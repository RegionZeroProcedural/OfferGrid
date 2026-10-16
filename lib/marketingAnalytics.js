import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const MARKETING_EVENTS_PATH = path.join(DATA_DIR, "marketing_events.ndjson");
const COMMISSION_EVENTS_PATH = path.join(DATA_DIR, "commission_events.ndjson");
const MAX_EVENTS = Math.max(10_000, Number(process.env.MARKETING_EVENT_LOG_LIMIT || 100_000));
const MAX_COMMISSIONS = Math.max(1_000, Number(process.env.COMMISSION_EVENT_LOG_LIMIT || 100_000));

const marketingEvents = [];
const visitSessions = new Set();
const commissionByKey = new Map();
let loaded = false;
let appendChain = Promise.resolve();

function text(value, max = 120) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function token(value, max = 100) {
  return text(value, max)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function money(value) {
  const normalized = String(value ?? "").replace(/[$,\s]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function timestamp(value, fallback = null) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function digest(namespace, value) {
  return crypto.createHash("sha256").update(`${namespace}:${String(value || "")}`, "utf8").digest("hex");
}

function referrerHost(value) {
  try { return new URL(String(value || "")).hostname.toLowerCase().slice(0, 200); }
  catch { return ""; }
}

function deviceClass(userAgent = "") {
  const value = String(userAgent).toLowerCase();
  if (/bot|crawler|spider|preview|slurp/.test(value)) return "bot";
  if (/ipad|tablet|kindle/.test(value)) return "tablet";
  if (/mobile|iphone|android/.test(value)) return "mobile";
  return "desktop";
}

function queueAppend(filePath, event, label) {
  appendChain = appendChain
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      await fs.promises.appendFile(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    })
    .catch(error => console.warn(`[marketing-analytics] could not persist ${label}: ${error?.message || error}`));
}

function applyMarketingEvent(event) {
  if (!event || !["visit", "outbound_click"].includes(event.type) || !timestamp(event.at)) return false;
  if (event.type === "visit" && event.sessionHash) {
    if (visitSessions.has(event.sessionHash)) return false;
    visitSessions.add(event.sessionHash);
  }
  marketingEvents.push(event);
  if (marketingEvents.length > MAX_EVENTS) marketingEvents.splice(0, marketingEvents.length - MAX_EVENTS);
  return true;
}

function commissionKey(event) {
  return `${token(event?.network, 60)}:${text(event?.transactionId, 180)}`;
}

function applyCommissionEvent(event) {
  if (!event?.transactionId || !event?.network) return false;
  commissionByKey.set(commissionKey(event), event);
  if (commissionByKey.size > MAX_COMMISSIONS) {
    const oldest = [...commissionByKey.entries()]
      .sort((a, b) => Date.parse(a[1]?.importedAt || a[1]?.occurredAt || 0) - Date.parse(b[1]?.importedAt || b[1]?.occurredAt || 0))
      .slice(0, commissionByKey.size - MAX_COMMISSIONS);
    for (const [key] of oldest) commissionByKey.delete(key);
  }
  return true;
}

function loadNdjson(filePath, apply) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { apply(JSON.parse(line)); } catch {}
  }
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    loadNdjson(MARKETING_EVENTS_PATH, applyMarketingEvent);
    loadNdjson(COMMISSION_EVENTS_PATH, applyCommissionEvent);
  } catch (error) {
    console.warn(`[marketing-analytics] could not load ledgers: ${error?.message || error}`);
  }
}

export function normalizeAttribution(input = {}) {
  return {
    source: token(input.source ?? input.utm_source, 80),
    medium: token(input.medium ?? input.utm_medium, 80),
    campaign: token(input.campaign ?? input.utm_campaign, 120),
    content: token(input.content ?? input.utm_content, 120),
    term: token(input.term ?? input.utm_term, 120),
    area: token(input.area ?? input.og_area, 120),
    partner: token(input.partner ?? input.og_partner, 120),
  };
}

