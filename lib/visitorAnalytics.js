import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { publishLiveEvent } from "./liveEvents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const VISITOR_LEDGER_PATH = path.join(DATA_DIR, "unique_visitors.ndjson");
const VISITOR_ACTIVITY_PATH = path.join(DATA_DIR, "visitor_activity.ndjson");
const ACTIVE_TTL_MS = Math.max(
  5 * 60_000,
  Math.min(Number(process.env.VISITOR_ACTIVE_TTL_MS || 7 * 60_000), 30 * 60_000)
);
const RETURN_WINDOW_MS = 30 * 24 * 60 * 60_000;
const RETURN_VISIT_GAP_MS = Math.max(
  5 * 60_000,
  Math.min(Number(process.env.VISITOR_RETURN_GAP_MS || 30 * 60_000), 24 * 60 * 60_000)
);
const ACTIVITY_TOUCH_PERSIST_MS = Math.max(
  5 * 60_000,
  Math.min(Number(process.env.VISITOR_ACTIVITY_TOUCH_MS || 10 * 60_000), RETURN_VISIT_GAP_MS)
);
const GEOLOCATION_ENABLED =
  String(process.env.VISITOR_GEOLOCATION_ENABLED ?? "true").toLowerCase() !== "false";
const GEOLOCATION_RETENTION_DAYS = Math.max(
  1,
  Math.min(Number(process.env.VISITOR_GEOLOCATION_RETENTION_DAYS || 30), 90)
);
const GEOLOCATION_RETENTION_MS = GEOLOCATION_RETENTION_DAYS * 24 * 60 * 60_000;
const ACTIVITY_LEDGER_RETENTION_MS = Math.max(RETURN_WINDOW_MS, GEOLOCATION_RETENTION_MS);
const ACTIVITY_COMPACT_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_ACTIVITY_EVENTS = Math.max(
  10_000,
  Math.min(Number(process.env.VISITOR_ACTIVITY_EVENT_LIMIT || 200_000), 500_000)
);
const MAX_TOKEN_LENGTH = 160;

const historicalVisitors = new Set();
const visitorActivity = new Map();
const activeConnections = new Map();
const locationHistory = [];
let ledgerLoaded = false;
let appendChain = Promise.resolve();
let returnTrackingStartedAt = null;
let lastActivityCompactionAt = 0;

function safeToken(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "")
    .slice(0, MAX_TOKEN_LENGTH);
}

function digest(namespace, value) {
  return crypto
    .createHash("sha256")
    .update(`${namespace}:${value}`, "utf8")
    .digest("hex");
}

