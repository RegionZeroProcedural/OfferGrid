import "dotenv/config";
import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

import {
  initDb,
  listPublicProducts,
  listPublicProductsPage,
  listAllProducts,
  getProduct,
  getCategories,
  getTrendingDeals,
  getStats,
  ingestCandidates,
  setApproved,
  updateProduct,
  deleteProduct,
  markMissingOffers,
  recordOutboundClick,
  getOutboundClickTarget,
  getAnalytics,
  resetClickAnalytics,
  getDiscoveryRules,
  createDiscoveryRule,
  updateDiscoveryRule,
  deleteDiscoveryRule,
  markRuleRun,
  autoApproveFromRule,
  countCatalogProducts,
  countPublicProducts,
  getDiscoveryRulesForCycle,
  getDiscoveryGrowthStatus,
  markRuleExpanded,
  approveProductIds,
  installDiscoverySearchPack,
  cleanupEbayCompetitorOffers,
  getEbayCompetitorCleanupStatus,
  getEbayCompetitorSanitizerStatus,
  getAdminEbayCompetitorCoverageStatus,
  getOffer,
  getDataIntegrityStats,
  getAdminIntegritySummary,
  getCatalogIntegrityVersionStatus,
  getEbayVerificationBacklogStatus,
  runCatalogIntegrityRepair,
  runProductLifecycleCycle,
  getProductLifecycleStatus,
  setProductLifecyclePinned,
  compressPriceHistory,
  queueStaleIntelligenceSnapshots,
  getIntelligencePipelineStatus,
  flushOfferGridMutationPipelines,
  autoApproveConfidentDrafts,
  getDraftAutoReviewStatus,
  getPendingVerificationSearchProducts,
  getShopperProduct,
  getEbayVerificationDemandSnapshot,
  runLocalDatabaseCleanup,
  getLocalDatabaseCleanupStatus,
} from "./lib/db.js";
import {
  getEbayBulkGetItemsCapabilityStatus,
  setEbayGetItemFallbackIdentityBacklog,
  syncEbayApplicationRateLimits,
} from "./providers/ebay.js";
import { searchEbayAndRakuten } from "./services/marketplaceSearch.js";
import {
  getRakutenCatalogStatus,
  startRakutenCatalogSync,
} from "./providers/rakutenCatalog.js";
import {
  runEbayPriceVerification,
  verifyEbayOfferIfStale,
} from "./services/ebayPriceVerifier.js";
import { runEbayCompetitorScan } from "./services/ebayCompetitorScanner.js";
import { runEbayCompetitorSanitizer } from "./services/ebayCompetitorSanitizer.js";
import {
  searchCatalogPage,
  catalogSearchThreadCount,
  scheduleCatalogSearchWarmup,
} from "./services/catalogSearchPool.js";
import { CATALOG_SHOPPER_PAGE_SIZE } from "./services/catalogSearchCore.js";
import { discoverForUserSearch, getUserSearchDiscoveryState } from "./services/liveSearch.js";
import { opLog, opWarn } from "./lib/opsLog.js";
import {
  subscribeLiveEvents,
  getLiveEventRevision,
  publishLiveEvent,
} from "./lib/liveEvents.js";
import {
  recordVisitorPresence,
  getVisitorAnalytics,
  visitorLocationFromHeaders,
} from "./lib/visitorAnalytics.js";
import {
  getEbayRateGuardStatus,
  isEbayRateGuardError,
  recommendedEbayBackgroundCallBudget,
} from "./lib/ebayRateGuard.js";
import {
  getEbayApiUsageStatus,
  noteEbayDeduplicatedCall,
  noteEbayDeferredDemand,
} from "./lib/ebayApiUsage.js";
import { generateRelatedSearches } from "./services/searchExpansion.js";
import { fetchAwinFeed } from "./providers/awin.js";
import { demoCandidates } from "./providers/demo.js";
import { enrichProductWithAI } from "./services/ai.js";
import { getConfigValue, vaultSecurityStatus } from "./lib/privateConfig.js";
import {
  integrationSummary,
  saveIntegration,
  clearIntegration,
} from "./lib/integrations.js";
import { testIntegration } from "./services/integrationTests.js";
import {
  buildChallengeResponse,
  deletionSetupStatus,
  acknowledgeDeletionNotification,
  verifyDeletionNotificationAsync,
  testPublicDeletionEndpoint,
} from "./services/ebayDeletion.js";
import { StartupTqdmBar } from "./lib/startupTqdm.js";
import {
  beginInteractiveRequest,
  backgroundCheckpoint,
  getInteractivePriorityStatus,
  waitForInteractiveIdle,
} from "./lib/requestPriority.js";
import { searchRelevance } from "./lib/searchRelevance.js";
import { isExplicitProduct, isExplicitSearchQuery } from "./lib/contentSafety.js";
import { getEbayAdaptiveVerificationPolicy } from "./lib/ebayVerificationPressure.js";
import {
  attachAffiliateClickReference,
  attributionFromRequest,
  flushMarketingAnalytics,
  getCommissionAnalytics,
  getMarketingAnalytics,
  hasCampaignAttribution,
  importCommissionCsv,
  newClickReference,
  newTrackingToken,
  normalizeAttribution,
  recordMarketingClick,
  recordMarketingVisit,
} from "./lib/marketingAnalytics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const APP_NAME = process.env.APP_NAME || "OfferGrid";
const APP_VERSION = "3.7.61-js";
const SHOPPER_PAGE_SIZE = CATALOG_SHOPPER_PAGE_SIZE;
const SITE_BASE_URL = String(process.env.SITE_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SITE_ORIGIN = (() => {
  try { return new URL(SITE_BASE_URL).origin; }
  catch { return `http://localhost:${PORT}`; }
})();
const CANONICAL_HOST =
  process.env.CANONICAL_HOST ||
  (() => {
    try { return new URL(SITE_BASE_URL).hostname; }
    catch { return ""; }
  })();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-this-password";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "false").toLowerCase() === "true";
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const TRUST_PROXY = process.env.TRUST_PROXY || "1";
const ENFORCE_CANONICAL_HOST =
  String(process.env.ENFORCE_CANONICAL_HOST || "false").toLowerCase() === "true";
const FORCE_HTTPS =
  String(process.env.FORCE_HTTPS || "false").toLowerCase() === "true";
const SHOW_ADMIN_NAV =
  String(process.env.SHOW_ADMIN_NAV ?? (!IS_PRODUCTION)).toLowerCase() === "true";
const STRICT_PRODUCTION =
  String(process.env.STRICT_PRODUCTION || "false").toLowerCase() === "true";
const CAMPAIGN_TRAFFIC_MODE =
  String(process.env.CAMPAIGN_TRAFFIC_MODE || "false").toLowerCase() === "true";
const DALLAS_CAMPAIGN_LANDINGS = Object.freeze({
  "/dallas/area-1": "1",
  "/dallas/area-2": "2",
  "/dallas/area-3": "3",
});
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "api@offergrid.tech";
const CLOUDFLARE_ACCESS_REQUIRED =
  String(process.env.CLOUDFLARE_ACCESS_REQUIRED || "false").toLowerCase() === "true";
const CLOUDFLARE_ACCESS_EMAILS = new Set(
  String(process.env.CLOUDFLARE_ACCESS_EMAILS || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
);

const ATTRIBUTION_COOKIE = "og_attribution";
const MARKETING_VISITOR_COOKIE = "og_visitor";
const MARKETING_SESSION_COOKIE = "og_session";
const ATTRIBUTION_MAX_AGE_SECONDS = Math.max(
  86_400,
  Math.min(Number(process.env.ATTRIBUTION_COOKIE_DAYS || 90) * 86_400, 365 * 86_400)
);
const MARKETING_VISITOR_MAX_AGE_SECONDS = 365 * 86_400;
const MARKETING_SESSION_MAX_AGE_SECONDS = Math.max(
  30 * 60,
  Math.min(Number(process.env.MARKETING_SESSION_MINUTES || 30) * 60, 24 * 60 * 60)
);

const STARTER_POPULATE_ON_BOOT =
  String(process.env.STARTER_POPULATE_ON_BOOT || "true").toLowerCase() === "true";
const STARTER_AUTO_PUBLISH =
  String(process.env.STARTER_AUTO_PUBLISH || "true").toLowerCase() === "true";
const STARTER_PRODUCTS_PER_QUERY = Math.min(
  Math.max(
    Number(process.env.DISCOVERY_RESULTS_PER_RULE || process.env.STARTER_PRODUCTS_PER_QUERY || 50),
    10
  ),
  100
);

const CATALOG_TARGET_PRODUCTS = Math.max(
  1000,
  Number(process.env.CATALOG_TARGET_PRODUCTS || 10000)
);
const DISCOVERY_RULES_PER_CYCLE = Math.min(
  Math.max(Number(process.env.DISCOVERY_RULES_PER_CYCLE || 24), 1),
  100
);
const DISCOVERY_MAX_RULES = Math.min(
  Math.max(Number(process.env.DISCOVERY_MAX_RULES || 300), 56),
  1000
);
const DISCOVERY_EXPANSIONS_PER_STALLED_RULE = Math.min(
  Math.max(Number(process.env.DISCOVERY_EXPANSIONS_PER_STALLED_RULE || 2), 1),
  5
);
const DISCOVERY_MAX_GENERATION_DEPTH = Math.min(
  Math.max(Number(process.env.DISCOVERY_MAX_GENERATION_DEPTH || 5), 1),
  12
);

const STARTER_EBAY_SEARCHES = [
  { key: "aquarium-canister-filter", name: "Aquarium · Canister filters", query: "aquarium canister filter", category: "Aquarium" },
  { key: "aquarium-hob-filter", name: "Aquarium · HOB filters", query: "aquarium hob power filter", category: "Aquarium" },
  { key: "aquarium-sponge-filter", name: "Aquarium · Sponge filters", query: "aquarium sponge filter", category: "Aquarium" },
  { key: "aquarium-air-pump", name: "Aquarium · Air pumps", query: "aquarium air pump quiet", category: "Aquarium" },
  { key: "aquarium-heater", name: "Aquarium · Heaters", query: "aquarium heater thermostat", category: "Aquarium" },
  { key: "aquarium-led-light", name: "Aquarium · LED lighting", query: "aquarium led light planted tank", category: "Aquarium" },
  { key: "aquarium-wavemaker", name: "Aquarium · Wavemakers", query: "aquarium wavemaker circulation pump", category: "Aquarium" },
  { key: "aquarium-co2", name: "Aquarium · CO2 equipment", query: "aquarium co2 regulator diffuser kit", category: "Aquarium" },
  { key: "auto-obd2", name: "Automotive · OBD2 scanners", query: "obd2 scanner diagnostic tool", category: "Automotive" },
  { key: "auto-bidirectional", name: "Automotive · Bidirectional scanners", query: "bidirectional obd2 scan tool", category: "Automotive" },
  { key: "auto-battery-tester", name: "Automotive · Battery testers", query: "automotive battery tester", category: "Automotive" },
  { key: "auto-jump-starter", name: "Automotive · Jump starters", query: "portable car jump starter", category: "Automotive" },
  { key: "auto-multimeter", name: "Automotive · Multimeters", query: "digital multimeter automotive", category: "Automotive" },
  { key: "auto-torque-wrench", name: "Automotive · Torque wrenches", query: "digital torque wrench", category: "Automotive" },
  { key: "auto-tpms", name: "Automotive · TPMS tools", query: "tpms relearn tool", category: "Automotive" },
  { key: "auto-brake-bleeder", name: "Automotive · Brake service", query: "brake bleeder vacuum kit", category: "Automotive" },
  { key: "tools-impact-wrench", name: "Power Tools · Impact wrenches", query: "brushless cordless impact wrench", category: "Power Tools" },
  { key: "tools-drill", name: "Power Tools · Drill drivers", query: "brushless drill driver kit", category: "Power Tools" },
  { key: "tools-impact-driver", name: "Power Tools · Impact drivers", query: "cordless impact driver", category: "Power Tools" },
  { key: "tools-oscillating", name: "Power Tools · Oscillating tools", query: "cordless oscillating multi tool", category: "Power Tools" },
  { key: "tools-grinder", name: "Power Tools · Angle grinders", query: "cordless angle grinder", category: "Power Tools" },
  { key: "tools-circular-saw", name: "Power Tools · Circular saws", query: "cordless circular saw", category: "Power Tools" },
  { key: "tools-battery", name: "Power Tools · Batteries & chargers", query: "power tool battery charger", category: "Power Tools" },
  { key: "tools-recip-saw", name: "Power Tools · Reciprocating saws", query: "cordless reciprocating saw", category: "Power Tools" },
  { key: "3dp-filament-dryer", name: "3D Printing · Filament dryers", query: "3d printer filament dryer", category: "3D Printing" },
  { key: "3dp-pla", name: "3D Printing · PLA filament", query: "pla filament 1.75mm", category: "3D Printing" },
  { key: "3dp-petg", name: "3D Printing · PETG filament", query: "petg filament 1.75mm", category: "3D Printing" },
  { key: "3dp-pei", name: "3D Printing · PEI plates", query: "3d printer pei build plate", category: "3D Printing" },
  { key: "3dp-nozzle", name: "3D Printing · Nozzles", query: "3d printer nozzle hardened steel", category: "3D Printing" },
  { key: "3dp-hotend", name: "3D Printing · Hotends", query: "3d printer hotend upgrade", category: "3D Printing" },
  { key: "3dp-enclosure", name: "3D Printing · Enclosures", query: "3d printer enclosure", category: "3D Printing" },
  { key: "3dp-wash-cure", name: "3D Printing · Wash & cure", query: "resin 3d printer wash cure station", category: "3D Printing" },
  { key: "pc-keyboard", name: "PC Accessories · Keyboards", query: "mechanical keyboard hot swap", category: "PC Accessories" },
  { key: "pc-mouse", name: "PC Accessories · Mice", query: "gaming mouse lightweight wired", category: "PC Accessories" },
  { key: "pc-dock", name: "PC Accessories · USB-C docks", query: "usb c docking station dual monitor", category: "PC Accessories" },
  { key: "pc-nvme", name: "PC Accessories · NVMe enclosures", query: "nvme ssd enclosure usb c", category: "PC Accessories" },
  { key: "pc-wifi", name: "PC Accessories · Wi-Fi cards", query: "pcie wifi 6e card", category: "PC Accessories" },
  { key: "pc-monitor-arm", name: "PC Accessories · Monitor arms", query: "monitor arm gas spring", category: "PC Accessories" },
  { key: "pc-microphone", name: "PC Accessories · USB microphones", query: "usb microphone pc", category: "PC Accessories" },
  { key: "pc-cooling", name: "PC Accessories · Laptop cooling", query: "laptop cooling pad", category: "PC Accessories" },
  { key: "usbc-100w-gan", name: "USB-C Charging · 100W GaN", query: "100w usb c gan charger", category: "USB-C Charging" },
  { key: "usbc-65w-gan", name: "USB-C Charging · 65W GaN", query: "65w usb c gan charger", category: "USB-C Charging" },
  { key: "usbc-240w-cable", name: "USB-C Charging · 240W cables", query: "240w usb c cable", category: "USB-C Charging" },
  { key: "usbc-100w-cable", name: "USB-C Charging · 100W cables", query: "100w usb c cable", category: "USB-C Charging" },
  { key: "usbc-power-bank", name: "USB-C Charging · High-output banks", query: "usb c power bank 100w", category: "USB-C Charging" },
  { key: "usbc-car", name: "USB-C Charging · Car chargers", query: "usb c car charger pd", category: "USB-C Charging" },
  { key: "usbc-multiport", name: "USB-C Charging · Multiport chargers", query: "multiport usb c charger", category: "USB-C Charging" },
  { key: "usbc-station", name: "USB-C Charging · Charging stations", query: "usb c charging station", category: "USB-C Charging" },
  { key: "power-station", name: "Portable Power · Power stations", query: "portable power station", category: "Portable Power" },
  { key: "power-solar-panel", name: "Portable Power · Solar panels", query: "portable solar panel power station", category: "Portable Power" },
  { key: "power-lifepo4", name: "Portable Power · LiFePO4 stations", query: "lifepo4 portable power station", category: "Portable Power" },
  { key: "power-solar-generator", name: "Portable Power · Solar generators", query: "solar generator kit", category: "Portable Power" },
  { key: "power-1000w", name: "Portable Power · 1000W class", query: "portable power station 1000w", category: "Portable Power" },
  { key: "power-500w", name: "Portable Power · 500W class", query: "portable power station 500w", category: "Portable Power" },
  { key: "power-200w-panel", name: "Portable Power · 200W panels", query: "foldable solar panel 200w", category: "Portable Power" },
  { key: "power-expansion", name: "Portable Power · Expansion batteries", query: "power station expansion battery", category: "Portable Power" },
];

function safeDecodeComponent(value) {
  try { return decodeURIComponent(String(value || "")); }
  catch { return null; }
}

function parseCookies(req) {
  const header = String(req.headers.cookie || "").slice(0, 16_384);
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = safeDecodeComponent(part.slice(0, index).trim());
    const value = safeDecodeComponent(part.slice(index + 1).trim());
    if (!key || value == null || key.length > 128 || value.length > 8192) continue;
    out[key] = value;
  }
  return out;
}

function signedTrackingValue(namespace, value) {
  const payload = Buffer.from(String(value || ""), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`${namespace}:${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifiedTrackingValue(namespace, signedValue, maxLength = 4096) {
  const raw = String(signedValue || "");
  if (!raw || raw.length > maxLength) return "";
  const separator = raw.lastIndexOf(".");
  if (separator < 1) return "";
  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`${namespace}:${payload}`)
    .digest("base64url");
  if (!safeEqual(signature, expected)) return "";
  try { return Buffer.from(payload, "base64url").toString("utf8"); }
  catch { return ""; }
}

function appendTrackingCookie(res, name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(Number(maxAgeSeconds) || 0))}`,
  ];
  if (COOKIE_SECURE) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function parseAttributionCookie(cookies) {
  const raw = verifiedTrackingValue(ATTRIBUTION_COOKIE, cookies[ATTRIBUTION_COOKIE], 8192);
  if (!raw) return normalizeAttribution();
  try { return normalizeAttribution(JSON.parse(raw)); }
  catch { return normalizeAttribution(); }
}

function marketingTrackingContext(req, res, { captureQuery = false } = {}) {
  const cookies = parseCookies(req);
  let visitorId = verifiedTrackingValue(MARKETING_VISITOR_COOKIE, cookies[MARKETING_VISITOR_COOKIE], 1024);
  let sessionId = verifiedTrackingValue(MARKETING_SESSION_COOKIE, cookies[MARKETING_SESSION_COOKIE], 1024);
  let attribution = parseAttributionCookie(cookies);

  if (!visitorId) {
    visitorId = newTrackingToken("visitor");
    appendTrackingCookie(
      res,
      MARKETING_VISITOR_COOKIE,
      signedTrackingValue(MARKETING_VISITOR_COOKIE, visitorId),
      MARKETING_VISITOR_MAX_AGE_SECONDS
    );
  }

  const campaignKeys = [
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "og_area", "og_partner",
  ];
  const hasExplicitCampaign = captureQuery && campaignKeys.some(key =>
    String(req.query?.[key] ?? "").trim()
  );
  let externalReferrer = "";
  if (captureQuery && !hasExplicitCampaign && !hasCampaignAttribution(attribution)) {
    try {
      const referrer = new URL(String(req.get("referer") || ""));
      if (referrer.hostname.toLowerCase() !== requestHostname(req)) externalReferrer = referrer.toString();
    } catch {}
  }
  const queryAttribution = hasExplicitCampaign
    ? attributionFromRequest(req.query || {}, "")
    : externalReferrer
      ? attributionFromRequest({}, externalReferrer)
      : normalizeAttribution();
  if (captureQuery && hasCampaignAttribution(queryAttribution)) {
    attribution = queryAttribution;
    sessionId = "";
    appendTrackingCookie(
      res,
      ATTRIBUTION_COOKIE,
      signedTrackingValue(ATTRIBUTION_COOKIE, JSON.stringify(attribution)),
      ATTRIBUTION_MAX_AGE_SECONDS
    );
  }

  if (!sessionId) sessionId = newTrackingToken("session");
  appendTrackingCookie(
    res,
    MARKETING_SESSION_COOKIE,
    signedTrackingValue(MARKETING_SESSION_COOKIE, sessionId),
    MARKETING_SESSION_MAX_AGE_SECONDS
  );

  return { visitorId, sessionId, attribution };
}


app.disable("x-powered-by");

if (TRUST_PROXY === "true") app.set("trust proxy", true);
else if (TRUST_PROXY === "false" || TRUST_PROXY === "0") app.set("trust proxy", false);
else app.set("trust proxy", Number(TRUST_PROXY) || 1);

function requestHostname(req) {
  return String(req.get("host") || "").split(":")[0].toLowerCase();
}

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function canonicalUrl(req) {
  return `${SITE_BASE_URL}${req.originalUrl || "/"}`;
}

app.use((req, res, next) => {
  const hostname = requestHostname(req);

  if (
    FORCE_HTTPS &&
    !req.secure &&
    !isLocalHostname(hostname)
  ) {
    return res.redirect(308, canonicalUrl(req));
  }

  if (
    ENFORCE_CANONICAL_HOST &&
    CANONICAL_HOST &&
    !isLocalHostname(hostname) &&
    hostname !== CANONICAL_HOST.toLowerCase()
  ) {
    return res.redirect(308, canonicalUrl(req));
  }

  next();
});

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");

  // Affiliate/ad hosts are allowlisted. Executable inline code is prohibited;
  // object/embed content and framing remain disabled.
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' https://getsquirrel.co https://*.getsquirrel.co https://pagead2.googlesyndication.com https://*.googlesyndication.com",
      "style-src 'self'",
      "img-src 'self' data: https:",
      "connect-src 'self' https://getsquirrel.co https://*.getsquirrel.co https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net",
      "font-src 'self' data:",
      "frame-src https://*.googlesyndication.com https://*.doubleclick.net",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; ")
  );

  if (req.secure || IS_PRODUCTION) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
});