export function attributionFromRequest(query = {}, referrer = "") {
  const attribution = normalizeAttribution(query);
  if (!attribution.source && referrerHost(referrer)) attribution.source = referrerHost(referrer);
  if (!attribution.medium && attribution.source) attribution.medium = referrer ? "referral" : "campaign";
  return attribution;
}

export function hasCampaignAttribution(attribution = {}) {
  return Boolean(attribution.source || attribution.medium || attribution.campaign || attribution.content || attribution.area || attribution.partner);
}

export function newTrackingToken(prefix = "og") {
  return `${token(prefix, 16) || "og"}_${Date.now().toString(36)}_${crypto.randomBytes(12).toString("base64url")}`;
}

export function newClickReference() {
  return newTrackingToken("ogc").slice(0, 64);
}

export function hashedTrackingIds(visitorId = "", sessionId = "") {
  return {
    visitorHash: visitorId ? digest("marketing-visitor", visitorId) : "",
    sessionHash: sessionId ? digest("marketing-session", sessionId) : "",
  };
}

export function recordMarketingVisit({ visitorId = "", sessionId = "", path: landingPath = "/", referrer = "", userAgent = "", attribution = {} } = {}) {
  ensureLoaded();
  const { visitorHash, sessionHash } = hashedTrackingIds(visitorId, sessionId);
  if (!visitorHash || !sessionHash || visitSessions.has(sessionHash)) return { accepted: false, duplicate: true };
  const event = {
    v: 1,
    type: "visit",
    at: new Date().toISOString(),
    visitorHash,
    sessionHash,
    landingPath: text(landingPath, 500) || "/",
    referrerHost: referrerHost(referrer),
    device: deviceClass(userAgent),
    ...normalizeAttribution(attribution),
  };
  applyMarketingEvent(event);
  queueAppend(MARKETING_EVENTS_PATH, event, "campaign visit");
  return { accepted: true, duplicate: false };
}

export function recordMarketingClick({ clickReference = "", offerId = 0, productId = 0, provider = "", visitorId = "", sessionId = "", path: landingPath = "", referrer = "", userAgent = "", attribution = {} } = {}) {
  ensureLoaded();
  const { visitorHash, sessionHash } = hashedTrackingIds(visitorId, sessionId);
  const event = {
    v: 1,
    type: "outbound_click",
    at: new Date().toISOString(),
    clickReference: text(clickReference, 100),
    offerId: Number(offerId) || 0,
    productId: Number(productId) || 0,
    provider: token(provider, 80),
    visitorHash,
    sessionHash,
    landingPath: text(landingPath, 500),
    referrerHost: referrerHost(referrer),
    device: deviceClass(userAgent),
    ...normalizeAttribution(attribution),
  };
  applyMarketingEvent(event);
  queueAppend(MARKETING_EVENTS_PATH, event, "outbound click");
  return event;
}

function groupEvents(events, keyName) {
  const grouped = new Map();
  for (const event of events) {
    const key = text(event?.[keyName], 120) || "(unattributed)";
    const row = grouped.get(key) || { key, visits: 0, uniqueVisitors: new Set(), outboundClicks: 0 };
    if (event.type === "visit") row.visits += 1;
    if (event.type === "outbound_click") row.outboundClicks += 1;
    if (event.visitorHash) row.uniqueVisitors.add(event.visitorHash);
    grouped.set(key, row);
  }
  return [...grouped.values()]
    .map(row => ({ key: row.key, visits: row.visits, uniqueVisitors: row.uniqueVisitors.size, outboundClicks: row.outboundClicks, clickThroughRate: row.visits ? Math.round((row.outboundClicks / row.visits) * 1000) / 10 : 0 }))
    .sort((a, b) => b.visits - a.visits || b.outboundClicks - a.outboundClicks || a.key.localeCompare(b.key));
}

