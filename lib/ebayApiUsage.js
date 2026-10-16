import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const STATE_FILE = path.join(DATA_DIR, "ebay-api-metrics.json");
const TMP_FILE = path.join(DATA_DIR, "ebay-api-metrics.json.tmp");

const METRICS = [
  "calls",
  "cacheHits",
  "cacheMisses",
  "avoidedCalls",
  "failedCalls",
  "retries",
  "rateLimitResponses",
  "deduplicatedCalls",
  "deferredAttempts",
  "deferredUnits",
  "networkUnits",
  "batchCapacityUnits",
];

let state = null;
let persistTimer = null;

function intEnv(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function emptyCounters() {
  return Object.fromEntries(METRICS.map(key => [key, 0]));
}

function normalizeCounters(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    METRICS.map(key => [
      key,
      Math.max(0, Number.isFinite(Number(source[key])) ? Number(source[key]) : 0),
    ])
  );
}

function emptyPeriod() {
  return {
    counters: emptyCounters(),
    buckets: {},
    endpoints: {},
    deferredKeys: {},
    deferredSummary: {
      finalized: false,
      unfulfilledCalls: 0,
      unfulfilledUnits: 0,
      byBucket: {},
      finalizedAt: 0,
    },
  };
}

function normalizePeriod(value) {
  const source = value && typeof value === "object" ? value : {};
  const period = emptyPeriod();
  period.counters = normalizeCounters(source.counters);

  for (const [bucket, counters] of Object.entries(source.buckets || {})) {
    period.buckets[String(bucket)] = normalizeCounters(counters);
  }

  for (const [endpoint, item] of Object.entries(source.endpoints || {})) {
    period.endpoints[String(endpoint)] = {
      bucket: String(item?.bucket || ""),
      counters: normalizeCounters(item?.counters),
    };
  }

  const deferredSummary = source.deferredSummary && typeof source.deferredSummary === "object"
    ? source.deferredSummary
    : {};
  period.deferredSummary = {
    finalized: Boolean(deferredSummary.finalized),
    unfulfilledCalls: Math.max(0, Number(deferredSummary.unfulfilledCalls || 0)),
    unfulfilledUnits: Math.max(0, Number(deferredSummary.unfulfilledUnits || 0)),
    byBucket: Object.fromEntries(
      Object.entries(deferredSummary.byBucket || {}).map(([bucket, summary]) => [
        String(bucket),
        {
          calls: Math.max(0, Number(summary?.calls || 0)),
          units: Math.max(0, Number(summary?.units || 0)),
        },
      ])
    ),
    finalizedAt: Math.max(0, Number(deferredSummary.finalizedAt || 0)),
  };

  for (const [key, item] of Object.entries(source.deferredKeys || {})) {
    period.deferredKeys[String(key)] = {
      endpoint: String(item?.endpoint || "unknown"),
      bucket: String(item?.bucket || "unmetered"),
      units: Math.max(0, Number(item?.units || 0)),
      capacity: Math.max(0, Number(item?.capacity || 0)),
      attempts: Math.max(1, Number(item?.attempts || 1)),
      priority: String(item?.priority || "background"),
      reason: String(item?.reason || "quota-deferred").slice(0, 120),
      firstAt: Number(item?.firstAt || 0),
      lastAt: Number(item?.lastAt || 0),
      fulfilled: Boolean(item?.fulfilled),
      fulfilledAt: Number(item?.fulfilledAt || 0),
    };
  }

  return period;
}

function emptyState() {
  return {
    version: 1,
    days: {},
    hours: {},
    lifetime: emptyPeriod(),
    updatedAt: new Date().toISOString(),
  };
}

function loadState() {
  if (state) return state;

  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state = {
      version: 1,
      days: Object.fromEntries(
        Object.entries(parsed?.days || {}).map(([key, value]) => [key, normalizePeriod(value)])
      ),
      hours: Object.fromEntries(
        Object.entries(parsed?.hours || {}).map(([key, value]) => [key, normalizePeriod(value)])
      ),
      lifetime: normalizePeriod(parsed?.lifetime),
      updatedAt: String(parsed?.updatedAt || ""),
    };
  } catch {
    state = emptyState();
  }

  pruneState();
  return state;
}

