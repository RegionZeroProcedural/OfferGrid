import fs from "fs";
import path from "path";
import readline from "readline";
import crypto from "crypto";
import { createGunzip } from "zlib";
import { once } from "node:events";

import { getConfigValue } from "../lib/privateConfig.js";
import {
  approveProductIds,
  flushRuntimeMutationBuffer,
  ingestCandidates,
  reconcileProviderFeed,
} from "../lib/db.js";
import { isExplicitProduct } from "../lib/contentSafety.js";
import { opLog, opWarn } from "../lib/opsLog.js";
import { backgroundCheckpoint } from "../lib/requestPriority.js";


let SftpClientClass = null;

async function getSftpClientClass() {
  if (SftpClientClass) return SftpClientClass;
  try {
    const module = await import("ssh2-sftp-client");
    SftpClientClass = module.default || module;
    return SftpClientClass;
  } catch (error) {
    const wrapped = new Error(
      "Rakuten Product Catalog requires the ssh2-sftp-client dependency. Run npm install after applying the V3.7.30 patch."
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

const STATE_FILE = path.resolve("data", "rakuten-catalog-state.json");
const TMP_DIR = path.resolve("data", ".rakuten-catalog-tmp");

let syncPromise = null;
let runtimeStatus = {
  running: false,
  startedAt: null,
  completedAt: null,
  lastError: "",
  lastResult: null,
};

function boolConfig(key, fallback = false) {
  const raw = getConfigValue(key, fallback ? "true" : "false");
  return String(raw).toLowerCase() === "true";
}

function numberConfig(key, fallback, min, max) {
  const parsed = Number(getConfigValue(key, String(fallback)));
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(safe, min), max);
}

function catalogEnabled() {
  return boolConfig("RAKUTEN_CATALOG_SYNC_ENABLED", true);
}

export function isRakutenCatalogConfigured() {
  return Boolean(
    String(getConfigValue("RAKUTEN_SFTP_USERNAME", "") || "").trim() &&
    String(getConfigValue("RAKUTEN_SFTP_PASSWORD", "") || "").trim()
  );
}

function sftpConfig() {
  return {
    host: String(getConfigValue("RAKUTEN_SFTP_HOST", "aftp.linksynergy.com") || "aftp.linksynergy.com").trim(),
    port: Math.round(numberConfig("RAKUTEN_SFTP_PORT", 22, 1, 65535)),
    username: String(getConfigValue("RAKUTEN_SFTP_USERNAME", "") || "").trim(),
    password: String(getConfigValue("RAKUTEN_SFTP_PASSWORD", "") || "").trim(),
    readyTimeout: Math.round(numberConfig("RAKUTEN_SFTP_TIMEOUT_MS", 20_000, 5_000, 60_000)),
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
  };
}

function defaultState() {
  return {
    version: 1,
    updatedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: "",
    files: {},
    merchants: {},
  };
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      files: parsed?.files && typeof parsed.files === "object" ? parsed.files : {},
      merchants: parsed?.merchants && typeof parsed.merchants === "object" ? parsed.merchants : {},
    };
  } catch (error) {
    opWarn("rakuten-catalog", "state file could not be read; rebuilding state", {
      error: String(error?.message || error).slice(0, 300),
    });
    return defaultState();
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  const temp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2));
  fs.renameSync(temp, STATE_FILE);
}

function safeRemotePath(name) {
  const clean = String(name || "").replace(/\\/g, "/");
  if (!clean || clean.includes("..") || clean.startsWith("/")) {
    throw new Error("Unsafe Rakuten SFTP file path.");
  }
  return clean;
}

function parseFeedFileName(name) {
  const base = String(name || "").trim();
  if (!base.endsWith(".txt.gz")) return null;
  if (/_template|_deltatemplate|_cmp/i.test(base)) return null;

  const match = base.match(/^(\d+)_(\d+)_mp(_delta)?(?:_([^/]+))?\.txt\.gz$/i);
  if (!match) return null;

  return {
    name: base,
    mid: match[1],
    sid: match[2],
    delta: Boolean(match[3]),
    variant: String(match[4] || ""),
    scopeKey: `${match[1]}:${String(match[4] || "default").toLowerCase()}`,
  };
}