export function getMarketingAnalytics({ days = 30 } = {}) {
  ensureLoaded();
  const safeDays = Math.max(1, Math.min(Number(days) || 30, 3650));
  const cutoff = Date.now() - safeDays * 86_400_000;
  const events = marketingEvents.filter(event => Date.parse(event.at || "") >= cutoff && event.device !== "bot");
  const visits = events.filter(event => event.type === "visit");
  const clicks = events.filter(event => event.type === "outbound_click");
  const uniqueVisitors = new Set(events.map(event => event.visitorHash).filter(Boolean));
  const attributedVisits = visits.filter(event => hasCampaignAttribution(event));
  const areaTaggedVisits = visits.filter(event => Boolean(text(event.area, 120)));
  return {
    days: safeDays,
    visits: visits.length,
    uniqueVisitors: uniqueVisitors.size,
    outboundClicks: clicks.length,
    clickThroughRate: visits.length ? Math.round((clicks.length / visits.length) * 1000) / 10 : 0,
    attributedVisits: attributedVisits.length,
    unattributedVisits: visits.length - attributedVisits.length,
    areaTaggedVisits: areaTaggedVisits.length,
    bySource: groupEvents(events, "source"),
    // Campaign and placement tables should only contain tagged rows. Direct
    // traffic is summarized separately so it cannot masquerade as a failed
    // Dallas geolocation result in Admin.
    byCampaign: groupEvents(events.filter(event => Boolean(text(event.campaign, 120))), "campaign"),
    byArea: groupEvents(events.filter(event => Boolean(text(event.area, 120))), "area"),
    byProvider: groupEvents(clicks, "provider"),
  };
}

