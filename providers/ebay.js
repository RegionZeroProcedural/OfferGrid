import { getConfigValue } from "../lib/privateConfig.js";
import { opLog, opWarn, timedOp } from "../lib/opsLog.js";
import {
  acquireEbayApiPermit,
  getEbayRateGuardStatus,
  isEbayRateGuardError,
  recommendedEbayBackgroundCallBudget,
  noteEbayApiResponse,
  noteEbayApiSuccess,
  noteEbayRemoteQuota,
} from "../lib/ebayRateGuard.js";
import {
  noteEbayCacheHit,
  noteEbayCacheMiss,
  noteEbayDeduplicatedCall,
  noteEbayDeferredDemand,
  noteEbayFailedCall,
  noteEbayNetworkCall,
  noteEbayRateLimitResponse,
  noteEbayRetry,
} from "../lib/ebayApiUsage.js";
import {
  EBAY_GETITEMS_SINGLE_BATCH_MAX,
  EBAY_GETITEMS_VARIATION_BATCH_MAX,
  ebayGetItemsDemandKey,
  isEbayVariationItemId,
} from "../lib/ebayBatching.js";
import { getEbayAdaptiveVerificationPolicy } from "../lib/ebayVerificationPressure.js";
import { normalizedConditionGroup } from "../lib/listingCondition.js";

let cachedToken = "";
let tokenExpiresAt = 0;
let cachedCredentialFingerprint = "";
let tokenRefreshPromise = null;
let browseCallsThisProcess = 0;
const searchResponseCache = new Map();
const itemDetailCache = new Map();
const itemIdentityCache = new Map();
const inFlightRequests = new Map();
let analyticsCache = null;
let analyticsCacheAt = 0;

// Bulk Browse getItems is a restricted capability for some production apps.
// Keep the capability process-local so one authoritative 403/1100 immediately
// switches OfferGrid to the ordinary getItem endpoint without repeatedly
// hammering a forbidden route. A later timed probe lets newly granted eBay
// permissions become usable without a code change.
let bulkGetItemsCapability = "unknown";
let bulkGetItemsCapabilityAt = 0;
let bulkGetItemsProbePromise = null;
let bulkGetItemsProbeResolve = null;

// Individual getItem fallback shares the ordinary Browse quota with search.
// Identity verification receives a protected share because pending competitors
// cannot become trusted without PRODUCT detail. Ordinary price refresh may use
// only the unreserved slice while an identity backlog exists.
let getItemFallbackWindowStartedAt = 0;
let getItemFallbackWindowBudget = 0;
let getItemFallbackIdentityUsed = 0;
let getItemFallbackPriceUsed = 0;
let getItemFallbackIdentityBacklog = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function boundedEnvNumber(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) ? raw : fallback;
  return Math.min(Math.max(value, min), max);
}

function bulkGetItemsRetryMs() {
  return boundedEnvNumber(
    "EBAY_BULK_GETITEMS_RETRY_MINUTES",
    360,
    5,
    7 * 24 * 60
  ) * 60_000;
}

function currentBulkGetItemsCapability() {
  if (
    bulkGetItemsCapability === "denied" &&
    bulkGetItemsCapabilityAt > 0 &&
    Date.now() - bulkGetItemsCapabilityAt >= bulkGetItemsRetryMs()
  ) {
    bulkGetItemsCapability = "unknown";
    bulkGetItemsCapabilityAt = 0;
  }
  return bulkGetItemsCapability;
}

function settleBulkGetItemsProbe() {
  const resolve = bulkGetItemsProbeResolve;
  bulkGetItemsProbePromise = null;
  bulkGetItemsProbeResolve = null;
  resolve?.();
}

function setBulkGetItemsCapability(value) {
  const next = ["unknown", "probing", "allowed", "denied"].includes(String(value))
    ? String(value)
    : "unknown";
  bulkGetItemsCapability = next;
  bulkGetItemsCapabilityAt = next === "unknown" ? 0 : Date.now();
  if (next !== "probing") settleBulkGetItemsProbe();
}

function beginBulkGetItemsCapabilityProbe() {
  const state = currentBulkGetItemsCapability();
  if (state !== "unknown") {
    return { owner: false, state, promise: bulkGetItemsProbePromise };
  }

  setBulkGetItemsCapability("probing");
  bulkGetItemsProbePromise = new Promise(resolve => {
    bulkGetItemsProbeResolve = resolve;
  });
  return { owner: true, state: "probing", promise: bulkGetItemsProbePromise };
}

async function waitForBulkGetItemsCapabilityProbe() {
  const promise = bulkGetItemsProbePromise;
  if (promise) await promise;
  return currentBulkGetItemsCapability();
}

function fallbackWindowMinutes() {
  return boundedEnvNumber(
    "EBAY_GETITEM_FALLBACK_WINDOW_MINUTES",
    10,
    1,
    60
  );
}

function fallbackBackgroundShare() {
  return boundedEnvNumber(
    "EBAY_GETITEM_FALLBACK_BROWSE_SHARE",
    0.30,
    0.01,
    0.80
  );
}

function fallbackIdentityReserveShare() {
  return boundedEnvNumber(
    "EBAY_GETITEM_FALLBACK_IDENTITY_RESERVE_SHARE",
    0.80,
    0.50,
    0.95
  );
}

function fallbackPurpose(includeProductIdentity) {
  return includeProductIdentity ? "identity" : "price";
}

function currentFallbackAdaptivePolicy() {
  return getEbayAdaptiveVerificationPolicy(getItemFallbackIdentityBacklog);
}

function recommendedGetItemFallbackWindowBudget() {
  const adaptive = currentFallbackAdaptivePolicy();
  const globalMax = Math.floor(
    boundedEnvNumber(
      "EBAY_GETITEM_FALLBACK_MAX_CALLS_PER_WINDOW",
      40,
      1,
      250
    )
  );
  const baseBudget = recommendedEbayBackgroundCallBudget("browse", {
    intervalMinutes: fallbackWindowMinutes(),
    share: fallbackBackgroundShare(),
    maxCalls: globalMax,
    minCalls: 0,
  });

  if (!adaptive.fallbackMaxCallsPerWindow || !adaptive.fallbackBrowseShare) {
    return baseBudget;
  }

  const adaptiveBudget = recommendedEbayBackgroundCallBudget("browse", {
    intervalMinutes: fallbackWindowMinutes(),
    share: Math.max(
      fallbackBackgroundShare(),
      Number(adaptive.fallbackBrowseShare || 0)
    ),
    maxCalls: Math.min(globalMax, adaptive.fallbackMaxCallsPerWindow),
    minCalls: 0,
  });

  // Adaptive mode is a catch-up floor, never a downgrade of an operator's
  // existing explicit fallback settings.
  return Math.max(baseBudget, adaptiveBudget);
}

function refreshGetItemFallbackWindow(now = Date.now()) {
  const windowMs = fallbackWindowMinutes() * 60_000;
  if (
    !getItemFallbackWindowStartedAt ||
    now - getItemFallbackWindowStartedAt >= windowMs
  ) {
    getItemFallbackWindowStartedAt = now;
    getItemFallbackIdentityUsed = 0;
    getItemFallbackPriceUsed = 0;
    getItemFallbackWindowBudget = 0;
  }

  // V3.7.38: backlog pressure may rise after a fallback window has already
  // started (for example, the price verifier can run before the sanitizer).
  // Allow the active window to top up to the current adaptive recommendation,
  // but never shrink it mid-window. RateGuard still authoritatively enforces
  // the safe background reserve on every actual Browse call.
  getItemFallbackWindowBudget = Math.max(
    getItemFallbackWindowBudget,
    recommendedGetItemFallbackWindowBudget()
  );
}

