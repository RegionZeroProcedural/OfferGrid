import os from "os";
import { Worker } from "worker_threads";
import { opLog, opWarn } from "../lib/opsLog.js";

const cpuCount = typeof os.availableParallelism === "function"
  ? os.availableParallelism()
  : os.cpus().length;

// On a 12-logical-CPU host OfferGrid also runs catalog-search workers, the
// Node request thread, marketplace parsing, and background mutation work. Keep
// more CPU headroom for the event loop; Deal Heat is background work and may
// finish slightly later rather than starving shopper requests.
const DEFAULT_THREADS = cpuCount >= 12
  ? 5
  : Math.max(2, Math.min(6, cpuCount - 3));
const THREADS = Math.max(
  1,
  Math.min(Number(process.env.INTELLIGENCE_WORKERS || DEFAULT_THREADS), Math.max(1, cpuCount - 2))
);
const PREP_BATCH_SIZE = Math.max(
  THREADS,
  Math.min(Number(process.env.INTELLIGENCE_PREP_BATCH_SIZE || 256), 2048)
);
const RESULT_COMMIT_MS = Math.max(
  25,
  Math.min(Number(process.env.INTELLIGENCE_RESULT_COMMIT_MS || 250), 5_000)
);
const RESULT_COMMIT_BATCH = Math.max(
  1,
  Math.min(Number(process.env.INTELLIGENCE_RESULT_COMMIT_BATCH || 64), 1024)
);

const workerUrl = new URL("../workers/dealHeatWorker.js", import.meta.url);

let hooks = null;
let workers = [];
let nextRequestId = 1;
let preparing = false;
let pumpScheduled = false;
let stopped = false;
const queued = new Map();
const readyJobs = [];
const inFlight = new Map();
let pendingResults = [];
let resultCommitTimer = null;
let committingResults = false;
let totalCompleted = 0;
let totalFailed = 0;

function priorityRank(priority) {
  return priority === "interactive" ? 0 : priority === "normal" ? 1 : 2;
}

function createWorker(index) {
  const worker = new Worker(workerUrl, {
    // Do not leak one-shot CLI flags (for example --input-type) into workers.
    execArgv: process.execArgv.filter(arg => !String(arg).startsWith("--input-type")),
  });
  const state = {
    index,
    worker,
    busy: false,
    requestId: null,
    productId: null,
    generation: null,
  };

  worker.on("message", message => {
    if (message?.requestId !== state.requestId) return;

    const productId = Number(state.productId);
    state.busy = false;
    state.requestId = null;
    state.productId = null;
    state.generation = null;
    inFlight.delete(productId);

    if (message.ok) {
      totalCompleted++;
      pendingResults.push(message.result);
      if (pendingResults.length >= RESULT_COMMIT_BATCH) {
        void commitResults();
      } else {
        armResultCommitTimer();
      }
    } else {
      totalFailed++;
      opWarn("intelligence", `worker ${index} failed product ${productId}`, message.error || "unknown worker error");
      queueOne(productId, { priority: "background", reason: "worker-retry" });
    }

    schedulePump();
  });

  worker.on("error", error => {
    const productId = Number(state.productId);
    if (Number.isFinite(productId)) {
      inFlight.delete(productId);
      queueOne(productId, { priority: "background", reason: "worker-crash-retry" });
    }
    state.busy = false;
    state.requestId = null;
    state.productId = null;
    state.generation = null;
    totalFailed++;
    opWarn("intelligence", `worker ${index} crashed`, error?.message || String(error));
    schedulePump();
  });

  worker.on("exit", code => {
    if (stopped) return;
    if (code !== 0) {
      opWarn("intelligence", `worker ${index} exited`, `exit code ${code}`);
    }
    // Replace unexpected exits in-place so the pool cannot silently shrink.
    setTimeout(() => {
      if (stopped) return;
      workers[index] = createWorker(index);
      schedulePump();
    }, 100).unref?.();
  });

  return state;
}

function ensureWorkers() {
  if (workers.length || stopped) return;
  workers = Array.from({ length: THREADS }, (_, index) => createWorker(index));
  opLog("intelligence", `Deal Heat worker pool online with ${THREADS} thread(s)`, {
    logicalCpuCount: cpuCount,
    prepBatchSize: PREP_BATCH_SIZE,
    resultCommitMs: RESULT_COMMIT_MS,
  });
}

function armResultCommitTimer() {
  if (resultCommitTimer || !pendingResults.length) return;
  resultCommitTimer = setTimeout(() => {
    resultCommitTimer = null;
    void commitResults();
  }, RESULT_COMMIT_MS);
  resultCommitTimer.unref?.();
}