function fileFingerprint(entry) {
  return `${Number(entry?.size || 0)}:${Number(entry?.modifyTime || 0)}:${Number(entry?.accessTime || 0)}`;
}

function parsePipeLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < String(line || "").length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "|" && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values.map(value => String(value || "").trim());
}

function parseMoney(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.includes(",") && !raw.includes(".")
    ? raw.replace(",", ".")
    : raw.replace(/,/g, "");
  const amount = Number(normalized.replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function parseRakutenUtcTimestamp(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return new Date().toISOString();
  const [, mm, dd, yyyy, hh, min, ss] = match;
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss)));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function availabilityValue(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "out-of-stock") return "out_of_stock";
  if (normalized === "preorder") return "preorder";
  if (normalized === "backorder") return "backorder";
  return "in_stock";
}

function candidateExternalId(mid, fields) {
  const sku = String(fields?.[2] || "").trim();
  const productId = String(fields?.[0] || "").trim();
  const stable = sku || productId;
  return stable ? `${mid}:${stable}` : "";
}

function candidateFromFields(fields, context) {
  if (!Array.isArray(fields) || fields.length < 28) return null;

  const productName = fields[1];
  const sku = fields[2];
  const primaryCategory = fields[3];
  const secondaryCategory = fields[4];
  const productUrl = fields[5];
  const imageUrl = fields[6];
  const buyUrl = fields[7];
  const salePrice = parseMoney(fields[12]);
  const retailPrice = parseMoney(fields[13]);
  const brand = fields[16];
  const shippingPrice = parseMoney(fields[17]);
  const mpn = fields[19];
  const availability = availabilityValue(fields[22]);
  const gtin = String(fields[23] || "").replace(/[^0-9]/g, "");
  const currency = String(fields[25] || "USD").trim().toUpperCase() || "USD";
  const externalId = candidateExternalId(context.mid, fields);

  const price =
    salePrice != null && salePrice > 0 && (retailPrice == null || retailPrice <= 0 || salePrice <= retailPrice)
      ? salePrice
      : retailPrice;
  if (!productName || !sku || !productUrl || !externalId || !(Number(price) > 0)) return null;

  const originalPrice = salePrice != null && retailPrice != null && salePrice > 0 && retailPrice > salePrice
    ? retailPrice
    : null;

  const rateRaw = Number(getConfigValue("RAKUTEN_DEFAULT_COMMISSION_RATE", "0.05"));
  const commissionRate = Number.isFinite(rateRaw) ? rateRaw : 0.05;

  return {
    provider: "rakuten",
    externalId,
    title: productName,
    listingTitle: productName,
    merchant: context.merchantName || `Rakuten advertiser ${context.mid}`,
    price: Number(price),
    originalPrice,
    shippingPrice,
    currency,
    affiliateUrl: productUrl,
    sourceUrl: buyUrl || productUrl,
    imageUrl,
    brand,
    category: String(secondaryCategory || primaryCategory || "Other").replace(/~~+/g, " > "),
    availability,
    commissionRate,
    commissionIsEstimate: true,
    merchantRatingPct: null,
    gtin,
    mpn,
    searchObservedAt: context.observedAt || new Date().toISOString(),
    priceSource: "rakuten-product-catalog",
    matchSource: "rakuten-product-catalog",
  };
}

function mergeIngestTotals(target, result) {
  for (const key of [
    "blockedExplicit",
    "productsCreated",
    "productsReactivated",
    "offersCreated",
    "offersUpdated",
    "offersRehomed",
    "productsTouched",
  ]) {
    target[key] = Number(target[key] || 0) + Number(result?.[key] || 0);
  }
}

