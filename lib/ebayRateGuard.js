import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { opLog, opWarn } from "./opsLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const STATE_FILE = path.join(DATA_DIR, "ebay-api-usage.json");
const TMP_FILE = path.join(DATA_DIR, "ebay-api-usage.json.tmp");
const WINDOW_MS = 24 * 60 * 60 * 1000;

let state = null;
let permitQueue = Promise.resolve();

function intEnv(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function numberEnv(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function enabled() {
  return String(process.env.EBAY_RATE_GUARD_ENABLED || "true").toLowerCase() !== "false";
}

function emptyBucket() {
  return {
    events: [],
    cooldownUntil: 0,
    lastCallAt: 0,
    lastRateLimitAt: "",
    remoteRateLimitHits: 0,
    cooldownReason: "",
    remoteLimit: null,
    remoteRemaining: null,
    remoteResetAt: 0,
    remoteSyncedAt: 0,
    remoteResource: "",
    consecutiveRateLimitHits: 0,
  };
}

function emptyState() {
  return {
    version: 1,
    buckets: {
      browse: emptyBucket(),
      getItems: emptyBucket(),
    },
    updatedAt: new Date().toISOString(),
  };
}

function nullableFiniteNumber(value) {
  // Number(null) and Number("") are both 0. Quota state uses null to mean
  // "eBay has not supplied an authoritative value", so coercing those values
  // to zero can incorrectly shut an entire API bucket off after a restart.
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBucket(bucket) {
  const value = bucket && typeof bucket === "object" ? bucket : {};
  const remoteSyncedAt = Number(value.remoteSyncedAt || 0);
  const remoteResetAt = Number(value.remoteResetAt || 0);
  const remoteResource = String(value.remoteResource || "");
  let remoteLimit = nullableFiniteNumber(value.remoteLimit);
  let remoteRemaining = nullableFiniteNumber(value.remoteRemaining);

  // V3.7.35 repairs the ghost-zero state created by older normalization logic.
  // A real zero-remaining quota always has authoritative provenance (a positive
  // limit plus a sync/resource/reset marker, or a live 429 cooldown). A bare
  // 0/0 with no provenance means "unknown", not "exhausted".
  if (
    remoteLimit === 0 &&
    remoteRemaining === 0 &&
    remoteSyncedAt <= 0 &&
    remoteResetAt <= 0 &&
    !remoteResource
  ) {
    remoteLimit = null;
    remoteRemaining = null;
  }

  return {
    events: Array.isArray(value.events)
      ? value.events.map(Number).filter(Number.isFinite)
      : [],
    cooldownUntil: Number(value.cooldownUntil || 0),
    lastCallAt: Number(value.lastCallAt || 0),
    lastRateLimitAt: String(value.lastRateLimitAt || ""),
    remoteRateLimitHits: Number(value.remoteRateLimitHits || 0),
    cooldownReason: String(value.cooldownReason || ""),
    remoteLimit,
    remoteRemaining,
    remoteResetAt,
    remoteSyncedAt,
    remoteResource,
    consecutiveRateLimitHits: Number(value.consecutiveRateLimitHits || 0),
  };
}

function hasAuthoritativeRemoteQuota(bucket) {
  const limit = nullableFiniteNumber(bucket?.remoteLimit);
  const remaining = nullableFiniteNumber(bucket?.remoteRemaining);
  if (!(limit > 0) || remaining == null || remaining < 0) return false;

  // Developer Analytics rows carry a sync timestamp/resource. Hard-resource
  // failures may carry a reset/cooldown instead. Either is enough provenance to
  // treat the remaining count as authoritative.
  return Boolean(
    Number(bucket?.remoteSyncedAt || 0) > 0 ||
    String(bucket?.remoteResource || "").trim() ||
    Number(bucket?.remoteResetAt || 0) > 0 ||
    String(bucket?.cooldownReason || "") === "authoritative-quota"
  );
}

function loadState() {
  if (state) return state;

  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state = {
      version: 1,
      buckets: {
        browse: normalizeBucket(parsed?.buckets?.browse),
        getItems: normalizeBucket(parsed?.buckets?.getItems),
      },
      updatedAt: String(parsed?.updatedAt || ""),
    };
  } catch {
    state = emptyState();
  }

  pruneAll();
  return state;
}

function persist() {
  if (!state) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(TMP_FILE, JSON.stringify(state), "utf8");
  fs.renameSync(TMP_FILE, STATE_FILE);
}

function pruneBucket(bucket, now = Date.now()) {
  bucket.events = bucket.events
    .map(Number)
    .filter(ts => Number.isFinite(ts) && now - ts < WINDOW_MS);

  if (bucket.cooldownUntil && bucket.cooldownUntil <= now) {
    bucket.cooldownUntil = 0;
    bucket.cooldownReason = "";
  }

  if (bucket.remoteResetAt && bucket.remoteResetAt <= now) {
    bucket.remoteLimit = null;
    bucket.remoteRemaining = null;
    bucket.remoteResetAt = 0;
    bucket.remoteSyncedAt = 0;
    bucket.remoteResource = "";
  }
}

function pruneAll(now = Date.now()) {
  const data = state || emptyState();
  for (const key of ["browse", "getItems"]) {
    data.buckets[key] ||= emptyBucket();
    pruneBucket(data.buckets[key], now);
  }
  state = data;
}

function configFor(bucketName) {
  const limit =
    bucketName === "getItems"
      ? intEnv("EBAY_GETITEMS_DAILY_LIMIT", 5000, 1, 1_000_000)
      : intEnv("EBAY_BROWSE_DAILY_LIMIT", 5000, 1, 1_000_000);

  const safety = intEnv(
    "EBAY_RATE_SAFETY_MARGIN",
    300,
    0,
    Math.max(0, limit - 1)
  );

  const hardCap = Math.max(1, limit - safety);
  const reserve = Math.min(
    intEnv("EBAY_INTERACTIVE_RESERVE", 900, 0, Math.max(0, hardCap - 1)),
    Math.max(0, hardCap - 1)
  );

  return {
    configuredLimit: limit,
    safetyMargin: safety,
    hardCap,
    interactiveReserve: reserve,
    backgroundCap: Math.max(1, hardCap - reserve),
    minIntervalMs: intEnv("EBAY_RATE_MIN_INTERVAL_MS", 180, 0, 10_000),
    softLimitStartPct: numberEnv("EBAY_SOFT_LIMIT_START_PCT", 70, 1, 99.9),
    softLimitStrictPct: numberEnv("EBAY_SOFT_LIMIT_STRICT_PCT", 85, 1, 99.9),
    softLimitCriticalPct: numberEnv("EBAY_SOFT_LIMIT_CRITICAL_PCT", 95, 1, 99.9),
    conserveMultiplier: numberEnv("EBAY_SOFT_LIMIT_CONSERVE_MULTIPLIER", 0.60, 0, 1),
    strictMultiplier: numberEnv("EBAY_SOFT_LIMIT_STRICT_MULTIPLIER", 0.25, 0, 1),
    criticalMultiplier: numberEnv("EBAY_SOFT_LIMIT_CRITICAL_MULTIPLIER", 0.05, 0, 1),
  };
}

function pressureFor(bucket, cfg, used) {
  const localPct = cfg.configuredLimit > 0
    ? (Math.max(0, used) / cfg.configuredLimit) * 100
    : 0;

  const remoteKnown = hasAuthoritativeRemoteQuota(bucket);
  const remoteLimit = remoteKnown ? Number(bucket.remoteLimit) : 0;
  const remoteRemaining = remoteKnown ? Number(bucket.remoteRemaining) : null;
  const remotePct =
    remoteKnown
      ? ((remoteLimit - Math.max(0, remoteRemaining)) / remoteLimit) * 100
      : 0;

  const usagePct = Math.max(localPct, remotePct);
  let mode = "normal";
  let backgroundBudgetMultiplier = 1;

  if (usagePct >= cfg.softLimitCriticalPct) {
    mode = "critical";
    backgroundBudgetMultiplier = cfg.criticalMultiplier;
  } else if (usagePct >= cfg.softLimitStrictPct) {
    mode = "strict";
    backgroundBudgetMultiplier = cfg.strictMultiplier;
  } else if (usagePct >= cfg.softLimitStartPct) {
    mode = "conserve";
    backgroundBudgetMultiplier = cfg.conserveMultiplier;
  }

  return {
    mode,
    usagePct: Math.round(usagePct * 10) / 10,
    localUsagePct: Math.round(localPct * 10) / 10,
    remoteUsagePct: Math.round(remotePct * 10) / 10,
    backgroundBudgetMultiplier,
  };
}

function bucketStatus(bucketName, now = Date.now()) {
  const data = loadState();
  const bucket = data.buckets[bucketName];
  pruneBucket(bucket, now);

  const cfg = configFor(bucketName);
  const used = bucket.events.length;
  const oldest = bucket.events[0] || 0;
  const nextReleaseAt = oldest ? oldest + WINDOW_MS : 0;

  const remoteKnown = hasAuthoritativeRemoteQuota(bucket);
  const remoteRemaining =
    remoteKnown
      ? Math.max(0, Number(bucket.remoteRemaining))
      : null;

  const remoteResetAt = Number(bucket.remoteResetAt || 0);
  const pressure = pressureFor(bucket, cfg, used);

  return {
    bucket: bucketName,
    usedLast24h: used,
    configuredLimit: cfg.configuredLimit,
    safetyMargin: cfg.safetyMargin,
    hardCap: cfg.hardCap,
    backgroundCap: cfg.backgroundCap,
    interactiveReserve: cfg.interactiveReserve,
    backgroundRemaining: Math.min(
      Math.max(0, cfg.backgroundCap - used),
      remoteRemaining == null
        ? Number.MAX_SAFE_INTEGER
        : Math.max(
            0,
            remoteRemaining -
              cfg.safetyMargin -
              cfg.interactiveReserve
          )
    ),
    interactiveRemaining: Math.min(
      Math.max(0, cfg.hardCap - used),
      remoteRemaining == null
        ? Number.MAX_SAFE_INTEGER
        : Math.max(
            0,
            remoteRemaining -
              cfg.safetyMargin
          )
    ),
    localBackgroundRemaining:
      Math.max(0, cfg.backgroundCap - used),
    localInteractiveRemaining:
      Math.max(0, cfg.hardCap - used),
    cooldownUntil: Number(bucket.cooldownUntil || 0),
    nextReleaseAt,
    remoteRateLimitHits: Number(bucket.remoteRateLimitHits || 0),
    lastRateLimitAt: String(bucket.lastRateLimitAt || ""),
    cooldownReason: String(bucket.cooldownReason || ""),
    remoteKnown,
    remoteLimit:
      remoteKnown
        ? Number(bucket.remoteLimit)
        : null,
    remoteRemaining,
    remoteResetAt,
    remoteResetAtIso:
      remoteResetAt
        ? new Date(remoteResetAt).toISOString()
        : null,
    remoteSyncedAt: Number(bucket.remoteSyncedAt || 0),
    remoteResource: String(bucket.remoteResource || ""),
    consecutiveRateLimitHits: Number(bucket.consecutiveRateLimitHits || 0),
    softLimitMode: pressure.mode,
    usagePct: pressure.usagePct,
    localUsagePct: pressure.localUsagePct,
    remoteUsagePct: pressure.remoteUsagePct,
    backgroundBudgetMultiplier: pressure.backgroundBudgetMultiplier,
    softLimitStartPct: cfg.softLimitStartPct,
    softLimitStrictPct: cfg.softLimitStrictPct,
    softLimitCriticalPct: cfg.softLimitCriticalPct,
  };
}

export class EbayRateGuardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "EbayRateGuardError";
    this.code = details.code || "EBAY_RATE_GUARD";
    this.rateGuardDeferred = true;
    this.bucket = details.bucket || "";
    this.priority = details.priority || "background";
    this.retryAt = Number(details.retryAt || 0);
    this.status = details.status || 429;
    this.details = details;
  }
}