function fallbackWindowSnapshot() {
  refreshGetItemFallbackWindow();
  const adaptive = currentFallbackAdaptivePolicy();
  const totalBudget = Math.max(0, Number(getItemFallbackWindowBudget || 0));
  const identityUsed = Math.max(0, Number(getItemFallbackIdentityUsed || 0));
  const priceUsed = Math.max(0, Number(getItemFallbackPriceUsed || 0));
  const used = identityUsed + priceUsed;
  const identityReserve = Math.min(
    totalBudget,
    Math.ceil(totalBudget * fallbackIdentityReserveShare())
  );
  const priceBudget = Math.max(0, totalBudget - identityReserve);
  return {
    totalBudget,
    used,
    remaining: Math.max(0, totalBudget - used),
    identityReserve,
    identityUsed,
    identityRemaining: Math.max(0, totalBudget - used),
    priceBudget,
    priceUsed,
    priceRemaining: Math.max(0, priceBudget - priceUsed),
    identityBacklog: adaptive.pending,
    adaptiveMode: adaptive.mode,
    adaptiveBrowseShare: adaptive.fallbackBrowseShare,
    adaptiveMaxCallsPerWindow: adaptive.fallbackMaxCallsPerWindow,
    adaptiveDiscoveryScale: adaptive.discoveryScale,
    suspendBackgroundPriceRefresh: adaptive.suspendBackgroundPriceRefresh,
  };
}

function reserveGetItemFallbackAllowance(
  requested,
  priority = "background",
  { includeProductIdentity = true } = {}
) {
  const count = Math.max(0, Math.floor(Number(requested) || 0));
  if (!count) return 0;

  const guard = getEbayRateGuardStatus()?.browse || {};
  if (priority !== "background") {
    const cap = Math.floor(
      boundedEnvNumber(
        "EBAY_INTERACTIVE_GETITEM_FALLBACK_MAX",
        6,
        1,
        20
      )
    );
    return Math.max(
      0,
      Math.min(count, cap, Number(guard.interactiveRemaining || 0))
    );
  }

  const perBatchCap = Math.floor(
    boundedEnvNumber(
      "EBAY_BACKGROUND_GETITEM_FALLBACK_MAX_PER_BATCH",
      8,
      1,
      20
    )
  );
  const snapshot = fallbackWindowSnapshot();
  const purpose = fallbackPurpose(includeProductIdentity);
  const purposeRemaining = purpose === "identity"
    ? snapshot.remaining
    : Math.min(snapshot.priceRemaining, snapshot.remaining);
  const granted = Math.max(
    0,
    Math.min(
      count,
      perBatchCap,
      purposeRemaining,
      Number(guard.backgroundRemaining || 0)
    )
  );
  if (purpose === "identity") getItemFallbackIdentityUsed += granted;
  else getItemFallbackPriceUsed += granted;
  return granted;
}

async function mapConcurrentLimited(values, concurrency, fn) {
  const input = Array.from(values || []);
  const results = new Array(input.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= input.length) return;
      results[index] = await fn(input[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), Math.max(1, input.length)) },
      () => worker()
    )
  );
  return results;
}


function retryDelayMs(attempt) {
  const base = Math.min(
    Math.max(Number(process.env.EBAY_INFRA_RETRY_BASE_MS || 400), 100),
    10_000
  );
  const max = Math.min(
    Math.max(Number(process.env.EBAY_INFRA_RETRY_MAX_MS || 5000), base),
    60_000
  );
  const jitterPct = Math.min(
    Math.max(Number(process.env.EBAY_INFRA_RETRY_JITTER_PCT || 0.25), 0),
    1
  );
  const raw = Math.min(max, base * (2 ** Math.max(0, attempt)));
  return Math.round(raw + raw * jitterPct * Math.random());
}

async function singleFlight(key, endpoint, bucket, fn) {
  const existing = inFlightRequests.get(key);
  if (existing) {
    noteEbayDeduplicatedCall(endpoint, bucket);
    return existing;
  }

  const promise = Promise.resolve()
    .then(fn)
    .finally(() => {
      if (inFlightRequests.get(key) === promise) {
        inFlightRequests.delete(key);
      }
    });

  inFlightRequests.set(key, promise);
  return promise;
}

function reuseInFlight(key, endpoint, bucket) {
  const existing = inFlightRequests.get(key);
  if (!existing) return null;
  noteEbayDeduplicatedCall(endpoint, bucket);
  return existing;
}

async function fetchEbayWithRetry(
  url,
  {
    headers,
    bucket,
    endpoint,
    priority = "background",
    label = endpoint,
    maxRetries = 2,
    demandUnits = 0,
    demandCapacity = 0,
    demandKey = "",
  }
) {
  const cappedRetries = Math.min(
    Math.max(Number(maxRetries) || 0, 0),
    2
  );

  let attempt = 0;
  while (true) {
    try {
      await acquireEbayApiPermit(bucket, {
        priority,
        label,
      });
    } catch (error) {
      if (error?.rateGuardDeferred) {
        noteEbayDeferredDemand(endpoint, bucket, {
          units: demandUnits,
          capacity: demandCapacity,
          demandKey: demandKey || `${bucket}|${endpoint}|${String(url)}`,
          priority,
          reason: error?.details?.reason || error?.cooldownReason || error?.code || "rate-guard",
        });
      }
      throw error;
    }

    noteEbayNetworkCall(endpoint, bucket, {
      units: demandUnits,
      capacity: demandCapacity,
      demandKey: demandKey || `${bucket}|${endpoint}|${String(url)}`,
    });
    browseCallsThisProcess++;

    let response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      noteEbayFailedCall(endpoint, bucket);
      if (attempt >= cappedRetries) throw error;
      noteEbayRetry(endpoint, bucket);
      await sleep(retryDelayMs(attempt));
      attempt++;
      continue;
    }

    if (response.ok) {
      noteEbayApiSuccess(bucket);
      return response;
    }

    if (response.status >= 500 && response.status <= 599) {
      noteEbayFailedCall(endpoint, bucket);
      if (attempt < cappedRetries) {
        noteEbayRetry(endpoint, bucket);
        await sleep(retryDelayMs(attempt));
        attempt++;
        continue;
      }
    }

    return response;
  }
}

function required(name) {
  const value = getConfigValue(name, "");
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanIdentifier(value) {
  return String(value || "").trim();
}

function cleanKeywordQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchableKeyword(value) {
  const query = cleanKeywordQuery(value);
  if (query.length < 2) return "";
  return /[\p{L}\p{N}]/u.test(query) ? query : "";
}

function canonicalSearchRequestValue(mode, value) {
  const raw = String(value || "");

  // eBay keyword search is case-insensitive for the requests OfferGrid makes.
  // Canonicalizing only the request/cache key (not the outbound query text)
  // allows simultaneous users to share equivalent searches such as
  // "Example Widget 100" and "example   widget 100" without changing what
  // OfferGrid sends to eBay or broadening the semantic meaning of a query.
  if (mode === "q") {
    return cleanKeywordQuery(raw).toLowerCase();
  }

  if (mode === "gtin") return normalizeEbayGtin(raw);
  if (mode === "epid") return normalizeEbayEpid(raw);
  return cleanIdentifier(raw);
}

function validIsbn10(value) {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const digit = value[i] === "X" ? 10 : Number(value[i]);
    sum += digit * (10 - i);
  }
  return sum % 11 === 0;
}

function validGtinChecksum(value) {
  if (!/^\d+$/.test(value)) return false;
  if (![8, 12, 13, 14].includes(value.length)) return false;

  const body = value.slice(0, -1);
  const expected = Number(value.at(-1));
  let sum = 0;
  let weight = 3;

  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }

  const check = (10 - (sum % 10)) % 10;
  return check === expected;
}

export function normalizeEbayGtin(value) {
  const cleaned = cleanIdentifier(value)
    .toUpperCase()
    .replace(/[\s-]+/g, "");

  if (!cleaned) return "";
  if (cleaned.length === 10 && validIsbn10(cleaned)) return cleaned;
  return validGtinChecksum(cleaned) ? cleaned : "";
}

export function normalizeEbayEpid(value) {
  let cleaned = cleanIdentifier(value)
    .toUpperCase()
    .replace(/^EPID[\s:-]*/i, "")
    .replace(/\s+/g, "");

  return /^\d{5,20}$/.test(cleaned) ? cleaned : "";
}