function cloudflareAccessGuard(req, res, next) {
  if (!CLOUDFLARE_ACCESS_REQUIRED) return next();

  const hostname = requestHostname(req);
  if (isLocalHostname(hostname)) return next();

  const email = String(req.get("cf-access-authenticated-user-email") || "")
    .trim()
    .toLowerCase();

  if (!email) {
    return res.status(403).send("Cloudflare Access authentication required.");
  }

  if (CLOUDFLARE_ACCESS_EMAILS.size && !CLOUDFLARE_ACCESS_EMAILS.has(email)) {
    return res.status(403).send("This Cloudflare Access identity is not allowed.");
  }

  next();
}

app.use((req, res, next) => {
  if (req.path === "/admin" || req.path === "/admin.html" || req.path.startsWith("/api/admin")) {
    res.setHeader("Cache-Control", "no-store, private");
    return cloudflareAccessGuard(req, res, next);
  }
  next();
});

// V3.7.15: user-generated traffic has hard priority over scheduled work.
// Long-lived SSE streams and health probes are excluded so they do not pause
// background work forever. Everything else counts as interactive demand.
app.use((req, res, next) => {
  const pathName = String(req.path || "");
  const excluded =
    pathName === "/api/health" ||
    pathName === "/api/live/stream" ||
    pathName === "/api/admin/live/stream" ||
    pathName === "/api/ebay/deletion";

  if (excluded) return next();

  const finishInteractive = beginInteractiveRequest();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    finishInteractive();
  };
  res.once("finish", finish);
  res.once("close", finish);
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// Stable path-based campaign URLs are safer for QR/placement vendors than a
// long query string: the server reconstructs the canonical attribution tags
// even if an intermediary strips parameters from the printed destination.
app.get(Object.keys(DALLAS_CAMPAIGN_LANDINGS), (req, res) => {
  const area = DALLAS_CAMPAIGN_LANDINGS[req.path];
  const isTest = String(req.query?.test || "").toLowerCase() === "1";
  const suffix = isTest ? "_test" : "";
  const query = new URLSearchParams({
    utm_source: "shot_or_shock",
    utm_medium: "out_of_home",
    utm_campaign: `dallas_launch_2026${suffix}`,
    utm_content: `area_${area}${suffix}`,
    og_area: `dallas_area_${area}${suffix}`,
    og_partner: "shot_or_shock",
  });
  res.set("Cache-Control", "no-store");
  res.redirect(302, `/?${query.toString()}#all-products`);
});

app.use((req, res, next) => {
  const pathName = String(req.path || "").toLowerCase();
  const isPublicHtmlRequest =
    ["GET", "HEAD"].includes(req.method) &&
    !pathName.startsWith("/api/") &&
    !pathName.startsWith("/go/") &&
    pathName !== "/admin" &&
    pathName !== "/admin.html" &&
    Boolean(req.accepts("html"));
  if (isPublicHtmlRequest) {
    req.marketing = marketingTrackingContext(req, res, { captureQuery: true });
    if (req.method === "GET") {
      // Record the landing at the server edge so a fast bounce, blocked script,
      // or client error cannot erase a paid campaign view. The browser presence
      // call uses the same signed session and is deduplicated automatically.
      recordMarketingVisit({
        visitorId: req.marketing.visitorId,
        sessionId: req.marketing.sessionId,
        path: req.originalUrl || req.path || "/",
        referrer: req.get("referer") || "",
        userAgent: req.get("user-agent") || "",
        attribution: req.marketing.attribution,
      });
    }
  }
  next();
});

app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
    maxAge: IS_PRODUCTION ? "10m" : 0,
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html") || filePath.endsWith(".webmanifest")) {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      } else if (
        filePath.endsWith(".js") ||
        filePath.endsWith(".css") ||
        filePath.endsWith(".webp") ||
        filePath.endsWith(".png") ||
        filePath.endsWith(".svg")
      ) {
        // Build-versioned asset URLs are safe to cache immutably in production.
        // Development stays uncached; API/product data remains no-store.
        res.setHeader(
          "Cache-Control",
          IS_PRODUCTION
            ? "public, max-age=31536000, immutable"
            : "no-cache, must-revalidate"
        );
      }
    },
  })
);

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function signSessionPayload(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function createSessionToken() {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      iat: Date.now(),
      exp: Date.now() + 12 * 60 * 60 * 1000,
      nonce: crypto.randomBytes(16).toString("hex"),
    })
  ).toString("base64url");

  return `${payload}.${signSessionPayload(payload)}`;
}

function validateSessionToken(token) {
  const raw = String(token || "");
  if (!raw || raw.length > 4096) return false;
  const parts = raw.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  if (!payload || !signature || payload.length > 2048 || signature.length > 256) return false;
  if (!safeEqual(signature, signSessionPayload(payload))) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const now = Date.now();
    const iat = Number(data?.iat);
    const exp = Number(data?.exp);
    const maxLifetimeMs = 13 * 60 * 60 * 1000;
    return (
      data?.v === 1 &&
      Number.isFinite(iat) &&
      Number.isFinite(exp) &&
      iat <= now + 5 * 60_000 &&
      exp > now &&
      exp > iat &&
      exp - iat <= maxLifetimeMs
    );
  } catch {
    return false;
  }
}

function isAdmin(req) {
  return validateSessionToken(parseCookies(req).affiliate_admin || "");
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: "Admin login required." });
  res.set("Cache-Control", "no-store");
  next();
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function cleanError(error) {
  const message = error?.message || String(error);
  return message.length > 700 ? message.slice(0, 700) + "…" : message;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}


const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_STATE_MAX_ENTRIES = 5000;

function pruneLoginAttempts(now = Date.now()) {
  if (loginAttempts.size < LOGIN_STATE_MAX_ENTRIES) return;
  for (const [key, state] of loginAttempts) {
    const inactiveSince = Math.max(Number(state?.windowStart || 0), Number(state?.blockedUntil || 0));
    if (!inactiveSince || now - inactiveSince > Math.max(LOGIN_WINDOW_MS, LOGIN_BLOCK_MS) * 2) {
      loginAttempts.delete(key);
    }
    if (loginAttempts.size < Math.floor(LOGIN_STATE_MAX_ENTRIES * 0.8)) break;
  }
  while (loginAttempts.size >= LOGIN_STATE_MAX_ENTRIES) {
    const oldest = loginAttempts.keys().next().value;
    if (oldest == null) break;
    loginAttempts.delete(oldest);
  }
}

function clientIp(req) {
  return String(req.get("cf-connecting-ip") || req.ip || req.socket.remoteAddress || "unknown").slice(0, 160);
}

function loginState(req) {
  const key = clientIp(req);
  const now = Date.now();
  pruneLoginAttempts(now);
  let state = loginAttempts.get(key);

  if (!state || now - state.windowStart > LOGIN_WINDOW_MS) {
    state = { windowStart: now, failures: 0, blockedUntil: 0 };
    loginAttempts.set(key, state);
  }

  return { key, state };
}

function loginRateLimit(req, res, next) {
  const { state } = loginState(req);
  if (state.blockedUntil > Date.now()) {
    const seconds = Math.ceil((state.blockedUntil - Date.now()) / 1000);
    res.setHeader("Retry-After", String(seconds));
    return res.status(429).json({
      error: `Too many failed login attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`
    });
  }
  next();
}

function recordLoginFailure(req) {
  const { state } = loginState(req);
  state.failures += 1;
  if (state.failures >= LOGIN_MAX_FAILURES) {
    state.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
  }
}

function clearLoginFailures(req) {
  loginAttempts.delete(clientIp(req));
}

function adminRequestGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  // Browser Admin actions deliberately carry a non-simple custom header.
  // That gives us a strong CSRF signal without hard-coding the public domain
  // as the only valid Origin (which previously broke localhost Admin login).
  if (req.get("x-offergrid-admin") !== "1") {
    return res.status(403).json({
      error: "Admin request guard rejected this request. Refresh the Admin page and try again."
    });
  }

  const fetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();
  if (fetchSite === "cross-site") {
    return res.status(403).json({ error: "Cross-site Admin requests are not allowed." });
  }

  const origin = req.get("origin");
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      const originHost = parsedOrigin.hostname.toLowerCase();
      const requestHost = requestHostname(req);

      // A relative fetch from the Admin page should have the same hostname
      // as the incoming request. Localhost / 127.0.0.1 are also permitted
      // so the live build can still be administered directly on the host.
      const sameHost = originHost === requestHost;
      const bothLocal = isLocalHostname(originHost) && isLocalHostname(requestHost);

      if (!sameHost && !bothLocal) {
        return res.status(403).json({
          error: `Admin request origin mismatch (${originHost} → ${requestHost}).`
        });
      }
    } catch {
      return res.status(403).json({ error: "Invalid Admin request origin." });
    }
  }

  next();
}

app.use("/api/admin", adminRequestGuard);

function deploymentSummary() {
  const vault = vaultSecurityStatus();
  const weakAdmin =
    ADMIN_PASSWORD.length < 12 ||
    ["change-this-password", "CHANGE_ME_BEFORE_LIVE"].includes(ADMIN_PASSWORD);
  const weakSession =
    SESSION_SECRET.length < 32 ||
    SESSION_SECRET === "dev-secret" ||
    SESSION_SECRET.includes("replace-this") ||
    SESSION_SECRET.includes("CHANGE_ME");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(HOST);
  const httpsSite = SITE_BASE_URL.startsWith("https://");

  return {
    siteBaseUrl: SITE_BASE_URL,
    canonicalHost: CANONICAL_HOST,
    bind: `${HOST}:${PORT}`,
    nodeEnv: NODE_ENV,
    cloudflareAccessRequired: CLOUDFLARE_ACCESS_REQUIRED,
    checks: [
      {
        name: "Production mode",
        ok: IS_PRODUCTION,
        detail: `NODE_ENV=${NODE_ENV}`,
      },
      {
        name: "HTTPS canonical URL",
        ok: httpsSite,
        detail: SITE_BASE_URL,
      },
      {
        name: "Origin bound to loopback",
        ok: loopback,
        detail: `${HOST}:${PORT} — ideal for Cloudflare Tunnel`,
      },
      {
        name: "Secure Admin cookie",
        ok: COOKIE_SECURE,
        detail: `COOKIE_SECURE=${COOKIE_SECURE}`,
      },
      {
        name: "Admin password changed",
        ok: !weakAdmin,
        detail: weakAdmin ? "Use a unique password with at least 12 characters." : "Custom password configured.",
      },
      {
        name: "Session secret hardened",
        ok: !weakSession,
        detail: weakSession ? "Generate a long random SESSION_SECRET." : "Strong session secret configured.",
      },
      {
        name: "Credential vault key",
        ok:
          String(process.env.CONFIG_ENCRYPTION_KEY || "").length >= 32 &&
          !String(process.env.CONFIG_ENCRYPTION_KEY || "").includes("CHANGE_ME"),
        detail:
          String(process.env.CONFIG_ENCRYPTION_KEY || "").length >= 32 &&
          !String(process.env.CONFIG_ENCRYPTION_KEY || "").includes("CHANGE_ME")
            ? `${vault.algorithm} · dedicated CONFIG_ENCRYPTION_KEY`
            : "Set a dedicated random CONFIG_ENCRYPTION_KEY.",
      },
      {
        name: "Cloudflare Access (optional)",
        ok: true,
        detail: CLOUDFLARE_ACCESS_REQUIRED
          ? "Enabled — Cloudflare identity is required before OfferGrid Admin."
          : "Not enabled — optional additional layer; OfferGrid password is still enforced.",
      },
    ],
  };
}

function validateProductionConfig() {
  if (!IS_PRODUCTION) return;

  const deployment = deploymentSummary();
  const fatalChecks = deployment.checks.filter(check =>
    [
      "HTTPS canonical URL",
      "Origin bound to loopback",
      "Secure Admin cookie",
      "Admin password changed",
      "Session secret hardened",
      "Credential vault key",
    ].includes(check.name) && !check.ok
  );

  if (!fatalChecks.length) return;

  console.error("\n[production] OfferGrid found unsafe live settings:");
  for (const check of fatalChecks) {
    console.error(`  - ${check.name}: ${check.detail}`);
  }
  console.error("");

  if (STRICT_PRODUCTION) {
    console.error("[production] STRICT_PRODUCTION=true, refusing to start.\n");
    process.exit(1);
  }

  console.warn("[production] WARNING: server will continue because STRICT_PRODUCTION=false.\n");
}



// ------------------------------------------------------------------
// eBay Marketplace Account Deletion / Closure notifications
// Public HTTPS callback used by the eBay Developer Portal.
// ------------------------------------------------------------------
app.get("/api/ebay/account-deletion", (req, res) => {
  const challengeCode = String(req.query?.challenge_code || "");

  if (!challengeCode) {
    return res.status(400).json({
      error: "Missing challenge_code.",
      configured: deletionSetupStatus().endpointValid,
    });
  }

  try {
    const challengeResponse = buildChallengeResponse(challengeCode);
    res
      .status(200)
      .type("application/json")
      .json({ challengeResponse });
  } catch (error) {
    console.error("[ebay deletion] challenge failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.head("/api/ebay/account-deletion", (req, res) => {
  res.status(deletionSetupStatus().endpointValid ? 204 : 503).end();
});

app.post("/api/ebay/account-deletion", (req, res) => {
  const payload = req.body || {};
  const signature = String(req.get("x-ebay-signature") || "");

  if (payload?.metadata?.topic !== "MARKETPLACE_ACCOUNT_DELETION") {
    return res.status(400).json({ error: "Unexpected eBay notification topic." });
  }

  acknowledgeDeletionNotification(payload, Boolean(signature));

  // eBay asks the callback to acknowledge promptly. OfferGrid does not persist
  // eBay-user personal data, so there is no local user record to delete here.
  res.status(204).end();

  // Validate the eBay signature after acknowledgement, as recommended by eBay.
  setImmediate(() => {
    verifyDeletionNotificationAsync(payload, signature).catch(error => {
      console.error("[ebay deletion] async verification failure:", error);
    });
  });
});

function writeSseEvent(res, eventName, payload, id = null) {
  if (id != null) res.write(`id: ${id}\n`);
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function openLiveSse(req, res, { admin = false } = {}) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  writeSseEvent(res, "hello", {
    version: APP_VERSION,
    revision: getLiveEventRevision(),
    admin,
    serverTime: new Date().toISOString(),
  }, getLiveEventRevision());

  const unsubscribe = subscribeLiveEvents(event => {
    if (!admin && !["public", "all"].includes(event.audience)) return;

    writeSseEvent(res, event.type, {
      revision: event.revision,
      at: event.at,
      ...event.payload,
    }, event.id);
  });

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 25_000);
  heartbeat.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };

  req.once("close", close);
  req.once("aborted", close);
}

app.get("/api/live/stream", (req, res) => {
  openLiveSse(req, res, { admin: false });
});

app.get("/api/admin/live/stream", requireAdmin, (req, res) => {
  openLiveSse(req, res, { admin: true });
});

app.post("/api/presence", (req, res) => {
  const marketing = req.marketing || marketingTrackingContext(req, res);
  recordVisitorPresence({
    visitorId: req.body?.visitorId,
    connectionId: req.body?.connectionId,
    active: req.body?.active !== false,
    location: visitorLocationFromHeaders(req.headers),
  });
  if (req.body?.active !== false) {
    recordMarketingVisit({
      visitorId: marketing.visitorId,
      sessionId: marketing.sessionId,
      path: req.body?.path || "/",
      referrer: req.body?.referrer || req.get("referer") || "",
      userAgent: req.get("user-agent") || "",
      attribution: marketing.attribution,
    });
  }
  res.set("Cache-Control", "no-store");
  res.status(204).end();
});