function validHash(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

function safeLocationText(value, max = 100) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[^\p{L}\p{N} .,'’()/-]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function roundedCoordinate(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return null;
  return Math.round(parsed * 100) / 100;
}

export function normalizeVisitorLocation(input = {}) {
  if (!GEOLOCATION_ENABLED) return null;
  const latitude = roundedCoordinate(input.latitude, -90, 90);
  const longitude = roundedCoordinate(input.longitude, -180, 180);
  if (latitude == null || longitude == null) return null;
  const country = safeLocationText(input.country, 2).toUpperCase();
  return {
    latitude,
    longitude,
    city: safeLocationText(input.city, 100),
    region: safeLocationText(input.region, 100),
    regionCode: safeLocationText(input.regionCode, 12).toUpperCase(),
    country: /^[A-Z]{2}$/.test(country) ? country : "",
  };
}

export function visitorLocationFromHeaders(headers = {}) {
  const read = name => {
    const value = typeof headers?.get === "function"
      ? headers.get(name)
      : headers?.[name] ?? headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  return normalizeVisitorLocation({
    latitude: read("cf-iplatitude"),
    longitude: read("cf-iplongitude"),
    city: read("cf-ipcity"),
    region: read("cf-region"),
    regionCode: read("cf-region-code"),
    country: read("cf-ipcountry"),
  });
}

function locationKey(location) {
  return location
    ? `${location.latitude.toFixed(2)}:${location.longitude.toFixed(2)}:${location.city}:${location.regionCode}:${location.country}`
    : "";
}

function locationLabel(location) {
  const region = location.regionCode || location.region;
  return [location.city, region, location.country].filter(Boolean).join(", ") || "Approximate location";
}

function applyLocationHistoryEvent(hash, at, location) {
  if (!location || at < Date.now() - GEOLOCATION_RETENTION_MS) return;
  locationHistory.push({ hash, at, location });
  if (locationHistory.length > MAX_ACTIVITY_EVENTS) {
    locationHistory.splice(0, locationHistory.length - MAX_ACTIVITY_EVENTS);
  }
}

function timestampMs(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function ensureActivityState(hash) {
  const normalized = String(hash || "").toLowerCase();
  let state = visitorActivity.get(normalized);
  if (!state) {
    state = {
      firstSeenAt: 0,
      lastSeenAt: 0,
      lastReturnAt: 0,
      lastPersistedSeenAt: 0,
    };
    visitorActivity.set(normalized, state);
  }
  return state;
}

function applyActivityEvent(event) {
  const hash = String(event?.hash || "").toLowerCase();
  const at = timestampMs(event?.at);
  const kind = String(event?.kind || "");
  if (!validHash(hash) || !at || !["first", "return", "seen"].includes(kind)) return false;

  const state = ensureActivityState(hash);
  if (kind === "first") {
    if (!state.firstSeenAt || at < state.firstSeenAt) state.firstSeenAt = at;
  }
  if (kind === "return") {
    state.lastReturnAt = Math.max(state.lastReturnAt || 0, at);
  }
  state.lastSeenAt = Math.max(state.lastSeenAt || 0, at);
  state.lastPersistedSeenAt = Math.max(state.lastPersistedSeenAt || 0, at);
  returnTrackingStartedAt = returnTrackingStartedAt == null
    ? at
    : Math.min(returnTrackingStartedAt, at);

  const location = normalizeVisitorLocation(event?.location);
  applyLocationHistoryEvent(hash, at, location);
  return true;
}

function compactActivityLedger(now = Date.now()) {
  if (!fs.existsSync(VISITOR_ACTIVITY_PATH)) return;
  const activityCutoff = now - ACTIVITY_LEDGER_RETENTION_MS;
  const locationCutoff = now - GEOLOCATION_RETENTION_MS;
  const retained = [];
  const raw = fs.readFileSync(VISITOR_ACTIVITY_PATH, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const at = timestampMs(event?.at);
      if (!at || at < activityCutoff || !validHash(event?.hash)) continue;
      if (at < locationCutoff) delete event.location;
      retained.push(JSON.stringify(event));
    } catch {}
  }
  const bounded = retained.slice(-MAX_ACTIVITY_EVENTS);
  const temporaryPath = `${VISITOR_ACTIVITY_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, bounded.length ? `${bounded.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, VISITOR_ACTIVITY_PATH);
}

function loadLedger() {
  if (ledgerLoaded) return;
  ledgerLoaded = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(VISITOR_LEDGER_PATH)) {
      const raw = fs.readFileSync(VISITOR_LEDGER_PATH, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const hash = String(line || "").trim();
        if (validHash(hash)) historicalVisitors.add(hash.toLowerCase());
      }
    }

    if (fs.existsSync(VISITOR_ACTIVITY_PATH)) {
      const raw = fs.readFileSync(VISITOR_ACTIVITY_PATH, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!String(line || "").trim()) continue;
        try {
          applyActivityEvent(JSON.parse(line));
        } catch {}
      }
    }
    lastActivityCompactionAt = Date.now();
  } catch (error) {
    console.warn(`[visitor-analytics] could not load visitor analytics ledgers: ${error?.message || error}`);
  }
}

function queueAppend(filePath, line, label) {
  appendChain = appendChain
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      await fs.promises.appendFile(filePath, `${line}\n`, "utf8");
    })
    .catch(error => {
      console.warn(`[visitor-analytics] could not persist ${label}: ${error?.message || error}`);
    });
}

function queueHistoricalAppend(hash) {
  queueAppend(VISITOR_LEDGER_PATH, hash, "unique visitor");
}

function queueActivityAppend(hash, kind, at, location = null) {
  const event = {
    v: 1,
    hash: String(hash || "").toLowerCase(),
    kind,
    at: new Date(at).toISOString(),
  };
  const normalizedLocation = normalizeVisitorLocation(location);
  if (normalizedLocation) event.location = normalizedLocation;
  applyLocationHistoryEvent(event.hash, at, normalizedLocation);
  queueAppend(VISITOR_ACTIVITY_PATH, JSON.stringify(event), "visitor activity");
  if (at - lastActivityCompactionAt >= ACTIVITY_COMPACT_INTERVAL_MS) {
    lastActivityCompactionAt = at;
    appendChain = appendChain
      .catch(() => {})
      .then(() => compactActivityLedger(at))
      .catch(error => console.warn(`[visitor-analytics] could not compact activity history: ${error?.message || error}`));
  }
}

function pruneActive(now = Date.now()) {
  for (const [connectionHash, state] of activeConnections) {
    if (!state?.lastSeen || now - Number(state.lastSeen) > ACTIVE_TTL_MS) {
      activeConnections.delete(connectionHash);
    }
  }
}

