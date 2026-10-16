import os from "os";
import { Worker } from "worker_threads";
import {
  getSearchIndexRevision,
  getSearchIndexSnapshot,
  getPublicProductsByIds,
} from "../lib/db.js";
import { backgroundCheckpoint } from "../lib/requestPriority.js";
import { opLog, opWarn } from "../lib/opsLog.js";
import {
  CATALOG_SHOPPER_PAGE_SIZE,
  runCatalogSearch,
  runNearestCatalogSearch,
} from "./catalogSearchCore.js";

const cpuCount =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;

const THREADS = Math.min(
  Math.max(
    Number(process.env.CATALOG_SEARCH_THREADS || Math.min(2, Math.max(1, cpuCount - 1))),
    1
  ),
  4
);

const SHOPPER_PAGE_SIZE = CATALOG_SHOPPER_PAGE_SIZE;
const workerUrl = new URL("../workers/catalogSearchWorker.js", import.meta.url);

let workers = [];
let rr = 0;
let nextRequestId = 1;
let refreshPromise = null;
let refreshTimer = null;
let snapshotCacheRevision = -1;
let snapshotCacheRecords = null;
let fallbackLexicalCache = new Map();
let refreshRuns = 0;
let refreshSwaps = 0;
let staleSearchesServed = 0;
let freshRepairCount = 0;

function createWorker(index) {
  const worker = new Worker(workerUrl);

  const state = {
    index,
    worker,
    revision: -1,
    pending: new Map(),
    retired: false,
    failed: false,
  };

  const maybeTerminateRetired = () => {
    if (!state.retired || state.pending.size) return;
    state.worker.terminate().catch(() => {});
  };

  worker.on("message", message => {
    const pending = state.pending.get(message.requestId);
    if (!pending) return;

    state.pending.delete(message.requestId);

    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Catalog search worker failed."));

    maybeTerminateRetired();
  });

  worker.on("error", error => {
    state.failed = true;
    opWarn("workers", `catalog worker ${index} error`, error.message);

    for (const pending of state.pending.values()) {
      pending.reject(error);
    }
    state.pending.clear();
    state.revision = -1;
    maybeTerminateRetired();
  });

  return state;
}

function ensureWorkers() {
  if (workers.length) return;
  workers = Array.from({ length: THREADS }, (_, index) => createWorker(index));
  opLog("workers", `catalog search pool online with ${THREADS} worker thread(s)`, {
    cpuCount,
    refreshMode: "double-buffered-background",
  });
}

function request(state, type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId++;
    state.pending.set(requestId, { resolve, reject });
    try {
      state.worker.postMessage({ requestId, type, payload });
    } catch (error) {
      state.pending.delete(requestId);
      reject(error);
    }
  });
}

function cachedSnapshotForCurrentRevision() {
  const revision = getSearchIndexRevision();
  if (snapshotCacheRevision === revision && Array.isArray(snapshotCacheRecords)) {
    return { revision, records: snapshotCacheRecords };
  }

  const records = getSearchIndexSnapshot();
  snapshotCacheRevision = revision;
  snapshotCacheRecords = records;

  // Keep lexical preparation for unchanged product IDs across revisions.
  // Periodically prune removed IDs so long-running processes do not retain
  // deleted catalog entries forever.
  if (fallbackLexicalCache.size > records.length + 1000) {
    const liveIds = new Set(records.map(record => Number(record.id)));
    for (const id of fallbackLexicalCache.keys()) {
      if (Number.isFinite(Number(id)) && !liveIds.has(Number(id))) {
        fallbackLexicalCache.delete(id);
      }
    }
  }
  return { revision, records };
}

function searchCurrentSnapshot({ q = "", category = "", sort = "heat", page = 1, includeParts = false } = {}) {
  const { revision, records } = cachedSnapshotForCurrentRevision();
  const meta = runCatalogSearch(records, { q, category, sort, page, includeParts }, {
    lexicalCache: fallbackLexicalCache,
  });
  return {
    ...meta,
    products: getPublicProductsByIds(meta.ids, { includeParts }),
    catalogRevision: revision,
  };
}