app.get("/api/config", (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");

  const clientVersion = String(
    req.get("x-offergrid-client-version") || ""
  ).trim();

  if (clientVersion && clientVersion !== APP_VERSION) {
    // Browser-managed HTTP cache is not exposed to JavaScript Cache Storage.
    // Clear-Site-Data lets a known older OfferGrid build ask the browser to
    // discard that network cache before the one-time automatic reload.
    res.set("Clear-Site-Data", '"cache"');
  }

  res.json({
    appName: APP_NAME,
    version: APP_VERSION,
    clientCacheVersion: APP_VERSION,
    siteBaseUrl: SITE_BASE_URL,
    showAdminNav: SHOW_ADMIN_NAV,
    contactEmail: CONTACT_EMAIL,
    adsenseClient: getConfigValue("ADSENSE_CLIENT", ""),
    adsenseSlot: getConfigValue("ADSENSE_SLOT", ""),
    squirrelEnabled:
      String(getConfigValue("SQUIRREL_ENABLED", "true")).toLowerCase() === "true",
    squirrelScriptUrl: getConfigValue(
      "SQUIRREL_SCRIPT_URL",
      ""
    ),
  });
});

function ebayPendingVerificationFallbackActive(discoveryState = null) {
  if (String(process.env.PENDING_VERIFICATION_FALLBACK_ENABLED || "true").toLowerCase() === "false") {
    return false;
  }
  const guard = getEbayRateGuardStatus();
  const getItems = guard?.getItems || {};
  const verificationUnavailable = Boolean(
    guard?.enabled && (
      Number(getItems.interactiveRemaining || 0) <= 0 ||
      Number(getItems.cooldownUntil || 0) > Date.now()
    )
  );
  const progressiveRenderEnabled =
    String(process.env.PENDING_VERIFICATION_PROGRESSIVE_RENDER_ENABLED || "true").toLowerCase() !== "false";
  return Boolean(
    discoveryState?.deferred ||
    verificationUnavailable ||
    (progressiveRenderEnabled && discoveryState?.searched)
  );
}

function mergePendingVerificationIntoCatalogPage(result, {
  q = "",
  category = "",
  page = 1,
  pageSize = SHOPPER_PAGE_SIZE,
  discoveryState = null,
  includeParts = false,
} = {}) {
  if (!q || Number(page) !== 1 || !ebayPendingVerificationFallbackActive(discoveryState)) {
    return {
      ...result,
      pendingVerificationCount: 0,
      pendingVerificationActive: false,
    };
  }

  const capacity = Math.max(0, Number(pageSize || SHOPPER_PAGE_SIZE) - Number(result.products?.length || 0));
  if (!capacity) {
    return {
      ...result,
      pendingVerificationCount: 0,
      pendingVerificationActive: true,
    };
  }

  const approvedIds = new Set((result.products || []).map(product => Number(product.id)));
  const pending = getPendingVerificationSearchProducts({
    q,
    category,
    limit: Math.min(Math.max(capacity * 3, capacity), 300),
    includeParts,
  })
    .filter(product => !approvedIds.has(Number(product.id)))
    .slice(0, capacity);

  if (!pending.length) {
    return {
      ...result,
      pendingVerificationCount: 0,
      pendingVerificationActive: true,
    };
  }

  const products = [...(result.products || []), ...pending];
  const total = Number(result.total || 0) + pending.length;
  return {
    ...result,
    products,
    total,
    totalPages: Math.max(1, Math.ceil(total / Number(pageSize || SHOPPER_PAGE_SIZE))),
    pendingVerificationCount: pending.length,
    pendingVerificationActive: true,
  };
}

const liveSearchInflight = new Map();
const settledHydrationViews = new Map();
const SETTLED_HYDRATION_VIEW_TTL_MS = 30 * 60_000;

function liveSearchInteractionToken() {
  return `interaction-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function settledHydrationViewKey({ clientId = "", viewId = "", q = "", category = "", page = 1, includeParts = false } = {}) {
  const client = shopperViewToken(clientId);
  const view = shopperViewToken(viewId);
  if (!client || !view) return "";
  return [
    client,
    view,
    String(q || "").trim().toLowerCase(),
    String(category || "").trim().toLowerCase(),
    Number(page || 1),
    includeParts ? "parts" : "normal",
  ].join("|");
}

function pruneSettledHydrationViews(now = Date.now()) {
  for (const [key, at] of settledHydrationViews) {
    if (now - Number(at || 0) > SETTLED_HYDRATION_VIEW_TTL_MS) settledHydrationViews.delete(key);
  }
}

function markHydrationViewSettled(job) {
  if (!job || job.workMode !== "hydrate") return 0;
  pruneSettledHydrationViews();
  let marked = 0;
  for (const [clientId, viewId] of job.viewers instanceof Map ? job.viewers : []) {
    const key = settledHydrationViewKey({
      clientId, viewId, q: job.query, category: job.category, page: job.page, includeParts: job.includeParts,
    });
    if (!key) continue;
    settledHydrationViews.set(key, Date.now());
    marked++;
  }
  return marked;
}

function hydrationViewIsSettled(args = {}) {
  pruneSettledHydrationViews();
  const key = settledHydrationViewKey(args);
  return Boolean(key && settledHydrationViews.has(key));
}

// V3.7.45: detached shopper indexing is owned by the result view that asked
// for it. Navigation detaches that view immediately. If no shopper is still
// watching the old page, its interactive job is marked superseded, removed
// from the foreground-dedupe map, and cooperatively hands unfinished products
// to the scheduled background competitor lane.
function shopperViewToken(value, max = 96) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "")
    .slice(0, max);
}

function attachShopperView(job, clientId, viewId) {
  const client = shopperViewToken(clientId);
  const view = shopperViewToken(viewId);
  if (!job || !client || !view) return false;
  if (!(job.viewers instanceof Map)) job.viewers = new Map();
  job.viewers.set(client, view);
  return true;
}

function demoteLiveSearchJob(job, reason = "shopper-navigation") {
  if (!job || job.control?.superseded) return false;
  job.control.superseded = true;
  job.control.reason = reason;
  job.control.supersededAt = Date.now();
  if (liveSearchInflight.get(job.key) === job) liveSearchInflight.delete(job.key);
  opLog("live-search", "foreground shopper indexing demoted to background scheduling", {
    key: job.key,
    query: job.query,
    page: job.page,
    reason,
  });
  return true;
}

function supersedeShopperViewJobs(clientId, viewId) {
  const client = shopperViewToken(clientId);
  const view = shopperViewToken(viewId);
  if (!client || !view) return 0;
  let demoted = 0;

  // Iterate a snapshot because demotion can delete from liveSearchInflight.
  for (const job of [...liveSearchInflight.values()]) {
    const previousView = job?.viewers?.get(client);
    if (!previousView || previousView === view) continue;
    job.viewers.delete(client);
    if (job.viewers.size === 0 && demoteLiveSearchJob(job, "shopper-navigation")) demoted++;
  }
  return demoted;
}

function releaseShopperViewJobs(clientId, viewId) {
  const client = shopperViewToken(clientId);
  const view = shopperViewToken(viewId);
  if (!client || !view) return 0;
  let demoted = 0;
  for (const job of [...liveSearchInflight.values()]) {
    if (job?.viewers?.get(client) !== view) continue;
    job.viewers.delete(client);
    if (job.viewers.size === 0 && demoteLiveSearchJob(job, "shopper-view-released")) demoted++;
  }
  return demoted;
}

function pageCompetitorHydrationState(products = []) {
  const enabled =
    String(process.env.LIVE_SEARCH_COMPETITOR_HYDRATE_ENABLED || "true").toLowerCase() !== "false";
  const targetSellers = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_COMPETITOR_TARGET_SELLERS || 3), 2),
    8
  );
  const freshnessMinutes = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_COMPETITOR_PAGE_FRESH_MINUTES || 60), 1),
    24 * 60
  );
  const now = Date.now();
  const freshnessMs = freshnessMinutes * 60_000;
  let underTarget = 0;
  let staleUnderTarget = 0;
  let stale = 0;
  let unresearched = 0;
  let fresh = 0;

  for (const product of Array.isArray(products) ? products : []) {
    // Observed-only / condition-exception cards are deliberately outside the
    // competitor intelligence lane. Exact source verification (when needed) is
    // owned by discovery; for-parts/non-working rows never affect ranking.
    if (product?.verificationPending || product?.conditionException) continue;
    const competition = product?.ebayCompetition || {};
    const sellerCount = Math.max(0, Number(
      competition.sellerCount ?? product?.competitorSellerCount ?? product?.cachedVerifiedSellerCount ?? 0
    ));
    if (sellerCount < targetSellers) underTarget++;

    // V3.7.46 selective hydration: seller count by itself does not decide
    // whether a visible card needs work. A product is researched only when a
    // completed progressive pass exists for the current seller target. Fresh
    // completed cards are never rehydrated; stale or never-researched cards are.
    const completeAt = Date.parse(String(
      competition.coverageCompleteAt || product?.ebayCompetitorCoverageCompleteAt || ""
    ));
    const completedTarget = Math.max(0, Number(
      competition.coverageTargetSellers || product?.ebayCompetitorCoverageTargetSellers || 0
    ));
    const researched = Number.isFinite(completeAt) && completedTarget >= targetSellers;
    const isStale = researched && now - completeAt >= freshnessMs;

    if (!researched) {
      unresearched++;
      if (sellerCount < targetSellers) staleUnderTarget++;
    } else if (isStale) {
      stale++;
      if (sellerCount < targetSellers) staleUnderTarget++;
    } else {
      fresh++;
    }
  }

  const staleOrUnresearched = stale + unresearched;
  return {
    enabled,
    targetSellers,
    freshnessMinutes,
    underTarget,
    staleUnderTarget,
    stale,
    unresearched,
    fresh,
    staleOrUnresearched,
    needsHydration: enabled && staleOrUnresearched > 0,
  };
}

function liveSearchInflightKey({
  q = "",
  category = "",
  sort = "heat",
  page = 1,
  pageSize = SHOPPER_PAGE_SIZE,
  targetCount = SHOPPER_PAGE_SIZE,
  workMode = "hydrate",
  includeParts = false,
} = {}) {
  return [
    String(q || "").trim().toLowerCase(),
    String(category || "").trim().toLowerCase(),
    String(sort || "heat"),
    Number(page || 1),
    Number(pageSize || SHOPPER_PAGE_SIZE),
    Number(targetCount || SHOPPER_PAGE_SIZE),
    workMode === "discover" ? "discover" : "hydrate",
    includeParts ? "parts" : "normal",
  ].join("|");
}

function shopperViewHasActiveLiveSearch({
  clientId = "",
  viewId = "",
  q = "",
  category = "",
  page = 1,
  pageSize = SHOPPER_PAGE_SIZE,
  targetCount = SHOPPER_PAGE_SIZE,
  includeParts = false,
} = {}) {
  const client = shopperViewToken(clientId);
  const view = shopperViewToken(viewId);
  if (!client || !view) return false;

  const queryKey = String(q || "").trim().toLowerCase();
  const categoryKey = String(category || "").trim().toLowerCase();
  for (const job of liveSearchInflight.values()) {
    if (!job || job.control?.superseded) continue;
    if (job.viewers?.get(client) !== view) continue;
    if (String(job.query || "").trim().toLowerCase() !== queryKey) continue;
    if (String(job.category || "").trim().toLowerCase() !== categoryKey) continue;
    if (Number(job.page || 1) !== Number(page || 1)) continue;
    if (Number(job.pageSize || SHOPPER_PAGE_SIZE) !== Number(pageSize || SHOPPER_PAGE_SIZE)) continue;
    if (Number(job.targetCount || SHOPPER_PAGE_SIZE) !== Number(targetCount || SHOPPER_PAGE_SIZE)) continue;
    if (Boolean(job.includeParts) !== Boolean(includeParts)) continue;

    // V3.7.54: the dropdown sort is presentation-only for an already-owned
    // shopper view. Recognize that view's existing discovery/hydration job even
    // if the browser has changed sort, but do NOT globally dedupe different-sort
    // jobs across unrelated tabs/views with potentially different visible IDs.
    return true;
  }
  return false;
}

app.get("/api/products", asyncRoute(async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 180);
  const category = String(req.query.category || "").trim().slice(0, 200);
  const includeParts = String(req.query.includeParts || "").toLowerCase() === "true";

  if (q && isExplicitSearchQuery(q)) {
    return res.status(400).json({
      error: "This search is not available on OfferGrid.",
      code: "SEARCH_BLOCKED",
    });
  }
  const sort =
    ["heat", "new", "price", "competitors"].includes(String(req.query.sort))
      ? String(req.query.sort)
      : "heat";

  const page = boundedInteger(req.query.page, 1, 1, 100000);
  const preferFresh = String(req.query.fresh || "").toLowerCase() === "true" || String(req.query.fresh || "") === "1";
  // V3.7.44: shopper pages are fixed at 40 cards. The query's complete
  // matching dataset is still filtered + globally sorted in the search worker
  // before pagination; only the hydration/render slice is reduced.
  const pageSize = SHOPPER_PAGE_SIZE;
  const viewClientId = shopperViewToken(req.query.viewClientId);
  const viewId = shopperViewToken(req.query.viewId);
  // Navigation/request intent is registered before any catalog/search work so
  // the new page gets the interactive lane before the old detached job can
  // begin another competitor product or discovery signal.
  const demotedForegroundJobs = supersedeShopperViewJobs(viewClientId, viewId);

  const started = Date.now();
  const result = await searchCatalogPage({
    q,
    category,
    sort,
    page,
    pageSize,
    preferFresh,
    includeParts,
  });

  opLog("http-search", `catalog page served`, {
    q: q || null,
    category: category || null,
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    threaded: result.threaded,
    ms: Date.now() - started,
  });

  const liveSearchEnabled =
    String(process.env.LIVE_SEARCH_ENABLED || "true").toLowerCase() === "true";
  const discoveryState = q
    ? getUserSearchDiscoveryState({ query: q, category, includeParts })
    : null;
  const responseResult = mergePendingVerificationIntoCatalogPage(result, {
    q,
    category,
    page,
    pageSize,
    discoveryState,
    includeParts,
  });
  const targetCount = page * pageSize;
  const foregroundLiveSearchActive = Boolean(q) && shopperViewHasActiveLiveSearch({
    clientId: viewClientId,
    viewId,
    q,
    category,
    page,
    pageSize,
    targetCount,
    includeParts,
  });
  const backgroundDiscoveryActive = Boolean(discoveryState?.backgroundActive);
  // Backward-compatible aggregate signal for diagnostics. Shopper progress and
  // discovery→hydration handoff must use foregroundLiveSearchActive so shared
  // background catalog growth cannot pin the progress card in discovery.
  const liveSearchActive = Boolean(q) && (foregroundLiveSearchActive || backgroundDiscoveryActive);
  const hydrationState = pageCompetitorHydrationState(responseResult.products);
  const hydrationSettledForView = hydrationViewIsSettled({
    clientId: viewClientId,
    viewId,
    q,
    category,
    page,
    includeParts,
  });
  const needsDiscovery =
    Boolean(q) &&
    liveSearchEnabled &&
    result.total < targetCount &&
    (discoveryState?.canDiscoverMore ?? true);
  // V3.7.41: a database-complete page can still be coverage-incomplete.
  // Trigger the same foreground live-search lane when visible products have not
  // received a recent competitor scan, even when no new marketplace products
  // are needed. This keeps cached database searches from serving a permanent
  // wall of one-seller cards.
  const needsHydration =
    Boolean(q) &&
    liveSearchEnabled &&
    !hydrationSettledForView &&
    hydrationState.needsHydration;

  res.json({
    products: responseResult.products,
    categories: getCategories(),
    page: responseResult.page,
    pageSize: responseResult.pageSize,
    total: responseResult.total,
    totalPages: responseResult.totalPages,
    threaded: responseResult.threaded,
    workerStale: Boolean(responseResult.workerStale),
    workerRevision: Number(responseResult.workerRevision ?? -1),
    catalogRevision: Number(responseResult.catalogRevision ?? -1),
    freshnessRepair: Boolean(responseResult.freshnessRepair),
    demotedForegroundJobs,
    sortScope: q ? "full-search-result-set" : "catalog-browse-result-set",
    hydratedPageOnly: true,
    pendingVerificationCount: Number(responseResult.pendingVerificationCount || 0),
    pendingVerificationActive: Boolean(responseResult.pendingVerificationActive),
    includeParts,
    discoveryDeferred: Boolean(discoveryState?.deferred),
    canLiveSearch: Boolean(q) && liveSearchEnabled,
    needsDiscovery,
    needsHydration,
    hydrationSettledForView,
    hydrationUnderTarget: hydrationState.underTarget,
    hydrationStaleUnderTarget: hydrationState.staleUnderTarget,
    hydrationStale: hydrationState.stale,
    hydrationUnresearched: hydrationState.unresearched,
    hydrationFresh: hydrationState.fresh,
    hydrationStaleOrUnresearched: hydrationState.staleOrUnresearched,
    hydrationTargetSellers: hydrationState.targetSellers,
    hydrationFreshnessMinutes: hydrationState.freshnessMinutes,
    liveSearchActive,
    foregroundLiveSearchActive,
    backgroundDiscoveryActive,
    canDiscoverMore:
      Boolean(q) && liveSearchEnabled && (discoveryState?.canDiscoverMore ?? true),
    endOfResults:
      Boolean(q) && Boolean(discoveryState?.searched) &&
      !(discoveryState?.canDiscoverMore ?? true),
    discoveryPagesSearched: Number(discoveryState?.pagesSearched || 0),
    discoveryVariantsTried: Number(discoveryState?.variantsTried || 0),
    discoveryRetryAfterMs: Number(discoveryState?.retryAfterMs || 0),
  });
}));

app.post("/api/search/live/release", (req, res) => {
  const clientId = shopperViewToken(req.body?.viewClientId);
  const viewId = shopperViewToken(req.body?.viewId);
  const demoted = releaseShopperViewJobs(clientId, viewId);
  if (demoted) {
    opLog("live-search", "shopper view released foreground indexing ownership", {
      viewId: viewId || null, demoted,
    });
  }
  res.status(204).end();
});

app.post("/api/search/live", asyncRoute(async (req, res) => {
  const enabled =
    String(process.env.LIVE_SEARCH_ENABLED || "true").toLowerCase() === "true";

  if (!enabled) {
    return res.status(503).json({
      error: "Live marketplace search is disabled.",
    });
  }

  const q = String(req.body?.q || "").trim().slice(0, 180);
  const category = String(req.body?.category || "").trim().slice(0, 200);
  const includeParts = Boolean(req.body?.includeParts);
  const page = boundedInteger(req.body?.page, 1, 1, 100000);
  const pageSize = SHOPPER_PAGE_SIZE;
  const sort = ["heat", "new", "price", "competitors"].includes(String(req.body?.sort))
    ? String(req.body.sort)
    : "heat";
  const targetCount = boundedInteger(req.body?.targetCount, page * pageSize, 1, 2400);
  const visibleProductIds = [...new Set(
    (Array.isArray(req.body?.visibleProductIds) ? req.body.visibleProductIds : [])
      .map(Number)
      .filter(Number.isFinite)
  )].slice(0, pageSize);
  // V3.7.46 render barrier: no-visible-card requests are discovery-only. Once
  // the browser has rendered normalized products it sends their exact DOM
  // order and the detached job becomes hydration-only. The two modes have
  // separate in-flight keys so a just-finished discovery job cannot swallow
  // the follow-up visible-card hydration request.
  const requestedWorkMode = String(req.body?.workMode || "").toLowerCase();
  const workMode = requestedWorkMode === "discover" || requestedWorkMode === "hydrate"
    ? requestedWorkMode
    : visibleProductIds.length
      ? "hydrate"
      : "discover";
  const viewClientId = shopperViewToken(req.body?.viewClientId);
  const viewId = shopperViewToken(req.body?.viewId);
  supersedeShopperViewJobs(viewClientId, viewId);

  if (q.length < 2) {
    return res.status(400).json({ error: "Search query is too short." });
  }
  if (isExplicitSearchQuery(q)) {
    return res.status(400).json({
      error: "This search is not available on OfferGrid.",
      code: "SEARCH_BLOCKED",
    });
  }

  const key = liveSearchInflightKey({
    q,
    category,
    sort,
    page,
    pageSize,
    targetCount,
    workMode,
    includeParts,
  });
  let job = liveSearchInflight.get(key);
  const started = !job;

  if (!job) {
    const control = {
      superseded: false,
      reason: "",
      supersededAt: 0,
      isSuperseded() { return Boolean(this.superseded); },
    };
    job = {
      key,
      interactionId: liveSearchInteractionToken(),
      query: q,
      category,
      sort,
      page,
      pageSize,
      targetCount,
      workMode,
      includeParts,
      viewers: new Map(),
      control,
      promise: null,
    };
    attachShopperView(job, viewClientId, viewId);

    opLog("live-search", "detached shopper indexing job started", {
      q,
      category: category || null,
      page,
      targetCount,
      workMode,
      visibleProducts: visibleProductIds.length,
      viewId: viewId || null,
    });

    // V3.7.43+: live discovery/indexing must never own the lifetime of the
    // HTTP request. V3.7.45 additionally gives the job a cooperative control
    // object so page navigation can demote it between atomic marketplace calls.
    job.promise = new Promise(resolve => setImmediate(resolve))
      .then(() => discoverForUserSearch({
        query: q,
        category,
        targetCount,
        sort,
        page,
        pageSize,
        visibleProductIds,
        jobControl: control,
        interactionId: job.interactionId,
        workMode,
        includeParts,
      }))
      .then(result => {
        if (workMode === "hydrate" && result?.foregroundHydrationTerminal) {
          const marked = markHydrationViewSettled(job);
          if (marked) {
            opLog("live-search", "shopper hydration interaction settled", {
              interactionId: job.interactionId,
              query: q,
              page,
              views: marked,
            });
          }
        }
        return result;
      })
      .catch(error => {
        opWarn("live-search", "detached shopper indexing job failed", {
          q,
          page,
          workMode,
          error: error?.message || String(error),
        });
        publishLiveEvent("hydration", {
          phase: "page-error",
          interactionId: job.interactionId,
          query: q,
          category: category || "",
          sort,
          page,
          pageSize,
          includeParts,
          error: error?.message || String(error),
        }, { audience: "public" });
        return { failed: true, error: error?.message || String(error) };
      })
      .finally(() => {
        if (liveSearchInflight.get(key) === job) liveSearchInflight.delete(key);
      });

    liveSearchInflight.set(key, job);
  } else {
    attachShopperView(job, viewClientId, viewId);
    noteEbayDeduplicatedCall("browse.search", "browse");
    opLog("live-search", "joined existing detached shopper indexing job", {
      q, targetCount, workMode, viewers: job.viewers?.size || 0,
    });
  }

  const state = getUserSearchDiscoveryState({ query: q, category, includeParts });
  return res.status(202).json({
    ok: true,
    searching: true,
    detached: true,
    started,
    liveSearchActive: true,
    interactionId: String(job.interactionId || ""),
    workMode,
    message: workMode === "discover"
      ? (started
          ? "First-paint marketplace discovery started in the live lane."
          : "First-paint marketplace discovery is already running for this search.")
      : (started
          ? "Competitor indexing started in the live lane."
          : "Competitor indexing is already running for this page."),
    canDiscoverMore: state.canDiscoverMore,
    endOfResults: !state.canDiscoverMore,
    discoveryPagesSearched: state.pagesSearched,
    discoveryVariantsTried: Number(state.variantsTried || 0),
    discoveryRetryAfterMs: Number(state.retryAfterMs || 0),
  });
}));

app.get("/api/deals/trending", (req, res) => {
  const limit = boundedInteger(req.query.limit, 40, 1, 100);
  res.json({ products: getTrendingDeals(limit) });
});

app.get("/api/products/:id/live", (req, res) => {
  const productId = Number(req.params.id);
  const includeParts = String(req.query.includeParts || "").toLowerCase() === "true";
  const product = getShopperProduct(productId, { includeParts });

  if (!product) {
    return res.status(404).json({ error: "Product not found." });
  }

  const best = product.bestOffer;
  const shouldRevalidate =
    best &&
    String(best.provider).toLowerCase() === "ebay" &&
    (!best.priceVerifiedAt ||
      Date.now() - (Date.parse(best.priceVerifiedAt) || 0) >
        Math.max(Number(process.env.EBAY_LIVE_VERIFY_MAX_AGE_MINUTES || 15), 1) * 60_000);

  // Return trusted cached intelligence immediately. If the best eBay offer is
  // stale, refresh it after the response; the existing SSE price event updates
  // the open page without making initial render wait on marketplace latency.
  res.set("Cache-Control", "no-store");
  res.json({ product, revalidating: Boolean(shouldRevalidate) });

  if (shouldRevalidate) {
    setImmediate(() => {
      backgroundCheckpoint(`product-live-revalidate:${productId}`)
        .then(() => verifyEbayOfferIfStale(
          best.id,
          Number(process.env.EBAY_LIVE_VERIFY_MAX_AGE_MINUTES || 15),
          { priority: "background" }
        ))
        .catch(error => {
          console.warn(`[live-price-refresh] product ${productId}: ${cleanError(error)}`);
        });
    });
  }
});

app.get("/api/products/:id", (req, res) => {
  const includeParts = String(req.query.includeParts || "").toLowerCase() === "true";
  const product = getShopperProduct(Number(req.params.id), { includeParts });
  if (!product) return res.status(404).json({ error: "Product not found." });
  res.json({ product });
});

app.get("/go/:offerId", (req, res) => {
  const offerId = Number(req.params.offerId);
  const target = getOutboundClickTarget(offerId);

  if (!target) return res.status(404).send("Offer unavailable.");
  if (target.availability === "out_of_stock") {
    return res.status(410).send(
      "This offer is no longer available. Return to OfferGrid to compare current offers."
    );
  }

  const referrer = req.get("referer") || "";
  const userAgent = req.get("user-agent") || "";
  let landingPath = "";
  try {
    const landing = new URL(referrer);
    if (landing.hostname.toLowerCase() === requestHostname(req)) landingPath = landing.pathname;
  } catch {}
  const marketing = req.marketing || marketingTrackingContext(req, res);
  const clickReference = newClickReference();
  let trackedAffiliateUrl = target.affiliateUrl;

  try {
    const click = recordOutboundClick(offerId, {
      referrer,
      userAgent,
      clickReference,
      attribution: marketing.attribution,
    });
    const referencedUrl = attachAffiliateClickReference(
      target.affiliateUrl,
      target.provider,
      clickReference
    );
    if (referencedUrl) trackedAffiliateUrl = referencedUrl;
    recordMarketingClick({
      clickReference,
      offerId,
      productId: target.productId,
      provider: target.provider,
      visitorId: marketing.visitorId,
      sessionId: marketing.sessionId,
      path: landingPath,
      referrer,
      userAgent,
      attribution: marketing.attribution,
    });
    if (!click) console.warn(`[outbound-click] offer ${offerId}: click could not be added to the catalog analytics view`);
  } catch (error) {
    console.warn(`[outbound-click] offer ${offerId}: ${cleanError(error)}`);
  }

  // V3.7.15: stale-while-revalidate for outbound clicks. The cached offer has
  // already passed OfferGrid's stored trust/availability checks. Attribution is
  // recorded in memory and queued to an append-only ledger before redirecting;
  // no network request or whole-catalog serialization is inserted into this path.
  res.set("Cache-Control", "no-store");
  res.redirect(302, trackedAffiliateUrl);

  setImmediate(() => {
    if (String(target.provider).toLowerCase() === "ebay" && target.needsRevalidation) {
      backgroundCheckpoint(`outbound-revalidate:${offerId}`)
        .then(() => verifyEbayOfferIfStale(
          offerId,
          Number(process.env.EBAY_OUTBOUND_REVALIDATE_MINUTES || 5),
          { priority: "background" }
        ))
        .catch(error => {
          console.warn(`[outbound-price-refresh] offer ${offerId}: ${cleanError(error)}`);
        });
    }
  });
});

app.get("/api/health", (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  res.json({ ok: true, app: APP_NAME, version: APP_VERSION });
});

app.get("/api/admin/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ authenticated: isAdmin(req) });
});

app.get("/api/admin/ebay/usage", requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store");
  const light = String(req.query?.light || "") === "1";
  res.json({
    ok: true,
    usage: getEbayApiUsageStatus(),
    rateGuard: getEbayRateGuardStatus(),
    capabilities: {
      bulkGetItems: getEbayBulkGetItemsCapabilityStatus(),
    },
    // The live quota panel polls this endpoint every two seconds. Avoid a
    // whole-catalog eBay verification-demand scan on that hot telemetry path;
    // the full Admin refresh still supplies the backlog snapshot.
    verificationDemand: light ? null : getEbayVerificationDemandSnapshot(),
  });
});

app.post("/api/admin/login", loginRateLimit, (req, res) => {
  if (!safeEqual(req.body?.password || "", ADMIN_PASSWORD)) {
    recordLoginFailure(req);
    return res.status(401).json({ error: "Incorrect password." });
  }

  clearLoginFailures(req);

  const cookieParts = [
    `affiliate_admin=${encodeURIComponent(createSessionToken())}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=43200",
  ];
  if (COOKIE_SECURE) cookieParts.push("Secure");

  res.setHeader("Set-Cookie", cookieParts.join("; "));
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  const cookieParts = [
    "affiliate_admin=",
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (COOKIE_SECURE) cookieParts.push("Secure");

  res.setHeader("Set-Cookie", cookieParts.join("; "));
  res.json({ ok: true });
});