function parseCsvRows(input) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const value = String(input || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      if (char === '"' && value[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(candidate => candidate.some(cell => String(cell).trim()));
}

function headerKey(value) {
  return token(value, 100).replace(/[:.-]/g, "_");
}

function firstColumn(row, names = []) {
  for (const name of names) {
    const value = row[headerKey(name)];
    if (value != null && String(value).trim() !== "") return value;
  }
  return "";
}

export function importCommissionCsv(csvText, { defaultNetwork = "" } = {}) {
  ensureLoaded();
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) throw new Error("Commission CSV must include a header row and at least one transaction.");
  const headers = rows[0].map(headerKey);
  const result = { imported: 0, updated: 0, skipped: 0, matchedClicks: 0, errors: [] };

  for (let index = 1; index < rows.length; index++) {
    const raw = Object.fromEntries(headers.map((header, column) => [header, rows[index][column] ?? ""]));
    const network = token(firstColumn(raw, ["network", "provider", "affiliate_network"]) || defaultNetwork, 60);
    const transactionId = text(firstColumn(raw, ["transaction_id", "transactionid", "order_id", "order_reference", "sale_id"]), 180);
    const commissionAmount = money(firstColumn(raw, ["commission_amount", "commission", "publisher_commission", "earnings"]));
    if (!network || !transactionId || commissionAmount == null) {
      result.skipped++;
      if (result.errors.length < 20) result.errors.push(`Row ${index + 1}: network, transaction_id, and commission_amount are required.`);
      continue;
    }

    const statusValue = token(firstColumn(raw, ["status", "transaction_status"]), 30);
    const status = ["pending", "approved", "paid", "reversed", "declined"].includes(statusValue) ? statusValue : "pending";
    const clickReference = text(firstColumn(raw, ["click_reference", "clickref", "customid", "u1", "sub_id", "subid"]), 180);
    const matchedClick = clickReference
      ? marketingEvents.findLast(event => event.type === "outbound_click" && event.clickReference === clickReference)
      : null;
    if (matchedClick) result.matchedClicks++;
    const event = {
      v: 1,
      type: "commission",
      importedAt: new Date().toISOString(),
      occurredAt: timestamp(firstColumn(raw, ["occurred_at", "transaction_date", "date", "event_date"]), new Date().toISOString()),
      transactionId,
      network,
      merchant: text(firstColumn(raw, ["merchant", "advertiser", "brand"]), 160),
      status,
      orderAmount: money(firstColumn(raw, ["order_amount", "sale_amount", "revenue", "order_value"])),
      commissionAmount,
      currency: token(firstColumn(raw, ["currency", "currency_code"]) || "usd", 8).toUpperCase(),
      clickReference,
      source: token(firstColumn(raw, ["utm_source", "source"]) || matchedClick?.source, 80),
      medium: token(firstColumn(raw, ["utm_medium", "medium"]) || matchedClick?.medium, 80),
      campaign: token(firstColumn(raw, ["utm_campaign", "campaign"]) || matchedClick?.campaign, 120),
      content: token(firstColumn(raw, ["utm_content", "content"]) || matchedClick?.content, 120),
      area: token(firstColumn(raw, ["area", "og_area"]) || matchedClick?.area, 120),
    };
    const key = commissionKey(event);
    if (commissionByKey.has(key)) result.updated++;
    else result.imported++;
    applyCommissionEvent(event);
    queueAppend(COMMISSION_EVENTS_PATH, event, "commission transaction");
  }

  return { ...result, total: commissionByKey.size };
}

function groupCommissions(events, keyName) {
  const groups = new Map();
  for (const event of events) {
    const key = text(event?.[keyName], 120) || "(unattributed)";
    const row = groups.get(key) || { key, transactions: 0, approvedCommission: 0, pendingCommission: 0, reversedCommission: 0, orderAmount: 0 };
    row.transactions++;
    row.orderAmount += Number(event.orderAmount || 0);
    if (["approved", "paid"].includes(event.status)) row.approvedCommission += Number(event.commissionAmount || 0);
    else if (event.status === "reversed" || event.status === "declined") row.reversedCommission += Number(event.commissionAmount || 0);
    else row.pendingCommission += Number(event.commissionAmount || 0);
    groups.set(key, row);
  }
  return [...groups.values()].map(row => ({
    ...row,
    approvedCommission: Math.round(row.approvedCommission * 100) / 100,
    pendingCommission: Math.round(row.pendingCommission * 100) / 100,
    reversedCommission: Math.round(row.reversedCommission * 100) / 100,
    orderAmount: Math.round(row.orderAmount * 100) / 100,
  })).sort((a, b) => b.approvedCommission - a.approvedCommission || b.transactions - a.transactions);
}

export function getCommissionAnalytics({ days = 90 } = {}) {
  ensureLoaded();
  const safeDays = Math.max(1, Math.min(Number(days) || 90, 3650));
  const cutoff = Date.now() - safeDays * 86_400_000;
  const events = [...commissionByKey.values()].filter(event => Date.parse(event.occurredAt || "") >= cutoff);
  const approved = events.filter(event => ["approved", "paid"].includes(event.status));
  const pending = events.filter(event => event.status === "pending");
  const reversed = events.filter(event => ["reversed", "declined"].includes(event.status));
  const sum = list => Math.round(list.reduce((total, event) => total + Number(event.commissionAmount || 0), 0) * 100) / 100;
  return {
    days: safeDays,
    transactions: events.length,
    approvedCommission: sum(approved),
    pendingCommission: sum(pending),
    reversedCommission: sum(reversed),
    byNetwork: groupCommissions(events, "network"),
    byCampaign: groupCommissions(events, "campaign"),
    byArea: groupCommissions(events, "area"),
  };
}

export function attachAffiliateClickReference(rawUrl, provider, clickReference) {
  const reference = text(clickReference, 100);
  if (!reference) return String(rawUrl || "");
  try {
    const url = new URL(String(rawUrl || ""));
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const normalizedProvider = token(provider, 40);
    if (normalizedProvider === "ebay" || /(^|\.)ebay\./i.test(url.hostname)) {
      url.searchParams.set("customid", reference.slice(0, 100));
    } else if (normalizedProvider === "awin" || /(^|\.)awin1\.com$/i.test(url.hostname)) {
      url.searchParams.set("clickref", reference.slice(0, 100));
    } else if (
      normalizedProvider === "rakuten" &&
      String(process.env.RAKUTEN_SIGNATURE_TRACKING_ENABLED || "false").toLowerCase() === "true"
    ) {
      url.searchParams.set("u1", reference.slice(0, 100));
    }
    return url.toString();
  } catch {
    return "";
  }
}

export async function flushMarketingAnalytics() {
  await appendChain.catch(() => {});
}

export const __marketingAnalyticsTest = { parseCsvRows, token, deviceClass };