function nearestCurrentSnapshot({ q = "", category = "", limit = 20 } = {}) {
  const { records } = cachedSnapshotForCurrentRevision();
  return runNearestCatalogSearch(records, { q, category, limit }, {
    lexicalCache: fallbackLexicalCache,
  });
}

function retireWorker(state) {
  if (!state) return;
  state.retired = true;
  if (!state.pending.size) {
    state.worker.terminate().catch(() => {});
  }
}

async function buildReplacementWorker(index, reason) {
  // Snapshot creation and structured cloning are intentionally admitted only
  // during a quiet window. The currently-active worker remains available for
  // searches the entire time; no shopper waits for this replacement.
  await backgroundCheckpoint(`catalog-worker-refresh:${index}:snapshot`, {
    quietMs: Math.max(100, Number(process.env.CATALOG_WORKER_REFRESH_QUIET_MS || 250)),
  });

  const { revision, records } = cachedSnapshotForCurrentRevision();
  const current = workers[index];
  if (current && current.revision >= revision) return false;

  await backgroundCheckpoint(`catalog-worker-refresh:${index}:clone`, {
    quietMs: Math.max(100, Number(process.env.CATALOG_WORKER_REFRESH_QUIET_MS || 250)),
  });

  const replacement = createWorker(index);
  try {
    const result = await request(replacement, "index", {
      revision,
      records,
    });
    replacement.revision = revision;

    const previous = workers[index];
    workers[index] = replacement;
    retireWorker(previous);
    refreshSwaps++;

    opLog("workers", `worker ${index} background-swapped to catalog revision ${revision}`, {
      records: result.records,
      previousRevision: Number(previous?.revision ?? -1),
      reason,
    });
    return true;
  } catch (error) {
    replacement.retired = true;
    retireWorker(replacement);
    opWarn("workers", `background refresh for catalog worker ${index} failed`, error.message);
    return false;
  }
}

function workersNeedRefresh() {
  if (!workers.length) return true;
  const revision = getSearchIndexRevision();
  return workers.some(state => !state || state.failed || state.revision < revision);
}

function armRefreshRetry(reason = "catalog-revision-advanced") {
  if (refreshTimer || refreshPromise || !workersNeedRefresh()) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    scheduleCatalogSearchWarmup({ reason });
  }, Math.max(100, Number(process.env.CATALOG_WORKER_REFRESH_RETRY_MS || 350)));
  refreshTimer.unref?.();
}

export function scheduleCatalogSearchWarmup({ reason = "catalog-revision-advanced" } = {}) {
  ensureWorkers();
  if (!workersNeedRefresh()) return false;
  if (refreshPromise) return true;

  refreshPromise = (async () => {
    refreshRuns++;
    // One replacement at a time avoids duplicating a full catalog snapshot into
    // several workers simultaneously and keeps memory/clone pressure bounded.
    for (let index = 0; index < workers.length; index++) {
      const state = workers[index];
      const currentRevision = getSearchIndexRevision();
      if (state && !state.failed && state.revision >= currentRevision) continue;
      await buildReplacementWorker(index, reason);
    }
  })()
    .catch(error => {
      opWarn("workers", "catalog background warmup failed", error.message);
    })
    .finally(() => {
      refreshPromise = null;
      armRefreshRetry("catalog-revision-changed-during-warmup");
    });

  return true;
}

function chooseReadyWorker() {
  ensureWorkers();
  const currentRevision = getSearchIndexRevision();

  // Do not await refresh. Every stale revision is stale-while-revalidate.
  if (workersNeedRefresh()) {
    scheduleCatalogSearchWarmup({ reason: "shopper-observed-stale-worker" });
  }

  const available = workers.filter(state => state && !state.failed && state.revision >= 0);
  if (!available.length) return null;

  // Round-robin among live workers. They can be stale, but they are never the
  // worker currently being rebuilt because refresh uses a separate replacement.
  const state = available[rr++ % available.length];
  if (state.revision < currentRevision) staleSearchesServed++;
  return { state, currentRevision };
}