export function summarizeVisitorRetention(states, now = Date.now()) {
  const cutoff = Number(now) - RETURN_WINDOW_MS;
  let uniqueVisitors30d = 0;
  let firstTimeVisitors30d = 0;
  let returningVisitors30d = 0;

  for (const state of states || []) {
    if (Number(state?.lastSeenAt || 0) >= cutoff) uniqueVisitors30d += 1;
    if (Number(state?.firstSeenAt || 0) >= cutoff) firstTimeVisitors30d += 1;
    if (Number(state?.lastReturnAt || 0) >= cutoff) returningVisitors30d += 1;
  }

  return {
    uniqueVisitors30d,
    firstTimeVisitors30d,
    returningVisitors30d,
    returnRate30d: uniqueVisitors30d
      ? Math.round((returningVisitors30d / uniqueVisitors30d) * 1000) / 10
      : 0,
  };
}

export function recordVisitorPresence({ visitorId = "", connectionId = "", active = true, location = null } = {}) {
  loadLedger();
  const visitor = safeToken(visitorId);
  const connection = safeToken(connectionId);
  if (!visitor || !connection) {
    return { accepted: false, newVisitor: false, returningVisitor: false, ...getVisitorAnalytics() };
  }

  const visitorHash = digest("visitor", visitor);
  const connectionHash = digest("connection", `${visitor}:${connection}`);
  const now = Date.now();
  const normalizedLocation = normalizeVisitorLocation(location);
  pruneActive(now);
  const previousConnection = activeConnections.get(connectionHash);

  const wasHistorical = historicalVisitors.has(visitorHash);
  let newVisitor = false;
  if (!wasHistorical) {
    historicalVisitors.add(visitorHash);
    newVisitor = true;
    queueHistoricalAppend(visitorHash);
  }

  let returningVisitor = false;
  let activityKind = "";
  let state = visitorActivity.get(visitorHash);

  if (active) {
    if (!state) {
      state = ensureActivityState(visitorHash);
      state.lastSeenAt = now;
      state.lastPersistedSeenAt = now;

      // Legacy unique_visitors.ndjson contains hashes but no timestamps. The
      // first post-upgrade presence from one of those known hashes is therefore
      // the first moment we can safely prove that the browser has returned.
      if (wasHistorical && !newVisitor) {
        state.lastReturnAt = now;
        returningVisitor = true;
        activityKind = "return";
      } else {
        state.firstSeenAt = now;
        activityKind = "first";
      }
    } else {
      const previousSeenAt = Number(state.lastSeenAt || 0);
      if (previousSeenAt && now - previousSeenAt >= RETURN_VISIT_GAP_MS) {
        state.lastReturnAt = now;
        returningVisitor = true;
        activityKind = "return";
      } else if (!state.lastPersistedSeenAt || now - state.lastPersistedSeenAt >= ACTIVITY_TOUCH_PERSIST_MS) {
        activityKind = "seen";
      }
      state.lastSeenAt = now;
      if (activityKind) state.lastPersistedSeenAt = now;
    }

    activeConnections.set(connectionHash, {
      visitorHash,
      lastSeen: now,
      location: normalizedLocation || previousConnection?.location || null,
    });
  } else {
    activeConnections.delete(connectionHash);
    if (state) {
      state.lastSeenAt = Math.max(Number(state.lastSeenAt || 0), now);
      if (!state.lastPersistedSeenAt || now - state.lastPersistedSeenAt >= ACTIVITY_TOUCH_PERSIST_MS) {
        state.lastPersistedSeenAt = now;
        activityKind = "seen";
      }
    }
  }

  if (activityKind) {
    returnTrackingStartedAt = returnTrackingStartedAt == null
      ? now
      : Math.min(returnTrackingStartedAt, now);
    queueActivityAppend(visitorHash, activityKind, now, normalizedLocation);
  }

  const analytics = getVisitorAnalytics(now);
  const locationChanged = Boolean(
    active && normalizedLocation &&
    locationKey(previousConnection?.location) !== locationKey(normalizedLocation)
  );
  if (newVisitor || returningVisitor || locationChanged) {
    publishLiveEvent(
      "analytics",
      {
        reason: returningVisitor ? "returning-visitor" : locationChanged ? "visitor-location" : "new-unique-visitor",
        visitors: analytics,
      },
      { audience: "admin" }
    );
  }

  return { accepted: true, newVisitor, returningVisitor, ...analytics };
}