function searchCacheSeconds() {
  const value = Number(process.env.EBAY_SEARCH_CACHE_SECONDS || 300);
  const base = Math.min(Math.max(Number.isFinite(value) ? value : 300, 0), 1800);
  if (!base) return 0;

  const max = Math.min(
    Math.max(Number(process.env.EBAY_SEARCH_CACHE_MAX_SECONDS || 1800), base),
    7200
  );
  const mode = String(getEbayRateGuardStatus()?.browse?.softLimitMode || "normal");
  const multiplier =
    mode === "critical" ? 6 :
      mode === "strict" ? 4 :
        mode === "conserve" ? 2 : 1;

  return Math.min(max, base * multiplier);
}

function cachedSearchResponse(key) {
  const ttlMs = searchCacheSeconds() * 1000;
  if (!ttlMs) return null;

  const hit = searchResponseCache.get(key);
  if (!hit) return null;

  if (Date.now() - hit.at > ttlMs) {
    searchResponseCache.delete(key);
    return null;
  }

  return hit.data;
}

function storeSearchResponse(key, data) {
  if (!searchCacheSeconds()) return;
  searchResponseCache.set(key, {
    at: Date.now(),
    data,
  });

  // Keep this tiny and bounded. It is only a short-lived API-call saver.
  if (searchResponseCache.size > 250) {
    const oldest = [...searchResponseCache.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, searchResponseCache.size - 200);

    for (const [cacheKey] of oldest) {
      searchResponseCache.delete(cacheKey);
    }
  }
}

function itemDetailCacheSeconds() {
  const value = Number(process.env.EBAY_ITEM_DETAIL_CACHE_SECONDS || 300);
  return Math.min(Math.max(Number.isFinite(value) ? value : 300, 0), 1800);
}

function itemIdentityCacheSeconds() {
  const value = Number(process.env.EBAY_ITEM_IDENTITY_CACHE_SECONDS || 86400);
  return Math.min(Math.max(Number.isFinite(value) ? value : 86400, 0), 7 * 86400);
}

function cachedItemDetail(itemId, { requireProductIdentity = false } = {}) {
  const ttlMs = itemDetailCacheSeconds() * 1000;
  if (!ttlMs) return null;
  const key = String(itemId || "");
  const hit = itemDetailCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    itemDetailCache.delete(key);
    return null;
  }
  if (requireProductIdentity && !hit.hasProductIdentity) return null;
  return { ...hit.detail };
}

function storeItemDetail(detail, { hasProductIdentity = false } = {}) {
  const key = String(detail?.externalId || "").trim();
  if (!key || !itemDetailCacheSeconds() || detail?.missing) return;
  const existing = itemDetailCache.get(key);
  itemDetailCache.set(key, {
    at: Date.now(),
    detail: { ...(existing?.detail || {}), ...detail },
    hasProductIdentity: Boolean(existing?.hasProductIdentity || hasProductIdentity),
  });

  if (hasProductIdentity) {
    itemIdentityCache.set(key, {
      at: Date.now(),
      identity: {
        gtin: String(detail.gtin || ""),
        mpn: String(detail.mpn || ""),
        brand: String(detail.brand || ""),
        epid: String(detail.epid || ""),
        inferredEpid: String(detail.inferredEpid || ""),
        title: String(detail.title || detail.listingTitle || ""),
        condition: String(detail.condition || ""),
        conditionGroup: String(detail.conditionGroup || "unknown"),
      },
    });
  }

  if (itemDetailCache.size > 5000) {
    const oldest = [...itemDetailCache.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, itemDetailCache.size - 4000);
    for (const [cacheKey] of oldest) itemDetailCache.delete(cacheKey);
  }
}

function cachedItemIdentity(itemId) {
  const ttlMs = itemIdentityCacheSeconds() * 1000;
  if (!ttlMs) return null;
  const key = String(itemId || "");
  const hit = itemIdentityCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    itemIdentityCache.delete(key);
    return null;
  }
  return { ...hit.identity };
}

function isSearch12001(detail) {
  const value = String(detail || "");
  return (
    /"errorId"\s*:\s*12001/.test(value) ||
    value.includes("must have a valid 'q'") ||
    value.includes('must have a valid "q"')
  );
}

async function responseError(response, bucket, label, prefix, endpoint = "unknown") {
  const detail = (await response.text()).slice(0, 1200);
  const rate = noteEbayApiResponse(bucket, response, detail);

  if (!(response.status >= 500 && response.status <= 599)) {
    noteEbayFailedCall(endpoint, bucket);
  }
  if (rate.rateLimited) {
    noteEbayRateLimitResponse(endpoint, bucket);
  }

  const error = new Error(
    `${prefix} ${response.status}: ${detail}`
  );
  error.status = response.status;
  const errorIdMatch = detail.match(/"errorId"\s*:\s*(\d+)/);
  if (errorIdMatch) error.ebayErrorId = Number(errorIdMatch[1]);
  if (
    Number(response.status) === 403 &&
    (Number(error.ebayErrorId) === 1100 || /insufficient permissions/i.test(detail))
  ) {
    error.code = "EBAY_ACCESS_DENIED";
  }

  if (rate.rateLimited) {
    error.code = "EBAY_REMOTE_RATE_LIMIT";
    error.rateGuardDeferred = true;
    error.retryAt = rate.retryAt;
    error.hardResourceLimit =
      Boolean(rate.hardResourceLimit);
    error.cooldownReason =
      rate.cooldownReason || "";

    if (rate.hardResourceLimit) {
      try {
        const analytics =
          await syncEbayApplicationRateLimits({
            force: true,
          });

        const remote =
          bucket === "getItems"
            ? analytics?.getItems
            : analytics?.browse;

        if (
          remote &&
          Number.isFinite(Number(remote.remaining))
        ) {
          error.remoteRemaining =
            Number(remote.remaining);
          error.remoteLimit =
            Number(remote.limit);
          error.remoteResetAt =
            Number(remote.resetAt || 0);
          error.retryAt =
            Number(remote.resetAt || 0) ||
            error.retryAt;
        }
      } catch (analyticsError) {
        opWarn(
          "ebay-analytics",
          "could not retrieve authoritative reset after rate-limit response",
          {
            status:
              analyticsError?.status || null,
            code:
              analyticsError?.code || null,
          }
        );
      }
    }
  } else if (isSearch12001(detail)) {
    error.code = "EBAY_INVALID_REMOTE_SEARCH";
    error.ebayErrorId = 12001;
  }

  opWarn("ebay-api", `${label} failed`, {
    status: response.status,
    code: error.code || null,
  });

  return error;
}

function ebayEnvironment() {
  const value = String(getConfigValue("EBAY_ENVIRONMENT", "sandbox")).toLowerCase();
  return value === "production" ? "production" : "sandbox";
}

function ebayApiBase() {
  return ebayEnvironment() === "sandbox"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
}

function ebayEnvironmentLabel() {
  return ebayEnvironment() === "sandbox" ? "Sandbox" : "Production";
}

function developerAnalyticsBase() {
  return ebayEnvironment() === "sandbox"
    ? "https://api.sandbox.ebay.com/developer/analytics/v1_beta"
    : "https://api.ebay.com/developer/analytics/v1_beta";
}

function analyticsCacheMinutes() {
  const value = Number(
    process.env.EBAY_ANALYTICS_CACHE_MINUTES || 15
  );

  return Math.min(
    Math.max(Number.isFinite(value) ? value : 15, 1),
    120
  );
}

function browseRateRows(payload) {
  const rows = [];

  for (const limit of payload?.rateLimits || []) {
    const apiName =
      String(limit?.apiName || "").toLowerCase();
    const apiContext =
      String(limit?.apiContext || "").toLowerCase();

    if (apiName && apiName !== "browse") continue;
    if (apiContext && apiContext !== "buy") continue;

    for (const resource of limit?.resources || []) {
      const resourceName =
        String(resource?.name || "");

      for (const rate of resource?.rates || []) {
        const limitValue = Number(rate?.limit);
        const remaining = Number(rate?.remaining);
        const reset = String(rate?.reset || "");
        const resetAt = Date.parse(reset);

        if (
          !Number.isFinite(limitValue) ||
          !Number.isFinite(remaining)
        ) continue;

        rows.push({
          resource: resourceName,
          limit: limitValue,
          remaining,
          reset,
          resetAt:
            Number.isFinite(resetAt)
              ? resetAt
              : 0,
          timeWindow: Number(rate?.timeWindow || 0),
          count:
            Number.isFinite(Number(rate?.count))
              ? Number(rate.count)
              : null,
        });
      }
    }
  }

  return rows;
}