function persistNow() {
  const data = loadState();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(TMP_FILE, JSON.stringify(data), "utf8");
  fs.renameSync(TMP_FILE, STATE_FILE);
}

function schedulePersist() {
  if (persistTimer) return;
  // Usage telemetry is intentionally write-behind. API bursts can otherwise
  // turn a tiny metrics file into a steady stream of SSD rewrites even though
  // none of this state is needed on the request hot path. beforeExit still
  // forces a final durable snapshot.
  const delay = intEnv("EBAY_USAGE_PERSIST_DEBOUNCE_MS", 5000, 250, 30000);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, delay);
  persistTimer.unref?.();
}

process.once("beforeExit", () => {
  if (state) persistNow();
});

function utcDayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function utcHourKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 13);
}

function pruneState(now = Date.now()) {
  if (!state) return false;
  let changed = false;
  const dayRetention = intEnv("EBAY_USAGE_DAY_RETENTION_DAYS", 45, 7, 365);
  const hourRetention = intEnv("EBAY_USAGE_HOUR_RETENTION_HOURS", 1080, 24, 24 * 90);
  const dayCutoff = utcDayKey(now - dayRetention * 86_400_000);
  const hourCutoff = utcHourKey(now - hourRetention * 3_600_000);

  const currentDay = utcDayKey(now);
  for (const key of Object.keys(state.days || {})) {
    if (key < dayCutoff) {
      delete state.days[key];
      changed = true;
      continue;
    }
    // Deferred request keys are only needed while a day is live. Before they
    // are discarded, freeze the unresolved UNIQUE demand into a compact daily
    // summary. This keeps multi-day quota evidence accurate without retaining
    // tens of thousands of request hashes for every historical day.
    if (key !== currentDay && state.days[key]?.deferredKeys) {
      const period = state.days[key];
      if (!period.deferredSummary?.finalized) {
        changed = true;
        const pending = Object.values(period.deferredKeys || {}).filter(item => !item?.fulfilled);
        const byBucket = {};
        for (const item of pending) {
          const bucket = String(item?.bucket || "unmetered");
          byBucket[bucket] ||= { calls: 0, units: 0 };
          byBucket[bucket].calls += 1;
          byBucket[bucket].units += Number(item?.units || 0);
        }
        period.deferredSummary = {
          finalized: true,
          unfulfilledCalls: pending.length,
          unfulfilledUnits: pending.reduce((sum, item) => sum + Number(item?.units || 0), 0),
          byBucket,
          finalizedAt: now,
        };
      }
      if (Object.keys(period.deferredKeys || {}).length || !period.deferredSummary?.finalized) {
        changed = true;
      }
      period.deferredKeys = {};
    }
  }

  for (const key of Object.keys(state.hours || {})) {
    if (key < hourCutoff) {
      delete state.hours[key];
      changed = true;
    }
  }
  return changed;
}

function ensurePeriod(map, key) {
  map[key] ||= emptyPeriod();
  return map[key];
}

function incrementCounters(target, metric, count) {
  if (!METRICS.includes(metric)) return;
  target[metric] = Math.max(0, Number(target[metric] || 0) + count);
}

function incrementPeriod(period, endpoint, bucket, metric, count) {
  incrementCounters(period.counters, metric, count);

  const bucketKey = String(bucket || "unmetered");
  period.buckets[bucketKey] ||= emptyCounters();
  incrementCounters(period.buckets[bucketKey], metric, count);

  const endpointKey = String(endpoint || "unknown");
  period.endpoints[endpointKey] ||= {
    bucket: bucketKey,
    counters: emptyCounters(),
  };
  if (!period.endpoints[endpointKey].bucket && bucketKey) {
    period.endpoints[endpointKey].bucket = bucketKey;
  }
  incrementCounters(period.endpoints[endpointKey].counters, metric, count);
}