export function isEbayRateGuardError(error) {
  return Boolean(
    error?.rateGuardDeferred ||
    String(error?.code || "").startsWith("EBAY_RATE_")
  );
}

function deferError(bucketName, priority, reason, retryAt, status) {
  const when = retryAt ? new Date(retryAt).toISOString() : "later";

  return new EbayRateGuardError(
    `eBay ${bucketName} request deferred by OfferGrid rate guard (${reason}); retry ${when}.`,
    {
      code:
        reason === "remote-cooldown"
          ? "EBAY_RATE_REMOTE_COOLDOWN"
          : "EBAY_RATE_LOCAL_BUDGET",
      bucket: bucketName,
      priority,
      reason,
      retryAt,
      status,
    }
  );
}

async function serialized(fn) {
  const run = permitQueue.then(fn, fn);
  permitQueue = run.catch(() => {});
  return run;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function acquireEbayApiPermit(
  bucketName,
  {
    priority = "background",
    label = "",
  } = {}
) {
  if (!enabled()) {
    return {
      enabled: false,
      bucket: bucketName,
      priority,
    };
  }

  const key = bucketName === "getItems" ? "getItems" : "browse";
  const effectivePriority =
    String(priority).toLowerCase() === "interactive"
      ? "interactive"
      : "background";

  return serialized(async () => {
    const data = loadState();
    const bucket = data.buckets[key];
    let now = Date.now();
    pruneBucket(bucket, now);

    if (bucket.cooldownUntil > now) {
      const status = bucketStatus(key, now);
      opWarn("ebay-rate", "request deferred during remote cooldown", {
        bucket: key,
        priority: effectivePriority,
        label: label || null,
        cooldownUntil: new Date(bucket.cooldownUntil).toISOString(),
        usedLast24h: status.usedLast24h,
      });

      throw deferError(
        key,
        effectivePriority,
        "remote-cooldown",
        bucket.cooldownUntil,
        429
      );
    }

    const cfg = configFor(key);
    const cap =
      effectivePriority === "interactive"
        ? cfg.hardCap
        : cfg.backgroundCap;

    const remoteKnown = hasAuthoritativeRemoteQuota(bucket);
    const remoteRemaining =
      remoteKnown
        ? Math.max(0, Number(bucket.remoteRemaining))
        : null;

    const remoteThreshold =
      effectivePriority === "interactive"
        ? cfg.safetyMargin
        : cfg.safetyMargin + cfg.interactiveReserve;

    if (
      remoteRemaining != null &&
      remoteRemaining <= remoteThreshold
    ) {
      const retryAt =
        Number(bucket.remoteResetAt || 0) > now
          ? Number(bucket.remoteResetAt)
          : now + 60 * 60 * 1000;

      opWarn("ebay-rate", "authoritative eBay quota reserve reached; request deferred", {
        bucket: key,
        priority: effectivePriority,
        label: label || null,
        remoteRemaining,
        remoteThreshold,
        remoteResetAt:
          bucket.remoteResetAt
            ? new Date(bucket.remoteResetAt).toISOString()
            : null,
      });

      throw deferError(
        key,
        effectivePriority,
        "remote-quota",
        retryAt,
        429
      );
    }

    if (bucket.events.length >= cap) {
      const retryAt = (bucket.events[0] || now) + WINDOW_MS;
      const status = bucketStatus(key, now);

      opWarn("ebay-rate", "local rolling API budget exhausted; request deferred", {
        bucket: key,
        priority: effectivePriority,
        label: label || null,
        usedLast24h: status.usedLast24h,
        cap,
        retryAt: new Date(retryAt).toISOString(),
      });

      throw deferError(
        key,
        effectivePriority,
        "rolling-budget",
        retryAt,
        429
      );
    }

    const waitMs = Math.max(
      0,
      Number(bucket.lastCallAt || 0) + cfg.minIntervalMs - now
    );

    if (waitMs) {
      await sleep(waitMs);
      now = Date.now();
      pruneBucket(bucket, now);
    }

    if (bucket.events.length >= cap) {
      const retryAt = (bucket.events[0] || now) + WINDOW_MS;
      throw deferError(
        key,
        effectivePriority,
        "rolling-budget",
        retryAt,
        429
      );
    }

    bucket.events.push(now);
    bucket.lastCallAt = now;

    if (
      hasAuthoritativeRemoteQuota(bucket) &&
      Number(bucket.remoteRemaining) > 0 &&
      Number(bucket.remoteResetAt || 0) > now
    ) {
      bucket.remoteRemaining =
        Math.max(0, Number(bucket.remoteRemaining) - 1);
    }

    persist();

    const status = bucketStatus(key, now);

    opLog("ebay-rate", "API permit granted", {
      bucket: key,
      priority: effectivePriority,
      label: label || null,
      usedLast24h: status.usedLast24h,
      backgroundRemaining: status.backgroundRemaining,
      interactiveRemaining: status.interactiveRemaining,
    });

    return {
      enabled: true,
      ...status,
      priority: effectivePriority,
    };
  });
}

function retryAfterMs(response) {
  const value = String(response?.headers?.get?.("retry-after") || "").trim();
  if (!value) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return 0;
}

function looksResourceExhausted(response, detail = "") {
  if (Number(response?.status) !== 429) return false;

  const text = String(detail || "").toLowerCase();

  return (
    /"errorid"\s*:\s*2001/.test(text) ||
    text.includes("request limit has been reached for the resource")
  );
}

function looksRateLimited(response, detail = "") {
  if (Number(response?.status) === 429) return true;

  const text = String(detail || "").toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("maximum call limit") ||
    text.includes("call limit exceeded") ||
    text.includes("too many requests")
  );
}