export async function searchCatalogPage({
  q = "",
  category = "",
  sort = "heat",
  page = 1,
  pageSize = SHOPPER_PAGE_SIZE,
  preferFresh = false,
  includeParts = false,
} = {}) {
  const safePageSize = SHOPPER_PAGE_SIZE;
  const selected = chooseReadyWorker();

  // First boot is the only time there may be no indexed worker yet. Fall back
  // to the in-memory DB search immediately while the worker warms in the
  // background; never make the first shopper wait for worker initialization.
  if (!selected) {
    return {
      ...searchCurrentSnapshot({ q, category, sort, page, includeParts }),
      threaded: false,
      workerStale: true,
      workerRevision: -1,
      catalogRevision: getSearchIndexRevision(),
      freshnessRepair: true,
    };
  }

  const { state, currentRevision } = selected;

  if (preferFresh && state.revision < currentRevision) {
    // Event-driven refreshes after discovery/verification need current catalog
    // membership immediately. Use the cached-summary main-thread fallback only
    // for this stale-revision window; the replacement worker is already warming
    // independently and no shopper waits for that refresh.
    freshRepairCount++;
    return {
      ...searchCurrentSnapshot({ q, category, sort, page, includeParts }),
      threaded: false,
      workerStale: true,
      workerRevision: state.revision,
      catalogRevision: currentRevision,
      freshnessRepair: true,
    };
  }

  try {
    const meta = await request(state, "search", {
      q,
      category,
      sort,
      page,
      pageSize: safePageSize,
      includeParts,
    });

    const workerStale = state.revision < currentRevision;
    const products = getPublicProductsByIds(meta.ids, { includeParts });

    // A stale index is normally useful and should paint immediately. The one
    // dangerous stale case is a precise query returning nothing immediately
    // after ingestion/approval; do a current in-memory repair rather than make
    // the shopper wait for the background worker swap.
    if (workerStale && String(q || "").trim() && products.length === 0) {
      freshRepairCount++;
      const repaired = searchCurrentSnapshot({ q, category, sort, page, includeParts });
      return {
        ...repaired,
        threaded: false,
        workerStale: true,
        workerRevision: state.revision,
        catalogRevision: currentRevision,
        freshnessRepair: true,
      };
    }

    return {
      ...meta,
      products,
      threaded: true,
      workerStale,
      workerRevision: state.revision,
      catalogRevision: currentRevision,
      freshnessRepair: false,
    };
  } catch (error) {
    opWarn("workers", "catalog worker search fell back to main thread", error.message);
    scheduleCatalogSearchWarmup({ reason: "worker-search-failure" });
    return {
      ...searchCurrentSnapshot({ q, category, sort, page, includeParts }),
      threaded: false,
      workerStale: true,
      workerRevision: Number(state?.revision ?? -1),
      catalogRevision: getSearchIndexRevision(),
      freshnessRepair: true,
    };
  }
}

export async function nearestCatalogProducts({
  q = "",
  category = "",
  limit = 20,
} = {}) {
  const selected = chooseReadyWorker();
  if (!selected) {
    return getPublicProductsByIds(nearestCurrentSnapshot({ q, category, limit }));
  }

  try {
    const ids = await request(selected.state, "nearest", {
      q,
      category,
      limit,
    });
    return getPublicProductsByIds(ids);
  } catch {
    scheduleCatalogSearchWarmup({ reason: "nearest-worker-failure" });
    return [];
  }
}

export function getCatalogSearchPoolStatus() {
  const currentRevision = getSearchIndexRevision();
  return {
    threads: THREADS,
    currentRevision,
    workerRevisions: workers.map(state => Number(state?.revision ?? -1)),
    refreshActive: Boolean(refreshPromise),
    refreshRuns,
    refreshSwaps,
    staleSearchesServed,
    freshRepairCount,
  };
}

export function catalogSearchThreadCount() {
  return THREADS;
}