app.get("/api/admin/catalog", requireAdmin, (req, res) => {
  res.json({
    products: listAllProducts({ limit: 500 }),
    deployment: deploymentSummary(),
    stats: getStats(),
    analytics: getAnalytics(),
    visitors: getVisitorAnalytics(),
    responsiveness: getInteractivePriorityStatus(),
    campaignTrafficMode: CAMPAIGN_TRAFFIC_MODE,
    rules: getDiscoveryRules(),
    integrations: {
      squirrel:
        String(getConfigValue("SQUIRREL_ENABLED", "true")).toLowerCase() === "true" &&
        Boolean(getConfigValue("SQUIRREL_SCRIPT_URL", "")),
      ebay: Boolean(getConfigValue("EBAY_CLIENT_ID", "") && getConfigValue("EBAY_CLIENT_SECRET", "")),
      ebayEnvironment:
        String(getConfigValue("EBAY_ENVIRONMENT", "sandbox")).toLowerCase() === "production"
          ? "production"
          : "sandbox",
      ebayAffiliate: Boolean(getConfigValue("EBAY_AFFILIATE_CAMPAIGN_ID", "")),
      bestbuy: Boolean(getConfigValue("BESTBUY_API_KEY", "")),
      upcitemdb: true,
      openfacts: true,
      awin: Boolean(getConfigValue("AWIN_ACCESS_TOKEN", "") && getConfigValue("AWIN_PUBLISHER_ID", "")),
      rakuten: Boolean(getConfigValue("RAKUTEN_ACCESS_TOKEN", "")),
      rakutenCatalog: Boolean(
        getConfigValue("RAKUTEN_SFTP_USERNAME", "") &&
        getConfigValue("RAKUTEN_SFTP_PASSWORD", "")
      ),
      amazon: Boolean(
        getConfigValue("AMAZON_CREATORS_CLIENT_ID", "") &&
        getConfigValue("AMAZON_CREATORS_CLIENT_SECRET", "") &&
        getConfigValue("AMAZON_PARTNER_TAG", "")
      ),
      openai: Boolean(getConfigValue("OPENAI_API_KEY", "")),
      adsense: Boolean(getConfigValue("ADSENSE_CLIENT", "") && getConfigValue("ADSENSE_SLOT", "")),
      autoSync: String(process.env.AUTO_SYNC_ENABLED || "true").toLowerCase() === "true",
      ebayCompetitorScan:
        String(process.env.EBAY_COMPETITOR_SCAN_ENABLED || "true").toLowerCase() === "true",
    },
    automation: {
      discoveryEnabled:
        String(process.env.AUTO_SYNC_ENABLED || "true").toLowerCase() === "true",
      discoveryMinutes: Math.max(Number(process.env.AUTO_SYNC_MINUTES || 20), 15),
      rulesPerCycle: DISCOVERY_RULES_PER_CYCLE,
      catalogTarget: CATALOG_TARGET_PRODUCTS,
      ...getDiscoveryGrowthStatus(),
      competitorEnabled:
        String(process.env.EBAY_COMPETITOR_SCAN_ENABLED || "true").toLowerCase() === "true",
      competitorMinutes: Math.max(Number(process.env.EBAY_COMPETITOR_SCHEDULER_MINUTES || 10), 5),
      competitorRescanMinutes: Math.max(Number(process.env.EBAY_COMPETITOR_SCAN_MINUTES || 60), 15),
      competitorProductsPerRun: Math.min(
        Math.max(Number(process.env.EBAY_COMPETITOR_PRODUCTS_PER_RUN || 40), 1),
        250
      ),
      competitorResultsPerSearch: Math.min(
        Math.max(
          Number(
            process.env.EBAY_COMPETITOR_DISCOVERY_RESULTS_PER_PRODUCT ||
            Math.max(Number(process.env.EBAY_COMPETITOR_RESULTS_PER_PRODUCT || 50), 100)
          ),
          5
        ),
        200
      ),
      discoverySearches: STARTER_EBAY_SEARCHES.length,
      cleanupEnabled:
        String(process.env.EBAY_COMPETITOR_CLEANUP_ENABLED || "true").toLowerCase() === "true",
      cleanupHours: Math.max(Number(process.env.EBAY_COMPETITOR_CLEANUP_HOURS || 24), 24),
      cleanup: getEbayCompetitorCleanupStatus(),
      localDatabaseCleanup: getLocalDatabaseCleanupStatus(),
      competitorSanitizerEnabled:
        String(process.env.EBAY_COMPETITOR_SANITIZER_ENABLED || "true").toLowerCase() === "true",
      competitorSanitizerMinutes:
        Math.max(Number(process.env.EBAY_COMPETITOR_SANITIZER_MINUTES || 5), 2),
      competitorSanitizer: getEbayCompetitorSanitizerStatus(),
      competitorCoverage: getAdminEbayCompetitorCoverageStatus(),
      priceVerificationEnabled:
        String(process.env.EBAY_PRICE_VERIFY_ENABLED || "true").toLowerCase() === "true",
      priceVerificationMinutes:
        Math.max(Number(process.env.EBAY_PRICE_VERIFY_MINUTES || 10), 5),
      priceVerificationOffersPerRun:
        Math.min(
          Math.max(Number(process.env.EBAY_PRICE_VERIFY_OFFERS_PER_RUN || 320), 1),
          1000
        ),
      priceVerificationBatchSize:
        Math.min(Math.max(Number(process.env.EBAY_PRICE_VERIFY_BATCH_SIZE || 20), 1), 20),
      priceVerificationConcurrency:
        Math.min(Math.max(Number(process.env.EBAY_PRICE_VERIFY_CONCURRENCY || 4), 1), 8),
      catalogSearchThreads: catalogSearchThreadCount(),
      rateGuard: getEbayRateGuardStatus(),
      ebayApiUsage: getEbayApiUsageStatus(),
      ebayVerificationDemand: getEbayVerificationDemandSnapshot(),
      rakutenCatalog: getRakutenCatalogStatus(),
      lifecycle: getProductLifecycleStatus(),
      integrity: getAdminIntegritySummary(),
      draftAutoReview: getDraftAutoReviewStatus(),
    },
  });
});


app.post("/api/admin/drafts/auto-review", requireAdmin, (req, res) => {
  const result = autoApproveConfidentDrafts({
    limit: Math.min(Math.max(Number(req.body?.limit || process.env.DRAFT_AUTO_APPROVE_BATCH || 200), 1), 2000),
    reason: "admin-manual-review",
    deferPersistence: false,
  });
  res.json({ ok: true, result, status: getDraftAutoReviewStatus() });
});

app.get("/api/admin/ebay/account-deletion/status", requireAdmin, (req, res) => {
  res.json({ ok: true, ...deletionSetupStatus() });
});

app.post("/api/admin/ebay/account-deletion/test", requireAdmin, asyncRoute(async (req, res) => {
  const result = await testPublicDeletionEndpoint();
  res.json(result);
}));

app.get("/api/admin/integrations", requireAdmin, (req, res) => {
  res.json(integrationSummary());
});

app.put("/api/admin/integrations/:id", requireAdmin, (req, res) => {
  const item = saveIntegration(req.params.id, req.body?.values || {});
  res.json({ ok: true, item });
});

app.delete("/api/admin/integrations/:id", requireAdmin, (req, res) => {
  const item = clearIntegration(req.params.id);
  res.json({ ok: true, item });
});

app.post("/api/admin/integrations/:id/test", requireAdmin, asyncRoute(async (req, res) => {
  const result = await testIntegration(req.params.id);
  res.json(result);
}));

app.get("/api/admin/rakuten/catalog/status", requireAdmin, (req, res) => {
  res.json({ ok: true, ...getRakutenCatalogStatus() });
});

app.post("/api/admin/rakuten/catalog/sync", requireAdmin, (req, res) => {
  const mode = ["auto", "full", "delta"].includes(String(req.body?.mode || "auto"))
    ? String(req.body?.mode || "auto")
    : "auto";
  const started = startRakutenCatalogSync({
    mode,
    force: Boolean(req.body?.force),
    priority: "background",
  });
  res.status(started.started ? 202 : 200).json({
    ok: true,
    ...started,
    status: getRakutenCatalogStatus(),
  });
});


app.post("/api/admin/import/demo", requireAdmin, (req, res) => {
  res.json({ ok: true, result: ingestCandidates(demoCandidates()) });
});

app.post("/api/admin/import/ebay", requireAdmin, asyncRoute(async (req, res) => {
  const query = String(req.body?.query || "").trim();
  const limit = Math.min(Math.max(Number(req.body?.limit || 30), 1), 200);
  if (!query) return res.status(400).json({ error: "Search query is required." });
  if (isExplicitSearchQuery(query)) {
    return res.status(400).json({ error: "Explicit product searches are not permitted in OfferGrid." });
  }
  const marketplace = await searchEbayAndRakuten(query, limit, {
    priority: "interactive",
  });
  if (marketplace.ebayError && !marketplace.rakutenCandidates.length) {
    throw marketplace.ebayError;
  }
  const candidates = marketplace.candidates;
  res.json({
    ok: true,
    result: ingestCandidates(candidates),
    received: candidates.length,
    providers: {
      ebay: marketplace.ebayCandidates.length,
      rakuten: marketplace.rakutenCandidates.length,
    },
    failures: marketplace.failures,
  });
}));