export function noteEbayApiResponse(bucketName, response, detail = "") {
  if (!enabled()) {
    return {
      rateLimited: false,
      retryAt: 0,
    };
  }

  const key = bucketName === "getItems" ? "getItems" : "browse";

  if (!looksRateLimited(response, detail)) {
    return {
      rateLimited: false,
      retryAt: 0,
    };
  }

  const data = loadState();
  const bucket = data.buckets[key];
  const explicitRetry = retryAfterMs(response);
  const hardResourceLimit =
    looksResourceExhausted(response, detail);

  bucket.consecutiveRateLimitHits =
    Number(bucket.consecutiveRateLimitHits || 0) + 1;

  const legacyGenericCooldown =
    intEnv("EBAY_RATE_LIMIT_COOLDOWN_MINUTES", 60, 1, 24 * 60) *
    60_000;

  const backoffBaseMs = intEnv(
    "EBAY_RATE_BACKOFF_BASE_MS",
    2_000,
    250,
    60_000
  );
  const backoffMaxMs = intEnv(
    "EBAY_RATE_BACKOFF_MAX_MS",
    legacyGenericCooldown,
    backoffBaseMs,
    24 * 60 * 60 * 1000
  );
  const jitterPct = numberEnv(
    "EBAY_RATE_BACKOFF_JITTER_PCT",
    0.25,
    0,
    1
  );
  const exponentialMs = Math.min(
    backoffMaxMs,
    backoffBaseMs * (2 ** Math.min(10, Math.max(0, bucket.consecutiveRateLimitHits - 1)))
  );
  const jitterMs = exponentialMs * jitterPct * Math.random();
  const genericCooldown = Math.round(exponentialMs + jitterMs);

  const resourceCooldown =
    intEnv("EBAY_RESOURCE_LIMIT_COOLDOWN_HOURS", 24, 1, 48) *
    60 * 60 * 1000;

  const fallbackCooldown =
    hardResourceLimit
      ? resourceCooldown
      : genericCooldown;

  const retryAt =
    Date.now() + Math.max(
      explicitRetry || 0,
      explicitRetry ? 1000 : fallbackCooldown
    );

  bucket.cooldownUntil = Math.max(
    Number(bucket.cooldownUntil || 0),
    retryAt
  );
  bucket.cooldownReason =
    hardResourceLimit
      ? "resource-exhausted"
      : "remote-rate-limit";
  bucket.remoteRateLimitHits =
    Number(bucket.remoteRateLimitHits || 0) + 1;
  bucket.lastRateLimitAt = new Date().toISOString();

  persist();

  opWarn("ebay-rate", "eBay reported a rate limit; requests paused", {
    bucket: key,
    status: Number(response?.status || 0),
    cooldownUntil: new Date(bucket.cooldownUntil).toISOString(),
    remoteRateLimitHits: bucket.remoteRateLimitHits,
    hardResourceLimit,
    cooldownReason: bucket.cooldownReason,
    consecutiveRateLimitHits: bucket.consecutiveRateLimitHits,
    retryAfterProvided: Boolean(explicitRetry),
  });

  return {
    rateLimited: true,
    retryAt: bucket.cooldownUntil,
    hardResourceLimit,
    cooldownReason: bucket.cooldownReason,
  };
}