async function commitResults() {
  if (committingResults || !pendingResults.length || typeof hooks?.applyResults !== "function") return;
  committingResults = true;
  if (resultCommitTimer) {
    clearTimeout(resultCommitTimer);
    resultCommitTimer = null;
  }

  const batch = pendingResults;
  pendingResults = [];

  try {
    const outcome = await hooks.applyResults(batch);
    for (const id of outcome?.staleIds || []) {
      queueOne(id, { priority: "background", reason: "generation-advanced" });
    }
  } catch (error) {
    totalFailed += batch.length;
    opWarn("intelligence", "snapshot result commit failed", error?.stack || error?.message || String(error));
    for (const result of batch) {
      queueOne(result.productId, { priority: "background", reason: "result-commit-retry" });
    }
  } finally {
    committingResults = false;
    if (pendingResults.length) armResultCommitTimer();
    schedulePump();
  }
}

function queueOne(productId, { priority = "background", reason = "mutation" } = {}) {
  const id = Number(productId);
  if (!Number.isFinite(id) || stopped) return;

  const existing = queued.get(id);
  const nextPriority = existing && priorityRank(existing.priority) <= priorityRank(priority)
    ? existing.priority
    : priority;
  const reasons = new Set(existing?.reasons || []);
  reasons.add(String(reason || "mutation").slice(0, 120));
  queued.set(id, {
    productId: id,
    priority: nextPriority,
    reasons: [...reasons].slice(-8),
    queuedAt: existing?.queuedAt || Date.now(),
  });
}

function takeQueuedBatch() {
  const available = [...queued.values()]
    .filter(item => !inFlight.has(item.productId))
    .sort((a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      a.queuedAt - b.queuedAt ||
      a.productId - b.productId
    )
    .slice(0, PREP_BATCH_SIZE);

  for (const item of available) queued.delete(item.productId);
  return available;
}

async function prepareMoreJobs() {
  if (preparing || stopped || typeof hooks?.buildJobs !== "function") return;
  const batch = takeQueuedBatch();
  if (!batch.length) return;

  preparing = true;
  try {
    const jobs = await hooks.buildJobs(batch.map(item => item.productId));
    const metadata = new Map(batch.map(item => [item.productId, item]));
    for (const job of jobs || []) {
      const productId = Number(job?.productId);
      if (!Number.isFinite(productId)) continue;
      readyJobs.push({
        ...job,
        priority: metadata.get(productId)?.priority || "background",
      });
    }
    readyJobs.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  } catch (error) {
    opWarn("intelligence", "snapshot job preparation failed", error?.stack || error?.message || String(error));
    for (const item of batch) queueOne(item.productId, item);
  } finally {
    preparing = false;
  }
}

function dispatchReadyJobs() {
  ensureWorkers();
  if (!workers.length) return;

  for (const state of workers) {
    if (state.busy || !readyJobs.length) continue;
    const job = readyJobs.shift();
    const productId = Number(job.productId);
    if (!Number.isFinite(productId)) continue;

    const requestId = nextRequestId++;
    state.busy = true;
    state.requestId = requestId;
    state.productId = productId;
    state.generation = Number(job.generation || 0);
    inFlight.set(productId, state.generation);
    state.worker.postMessage({ requestId, job });
  }
}

async function pump() {
  pumpScheduled = false;
  if (stopped || !hooks) return;
  ensureWorkers();

  dispatchReadyJobs();

  const idle = workers.filter(worker => !worker.busy).length;
  if (idle > 0 && queued.size > 0 && readyJobs.length < idle * 2) {
    await prepareMoreJobs();
    dispatchReadyJobs();
  }

  if ((queued.size > 0 || readyJobs.length > 0) && workers.some(worker => !worker.busy)) {
    schedulePump();
  }
}

function schedulePump() {
  if (pumpScheduled || stopped) return;
  pumpScheduled = true;
  setImmediate(() => void pump());
}

export function configureIntelligenceWorkerPool(nextHooks = {}) {
  hooks = {
    buildJobs: nextHooks.buildJobs,
    applyResults: nextHooks.applyResults,
  };
}

export function enqueueIntelligenceProducts(productIds = [], options = {}) {
  for (const productId of productIds || []) queueOne(productId, options);
  schedulePump();
}

export function intelligenceWorkerCount() {
  return THREADS;
}

export function getIntelligenceWorkerStatus() {
  return {
    logicalCpuCount: cpuCount,
    workers: THREADS,
    queued: queued.size,
    prepared: readyJobs.length,
    inFlight: inFlight.size,
    pendingResultCommits: pendingResults.length,
    totalCompleted,
    totalFailed,
  };
}

export async function flushIntelligenceWorkerPool({ timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs || 15_000));
  schedulePump();

  while (Date.now() < deadline) {
    await commitResults();
    if (
      queued.size === 0 &&
      readyJobs.length === 0 &&
      inFlight.size === 0 &&
      pendingResults.length === 0 &&
      !preparing &&
      !committingResults
    ) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  return false;
}

export async function stopIntelligenceWorkerPool() {
  stopped = true;
  if (resultCommitTimer) clearTimeout(resultCommitTimer);
  await Promise.all(workers.map(state => state.worker.terminate().catch(() => {})));
  workers = [];
}

export const __intelligenceWorkerPoolTest = {
  cpuCount,
  threads: THREADS,
  prepBatchSize: PREP_BATCH_SIZE,
};