app.post("/api/admin/import/awin", requireAdmin, asyncRoute(async (req, res) => {
  const advertiserId = String(req.body?.advertiserId || "").trim();
  const locale = String(req.body?.locale || "en_US").trim();
  const limit = Math.min(Math.max(Number(req.body?.limit || 250), 1), 5000);
  if (!advertiserId) return res.status(400).json({ error: "Advertiser ID is required." });
  const candidates = await fetchAwinFeed(advertiserId, locale, limit);
  res.json({ ok: true, result: ingestCandidates(candidates), received: candidates.length });
}));


async function populateStarterStore({ autoPublish = STARTER_AUTO_PUBLISH } = {}) {
  if (!getConfigValue("EBAY_CLIENT_ID", "") || !getConfigValue("EBAY_CLIENT_SECRET", "")) {
    throw new Error(
      "Real starter products require eBay Client ID and Client Secret. Add them in Admin → API connections or .env. " +
      "Add your eBay Partner Network campaign ID too if you want commissionable eBay affiliate URLs."
    );
  }

  const summary = {
    searches: 0,
    offersReceived: 0,
    productsTouched: 0,
    productsCreated: 0,
    published: 0,
    failures: []
  };

  for (const starter of STARTER_EBAY_SEARCHES) {
    try {
      const marketplace = await searchEbayAndRakuten(
        starter.query,
        STARTER_PRODUCTS_PER_QUERY,
        { priority: "background" }
      );
      if (marketplace.ebayError && !marketplace.rakutenCandidates.length) {
        throw marketplace.ebayError;
      }
      const candidates = marketplace.candidates
        .map(candidate => ({ ...candidate, category: starter.category || candidate.category }));
      const result = ingestCandidates(candidates);
      const approved = autoPublish
        ? approveProductIds(result.touchedProductIds, STARTER_PRODUCTS_PER_QUERY)
        : [];

      summary.searches++;
      summary.offersReceived += candidates.length;
      summary.productsTouched += result.productsTouched;
      summary.productsCreated += result.productsCreated;
      summary.published += approved.length;
    } catch (error) {
      summary.failures.push({
        search: starter.query,
        error: cleanError(error)
      });
    }
  }

  return summary;
}

app.post("/api/admin/populate/starter", requireAdmin, asyncRoute(async (req, res) => {
  const autoPublish = req.body?.autoPublish == null
    ? STARTER_AUTO_PUBLISH
    : Boolean(req.body.autoPublish);

  const result = await populateStarterStore({ autoPublish });
  res.json({ ok: true, result });
}));

app.patch("/api/admin/products/:id", requireAdmin, (req, res) => {
  const updated = updateProduct(Number(req.params.id), {
    title: req.body?.title,
    category: req.body?.category,
    editorNote: req.body?.editorNote,
    lifecyclePinned: req.body?.lifecyclePinned,
  });
  if (!updated) return res.status(404).json({ error: "Product not found." });
  res.json({ ok: true, product: updated });
});

app.get("/api/admin/visitors", requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, visitors: getVisitorAnalytics() });
});

app.get("/api/admin/marketing", requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    marketing: getMarketingAnalytics({ days: req.query?.days || 30 }),
    commissions: getCommissionAnalytics({ days: req.query?.commissionDays || 90 }),
  });
});

app.post(
  "/api/admin/commissions/import",
  requireAdmin,
  express.text({ type: ["text/csv", "text/plain"], limit: "2mb" }),
  (req, res) => {
    const result = importCommissionCsv(req.body, {
      defaultNetwork: req.query?.network || "",
    });
    res.json({
      ok: true,
      result,
      commissions: getCommissionAnalytics({ days: 90 }),
    });
  }
);

app.post("/api/admin/analytics/reset-clicks", requireAdmin, (req, res) => {
  const result = resetClickAnalytics();
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, analytics: result });
});

app.post("/api/admin/products/:id/approve", requireAdmin, (req, res) => {
  const product = setApproved(Number(req.params.id), true);
  if (!product) return res.status(404).json({ error: "Product not found." });
  res.json({ ok: true, product });
});

app.post("/api/admin/products/:id/hide", requireAdmin, (req, res) => {
  const product = setApproved(Number(req.params.id), false);
  if (!product) return res.status(404).json({ error: "Product not found." });
  res.json({ ok: true, product });
});

app.post("/api/admin/products/:id/lifecycle/pin", requireAdmin, (req, res) => {
  const pinned = req.body?.pinned == null
    ? true
    : Boolean(req.body.pinned);

  const product = setProductLifecyclePinned(
    Number(req.params.id),
    pinned
  );

  if (!product) {
    return res.status(404).json({ error: "Product not found." });
  }

  res.json({
    ok: true,
    product,
    pinned: product.lifecyclePinned,
  });
});


app.delete("/api/admin/products/:id", requireAdmin, (req, res) => {
  const removed = deleteProduct(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: "Product not found." });
  res.json({ ok: true });
});

app.post("/api/admin/products/:id/enrich", requireAdmin, asyncRoute(async (req, res) => {
  const product = getProduct(Number(req.params.id), false);
  if (!product) return res.status(404).json({ error: "Product not found." });
  const enrichment = await enrichProductWithAI(product);
  const updated = updateProduct(product.id, {
    category: enrichment.category,
    aiSummary: enrichment.summary,
    tags: enrichment.tags,
  });
  res.json({ ok: true, product: updated });
}));

app.post("/api/admin/ebay/prices/verify", requireAdmin, asyncRoute(async (req, res) => {
  const limit = Math.min(
    Math.max(
      Number(req.body?.limit || process.env.EBAY_PRICE_VERIFY_OFFERS_PER_RUN || 320),
      1
    ),
    1000
  );

  const result = await runEbayPriceVerification({ limit, priority: "interactive" });
  res.json({ ok: true, result });
}));

app.post("/api/admin/catalog/integrity", requireAdmin, (req, res) => {
  const result = runCatalogIntegrityRepair({
    reason: "admin-manual",
    makeBackup: false,
  });

  res.json({
    ok: true,
    result,
    integrity: getDataIntegrityStats(),
  });
});

app.post("/api/admin/catalog/lifecycle", requireAdmin, (req, res) => {
  const result = runProductLifecycleCycle({
    reason: "admin-manual",
    archiveEligible: req.body?.archiveEligible !== false,
    makeBackup: true,
  });

  res.json({
    ok: true,
    result,
    lifecycle: getProductLifecycleStatus(),
  });
});

app.post("/api/admin/catalog/history/compress", requireAdmin, (req, res) => {
  const result = compressPriceHistory({ force: true });
  res.json({ ok: true, result });
});


app.post("/api/admin/ebay/competitors/cleanup", requireAdmin, (req, res) => {
  const result = runCompetitorIntegrityCleanup("admin-manual");
  res.json({ ok: true, result });
});

app.post("/api/admin/ebay/competitors/sanitize", requireAdmin, asyncRoute(async (req, res) => {
  const requested = req.body?.maxCalls == null
    ? null
    : Math.min(Math.max(Number(req.body.maxCalls) || 1, 1), 100);
  const result = await runEbayCompetitorSanitizer({
    priority: "interactive",
    maxCalls: requested,
  });
  res.json({ ok: true, result });
}));

app.post("/api/admin/ebay/competitors/run", requireAdmin, asyncRoute(async (req, res) => {
  const limit = Math.min(
    Math.max(Number(req.body?.limit || process.env.EBAY_COMPETITOR_PRODUCTS_PER_RUN || 40), 1),
    250
  );
  const result = await runEbayCompetitorScan({ limit, priority: "interactive" });
  res.json({ ok: true, result });
}));

app.post("/api/admin/rules", requireAdmin, (req, res) => {
  const rule = createDiscoveryRule(req.body || {});
  res.json({ ok: true, rule });
});

app.patch("/api/admin/rules/:id", requireAdmin, (req, res) => {
  const rule = updateDiscoveryRule(Number(req.params.id), req.body || {});
  if (!rule) return res.status(404).json({ error: "Rule not found." });
  res.json({ ok: true, rule });
});

app.delete("/api/admin/rules/:id", requireAdmin, (req, res) => {
  if (!deleteDiscoveryRule(Number(req.params.id))) return res.status(404).json({ error: "Rule not found." });
  res.json({ ok: true });
});


function maybeExpandStalledEbaySearch(rule, result, { deferPersistence = false } = {}) {
  if (
    rule.provider !== "ebay" ||
    Number(result?.productsCreated || 0) > 0
  ) {
    return [];
  }

  if (countCatalogProducts() >= CATALOG_TARGET_PRODUCTS) {
    return [];
  }

  const allRules = getDiscoveryRules();
  if (allRules.length >= DISCOVERY_MAX_RULES) {
    return [];
  }

  const depth = Math.max(0, Number(rule.generationDepth || 0));
  if (depth >= DISCOVERY_MAX_GENERATION_DEPTH) {
    return [];
  }

  const room = Math.max(0, DISCOVERY_MAX_RULES - allRules.length);
  const requested = Math.min(DISCOVERY_EXPANSIONS_PER_STALLED_RULE, room);
  if (!requested) return [];

  const suggestions = generateRelatedSearches({
    query: rule.query,
    category: rule.categoryOverride || "",
    familyKey: rule.familyKey || "",
    existingQueries: allRules
      .filter(item => item.provider === "ebay")
      .map(item => item.query),
    limit: requested,
  });

  const created = [];
  for (const suggestion of suggestions) {
    if (getDiscoveryRules().some(item =>
      item.provider === "ebay" &&
      String(item.query || "").trim().toLowerCase() ===
        String(suggestion.query || "").trim().toLowerCase()
    )) {
      continue;
    }

    const child = createDiscoveryRule({
      name: `Auto · ${suggestion.category} · ${suggestion.query}`,
      provider: "ebay",
      query: suggestion.query,
      categoryOverride: suggestion.category,
      limit: Math.min(
        Math.max(Number(process.env.DISCOVERY_RESULTS_PER_RULE || 50), 10),
        100
      ),
      enabled: true,
      autoApprove: rule.autoApprove,
      starter: false,
      generated: true,
      parentRuleId: rule.id,
      generationDepth: depth + 1,
      familyKey: suggestion.familyKey || "",
      minScore: rule.minScore,
      minHeat: rule.minHeat,
      minDiscount: rule.minDiscount,
      minCommissionRate: rule.minCommissionRate,
    }, { deferPersistence });

    created.push(child);
    if (created.length >= requested) break;
  }

  if (created.length) {
    markRuleExpanded(rule.id, created.length, { deferPersistence });
    console.log(
      `[search-growth] rule ${rule.id} created no new products; ` +
      `added ${created.length} related searches: ` +
      created.map(item => `"${item.query}"`).join(", ")
    );
  }

  return created;
}

let discoveryMutationChain = Promise.resolve();

function runBackgroundDiscoveryMutation(label, fn) {
  const execute = async () => {
    // Force a macrotask boundary between completed I/O lanes before each
    // synchronous catalog mutation. This prevents several ~1s ingestion phases
    // from running back-to-back and starving timers/HTTP requests for seconds.
    await new Promise(resolve => setImmediate(resolve));
    await backgroundCheckpoint(label);
    const startedAt = Date.now();
    const value = fn();
    const durationMs = Date.now() - startedAt;
    if (durationMs >= Math.max(Number(process.env.BACKGROUND_MUTATION_WARN_MS || 750), 250)) {
      opWarn("background-mutation", "discovery mutation occupied the main thread", {
        label,
        durationMs,
      });
    }
    await new Promise(resolve => setImmediate(resolve));
    return value;
  };

  const next = discoveryMutationChain.then(execute, execute);
  discoveryMutationChain = next.catch(() => {});
  return next;
}

async function executeRule(rule, { priority = "background", skipEbay = false } = {}) {
  const started = Date.now();
  opLog("discovery-rule", `starting rule ${rule.id}`, {
    provider: rule.provider,
    query: rule.query || null,
    limit: rule.limit,
    category: rule.categoryOverride || null,
  });

  let candidates;
  let marketplaceMeta = null;
  if (rule.provider === "ebay") {
    const query = String(rule.query || "").trim();

    if (!query) {
      const error = new Error(
        `eBay discovery rule ${rule.id} is missing a usable search query; skipped before API call.`
      );
      error.code = "EBAY_INVALID_SEARCH";
      throw error;
    }

    if (isExplicitSearchQuery(query)) {
      const error = new Error("Explicit discovery queries are not permitted in OfferGrid.");
      error.code = "EXPLICIT_SEARCH_BLOCKED";
      error.status = 400;
      throw error;
    }

    const marketplace = await searchEbayAndRakuten(query, rule.limit, {
      priority,
      skipEbay,
    });
    marketplaceMeta = marketplace;
    if (skipEbay && !marketplace.rakutenConfigured) {
      const error = new Error("eBay discovery was quota-deferred and Rakuten Product Search is not configured.");
      error.code = "EBAY_RATE_LOCAL_BUDGET";
      error.rateGuardDeferred = true;
      throw error;
    }
    if (marketplace.ebayError && !marketplace.rakutenCandidates.length) {
      throw marketplace.ebayError;
    }
    candidates = marketplace.candidates;
    candidates = candidates.filter(candidate =>
      !isExplicitProduct(candidate) &&
      searchRelevance(query, {
        title: candidate.title,
        listingTitle: candidate.listingTitle,
        brand: candidate.brand,
        // Judge relevance from the marketplace record itself. A configured
        // OfferGrid category override is applied only after the candidate has
        // passed, so category metadata cannot create a false-positive match.
        category: candidate.category,
        searchText: `${candidate.title || ""} ${candidate.brand || ""} ${candidate.category || ""}`,
      }).relevant
    );
    if (rule.categoryOverride) {
      candidates = candidates.map(candidate => ({
        ...candidate,
        category: rule.categoryOverride,
      }));
    }
  } else if (rule.provider === "awin") {
    if (!rule.advertiserId) throw new Error("Awin rule is missing an advertiser ID.");
    candidates = await fetchAwinFeed(rule.advertiserId, rule.locale || "en_US", rule.limit);
  } else {
    throw new Error(`Unsupported rule provider: ${rule.provider}`);
  }

  const mutate = () => {
    const deferPersistence = priority === "background";
    const ingestResult = ingestCandidates(candidates, { deferPersistence });
    const approvedIds = autoApproveFromRule(ingestResult.touchedProductIds, rule, {
      deferPersistence,
    });
    const result = {
      received: candidates.length,
      productsTouched: ingestResult.productsTouched,
      productsCreated: ingestResult.productsCreated,
      offersCreated: ingestResult.offersCreated,
      offersUpdated: ingestResult.offersUpdated,
      autoApproved: approvedIds.length,
      providers: marketplaceMeta
        ? {
            ebay: marketplaceMeta.ebayCandidates.length,
            rakuten: marketplaceMeta.rakutenCandidates.length,
          }
        : undefined,
      providerFailures: marketplaceMeta?.failures || [],
      ebayDeferred: Boolean(skipEbay || marketplaceMeta?.ebayError),
    };
    markRuleRun(rule.id, { result, deferPersistence });
    const expandedRules = maybeExpandStalledEbaySearch(rule, result, { deferPersistence });
    return { result, expandedRules };
  };

  const mutation = priority === "background"
    ? await runBackgroundDiscoveryMutation(`discovery-ingest:${rule.id}`, mutate)
    : mutate();
  const { result, expandedRules } = mutation;

  opLog("discovery-rule", `finished rule ${rule.id} in ${Date.now() - started}ms`, result);

  if (expandedRules.length) {
    result.relatedSearchesAdded = expandedRules.map(item => ({
      id: item.id,
      query: item.query,
      category: item.categoryOverride,
      familyKey: item.familyKey,
    }));
  }

  return result;
}

app.post("/api/admin/rules/:id/run", requireAdmin, asyncRoute(async (req, res) => {
  const rule = getDiscoveryRules().find(r => r.id === Number(req.params.id));
  if (!rule) return res.status(404).json({ error: "Rule not found." });
  try {
    const result = await executeRule(rule, { priority: "interactive" });
    res.json({ ok: true, result });
  } catch (error) {
    markRuleRun(rule.id, { error: cleanError(error) });
    throw error;
  }
}));

app.post("/api/admin/rules/run-all", requireAdmin, asyncRoute(async (req, res) => {
  const results = [];
  for (const rule of getDiscoveryRules().filter(r => r.enabled)) {
    try {
      results.push({ id: rule.id, ok: true, result: await executeRule(rule, { priority: "interactive" }) });
    } catch (error) {
      if (isEbayRateGuardError(error)) {
        results.push({
          id: rule.id,
          ok: false,
          deferred: true,
          error: cleanError(error),
        });
        continue;
      }

      markRuleRun(rule.id, { error: cleanError(error) });
      results.push({ id: rule.id, ok: false, error: cleanError(error) });
    }
  }
  markMissingOffers(Number(process.env.STALE_OFFER_DAYS || 7));
  res.json({ ok: true, results });
}));

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /admin.html",
      "Disallow: /api/admin/",
      `Sitemap: ${SITE_BASE_URL}/sitemap.xml`,
      "",
    ].join("\n")
  );
});

app.get("/.well-known/security.txt", (req, res) => {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  res.type("text/plain").send(
    [
      `Contact: mailto:${CONTACT_EMAIL}`,
      `Canonical: ${SITE_BASE_URL}/.well-known/security.txt`,
      `Expires: ${expires}`,
      "",
    ].join("\n")
  );
});