export function noteEbayApiSuccess(bucketName) {
  if (!enabled()) return;
  const key = bucketName === "getItems" ? "getItems" : "browse";
  const data = loadState();
  const bucket = data.buckets[key];
  if (Number(bucket.consecutiveRateLimitHits || 0) === 0) return;
  bucket.consecutiveRateLimitHits = 0;
  persist();
}

export function noteEbayRemoteQuota(
  bucketName,
  {
    limit = null,
    remaining = null,
    resetAt = null,
    resource = "",
  } = {}
) {
  if (!enabled()) return getEbayRateGuardStatus();

  const key =
    bucketName === "getItems"
      ? "getItems"
      : "browse";

  const data = loadState();
  const bucket = data.buckets[key];
  const now = Date.now();
  pruneBucket(bucket, now);

  const parsedLimit = Number(limit);
  const parsedRemaining = Number(remaining);
  const parsedResetAt =
    typeof resetAt === "number"
      ? resetAt
      : Date.parse(String(resetAt || ""));

  if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
    bucket.remoteLimit = parsedLimit;
  }

  if (
    Number.isFinite(parsedRemaining) &&
    parsedRemaining >= 0 &&
    Number(bucket.remoteLimit || 0) > 0
  ) {
    bucket.remoteRemaining = parsedRemaining;
  }

  if (
    Number.isFinite(parsedResetAt) &&
    parsedResetAt > now
  ) {
    bucket.remoteResetAt = parsedResetAt;
  }

  bucket.remoteSyncedAt = now;
  bucket.remoteResource =
    String(resource || "").slice(0, 120);

  const cfg = configFor(key);

  if (
    bucket.remoteRemaining != null &&
    Number.isFinite(Number(bucket.remoteRemaining)) &&
    Number(bucket.remoteRemaining) <= cfg.safetyMargin &&
    Number(bucket.remoteResetAt || 0) > now
  ) {
    // Authoritative reset time is better than the conservative 24h fallback
    // created from a bare 429 response.
    bucket.cooldownUntil =
      Number(bucket.remoteResetAt);
    bucket.cooldownReason = "authoritative-quota";
  } else if (
    bucket.remoteRemaining != null &&
    Number.isFinite(Number(bucket.remoteRemaining)) &&
    Number(bucket.remoteRemaining) > cfg.safetyMargin &&
    ["resource-exhausted", "authoritative-quota"].includes(
      String(bucket.cooldownReason || "")
    )
  ) {
    // eBay says budget is available again, so clear only the hard-resource
    // cooldown. Generic short throttles remain untouched.
    bucket.cooldownUntil = 0;
    bucket.cooldownReason = "";
    bucket.consecutiveRateLimitHits = 0;
  }

  persist();

  opLog("ebay-rate", "authoritative eBay quota synchronized", {
    bucket: key,
    resource: bucket.remoteResource || null,
    remoteLimit: bucket.remoteLimit,
    remoteRemaining: bucket.remoteRemaining,
    remoteResetAt:
      bucket.remoteResetAt
        ? new Date(bucket.remoteResetAt).toISOString()
        : null,
  });

  return getEbayRateGuardStatus();
}