function selectBrowseGeneralRate(rows) {
  const filtered = (rows || []).filter(row => {
    const name = String(row.resource || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");

    // eBay documents getItems as a separate Browse quota. Exclude an
    // explicitly named getItems row from the general Browse/search bucket.
    return !name.includes("getitems");
  });

  if (!filtered.length) return null;

  const preferred = filtered.filter(row => {
    const name = String(row.resource || "").toLowerCase();
    return (
      name.includes("item_summary") ||
      name.includes("item summary") ||
      name.includes("search")
    );
  });

  const pool = preferred.length
    ? preferred
    : filtered;

  // Conservative selection: if eBay reports several applicable Browse
  // resources, obey the one with the least remaining allowance.
  return [...pool].sort((a, b) =>
    Number(a.remaining) - Number(b.remaining) ||
    Number(a.resetAt || 0) - Number(b.resetAt || 0)
  )[0] || null;
}

function selectGetItemsRate(rows) {
  const exact = (rows || []).filter(row => {
    const name = String(row.resource || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    return name.includes("getitems");
  });

  if (!exact.length) return null;

  return [...exact].sort((a, b) =>
    Number(a.remaining) - Number(b.remaining) ||
    Number(a.resetAt || 0) - Number(b.resetAt || 0)
  )[0] || null;
}

export async function syncEbayApplicationRateLimits({
  force = false,
} = {}) {
  const clientId =
    getConfigValue("EBAY_CLIENT_ID", "");
  const clientSecret =
    getConfigValue("EBAY_CLIENT_SECRET", "");

  if (!clientId || !clientSecret) {
    return {
      ok: false,
      skipped: true,
      reason: "credentials-not-configured",
    };
  }

  const now = Date.now();
  const ttl =
    analyticsCacheMinutes() * 60_000;

  if (
    !force &&
    analyticsCache &&
    now - analyticsCacheAt < ttl
  ) {
    noteEbayCacheHit("developerAnalytics.getRateLimits", "unmetered");
    return analyticsCache;
  }

  noteEbayCacheMiss("developerAnalytics.getRateLimits", "unmetered");

  return singleFlight(
    `analytics:${ebayEnvironment()}:browse:buy:${force ? "force" : "normal"}`,
    "developerAnalytics.getRateLimits",
    "unmetered",
    async () => {
      const token = await getToken();
      const url = new URL(
        `${developerAnalyticsBase()}/rate_limit/`
      );
      url.searchParams.set("api_name", "browse");
      url.searchParams.set("api_context", "buy");

      const finish = timedOp(
        "ebay-analytics",
        "synchronizing Browse API call limits"
      );

      noteEbayNetworkCall("developerAnalytics.getRateLimits", "unmetered");
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (response.status === 204) {
        const result = {
          ok: false,
          skipped: true,
          reason: "analytics-no-content",
          status: 204,
        };

        analyticsCache = result;
        analyticsCacheAt = Date.now();
        finish({ status: 204 });
        return result;
      }

      if (!response.ok) {
        noteEbayFailedCall("developerAnalytics.getRateLimits", "unmetered");
        if (response.status === 429) {
          noteEbayRateLimitResponse("developerAnalytics.getRateLimits", "unmetered");
        }
        const detail = (await response.text()).slice(0, 1000);

        finish({
          status: response.status,
          failed: true,
        });

        const error = new Error(
          `eBay ${ebayEnvironmentLabel()} Developer Analytics API ${response.status}: ${detail}`
        );
        error.status = response.status;
        error.code = "EBAY_ANALYTICS_ERROR";
        throw error;
      }

      const payload = await response.json();
      const rows = browseRateRows(payload);
      const browse = selectBrowseGeneralRate(rows);
      const getItems = selectGetItemsRate(rows);

      if (browse) {
        noteEbayRemoteQuota("browse", {
          limit: browse.limit,
          remaining: browse.remaining,
          resetAt: browse.resetAt || browse.reset,
          resource: browse.resource,
        });
      }

      if (getItems) {
        noteEbayRemoteQuota("getItems", {
          limit: getItems.limit,
          remaining: getItems.remaining,
          resetAt: getItems.resetAt || getItems.reset,
          resource: getItems.resource,
        });
      }

      const result = {
        ok: true,
        rows,
        browse,
        getItems,
        syncedAt: new Date().toISOString(),
      };

      analyticsCache = result;
      analyticsCacheAt = Date.now();

      finish({
        status: 200,
        rows: rows.length,
        browseRemaining:
          browse?.remaining ?? null,
        getItemsRemaining:
          getItems?.remaining ?? null,
      });

      return result;
    }
  );
}

async function getToken() {
  const clientId = required("EBAY_CLIENT_ID");
  const clientSecret = required("EBAY_CLIENT_SECRET");
  const environment = ebayEnvironment();

  const fingerprint = Buffer
    .from(`${environment}:${clientId}:${clientSecret}`)
    .toString("base64");

  if (cachedCredentialFingerprint !== fingerprint) {
    cachedToken = "";
    tokenExpiresAt = 0;
    cachedCredentialFingerprint = fingerprint;
  }

  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  if (tokenRefreshPromise) return tokenRefreshPromise;

  tokenRefreshPromise = (async () => {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const finish = timedOp("ebay-oauth", `requesting ${ebayEnvironmentLabel()} application token`);

    noteEbayNetworkCall("oauth.token", "unmetered");
    const response = await fetch(`${ebayApiBase()}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "https://api.ebay.com/oauth/api_scope",
      }),
    });

    if (!response.ok) {
      noteEbayFailedCall("oauth.token", "unmetered");
      if (response.status === 429) {
        noteEbayRateLimitResponse("oauth.token", "unmetered");
      }
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`eBay ${ebayEnvironmentLabel()} OAuth ${response.status}: ${detail}`);
    }

    const data = await response.json();
    finish("complete", { expiresIn: Number(data.expires_in || 7200) });
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + Number(data.expires_in || 7200) * 1000;
    return cachedToken;
  })().finally(() => {
    tokenRefreshPromise = null;
  });

  return tokenRefreshPromise;
}

async function requestHeaders() {
  const token = await getToken();
  const marketplace = getConfigValue("EBAY_MARKETPLACE_ID", "EBAY_US");
  const campaignId = getConfigValue("EBAY_AFFILIATE_CAMPAIGN_ID", "");
  const referenceId = getConfigValue("EBAY_AFFILIATE_REFERENCE_ID", "offergrid");
  const buyerCountry = String(process.env.EBAY_BUYER_COUNTRY || "").trim().toUpperCase();
  const buyerPostal = String(process.env.EBAY_BUYER_POSTAL_CODE || "").trim();

  const headers = {
    Authorization: `Bearer ${token}`,
    "X-EBAY-C-MARKETPLACE-ID": marketplace,
  };

  const ctx = [];
  if (campaignId) {
    ctx.push(`affiliateCampaignId=${campaignId}`);
    if (referenceId) ctx.push(`affiliateReferenceId=${referenceId}`);
  }

  if (buyerCountry && buyerPostal) {
    ctx.push(`contextualLocation=country=${buyerCountry},zip=${buyerPostal}`);
  }

  if (ctx.length) headers["X-EBAY-C-ENDUSERCTX"] = ctx.join(",");
  return headers;
}

function shippingPrice(options) {
  const prices = (options || [])
    .map(option => numberOrNull(option?.shippingCost?.value))
    .filter(value => value != null && value >= 0);
  return prices.length ? Math.min(...prices) : null;
}

function conditionGroup(condition) {
  return normalizedConditionGroup(condition);
}

function availabilityInfo(data) {
  const availability = (data?.estimatedAvailabilities || [])[0] || {};
  const status = String(availability.estimatedAvailabilityStatus || "");
  const end = Date.parse(data?.itemEndDate || "");
  const ended = Number.isFinite(end) && end < Date.now();

  return {
    availability: ended || status === "OUT_OF_STOCK" ? "out_of_stock" : "in_stock",
    estimatedAvailableQuantity:
      numberOrNull(
        availability.estimatedRemainingQuantity ??
        availability.estimatedAvailableQuantity
      ),
    availabilityThreshold: numberOrNull(availability.availabilityThreshold),
    availabilityThresholdType: String(availability.availabilityThresholdType || ""),
  };
}

function marketingInfo(data) {
  const marketing = data?.marketingPrice || {};
  const treatment = String(marketing.priceTreatment || "");
  const displayCondition = String(data?.priceDisplayCondition || "");

  return {
    originalPrice:
      numberOrNull(marketing?.originalPrice?.value) ??
      numberOrNull(marketing?.originalPrice),
    priceTreatment: treatment,
    priceDisplayCondition: displayCondition,
    priceDisplayRestricted:
      treatment === "MINIMUM_ADVERTISED_PRICE" ||
      Boolean(displayCondition),
  };
}

function firstLocalizedAspect(data, wanted) {
  const key = String(wanted).toLowerCase();
  const hit = (data?.localizedAspects || []).find(
    aspect => String(aspect?.name || "").toLowerCase() === key
  );
  if (Array.isArray(hit?.value)) return String(hit.value[0] || "");
  return hit?.value ? String(hit.value) : "";
}

function itemIdentity(data) {
  const product = data?.product || {};
  return {
    gtin: cleanIdentifier(data?.gtin) || cleanIdentifier(product?.gtins?.[0]),
    mpn:
      cleanIdentifier(data?.mpn) ||
      cleanIdentifier(product?.mpns?.[0]) ||
      cleanIdentifier(firstLocalizedAspect(data, "MPN")),
    brand:
      cleanIdentifier(data?.brand) ||
      cleanIdentifier(product?.brand) ||
      cleanIdentifier(firstLocalizedAspect(data, "Brand")),
    epid: cleanIdentifier(data?.epid),
    inferredEpid: cleanIdentifier(data?.inferredEpid),
  };
}

function couponSummary(data) {
  return (data?.availableCoupons || []).slice(0, 8).map(coupon => ({
    code: String(coupon?.couponCode || coupon?.redemptionCode || ""),
    message: String(coupon?.message || coupon?.terms || ""),
    discountType: String(coupon?.discountType || ""),
    discountAmount:
      numberOrNull(coupon?.discountAmount?.value) ??
      numberOrNull(coupon?.discountAmount),
  }));
}

export function parseEbayItemDetail(data, fallback = {}) {
  const price = numberOrNull(data?.price?.value);
  const identity = itemIdentity(data);
  const availability = availabilityInfo(data);
  const marketing = marketingInfo(data);
  const exactTitle = String(data?.title || fallback.title || "");

  return {
    provider: "ebay",
    externalId: String(data?.itemId || fallback.externalId || ""),
    legacyItemId: String(data?.legacyItemId || ""),
    title: exactTitle,
    listingTitle: exactTitle,
    merchant: String(data?.seller?.username || fallback.merchant || "eBay seller"),
    price,
    ...marketing,
    shippingPrice: shippingPrice(data?.shippingOptions),
    currency: String(data?.price?.currency || fallback.currency || "USD"),
    affiliateUrl: data?.itemAffiliateWebUrl || data?.itemWebUrl || fallback.affiliateUrl || "",
    sourceUrl: data?.itemWebUrl || fallback.sourceUrl || "",
    imageUrl: String(data?.image?.imageUrl || fallback.imageUrl || ""),
    brand: identity.brand,
    gtin: identity.gtin,
    mpn: identity.mpn,
    epid: identity.epid,
    inferredEpid: identity.inferredEpid,
    condition: String(data?.condition || fallback.condition || ""),
    conditionGroup: conditionGroup(data?.condition || fallback.condition || ""),
    buyingOptions: Array.isArray(data?.buyingOptions) ? data.buyingOptions : [],
    ...availability,
    lotSize: numberOrNull(data?.lotSize),
    quantityLimitPerBuyer: numberOrNull(data?.quantityLimitPerBuyer),
    unitPrice: numberOrNull(data?.unitPrice?.value),
    unitPriceCurrency: String(data?.unitPrice?.currency || ""),
    unitPricingMeasure: String(data?.unitPricingMeasure || ""),
    primaryItemGroupId: String(data?.primaryItemGroup?.itemGroupId || ""),
    primaryItemGroupType: String(data?.primaryItemGroup?.itemGroupType || ""),
    itemEndDate: String(data?.itemEndDate || ""),
    coupons: couponSummary(data),
    priceSource: "ebay-item-detail",
    priceVerifiedAt: new Date().toISOString(),
    environment: ebayEnvironment(),
  };
}

function summaryToCandidate(item, fallbackCategory = "", identity = {}) {
  const price = numberOrNull(item?.price?.value);
  if (price == null) return null;

  const affiliateUrl = item.itemAffiliateWebUrl || item.itemWebUrl;
  if (!affiliateUrl) return null;

  const seller = item.seller || {};
  const defaultRate = Number(getConfigValue("EBAY_DEFAULT_COMMISSION_RATE", "0.03"));
  const availability = availabilityInfo(item);
  const marketing = marketingInfo(item);
  const title = String(item.title || identity.title || "Untitled eBay item");
  const categories = Array.isArray(item.categories) ? item.categories : [];

  return {
    provider: "ebay",
    externalId: String(item.itemId || item.legacyItemId || affiliateUrl),
    legacyItemId: String(item.legacyItemId || ""),
    title,
    listingTitle: title,
    merchant: seller.username || "eBay seller",
    price,
    searchObservedPrice: price,
    searchObservedAt: new Date().toISOString(),
    ...marketing,
    shippingPrice: shippingPrice(item.shippingOptions),
    currency: item?.price?.currency || "USD",
    affiliateUrl,
    sourceUrl: item.itemWebUrl || "",
    imageUrl: item?.image?.imageUrl || "",
    brand: cleanIdentifier(identity.brand),
    category: categories[0]?.categoryName || fallbackCategory || "Other",
    ...availability,
    commissionRate: defaultRate,
    commissionIsEstimate: true,
    merchantRatingPct: numberOrNull(seller.feedbackPercentage),
    gtin: cleanIdentifier(identity.gtin),
    mpn: cleanIdentifier(identity.mpn),
    epid: cleanIdentifier(identity.epid || item.epid),
    condition: String(item.condition || ""),
    conditionGroup: conditionGroup(item.condition),
    buyingOptions: Array.isArray(item.buyingOptions) ? item.buyingOptions : [],
    unitPrice: numberOrNull(item?.unitPrice?.value),
    unitPriceCurrency: String(item?.unitPrice?.currency || ""),
    unitPricingMeasure: String(item?.unitPricingMeasure || ""),
    lotSize: numberOrNull(item?.lotSize),
    quantityLimitPerBuyer: numberOrNull(item?.quantityLimitPerBuyer),
    priceSource: "ebay-search",
    priceVerifiedAt: null,
    environment: ebayEnvironment(),
  };
}

export async function searchEbayAdvanced({
  query = "",
  gtin = "",
  epid = "",
  limit = 30,
  fixedPriceOnly = true,
  forcedIdentity = {},
  priority = "background",
  keywordOnly = false,
  offset = 0,
} = {}) {
  const rawQuery = cleanKeywordQuery(query);
  const cleanQuery = searchableKeyword(query);
  const rawGtin = cleanIdentifier(gtin);
  const rawEpid = cleanIdentifier(epid);
  const cleanGtin = normalizeEbayGtin(gtin);
  const cleanEpid = normalizeEbayEpid(epid);

  if (rawGtin && !cleanGtin) {
    opWarn("ebay-search", "invalid GTIN rejected locally before eBay call", {
      gtin: rawGtin.slice(0, 40),
      fallbackQuery: cleanQuery || null,
    });
  }

  if (rawEpid && !cleanEpid) {
    opWarn("ebay-search", "invalid ePID rejected locally before eBay call", {
      epid: rawEpid.slice(0, 40),
      fallbackQuery: cleanQuery || null,
    });
  }

  let mode = "";
  let value = "";

  if (!keywordOnly && cleanGtin) {
    mode = "gtin";
    value = cleanGtin;
  } else if (!keywordOnly && cleanEpid) {
    mode = "epid";
    value = cleanEpid;
  } else if (cleanQuery) {
    mode = "q";
    value = cleanQuery;
  } else {
    const error = new Error(
      `eBay search blocked locally: no valid q, GTIN, or ePID. ` +
      `Raw query=${JSON.stringify(rawQuery.slice(0, 100))}.`
    );
    error.code = "EBAY_INVALID_SEARCH";
    error.status = 400;
    throw error;
  }

  const cappedLimit = Math.min(Math.max(Number(limit), 1), 200);
  const cappedOffset = Math.min(Math.max(Number(offset || 0), 0), 9999);
  const canonicalRequestValue = canonicalSearchRequestValue(mode, value);
  const cacheKey = [
    ebayEnvironment(),
    getConfigValue("EBAY_MARKETPLACE_ID", "EBAY_US"),
    mode,
    canonicalRequestValue,
    cappedLimit,
    cappedOffset,
    fixedPriceOnly ? "fixed" : "all",
  ].join("|");

  let data = cachedSearchResponse(cacheKey);
  const endpoint = "browse.search";

  const searchLabel =
    mode === "gtin"
      ? `GTIN ${value}`
      : mode === "epid"
        ? `ePID ${value}`
        : `"${value}"`;

  if (data) {
    noteEbayCacheHit(endpoint, "browse");
    opLog("ebay-search", `cache hit ${searchLabel}`, {
      limit: cappedLimit,
      offset: cappedOffset,
    });
  } else {
    noteEbayCacheMiss(endpoint, "browse");
    data = await singleFlight(
      `search:${cacheKey}`,
      endpoint,
      "browse",
      async () => {
        const secondChance = cachedSearchResponse(cacheKey);
        if (secondChance) {
          noteEbayCacheHit(endpoint, "browse");
          return secondChance;
        }

        const headers = await requestHeaders();
        const url = new URL(`${ebayApiBase()}/buy/browse/v1/item_summary/search`);
        url.searchParams.set(mode, value);
        url.searchParams.set("limit", String(cappedLimit));
        if (cappedOffset > 0) url.searchParams.set("offset", String(cappedOffset));

        if (fixedPriceOnly) {
          url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE}");
        }

        const finish = timedOp("ebay-search", `Browse search ${searchLabel}`, {
          limit: cappedLimit,
          priority,
        });

        const response = await fetchEbayWithRetry(url, {
          headers,
          bucket: "browse",
          endpoint,
          priority,
          label: `search:${mode}:${value.slice(0, 80)}`,
          demandUnits: cappedLimit,
          demandCapacity: 200,
          demandKey: `browse.search|${cacheKey}`,
        });

        if (!response.ok) {
          finish("failed", {
            status: response.status,
            callsThisProcess: browseCallsThisProcess,
          });

          const error = await responseError(
            response,
            "browse",
            `Browse search ${searchLabel}`,
            `eBay ${ebayEnvironmentLabel()} Browse API`,
            endpoint
          );

          error.searchCriteria = {
            mode,
            queryLength: cleanQuery.length,
            hasValidGtin: Boolean(cleanGtin),
            hasValidEpid: Boolean(cleanEpid),
            keywordOnly: Boolean(keywordOnly),
          };

          throw error;
        }

        const payload = await response.json();
        storeSearchResponse(cacheKey, payload);

        finish("complete", {
          returned: Array.isArray(payload.itemSummaries)
            ? payload.itemSummaries.length
            : 0,
          callsThisProcess: browseCallsThisProcess,
        });

        return payload;
      }
    );
  }

  const deduped = new Map();

  for (const raw of data.itemSummaries || []) {
    const candidate = summaryToCandidate(raw, cleanQuery || value, forcedIdentity);
    if (!candidate) continue;
    const key = `${candidate.provider}:${candidate.externalId}`;
    if (!deduped.has(key)) deduped.set(key, candidate);
  }

  return [...deduped.values()];
}

export async function searchEbay(query, limit = 30, options = {}) {
  return searchEbayAdvanced({
    query,
    limit,
    fixedPriceOnly: true,
    priority: options?.priority || "background",
    offset: options?.offset || 0,
  });
}

export async function getEbayItemDetails(
  itemId,
  {
    compact = false,
    includeProductIdentity = false,
    priority = "background",
    forceRefresh = false,
  } = {}
) {
  if (!itemId) throw new Error("eBay item ID is required.");

  const endpoint = "browse.getItem";
  const requireProductIdentity = Boolean(includeProductIdentity);
  if (!forceRefresh) {
    const cached = cachedItemDetail(itemId, { requireProductIdentity });
    if (cached) {
      noteEbayCacheHit(endpoint, "browse");
      return cached;
    }
  }
  noteEbayCacheMiss(endpoint, "browse");

  const baseFlightKey = [
    "getItem",
    ebayEnvironment(),
    String(itemId),
  ].join("|");
  const capability = requireProductIdentity
    ? "product"
    : (compact ? "compact" : "market");
  const flightKey = `${baseFlightKey}|${capability}`;

  // A PRODUCT response includes the market/price fields required by leaner
  // callers. If an identity proof request is already in flight, let a price
  // refresh or compact caller reuse it instead of issuing a second getItem.
  if (!requireProductIdentity) {
    const richer = reuseInFlight(`${baseFlightKey}|product`, endpoint, "browse");
    if (richer) return richer;

    // Likewise, a normal market response can satisfy a COMPACT caller.
    if (compact) {
      const market = reuseInFlight(`${baseFlightKey}|market`, endpoint, "browse");
      if (market) return market;
    }
  }

  return singleFlight(flightKey, endpoint, "browse", async () => {
    if (!forceRefresh) {
      const secondChance = cachedItemDetail(itemId, { requireProductIdentity });
      if (secondChance) {
        noteEbayCacheHit(endpoint, "browse");
        return secondChance;
      }
    }

    const headers = await requestHeaders();
    const url = new URL(`${ebayApiBase()}/buy/browse/v1/item/${encodeURIComponent(String(itemId))}`);
    if (requireProductIdentity) url.searchParams.set("fieldgroups", "PRODUCT");
    else if (compact) url.searchParams.set("fieldgroups", "COMPACT");

    const finish = timedOp("ebay-item", `getItem ${String(itemId)}`);
    const response = await fetchEbayWithRetry(url, {
      headers,
      bucket: "browse",
      endpoint,
      priority,
      label: `getItem:${String(itemId).slice(0, 80)}`,
      demandUnits: 1,
      demandCapacity: 1,
      demandKey: `browse.getItem|${ebayEnvironment()}|${String(itemId)}|${capability}`,
    });

    if (response.status === 404) {
      finish("missing", { callsThisProcess: browseCallsThisProcess });
      return {
        missing: true,
        externalId: String(itemId),
        priceVerifiedAt: new Date().toISOString(),
      };
    }

    if (!response.ok) {
      finish("failed", {
        status: response.status,
        callsThisProcess: browseCallsThisProcess,
      });

      throw await responseError(
        response,
        "browse",
        `getItem ${String(itemId)}`,
        `eBay ${ebayEnvironmentLabel()} getItem`,
        endpoint
      );
    }

    const data = await response.json();
    const parsed = parseEbayItemDetail(data, { externalId: itemId });
    storeItemDetail(parsed, { hasProductIdentity: requireProductIdentity });
    finish("complete", {
      price: parsed.price,
      availability: parsed.availability,
      callsThisProcess: browseCallsThisProcess,
    });
    return parsed;
  });
}

function bulkGetItemsAccessDenied(error) {
  return (
    Number(error?.status || 0) === 403 &&
    (
      Number(error?.ebayErrorId || 0) === 1100 ||
      /insufficient permissions/i.test(String(error?.message || ""))
    )
  );
}

async function getItemsViaIndividualFallback(
  networkIds,
  {
    priority = "background",
    forceRefresh = false,
    includeProductIdentity = true,
    reason = "bulk-unavailable",
  } = {}
) {
  const ids = Array.from(networkIds || []).map(String).filter(Boolean);
  const allowance = reserveGetItemFallbackAllowance(ids.length, priority, {
    includeProductIdentity,
  });
  const selectedIds = ids.slice(0, allowance);
  const deferredIds = ids.slice(allowance);

  if (!selectedIds.length) {
    opLog("ebay-items", "individual getItem fallback deferred by Browse budget", {
      requested: ids.length,
      deferred: deferredIds.length,
      priority,
      reason,
      bulkCapability: currentBulkGetItemsCapability(),
      browseRemaining:
        priority === "background"
          ? getEbayRateGuardStatus()?.browse?.backgroundRemaining ?? 0
          : getEbayRateGuardStatus()?.browse?.interactiveRemaining ?? 0,
    });
    return {
      items: [],
      warnings: [],
      missingIds: [],
      deferredIds,
      failedIds: [],
      attemptedIds: [],
      transport: "getItem-fallback",
    };
  }

  const concurrency = Math.floor(
    boundedEnvNumber(
      priority === "background"
        ? "EBAY_BACKGROUND_GETITEM_FALLBACK_CONCURRENCY"
        : "EBAY_INTERACTIVE_GETITEM_FALLBACK_CONCURRENCY",
      priority === "background" ? 2 : 3,
      1,
      6
    )
  );

  opLog("ebay-items", "using quota-aware individual getItem fallback", {
    requested: ids.length,
    selected: selectedIds.length,
    deferred: deferredIds.length,
    priority,
    reason,
    includeProductIdentity: Boolean(includeProductIdentity),
    concurrency,
    bulkCapability: currentBulkGetItemsCapability(),
  });

  const results = await mapConcurrentLimited(
    selectedIds,
    concurrency,
    async id => {
      try {
        const detail = await getEbayItemDetails(id, {
          compact: false,
          includeProductIdentity,
          priority,
          forceRefresh,
        });
        return { id, detail };
      } catch (error) {
        return { id, error };
      }
    }
  );

  const items = [];
  const missingIds = [];
  const providerDeferredIds = [...deferredIds];
  const failedIds = [];
  const warnings = [];

  for (const result of results) {
    if (result?.detail?.missing) {
      missingIds.push(String(result.id));
      continue;
    }
    if (result?.detail) {
      items.push(result.detail);
      continue;
    }

    const error = result?.error;
    const id = String(result?.id || "");
    const status = Number(error?.status || 0) || 0;
    const deferred = Boolean(
      isEbayRateGuardError(error) ||
      error?.rateGuardDeferred ||
      !status ||
      status === 429 ||
      status >= 500
    );
    (deferred ? providerDeferredIds : failedIds).push(id);
    warnings.push({
      itemId: id,
      code: String(error?.code || "GETITEM_FALLBACK_FAILED"),
      status: status || null,
      deferred,
      message: String(error?.message || error || "getItem fallback failed").slice(0, 300),
    });
  }

  return {
    items,
    warnings,
    missingIds,
    deferredIds: [...new Set(providerDeferredIds.filter(Boolean))],
    failedIds: [...new Set(failedIds.filter(Boolean))],
    attemptedIds: selectedIds,
    transport: "getItem-fallback",
  };
}

function mergeBatchDetailResult(ids, cached, networkIds, networkResult = {}) {
  const networkItems = Array.isArray(networkResult.items) ? networkResult.items : [];
  const warnings = Array.isArray(networkResult.warnings) ? networkResult.warnings : [];
  const explicitlyMissing = new Set(
    (networkResult.missingIds || []).map(value => String(value || "")).filter(Boolean)
  );
  const deferredIds = [...new Set(
    (networkResult.deferredIds || []).map(value => String(value || "")).filter(Boolean)
  )];
  const failedIds = [...new Set(
    (networkResult.failedIds || []).map(value => String(value || "")).filter(Boolean)
  )];

  const byId = new Map(cached);
  for (const detail of networkItems) {
    byId.set(String(detail.externalId), detail);
  }

  const items = ids.map(id => byId.get(id)).filter(Boolean);
  const returnedIds = new Set(items.map(item => String(item.externalId)));
  const missingIds = ids.filter(
    id => !returnedIds.has(id) && explicitlyMissing.has(String(id))
  );

  return {
    items,
    requestedIds: ids,
    returnedIds: [...returnedIds],
    missingIds,
    deferredIds,
    failedIds,
    warnings,
    cacheHits: cached.size,
    networkIds: Number(networkResult.attemptedIds?.length ?? networkIds.length ?? 0),
    transport: String(networkResult.transport || "getItems"),
    bulkCapability: currentBulkGetItemsCapability(),
  };
}

export async function getEbayItemsDetails(
  itemIds = [],
  {
    priority = "background",
    forceRefresh = false,
    includeProductIdentity = true,
  } = {}
) {
  const uniqueIds = [...new Set(
    (itemIds || [])
      .map(value => String(value || "").trim())
      .filter(Boolean)
  )];
  const containsVariation = uniqueIds.some(isEbayVariationItemId);
  const requestMax = containsVariation
    ? EBAY_GETITEMS_VARIATION_BATCH_MAX
    : EBAY_GETITEMS_SINGLE_BATCH_MAX;
  if (uniqueIds.length > requestMax) {
    const error = new Error(
      `eBay getItems batch exceeds the safe ${containsVariation ? "variation/mixed" : "single-item"} limit ` +
      `(${uniqueIds.length} supplied; maximum ${requestMax}).`
    );
    error.code = "EBAY_GETITEMS_BATCH_TOO_LARGE";
    error.status = 400;
    throw error;
  }
  const ids = uniqueIds;

  if (!ids.length) {
    return {
      items: [],
      requestedIds: [],
      returnedIds: [],
      missingIds: [],
      deferredIds: [],
      failedIds: [],
      warnings: [],
      cacheHits: 0,
      networkIds: 0,
      transport: "none",
      bulkCapability: currentBulkGetItemsCapability(),
    };
  }

  const cached = new Map();
  if (!forceRefresh) {
    for (const id of ids) {
      const detail = cachedItemDetail(id, {
        requireProductIdentity: Boolean(includeProductIdentity),
      });
      if (detail) cached.set(id, detail);
    }
  }

  const networkIds = ids.filter(id => !cached.has(id));
  const endpoint = "browse.getItems";
  if (!networkIds.length) {
    noteEbayCacheHit(endpoint, "getItems");
    opLog("ebay-items", "exact details satisfied entirely from short-lived cache", {
      requested: ids.length,
      cacheHits: cached.size,
      priority,
    });
    return {
      items: ids.map(id => cached.get(id)).filter(Boolean),
      requestedIds: ids,
      returnedIds: ids.filter(id => cached.has(id)),
      missingIds: [],
      deferredIds: [],
      failedIds: [],
      warnings: [],
      cacheHits: cached.size,
      networkIds: 0,
      transport: "cache",
      bulkCapability: currentBulkGetItemsCapability(),
    };
  }

  if (cached.size) {
    noteEbayCacheHit(endpoint, "getItems", { avoided: false });
  }
  noteEbayCacheMiss(endpoint, "getItems");

  const sortedNetworkIds = [...networkIds].sort();
  let capability = currentBulkGetItemsCapability();

  // Only one distinct request may probe the restricted bulk entitlement. Other
  // callers wait for that authoritative result instead of racing another 403 or
  // spending fallback quota while the capability is still unknown.
  if (capability === "probing") {
    capability = await waitForBulkGetItemsCapabilityProbe();
  }

  if (capability === "denied") {
    const fallback = await getItemsViaIndividualFallback(sortedNetworkIds, {
      priority,
      forceRefresh,
      includeProductIdentity,
      reason: "bulk-getItems-access-denied",
    });
    return mergeBatchDetailResult(ids, cached, networkIds, fallback);
  }

  let isCapabilityProbe = false;
  if (capability === "unknown") {
    const claim = beginBulkGetItemsCapabilityProbe();
    isCapabilityProbe = Boolean(claim.owner);
    if (!isCapabilityProbe && claim.state === "probing") {
      capability = await waitForBulkGetItemsCapabilityProbe();
      if (capability === "denied") {
        const fallback = await getItemsViaIndividualFallback(sortedNetworkIds, {
          priority,
          forceRefresh,
          includeProductIdentity,
          reason: "bulk-getItems-access-denied-after-probe",
        });
        return mergeBatchDetailResult(ids, cached, networkIds, fallback);
      }
    }
  }

  const baseFlightKey = [
    "getItems",
    ebayEnvironment(),
    sortedNetworkIds.join(","),
  ].join("|");
  const flightKey = `${baseFlightKey}|${includeProductIdentity ? "product" : "market"}`;

  // Exact identity batches are supersets of market-only price batches. Share
  // an already-running PRODUCT batch with a simultaneous price verifier when
  // the exact same item IDs are requested.
  const richerInFlight = !includeProductIdentity
    ? reuseInFlight(`${baseFlightKey}|product`, endpoint, "getItems")
    : null;

  const networkResult = richerInFlight
    ? await richerInFlight
    : await singleFlight(
        flightKey,
        endpoint,
        "getItems",
        async () => {
          // Another concurrent batch may have discovered the permission block
          // while this request was waiting for its single-flight turn.
          if (currentBulkGetItemsCapability() === "denied") {
            return getItemsViaIndividualFallback(sortedNetworkIds, {
              priority,
              forceRefresh,
              includeProductIdentity,
              reason: "bulk-getItems-access-denied-concurrent",
            });
          }

          const headers = await requestHeaders();
          const url = new URL(`${ebayApiBase()}/buy/browse/v1/item`);
          url.searchParams.set("item_ids", sortedNetworkIds.join(","));
          if (includeProductIdentity) {
            url.searchParams.set("fieldgroups", "PRODUCT");
          }

          const finish = timedOp("ebay-items", "getItems batch", {
            requested: ids.length,
            cacheHits: cached.size,
            networkIds: sortedNetworkIds.length,
            includeProductIdentity: Boolean(includeProductIdentity),
          });

          let response;
          try {
            response = await fetchEbayWithRetry(url, {
              headers,
              bucket: "getItems",
              endpoint,
              priority,
              label: `getItems:${sortedNetworkIds.length}:${includeProductIdentity ? "product" : "market"}`,
              demandUnits: sortedNetworkIds.length,
              demandCapacity: sortedNetworkIds.every(isEbayVariationItemId)
                ? EBAY_GETITEMS_VARIATION_BATCH_MAX
                : EBAY_GETITEMS_SINGLE_BATCH_MAX,
              demandKey: ebayGetItemsDemandKey(sortedNetworkIds, { includeProductIdentity }),
            });
          } catch (error) {
            if (isCapabilityProbe && currentBulkGetItemsCapability() === "probing") {
              setBulkGetItemsCapability("unknown");
            }
            throw error;
          }

          if (!response.ok) {
            const error = await responseError(
              response,
              "getItems",
              `getItems batch (${sortedNetworkIds.length})`,
              `eBay ${ebayEnvironmentLabel()} getItems`,
              endpoint
            );

            if (bulkGetItemsAccessDenied(error)) {
              setBulkGetItemsCapability("denied");
              finish("access-denied-fallback", {
                status: Number(error.status || 403),
                ebayErrorId: Number(error.ebayErrorId || 1100),
                callsThisProcess: browseCallsThisProcess,
              });
              opWarn(
                "ebay-items",
                "bulk getItems access denied; switching to quota-aware Browse getItem fallback",
                {
                  status: Number(error.status || 403),
                  ebayErrorId: Number(error.ebayErrorId || 1100),
                  retryBulkAfter: new Date(Date.now() + bulkGetItemsRetryMs()).toISOString(),
                }
              );
              return getItemsViaIndividualFallback(sortedNetworkIds, {
                priority,
                forceRefresh,
                includeProductIdentity,
                reason: "bulk-getItems-403-1100",
              });
            }

            if (isCapabilityProbe && currentBulkGetItemsCapability() === "probing") {
              setBulkGetItemsCapability("unknown");
            }
            finish("failed", {
              status: Number(error.status || response.status || 0),
              callsThisProcess: browseCallsThisProcess,
            });
            throw error;
          }

          setBulkGetItemsCapability("allowed");
          const data = await response.json();
          const networkItems = (data.items || []).map(raw =>
            parseEbayItemDetail(raw, { externalId: raw?.itemId || "" })
          );
          for (const detail of networkItems) {
            storeItemDetail(detail, {
              hasProductIdentity: Boolean(includeProductIdentity),
            });
          }

          finish("complete", {
            requested: sortedNetworkIds.length,
            returned: networkItems.length,
            warnings: Array.isArray(data.warnings) ? data.warnings.length : 0,
            callsThisProcess: browseCallsThisProcess,
          });

          return {
            items: networkItems,
            warnings: Array.isArray(data.warnings) ? data.warnings : [],
            missingIds: sortedNetworkIds.filter(
              id => !networkItems.some(item => String(item.externalId) === String(id))
            ),
            deferredIds: [],
            attemptedIds: sortedNetworkIds,
            transport: "getItems",
          };
        }
      );

  return mergeBatchDetailResult(ids, cached, networkIds, networkResult);
}

export function getEbayProcessCallCount() {
  return browseCallsThisProcess;
}

export function setEbayGetItemFallbackIdentityBacklog(pending = 0) {
  getItemFallbackIdentityBacklog = Math.max(0, Math.floor(Number(pending) || 0));
  // Recompute/top-up immediately so a sanitizer pass does not have to wait for
  // the next 10-minute fallback window after discovering a large backlog.
  refreshGetItemFallbackWindow();
  return fallbackWindowSnapshot();
}

export function getEbayBulkGetItemsCapabilityStatus() {
  const state = currentBulkGetItemsCapability();
  const fallback = fallbackWindowSnapshot();
  return {
    state,
    checkedAt: bulkGetItemsCapabilityAt
      ? new Date(bulkGetItemsCapabilityAt).toISOString()
      : null,
    retryAt:
      state === "denied" && bulkGetItemsCapabilityAt
        ? new Date(bulkGetItemsCapabilityAt + bulkGetItemsRetryMs()).toISOString()
        : null,
    fallbackActive: state === "denied" || state === "probing",
    fallbackWindowMinutes: fallbackWindowMinutes(),
    fallbackBackgroundShare: fallbackBackgroundShare(),
    fallbackIdentityReserveShare: fallbackIdentityReserveShare(),
    fallbackWindowBudget: fallback.totalBudget,
    fallbackWindowUsed: fallback.used,
    fallbackWindowRemaining: fallback.remaining,
    fallbackIdentityReserve: fallback.identityReserve,
    fallbackIdentityWindowUsed: fallback.identityUsed,
    fallbackIdentityWindowRemaining: fallback.identityRemaining,
    fallbackPriceWindowBudget: fallback.priceBudget,
    fallbackPriceWindowUsed: fallback.priceUsed,
    fallbackPriceWindowRemaining: fallback.priceRemaining,
    fallbackIdentityBacklog: fallback.identityBacklog,
    fallbackAdaptiveMode: fallback.adaptiveMode,
    fallbackAdaptiveBrowseShare: fallback.adaptiveBrowseShare,
    fallbackAdaptiveMaxCallsPerWindow: fallback.adaptiveMaxCallsPerWindow,
    fallbackAdaptiveDiscoveryScale: fallback.adaptiveDiscoveryScale,
    fallbackSuspendBackgroundPriceRefresh: fallback.suspendBackgroundPriceRefresh,
  };
}

export async function getEbayItemIdentity(itemId, { priority = "background" } = {}) {
  const cachedIdentity = cachedItemIdentity(itemId);
  if (cachedIdentity) {
    noteEbayCacheHit("browse.getItem", "browse");
    return cachedIdentity;
  }

  const detail = await getEbayItemDetails(itemId, {
    compact: false,
    includeProductIdentity: true,
    priority,
  });
  if (detail.missing) throw new Error("eBay item is no longer available.");
  return {
    gtin: detail.gtin,
    mpn: detail.mpn,
    brand: detail.brand,
    epid: detail.epid,
    inferredEpid: detail.inferredEpid,
    title: detail.title,
    condition: detail.condition,
    conditionGroup: detail.conditionGroup,
  };
}

export function getEbayEnvironment() {
  return ebayEnvironment();
}

export function getEbayApiBase() {
  return ebayApiBase();
}