app.get("/sitemap.xml", (req, res) => {
  const products = listPublicProducts({ limit: 5000 });
  const urls = [
    `${SITE_BASE_URL}/`,
    `${SITE_BASE_URL}/trending.html`,
    `${SITE_BASE_URL}/disclosure.html`,
    `${SITE_BASE_URL}/methodology.html`,
    `${SITE_BASE_URL}/privacy.html`,
    `${SITE_BASE_URL}/terms.html`,
    ...products.map(p => `${SITE_BASE_URL}/product.html?id=${p.id}`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(url => `  <url><loc>${escapeXml(url)}</loc></url>`).join("\n") +
    `\n</urlset>`;
  res.type("application/xml").send(xml);
});

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function seedInitialRules() {
  const ebayQueries = String(process.env.EBAY_DISCOVERY_QUERIES || "")
    .split("|").map(v => v.trim()).filter(Boolean);
  const awinFeeds = String(process.env.AWIN_DISCOVERY_FEEDS || "")
    .split(",").map(v => v.trim()).filter(Boolean);

  for (const query of ebayQueries) {
    if (getDiscoveryRules().some(rule =>
      rule.provider === "ebay" &&
      String(rule.query || "").toLowerCase() === query.toLowerCase()
    )) continue;

    createDiscoveryRule({
      name: `eBay: ${query}`,
      provider: "ebay",
      query,
      limit: 50,
      enabled: true,
      autoApprove: false,
      starter: false
    });
  }

  for (const item of awinFeeds) {
    const [advertiserId, locale = "en_US"] = item.split(":");
    if (!advertiserId?.trim()) continue;

    if (getDiscoveryRules().some(rule =>
      rule.provider === "awin" &&
      String(rule.advertiserId || "") === advertiserId.trim()
    )) continue;

    createDiscoveryRule({
      name: `Awin: ${advertiserId.trim()}`,
      provider: "awin",
      advertiserId: advertiserId.trim(),
      locale: locale.trim(),
      limit: 500,
      enabled: true,
      autoApprove: false,
      starter: false
    });
  }

  const pack = installDiscoverySearchPack(
    STARTER_EBAY_SEARCHES,
    28,
    {
      limit: STARTER_PRODUCTS_PER_QUERY,
      enabled: true,
      autoApprove: STARTER_AUTO_PUBLISH,
      minScore: 55,
      minHeat: 0,
      minDiscount: 0,
      minCommissionRate: 0,
    }
  );

  if (pack.installed || pack.updated) {
    console.log(
      `[discovery] search pack v${pack.version}: ${pack.installed} added, ` +
      `${pack.updated} upgraded, ${pack.skipped} already present`
    );
  }
}

function startStarterPopulate() {
  if (!STARTER_POPULATE_ON_BOOT) return;
  if (countPublicProducts() > 0) return;

  if (!getConfigValue("EBAY_CLIENT_ID", "") || !getConfigValue("EBAY_CLIENT_SECRET", "")) {
    console.log("[starter] catalog is empty; add eBay API credentials, then use Admin → Populate starter store.");
    return;
  }

  setTimeout(async () => {
    try {
      console.log("[starter] empty store detected — importing real products from eBay...");
      const result = await populateStarterStore({ autoPublish: STARTER_AUTO_PUBLISH });
      console.log("[starter] population complete:", result);
    } catch (error) {
      console.error("[starter] population failed:", cleanError(error));
    }
  }, 2_500);
}

async function mapConcurrent(values, concurrency, fn) {
  const results = new Array(values.length);
  let cursor = 0;

  async function lane(laneIndex) {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index, laneIndex);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(Number(concurrency || 1), 1), Math.max(values.length, 1)) },
      (_, index) => lane(index)
    )
  );

  return results;
}

let autoSyncRunning = false;
let competitorScanRunning = false;

async function runAutoSync() {
  if (autoSyncRunning) {
    console.log("[auto-sync] previous discovery cycle is still running; skipping overlap");
    return;
  }

  autoSyncRunning = true;
  try {
    await backgroundCheckpoint("auto-sync:cycle-start");
    const beforeCount = countCatalogProducts();
    const selectedRules = getDiscoveryRulesForCycle(DISCOVERY_RULES_PER_CYCLE);
    const rateGuardBefore = getEbayRateGuardStatus();
    const browseBackgroundRemaining =
      Number(rateGuardBefore?.browse?.backgroundRemaining || 0);

    const discoveryBrowseBudget = rateGuardBefore.enabled
      ? recommendedEbayBackgroundCallBudget("browse", {
          intervalMinutes: Math.max(Number(process.env.AUTO_SYNC_MINUTES || 20), 15),
          share: Math.min(
            Math.max(Number(process.env.EBAY_DISCOVERY_QUOTA_SHARE || 0.30), 0.05),
            0.90
          ),
          maxCalls: Math.min(
            Math.max(Number(process.env.EBAY_DISCOVERY_MAX_CALLS_PER_CYCLE || DISCOVERY_RULES_PER_CYCLE), 1),
            DISCOVERY_RULES_PER_CYCLE
          ),
          minCalls: 1,
        })
      : Number.POSITIVE_INFINITY;

    let ebaySlots = rateGuardBefore.enabled
      ? Math.min(browseBackgroundRemaining, discoveryBrowseBudget)
      : Number.POSITIVE_INFINITY;

    const workItems = [];
    let ebayDeferredBeforeStart = 0;
    const discoveryIntervalMinutes = Math.max(Number(process.env.AUTO_SYNC_MINUTES || 20), 15);
    const discoveryCycleKey = Math.floor(Date.now() / (discoveryIntervalMinutes * 60_000));

    for (const rule of selectedRules) {
      if (rule.provider !== "ebay") {
        workItems.push({ rule, skipEbay: false });
        continue;
      }

      if (ebaySlots > 0) {
        workItems.push({ rule, skipEbay: false });
        ebaySlots--;
      } else {
        // Preserve eBay's interactive reserve without suppressing the Rakuten
        // mirror. The rule still runs; only the eBay half is skipped. Record
        // the call that would have been made so quota-growth telemetry does not
        // flatline while the rate guard is doing its job.
        noteEbayDeferredDemand("browse.search", "browse", {
          units: Math.min(Math.max(Number(rule.limit || 50), 1), 200),
          capacity: 200,
          demandKey: `auto-sync|cycle:${discoveryCycleKey}|rule:${rule.id}|${String(rule.query || "").trim().toLowerCase()}`,
          priority: "background",
          reason: "discovery-quota-reserve",
        });
        workItems.push({ rule, skipEbay: true });
        ebayDeferredBeforeStart++;
      }
    }

    console.log(
      `[auto-sync] 20-minute growth cycle: ${workItems.length}/${selectedRules.length} rules runnable, ` +
      `${beforeCount}/${CATALOG_TARGET_PRODUCTS} catalog products`
    );

    if (ebayDeferredBeforeStart) {
      opLog(
        "auto-sync",
        `${ebayDeferredBeforeStart} eBay discovery side(s) deferred to preserve API reserve; Rakuten mirrors remain runnable`,
        {
          browseUsedLast24h: rateGuardBefore.browse.usedLast24h,
          backgroundRemaining: browseBackgroundRemaining,
          softLimitMode: rateGuardBefore.browse.softLimitMode,
          discoveryCallBudget: discoveryBrowseBudget,
          interactiveRemaining: rateGuardBefore.browse.interactiveRemaining,
        }
      );
    }

    const discoveryConcurrency = Math.min(
      Math.max(Number(process.env.DISCOVERY_IO_CONCURRENCY || 4), 1),
      8
    );

    opLog("auto-sync", `dispatching ${workItems.length} rules across ${discoveryConcurrency} I/O lanes`);

    const cycleResults = await mapConcurrent(
      workItems,
      discoveryConcurrency,
      async (workItem, index, laneIndex) => {
        const { rule, skipEbay } = workItem;
        try {
          opLog("auto-sync", `lane ${laneIndex + 1} running ${index + 1}/${workItems.length}`, {
            ruleId: rule.id,
            query: rule.query || null,
            ebayDeferred: skipEbay,
          });

          await backgroundCheckpoint(`auto-sync:rule:${rule.id}`);
          const result = await executeRule(rule, { priority: "background", skipEbay });
          return { ok: true, rule, result, ebayDeferred: skipEbay };
        } catch (error) {
          if (isEbayRateGuardError(error)) {
            opLog("auto-sync", `rule ${rule.id} deferred by eBay rate guard`, {
              query: rule.query || null,
              retryAt: error.retryAt
                ? new Date(error.retryAt).toISOString()
                : null,
            });
            return {
              ok: false,
              deferred: true,
              rule,
              error: cleanError(error),
            };
          }

          markRuleRun(rule.id, {
            error: cleanError(error),
            deferPersistence: true,
          });
          opWarn("auto-sync", `rule ${rule.id} failed`, cleanError(error));
          return { ok: false, rule, error: cleanError(error) };
        }
      }
    );

    let createdThisCycle = 0;
    let expansionsThisCycle = 0;
    let deferredThisCycle = 0;
    let ebayDeferredThisCycle = ebayDeferredBeforeStart;

    for (const item of cycleResults) {
      if (item?.deferred) {
        deferredThisCycle++;
        continue;
      }
      if (!item?.ok) continue;
      createdThisCycle += Number(item.result.productsCreated || 0);
      expansionsThisCycle += Array.isArray(item.result.relatedSearchesAdded)
        ? item.result.relatedSearchesAdded.length
        : 0;
    }

    const stale = markMissingOffers(Number(process.env.STALE_OFFER_DAYS || 7));
    if (stale) console.log(`[auto-sync] marked ${stale} stale offers out of stock`);

    console.log(
      `[auto-sync] cycle complete: +${createdThisCycle} products, ` +
      `+${expansionsThisCycle} related searches, ` +
      `${deferredThisCycle} fully rate-deferred, ${ebayDeferredThisCycle} eBay-side deferred, ` +
      `${countCatalogProducts()}/${CATALOG_TARGET_PRODUCTS} catalog products`
    );
  } finally {
    autoSyncRunning = false;
  }
}

function startAutoSync() {
  const enabled = String(process.env.AUTO_SYNC_ENABLED || "true").toLowerCase() === "true";
  if (!enabled) {
    console.log("[auto-sync] disabled by AUTO_SYNC_ENABLED=false");
    return;
  }

  const minutes = Math.max(Number(process.env.AUTO_SYNC_MINUTES || 20), 15);
  const firstDelay = countPublicProducts() > 0 ? 30_000 : 120_000;

  console.log(
    `[auto-sync] autonomous growth enabled every ${minutes} minutes; ` +
    `${DISCOVERY_RULES_PER_CYCLE} rotating rules/cycle; catalog target ${CATALOG_TARGET_PRODUCTS}`
  );

  setTimeout(() => runAutoSync().catch(console.error), firstDelay);
  setInterval(() => runAutoSync().catch(console.error), minutes * 60_000);
}

function startRakutenCatalogScheduler() {
  const tick = () => {
    const status = getRakutenCatalogStatus();
    if (!status.enabled || !status.configured || status.runtime?.running) return;

    const minutes = Math.max(5, Number(status.syncMinutes || 30));
    const lastAttempt = Date.parse(status.state?.lastAttemptAt || "") || 0;
    if (lastAttempt && Date.now() - lastAttempt < minutes * 60_000) return;

    startRakutenCatalogSync({ mode: "auto", priority: "background" });
  };

  const initialStatus = getRakutenCatalogStatus();
  if (initialStatus.enabled) {
    console.log(
      `[rakuten-catalog] scheduler armed · ${Number(initialStatus.syncMinutes || 30)}m delta cadence · ` +
      `${Number(initialStatus.fullRefreshHours || 24)}h full refresh · ` +
      `${initialStatus.configured ? "SFTP configured" : "waiting for SFTP credentials"}`
    );
  } else {
    console.log("[rakuten-catalog] disabled by RAKUTEN_CATALOG_SYNC_ENABLED=false");
  }

  // Never delay HTTP startup for a bulk feed. The first catalog check runs in
  // the background and cooperatively yields to foreground shopper traffic.
  setTimeout(tick, 45_000);
  setInterval(tick, 60_000);
}

async function runCompetitorScanCycle() {
  if (competitorScanRunning) {
    console.log("[ebay-competitors] previous cycle is still running; skipping overlap");
    return;
  }

  competitorScanRunning = true;
  try {
    await backgroundCheckpoint("ebay-competitors:cycle-start");
    const configuredLimit = Math.min(
      Math.max(Number(process.env.EBAY_COMPETITOR_PRODUCTS_PER_RUN || 40), 1),
      250
    );
    const sanitizerStatus = getEbayCompetitorSanitizerStatus();
    setEbayGetItemFallbackIdentityBacklog(sanitizerStatus.pending);
    const bulkCapability = getEbayBulkGetItemsCapabilityStatus();
    const verificationPressure = getEbayAdaptiveVerificationPolicy(sanitizerStatus.pending);
    const fallbackPressureActive =
      bulkCapability.state === "denied" && verificationPressure.mode !== "normal";
    const discoveryScale = fallbackPressureActive
      ? Number(verificationPressure.discoveryScale || 0)
      : 1;
    const effectiveConfiguredLimit = discoveryScale <= 0
      ? 0
      : Math.min(
          configuredLimit,
          Math.max(1, Math.floor(configuredLimit * discoveryScale))
        );

    if (effectiveConfiguredLimit <= 0) {
      opLog("ebay-competitors", "competitor discovery paused for verification catch-up", {
        adaptiveMode: verificationPressure.mode,
        pending: sanitizerStatus.pending,
        configuredLimit,
        discoveryScale,
      });
      return;
    }

    if (effectiveConfiguredLimit < configuredLimit) {
      opLog("ebay-competitors", "competitor discovery throttled for verification catch-up", {
        adaptiveMode: verificationPressure.mode,
        pending: sanitizerStatus.pending,
        configuredLimit,
        effectiveLimit: effectiveConfiguredLimit,
        discoveryScale,
        fallbackWindowBudget: Number(bulkCapability.fallbackWindowBudget || 0),
      });
    }

    const browseCallBudget = recommendedEbayBackgroundCallBudget("browse", {
      intervalMinutes: Math.max(Number(process.env.EBAY_COMPETITOR_SCHEDULER_MINUTES || 10), 5),
      share: Math.min(
        Math.max(Number(process.env.EBAY_COMPETITOR_DISCOVERY_QUOTA_SHARE || 0.55), 0.05),
        0.90
      ),
      maxCalls: effectiveConfiguredLimit,
      minCalls: 1,
    });
    if (browseCallBudget <= 0) {
      const intervalMinutes = Math.max(Number(process.env.EBAY_COMPETITOR_SCHEDULER_MINUTES || 10), 5);
      const cycleKey = Math.floor(Date.now() / (intervalMinutes * 60_000));
      const legacyResultLimit = Math.max(
        Number(process.env.EBAY_COMPETITOR_RESULTS_PER_PRODUCT || 50),
        1
      );
      const resultLimit = Math.min(
        Math.max(
          Number(
            process.env.EBAY_COMPETITOR_DISCOVERY_RESULTS_PER_PRODUCT ||
            Math.max(legacyResultLimit, 100)
          ),
          1
        ),
        200
      );
      for (let index = 0; index < effectiveConfiguredLimit; index++) {
        noteEbayDeferredDemand("browse.search", "browse", {
          units: resultLimit,
          capacity: 200,
          demandKey: `competitor-cycle|${cycleKey}|slot:${index}`,
          priority: "background",
          reason: "competitor-scan-quota-reserve",
        });
      }
      console.log(
        `[ebay-competitors] cycle deferred; Browse background quota is reserved or cooling down; ` +
        `${effectiveConfiguredLimit} conservative search-call demand slot(s) recorded`
      );
      return;
    }

    const limit = Math.min(effectiveConfiguredLimit, browseCallBudget);
    const result = await runEbayCompetitorScan({ limit });
    console.log("[ebay-competitors] cycle complete:", result);
  } finally {
    competitorScanRunning = false;
  }
}

function startEbayCompetitorScanner() {
  const enabled =
    String(process.env.EBAY_COMPETITOR_SCAN_ENABLED || "true").toLowerCase() === "true";

  if (!enabled) {
    console.log("[ebay-competitors] disabled by EBAY_COMPETITOR_SCAN_ENABLED=false");
    return;
  }

  const minutes = Math.max(Number(process.env.EBAY_COMPETITOR_SCHEDULER_MINUTES || 10), 5);
  const batch = Math.min(
    Math.max(Number(process.env.EBAY_COMPETITOR_PRODUCTS_PER_RUN || 40), 1),
    250
  );
  const firstDelay = countPublicProducts() > 0 ? 45_000 : 240_000;

  console.log(
    `[ebay-competitors] discovery scheduler every ${minutes} minutes; ` +
    `rotating through up to ${batch} published products per pass; ` +
    `per-product rescan floor ${Math.max(Number(process.env.EBAY_COMPETITOR_SCAN_MINUTES || 60), 15)} minutes`
  );

  setTimeout(() => runCompetitorScanCycle().catch(console.error), firstDelay);
  setInterval(
    () => runCompetitorScanCycle().catch(console.error),
    minutes * 60_000
  );
}


let competitorSanitizerRunning = false;

async function runCompetitorSanitizerCycle() {
  if (competitorSanitizerRunning) {
    console.log("[competitor-sanitizer] previous cycle still running; skipping overlap");
    return;
  }

  competitorSanitizerRunning = true;
  try {
    await backgroundCheckpoint("competitor-sanitizer:cycle-start");
    const result = await runEbayCompetitorSanitizer({ priority: "background" });
    console.log("[competitor-sanitizer] cycle complete:", result);
  } finally {
    competitorSanitizerRunning = false;
  }
}

function startEbayCompetitorSanitizer() {
  const enabled =
    String(process.env.EBAY_COMPETITOR_SANITIZER_ENABLED || "true").toLowerCase() === "true";
  if (!enabled) {
    console.log("[competitor-sanitizer] disabled by EBAY_COMPETITOR_SANITIZER_ENABLED=false");
    return;
  }

  const minutes = Math.max(Number(process.env.EBAY_COMPETITOR_SANITIZER_MINUTES || 5), 2);
  console.log(
    `[competitor-sanitizer] exact competitor re-verification every ${minutes} minutes; ` +
    `bulk getItems when entitled, otherwise quota-aware individual getItem fallback`
  );

  // Give the startup Developer Analytics sync and first price verification a
  // chance to establish current quota state before draining the cleanup queue.
  setTimeout(() => runCompetitorSanitizerCycle().catch(console.error), 15_000);
  setInterval(
    () => runCompetitorSanitizerCycle().catch(console.error),
    minutes * 60_000
  );
}

let ebayPriceVerificationRunning = false;

async function runPriceVerificationCycle() {
  if (ebayPriceVerificationRunning) {
    console.log("[price-verify] previous cycle still running; skipping overlap");
    return;
  }

  ebayPriceVerificationRunning = true;
  opLog("price-verify", "scheduled verification cycle starting");

  try {
    await backgroundCheckpoint("price-verify:cycle-start");
    const result = await runEbayPriceVerification();
    console.log("[price-verify] cycle complete:", result);
  } finally {
    ebayPriceVerificationRunning = false;
  }
}