export function getEbayRateGuardStatus() {
  const now = Date.now();
  const data = loadState();
  pruneAll(now);

  return {
    enabled: enabled(),
    windowHours: 24,
    browse: bucketStatus("browse", now),
    getItems: bucketStatus("getItems", now),
    updatedAt: data.updatedAt || "",
  };
}

// Spread background work across the remaining quota window instead of letting
// one scheduled worker consume the entire daily allowance early in the day.
// `share` is the fraction of the currently safe background budget that this
// worker is allowed to target across its remaining cycles. Multiple workers
// can use complementary shares while the existing hard reserve remains the
// final authority at permit time.
export function recommendedEbayBackgroundCallBudget(
  bucketName,
  {
    intervalMinutes = 10,
    share = 0.45,
    maxCalls = 50,
    minCalls = 1,
  } = {}
) {
  const status = bucketStatus(bucketName === "getItems" ? "getItems" : "browse");
  const remaining = Math.max(0, Number(status.backgroundRemaining || 0));
  if (!remaining || Number(status.cooldownUntil || 0) > Date.now()) return 0;

  const interval = Math.min(Math.max(Number(intervalMinutes || 10), 1), 1440);
  const boundedShare = Math.min(Math.max(Number(share || 0), 0.01), 1);
  const cap = Math.min(Math.max(Number(maxCalls || 1), 1), 1000);
  const floor = Math.min(Math.max(Number(minCalls || 0), 0), cap);

  const now = Date.now();
  const resetAt = Number(status.remoteResetAt || 0);
  const minutesRemaining =
    resetAt > now
      ? Math.max(interval, (resetAt - now) / 60_000)
      : 1440;
  const cyclesRemaining = Math.max(1, Math.ceil(minutesRemaining / interval));

  const pressureMultiplier = Math.min(
    Math.max(Number(status.backgroundBudgetMultiplier ?? 1), 0),
    1
  );
  const spreadTarget = Math.floor(
    (remaining * boundedShare * pressureMultiplier) / cyclesRemaining
  );
  const budget = Math.max(floor, spreadTarget);
  return Math.max(0, Math.min(cap, remaining, budget));
}