async function ingestChunk(chunk, totals, { priority, autoApprove }) {
  if (!chunk.length) return;
  if (priority === "background") {
    await backgroundCheckpoint("rakuten-catalog-ingest");
  }

  const clean = chunk.filter(candidate => !isExplicitProduct(candidate));
  totals.blockedExplicit = Number(totals.blockedExplicit || 0) + (chunk.length - clean.length);
  if (!clean.length) return;

  const result = ingestCandidates(clean, { deferPersistence: true });
  mergeIngestTotals(totals, result);

  if (autoApprove && result.touchedProductIds?.length) {
    const approved = approveProductIds(result.touchedProductIds, Infinity, { deferPersistence: true });
    totals.autoApproved = Number(totals.autoApproved || 0) + approved.length;
  }
}

async function processDownloadedFeed(localPath, feed, options = {}) {
  const delta = Boolean(feed.delta);
  const priority = options.priority || "background";
  const batchSize = Math.round(numberConfig("RAKUTEN_CATALOG_BATCH_SIZE", 250, 25, 2000));
  const autoApprove = boolConfig("RAKUTEN_CATALOG_AUTO_APPROVE", true);
  const maxProducts = Math.round(numberConfig("RAKUTEN_CATALOG_MAX_PRODUCTS_PER_FILE", 0, 0, 10_000_000));
  const stagedPath = `${localPath}.ndjson`;

  const input = fs.createReadStream(localPath).pipe(createGunzip());
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const staged = fs.createWriteStream(stagedPath, { encoding: "utf8" });
  const hash = crypto.createHash("sha256");

  let merchantName = "";
  let observedAt = new Date().toISOString();
  let trailerCount = null;
  let rows = 0;
  let parsed = 0;
  let invalid = 0;
  let deleted = 0;
  const activeExternalIds = new Set();
  const unavailableExternalIds = new Set();
  const totals = {
    blockedExplicit: 0,
    productsCreated: 0,
    productsReactivated: 0,
    offersCreated: 0,
    offersUpdated: 0,
    productsTouched: 0,
    autoApproved: 0,
  };

  try {
    for await (const line of lines) {
      hash.update(line);
      hash.update("\n");
      if (!line) continue;

      if (line.startsWith("HDR|")) {
        const header = parsePipeLine(line);
        merchantName = header[2] || merchantName;
        observedAt = parseRakutenUtcTimestamp(header[3]);
        continue;
      }

      if (line.startsWith("TRL|")) {
        const trailer = parsePipeLine(line);
        const count = Number(trailer[1]);
        trailerCount = Number.isFinite(count) ? count : null;
        continue;
      }

      rows++;
      const fields = parsePipeLine(line);
      const externalId = candidateExternalId(feed.mid, fields);
      const modification = delta
        ? String(fields[fields.length - 1] || "").trim().toUpperCase()
        : "";

      if (delta && modification === "D") {
        if (externalId) {
          unavailableExternalIds.add(externalId);
          deleted++;
        } else {
          invalid++;
        }
        continue;
      }

      const candidate = candidateFromFields(fields, {
        mid: feed.mid,
        merchantName,
        observedAt,
      });

      if (!candidate) {
        invalid++;
        continue;
      }

      parsed++;
      activeExternalIds.add(candidate.externalId);
      if (!staged.write(`${JSON.stringify(candidate)}\n`)) {
        await once(staged, "drain");
      }

      if (maxProducts > 0 && parsed >= maxProducts) break;
    }

    const stagedFinished = once(staged, "finish");
    staged.end();
    await stagedFinished;

    // Rakuten documents the trailer as the integrity signal for a complete
    // Product Catalog download. Do not mutate OfferGrid until the gzip stream
    // has extracted cleanly and the trailer agrees with the product row count.
    // A configured test cap intentionally stops early and therefore skips this
    // completeness check and full-feed reconciliation.
    if (maxProducts === 0) {
      if (trailerCount == null) {
        throw new Error(
          `Rakuten Product Catalog ${feed.name} did not contain a valid TRL record; import was aborted before catalog mutation.`
        );
      }
      if (trailerCount !== rows) {
        throw new Error(
          `Rakuten Product Catalog trailer mismatch for ${feed.name}: trailer=${trailerCount}, parsedRows=${rows}. ` +
          "Import was aborted before catalog mutation."
        );
      }
    }

    const stagedInput = readline.createInterface({
      input: fs.createReadStream(stagedPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let chunk = [];

    for await (const line of stagedInput) {
      if (!line) continue;
      let candidate;
      try {
        candidate = JSON.parse(line);
      } catch {
        invalid++;
        continue;
      }
      chunk.push(candidate);
      if (chunk.length >= batchSize) {
        await ingestChunk(chunk, totals, { priority, autoApprove });
        chunk = [];
      }
    }
    await ingestChunk(chunk, totals, { priority, autoApprove });

    if (priority === "background") {
      await backgroundCheckpoint("rakuten-catalog-reconcile");
    }

    const reconciliation = reconcileProviderFeed("rakuten", {
      externalIdPrefix: `${feed.mid}:`,
      priceSourcePrefix: "rakuten-product-catalog",
      activeExternalIds: delta ? null : activeExternalIds,
      unavailableExternalIds,
      replaceScope: !delta && maxProducts === 0,
      deferPersistence: true,
      reason: delta ? "rakuten-catalog-delta" : "rakuten-catalog-full",
    });

    return {
      merchantName,
      observedAt,
      rows,
      parsed,
      invalid,
      deleted,
      trailerCount,
      contentHash: hash.digest("hex"),
      activeExternalIds: activeExternalIds.size,
      reconciliation,
      ...totals,
    };
  } finally {
    try { staged.destroy(); } catch {}
    try { fs.unlinkSync(stagedPath); } catch {}
  }
}

async function withSftp(fn) {
  const config = sftpConfig();
  if (!config.username || !config.password) {
    throw new Error("Rakuten Product Catalog SFTP username/password are not configured.");
  }

  const SftpClient = await getSftpClientClass();
  const sftp = new SftpClient("OfferGrid-Rakuten-Catalog");
  try {
    await sftp.connect(config);
    return await fn(sftp, config);
  } finally {
    try { await sftp.end(); } catch {}
  }
}

export async function testRakutenCatalogConnection() {
  if (!isRakutenCatalogConfigured()) {
    throw new Error("Rakuten Product Catalog SFTP username/password are not configured.");
  }

  return withSftp(async sftp => {
    const entries = await sftp.list(".");
    const feedFiles = entries
      .filter(entry => entry?.type !== "d")
      .map(entry => parseFeedFileName(entry.name))
      .filter(Boolean);

    return {
      ok: true,
      rootEntries: entries.length,
      productFeedFiles: feedFiles.length,
      advertisers: new Set(feedFiles.map(item => item.mid)).size,
      files: feedFiles.slice(0, 20).map(item => item.name),
    };
  });
}

function selectFiles(entries, state, mode, force) {
  const accountSid = String(getConfigValue("RAKUTEN_ACCOUNT_ID", "") || "").replace(/[^0-9]/g, "");
  const parsed = entries
    .filter(entry => entry?.type !== "d")
    .map(entry => ({ entry, feed: parseFeedFileName(entry.name) }))
    .filter(item => item.feed)
    .filter(item => !accountSid || item.feed.sid === accountSid);

  const byScope = new Map();
  for (const item of parsed) {
    const key = item.feed.scopeKey;
    if (!byScope.has(key)) byScope.set(key, { full: null, delta: null });
    if (item.feed.delta) byScope.get(key).delta = item;
    else byScope.get(key).full = item;
  }

  const fullRefreshHours = numberConfig("RAKUTEN_CATALOG_FULL_REFRESH_HOURS", 24, 1, 24 * 30);
  const fullCutoff = Date.now() - fullRefreshHours * 3_600_000;
  const selected = [];

  for (const [scopeKey, pair] of byScope.entries()) {
    const merchantState = state.merchants?.[scopeKey] || {};
    const lastFull = Date.parse(merchantState.lastFullAt || "") || 0;
    const fullDue = force || !lastFull || lastFull < fullCutoff;

    let choice = null;
    if (mode === "full") choice = pair.full;
    else if (mode === "delta") choice = pair.delta || pair.full;
    else choice = fullDue ? pair.full : (pair.delta || null);

    if (!choice) continue;

    const fingerprint = fileFingerprint(choice.entry);

    // Rakuten Product Catalog files are generated dynamically when retrieved.
    // Do not treat remote size/mtime as a reliable content-change gate for delta
    // feeds; cadence/state already prevents request storms, and reapplying an
    // unchanged delta is idempotent. This favors recall over accidentally
    // skipping a merchant update whose remote metadata did not change.
    selected.push({ ...choice, fingerprint });
  }

  return selected;
}

async function runSyncInternal({ mode = "auto", force = false, priority = "background" } = {}) {
  if (!catalogEnabled()) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!isRakutenCatalogConfigured()) {
    return { ok: true, skipped: true, reason: "not-configured" };
  }

  const state = readState();
  const startedAt = new Date().toISOString();
  state.lastAttemptAt = startedAt;
  state.lastError = "";
  writeState(state);

  fs.mkdirSync(TMP_DIR, { recursive: true });

  return withSftp(async sftp => {
    const entries = await sftp.list(".");
    const selected = selectFiles(entries, state, mode, force);
    const result = {
      ok: true,
      mode,
      startedAt,
      filesAvailable: entries.length,
      filesSelected: selected.length,
      filesProcessed: 0,
      filesSkipped: 0,
      advertisers: new Set(),
      totals: {
        rows: 0,
        parsed: 0,
        invalid: 0,
        deleted: 0,
        productsCreated: 0,
        productsReactivated: 0,
        offersCreated: 0,
        offersUpdated: 0,
        offersRehomed: 0,
        productsTouched: 0,
        autoApproved: 0,
        offersMarkedUnavailable: 0,
      },
      files: [],
    };

    for (const item of selected) {
      if (priority === "background") {
        await backgroundCheckpoint(`rakuten-catalog-download:${item.feed.mid}`);
      }

      const remoteName = safeRemotePath(item.feed.name);
      const tempName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${path.basename(remoteName)}`;
      const localPath = path.join(TMP_DIR, tempName);

      opLog("rakuten-catalog", `downloading ${remoteName}`, {
        mid: item.feed.mid,
        delta: item.feed.delta,
      });

      try {
        await sftp.fastGet(remoteName, localPath);
        const fileResult = await processDownloadedFeed(localPath, item.feed, { priority });

        state.files[item.feed.name] = {
          fingerprint: item.fingerprint,
          contentHash: fileResult.contentHash,
          lastProcessedAt: new Date().toISOString(),
          delta: item.feed.delta,
          mid: item.feed.mid,
          rows: fileResult.rows,
          parsed: fileResult.parsed,
        };
        const merchant = state.merchants[item.feed.scopeKey] || {};
        if (item.feed.delta) merchant.lastDeltaAt = new Date().toISOString();
        else merchant.lastFullAt = new Date().toISOString();
        merchant.mid = item.feed.mid;
        merchant.name = fileResult.merchantName || merchant.name || "";
        state.merchants[item.feed.scopeKey] = merchant;
        writeState(state);

        result.filesProcessed++;
        result.advertisers.add(item.feed.mid);
        result.files.push({
          name: item.feed.name,
          mid: item.feed.mid,
          delta: item.feed.delta,
          merchant: fileResult.merchantName,
          rows: fileResult.rows,
          parsed: fileResult.parsed,
          deleted: fileResult.deleted,
        });

        for (const key of [
          "rows", "parsed", "invalid", "deleted", "productsCreated", "productsReactivated",
          "offersCreated", "offersUpdated", "offersRehomed", "productsTouched", "autoApproved",
        ]) {
          result.totals[key] += Number(fileResult[key] || 0);
        }
        result.totals.offersMarkedUnavailable += Number(fileResult.reconciliation?.offersMarkedUnavailable || 0);
      } finally {
        try { fs.unlinkSync(localPath); } catch {}
      }
    }

    // A completed SFTP run is a natural durability boundary. All feed chunks
    // above mutate the shared in-memory catalog and coalesce by product; flush
    // that entire burst once before recording the sync as successful. This
    // keeps per-row/per-chunk SSD writes eliminated while ensuring a reported
    // successful feed is already durable in catalog.json/history.
    if (result.filesProcessed > 0) {
      await flushRuntimeMutationBuffer({
        reason: `rakuten-catalog-${mode}-complete`,
        force: false,
      });
    }

    state.lastSuccessAt = new Date().toISOString();
    state.lastError = "";
    writeState(state);

    result.advertisers = [...result.advertisers];
    result.completedAt = state.lastSuccessAt;
    opLog("rakuten-catalog", "Product Catalog synchronization complete", {
      mode,
      filesProcessed: result.filesProcessed,
      advertisers: result.advertisers.length,
      parsed: result.totals.parsed,
      productsCreated: result.totals.productsCreated,
      offersUpdated: result.totals.offersUpdated,
      offersRehomed: result.totals.offersRehomed,
    });
    return result;
  });
}

export async function runRakutenCatalogSync(options = {}) {
  if (syncPromise) return syncPromise;

  runtimeStatus = {
    ...runtimeStatus,
    running: true,
    startedAt: new Date().toISOString(),
    lastError: "",
  };

  syncPromise = runSyncInternal(options)
    .then(result => {
      runtimeStatus = {
        running: false,
        startedAt: runtimeStatus.startedAt,
        completedAt: new Date().toISOString(),
        lastError: "",
        lastResult: result,
      };
      return result;
    })
    .catch(error => {
      const state = readState();
      state.lastError = String(error?.message || error).slice(0, 1000);
      state.lastAttemptAt = runtimeStatus.startedAt || new Date().toISOString();
      writeState(state);
      runtimeStatus = {
        ...runtimeStatus,
        running: false,
        completedAt: new Date().toISOString(),
        lastError: state.lastError,
      };
      opWarn("rakuten-catalog", "Product Catalog synchronization failed", {
        error: state.lastError,
      });
      throw error;
    })
    .finally(() => {
      syncPromise = null;
    });

  return syncPromise;
}

export function startRakutenCatalogSync(options = {}) {
  if (syncPromise) return { started: false, running: true };
  runRakutenCatalogSync(options).catch(() => {});
  return { started: true, running: true };
}

export function getRakutenCatalogStatus() {
  const state = readState();
  return {
    configured: isRakutenCatalogConfigured(),
    enabled: catalogEnabled(),
    host: String(getConfigValue("RAKUTEN_SFTP_HOST", "aftp.linksynergy.com") || "aftp.linksynergy.com"),
    usernameConfigured: Boolean(String(getConfigValue("RAKUTEN_SFTP_USERNAME", "") || "").trim()),
    passwordConfigured: Boolean(String(getConfigValue("RAKUTEN_SFTP_PASSWORD", "") || "").trim()),
    syncMinutes: numberConfig("RAKUTEN_CATALOG_SYNC_MINUTES", 30, 5, 24 * 60),
    fullRefreshHours: numberConfig("RAKUTEN_CATALOG_FULL_REFRESH_HOURS", 24, 1, 24 * 30),
    autoApprove: boolConfig("RAKUTEN_CATALOG_AUTO_APPROVE", true),
    state: {
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      merchantCount: Object.keys(state.merchants || {}).length,
      fileCount: Object.keys(state.files || {}).length,
      merchants: Object.values(state.merchants || {}).slice(0, 50),
    },
    runtime: { ...runtimeStatus },
  };
}

export const __rakutenCatalogTest = {
  parsePipeLine,
  parseFeedFileName,
  parseMoney,
  candidateExternalId,
  candidateFromFields,
  availabilityValue,
  processDownloadedFeed,
};