async function runStartupVerificationBurst() {
  const runs = Math.min(
    Math.max(Number(process.env.EBAY_STARTUP_VERIFY_BURST_RUNS || 5), 0),
    12
  );
  const delayMs = Math.max(
    Number(process.env.EBAY_STARTUP_VERIFY_BURST_DELAY_MS || 8000),
    2000
  );

  if (!runs) return;

  opLog("price-verify", `startup recovery burst armed for up to ${runs} pass(es)`);

  for (let run = 1; run <= runs; run++) {
    const backlog = getEbayVerificationBacklogStatus();
    const competitorBacklog = getEbayCompetitorSanitizerStatus();
    setEbayGetItemFallbackIdentityBacklog(competitorBacklog.pending);
    const rateGuard = getEbayRateGuardStatus();
    const capability = getEbayBulkGetItemsCapabilityStatus();

    if (
      rateGuard.enabled &&
      capability.state !== "denied" &&
      Number(rateGuard?.getItems?.backgroundRemaining || 0) <= 0
    ) {
      opLog(
        "price-verify",
        "startup recovery burst stopped to preserve interactive getItems reserve",
        {
          usedLast24h: rateGuard.getItems.usedLast24h,
          interactiveRemaining: rateGuard.getItems.interactiveRemaining,
        }
      );
      return;
    }

    if (
      capability.state === "denied" &&
      Number(capability.fallbackPriceWindowRemaining || 0) <= 0
    ) {
      opLog(
        "price-verify",
        "startup price recovery burst paused; Browse fallback reserve is protected for competitor identity verification",
        {
          fallbackPriceRemaining: Number(capability.fallbackPriceWindowRemaining || 0),
          fallbackIdentityRemaining: Number(capability.fallbackIdentityWindowRemaining || 0),
        }
      );
      return;
    }

    if (
      Number(backlog.unverifiedPublicEbayOffers || 0) === 0 &&
      run > 1
    ) {
      opLog("price-verify", "startup recovery burst finished early; all public eBay offers are verified");
      return;
    }

    opLog("price-verify", `startup recovery pass ${run}/${runs}`, {
      unverifiedPublic: backlog.unverifiedPublicEbayOffers,
      exactDetailTransport: capability.state === "denied" ? "getItem-fallback" : "getItems",
    });

    await runPriceVerificationCycle();

    if (run < runs) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

let ebayQuotaSyncRunning = false;

async function runEbayQuotaSync(reason = "scheduled") {
  if (ebayQuotaSyncRunning) return null;
  ebayQuotaSyncRunning = true;

  try {
    const result = await syncEbayApplicationRateLimits({
      force: reason === "startup" || reason === "remote-limit",
    });

    if (result?.ok) {
      opLog("ebay-analytics", `quota sync ${reason} complete`, {
        browseRemaining: result.browse?.remaining ?? null,
        browseResetAt: result.browse?.reset || null,
        getItemsRemaining: result.getItems?.remaining ?? null,
        getItemsResetAt: result.getItems?.reset || null,
      });
    } else if (!result?.skipped) {
      opWarn("ebay-analytics", `quota sync ${reason} did not return usable data`, result);
    }

    return result;
  } catch (error) {
    opWarn("ebay-analytics", `quota sync ${reason} failed`, cleanError(error));
    return null;
  } finally {
    ebayQuotaSyncRunning = false;
  }
}

function startEbayQuotaSync() {
  const enabled =
    String(process.env.EBAY_ANALYTICS_SYNC_ENABLED || "true").toLowerCase() === "true";

  if (!enabled) {
    console.log("[ebay-analytics] authoritative quota sync disabled");
    return;
  }

  const minutes = Math.max(
    Number(process.env.EBAY_ANALYTICS_SYNC_MINUTES || 30),
    10
  );

  console.log(
    `[ebay-analytics] authoritative eBay quota sync every ${minutes} minutes`
  );

  // Starter population begins after 2.5s and verification after 5s, so sync
  // first and let the rate guard know the real remote budget before they run.
  setTimeout(
    () => runEbayQuotaSync("startup").catch(console.error),
    350
  );

  setInterval(
    () => runEbayQuotaSync("scheduled").catch(console.error),
    minutes * 60_000
  );
}

function startEbayPriceVerifier() {
  const enabled =
    String(process.env.EBAY_PRICE_VERIFY_ENABLED || "true").toLowerCase() === "true";

  if (!enabled) {
    console.log("[price-verify] disabled by EBAY_PRICE_VERIFY_ENABLED=false");
    return;
  }

  const minutes = Math.max(
    Number(process.env.EBAY_PRICE_VERIFY_MINUTES || 10),
    5
  );
  const batch = Math.min(
    Math.max(Number(process.env.EBAY_PRICE_VERIFY_OFFERS_PER_RUN || 320), 1),
    1000
  );

  const batchSize = Math.min(
    Math.max(Number(process.env.EBAY_PRICE_VERIFY_BATCH_SIZE || 20), 1),
    20
  );
  const concurrency = Math.min(
    Math.max(Number(process.env.EBAY_PRICE_VERIFY_CONCURRENCY || 4), 1),
    8
  );

  opLog(
    "price-verify",
    `exact eBay refresh every ${minutes} minutes`,
    {
      offersPerPass: batch,
      itemsPerApiCall: batchSize,
      concurrentIoLanes: concurrency,
    }
  );

  setTimeout(
    () => runStartupVerificationBurst().catch(console.error),
    5_000
  );

  setInterval(
    () => runPriceVerificationCycle().catch(console.error),
    minutes * 60_000
  );
}

function catalogIntegrityPhaseLabel(phase) {
  const labels = {
    "broad-trust-scan": "legacy eBay relationship scan",
    "broad-trust-rebuild": "isolated relationship rebuild",
    "catalog-integrity-normalize": "catalog identity normalization",
    "catalog-integrity-rescore": "catalog offer rescoring",
    "product-cache-lookup-index": "integrity product/offer lookup index",
    "price-signal-index": "integrity Price Signal history index",
    "price-signal-trust-scan": "integrity Price Signal offer trust scan",
    "price-signal-raw-history": "integrity Price Signal raw history",
    "price-signal-aggregates": "integrity Price Signal aggregates",
    "price-signal-compaction": "integrity Price Signal sparkline compaction",
    "product-cache-history-index": "integrity Deal Heat 30-day history index",
    "product-cache-rebuild": "integrity product intelligence cache rebuild",
  };
  return labels[String(phase || "")] || startupDbPhaseLabel(phase);
}

function createCatalogIntegrityProgressReporter(reason = "startup") {
  if (reason !== "startup") return null;
  return createStartupDbProgressReporter({
    prefix: "[catalog-integrity]",
    labelResolver: catalogIntegrityPhaseLabel,
  });
}

function productLifecyclePhaseLabel(phase) {
  const labels = {
    "lifecycle-price-compression": "lifecycle price-history compression",
    "price-compression-aggregates": "lifecycle retained aggregate rebucketing",
    "price-compression-raw-history": "lifecycle raw history compression",
    "lifecycle-lookup-index": "lifecycle evidence index",
    "lifecycle-classification": "lifecycle classification",
    "lifecycle-archive-prune": "lifecycle archive row cleanup",
    "product-cache-lookup-index": "lifecycle product/offer lookup index",
    "price-signal-index": "lifecycle Price Signal history index",
    "price-signal-trust-scan": "lifecycle eBay history trust scan",
    "price-signal-raw-history": "lifecycle Price Signal raw history",
    "price-signal-aggregates": "lifecycle Price Signal aggregates",
    "price-signal-compaction": "lifecycle Price Signal sparkline compaction",
    "product-cache-history-index": "lifecycle Deal Heat 30-day history index",
    "product-cache-rebuild": "lifecycle product intelligence cache rebuild",
  };
  return labels[String(phase || "")] || startupDbPhaseLabel(phase);
}

function createProductLifecycleProgressReporter(reason = "startup") {
  if (reason !== "startup") return null;
  return createStartupDbProgressReporter({
    prefix: "[product-lifecycle]",
    labelResolver: productLifecyclePhaseLabel,
  });
}

function runCatalogIntegrityCycle(reason = "scheduled") {
  const report = runCatalogIntegrityRepair({
    reason,
    makeBackup: reason === "startup",
    onProgress: createCatalogIntegrityProgressReporter(reason),
    deferPersistence: reason !== "admin-manual",
  });

  console.log("[catalog-integrity]", report);
  return report;
}

function runProductLifecycleMaintenance(reason = "scheduled") {
  const enabled =
    String(process.env.PRODUCT_LIFECYCLE_ENABLED || "true").toLowerCase() === "true";

  if (!enabled) {
    console.log(`[product-lifecycle] ${reason} maintenance skipped; lifecycle disabled`);
    return null;
  }

  const result = runProductLifecycleCycle({
    reason,
    archiveEligible: true,
    makeBackup: reason === "startup",
    onProgress: createProductLifecycleProgressReporter(reason),
    deferPersistence: reason !== "admin-manual",
  });

  console.log(
    `[product-lifecycle] ${reason}: ` +
    `active=${result.after.ACTIVE || 0}, ` +
    `dormant=${result.after.DORMANT || 0}, ` +
    `stale=${result.after.STALE || 0}, ` +
    `prunable=${result.after.PRUNABLE || 0}, ` +
    `archived=${result.after.ARCHIVED || 0}; ` +
    `${result.archived || 0} archived this pass; ` +
    `${result.compression?.rawPointsCompressed || 0} price observations compressed`
  );

  return result;
}

function startProductLifecycleScheduler() {
  const enabled =
    String(process.env.PRODUCT_LIFECYCLE_ENABLED || "true").toLowerCase() === "true";

  if (!enabled) {
    console.log("[product-lifecycle] disabled by PRODUCT_LIFECYCLE_ENABLED=false");
    return;
  }

  const hours = Math.max(
    Number(process.env.PRODUCT_LIFECYCLE_HOURS || 24),
    6
  );

  console.log(
    `[product-lifecycle] scheduled every ${hours} hours; ` +
    `dormant after ${Math.max(Number(process.env.PRODUCT_DORMANT_DAYS || 120), 90)}d, ` +
    `stale/prunable evaluation after ${Math.max(Number(process.env.PRODUCT_STALE_DAYS || 365), 365)}d`
  );

  setInterval(
    () => {
      waitForInteractiveIdle({
        reason: "product-lifecycle:scheduled",
        quietMs: Math.max(Number(process.env.HEAVY_BACKGROUND_QUIET_MS || 2000), 250),
      }).then(() => {
        try {
          runProductLifecycleMaintenance("scheduled");
        } catch (error) {
          console.error(
            "[product-lifecycle] scheduled maintenance failed:",
            cleanError(error)
          );
        }
      }).catch(console.error);
    },
    hours * 60 * 60 * 1000
  );
}

function startCatalogIntegrityScheduler() {
  const enabled =
    String(process.env.CATALOG_INTEGRITY_ENABLED || "true").toLowerCase() === "true";

  if (!enabled) {
    console.log("[catalog-integrity] periodic audit disabled");
    return;
  }

  const hours = Math.max(
    Number(process.env.CATALOG_INTEGRITY_HOURS || 6),
    1
  );

  console.log(`[catalog-integrity] scheduled every ${hours} hours`);

  setInterval(
    () => {
      waitForInteractiveIdle({
        reason: "catalog-integrity:scheduled",
        quietMs: Math.max(Number(process.env.HEAVY_BACKGROUND_QUIET_MS || 2000), 250),
      }).then(async () => {
        try {
          const versions = getCatalogIntegrityVersionStatus();
          if (
            Number(versions.integrityVersion || 0) < 313 ||
            Number(versions.priceAccuracyVersion || 0) < 4
          ) {
            runCatalogIntegrityCycle("scheduled-migration");
          } else {
            // Current catalogs receive bounded normalization instead of a
            // synchronous whole-catalog rebuild on the request thread.
            await runLocalDatabaseMaintenance("catalog-integrity-heartbeat");
            opLog("catalog-integrity", "scheduled full repair skipped; current catalog maintained incrementally");
          }
        } catch (error) {
          console.error(
            "[catalog-integrity] scheduled repair failed:",
            cleanError(error)
          );
        }
      }).catch(console.error);
    },
    hours * 60 * 60 * 1000
  );
}

function startEventLoopWatchdog() {
  const enabled =
    String(process.env.EVENT_LOOP_WATCHDOG_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) return;

  const intervalMs = Math.max(
    250,
    Number(process.env.EVENT_LOOP_WATCHDOG_INTERVAL_MS || 1000)
  );
  const warnMs = Math.max(
    250,
    Number(process.env.EVENT_LOOP_STALL_WARN_MS || 1000)
  );
  let expectedAt = Date.now() + intervalMs;

  const timer = setInterval(() => {
    const now = Date.now();
    const lagMs = Math.max(0, now - expectedAt);
    expectedAt = now + intervalMs;

    if (lagMs >= warnMs) {
      opWarn("event-loop", "Node event loop was blocked long enough to delay client work", {
        lagMs,
        thresholdMs: warnMs,
      });
    }
  }, intervalMs);

  timer.unref?.();
  console.log(`[event-loop] responsiveness watchdog armed · warning threshold ${warnMs}ms`);
}

function cleanupProgressEnabled() {
  return String(
    process.env.EBAY_COMPETITOR_CLEANUP_PROGRESS_ENABLED || "true"
  ).toLowerCase() !== "false";
}

function formatCleanupDuration(milliseconds) {
  const ms = Math.max(0, Number(milliseconds) || 0);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function cleanupProgressBar(current, total, width = 22) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeCurrent = Math.max(0, Number(current) || 0);
  if (!safeTotal) return `[${"-".repeat(width)}]`;
  const ratio = Math.max(0, Math.min(1, safeCurrent / safeTotal));
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
}

function cleanupPhaseLabel(phase) {
  const labels = {
    load: "catalog load",
    backup: "safety backup",
    "broad-trust-scan": "legacy relationship scan",
    "broad-trust-rebuild": "isolated relationship rebuild",
    "competitor-proof-audit": "competitor proof audit",
    "history-sanitize": "history sanitation",
    "intelligence-rebuild": "intelligence rebuild",
    "product-cache-lookup-index": "cleanup product/offer lookup index",
    "price-signal-index": "cleanup Price Signal history index",
    "price-signal-trust-scan": "cleanup Price Signal offer trust scan",
    "price-signal-raw-history": "cleanup Price Signal raw history",
    "price-signal-aggregates": "cleanup Price Signal aggregates",
    "price-signal-compaction": "cleanup Price Signal sparkline compaction",
    "product-cache-history-index": "cleanup Deal Heat 30-day history index",
    persist: "catalog commit",
    complete: "complete",
  };
  return labels[String(phase || "")] || String(phase || "cleanup");
}

function createCompetitorCleanupProgressReporter(reason = "scheduled") {
  if (!cleanupProgressEnabled()) return null;

  const minSeconds = Math.max(
    Number(process.env.EBAY_COMPETITOR_CLEANUP_PROGRESS_SECONDS || 2),
    0.25
  );
  const minItems = Math.max(
    Math.floor(Number(process.env.EBAY_COMPETITOR_CLEANUP_PROGRESS_ITEMS || 250)),
    1
  );
  const cleanupStartedAt = Date.now();
  let phase = "";
  let phaseStartedAt = cleanupStartedAt;
  let lastPrintedAt = 0;
  let lastPrintedCurrent = -1;

  console.log(`[competitor-cleanup] ${reason}: progress console enabled`);

  return event => {
    const now = Date.now();
    const eventPhase = String(event?.phase || "cleanup");
    const state = String(event?.state || "progress");
    const current = Math.max(0, Number(event?.current) || 0);
    const total = Math.max(0, Number(event?.total) || 0);

    if (eventPhase !== phase) {
      phase = eventPhase;
      phaseStartedAt = now;
      lastPrintedAt = 0;
      lastPrintedCurrent = -1;
    }

    const phaseChangedOrBoundary = state === "start" || state === "done" || eventPhase === "complete";
    const enoughTime = now - lastPrintedAt >= minSeconds * 1000;
    const enoughItems = current - lastPrintedCurrent >= minItems;
    const atEnd = total > 0 && current >= total;

    if (!phaseChangedOrBoundary && !enoughTime && !enoughItems && !atEnd) return;

    lastPrintedAt = now;
    lastPrintedCurrent = current;

    if (eventPhase === "complete") {
      console.log(
        `[competitor-cleanup] ${reason}: COMPLETE in ${formatCleanupDuration(event.durationMs ?? (now - cleanupStartedAt))} · ` +
        `checked ${Number(event.competitorOffersChecked || 0)} competitors · ` +
        `isolated ${Number(event.broadOffersSplit || 0)} weak relationships · ` +
        `quarantined ${Number(event.quarantinedOffers || 0)} · removed ${Number(event.removedOffers || 0)} · ` +
        `${Number(event.pendingAfter || 0)} pending exact proof`
      );
      return;
    }

    const label = cleanupPhaseLabel(eventPhase);
    if (state === "start") {
      console.log(
        `[competitor-cleanup] ${reason}: ${label} starting` +
        `${event?.message ? ` · ${event.message}` : ""}`
      );
      return;
    }

    if (!total) {
      console.log(
        `[competitor-cleanup] ${reason}: ${label} ${state === "done" ? "done" : "working"}` +
        `${event?.message ? ` · ${event.message}` : ""}`
      );
      return;
    }

    const pct = Math.max(0, Math.min(100, (current / total) * 100));
    const phaseElapsedMs = Math.max(1, now - phaseStartedAt);
    const ratePerSecond = current > 0 ? current / (phaseElapsedMs / 1000) : 0;
    const rateReady = phaseElapsedMs >= 250 && current > 1;
    const remaining = Math.max(0, total - current);
    const etaMs = rateReady && ratePerSecond > 0 ? (remaining / ratePerSecond) * 1000 : null;
    const details = [];

    if (event.splitOffers != null) details.push(`isolated ${Number(event.splitOffers || 0)}`);
    if (event.trustedSecondaries != null) details.push(`trusted ${Number(event.trustedSecondaries || 0)}`);
    if (event.quarantinedOffers != null) details.push(`quarantined ${Number(event.quarantinedOffers || 0)}`);
    if (event.removedOffers != null) details.push(`removed ${Number(event.removedOffers || 0)}`);
    if (event.removedHistoryPoints != null) details.push(`history removed ${Number(event.removedHistoryPoints || 0)}`);
    if (event.removedAggregateBuckets != null) details.push(`aggregates removed ${Number(event.removedAggregateBuckets || 0)}`);

    console.log(
      `[competitor-cleanup] ${reason}: ${label} ${cleanupProgressBar(current, total)} ` +
      `${pct.toFixed(1)}% · ${current}/${total} ${event?.unit || "items"}` +
      `${rateReady && ratePerSecond > 0 && state !== "done" ? ` · ${ratePerSecond.toFixed(ratePerSecond >= 10 ? 0 : 1)}/s` : ""}` +
      `${etaMs != null && etaMs > 500 && state !== "done" ? ` · ETA ${formatCleanupDuration(etaMs)}` : ""}` +
      `${details.length ? ` · ${details.join(" · ")}` : ""}` +
      `${state === "done" ? ` · done in ${formatCleanupDuration(phaseElapsedMs)}` : ""}`
    );
  };
}

function runCompetitorIntegrityCleanup(reason = "scheduled") {
  const result = cleanupEbayCompetitorOffers({
    reason,
    makeBackup: reason === "startup",
    onProgress: createCompetitorCleanupProgressReporter(reason),
    deferPersistence: reason !== "admin-manual",
  });

  console.log(
    `[competitor-cleanup] ${reason}: checked ${result.competitorOffersChecked}, ` +
    `quarantined ${result.quarantinedOffers || 0}, removed ${result.removedOffers} proven-unsafe offers, ` +
    `${result.pendingAfter || 0} awaiting exact-detail proof; ` +
    `isolated ${result.broadOffersSplit || 0} legacy broad eBay relationships and retained ` +
    `${result.broadSecondariesVerified || 0} only after exact proof`
  );

  if (Object.keys(result.reasons || {}).length) {
    console.log("[competitor-cleanup] removal reasons:", result.reasons);
  }

  return result;
}

function startCompetitorIntegrityCleanup() {
  const enabled =
    String(process.env.EBAY_COMPETITOR_CLEANUP_ENABLED || "true").toLowerCase() === "true";

  if (!enabled) {
    console.log("[competitor-cleanup] disabled by EBAY_COMPETITOR_CLEANUP_ENABLED=false");
    return;
  }

  // User-facing behavior is intentionally fixed to no more often than 24 hours.
  const hours = Math.max(Number(process.env.EBAY_COMPETITOR_CLEANUP_HOURS || 24), 24);

  console.log(
    `[competitor-cleanup] scheduled every ${hours} hours; any required startup cleanup runs after the HTTP listener is live`
  );

  setInterval(
    () => {
      try {
        runCompetitorIntegrityCleanup("scheduled-24h");
      } catch (error) {
        console.error("[competitor-cleanup] scheduled cleanup failed:", cleanError(error));
      }
    },
    hours * 60 * 60 * 1000
  );
}

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  const status = Number(error?.status || 500);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: cleanError(error),
    code: error?.code || undefined,
  });
});