export function recordEbayApiMetric(
  endpoint,
  metric,
  {
    count = 1,
    bucket = "unmetered",
  } = {}
) {
  if (!METRICS.includes(metric)) return;
  const amount = Number(count);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const data = loadState();
  const now = Date.now();
  pruneState(now);
  const day = ensurePeriod(data.days, utcDayKey(now));
  const hour = ensurePeriod(data.hours, utcHourKey(now));

  incrementPeriod(day, endpoint, bucket, metric, amount);
  incrementPeriod(hour, endpoint, bucket, metric, amount);
  incrementPeriod(data.lifetime, endpoint, bucket, metric, amount);
  schedulePersist();
}

function demandHash(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function mutateCurrentPeriods(mutator) {
  const data = loadState();
  const now = Date.now();
  pruneState(now);
  const day = ensurePeriod(data.days, utcDayKey(now));
  const hour = ensurePeriod(data.hours, utcHourKey(now));
  mutator({ data, day, hour, now });
  schedulePersist();
}

export function noteEbayNetworkCall(
  endpoint,
  bucket,
  { units = 0, capacity = 0, demandKey = "" } = {}
) {
  const networkUnits = Math.max(0, Number(units || 0));
  const batchCapacity = Math.max(0, Number(capacity || 0));
  const key = demandHash(demandKey);

  mutateCurrentPeriods(({ data, day, hour, now }) => {
    for (const period of [day, hour, data.lifetime]) {
      incrementPeriod(period, endpoint, bucket, "calls", 1);
      if (networkUnits > 0) incrementPeriod(period, endpoint, bucket, "networkUnits", networkUnits);
      if (batchCapacity > 0) incrementPeriod(period, endpoint, bucket, "batchCapacityUnits", batchCapacity);
    }

    if (key && day.deferredKeys?.[key]) {
      day.deferredKeys[key].fulfilled = true;
      day.deferredKeys[key].fulfilledAt = now;
    }
  });
}

export function noteEbayDeferredDemand(
  endpoint,
  bucket,
  {
    units = 0,
    capacity = 0,
    demandKey = "",
    priority = "background",
    reason = "quota-deferred",
  } = {}
) {
  const deferredUnits = Math.max(0, Number(units || 0));
  const batchCapacity = Math.max(0, Number(capacity || 0));
  const key = demandHash(demandKey || `${endpoint}|${bucket}|${Date.now()}|${Math.random()}`);

  mutateCurrentPeriods(({ data, day, hour, now }) => {
    for (const period of [day, hour, data.lifetime]) {
      incrementPeriod(period, endpoint, bucket, "deferredAttempts", 1);
      if (deferredUnits > 0) incrementPeriod(period, endpoint, bucket, "deferredUnits", deferredUnits);
    }

    const existing = day.deferredKeys[key];
    if (existing) {
      existing.attempts = Number(existing.attempts || 0) + 1;
      existing.lastAt = now;
      existing.units = Math.max(Number(existing.units || 0), deferredUnits);
      existing.capacity = Math.max(Number(existing.capacity || 0), batchCapacity);
      existing.reason = String(reason || existing.reason || "quota-deferred").slice(0, 120);
      existing.priority = String(priority || existing.priority || "background");
      existing.fulfilled = false;
      existing.fulfilledAt = 0;
    } else {
      day.deferredKeys[key] = {
        endpoint: String(endpoint || "unknown"),
        bucket: String(bucket || "unmetered"),
        units: deferredUnits,
        capacity: batchCapacity,
        attempts: 1,
        priority: String(priority || "background"),
        reason: String(reason || "quota-deferred").slice(0, 120),
        firstAt: now,
        lastAt: now,
        fulfilled: false,
        fulfilledAt: 0,
      };
    }

    const keyCap = intEnv("EBAY_USAGE_DEFERRED_KEY_CAP", 25_000, 1_000, 100_000);
    const entries = Object.entries(day.deferredKeys || {});
    if (entries.length > keyCap) {
      const removable = entries
        .sort((a, b) => {
          const aFulfilled = a[1]?.fulfilled ? 0 : 1;
          const bFulfilled = b[1]?.fulfilled ? 0 : 1;
          return aFulfilled - bFulfilled || Number(a[1]?.lastAt || 0) - Number(b[1]?.lastAt || 0);
        })
        .slice(0, entries.length - keyCap);
      for (const [oldKey] of removable) delete day.deferredKeys[oldKey];
    }
  });
}

export function noteEbayCacheHit(endpoint, bucket, { avoided = true } = {}) {
  recordEbayApiMetric(endpoint, "cacheHits", { bucket });
  if (avoided) recordEbayApiMetric(endpoint, "avoidedCalls", { bucket });
}

export function noteEbayCacheMiss(endpoint, bucket) {
  recordEbayApiMetric(endpoint, "cacheMisses", { bucket });
}

export function noteEbayDeduplicatedCall(endpoint, bucket) {
  recordEbayApiMetric(endpoint, "deduplicatedCalls", { bucket });
  recordEbayApiMetric(endpoint, "avoidedCalls", { bucket });
}

export function noteEbayFailedCall(endpoint, bucket) {
  recordEbayApiMetric(endpoint, "failedCalls", { bucket });
}

export function noteEbayRetry(endpoint, bucket) {
  recordEbayApiMetric(endpoint, "retries", { bucket });
}

export function noteEbayRateLimitResponse(endpoint, bucket) {
  recordEbayApiMetric(endpoint, "rateLimitResponses", { bucket });
}

function configuredAllowance(bucket) {
  if (bucket === "browse") {
    return intEnv("EBAY_BROWSE_DAILY_LIMIT", 5000, 1, 10_000_000);
  }
  if (bucket === "getItems") {
    return intEnv("EBAY_GETITEMS_DAILY_LIMIT", 5000, 1, 10_000_000);
  }
  return null;
}

function endpointPeak(endpoint, periods) {
  let peak = 0;
  for (const period of Object.values(periods || {})) {
    peak = Math.max(
      peak,
      Number(period?.endpoints?.[endpoint]?.counters?.calls || 0)
    );
  }
  return peak;
}

function sumRecentHours(data, hours = 6, now = Date.now()) {
  const count = Math.min(Math.max(Number(hours) || 6, 1), 24);
  let total = 0;

  // Use the actual most-recent clock hours, including zero-call hours. Taking
  // the last N stored keys can accidentally include old busy hours after an
  // idle period and overstate current traffic.
  const currentHourStart = Math.floor(now / 3_600_000) * 3_600_000;
  for (let offset = 0; offset < count; offset++) {
    const key = utcHourKey(currentHourStart - offset * 3_600_000);
    total += Number(data.hours?.[key]?.counters?.calls || 0);
  }

  return total;
}

function sumRecentHoursForBucket(data, bucket, hours = 6, now = Date.now()) {
  const count = Math.min(Math.max(Number(hours) || 6, 1), 24);
  let total = 0;
  const currentHourStart = Math.floor(now / 3_600_000) * 3_600_000;
  for (let offset = 0; offset < count; offset++) {
    const key = utcHourKey(currentHourStart - offset * 3_600_000);
    total += Number(data.hours?.[key]?.buckets?.[bucket]?.calls || 0);
  }
  return total;
}

function projectedDailyCalls(callsToday, recentCalls, elapsedHours, recentHours = 6) {
  const todayPace = Number(callsToday || 0) * (24 / Math.max(1, elapsedHours));
  const recentPace = Number(recentCalls || 0) * (24 / Math.max(1, recentHours));
  return Math.max(Number(callsToday || 0), Math.round((todayPace + recentPace) / 2));
}

function quotaHeadroomMultiplier() {
  const value = Number(process.env.EBAY_QUOTA_REQUEST_HEADROOM_MULTIPLIER || 1.5);
  return Math.min(Math.max(Number.isFinite(value) ? value : 1.5, 1), 3);
}

function recommendedQuota(value, configured = 0) {
  const roundTo = intEnv("EBAY_QUOTA_REQUEST_ROUND_TO", 500, 100, 10_000);
  const raw = Math.ceil(Math.max(0, Number(value || 0)) * quotaHeadroomMultiplier());
  if (!raw) return Math.max(0, Number(configured || 0));
  return Math.max(Number(configured || 0), Math.ceil(raw / roundTo) * roundTo);
}

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

export function getEbayApiUsageStatus() {
  const data = loadState();
  const now = Date.now();
  const pruned = pruneState(now);
  if (pruned) schedulePersist();

  const todayKey = utcDayKey(now);
  const hourKey = utcHourKey(now);
  const today = data.days[todayKey] || emptyPeriod();
  const currentHour = data.hours[hourKey] || emptyPeriod();

  const browseAllowance = configuredAllowance("browse");
  const getItemsAllowance = configuredAllowance("getItems");
  const configuredDailyAllowance = browseAllowance + getItemsAllowance;

  const browseCallsToday = Number(today.buckets?.browse?.calls || 0);
  const getItemsCallsToday = Number(today.buckets?.getItems?.calls || 0);
  const meteredCallsToday = browseCallsToday + getItemsCallsToday;
  const remaining = Math.max(0, configuredDailyAllowance - meteredCallsToday);
  const percentageRemaining = configuredDailyAllowance > 0
    ? round1((remaining / configuredDailyAllowance) * 100)
    : 0;

  const totalCacheLookups =
    Number(today.counters.cacheHits || 0) + Number(today.counters.cacheMisses || 0);
  const cacheHitRate = totalCacheLookups > 0
    ? round1((Number(today.counters.cacheHits || 0) / totalCacheLookups) * 100)
    : 0;

  const midnight = Date.parse(`${todayKey}T00:00:00.000Z`);
  const elapsedHours = Math.max(1, (now - midnight) / 3_600_000);
  const recentHours = 6;
  const recentCalls = sumRecentHours(data, recentHours, now);
  const estimatedCallsPerDay = projectedDailyCalls(
    meteredCallsToday,
    recentCalls,
    elapsedHours,
    recentHours
  );

  const pendingDeferred = Object.values(today.deferredKeys || {})
    .filter(item => !item?.fulfilled);
  const pendingDeferredCalls = pendingDeferred.length;
  const pendingDeferredUnits = pendingDeferred.reduce(
    (sum, item) => sum + Number(item?.units || 0),
    0
  );
  const estimatedUnconstrainedCallsPerDay = Math.max(
    estimatedCallsPerDay,
    meteredCallsToday + pendingDeferredCalls
  );

  const endpointNames = new Set([
    ...Object.keys(today.endpoints || {}),
    ...Object.keys(data.lifetime?.endpoints || {}),
  ]);

  const endpoints = [...endpointNames]
    .map(endpoint => {
      const todayItem = today.endpoints?.[endpoint] || { bucket: "", counters: emptyCounters() };
      const hourItem = currentHour.endpoints?.[endpoint] || { counters: emptyCounters() };
      const lifetimeItem = data.lifetime?.endpoints?.[endpoint] || { counters: emptyCounters() };
      const bucket = String(todayItem.bucket || data.lifetime?.endpoints?.[endpoint]?.bucket || "unmetered");
      const lookups = Number(todayItem.counters.cacheHits || 0) + Number(todayItem.counters.cacheMisses || 0);
      return {
        endpoint,
        bucket,
        configuredDailyAllowance: configuredAllowance(bucket),
        callsToday: Number(todayItem.counters.calls || 0),
        callsThisHour: Number(hourItem.counters.calls || 0),
        peakHourlyCalls: endpointPeak(endpoint, data.hours),
        peakDailyCalls: endpointPeak(endpoint, data.days),
        cacheHitsToday: Number(todayItem.counters.cacheHits || 0),
        cacheMissesToday: Number(todayItem.counters.cacheMisses || 0),
        cacheHitRate: lookups > 0
          ? round1((Number(todayItem.counters.cacheHits || 0) / lookups) * 100)
          : 0,
        avoidedCallsToday: Number(todayItem.counters.avoidedCalls || 0),
        failedCallsToday: Number(todayItem.counters.failedCalls || 0),
        retriesToday: Number(todayItem.counters.retries || 0),
        rateLimitResponsesToday: Number(todayItem.counters.rateLimitResponses || 0),
        deduplicatedCallsToday: Number(todayItem.counters.deduplicatedCalls || 0),
        deferredAttemptsToday: Number(todayItem.counters.deferredAttempts || 0),
        deferredUnitsToday: Number(todayItem.counters.deferredUnits || 0),
        networkUnitsToday: Number(todayItem.counters.networkUnits || 0),
        batchCapacityUnitsToday: Number(todayItem.counters.batchCapacityUnits || 0),
        batchFillPct: Number(todayItem.counters.batchCapacityUnits || 0) > 0
          ? round1((Number(todayItem.counters.networkUnits || 0) / Number(todayItem.counters.batchCapacityUnits || 0)) * 100)
          : 0,
        pendingDeferredCalls: pendingDeferred.filter(item => item.endpoint === endpoint).length,
        pendingDeferredUnits: pendingDeferred
          .filter(item => item.endpoint === endpoint)
          .reduce((sum, item) => sum + Number(item.units || 0), 0),
        lifetimeCalls: Number(lifetimeItem.counters.calls || 0),
      };
    })
    .sort((a, b) => b.callsToday - a.callsToday || a.endpoint.localeCompare(b.endpoint));

  const bucketDemand = bucket => {
    const callsToday = Number(today.buckets?.[bucket]?.calls || 0);
    const recentBucketCalls = sumRecentHoursForBucket(data, bucket, recentHours, now);
    const actualPace = projectedDailyCalls(callsToday, recentBucketCalls, elapsedHours, recentHours);
    const pending = pendingDeferred.filter(item => item.bucket === bucket);
    const pendingCalls = pending.length;
    const pendingUnits = pending.reduce((sum, item) => sum + Number(item.units || 0), 0);
    const unconstrained = Math.max(actualPace, callsToday + pendingCalls);
    const allowance = configuredAllowance(bucket) || 0;
    const counters = today.buckets?.[bucket] || emptyCounters();
    const capacity = Number(counters.batchCapacityUnits || 0);
    const units = Number(counters.networkUnits || 0);
    const averageUnitsPerCall = callsToday > 0 ? round1(units / callsToday) : 0;
    const bulkCallsSavedVsOneItem = bucket === "getItems"
      ? Math.max(0, Math.round(units - callsToday))
      : 0;
    return {
      callsToday,
      configuredDailyAllowance: allowance,
      percentageRemaining: allowance > 0
        ? round1((Math.max(0, allowance - callsToday) / allowance) * 100)
        : 0,
      deferredAttemptsToday: Number(counters.deferredAttempts || 0),
      pendingDeferredCalls: pendingCalls,
      pendingDeferredUnits: pendingUnits,
      estimatedActualCallsPerDay: actualPace,
      estimatedUnconstrainedCallsPerDay: unconstrained,
      recommendedRequestedDailyLimit: recommendedQuota(unconstrained, allowance),
      networkUnitsToday: units,
      batchCapacityUnitsToday: capacity,
      batchFillPct: capacity > 0 ? round1((units / capacity) * 100) : 0,
      averageUnitsPerCall,
      bulkCallsSavedVsOneItem,
    };
  };

  const browseDemand = bucketDemand("browse");
  const getItemsDemand = bucketDemand("getItems");

  const demandHistory = Object.keys(data.days || {})
    .sort()
    .slice(-7)
    .map(dayKey => {
      const period = data.days[dayKey] || emptyPeriod();
      const isToday = dayKey === todayKey;
      const pending = isToday
        ? Object.values(period.deferredKeys || {}).filter(item => !item?.fulfilled)
        : [];
      const finalized = period.deferredSummary || {};
      const shadowCalls = isToday
        ? pending.length
        : Number(finalized.unfulfilledCalls || 0);
      const shadowUnits = isToday
        ? pending.reduce((sum, item) => sum + Number(item?.units || 0), 0)
        : Number(finalized.unfulfilledUnits || 0);
      const calls = Number(period.buckets?.browse?.calls || 0) + Number(period.buckets?.getItems?.calls || 0);
      const buckets = {};
      for (const bucket of ["browse", "getItems"]) {
        const actualCalls = Number(period.buckets?.[bucket]?.calls || 0);
        const bucketPending = isToday
          ? pending.filter(item => item?.bucket === bucket)
          : [];
        const unresolvedShadowCalls = isToday
          ? bucketPending.length
          : Number(finalized.byBucket?.[bucket]?.calls || 0);
        const unresolvedShadowUnits = isToday
          ? bucketPending.reduce((sum, item) => sum + Number(item?.units || 0), 0)
          : Number(finalized.byBucket?.[bucket]?.units || 0);
        buckets[bucket] = {
          actualCalls,
          unresolvedShadowCalls,
          unresolvedShadowUnits,
          measuredUncappedCalls: actualCalls + unresolvedShadowCalls,
        };
      }
      return {
        dayUtc: dayKey,
        actualCalls: calls,
        unresolvedShadowCalls: shadowCalls,
        unresolvedShadowUnits: shadowUnits,
        measuredUncappedCalls: calls + shadowCalls,
        buckets,
      };
    });

  const completedDemandDays = demandHistory.filter(day => day.dayUtc !== todayKey);
  const averageMeasuredUncappedCalls = completedDemandDays.length
    ? Math.round(completedDemandDays.reduce((sum, day) => sum + Number(day.measuredUncappedCalls || 0), 0) / completedDemandDays.length)
    : estimatedUnconstrainedCallsPerDay;
  const peakMeasuredUncappedCalls = demandHistory.length
    ? Math.max(...demandHistory.map(day => Number(day.measuredUncappedCalls || 0)))
    : estimatedUnconstrainedCallsPerDay;

  for (const [bucket, bucketStatus] of [["browse", browseDemand], ["getItems", getItemsDemand]]) {
    const completed = completedDemandDays.map(day => Number(day.buckets?.[bucket]?.measuredUncappedCalls || 0));
    const all = demandHistory.map(day => Number(day.buckets?.[bucket]?.measuredUncappedCalls || 0));
    bucketStatus.averageMeasuredUncappedCalls = completed.length
      ? Math.round(completed.reduce((sum, value) => sum + value, 0) / completed.length)
      : Number(bucketStatus.estimatedUnconstrainedCallsPerDay || 0);
    bucketStatus.peakMeasuredUncappedCalls = all.length
      ? Math.max(...all, Number(bucketStatus.estimatedUnconstrainedCallsPerDay || 0))
      : Number(bucketStatus.estimatedUnconstrainedCallsPerDay || 0);
    bucketStatus.recommendedRequestedDailyLimit = recommendedQuota(
      Math.max(
        Number(bucketStatus.estimatedUnconstrainedCallsPerDay || 0),
        Number(bucketStatus.peakMeasuredUncappedCalls || 0)
      ),
      Number(bucketStatus.configuredDailyAllowance || 0)
    );
  }

  return {
    persistent: true,
    period: {
      dayUtc: todayKey,
      hourUtc: hourKey,
    },
    callsUsedToday: meteredCallsToday,
    configuredDailyAllowance,
    percentageRemaining,
    callsThisHour:
      Number(currentHour.buckets?.browse?.calls || 0) +
      Number(currentHour.buckets?.getItems?.calls || 0),
    cacheHitsToday: Number(today.counters.cacheHits || 0),
    cacheMissesToday: Number(today.counters.cacheMisses || 0),
    cacheHitRate,
    avoidedCallsToday: Number(today.counters.avoidedCalls || 0),
    failedCallsToday: Number(today.counters.failedCalls || 0),
    retriesToday: Number(today.counters.retries || 0),
    rateLimitEventsToday: Number(today.counters.rateLimitResponses || 0),
    deferredAttemptsToday: Number(today.counters.deferredAttempts || 0),
    pendingDeferredCalls,
    pendingDeferredUnits,
    estimatedCallsPerDay,
    estimatedUnconstrainedCallsPerDay,
    recommendedRequestedDailyLimit: recommendedQuota(
      Math.max(estimatedUnconstrainedCallsPerDay, peakMeasuredUncappedCalls),
      configuredDailyAllowance
    ),
    quotaRequestHeadroomMultiplier: quotaHeadroomMultiplier(),
    demandHistory,
    averageMeasuredUncappedCalls,
    peakMeasuredUncappedCalls,
    growthCheckSuggested:
      configuredDailyAllowance > 0 &&
      estimatedUnconstrainedCallsPerDay >= configuredDailyAllowance * 0.8,
    buckets: {
      browse: browseDemand,
      getItems: getItemsDemand,
    },
    endpoints,
    updatedAt: data.updatedAt || "",
  };
}