function summarizeActiveLocations() {
  const latestByVisitor = new Map();
  for (const state of activeConnections.values()) {
    if (!state?.visitorHash || !state?.location) continue;
    const existing = latestByVisitor.get(state.visitorHash);
    if (!existing || Number(state.lastSeen || 0) > Number(existing.lastSeen || 0)) {
      latestByVisitor.set(state.visitorHash, state);
    }
  }
  const groups = new Map();
  for (const state of latestByVisitor.values()) {
    const key = locationKey(state.location);
    const row = groups.get(key) || {
      key,
      label: locationLabel(state.location),
      ...state.location,
      activeUsers: 0,
      lastSeenAt: 0,
    };
    row.activeUsers += 1;
    row.lastSeenAt = Math.max(row.lastSeenAt, Number(state.lastSeen || 0));
    groups.set(key, row);
  }
  return [...groups.values()]
    .map(row => ({ ...row, lastSeenAt: new Date(row.lastSeenAt).toISOString() }))
    .sort((a, b) => b.activeUsers - a.activeUsers || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

function summarizeLocationHistory(now = Date.now()) {
  const cutoff30d = now - GEOLOCATION_RETENTION_MS;
  const cutoff7d = now - 7 * 24 * 60 * 60_000;
  const cutoff24h = now - 24 * 60 * 60_000;
  const groups = new Map();
  for (const event of locationHistory) {
    if (!event?.location || Number(event.at || 0) < cutoff30d) continue;
    const key = locationKey(event.location);
    const row = groups.get(key) || {
      key,
      label: locationLabel(event.location),
      ...event.location,
      observations24h: 0,
      observations7d: 0,
      observations30d: 0,
      visitors24h: new Set(),
      visitors7d: new Set(),
      visitors30d: new Set(),
      lastSeenAt: 0,
    };
    row.observations30d += 1;
    row.visitors30d.add(event.hash);
    if (event.at >= cutoff7d) {
      row.observations7d += 1;
      row.visitors7d.add(event.hash);
    }
    if (event.at >= cutoff24h) {
      row.observations24h += 1;
      row.visitors24h.add(event.hash);
    }
    row.lastSeenAt = Math.max(row.lastSeenAt, event.at);
    groups.set(key, row);
  }
  return [...groups.values()]
    .map(row => ({
      key: row.key,
      label: row.label,
      latitude: row.latitude,
      longitude: row.longitude,
      city: row.city,
      region: row.region,
      regionCode: row.regionCode,
      country: row.country,
      observations24h: row.observations24h,
      observations7d: row.observations7d,
      observations30d: row.observations30d,
      uniqueVisitors24h: row.visitors24h.size,
      uniqueVisitors7d: row.visitors7d.size,
      uniqueVisitors30d: row.visitors30d.size,
      lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    }))
    .sort((a, b) => b.uniqueVisitors30d - a.uniqueVisitors30d || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function getVisitorAnalytics(now = Date.now()) {
  loadLedger();
  pruneActive(now);
  const activeVisitorHashes = new Set(
    [...activeConnections.values()]
      .map(state => state?.visitorHash)
      .filter(Boolean)
  );
  const retention = summarizeVisitorRetention(visitorActivity.values(), now);
  const activeLocations = summarizeActiveLocations();
  const historyLocations = summarizeLocationHistory(now);
  const locatedActiveUsers = activeLocations.reduce((total, row) => total + Number(row.activeUsers || 0), 0);
  return {
    currentlyConnectedUsers: activeVisitorHashes.size,
    historicallyUniqueUsers: historicalVisitors.size,
    ...retention,
    returnWindowDays: 30,
    returnVisitGapMinutes: Math.round((RETURN_VISIT_GAP_MS / 60_000) * 10) / 10,
    returnTrackingStartedAt: returnTrackingStartedAt
      ? new Date(returnTrackingStartedAt).toISOString()
      : null,
    activeWindowMinutes: Math.round((ACTIVE_TTL_MS / 60_000) * 10) / 10,
    updatedAt: new Date(now).toISOString(),
    identityBasis: "anonymous-browser-id",
    geolocation: {
      enabled: GEOLOCATION_ENABLED,
      source: "cloudflare-visitor-location-headers",
      retentionDays: GEOLOCATION_RETENTION_DAYS,
      coordinatePrecisionDecimals: 2,
      activeLocatedUsers: locatedActiveUsers,
      activeUnlocatedUsers: Math.max(0, activeVisitorHashes.size - locatedActiveUsers),
      activeLocations,
      historyLocations,
      lastObservedAt: historyLocations[0]?.lastSeenAt || activeLocations[0]?.lastSeenAt || null,
    },
  };
}

// Startup-only disk read. Request-path updates stay in memory; meaningful
// visitor/session transitions append compact hash+timestamp events rather than
// rewriting the catalog or persisting raw browser identifiers.
loadLedger();