function startupDbPhaseLabel(phase) {
  const labels = {
    "prepare": "database directory",
    "catalog-load": "catalog load",
    "catalog-parse": "catalog parse",
    "catalog-migrate": "catalog migration",
    "migrate-offers": "offer schema migration",
    "migrate-products": "product schema migration",
    "migrate-history": "price-history aggregate migration",
    "migrate-rules": "discovery-rule migration",
    "migrate-lifecycle": "lifecycle metadata migration",
    "price-signal-index": "Price Signal history index",
    "price-signal-trust-scan": "Price Signal offer trust scan",
    "price-signal-raw-history": "Price Signal raw history",
    "price-signal-aggregates": "Price Signal aggregates",
    "price-signal-compaction": "Price Signal sparkline compaction",
    "product-cache-lookup-index": "startup product/offer lookup index",
    "product-cache-history-index": "Deal Heat 30-day history index",
    "product-cache-rebuild": "product intelligence cache rebuild",
    "catalog-serialize": "catalog serialization",
    "catalog-write": "catalog persistence",
    "complete": "database initialization",
  };
  return labels[String(phase || "")] || String(phase || "database initialization");
}

function createStartupDbProgressReporter({
  prefix = "[startup-db]",
  labelResolver = startupDbPhaseLabel,
} = {}) {
  const startedAt = Date.now();
  let lastProgressPrintedAt = 0;
  let activePhase = "";
  const tqdm = new StartupTqdmBar();

  function verboseLine(line) {
    if (tqdm.active) {
      tqdm.interrupt(line);
    } else {
      console.log(line);
    }
  }

  return event => {
    const now = Date.now();
    const phase = String(event?.phase || "database");
    const state = String(event?.state || "progress");
    const current = Number(event?.current);
    const total = Number(event?.total);
    const hasCount = Number.isFinite(current) && Number.isFinite(total) && total > 0;
    const label = labelResolver(phase);
    const elapsed = formatCleanupDuration(now - startedAt);
    const phaseDuration = Number.isFinite(Number(event?.durationMs))
      ? formatCleanupDuration(Number(event.durationMs))
      : null;
    const countDetail = hasCount
      ? ` · ${current.toLocaleString()}/${total.toLocaleString()} (${Math.min(100, Math.max(0, Math.round((current / total) * 100)))}%)`
      : "";
    const byteDetail = Number.isFinite(Number(event?.totalBytes)) && Number(event.totalBytes) > 0
      ? ` · ${Number(event.totalBytes).toLocaleString()} bytes`
      : "";
    const message = event?.message ? ` · ${event.message}` : "";

    if (state === "start") {
      if (tqdm.active) tqdm.stop({ clear: true });
      activePhase = phase;
      console.log(`${prefix} ${label} starting${countDetail}${byteDetail}${message} · elapsed ${elapsed}`);
      if (hasCount) tqdm.start(label, total, current);
      return;
    }

    if (state === "done") {
      if (tqdm.active && activePhase === phase) {
        tqdm.update(hasCount ? current : total, { force: true });
        tqdm.stop();
      } else if (tqdm.active) {
        tqdm.stop({ clear: true });
      }
      activePhase = "";
      console.log(`${prefix} ${label} complete${countDetail}${byteDetail}${message}${phaseDuration ? ` · phase ${phaseDuration}` : ""} · elapsed ${elapsed}`);
      return;
    }

    if (hasCount && tqdm.active && activePhase === phase) {
      tqdm.update(current);
      return;
    }

    // Non-TTY logs cannot redraw a single line, so retain periodic verbose
    // progress there. TTY consoles use the live tqdm-style bar instead.
    if (state === "progress" && now - lastProgressPrintedAt < 750 && (!hasCount || current < total)) {
      return;
    }
    if (state === "progress") lastProgressPrintedAt = now;
    verboseLine(`${prefix} ${label} working${countDetail}${byteDetail}${message} · elapsed ${elapsed}`);
  };
}

console.log("[startup-maintenance] application modules loaded · database initialization starting");
const startupDbStartedAt = Date.now();
initDb({ onProgress: createStartupDbProgressReporter() });
console.log(
  `[startup-maintenance] database initialization complete in ${formatCleanupDuration(Date.now() - startupDbStartedAt)}`
);
validateProductionConfig();

console.log("[startup-maintenance] heavy maintenance deferred until after HTTP listen; persistent snapshots are serving immediately");

function startDraftAutoReview() {
  const enabled = String(process.env.DRAFT_AUTO_APPROVE_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[draft-review] confident draft auto-approval disabled");
    return;
  }

  const minutes = Math.max(1, Number(process.env.DRAFT_AUTO_APPROVE_MINUTES || 1));
  const batch = Math.min(Math.max(Number(process.env.DRAFT_AUTO_APPROVE_BATCH || 200), 1), 2000);

  const run = async reason => {
    try {
      await waitForInteractiveIdle({
        reason: `draft-auto-review:${reason}`,
        quietMs: Math.max(Number(process.env.DRAFT_AUTO_APPROVE_QUIET_MS || 250), 50),
      });
      const result = autoApproveConfidentDrafts({
        limit: batch,
        reason,
        deferPersistence: true,
      });
      if (result.approved.length || result.scanned) {
        opLog("draft-review", "confident draft review complete", {
          reason,
          scanned: result.scanned,
          approved: result.approved.length,
          skipped: result.skipped,
          minConfidence: result.minConfidence,
        });
      }
    } catch (error) {
      opWarn("draft-review", "confident draft review failed", cleanError(error));
    }
  };

  setTimeout(() => run("startup-backlog"), 5_000).unref?.();
  setInterval(() => run("scheduled"), minutes * 60_000).unref?.();
  console.log(`[draft-review] confident draft review every ${minutes} minute(s) · up to ${batch} drafts/pass`);
}

function startLazyIntelligenceValidation() {
  const minutes = Math.max(1, Number(process.env.INTELLIGENCE_LAZY_SCAN_MINUTES || 2));
  const batch = Math.max(1, Math.min(Number(process.env.INTELLIGENCE_LAZY_SCAN_BATCH || 32), 500));

  const run = () => {
    const ids = queueStaleIntelligenceSnapshots({ limit: batch });
    if (ids.length) {
      opLog("intelligence", "lazy snapshot validation queued", { queued: ids.length });
    }
  };

  setTimeout(run, 2_000).unref?.();
  setInterval(run, minutes * 60_000).unref?.();
}


let localDatabaseCleanupRunning = false;

function localMaintenanceQuotaConstrained() {
  const guard = getEbayRateGuardStatus();
  const getItems = guard?.getItems || {};
  const browse = guard?.browse || {};
  return Boolean(
    Number(getItems.backgroundRemaining || 0) <= 0 ||
    Number(browse.backgroundRemaining || 0) <= 0 ||
    ["strict", "critical"].includes(String(getItems.softLimitMode || "")) ||
    ["strict", "critical"].includes(String(browse.softLimitMode || "")) ||
    Number(getItems.cooldownUntil || 0) > Date.now() ||
    Number(browse.cooldownUntil || 0) > Date.now()
  );
}

async function runLocalDatabaseMaintenance(reason = "scheduled") {
  if (localDatabaseCleanupRunning) return null;

  // V3.7.33: recurring/local cleanup is not a substitute for the full v313
  // integrity migration. The startup local-cleanup timer fires before deferred
  // startup integrity maintenance, so allowing it to run on a legacy catalog
  // could partially normalize a batch and then make startup believe the full
  // migration had already completed. Defer local work until the authoritative
  // integrity cycle has advanced the catalog to v313.
  const integrityBefore = getCatalogIntegrityVersionStatus();
  if (Number(integrityBefore.integrityVersion || 0) < 313) {
    opLog("local-db-cleanup", "catalog integrity migration pending; local normalization deferred", {
      integrityVersion: Number(integrityBefore.integrityVersion || 0),
      requiredIntegrityVersion: 313,
      reason,
    });
    return {
      skipped: true,
      skipReason: "catalog-integrity-migration-pending",
      integrityVersion: Number(integrityBefore.integrityVersion || 0),
      requiredIntegrityVersion: 313,
    };
  }

  localDatabaseCleanupRunning = true;
  try {
    await waitForInteractiveIdle({
      reason: `local-db-cleanup:${reason}`,
      quietMs: Math.max(Number(process.env.LOCAL_NORMALIZATION_QUIET_MS || 500), 100),
    });
    await backgroundCheckpoint(`local-db-cleanup:${reason}`);
    const constrained = localMaintenanceQuotaConstrained();
    const result = runLocalDatabaseCleanup({
      reason: constrained ? `${reason}:api-constrained` : reason,
      maxProducts: constrained
        ? Number(process.env.LOCAL_NORMALIZATION_CONSTRAINED_BATCH || 5000)
        : Number(process.env.LOCAL_NORMALIZATION_PRODUCTS_PER_PASS || 2500),
      deferPersistence: true,
    });
    if (result.touchedProducts || result.duplicateOffersRemoved || result.invalidCanonicalProductsRepaired) {
      opLog("local-db-cleanup", "local normalization maintenance complete", {
        constrained,
        ...result,
      });
    }
    return result;
  } catch (error) {
    opWarn("local-db-cleanup", "local normalization maintenance failed", cleanError(error));
    return null;
  } finally {
    localDatabaseCleanupRunning = false;
  }
}

function startLocalDatabaseCleanupScheduler() {
  const enabled = String(process.env.LOCAL_NORMALIZATION_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[local-db-cleanup] disabled by LOCAL_NORMALIZATION_ENABLED=false");
    return;
  }

  const heartbeatMinutes = Math.max(5, Number(process.env.LOCAL_NORMALIZATION_HEARTBEAT_MINUTES || 10));
  const normalMinutes = Math.max(15, Number(process.env.LOCAL_NORMALIZATION_MINUTES || 30));
  const constrainedMinutes = Math.max(5, Number(process.env.LOCAL_NORMALIZATION_CONSTRAINED_MINUTES || 10));

  const maybeRun = async reason => {
    const status = getLocalDatabaseCleanupStatus();
    const last = Date.parse(status.lastRunAt || "") || 0;
    const constrained = localMaintenanceQuotaConstrained();
    const dueMs = (constrained ? constrainedMinutes : normalMinutes) * 60_000;
    const needsStrongEvidenceMerge = Number(status.strongEvidenceDuplicateMergeVersion || 0) < 1;
    if (!needsStrongEvidenceMerge && last && Date.now() - last < dueMs) return;
    await runLocalDatabaseMaintenance(
      needsStrongEvidenceMerge ? `${reason}:v3.7.35-strong-duplicate-migration` : reason
    );
  };

  setTimeout(() => maybeRun("startup").catch(console.error), 20_000).unref?.();
  setInterval(() => maybeRun("scheduled").catch(console.error), heartbeatMinutes * 60_000).unref?.();
  console.log(
    `[local-db-cleanup] local normalization every ${normalMinutes}m normally / ${constrainedMinutes}m while eBay quota is constrained`
  );
}

function startDeferredStartupMaintenance() {
  const delayMs = Math.max(1_000, Number(process.env.STARTUP_MAINTENANCE_DELAY_MS || 30_000));
  setTimeout(async () => {
    try {
      await waitForInteractiveIdle({ reason: "startup-maintenance", quietMs: 750 });

      const integrity = getCatalogIntegrityVersionStatus();
      // Full-catalog integrity repair is a migration/recovery operation, not a
      // live duplicate detector. Current-version duplicate cleanup is handled
      // incrementally by the bounded local normalization scheduler.
      const needsIntegrity =
        Number(integrity.integrityVersion || 0) < 313 ||
        Number(integrity.priceAccuracyVersion || 0) < 4;

      if (needsIntegrity) {
        await backgroundCheckpoint("startup-maintenance:catalog-integrity");
        runCatalogIntegrityCycle("startup");
      } else {
        opLog("startup-maintenance", "catalog integrity already current; full startup repair skipped");
      }

      const cleanup = getEbayCompetitorCleanupStatus();
      if (Number(cleanup.version || 0) < 376 || Number(cleanup.pending || 0) > 0) {
        await backgroundCheckpoint("startup-maintenance:competitor-cleanup");
        runCompetitorIntegrityCleanup("startup");
      } else {
        opLog("startup-maintenance", "competitor trust cleanup already current");
      }

      const lifecycle = getProductLifecycleStatus();
      if (!lifecycle.lastRunAt) {
        await backgroundCheckpoint("startup-maintenance:lifecycle");
        runProductLifecycleMaintenance("startup");
      } else {
        opLog("startup-maintenance", "lifecycle state already initialized; scheduled cycle will maintain it");
      }

      opLog("startup-maintenance", "deferred maintenance complete");
    } catch (error) {
      opWarn("startup-maintenance", "deferred maintenance failed", error?.stack || error?.message || String(error));
    }
  }, delayMs).unref?.();
}

// Friendly HTML 404 after API/static routes.
app.use((req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
    return res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
  }
  next();
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`\n${APP_NAME} v3.7.61-CAMPAIGN-READY-GLASS`);
  console.log(`Public: ${SITE_BASE_URL}`);
  console.log(`Origin: http://${HOST}:${PORT}`);
  console.log(`Catalog search workers: ${catalogSearchThreadCount()}`);
  console.log(`Store page size: ${SHOPPER_PAGE_SIZE} (fixed shopper page)`);
  console.log(`Live precision page expansion: ${String(process.env.LIVE_SEARCH_ENABLED || "true").toLowerCase() === "true" ? "ON" : "OFF"}`);
  console.log(`Verbose operations log: ${String(process.env.VERBOSE_LOGGING || "true").toLowerCase() !== "false" ? "ON" : "OFF"}`);

  // V3.7.47: begin double-buffered worker warmup as soon as HTTP is ready.
  // This is deliberately fire-and-forget/quiet-lane work: the server can serve
  // immediately, while the common first shopper avoids paying cold lexical
  // preparation if the warm worker is ready by the time they search.
  scheduleCatalogSearchWarmup({ reason: "startup-http-ready" });

  startEventLoopWatchdog();
  if (CAMPAIGN_TRAFFIC_MODE) {
    console.log("[campaign-mode] paid-traffic protection enabled; background catalog mutation and maintenance schedulers are paused");
  } else {
    seedInitialRules();
    startEbayQuotaSync();
    startStarterPopulate();
    startAutoSync();
    startRakutenCatalogScheduler();
    startEbayCompetitorScanner();
    startEbayPriceVerifier();
    startDraftAutoReview();
    startEbayCompetitorSanitizer();
    startCatalogIntegrityScheduler();
    startProductLifecycleScheduler();
    startCompetitorIntegrityCleanup();
    startLocalDatabaseCleanupScheduler();
    startLazyIntelligenceValidation();
    startDeferredStartupMaintenance();
  }

  const intelligence = getIntelligencePipelineStatus();
  console.log(
    `Intelligence workers: ${intelligence.workers.workers}/${intelligence.workers.logicalCpuCount} logical CPUs · ` +
    `mutation buffer ${intelligence.mutationBuffer.thresholdProducts} products / ${Math.round(intelligence.mutationBuffer.windowMs / 1000)}s`
  );

  const rateGuard = getEbayRateGuardStatus();
  console.log(
    `eBay rate guard: ${rateGuard.enabled ? "ON" : "OFF"} · ` +
    `Browse effective background ${rateGuard.browse.backgroundRemaining}/${rateGuard.browse.backgroundCap} remaining · ` +
    `getItems effective background ${rateGuard.getItems.backgroundRemaining}/${rateGuard.getItems.backgroundCap} remaining`
  );

  if (rateGuard.browse.remoteRemaining != null) {
    console.log(
      `eBay authoritative Browse quota: ${rateGuard.browse.remoteRemaining}/${rateGuard.browse.remoteLimit ?? "?"} remaining` +
      `${rateGuard.browse.remoteResetAtIso ? ` · reset ${rateGuard.browse.remoteResetAtIso}` : ""}`
    );
  }

  const ebayUsage = getEbayApiUsageStatus();
  console.log(
    `eBay usage today: ${ebayUsage.callsUsedToday}/${ebayUsage.configuredDailyAllowance} configured calls · ` +
    `${ebayUsage.percentageRemaining}% remaining · estimated ${ebayUsage.estimatedCallsPerDay}/day at current traffic`
  );

  const lifecycle = getProductLifecycleStatus();
  console.log(
    `Product lifecycle: ${lifecycle.enabled ? "ON" : "OFF"} · ` +
    `ACTIVE ${lifecycle.counts.ACTIVE || 0} · ` +
    `DORMANT ${lifecycle.counts.DORMANT || 0} · ` +
    `STALE ${lifecycle.counts.STALE || 0} · ` +
    `PRUNABLE ${lifecycle.counts.PRUNABLE || 0} · ` +
    `ARCHIVED ${lifecycle.counts.ARCHIVED || 0}`
  );
  console.log(`Trending: ${SITE_BASE_URL}/trending.html`);
  console.log(`Admin: ${SITE_BASE_URL}/admin.html`);
  if (IS_PRODUCTION) {
    console.log(`Cloudflare Tunnel origin target: http://${HOST}:${PORT}`);
  }
  console.log(`\nV3.7.40 FULL-PAGE COMPETITOR HYDRATION: live shopper discovery now fills toward the requested page, then attempts exact competitor verification for every visible product below the verified-seller target before the completed page is returned. V3.7.39 evidence-weighted identity, draft-source catch-up, seller diversity, and competitor sorting remain intact.\n`);
});
let shutdownStarted = false;
async function gracefulShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[shutdown] ${signal} received; draining OfferGrid mutation/intelligence buffers`);

  // Stop accepting new HTTP work immediately, but do not wait forever on
  // long-lived SSE sockets before making the RAM mutation buffer durable.
  const httpClosed = new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    httpServer.close(finish);
    const forceClose = setTimeout(() => {
      try { httpServer.closeAllConnections?.(); } catch {}
      finish();
    }, 5_000);
    forceClose.unref?.();
  });

  try {
    await flushOfferGridMutationPipelines({ timeoutMs: 20_000 });
  } catch (error) {
    console.error("[shutdown] buffer drain failed:", error?.stack || error?.message || error);
  }
  try {
    await flushMarketingAnalytics();
  } catch (error) {
    console.error("[shutdown] marketing ledger drain failed:", error?.stack || error?.message || error);
  }

  await httpClosed;
  process.exit(0);
}

process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
