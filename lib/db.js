import fs from "fs";
import path from "path";
import v8 from "node:v8";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "url";
import { discountPercent, rescoreOffers, offerComparisonPrice } from "./scoring.js";
import {
  candidateCanonicalKey,
  canonicalStrongBrand,
  canonicalStrongEpid,
  canonicalStrongGtin,
  canonicalStrongMpn,
  coarseVariantBucket,
  isPlaceholderIdentifier,
  safeSameVariant,
  sanitizeIdentityForStorage,
  strongIdentityBaseKey,
  strongVariantOwnershipConflict,
  variantIdentityDiscriminator,
} from "./productIdentity.js";
import {
  classifyStoredCompetitorOffer,
  exactCompetitorProof,
} from "./productMatch.js";
import { publishLiveEvent } from "./liveEvents.js";
import { waitForInteractiveIdle } from "./requestPriority.js";
import {
  configureIntelligenceWorkerPool,
  enqueueIntelligenceProducts,
  getIntelligenceWorkerStatus,
  flushIntelligenceWorkerPool,
} from "../services/intelligenceWorkerPool.js";
import { searchRelevance } from "./searchRelevance.js";
import { isExplicitProduct, assertNonExplicitProduct, isExplicitSearchQuery } from "./contentSafety.js";
import { buildEbayGetItemsBatches, summarizeEbayGetItemsBatches } from "./ebayBatching.js";
import { correctedProductCategory } from "./catalogQuality.js";
import {
  intelligenceEligibleListing,
  isBrokenOrPartsListing,
  listingConditionExclusionReason,
} from "./listingCondition.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const DB_FILE = path.join(DATA_DIR, "catalog.json");
const TMP_FILE = path.join(DATA_DIR, "catalog.json.tmp");
const OUTBOUND_CLICK_LEDGER_FILE = path.join(DATA_DIR, "outbound_clicks.ndjson");

let DB_CACHE = null;
let DB_REVISION = 0;
let SEARCH_INDEX_REVISION = 0;
let PENDING_DEFERRED_WRITE = null;
let DEFERRED_WRITE_GENERATION = 0;
let PERSISTENCE_EPOCH = 0;
let LAST_DURABLE_PERSISTENCE_EPOCH = 0;
let RUNTIME_PERSIST_WORKER = null;
let RUNTIME_PERSIST_JOB_ID = 0;
let RUNTIME_PERSIST_ACTIVE = false;
let RUNTIME_PERSIST_LATEST = null;
const RUNTIME_PERSIST_JOBS = new Map();
const RUNTIME_PERSIST_WAITERS = [];
const PENDING_INTELLIGENCE_LIVE_IDS = new Set();
const PENDING_STARTUP_INTELLIGENCE_IDS = new Set();
let CLICK_LEDGER_APPEND_CHAIN = Promise.resolve();

// V3.7.47: reusable relationship maps for hot shopper reads. The cache is
// keyed to the search-intelligence revision plus structural array lengths, so
// repeated catalog refreshes do not rescan every product/offer/click row.
let RUNTIME_LOOKUP_CACHE = null;
let RUNTIME_LOOKUP_CACHE_REVISION = -1;
let RUNTIME_LOOKUP_CACHE_PRODUCTS = -1;
let RUNTIME_LOOKUP_CACHE_OFFERS = -1;
let RUNTIME_LOOKUP_CACHE_NEXT_CLICK_ID = -1;
let RUNTIME_CATEGORY_CACHE_REVISION = -1;
let RUNTIME_CATEGORY_CACHE = [];

let RUNTIME_DRAFT_REVIEW_CACHE = null;
let RUNTIME_DRAFT_REVIEW_CACHE_REVISION = -1;
let RUNTIME_DRAFT_REVIEW_CACHE_PRODUCTS = -1;


const INTELLIGENCE_SNAPSHOT_SCHEMA_VERSION = 1;
const BEST_OFFER_CACHE_SCHEMA_VERSION = 2;
const MUTATION_BUFFER_WINDOW_MS = Math.max(
  5_000,
  Math.min(Number(process.env.MUTATION_BUFFER_WINDOW_MS || 120_000), 300_000)
);
const MUTATION_BUFFER_MAX_AGE_MS = Math.max(
  MUTATION_BUFFER_WINDOW_MS,
  Math.min(Number(process.env.MUTATION_BUFFER_MAX_AGE_MS || 300_000), 900_000)
);
const MUTATION_BUFFER_MAX_PRODUCTS = Math.max(
  64,
  Math.min(Number(process.env.MUTATION_BUFFER_MAX_PRODUCTS || 1024), 25_000)
);
const INTELLIGENCE_STALE_MINUTES = Math.max(
  5,
  Number(process.env.INTELLIGENCE_STALE_MINUTES || 180)
);

const PENDING_RUNTIME_MUTATIONS = new Map();
let MUTATION_BUFFER_TIMER = null;
let MUTATION_BUFFER_HARD_TIMER = null;
let MUTATION_BUFFER_FIRST_QUEUED_AT = 0;
let MUTATION_FLUSH_CHAIN = Promise.resolve();
let MUTATION_FLUSH_COUNT = 0;
let MUTATION_BUFFER_LAST_FLUSH_AT = null;

function nowIso() {
  return new Date().toISOString();
}

function boundedText(value, maxLength = 500) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, Number(maxLength) || 0));
}

function boundedToken(value, maxLength = 300) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, Math.max(0, Number(maxLength) || 0));
}

function safeHttpUrl(value, maxLength = 4000) {
  const raw = boundedToken(value, maxLength);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return "";
    if (!parsed.hostname) return "";
    return raw;
  } catch {
    return "";
  }
}

function clickLedgerKey(click) {
  const reference = boundedToken(click?.clickReference, 100);
  if (reference) return `reference:${reference}`;
  return `legacy:${Number(click?.id) || 0}:${boundedToken(click?.at, 80)}:${Number(click?.offerId) || 0}`;
}

function mergeOutboundClickLedger(data) {
  if (!fs.existsSync(OUTBOUND_CLICK_LEDGER_FILE)) return;
  try {
    const knownProducts = new Set((data.products || []).map(product => Number(product.id)));
    const knownOffers = new Set((data.offers || []).map(offer => Number(offer.id)));
    const byKey = new Map((data.clicks || []).map(click => [clickLedgerKey(click), click]));
    const raw = fs.readFileSync(OUTBOUND_CLICK_LEDGER_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const click = JSON.parse(line);
        if (!Date.parse(click?.at || "")) continue;
        if (!knownProducts.has(Number(click.productId)) || !knownOffers.has(Number(click.offerId))) continue;
        byKey.set(clickLedgerKey(click), click);
      } catch {}
    }
    const clickLimit = Math.max(1000, Number(process.env.CLICK_LOG_LIMIT || 50000));
    data.clicks = [...byKey.values()]
      .sort((a, b) => Date.parse(a.at || "") - Date.parse(b.at || ""))
      .slice(-clickLimit);
    data.meta.nextClickId = Math.max(
      Number(data.meta.nextClickId || 1),
      Math.max(0, ...data.clicks.map(click => Number(click.id) || 0)) + 1
    );
  } catch (error) {
    console.warn(`[db] outbound click ledger could not be loaded: ${error?.message || error}`);
  }
}

function queueOutboundClickAppend(click) {
  CLICK_LEDGER_APPEND_CHAIN = CLICK_LEDGER_APPEND_CHAIN
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      await fs.promises.appendFile(
        OUTBOUND_CLICK_LEDGER_FILE,
        `${JSON.stringify(click)}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
    })
    .catch(error => console.warn(`[db] outbound click ledger append failed: ${error?.message || error}`));
}

function finiteNumberOrNull(value, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number;
}

function noteRejectedProductIdentity(product, rejected = {}, source = "identity") {
  if (!product || !rejected || typeof rejected !== "object") return false;
  let changed = false;
  const fields = {
    brand: "identityRejectedBrand",
    gtin: "identityRejectedGtin",
    mpn: "identityRejectedMpn",
    epid: "identityRejectedEpid",
  };

  for (const [kind, field] of Object.entries(fields)) {
    const raw = boundedText(rejected[kind], 200);
    if (!raw) continue;
    if (!product[field]) {
      product[field] = raw;
      changed = true;
    }
  }

  if (Object.values(rejected).some(Boolean)) {
    product.identityRejectedLastAt = nowIso();
    product.identityRejectedLastSource = boundedText(source, 120);
    product.identityRejectedCount = Math.max(0, Number(product.identityRejectedCount || 0)) + 1;
    changed = true;
  }
  return changed;
}

function applyTrustedProductIdentity(product, identity = {}, { fillOnly = true, source = "identity" } = {}) {
  if (!product) return { changed: false, identity: sanitizeIdentityForStorage(identity) };
  const cleaned = sanitizeIdentityForStorage(identity);
  let changed = noteRejectedProductIdentity(product, cleaned.rejected, source);

  for (const field of ["brand", "gtin", "mpn", "epid"]) {
    const next = cleaned[field] || "";
    if (!next) continue;
    if (fillOnly && String(product[field] || "").trim()) continue;
    if (product[field] !== next) {
      product[field] = next;
      changed = true;
    }
  }

  return { changed, identity: cleaned };
}

function emptyDb() {
  return {
    meta: {
      nextProductId: 1,
      nextOfferId: 1,
      nextRuleId: 1,
      nextClickId: 1,
      version: 2,
    },
    products: [],
    offers: [],
    priceHistory: [],
    priceAggregates: [],
    discoveryRules: [],
    clicks: [],
  };
}

function migrate(data, { onProgress = null } = {}) {
  if (!data || typeof data !== "object") return emptyDb();
  data.meta ||= {};
  data.products = Array.isArray(data.products) ? data.products : [];
  data.offers = Array.isArray(data.offers) ? data.offers : [];
  data.priceHistory = Array.isArray(data.priceHistory) ? data.priceHistory : [];
  data.priceAggregates = Array.isArray(data.priceAggregates) ? data.priceAggregates : [];
  data.discoveryRules = Array.isArray(data.discoveryRules) ? data.discoveryRules : [];
  data.clicks = Array.isArray(data.clicks) ? data.clicks : [];

  const migrationProgressEvery = Math.max(
    1,
    Math.floor(Number(process.env.DB_STARTUP_PROGRESS_ITEMS || 100))
  );

  data.meta.nextProductId ||= Math.max(0, ...data.products.map(p => Number(p.id) || 0)) + 1;
  data.meta.nextOfferId ||= Math.max(0, ...data.offers.map(o => Number(o.id) || 0)) + 1;
  data.meta.nextRuleId ||= Math.max(0, ...data.discoveryRules.map(r => Number(r.id) || 0)) + 1;
  data.meta.nextClickId ||= Math.max(0, ...data.clicks.map(c => Number(c.id) || 0)) + 1;
  data.meta.version = 2;

  emitDbStartupProgress(onProgress, {
    phase: "migrate-offers",
    state: "start",
    current: 0,
    total: data.offers.length,
    message: "normalizing stored offer metadata",
  });
  for (let offerIndex = 0; offerIndex < data.offers.length; offerIndex++) {
    const o = data.offers[offerIndex];
    o.listingTitle ||= "";
    o.imageUrl ||= "";
    const storedAffiliateUrl = boundedToken(o.affiliateUrl, 4000);
    const safeStoredAffiliateUrl = safeHttpUrl(storedAffiliateUrl, 4000);
    if (storedAffiliateUrl && !safeStoredAffiliateUrl) {
      o.affiliateUrlRejected ||= storedAffiliateUrl.slice(0, 500);
      o.affiliateUrlRejectedAt ||= nowIso();
    }
    o.affiliateUrl = safeStoredAffiliateUrl;
    o.brand ||= "";
    o.gtin ||= "";
    o.mpn ||= "";
    o.epid ||= "";
    o.legacyItemId ||= "";
    o.searchObservedAt ||= o.lastSeen || null;
    o.searchObservedPrice =
      o.searchObservedPrice == null && Number.isFinite(Number(o.price))
        ? Number(o.price)
        : o.searchObservedPrice;
    o.priceVerifiedAt ||= null;
    o.lastVerifiedPrice =
      o.lastVerifiedPrice == null ? null : Number(o.lastVerifiedPrice);
    o.priceSource ||= o.priceVerifiedAt ? "ebay-item-detail" : "legacy";
    o.priceVerificationStatus ||= o.priceVerifiedAt ? "verified" : "unverified";
    o.priceDiscrepancyCount = Math.max(0, Number(o.priceDiscrepancyCount || 0));
    o.lastPriceDiscrepancy = Number(o.lastPriceDiscrepancy || 0);
    o.unitPrice = o.unitPrice == null ? null : Number(o.unitPrice);
    o.unitPriceCurrency ||= "";
    o.unitPricingMeasure ||= "";
    o.lotSize = o.lotSize == null ? null : Number(o.lotSize);
    o.quantityLimitPerBuyer =
      o.quantityLimitPerBuyer == null ? null : Number(o.quantityLimitPerBuyer);
    o.estimatedAvailableQuantity =
      o.estimatedAvailableQuantity == null ? null : Number(o.estimatedAvailableQuantity);
    o.availabilityThreshold =
      o.availabilityThreshold == null ? null : Number(o.availabilityThreshold);
    o.availabilityThresholdType ||= "";
    o.primaryItemGroupId ||= "";
    o.primaryItemGroupType ||= "";
    o.itemEndDate ||= "";
    o.priceTreatment ||= "";
    o.priceDisplayCondition ||= "";
    o.priceDisplayRestricted = Boolean(o.priceDisplayRestricted);
    o.coupons = Array.isArray(o.coupons) ? o.coupons : [];
    o.competitorIdentityStatus ||= "";
    o.competitorIdentityQueuedAt ||= null;
    o.competitorIdentityLastAttemptAt ||= null;
    o.competitorIdentityVerifiedAt ||= null;
    o.competitorIdentityLastReason ||= "";
    o.competitorSanitizerAttempts = Math.max(0, Number(o.competitorSanitizerAttempts || 0));
    o.competitorPreQuarantineAvailability ||= "";

    const current = offerIndex + 1;
    if (current === data.offers.length || current % migrationProgressEvery === 0) {
      emitDbStartupProgress(onProgress, {
        phase: "migrate-offers",
        state: current === data.offers.length ? "done" : "progress",
        current,
        total: data.offers.length,
        message: "normalizing stored offer metadata",
      });
    }
  }
  if (data.offers.length === 0) {
    emitDbStartupProgress(onProgress, {
      phase: "migrate-offers",
      state: "done",
      current: 0,
      total: 0,
      message: "no stored offers required normalization",
    });
  }

  emitDbStartupProgress(onProgress, {
    phase: "migrate-products",
    state: "start",
    current: 0,
    total: data.products.length,
    message: "normalizing product identity and lifecycle fields",
  });
  for (let productIndex = 0; productIndex < data.products.length; productIndex++) {
    const p = data.products[productIndex];
    p.tags = Array.isArray(p.tags) ? p.tags : [];
    p.editorNote ||= "";
    p.aiSummary ||= "";
    p.gtin ||= "";
    p.mpn ||= "";
    p.epid ||= "";
    p.ebayIdentityCheckedAt ||= null;
    p.ebayCompetitorScanAt ||= null;
    p.ebayCompetitorScanMethod ||= "";
    p.ebayCompetitorScanConfidence ||= 0;
    p.ebayCompetitorScanMatched ||= 0;
    p.ebayCompetitorScanError ||= "";
    // V3.7.42: a generic competitor scan timestamp is not enough to claim
    // that a shopper-visible normalized product received the ordered
    // progressive coverage pass. Keep explicit completion metadata so older
    // shallow scans cannot suppress page hydration.
    p.ebayCompetitorCoverageCompleteAt ||= null;
    p.ebayCompetitorCoverageTargetSellers = Math.max(0, Number(p.ebayCompetitorCoverageTargetSellers || 0));
    p.ebayCompetitorCoverageSignalsExhausted = Boolean(p.ebayCompetitorCoverageSignalsExhausted);
    p.ebayCompetitorCoverageSignalsRun = Math.max(0, Number(p.ebayCompetitorCoverageSignalsRun || 0));
    p.ebayCompetitorCoverageSellerCount = Math.max(0, Number(p.ebayCompetitorCoverageSellerCount || 0));
    p.ebayCompetitorCoverageStatus ||= "";
    p.primaryEbayOfferId = p.primaryEbayOfferId == null
      ? null
      : Number(p.primaryEbayOfferId);
    if (!Number.isFinite(p.primaryEbayOfferId)) p.primaryEbayOfferId = null;
    p.ebayTrustPolicyVersion = Math.max(0, Number(p.ebayTrustPolicyVersion || 0));
    p.ebayTrustLastCleanedAt ||= null;
    p.integrityBucket ||= "";
    const correctedCategory = correctedProductCategory(p.category, p.title);
    if (correctedCategory !== p.category) {
      p.category = correctedCategory;
      p.searchText = [p.title, p.brand, p.category].filter(Boolean).join(" ").toLowerCase();
      p.catalogQualityCorrection = "strong-title-category-conflict";
    }
    p.searchText ||= "";
    p.cachedBestOfferId = p.cachedBestOfferId == null ? null : Number(p.cachedBestOfferId);
    p.cachedBestPrice = p.cachedBestPrice == null ? null : Number(p.cachedBestPrice);
    p.cachedBestScore = Number(p.cachedBestScore || 0);
    p.cachedVerificationRank = Number(p.cachedVerificationRank || 0);
    p.cachedVerifiedSellerCount = Math.max(0, Number(p.cachedVerifiedSellerCount || 0));
    p.cachedPriceStats =
      p.cachedPriceStats && typeof p.cachedPriceStats === "object"
        ? p.cachedPriceStats
        : null;
    p.cachedPriceSparkline = Array.isArray(p.cachedPriceSparkline)
      ? p.cachedPriceSparkline
          .filter(point =>
            point &&
            Number.isFinite(Number(point.price)) &&
            Number.isFinite(Date.parse(point.at || ""))
          )
          .slice(-24)
      : [];

    const hasPersistedSnapshot = Boolean(
      p.cachedPriceStats &&
      typeof p.cachedPriceStats === "object" &&
      Number.isFinite(Number(p.cachedPriceStats.dealHeat || 0))
    );
    p.intelligenceSnapshotVersion = Math.max(
      0,
      Number(p.intelligenceSnapshotVersion || (hasPersistedSnapshot ? INTELLIGENCE_SNAPSHOT_SCHEMA_VERSION : 0))
    );
    p.intelligenceComputedAt ||= hasPersistedSnapshot
      ? (p.updatedAt || p.createdAt || null)
      : null;
    p.intelligenceDirty = Boolean(p.intelligenceDirty || !hasPersistedSnapshot);
    p.intelligenceDirtyAt ||= p.intelligenceDirty
      ? (p.updatedAt || p.createdAt || nowIso())
      : null;
    p.intelligenceDirtyReason ||= p.intelligenceDirty ? "snapshot-missing" : "";
    p.intelligenceGeneration = Math.max(0, Number(p.intelligenceGeneration || 0));
    p.intelligenceLastError ||= "";

    p.lifecycleState = String(p.lifecycleState || "ACTIVE").toUpperCase();
    if (!["ACTIVE", "DORMANT", "STALE", "PRUNABLE", "ARCHIVED"].includes(p.lifecycleState)) {
      p.lifecycleState = "ACTIVE";
    }
    p.lifecycleStateChangedAt ||= p.updatedAt || p.createdAt || nowIso();
    p.lifecycleLastActiveAt ||= null;
    p.lifecycleLastObservationAt ||= null;
    p.lifecyclePrunableSince ||= null;
    p.lifecycleArchivedAt ||= null;
    p.lifecycleLastArchivedAt ||= null;
    p.lifecycleReactivatedAt ||= null;
    p.lifecycleReactivateCount = Math.max(0, Number(p.lifecycleReactivateCount || 0));
    p.lifecycleWasApproved = Boolean(p.lifecycleWasApproved);
    p.lifecyclePinned = Boolean(p.lifecyclePinned);
    p.lifecycleProtectionScore = Math.max(0, Number(p.lifecycleProtectionScore || 0));
    p.lifecycleProtectionReasons = Array.isArray(p.lifecycleProtectionReasons)
      ? p.lifecycleProtectionReasons.map(String).slice(0, 20)
      : [];
    p.lifecyclePriceSummary =
      p.lifecyclePriceSummary && typeof p.lifecyclePriceSummary === "object"
        ? p.lifecyclePriceSummary
        : null;
    p.lifecycleClickSummary =
      p.lifecycleClickSummary && typeof p.lifecycleClickSummary === "object"
        ? p.lifecycleClickSummary
        : null;
    p.lifecycleTombstone =
      p.lifecycleTombstone && typeof p.lifecycleTombstone === "object"
        ? p.lifecycleTombstone
        : null;
    p.lifecycleNormalizedTitle ||= "";
    p.lifecycleNormalizedBrand ||= "";
    p.lifecycleIdentityKey ||= "";

    p.ebayExactSearchRejectedAt ||= null;
    p.ebayExactSearchRejectedMethod ||= "";
    p.ebayExactSearchRejectedValue ||= "";
    p.ebayExactSearchRejectedErrorId =
      Number(p.ebayExactSearchRejectedErrorId || 0) || null;

    p.approved = Boolean(p.approved);
    p.approvalSource ||= p.approved ? "legacy" : "";
    p.approvedAt ||= p.approved ? (p.updatedAt || p.createdAt || null) : null;
    p.autoApprovalBlocked = Boolean(p.autoApprovalBlocked);
    p.manualReviewTouchedAt ||= null;
    p.lastAutoReviewAt ||= null;
    p.lastAutoReviewDecision ||= "";
    p.lastAutoReviewReason ||= "";
    p.autoApprovalConfidence = Math.max(0, Math.min(100, Number(p.autoApprovalConfidence || 0)));
    if (p.lifecycleState === "ARCHIVED") p.approved = false;

    const current = productIndex + 1;
    if (current === data.products.length || current % migrationProgressEvery === 0) {
      emitDbStartupProgress(onProgress, {
        phase: "migrate-products",
        state: current === data.products.length ? "done" : "progress",
        current,
        total: data.products.length,
        message: "normalizing product identity and lifecycle fields",
      });
    }
  }
  if (data.products.length === 0) {
    emitDbStartupProgress(onProgress, {
      phase: "migrate-products",
      state: "done",
      current: 0,
      total: 0,
      message: "no products required normalization",
    });
  }

  emitDbStartupProgress(onProgress, {
    phase: "migrate-history",
    state: "start",
    current: 0,
    total: data.priceAggregates.length,
    message: "normalizing compressed price-history aggregates",
  });
  data.priceAggregates = data.priceAggregates
    .filter(item => item && Number.isFinite(Number(item.productId)))
    .map(item => ({
      productId: Number(item.productId),
      granularity:
        item.granularity === "month"
          ? "month"
          : item.granularity === "week"
            ? "week"
            : "day",
      bucket: String(item.bucket || ""),
      startAt: String(item.startAt || item.at || ""),
      endAt: String(item.endAt || item.at || ""),
      sampleCount: Math.max(1, Number(item.sampleCount || item.count || 1)),
      low: Number(item.low ?? item.price ?? 0),
      high: Number(item.high ?? item.price ?? 0),
      average: Number(item.average ?? item.price ?? 0),
      firstPrice: Number(item.firstPrice ?? item.price ?? item.average ?? 0),
      lastPrice: Number(item.lastPrice ?? item.price ?? item.average ?? 0),
      currency: String(item.currency || "USD").slice(0, 12),
      verifiedCount: Math.max(0, Number(item.verifiedCount || 0)),
      source: String(item.source || "compressed").slice(0, 80),
      // V3.7.47: aggregates created before condition provenance existed cannot
      // be asserted clean. New aggregates are explicitly tagged deal-eligible.
      conditionScope: item.conditionScope === "deal-eligible"
        ? "deal-eligible"
        : "legacy-unknown",
    }));
  emitDbStartupProgress(onProgress, {
    phase: "migrate-history",
    state: "done",
    current: data.priceAggregates.length,
    total: data.priceAggregates.length,
    message: "compressed price-history aggregates normalized",
  });

  emitDbStartupProgress(onProgress, {
    phase: "migrate-rules",
    state: "start",
    current: 0,
    total: data.discoveryRules.length,
    message: "normalizing discovery rules",
  });
  for (let ruleIndex = 0; ruleIndex < data.discoveryRules.length; ruleIndex++) {
    const r = data.discoveryRules[ruleIndex];
    r.starter = Boolean(r.starter);
    r.starterKey ||= "";
    r.categoryOverride ||= "";
    r.generated = Boolean(r.generated);
    r.parentRuleId = r.parentRuleId == null ? null : Number(r.parentRuleId);
    r.generationDepth = Math.max(0, Number(r.generationDepth || 0));
    r.familyKey ||= "";
    r.stallCount = Math.max(0, Number(r.stallCount || 0));
    r.expansionCount = Math.max(0, Number(r.expansionCount || 0));
    r.lastExpansionAt ||= null;

    const current = ruleIndex + 1;
    if (current === data.discoveryRules.length || current % migrationProgressEvery === 0) {
      emitDbStartupProgress(onProgress, {
        phase: "migrate-rules",
        state: current === data.discoveryRules.length ? "done" : "progress",
        current,
        total: data.discoveryRules.length,
        message: "normalizing discovery rules",
      });
    }
  }
  if (data.discoveryRules.length === 0) {
    emitDbStartupProgress(onProgress, {
      phase: "migrate-rules",
      state: "done",
      current: 0,
      total: 0,
      message: "no discovery rules required normalization",
    });
  }

  emitDbStartupProgress(onProgress, {
    phase: "migrate-lifecycle",
    state: "start",
    total: data.products.length + data.offers.length + data.priceHistory.length,
    message: "rebuilding lifecycle observation metadata",
  });
  migrateLifecycleMetadata(data);
  emitDbStartupProgress(onProgress, {
    phase: "migrate-lifecycle",
    state: "done",
    current: data.products.length + data.offers.length + data.priceHistory.length,
    total: data.products.length + data.offers.length + data.priceHistory.length,
    message: "lifecycle observation metadata rebuilt",
  });

  // V3.7.58 seller-cache coherence repair. Earlier migrations only inspected
  // products whose cached count was already nonzero, which left many valid
  // verified source/competitor sellers at cached=0 even though product detail
  // correctly hydrated them. Recompute every product that owns at least one
  // eBay offer in bounded batches, while preserving the Parts/Broken/Not-Tested
  // exclusion rules and invalidating coverage only when eligible sellers drop.
  const conditionSellerRepair = repairConditionAwareSellerCountCachesInDb(data, { onProgress });
  // Persist the one-time migration marker even when every cached count was
  // already correct. Otherwise the same bounded audit would repeat on every
  // restart forever for catalogs that happened not to need a numerical repair.
  if (!conditionSellerRepair.skipped) {
    data.meta.conditionAwareSellerCountCacheRepairPendingPersistence = true;
  }
  // V3.7.61: "best" is the lowest currently displayable, identity-trusted
  // verified price, not the highest affiliate/quality score. Reconcile every
  // persisted fast cache once so storefront cards, Deal Heat, search-worker
  // snapshots and product detail all agree immediately after deployment.
  const bestOfferRepair = repairBestOfferCachesInDb(data, { onProgress });
  if (!bestOfferRepair.skipped) {
    data.meta.bestOfferCacheRepairPendingPersistence = true;
  }
  return data;
}

function emitDbStartupProgress(onProgress, event = {}) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress({
      at: nowIso(),
      ...event,
    });
  } catch {
    // Startup progress is observability-only and must never interrupt database init.
  }
}

function tryRecoverCatalogTemp(reason = "catalog-read-failure") {
  const enabled = String(process.env.DB_RECOVER_VALID_TEMP || "true").toLowerCase() !== "false";
  if (!enabled || !fs.existsSync(TMP_FILE)) return null;

  try {
    const raw = fs.readFileSync(TMP_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.products) || !Array.isArray(parsed.offers)) {
      return null;
    }

    if (fs.existsSync(DB_FILE)) {
      const corruptPath = path.join(
        DATA_DIR,
        `catalog.corrupt-${Date.now()}.json`
      );
      fs.renameSync(DB_FILE, corruptPath);
      console.warn(`[db] preserved unreadable catalog at ${path.basename(corruptPath)}`);
    }
    fs.renameSync(TMP_FILE, DB_FILE);
    console.warn(`[db] recovered catalog.json from a valid completed temp snapshot (${reason})`);
    return { raw, parsed };
  } catch (error) {
    console.warn(`[db] temp catalog recovery unavailable: ${error?.message || error}`);
    return null;
  }
}

function parseCatalogWithTempRecovery(raw, reason = "catalog-parse") {
  try {
    return JSON.parse(raw);
  } catch (originalError) {
    const recovered = tryRecoverCatalogTemp(reason);
    if (recovered) return recovered.parsed;
    throw originalError;
  }
}

export function initDb({ onProgress = null } = {}) {
  const startedAt = Date.now();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  emitDbStartupProgress(onProgress, {
    phase: "prepare",
    state: "done",
    message: "data directory ready",
    durationMs: Date.now() - startedAt,
  });

  let data;
  if (!fs.existsSync(DB_FILE) && fs.existsSync(TMP_FILE)) {
    tryRecoverCatalogTemp("catalog-missing");
  }
  if (!fs.existsSync(DB_FILE)) {
    emitDbStartupProgress(onProgress, {
      phase: "catalog-load",
      state: "done",
      message: "no catalog.json found; creating an empty catalog",
      total: 0,
      current: 0,
    });
    data = emptyDb();
  } else {
    const fileSize = fs.statSync(DB_FILE).size;
    const readStartedAt = Date.now();
    emitDbStartupProgress(onProgress, {
      phase: "catalog-load",
      state: "start",
      totalBytes: fileSize,
      message: `reading catalog.json (${fileSize.toLocaleString()} bytes)`,
    });
    const raw = fs.readFileSync(DB_FILE, "utf8");
    emitDbStartupProgress(onProgress, {
      phase: "catalog-load",
      state: "done",
      totalBytes: fileSize,
      durationMs: Date.now() - readStartedAt,
      message: "catalog.json loaded",
    });

    const parseStartedAt = Date.now();
    emitDbStartupProgress(onProgress, {
      phase: "catalog-parse",
      state: "start",
      message: "parsing catalog JSON",
    });
    const parsed = parseCatalogWithTempRecovery(raw, "startup-parse");
    emitDbStartupProgress(onProgress, {
      phase: "catalog-parse",
      state: "done",
      durationMs: Date.now() - parseStartedAt,
      message: `parsed ${Number(parsed?.products?.length || 0).toLocaleString()} products, ${Number(parsed?.offers?.length || 0).toLocaleString()} offers, and ${Number(parsed?.priceHistory?.length || 0).toLocaleString()} raw price-history points`,
    });

    const migrateStartedAt = Date.now();
    emitDbStartupProgress(onProgress, {
      phase: "catalog-migrate",
      state: "start",
      message: "normalizing catalog schema and lifecycle metadata",
    });
    data = migrate(parsed, { onProgress });
    emitDbStartupProgress(onProgress, {
      phase: "catalog-migrate",
      state: "done",
      durationMs: Date.now() - migrateStartedAt,
      message: "catalog schema normalization complete",
    });
  }

  // Keep high-volume click writes out of the 200MB+ catalog hot path. The
  // append-only ledger is merged into memory at boot and deduplicated against
  // clicks already included in an occasional catalog snapshot.
  mergeOutboundClickLedger(data);

  // V3.7.23: boot trusts the persistent materialized snapshots already stored
  // on each product. No whole-catalog Deal Heat/history reconstruction is
  // allowed on the request-serving thread during initialization.
  DB_CACHE = data;
  DB_REVISION++;
  data.meta ||= {};
  data.meta.dbRevision = DB_REVISION;
  if (data.meta.conditionAwareSellerCountCacheRepairPendingPersistence) {
    delete data.meta.conditionAwareSellerCountCacheRepairPendingPersistence;
    scheduleDeferredWrite(data, 1000);
  }
  if (data.meta.bestOfferCacheRepairPendingPersistence) {
    delete data.meta.bestOfferCacheRepairPendingPersistence;
    scheduleDeferredWrite(data, 1000);
  }
  if (PENDING_STARTUP_INTELLIGENCE_IDS.size) {
    const ids = [...PENDING_STARTUP_INTELLIGENCE_IDS];
    PENDING_STARTUP_INTELLIGENCE_IDS.clear();
    enqueueIntelligenceProducts(ids, {
      priority: "background",
      reason: "best-offer-cache-migration",
    });
  }

  emitDbStartupProgress(onProgress, {
    phase: "product-cache-rebuild",
    state: "done",
    current: 0,
    total: 0,
    durationMs: 0,
    message: "persistent intelligence snapshots trusted; startup cache rebuild skipped",
  });

  emitDbStartupProgress(onProgress, {
    phase: "complete",
    state: "done",
    durationMs: Date.now() - startedAt,
    message: `database initialized with ${Number(data.products?.length || 0).toLocaleString()} products and ${Number(data.offers?.length || 0).toLocaleString()} offers`,
  });
}

function readDb() {
  if (DB_CACHE) return DB_CACHE;

  const raw = fs.readFileSync(DB_FILE, "utf8");
  DB_CACHE = migrate(parseCatalogWithTempRecovery(raw, "lazy-read"));
  DB_REVISION++;
  DB_CACHE.meta ||= {};
  DB_CACHE.meta.dbRevision = DB_REVISION;
  return DB_CACHE;
}

function finalizePersistedIntelligenceEvents(data) {
  // Worker-computed intelligence is announced to browsers only after the
  // materialized snapshot has crossed the durable catalog boundary. If a newer
  // mutation dirtied the product before this write, suppress the stale event;
  // the newer generation's worker result will announce itself later.
  if (!PENDING_INTELLIGENCE_LIVE_IDS.size) return;

  const byId = new Map((data.products || []).map(product => [Number(product.id), product]));
  const readyIds = [];
  for (const productId of [...PENDING_INTELLIGENCE_LIVE_IDS]) {
    const product = byId.get(Number(productId));
    PENDING_INTELLIGENCE_LIVE_IDS.delete(Number(productId));
    if (!product || product.intelligenceDirty) continue;
    if (Number(product.intelligenceSnapshotVersion || 0) < INTELLIGENCE_SNAPSHOT_SCHEMA_VERSION) continue;
    readyIds.push(Number(productId));
  }

  if (readyIds.length) {
    publishProductLiveMutation(data, {
      type: "price",
      reason: "intelligence-snapshot-refreshed",
      productIds: readyIds,
      metadata: { snapshotVersion: INTELLIGENCE_SNAPSHOT_SCHEMA_VERSION },
    });
  }
}

function resolveRuntimePersistenceWaiters() {
  for (let index = RUNTIME_PERSIST_WAITERS.length - 1; index >= 0; index--) {
    const waiter = RUNTIME_PERSIST_WAITERS[index];
    if (Number(waiter.epoch) > LAST_DURABLE_PERSISTENCE_EPOCH) continue;
    RUNTIME_PERSIST_WAITERS.splice(index, 1);
    waiter.resolve({
      committed: true,
      durableEpoch: LAST_DURABLE_PERSISTENCE_EPOCH,
      requestedEpoch: waiter.epoch,
      reason: waiter.reason,
    });
  }
}

function rejectRuntimePersistenceWaiters(error) {
  while (RUNTIME_PERSIST_WAITERS.length) {
    RUNTIME_PERSIST_WAITERS.shift().reject(error);
  }
}

function runtimePersistenceWorker() {
  if (RUNTIME_PERSIST_WORKER) return RUNTIME_PERSIST_WORKER;

  const worker = new Worker(
    new URL("../workers/catalogPersistenceWorker.js", import.meta.url),
    {
      type: "module",
      workerData: { dataDir: DATA_DIR },
      execArgv: process.execArgv.filter(arg => !String(arg).startsWith("--input-type")),
    }
  );
  worker.unref?.();

  worker.on("message", message => {
    const id = Number(message?.id || 0);
    const job = RUNTIME_PERSIST_JOBS.get(id);
    if (!job) {
      if (message?.tempPath) fs.promises.unlink(message.tempPath).catch(() => {});
      return;
    }
    RUNTIME_PERSIST_JOBS.delete(id);
    RUNTIME_PERSIST_ACTIVE = false;

    if (!message?.ok) {
      const error = new Error(message?.error || "Catalog persistence worker failed.");
      rejectRuntimePersistenceWaiters(error);
      queueMicrotask(kickRuntimePersistence);
      return;
    }

    try {
      if (job.epoch < LAST_DURABLE_PERSISTENCE_EPOCH) {
        // A newer synchronous write committed while this worker snapshot was in
        // flight. Never allow the older runtime snapshot to roll disk state back.
        fs.promises.unlink(message.tempPath).catch(() => {});
      } else {
        // JSON serialization and the 100MB+ file write already happened on the
        // worker. Keep only the tiny rename synchronous so epoch-check + commit
        // cannot race another main-thread write.
        fs.renameSync(message.tempPath, DB_FILE);
        LAST_DURABLE_PERSISTENCE_EPOCH = Math.max(
          LAST_DURABLE_PERSISTENCE_EPOCH,
          Number(job.epoch)
        );
        finalizePersistedIntelligenceEvents(job.data);
      }
      resolveRuntimePersistenceWaiters();
      queueMicrotask(kickRuntimePersistence);
    } catch (error) {
      fs.promises.unlink(message?.tempPath || "").catch(() => {});
      rejectRuntimePersistenceWaiters(error);
      queueMicrotask(kickRuntimePersistence);
    }
  });

  const rejectAll = error => {
    if (RUNTIME_PERSIST_WORKER === worker) RUNTIME_PERSIST_WORKER = null;
    RUNTIME_PERSIST_ACTIVE = false;
    RUNTIME_PERSIST_JOBS.clear();
    rejectRuntimePersistenceWaiters(
      error instanceof Error
        ? error
        : new Error(String(error || "Catalog persistence worker exited."))
    );
  };
  worker.on("error", rejectAll);
  worker.on("exit", code => {
    if (code !== 0) rejectAll(new Error(`Catalog persistence worker exited with code ${code}.`));
    else if (RUNTIME_PERSIST_WORKER === worker) RUNTIME_PERSIST_WORKER = null;
  });

  RUNTIME_PERSIST_WORKER = worker;
  return worker;
}

function kickRuntimePersistence() {
  if (RUNTIME_PERSIST_ACTIVE) return;
  const request = RUNTIME_PERSIST_LATEST;
  if (!request || Number(request.epoch) <= LAST_DURABLE_PERSISTENCE_EPOCH) {
    resolveRuntimePersistenceWaiters();
    return;
  }

  RUNTIME_PERSIST_ACTIVE = true;
  const snapshotStartedAt = Date.now();
  let snapshot;
  try {
    // v8.serialize gives us an immutable point-in-time snapshot far faster than
    // JSON.stringify. Everything expensive after this capture happens off-thread.
    snapshot = v8.serialize(request.data);
  } catch (error) {
    RUNTIME_PERSIST_ACTIVE = false;
    rejectRuntimePersistenceWaiters(error);
    return;
  }

  const id = ++RUNTIME_PERSIST_JOB_ID;
  RUNTIME_PERSIST_JOBS.set(id, {
    id,
    epoch: Number(request.epoch),
    data: request.data,
    reason: request.reason,
    snapshotDurationMs: Date.now() - snapshotStartedAt,
  });

  try {
    runtimePersistenceWorker().postMessage(
      {
        id,
        payload: snapshot.buffer,
        pretty: String(process.env.DB_PRETTY_JSON || "false").toLowerCase() === "true",
        fsync: String(process.env.DB_FSYNC_WRITES || "false").toLowerCase() === "true",
      },
      [snapshot.buffer]
    );
  } catch (error) {
    RUNTIME_PERSIST_JOBS.delete(id);
    RUNTIME_PERSIST_ACTIVE = false;
    rejectRuntimePersistenceWaiters(error);
  }
}

async function writeDbOffThread(data, { reason = "runtime" } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (PENDING_DEFERRED_WRITE) {
    clearTimeout(PENDING_DEFERRED_WRITE);
    PENDING_DEFERRED_WRITE = null;
  }
  DEFERRED_WRITE_GENERATION++;

  DB_CACHE = data;
  DB_REVISION++;
  data.meta ||= {};
  data.meta.dbRevision = DB_REVISION;
  data.meta.lastWriteAt = nowIso();

  const epoch = ++PERSISTENCE_EPOCH;
  RUNTIME_PERSIST_LATEST = {
    epoch,
    data,
    reason: String(reason || "runtime").slice(0, 160),
  };

  const promise = new Promise((resolve, reject) => {
    RUNTIME_PERSIST_WAITERS.push({ epoch, reason, resolve, reject });
  });
  kickRuntimePersistence();
  return promise;
}

function writeDb(data, { onProgress = null } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (PENDING_DEFERRED_WRITE) {
    clearTimeout(PENDING_DEFERRED_WRITE);
    PENDING_DEFERRED_WRITE = null;
  }
  DEFERRED_WRITE_GENERATION++;
  const persistenceEpoch = ++PERSISTENCE_EPOCH;

  DB_CACHE = data;
  DB_REVISION++;

  data.meta ||= {};
  data.meta.dbRevision = DB_REVISION;
  data.meta.lastWriteAt = nowIso();

  const pretty =
    String(process.env.DB_PRETTY_JSON || "false").toLowerCase() === "true";

  const serializeStartedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "catalog-serialize",
    state: "start",
    message: "serializing initialized catalog",
  });
  const serialized = JSON.stringify(data, null, pretty ? 2 : 0);
  emitDbStartupProgress(onProgress, {
    phase: "catalog-serialize",
    state: "done",
    durationMs: Date.now() - serializeStartedAt,
    totalBytes: Buffer.byteLength(serialized, "utf8"),
    message: `serialized ${Buffer.byteLength(serialized, "utf8").toLocaleString()} bytes`,
  });

  const writeStartedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "catalog-write",
    state: "start",
    message: "writing catalog.json atomically",
  });
  fs.writeFileSync(TMP_FILE, serialized, { encoding: "utf8", mode: 0o600 });
  if (String(process.env.DB_FSYNC_WRITES || "false").toLowerCase() === "true") {
    const fd = fs.openSync(TMP_FILE, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  fs.renameSync(TMP_FILE, DB_FILE);
  LAST_DURABLE_PERSISTENCE_EPOCH = Math.max(
    LAST_DURABLE_PERSISTENCE_EPOCH,
    persistenceEpoch
  );
  resolveRuntimePersistenceWaiters();
  emitDbStartupProgress(onProgress, {
    phase: "catalog-write",
    state: "done",
    durationMs: Date.now() - writeStartedAt,
    message: "catalog.json persisted",
  });

  finalizePersistedIntelligenceEvents(data);

}

export function getDbRevision() {
  return DB_REVISION;
}

export function getSearchIndexRevision() {
  return SEARCH_INDEX_REVISION;
}

function scheduleDeferredWrite(data, delayMs = 750) {
  DB_CACHE = data;
  const generation = ++DEFERRED_WRITE_GENERATION;

  if (PENDING_DEFERRED_WRITE) {
    clearTimeout(PENDING_DEFERRED_WRITE);
  }

  PENDING_DEFERRED_WRITE = setTimeout(() => {
    PENDING_DEFERRED_WRITE = null;

    // Deferred persistence is never allowed to jump ahead of a shopper/admin
    // request. Wait for a short quiet window before the unavoidable atomic
    // JSON snapshot. If newer mutations arrived while we waited, the newer
    // generation owns the eventual write.
    waitForInteractiveIdle({
      reason: "deferred-catalog-persistence",
      quietMs: Math.max(
        Number(
          process.env.DEFERRED_WRITE_QUIET_MS ||
          (String(process.env.CAMPAIGN_TRAFFIC_MODE || "false").toLowerCase() === "true" ? 60_000 : 500)
        ),
        50
      ),
    }).then(() => {
      if (generation !== DEFERRED_WRITE_GENERATION) return;
      return writeDbOffThread(DB_CACHE, { reason: "deferred-catalog-persistence" });
    }).catch(error => {
      console.warn("[db] deferred catalog persistence failed:", error?.message || error);
    });
  }, Math.max(100, Number(delayMs || 750)));

  PENDING_DEFERRED_WRITE.unref?.();
}


function clearMutationBufferTimers() {
  if (MUTATION_BUFFER_TIMER) clearTimeout(MUTATION_BUFFER_TIMER);
  if (MUTATION_BUFFER_HARD_TIMER) clearTimeout(MUTATION_BUFFER_HARD_TIMER);
  MUTATION_BUFFER_TIMER = null;
  MUTATION_BUFFER_HARD_TIMER = null;
}

function armMutationBufferTimers() {
  if (!PENDING_RUNTIME_MUTATIONS.size) {
    clearMutationBufferTimers();
    MUTATION_BUFFER_FIRST_QUEUED_AT = 0;
    return;
  }

  if (MUTATION_BUFFER_TIMER) clearTimeout(MUTATION_BUFFER_TIMER);
  MUTATION_BUFFER_TIMER = setTimeout(() => {
    MUTATION_BUFFER_TIMER = null;
    void flushRuntimeMutationBuffer({ reason: "sliding-window" });
  }, MUTATION_BUFFER_WINDOW_MS);
  MUTATION_BUFFER_TIMER.unref?.();

  if (!MUTATION_BUFFER_HARD_TIMER) {
    const elapsed = MUTATION_BUFFER_FIRST_QUEUED_AT
      ? Date.now() - MUTATION_BUFFER_FIRST_QUEUED_AT
      : 0;
    MUTATION_BUFFER_HARD_TIMER = setTimeout(() => {
      MUTATION_BUFFER_HARD_TIMER = null;
      void flushRuntimeMutationBuffer({ reason: "max-age" });
    }, Math.max(100, MUTATION_BUFFER_MAX_AGE_MS - elapsed));
    MUTATION_BUFFER_HARD_TIMER.unref?.();
  }
}

function queueRuntimeProductMutation(
  data,
  productIds = [],
  {
    forceHistoryProductIds = [],
    reason = "runtime-mutation",
    lookup = null,
  } = {}
) {
  const ids = [...new Set(
    Array.from(productIds || []).map(Number).filter(Number.isFinite)
  )];
  if (!ids.length) return;

  DB_CACHE = data;
  const forceSet = new Set(
    Array.from(forceHistoryProductIds || []).map(Number).filter(Number.isFinite)
  );
  const at = Date.now();

  refreshProductFastCachesForIdsInDb(data, ids, { lookup });
  markProductsIntelligenceDirtyInDb(data, ids, reason);

  if (!MUTATION_BUFFER_FIRST_QUEUED_AT) MUTATION_BUFFER_FIRST_QUEUED_AT = at;

  for (const productId of ids) {
    const existing = PENDING_RUNTIME_MUTATIONS.get(productId);
    const reasons = new Set(existing?.reasons || []);
    reasons.add(String(reason || "runtime-mutation").slice(0, 120));
    PENDING_RUNTIME_MUTATIONS.set(productId, {
      productId,
      forceHistory: Boolean(existing?.forceHistory || forceSet.has(productId)),
      firstQueuedAt: existing?.firstQueuedAt || at,
      lastQueuedAt: at,
      reasons: [...reasons].slice(-8),
    });
  }

  if (PENDING_RUNTIME_MUTATIONS.size >= MUTATION_BUFFER_MAX_PRODUCTS) {
    clearMutationBufferTimers();
    setImmediate(() => void flushRuntimeMutationBuffer({ reason: "threshold" }));
    return;
  }

  armMutationBufferTimers();
}

export function flushRuntimeMutationBuffer({ reason = "manual", force = false } = {}) {
  const execute = async () => {
    if (!PENDING_RUNTIME_MUTATIONS.size) return {
      flushed: 0,
      recordedHistory: 0,
      reason,
    };

    const captured = [...PENDING_RUNTIME_MUTATIONS.values()];
    PENDING_RUNTIME_MUTATIONS.clear();
    clearMutationBufferTimers();
    MUTATION_BUFFER_FIRST_QUEUED_AT = 0;

    if (!force) {
      await waitForInteractiveIdle({
        reason: `mutation-buffer:${reason}`,
        quietMs: Math.max(Number(process.env.MUTATION_BUFFER_QUIET_MS || 75), 25),
      });
    }

    const data = readDb();
    const productIds = captured.map(item => item.productId);
    const forceHistoryProductIds = captured
      .filter(item => item.forceHistory)
      .map(item => item.productId);

    try {
      // V3.7.47: a coalesced runtime flush is already scoped by product IDs.
      // Build relationship buckets only for those products instead of allocating
      // maps for the entire catalog during an otherwise-idle background flush.
      const lookup = buildPageHydrationLookup(data, productIds, {
        approvedOnly: false,
        includeClicks: false,
      });

      // This is the only raw-history insertion point for buffered runtime price
      // mutations. Duplicate product updates inside the window collapse to one
      // newest observation before the atomic JSON snapshot reaches NVMe.
      const recordedHistory = recordBestPricesForIdsInDb(data, productIds, {
        forceProductIds: forceHistoryProductIds,
        lookup,
      });

      refreshProductFastCachesForIdsInDb(data, productIds, { lookup });
      await writeDbOffThread(data, { reason: `mutation-buffer:${reason}` });
      MUTATION_FLUSH_COUNT++;
      MUTATION_BUFFER_LAST_FLUSH_AT = nowIso();

      // Deal Heat/MAD work begins only after the raw mutation batch is durable.
      enqueueIntelligenceProducts(productIds, {
        priority: "background",
        reason: `durable-${reason}`,
      });

      if (PENDING_RUNTIME_MUTATIONS.size) armMutationBufferTimers();

      return {
        flushed: productIds.length,
        recordedHistory,
        reason,
      };
    } catch (error) {
      // Never lose a captured RAM batch because the NVMe write failed. Merge
      // it back into the live coalescing map; a later timer/manual flush can
      // retry the same newest product state. The in-memory DB is intentionally
      // left intact, so a partially prepared history point is not discarded.
      const now = Date.now();
      for (const item of captured) {
        const existing = PENDING_RUNTIME_MUTATIONS.get(item.productId);
        const reasons = new Set([
          ...(item.reasons || []),
          ...(existing?.reasons || []),
          "flush-retry",
        ]);
        PENDING_RUNTIME_MUTATIONS.set(item.productId, {
          productId: item.productId,
          forceHistory: Boolean(item.forceHistory || existing?.forceHistory),
          firstQueuedAt: Math.min(
            Number(item.firstQueuedAt || now),
            Number(existing?.firstQueuedAt || now)
          ),
          lastQueuedAt: Math.max(
            Number(item.lastQueuedAt || 0),
            Number(existing?.lastQueuedAt || 0),
            now
          ),
          reasons: [...reasons].slice(-8),
        });
      }
      MUTATION_BUFFER_FIRST_QUEUED_AT = [...PENDING_RUNTIME_MUTATIONS.values()]
        .reduce((min, item) => Math.min(min, Number(item.firstQueuedAt || now)), now);
      armMutationBufferTimers();
      throw error;
    }
  };

  MUTATION_FLUSH_CHAIN = MUTATION_FLUSH_CHAIN.then(execute, execute);
  return MUTATION_FLUSH_CHAIN;
}

export function getRuntimeMutationBufferStatus() {
  const first = [...PENDING_RUNTIME_MUTATIONS.values()]
    .reduce((min, item) => Math.min(min, Number(item.firstQueuedAt || Infinity)), Infinity);
  return {
    pendingProducts: PENDING_RUNTIME_MUTATIONS.size,
    windowMs: MUTATION_BUFFER_WINDOW_MS,
    maxAgeMs: MUTATION_BUFFER_MAX_AGE_MS,
    thresholdProducts: MUTATION_BUFFER_MAX_PRODUCTS,
    oldestPendingMs: Number.isFinite(first) ? Math.max(0, Date.now() - first) : 0,
    flushCount: MUTATION_FLUSH_COUNT,
    lastFlushAt: MUTATION_BUFFER_LAST_FLUSH_AT,
  };
}

function norm(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function canonicalKey(candidate) {
  return candidateCanonicalKey(candidate);
}

function normalizeCategory(value) {
  if (!value) return "Other";
  const parts = String(value).split(/\s*>\s*|\s*\/\s*/).map(v => v.trim()).filter(Boolean);
  return (parts.at(-1) || "Other").slice(0, 200);
}

const DAY_MS = 86_400_000;

function lifecycleNumber(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function lifecycleEnabled() {
  return String(process.env.PRODUCT_LIFECYCLE_ENABLED || "true").toLowerCase() !== "false";
}

function normalizeLifecycleIdentityText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lifecycleIdentityKey(product) {
  const strong = strongIdentityBaseKey(product || {});
  if (strong) {
    const variant = variantIdentityDiscriminator(product?.title || "");
    return variant ? `${strong}:variant:${variant}` : strong;
  }

  const brand = normalizeLifecycleIdentityText(product?.brand);
  const title = normalizeLifecycleIdentityText(product?.title);
  return `title:${brand}:${title}`;
}

function maxIso(...values) {
  let best = 0;
  for (const value of values.flat()) {
    const at = Date.parse(value || "");
    if (Number.isFinite(at) && at > best) best = at;
  }
  return best ? new Date(best).toISOString() : null;
}

function migrateLifecycleMetadata(data) {
  data.meta ||= {};
  data.meta.lifecycleVersion = Math.max(1, Number(data.meta.lifecycleVersion || 1));

  const activeByProduct = new Map();
  const observedByProduct = new Map();

  for (const offer of data.offers) {
    const productId = Number(offer.productId);
    const observed = maxIso(
      offer.lastSeen,
      offer.searchObservedAt,
      offer.priceVerifiedAt
    );

    if (observed) {
      observedByProduct.set(
        productId,
        maxIso(observedByProduct.get(productId), observed)
      );
    }

    if (offer.availability !== "out_of_stock" && offer.lastSeen) {
      activeByProduct.set(
        productId,
        maxIso(activeByProduct.get(productId), offer.lastSeen)
      );
    }
  }

  for (const point of data.priceHistory) {
    const productId = Number(point.productId);
    observedByProduct.set(
      productId,
      maxIso(observedByProduct.get(productId), point.at)
    );
  }

  for (const aggregate of data.priceAggregates) {
    const productId = Number(aggregate.productId);
    observedByProduct.set(
      productId,
      maxIso(
        observedByProduct.get(productId),
        aggregate.endAt,
        aggregate.startAt
      )
    );
  }

  for (const product of data.products) {
    const fallback = product.createdAt || product.updatedAt || nowIso();

    product.lifecycleNormalizedTitle =
      normalizeLifecycleIdentityText(product.title);
    product.lifecycleNormalizedBrand =
      normalizeLifecycleIdentityText(product.brand);
    product.lifecycleIdentityKey =
      lifecycleIdentityKey(product);

    product.lifecycleLastActiveAt =
      maxIso(
        product.lifecycleLastActiveAt,
        activeByProduct.get(Number(product.id))
      ) ||
      product.lifecycleLastActiveAt ||
      fallback;

    product.lifecycleLastObservationAt =
      maxIso(
        product.lifecycleLastObservationAt,
        observedByProduct.get(Number(product.id)),
        product.lifecycleLastActiveAt
      ) ||
      product.lifecycleLastObservationAt ||
      product.lifecycleLastActiveAt ||
      fallback;

    product.lifecycleStateChangedAt ||=
      product.updatedAt || product.createdAt || nowIso();
  }
}

function productHasActiveOffer(data, productId, lifecycleIndex = null) {
  const numericId = Number(productId);
  if (lifecycleIndex?.activeProductIds) {
    return lifecycleIndex.activeProductIds.has(numericId);
  }

  return data.offers.some(
    offer =>
      Number(offer.productId) === numericId &&
      offer.availability !== "out_of_stock"
  );
}

function productLatestActiveOfferAt(data, productId, lifecycleIndex = null) {
  const numericId = Number(productId);
  if (lifecycleIndex?.latestActiveOfferAtByProduct) {
    return lifecycleIndex.latestActiveOfferAtByProduct.get(numericId) || null;
  }

  let latest = null;

  for (const offer of data.offers) {
    if (
      Number(offer.productId) !== numericId ||
      offer.availability === "out_of_stock"
    ) continue;

    latest = maxIso(latest, offer.lastSeen, offer.priceVerifiedAt);
  }

  return latest;
}

function productLatestObservationAt(data, productId, lifecycleIndex = null) {
  const numericId = Number(productId);
  if (lifecycleIndex?.latestObservationAtByProduct) {
    return lifecycleIndex.latestObservationAtByProduct.get(numericId) || null;
  }

  let latest = null;

  for (const offer of data.offers) {
    if (Number(offer.productId) !== numericId) continue;
    latest = maxIso(
      latest,
      offer.searchObservedAt,
      offer.priceVerifiedAt,
      offer.lastSeen
    );
  }

  for (const point of data.priceHistory) {
    if (Number(point.productId) !== numericId) continue;
    latest = maxIso(latest, point.at);
  }

  for (const aggregate of data.priceAggregates) {
    if (Number(aggregate.productId) !== numericId) continue;
    latest = maxIso(latest, aggregate.endAt, aggregate.startAt);
  }

  return latest;
}

function isoWeekBucket(at) {
  const original = new Date(at);
  if (!Number.isFinite(original.getTime())) return "";

  const date = new Date(Date.UTC(
    original.getUTCFullYear(),
    original.getUTCMonth(),
    original.getUTCDate()
  ));

  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);

  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((date - yearStart) / DAY_MS) + 1) / 7);

  return `${year}-W${String(week).padStart(2, "0")}`;
}

function monthBucket(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dayBucket(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function aggregateBucket(at, granularity) {
  if (granularity === "month") return monthBucket(at);
  if (granularity === "week") return isoWeekBucket(at);
  return dayBucket(at);
}

function aggregateKey(productId, granularity, bucket, currency) {
  return `${Number(productId)}|${granularity}|${bucket}|${String(currency || "USD")}`;
}

function mergeAggregate(target, sample) {
  const countA = Math.max(0, Number(target.sampleCount || 0));
  const countB = Math.max(1, Number(sample.sampleCount || 1));
  const total = countA + countB;

  const avgA = Number(target.average || 0);
  const avgB = Number(sample.average ?? sample.price ?? 0);

  const startA = Date.parse(target.startAt || "");
  const startB = Date.parse(sample.startAt || sample.at || "");
  const endA = Date.parse(target.endAt || "");
  const endB = Date.parse(sample.endAt || sample.at || "");

  if (!countA || (Number.isFinite(startB) && (!Number.isFinite(startA) || startB < startA))) {
    target.firstPrice = Number(sample.firstPrice ?? sample.price ?? sample.average ?? 0);
  }

  if (!countA || (Number.isFinite(endB) && (!Number.isFinite(endA) || endB >= endA))) {
    target.lastPrice = Number(sample.lastPrice ?? sample.price ?? sample.average ?? 0);
  }

  target.sampleCount = total;
  target.low =
    !countA
      ? Number(sample.low ?? sample.price ?? sample.average ?? 0)
      : Math.min(
          Number(target.low),
          Number(sample.low ?? sample.price ?? sample.average ?? 0)
        );
  target.high =
    !countA
      ? Number(sample.high ?? sample.price ?? sample.average ?? 0)
      : Math.max(
          Number(target.high),
          Number(sample.high ?? sample.price ?? sample.average ?? 0)
        );
  target.average =
    total
      ? ((avgA * countA) + (avgB * countB)) / total
      : avgB;
  target.startAt =
    maxIso(target.startAt, sample.startAt || sample.at)
      ? new Date(
          Math.min(
            Number.isFinite(startA) ? startA : Number.MAX_SAFE_INTEGER,
            Number.isFinite(startB) ? startB : Number.MAX_SAFE_INTEGER
          )
        ).toISOString()
      : String(sample.startAt || sample.at || "");
  target.endAt = maxIso(target.endAt, sample.endAt || sample.at) || target.endAt;
  target.verifiedCount =
    Math.max(0, Number(target.verifiedCount || 0)) +
    Math.max(
      0,
      Number(
        sample.verifiedCount ??
        (sample.verifiedAt ? 1 : 0)
      )
    );
  target.conditionScope =
    target.conditionScope === "deal-eligible" && sample.conditionScope === "deal-eligible"
      ? "deal-eligible"
      : "legacy-unknown";

  return target;
}

function aggregateRecordFromPoint(point, granularity) {
  const bucket = aggregateBucket(point.at, granularity);
  return {
    productId: Number(point.productId),
    granularity,
    bucket,
    startAt: point.at,
    endAt: point.at,
    sampleCount: 1,
    low: Number(point.price),
    high: Number(point.price),
    average: Number(point.price),
    firstPrice: Number(point.price),
    lastPrice: Number(point.price),
    currency: String(point.currency || "USD").slice(0, 12),
    verifiedCount: point.verifiedAt ? 1 : 0,
    source: "compressed-price-history",
    // Raw points only reach compression after the same trust/condition gate
    // used by Deal Heat, so V3.7.47-created buckets have known provenance.
    conditionScope: "deal-eligible",
  };
}

function mergeAggregateIntoMap(map, record) {
  if (!record?.bucket || !Number.isFinite(Number(record.productId))) return;

  const key = aggregateKey(
    record.productId,
    record.granularity,
    record.bucket,
    record.currency
  );

  if (!map.has(key)) {
    map.set(key, {
      ...record,
      sampleCount: 0,
      low: Number.POSITIVE_INFINITY,
      high: Number.NEGATIVE_INFINITY,
      average: 0,
      verifiedCount: 0,
    });
  }

  mergeAggregate(map.get(key), record);
}

function compressPriceHistoryInDb(
  data,
  {
    force = false,
    archiveProductIds = [],
    onProgress = null,
    lookup = null,
  } = {}
) {
  const now = Date.now();
  const compressionHours = Math.max(
    1,
    lifecycleNumber("PRICE_COMPRESSION_HOURS", 12, 1, 168)
  );
  const lastRun = Date.parse(data.meta?.lastPriceCompressionAt || "");

  if (
    !force &&
    Number.isFinite(lastRun) &&
    now - lastRun < compressionHours * 3_600_000
  ) {
    return {
      skipped: true,
      rawPointsCompressed: 0,
      aggregatesCreated: 0,
      aggregatesRetained: data.priceAggregates.length,
    };
  }

  const rawDays = Math.max(
    30,
    lifecycleNumber("PRICE_HISTORY_RAW_DAYS", 90, 30, 3650)
  );
  const weeklyDays = Math.max(
    rawDays,
    lifecycleNumber("PRICE_HISTORY_WEEKLY_DAYS", 365, rawDays, 3650)
  );
  const aggregateRetentionDays = Math.max(
    weeklyDays,
    lifecycleNumber(
      "PRICE_AGGREGATE_RETENTION_DAYS",
      3650,
      weeklyDays,
      36500
    )
  );

  const archiveSet = new Set(
    (archiveProductIds || []).map(Number).filter(Number.isFinite)
  );

  const aggregateMap = new Map();
  const existingAggregates = data.priceAggregates || [];
  const aggregateCompressionStartedAt = Date.now();

  emitDbStartupProgress(onProgress, {
    phase: "price-compression-aggregates",
    state: "start",
    current: 0,
    total: existingAggregates.length,
    message: "rebucketing retained weekly/monthly price aggregates",
  });

  // Rebucket old weekly aggregates into monthly aggregates as they age.
  for (let aggregateIndex = 0; aggregateIndex < existingAggregates.length; aggregateIndex++) {
    const aggregate = existingAggregates[aggregateIndex];
    const endAt = Date.parse(aggregate.endAt || aggregate.startAt || "");

    if (Number.isFinite(endAt)) {
      const ageDays = (now - endAt) / DAY_MS;

      if (ageDays <= aggregateRetentionDays) {
        let granularity = aggregate.granularity;
        if (
          archiveSet.has(Number(aggregate.productId)) ||
          (granularity === "week" && ageDays >= weeklyDays)
        ) {
          granularity = "month";
        }

        const record = {
          ...aggregate,
          granularity,
          bucket: aggregateBucket(
            aggregate.endAt || aggregate.startAt,
            granularity
          ),
        };

        mergeAggregateIntoMap(aggregateMap, record);
      }
    }

    emitDbStartupProgress(onProgress, {
      phase: "price-compression-aggregates",
      state: aggregateIndex + 1 === existingAggregates.length ? "done" : "progress",
      current: aggregateIndex + 1,
      total: existingAggregates.length,
      durationMs: Date.now() - aggregateCompressionStartedAt,
      message: "rebucketing retained weekly/monthly price aggregates",
    });
  }

  if (!existingAggregates.length) {
    emitDbStartupProgress(onProgress, {
      phase: "price-compression-aggregates",
      state: "done",
      current: 0,
      total: 0,
      durationMs: Date.now() - aggregateCompressionStartedAt,
      message: "no retained aggregates required rebucketing",
    });
  }

  const retainedRaw = [];
  let compressed = 0;
  const blockedHistoryOfferIds = blockedCompetitorHistoryOfferIds(data, {
    onProgress,
    lookup,
  });

  const rawHistory = data.priceHistory || [];
  const rawCompressionStartedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "price-compression-raw-history",
    state: "start",
    current: 0,
    total: rawHistory.length,
    message: "compacting aged raw price observations into retained aggregates",
  });

  for (let rawIndex = 0; rawIndex < rawHistory.length; rawIndex++) {
    const point = rawHistory[rawIndex];

    if (!blockedHistoryOfferIds.has(Number(point.offerId))) {
      const at = Date.parse(point.at || "");

      if (Number.isFinite(at) && Number.isFinite(Number(point.price))) {
        const ageDays = (now - at) / DAY_MS;
        const forceArchive = archiveSet.has(Number(point.productId));

        if (!forceArchive && ageDays < rawDays) {
          retainedRaw.push(point);
        } else {
          const granularity =
            forceArchive || ageDays >= weeklyDays
              ? "month"
              : "week";

          mergeAggregateIntoMap(
            aggregateMap,
            aggregateRecordFromPoint(point, granularity)
          );
          compressed++;
        }
      }
    }

    emitDbStartupProgress(onProgress, {
      phase: "price-compression-raw-history",
      state: rawIndex + 1 === rawHistory.length ? "done" : "progress",
      current: rawIndex + 1,
      total: rawHistory.length,
      durationMs: Date.now() - rawCompressionStartedAt,
      message: "compacting aged raw price observations into retained aggregates",
    });
  }

  if (!rawHistory.length) {
    emitDbStartupProgress(onProgress, {
      phase: "price-compression-raw-history",
      state: "done",
      current: 0,
      total: 0,
      durationMs: Date.now() - rawCompressionStartedAt,
      message: "no raw price observations required compression",
    });
  }

  data.priceHistory = retainedRaw;
  data.priceAggregates = [...aggregateMap.values()]
    .map(item => ({
      ...item,
      low: Math.round(Number(item.low) * 100) / 100,
      high: Math.round(Number(item.high) * 100) / 100,
      average: Math.round(Number(item.average) * 100) / 100,
      firstPrice: Math.round(Number(item.firstPrice) * 100) / 100,
      lastPrice: Math.round(Number(item.lastPrice) * 100) / 100,
    }))
    .sort((a, b) =>
      Number(a.productId) - Number(b.productId) ||
      Date.parse(a.startAt || 0) - Date.parse(b.startAt || 0)
    );

  data.meta ||= {};
  data.meta.lastPriceCompressionAt = nowIso();

  return {
    skipped: false,
    rawPointsCompressed: compressed,
    rawPointsRetained: data.priceHistory.length,
    aggregatesRetained: data.priceAggregates.length,
    aggregatesCreated: data.priceAggregates.length,
    rawDays,
    weeklyDays,
    aggregateRetentionDays,
  };
}

function lifecycleHistorySampleCount(data, productId, lifecycleIndex = null) {
  const numericId = Number(productId);
  if (lifecycleIndex?.historySampleCountByProduct) {
    return Number(lifecycleIndex.historySampleCountByProduct.get(numericId) || 0);
  }

  const raw = data.priceHistory.filter(
    point => Number(point.productId) === numericId
  ).length;

  const compressed = data.priceAggregates
    .filter(item => Number(item.productId) === numericId)
    .reduce(
      (sum, item) => sum + Math.max(1, Number(item.sampleCount || 1)),
      0
    );

  return raw + compressed;
}

function lifecyclePriceSummary(data, productId, lifecycleIndex = null) {
  const numericId = Number(productId);
  const rawPoints = lifecycleIndex?.rawHistoryByProduct
    ? lifecycleIndex.rawHistoryByProduct.get(numericId) || []
    : data.priceHistory.filter(point => Number(point.productId) === numericId);
  const aggregates = lifecycleIndex?.aggregatesByProduct
    ? lifecycleIndex.aggregatesByProduct.get(numericId) || []
    : data.priceAggregates.filter(item => Number(item.productId) === numericId);

  const prices = [];
  let weightedTotal = 0;
  let samples = 0;
  let firstAt = null;
  let lastAt = null;
  let lastPrice = null;
  let lastMs = -1;

  for (const point of rawPoints) {
    const price = Number(point.price);
    if (!Number.isFinite(price)) continue;

    prices.push(price);
    weightedTotal += price;
    samples++;

    const at = Date.parse(point.at || "");
    if (Number.isFinite(at)) {
      firstAt = firstAt
        ? new Date(Math.min(Date.parse(firstAt), at)).toISOString()
        : new Date(at).toISOString();
      lastAt = lastAt
        ? new Date(Math.max(Date.parse(lastAt), at)).toISOString()
        : new Date(at).toISOString();

      if (at >= lastMs) {
        lastMs = at;
        lastPrice = price;
      }
    }
  }

  for (const aggregate of aggregates) {
    const count = Math.max(1, Number(aggregate.sampleCount || 1));
    const average = Number(aggregate.average);
    if (!Number.isFinite(average)) continue;

    prices.push(Number(aggregate.low));
    prices.push(Number(aggregate.high));
    weightedTotal += average * count;
    samples += count;

    const start = Date.parse(aggregate.startAt || "");
    const end = Date.parse(aggregate.endAt || "");

    if (Number.isFinite(start)) {
      firstAt = firstAt
        ? new Date(Math.min(Date.parse(firstAt), start)).toISOString()
        : new Date(start).toISOString();
    }

    if (Number.isFinite(end)) {
      lastAt = lastAt
        ? new Date(Math.max(Date.parse(lastAt), end)).toISOString()
        : new Date(end).toISOString();

      if (end >= lastMs) {
        lastMs = end;
        lastPrice = Number(aggregate.lastPrice ?? average);
      }
    }
  }

  const finite = prices.filter(Number.isFinite);

  return {
    sampleCount: samples,
    firstObservedAt: firstAt,
    lastObservedAt: lastAt,
    low: finite.length
      ? Math.round(Math.min(...finite) * 100) / 100
      : null,
    high: finite.length
      ? Math.round(Math.max(...finite) * 100) / 100
      : null,
    average: samples
      ? Math.round((weightedTotal / samples) * 100) / 100
      : null,
    lastPrice:
      Number.isFinite(lastPrice)
        ? Math.round(lastPrice * 100) / 100
        : null,
  };
}

function lifecycleClickSummary(data, productId, lifecycleIndex = null) {
  const numericId = Number(productId);
  const clicks = lifecycleIndex?.clicksByProduct
    ? [...(lifecycleIndex.clicksByProduct.get(numericId) || [])]
    : data.clicks.filter(click => Number(click.productId) === numericId);

  clicks.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));

  const product = lifecycleIndex?.productByNumericId
    ? lifecycleIndex.productByNumericId.get(numericId)
    : data.products.find(p => Number(p.id) === numericId);

  return {
    lifetimeClicks:
      Number(product?.lifecycleClickSummary?.lifetimeClicks || 0) + clicks.length,
    firstClickAt: clicks[0]?.at || null,
    lastClickAt: clicks.at(-1)?.at || null,
  };
}

function buildLifecycleLookupIndex(data, { onProgress = null } = {}) {
  const products = Array.isArray(data.products) ? data.products : [];
  const offers = Array.isArray(data.offers) ? data.offers : [];
  const rawHistory = Array.isArray(data.priceHistory) ? data.priceHistory : [];
  const aggregates = Array.isArray(data.priceAggregates) ? data.priceAggregates : [];
  const clicks = Array.isArray(data.clicks) ? data.clicks : [];
  const total = products.length + offers.length + rawHistory.length + aggregates.length + clicks.length;
  const startedAt = Date.now();
  let current = 0;

  const productByNumericId = new Map();
  const offersByProductId = new Map();
  const rawHistoryByProduct = new Map();
  const aggregatesByProduct = new Map();
  const clicksByProduct = new Map();
  const activeProductIds = new Set();
  const latestActiveOfferAtByProduct = new Map();
  const latestObservationAtByProduct = new Map();
  const historySampleCountByProduct = new Map();
  const clickCountByProduct = new Map();
  const recentClickProductIds = new Set();
  const recentClickCutoff = Date.now() - 365 * DAY_MS;

  emitDbStartupProgress(onProgress, {
    phase: "lifecycle-lookup-index",
    state: "start",
    current: 0,
    total,
    message: "building one-pass lifecycle evidence indexes",
  });

  function advance(message) {
    current++;
    emitDbStartupProgress(onProgress, {
      phase: "lifecycle-lookup-index",
      state: current === total ? "done" : "progress",
      current,
      total,
      durationMs: Date.now() - startedAt,
      message,
    });
  }

  for (const product of products) {
    const id = Number(product.id);
    if (Number.isFinite(id)) productByNumericId.set(id, product);
    advance("indexing lifecycle products");
  }

  for (const offer of offers) {
    const id = Number(offer.productId);
    if (Number.isFinite(id)) {
      if (!offersByProductId.has(id)) offersByProductId.set(id, []);
      offersByProductId.get(id).push(offer);

      latestObservationAtByProduct.set(
        id,
        maxIso(
          latestObservationAtByProduct.get(id),
          offer.searchObservedAt,
          offer.priceVerifiedAt,
          offer.lastSeen
        )
      );

      if (offer.availability !== "out_of_stock") {
        activeProductIds.add(id);
        latestActiveOfferAtByProduct.set(
          id,
          maxIso(
            latestActiveOfferAtByProduct.get(id),
            offer.lastSeen,
            offer.priceVerifiedAt
          )
        );
      }
    }
    advance("indexing lifecycle offer evidence");
  }

  for (const point of rawHistory) {
    const id = Number(point.productId);
    if (Number.isFinite(id)) {
      if (!rawHistoryByProduct.has(id)) rawHistoryByProduct.set(id, []);
      rawHistoryByProduct.get(id).push(point);
      historySampleCountByProduct.set(
        id,
        Number(historySampleCountByProduct.get(id) || 0) + 1
      );
      latestObservationAtByProduct.set(
        id,
        maxIso(latestObservationAtByProduct.get(id), point.at)
      );
    }
    advance("indexing lifecycle raw price evidence");
  }

  for (const aggregate of aggregates) {
    const id = Number(aggregate.productId);
    if (Number.isFinite(id)) {
      if (!aggregatesByProduct.has(id)) aggregatesByProduct.set(id, []);
      aggregatesByProduct.get(id).push(aggregate);
      historySampleCountByProduct.set(
        id,
        Number(historySampleCountByProduct.get(id) || 0) +
          Math.max(1, Number(aggregate.sampleCount || 1))
      );
      latestObservationAtByProduct.set(
        id,
        maxIso(
          latestObservationAtByProduct.get(id),
          aggregate.endAt,
          aggregate.startAt
        )
      );
    }
    advance("indexing lifecycle compressed price evidence");
  }

  for (const click of clicks) {
    const id = Number(click.productId);
    if (Number.isFinite(id)) {
      if (!clicksByProduct.has(id)) clicksByProduct.set(id, []);
      clicksByProduct.get(id).push(click);
      clickCountByProduct.set(id, Number(clickCountByProduct.get(id) || 0) + 1);
      const clickedAt = Date.parse(click.at || "");
      if (Number.isFinite(clickedAt) && clickedAt >= recentClickCutoff) {
        recentClickProductIds.add(id);
      }
    }
    advance("indexing lifecycle click evidence");
  }

  if (!total) {
    emitDbStartupProgress(onProgress, {
      phase: "lifecycle-lookup-index",
      state: "done",
      current: 0,
      total: 0,
      durationMs: Date.now() - startedAt,
      message: "no lifecycle evidence required indexing",
    });
  }

  return {
    productByNumericId,
    offersByProductId,
    rawHistoryByProduct,
    aggregatesByProduct,
    clicksByProduct,
    activeProductIds,
    latestActiveOfferAtByProduct,
    latestObservationAtByProduct,
    historySampleCountByProduct,
    clickCountByProduct,
    recentClickProductIds,
  };
}

function lifecycleProtection(data, product, inactivityDays, lifecycleIndex = null) {
  const reasons = [];
  let score = 0;

  if (product.lifecyclePinned) {
    return {
      score: 999,
      protected: true,
      pinned: true,
      reasons: ["manually-pinned"],
      eligibleAfterDays: Number.POSITIVE_INFINITY,
    };
  }

  if (String(product.gtin || "").trim()) {
    score += 3;
    reasons.push("strong-gtin");
  } else if (
    String(product.brand || "").trim() &&
    String(product.mpn || "").trim()
  ) {
    score += 3;
    reasons.push("strong-brand-mpn");
  }

  const sampleCount = lifecycleHistorySampleCount(data, product.id, lifecycleIndex);
  const historyThreshold = Math.max(
    2,
    lifecycleNumber(
      "PRODUCT_LIFECYCLE_HISTORY_PROTECTION_SAMPLES",
      12,
      2,
      10000
    )
  );

  if (sampleCount >= historyThreshold * 4) {
    score += 3;
    reasons.push("deep-price-history");
  } else if (sampleCount >= historyThreshold) {
    score += 2;
    reasons.push("meaningful-price-history");
  }

  const clickThreshold = Math.max(
    1,
    lifecycleNumber(
      "PRODUCT_LIFECYCLE_CLICK_PROTECTION_THRESHOLD",
      5,
      1,
      100000
    )
  );

  const historicalClicks =
    Math.max(
      0,
      Number(product.lifecycleClickSummary?.lifetimeClicks || 0)
    ) +
    (lifecycleIndex?.clickCountByProduct
      ? Number(lifecycleIndex.clickCountByProduct.get(Number(product.id)) || 0)
      : data.clicks.filter(
          click => Number(click.productId) === Number(product.id)
        ).length);

  if (historicalClicks >= clickThreshold) {
    score += 2;
    reasons.push("historical-user-traffic");
  }

  const recentClickCutoff = Date.now() - 365 * DAY_MS;
  if (
    lifecycleIndex?.recentClickProductIds
      ? lifecycleIndex.recentClickProductIds.has(Number(product.id))
      : data.clicks.some(
          click =>
            Number(click.productId) === Number(product.id) &&
            Date.parse(click.at || "") >= recentClickCutoff
        )
  ) {
    score += 3;
    reasons.push("recent-user-traffic");
  }

  if (product.approved || product.lifecycleWasApproved) {
    score += 1;
    reasons.push("previously-public");
  }

  if (Number(product.lifecycleReactivateCount || 0) > 0) {
    score += 1;
    reasons.push("previously-reactivated");
  }

  const protectedRetentionDays = Math.max(
    365,
    lifecycleNumber(
      "PRODUCT_PROTECTED_RETENTION_DAYS",
      730,
      365,
      3650
    )
  );

  return {
    score,
    protected: score >= 3,
    pinned: false,
    reasons,
    eligibleAfterDays:
      score >= 3
        ? protectedRetentionDays
        : Math.max(
            365,
            lifecycleNumber("PRODUCT_PRUNABLE_DAYS", 365, 365, 3650)
          ),
  };
}

function changeLifecycleState(product, nextState, at = nowIso()) {
  const state = String(nextState || "").toUpperCase();
  if (product.lifecycleState === state) return false;

  product.lifecycleState = state;
  product.lifecycleStateChangedAt = at;

  if (state !== "PRUNABLE") {
    product.lifecyclePrunableSince = null;
  } else {
    product.lifecyclePrunableSince ||= at;
  }

  return true;
}

function reactivateProductInDb(data, product, at = nowIso()) {
  if (!product) return false;

  const previous = product.lifecycleState || "ACTIVE";
  const wasArchived = previous === "ARCHIVED";

  if (previous !== "ACTIVE") {
    if (wasArchived) {
      product.lifecycleLastArchivedAt =
        product.lifecycleArchivedAt ||
        product.lifecycleLastArchivedAt ||
        at;
      product.lifecycleArchivedAt = null;
    }

    product.lifecycleReactivatedAt = at;
    product.lifecycleReactivateCount =
      Math.max(0, Number(product.lifecycleReactivateCount || 0)) + 1;
    product.lifecyclePrunableSince = null;
    changeLifecycleState(product, "ACTIVE", at);
  }

  product.lifecycleLastActiveAt = maxIso(
    product.lifecycleLastActiveAt,
    at
  );
  product.lifecycleLastObservationAt = maxIso(
    product.lifecycleLastObservationAt,
    at
  );
  product.lifecycleNormalizedTitle =
    normalizeLifecycleIdentityText(product.title);
  product.lifecycleNormalizedBrand =
    normalizeLifecycleIdentityText(product.brand);
  product.lifecycleIdentityKey = lifecycleIdentityKey(product);

  // Archived products intentionally come back as draft. Existing exact-price
  // verification/auto-approval rules decide when it is safe to republish.
  if (wasArchived) {
    product.approved = false;
  }

  return previous !== "ACTIVE";
}

function archiveProductInDb(data, product, at = nowIso(), lifecycleIndex = null, deferredRemovalProductIds = null) {
  const productId = Number(product.id);
  const offers = lifecycleIndex?.offersByProductId
    ? lifecycleIndex.offersByProductId.get(productId) || []
    : data.offers.filter(
        offer => Number(offer.productId) === productId
      );
  const providerCounts = {};

  for (const offer of offers) {
    const provider = String(offer.provider || "unknown").toLowerCase();
    providerCounts[provider] = Number(providerCounts[provider] || 0) + 1;
  }

  // The lifecycle pass force-compacts old observations before classification.
  // A product cannot be PRUNABLE while it has a recent raw price observation,
  // so there is no need to reaggregate the entire database once per archive.
  const priceSummary = lifecyclePriceSummary(data, productId, lifecycleIndex);
  const clickSummary = lifecycleClickSummary(data, productId, lifecycleIndex);
  const previousApproval = Boolean(product.approved || product.lifecycleWasApproved);

  const lastOfferSeenAt = maxIso(
    ...offers.map(offer => [
      offer.lastSeen,
      offer.searchObservedAt,
      offer.priceVerifiedAt,
    ])
  );

  product.lifecyclePriceSummary = priceSummary;
  product.lifecycleClickSummary = clickSummary;
  product.lifecycleWasApproved = previousApproval;
  product.lifecycleLastObservationAt = maxIso(
    product.lifecycleLastObservationAt,
    priceSummary.lastObservedAt,
    lastOfferSeenAt
  );
  product.lifecycleLastActiveAt = maxIso(
    product.lifecycleLastActiveAt,
    ...offers
      .filter(offer => offer.availability !== "out_of_stock")
      .map(offer => offer.lastSeen)
  );

  product.lifecycleNormalizedTitle =
    normalizeLifecycleIdentityText(product.title);
  product.lifecycleNormalizedBrand =
    normalizeLifecycleIdentityText(product.brand);
  product.lifecycleIdentityKey = lifecycleIdentityKey(product);

  product.lifecycleTombstone = {
    productId,
    canonicalKey: String(product.canonicalKey || ""),
    gtin: String(product.gtin || ""),
    mpn: String(product.mpn || ""),
    epid: String(product.epid || ""),
    normalizedTitle: product.lifecycleNormalizedTitle,
    normalizedBrand: product.lifecycleNormalizedBrand,
    title: String(product.title || "").slice(0, 500),
    brand: String(product.brand || "").slice(0, 200),
    category: String(product.category || "Other").slice(0, 200),
    createdAt: product.createdAt || null,
    lastActiveAt: product.lifecycleLastActiveAt || null,
    lastObservedAt: product.lifecycleLastObservationAt || null,
    prunableSince: product.lifecyclePrunableSince || null,
    archivedAt: at,
    previousApproval,
    offerSummary: {
      offerCount: offers.length,
      providerCounts,
      lastSeenAt: lastOfferSeenAt,
    },
    priceSummary,
    clickSummary,
  };

  if (deferredRemovalProductIds instanceof Set) {
    deferredRemovalProductIds.add(productId);
  } else {
    data.offers = data.offers.filter(
      offer => Number(offer.productId) !== productId
    );
    data.priceHistory = data.priceHistory.filter(
      point => Number(point.productId) !== productId
    );
    data.clicks = data.clicks.filter(
      click => Number(click.productId) !== productId
    );
  }

  // Keep durable identity, canonical matching, category, lifecycle summaries,
  // and compressed aggregates. Discard presentation/runtime-heavy fields.
  product.imageUrl = "";
  product.aiSummary = "";
  product.editorNote = "";
  product.tags = [];
  product.cachedBestOfferId = null;
  product.cachedBestPrice = null;
  product.cachedBestScore = 0;
  product.cachedVerificationRank = 0;
  product.cachedVerifiedSellerCount = 0;
  product.cachedPriceStats = null;
  product.cachedPriceSparkline = [];
  product.approved = false;
  product.lifecycleArchivedAt = at;
  product.updatedAt = at;
  changeLifecycleState(product, "ARCHIVED", at);

  return {
    productId,
    removedOffers: offers.length,
    priceSummary,
    clickSummary,
  };
}

function lifecycleAuditPath() {
  return path.join(DATA_DIR, "product-lifecycle.jsonl");
}

function lifecycleBackupPath() {
  return path.join(DATA_DIR, "catalog.pre-v340-lifecycle.json");
}

function appendLifecycleAudit(report) {
  try {
    fs.appendFileSync(
      lifecycleAuditPath(),
      JSON.stringify(report) + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (error) {
    console.error("[product-lifecycle] could not write audit log:", error.message);
  }
}

export function runProductLifecycleCycle({
  reason = "scheduled",
  archiveEligible = true,
  makeBackup = false,
  onProgress = null,
  deferPersistence = false,
} = {}) {
  const data = readDb();
  const at = nowIso();
  const now = Date.now();

  const dormantDays = Math.max(
    90,
    lifecycleNumber("PRODUCT_DORMANT_DAYS", 120, 90, 180)
  );
  const staleDays = Math.max(
    365,
    lifecycleNumber("PRODUCT_STALE_DAYS", 365, 365, 3650)
  );
  const prunableDays = Math.max(
    staleDays,
    lifecycleNumber("PRODUCT_PRUNABLE_DAYS", 365, 365, 3650)
  );
  const pruneGraceDays = Math.max(
    0,
    lifecycleNumber("PRODUCT_PRUNE_GRACE_DAYS", 30, 0, 365)
  );

  if (makeBackup) {
    const backup = lifecycleBackupPath();
    if (!fs.existsSync(backup) && fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, backup);
    }
  }

  const compressionStartedAt = Date.now();
  const lifecycleCompressionInputTotal =
    Number(data.priceHistory?.length || 0) + Number(data.priceAggregates?.length || 0);
  emitDbStartupProgress(onProgress, {
    phase: "lifecycle-price-compression",
    state: "start",
    current: 0,
    total: lifecycleCompressionInputTotal,
    message: "compacting lifecycle price history without discarding retained intelligence",
  });
  const compression = compressPriceHistoryInDb(data, { force: true, onProgress });
  emitDbStartupProgress(onProgress, {
    phase: "lifecycle-price-compression",
    state: "done",
    current: lifecycleCompressionInputTotal,
    total: lifecycleCompressionInputTotal,
    durationMs: Date.now() - compressionStartedAt,
    message: `${Number(compression.rawPointsCompressed || 0).toLocaleString()} raw points compressed`,
  });

  // V3.7.13: lifecycle classification used to rescan offers, price history,
  // aggregates, and clicks for every product. Build the same evidence once and
  // preserve the exact classification/protection calculations against maps.
  const lifecycleIndex = buildLifecycleLookupIndex(data, { onProgress });

  const report = {
    at,
    reason,
    thresholds: {
      dormantDays,
      staleDays,
      prunableDays,
      pruneGraceDays,
      protectedRetentionDays: Math.max(
        365,
        lifecycleNumber(
          "PRODUCT_PROTECTED_RETENTION_DAYS",
          730,
          365,
          3650
        )
      ),
    },
    before: {},
    after: {},
    transitioned: {
      ACTIVE: 0,
      DORMANT: 0,
      STALE: 0,
      PRUNABLE: 0,
      ARCHIVED: 0,
    },
    archived: 0,
    archivedOfferRowsRemoved: 0,
    protectedStale: 0,
    pinned: 0,
    compression,
  };

  for (const state of ["ACTIVE", "DORMANT", "STALE", "PRUNABLE", "ARCHIVED"]) {
    report.before[state] = 0;
  }
  for (const product of data.products) {
    const state = String(product.lifecycleState || "ACTIVE");
    if (Object.prototype.hasOwnProperty.call(report.before, state)) {
      report.before[state]++;
    }
  }

  const deferredArchiveProductIds = new Set();
  const products = Array.isArray(data.products) ? data.products : [];
  const classificationStartedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "lifecycle-classification",
    state: "start",
    current: 0,
    total: products.length,
    message: "evaluating lifecycle state and retention protection",
  });

  for (let productIndex = 0; productIndex < products.length; productIndex++) {
    const product = products[productIndex];

    if (product.lifecycleState !== "ARCHIVED") {
      const productId = Number(product.id);
      const activeOfferAt = productLatestActiveOfferAt(data, productId, lifecycleIndex);
      const observedAt = productLatestObservationAt(data, productId, lifecycleIndex);

      if (activeOfferAt) {
        product.lifecycleLastActiveAt = maxIso(
          product.lifecycleLastActiveAt,
          activeOfferAt
        );
      }

      if (observedAt) {
        product.lifecycleLastObservationAt = maxIso(
          product.lifecycleLastObservationAt,
          observedAt
        );
      }

      product.lifecycleNormalizedTitle =
        normalizeLifecycleIdentityText(product.title);
      product.lifecycleNormalizedBrand =
        normalizeLifecycleIdentityText(product.brand);
      product.lifecycleIdentityKey = lifecycleIdentityKey(product);

      const hasActive = productHasActiveOffer(data, productId, lifecycleIndex);

      if (hasActive) {
        if (changeLifecycleState(product, "ACTIVE", at)) {
          report.transitioned.ACTIVE++;
        }
      } else {
        const lastEvidenceAt = maxIso(
          product.lifecycleLastActiveAt,
          product.lifecycleLastObservationAt,
          product.createdAt
        );

        const evidenceMs = Date.parse(lastEvidenceAt || product.createdAt || at);
        const inactivityDays = Number.isFinite(evidenceMs)
          ? Math.max(0, (now - evidenceMs) / DAY_MS)
          : 0;

        const protection = lifecycleProtection(
          data,
          product,
          inactivityDays,
          lifecycleIndex
        );

        product.lifecycleProtectionScore = protection.score;
        product.lifecycleProtectionReasons = protection.reasons;

        if (protection.pinned) report.pinned++;

        let nextState = "ACTIVE";
        const previousState = product.lifecycleState || "ACTIVE";

        if (inactivityDays >= staleDays) {
          // Preserve the explicit lifecycle sequence. A product crosses into
          // STALE first; only a later lifecycle pass can promote an eligible
          // STALE record to PRUNABLE.
          if (!["STALE", "PRUNABLE"].includes(previousState)) {
            nextState = "STALE";
          } else if (
            !protection.pinned &&
            inactivityDays >= Math.max(
              prunableDays,
              protection.eligibleAfterDays
            )
          ) {
            nextState = "PRUNABLE";
          } else {
            nextState = "STALE";
            if (protection.protected) report.protectedStale++;
          }
        } else if (inactivityDays >= dormantDays) {
          nextState = "DORMANT";
        }

        const changed = changeLifecycleState(product, nextState, at);
        if (changed) report.transitioned[nextState]++;

        if (
          nextState === "PRUNABLE" &&
          archiveEligible &&
          !protection.pinned
        ) {
          product.lifecyclePrunableSince ||= at;
          const prunableSince = Date.parse(product.lifecyclePrunableSince || at);
          const prunableAgeDays = Number.isFinite(prunableSince)
            ? Math.max(0, (now - prunableSince) / DAY_MS)
            : 0;

          if (prunableAgeDays >= pruneGraceDays) {
            const archived = archiveProductInDb(
              data,
              product,
              at,
              lifecycleIndex,
              deferredArchiveProductIds
            );
            report.archived++;
            report.archivedOfferRowsRemoved += archived.removedOffers;
            report.transitioned.ARCHIVED++;
          }
        }
      }
    }

    emitDbStartupProgress(onProgress, {
      phase: "lifecycle-classification",
      state: productIndex + 1 === products.length ? "done" : "progress",
      current: productIndex + 1,
      total: products.length,
      durationMs: Date.now() - classificationStartedAt,
      message: "evaluating lifecycle state and retention protection",
    });
  }

  if (!products.length) {
    emitDbStartupProgress(onProgress, {
      phase: "lifecycle-classification",
      state: "done",
      current: 0,
      total: 0,
      durationMs: Date.now() - classificationStartedAt,
      message: "no products required lifecycle evaluation",
    });
  }

  const archivePruneStartedAt = Date.now();
  const archivePruneInputTotal =
    Number(data.offers?.length || 0) + Number(data.priceHistory?.length || 0) + Number(data.clicks?.length || 0);
  emitDbStartupProgress(onProgress, {
    phase: "lifecycle-archive-prune",
    state: "start",
    current: 0,
    total: archivePruneInputTotal,
    message: deferredArchiveProductIds.size
      ? `batch-removing rows for ${deferredArchiveProductIds.size.toLocaleString()} archived products`
      : "no archived product rows require removal",
  });

  if (deferredArchiveProductIds.size) {
    data.offers = data.offers.filter(
      offer => !deferredArchiveProductIds.has(Number(offer.productId))
    );
    data.priceHistory = data.priceHistory.filter(
      point => !deferredArchiveProductIds.has(Number(point.productId))
    );
    data.clicks = data.clicks.filter(
      click => !deferredArchiveProductIds.has(Number(click.productId))
    );
  }

  emitDbStartupProgress(onProgress, {
    phase: "lifecycle-archive-prune",
    state: "done",
    current: archivePruneInputTotal,
    total: archivePruneInputTotal,
    durationMs: Date.now() - archivePruneStartedAt,
    message: deferredArchiveProductIds.size
      ? "archived relationship rows removed in one pass"
      : "no archive row removal needed",
  });

  // V3.7.23: lifecycle maintenance never reconstructs Deal Heat/sparklines on
  // the request thread. Persistent snapshots remain valid across history
  // compaction, and lifecycle state itself is read directly from the product.

  data.meta.lifecycleVersion = 4;
  data.meta.lastLifecycleRunAt = at;
  data.meta.lastLifecycleReport = {
    at,
    reason,
    archived: report.archived,
    transitioned: report.transitioned,
  };

  pruneData(data);
  if (deferPersistence) scheduleDeferredWrite(data, 250);
  else writeDb(data);

  for (const state of ["ACTIVE", "DORMANT", "STALE", "PRUNABLE", "ARCHIVED"]) {
    report.after[state] = 0;
  }
  for (const product of data.products) {
    const state = String(product.lifecycleState || "ACTIVE");
    if (Object.prototype.hasOwnProperty.call(report.after, state)) {
      report.after[state]++;
    }
  }

  appendLifecycleAudit(report);

  publishLiveEvent(
    "catalog",
    {
      reason: "product-lifecycle",
      productIds: [],
      deletedProductIds: [],
      products: [],
      hotProductIds: [],
      scorchingProductIds: [],
      lifecycle: report.after,
      archived: report.archived,
    },
    { audience: "all" }
  );

  return report;
}

export function getProductLifecycleStatus() {
  const data = readDb();
  const counts = {};

  for (const state of ["ACTIVE", "DORMANT", "STALE", "PRUNABLE", "ARCHIVED"]) {
    counts[state] = data.products.filter(
      product => product.lifecycleState === state
    ).length;
  }

  return {
    enabled: lifecycleEnabled(),
    counts,
    lastRunAt: data.meta?.lastLifecycleRunAt || null,
    lastReport: data.meta?.lastLifecycleReport || null,
    rawPricePoints: data.priceHistory.length,
    compressedPriceBuckets: data.priceAggregates.length,
    thresholds: {
      dormantDays: Math.max(
        90,
        lifecycleNumber("PRODUCT_DORMANT_DAYS", 120, 90, 180)
      ),
      staleDays: Math.max(
        365,
        lifecycleNumber("PRODUCT_STALE_DAYS", 365, 365, 3650)
      ),
      prunableDays: Math.max(
        365,
        lifecycleNumber("PRODUCT_PRUNABLE_DAYS", 365, 365, 3650)
      ),
      pruneGraceDays: Math.max(
        0,
        lifecycleNumber("PRODUCT_PRUNE_GRACE_DAYS", 30, 0, 365)
      ),
      protectedRetentionDays: Math.max(
        365,
        lifecycleNumber(
          "PRODUCT_PROTECTED_RETENTION_DAYS",
          730,
          365,
          3650
        )
      ),
    },
  };
}


export function queueStaleIntelligenceSnapshots({
  limit = 32,
  maxAgeMinutes = INTELLIGENCE_STALE_MINUTES,
} = {}) {
  const data = readDb();
  const cap = Math.max(1, Math.min(Number(limit || 32), 500));
  const maxAgeMs = Math.max(5, Number(maxAgeMinutes || INTELLIGENCE_STALE_MINUTES)) * 60_000;
  const now = Date.now();

  const candidates = (data.products || [])
    .filter(product => product.lifecycleState !== "ARCHIVED")
    .filter(product => {
      if (product.intelligenceDirty) return true;
      if (Number(product.intelligenceSnapshotVersion || 0) < INTELLIGENCE_SNAPSHOT_SCHEMA_VERSION) return true;
      if (!snapshotStatsLookValid(product.cachedPriceStats)) return true;
      const computedAt = Date.parse(product.intelligenceComputedAt || "");
      return !Number.isFinite(computedAt) || now - computedAt >= maxAgeMs;
    })
    .sort((a, b) =>
      Number(Boolean(b.approved)) - Number(Boolean(a.approved)) ||
      Number(Boolean(b.intelligenceDirty)) - Number(Boolean(a.intelligenceDirty)) ||
      (Date.parse(a.intelligenceComputedAt || 0) || 0) - (Date.parse(b.intelligenceComputedAt || 0) || 0) ||
      Number(a.id) - Number(b.id)
    )
    .slice(0, cap);

  const ids = [];
  for (const product of candidates) {
    if (!product.intelligenceDirty) {
      product.intelligenceGeneration = Math.max(0, Number(product.intelligenceGeneration || 0)) + 1;
      product.intelligenceDirty = true;
      product.intelligenceDirtyAt = nowIso();
      product.intelligenceDirtyReason = "lazy-stale-validation";
    }
    ids.push(Number(product.id));
  }

  if (ids.length) {
    enqueueIntelligenceProducts(ids, {
      priority: "background",
      reason: "lazy-stale-validation",
    });
  }

  return ids;
}

export function getIntelligencePipelineStatus() {
  return {
    snapshotSchemaVersion: INTELLIGENCE_SNAPSHOT_SCHEMA_VERSION,
    staleMinutes: INTELLIGENCE_STALE_MINUTES,
    mutationBuffer: getRuntimeMutationBufferStatus(),
    workers: getIntelligenceWorkerStatus(),
  };
}

export async function flushOfferGridMutationPipelines({ timeoutMs = 20_000 } = {}) {
  await CLICK_LEDGER_APPEND_CHAIN.catch(() => {});
  await flushRuntimeMutationBuffer({ reason: "shutdown", force: true });
  const workersFlushed = await flushIntelligenceWorkerPool({ timeoutMs });
  // Worker result commits may have scheduled a final deferred catalog write.
  if (PENDING_DEFERRED_WRITE) {
    clearTimeout(PENDING_DEFERRED_WRITE);
    PENDING_DEFERRED_WRITE = null;
    writeDb(readDb());
  }
  return { workersFlushed };
}

export function setProductLifecyclePinned(id, pinned) {
  const data = readDb();
  const product = data.products.find(p => p.id === Number(id));
  if (!product) return null;

  product.lifecyclePinned = Boolean(pinned);
  product.updatedAt = nowIso();
  writeDb(data);

  return hydrate(data, product, { includeHistory: true });
}

export function compressPriceHistory({
  force = true,
} = {}) {
  const data = readDb();
  const result = compressPriceHistoryInDb(data, { force });
  if (!result.skipped) writeDb(data);
  return result;
}

function offersFor(data, productId, lookup = null) {
  if (lookup?.offersByExactProductId) {
    const exact = lookup.offersByExactProductId.get(productId);
    if (exact) return exact;
    const numericId = Number(productId);
    if (Number.isFinite(numericId) && lookup?.offersByNumericProductId) {
      return lookup.offersByNumericProductId.get(numericId) || [];
    }
    return [];
  }

  return data.offers
    .filter(o => o.productId === productId)
    .sort((a, b) => b.score - a.score || a.price - b.price);
}

function buildPageHydrationLookup(data, ids = [], { approvedOnly = true, includeClicks = true } = {}) {
  const wanted = new Set(
    (Array.isArray(ids) ? ids : [])
      .map(Number)
      .filter(Number.isFinite)
  );
  const productByNumericId = new Map();
  const productByExactId = new Map();
  const offersByExactProductId = new Map();
  const offersByNumericProductId = new Map();
  const offerByNumericId = new Map();
  const primaryEbayOfferByNumericProductId = new Map();
  const clicksByProduct = new Map();

  if (!wanted.size) {
    return {
      productByNumericId,
      productByExactId,
      offersByExactProductId,
      offersByNumericProductId,
      offerByNumericId,
      primaryEbayOfferByNumericProductId,
      clicksByProduct,
      scopeProductIds: wanted,
    };
  }

  // V3.7.44: page hydration is intentionally scoped to the product IDs that
  // survived search + global sort + pagination. We make one linear pass over
  // shared arrays to build relationship buckets, then every card-level lookup
  // is O(1). No non-visible product is hydrated or rescored for this response.
  for (const product of data.products || []) {
    const numericId = Number(product.id);
    if (!wanted.has(numericId) || (approvedOnly && !product.approved)) continue;
    productByNumericId.set(numericId, product);
    productByExactId.set(product.id, product);
  }

  for (const offer of data.offers || []) {
    const numericProductId = Number(offer.productId);
    if (!wanted.has(numericProductId)) continue;

    if (!offersByExactProductId.has(offer.productId)) {
      offersByExactProductId.set(offer.productId, []);
    }
    offersByExactProductId.get(offer.productId).push(offer);

    if (!offersByNumericProductId.has(numericProductId)) {
      offersByNumericProductId.set(numericProductId, []);
    }
    offersByNumericProductId.get(numericProductId).push(offer);

    const numericOfferId = Number(offer.id);
    if (Number.isFinite(numericOfferId)) offerByNumericId.set(numericOfferId, offer);
  }

  for (const grouped of offersByExactProductId.values()) {
    grouped.sort((a, b) => b.score - a.score || a.price - b.price);
  }
  for (const [numericProductId, grouped] of offersByNumericProductId.entries()) {
    // If exact and numeric product IDs are both numeric they may reference the
    // same array. Sorting twice is harmless, but avoid it when possible.
    if (offersByExactProductId.get(numericProductId) !== grouped) {
      grouped.sort((a, b) => b.score - a.score || a.price - b.price);
    }
  }

  if (includeClicks) {
    for (const click of data.clicks || []) {
      const numericProductId = Number(click.productId);
      if (!wanted.has(numericProductId)) continue;
      if (!clicksByProduct.has(numericProductId)) clicksByProduct.set(numericProductId, []);
      clicksByProduct.get(numericProductId).push(click);
    }
  }

  return {
    productByNumericId,
    productByExactId,
    offersByExactProductId,
    offersByNumericProductId,
    offerByNumericId,
    primaryEbayOfferByNumericProductId,
    clicksByProduct,
    scopeProductIds: wanted,
  };
}

function buildOfferLookupIndex(data, { onProgress = null, includeClicks = false } = {}) {
  const products = Array.isArray(data.products) ? data.products : [];
  const offers = Array.isArray(data.offers) ? data.offers : [];
  const productByNumericId = new Map();
  const productByExactId = new Map();
  const offersByExactProductId = new Map();
  const offersByNumericProductId = new Map();
  const offerByNumericId = new Map();
  const offerByProviderExternalId = new Map();
  const primaryEbayOfferByNumericProductId = new Map();
  const clicksByProduct = includeClicks ? new Map() : null;
  const startedAt = Date.now();

  emitDbStartupProgress(onProgress, {
    phase: "product-cache-lookup-index",
    state: "start",
    current: 0,
    total: products.length + offers.length,
    message: "building reusable product/offer lookup indexes for startup cache work",
  });

  let current = 0;
  for (const product of products) {
    const numericId = Number(product.id);
    if (!productByExactId.has(product.id)) productByExactId.set(product.id, product);
    if (Number.isFinite(numericId) && !productByNumericId.has(numericId)) {
      productByNumericId.set(numericId, product);
    }
    current++;
    emitDbStartupProgress(onProgress, {
      phase: "product-cache-lookup-index",
      state: "progress",
      current,
      total: products.length + offers.length,
      durationMs: Date.now() - startedAt,
      message: "indexing products and offers",
    });
  }

  for (const offer of offers) {
    const exactKey = offer.productId;
    if (!offersByExactProductId.has(exactKey)) offersByExactProductId.set(exactKey, []);
    offersByExactProductId.get(exactKey).push(offer);

    const numericId = Number(offer.productId);
    if (Number.isFinite(numericId)) {
      if (!offersByNumericProductId.has(numericId)) offersByNumericProductId.set(numericId, []);
      offersByNumericProductId.get(numericId).push(offer);
    }

    const numericOfferId = Number(offer.id);
    if (Number.isFinite(numericOfferId) && !offerByNumericId.has(numericOfferId)) {
      offerByNumericId.set(numericOfferId, offer);
    }
    const providerExternalKey = `${String(offer.provider || "").toLowerCase()}:${String(offer.externalId || "")}`;
    if (providerExternalKey !== ":" && !offerByProviderExternalId.has(providerExternalKey)) {
      offerByProviderExternalId.set(providerExternalKey, offer);
    }

    current++;
    emitDbStartupProgress(onProgress, {
      phase: "product-cache-lookup-index",
      state: "progress",
      current,
      total: products.length + offers.length,
      durationMs: Date.now() - startedAt,
      message: "indexing products and offers",
    });
  }

  for (const grouped of offersByExactProductId.values()) {
    grouped.sort((a, b) => b.score - a.score || a.price - b.price);
  }

  if (clicksByProduct) {
    for (const click of data.clicks || []) {
      const productId = Number(click.productId);
      if (!Number.isFinite(productId)) continue;
      if (!clicksByProduct.has(productId)) clicksByProduct.set(productId, []);
      clicksByProduct.get(productId).push(click);
    }
  }

  emitDbStartupProgress(onProgress, {
    phase: "product-cache-lookup-index",
    state: "done",
    current: products.length + offers.length,
    total: products.length + offers.length,
    durationMs: Date.now() - startedAt,
    message: products.length + offers.length
      ? "reusable product/offer lookup indexes ready"
      : "no product/offer lookup entries required",
  });

  return {
    productByNumericId,
    productByExactId,
    offersByExactProductId,
    offersByNumericProductId,
    offerByNumericId,
    offerByProviderExternalId,
    primaryEbayOfferByNumericProductId,
    clicksByProduct,
  };
}

function runtimeOfferLookupCacheValid(data) {
  const productsLength = Array.isArray(data?.products) ? data.products.length : 0;
  const offersLength = Array.isArray(data?.offers) ? data.offers.length : 0;
  return Boolean(
    RUNTIME_LOOKUP_CACHE &&
    RUNTIME_LOOKUP_CACHE_REVISION === SEARCH_INDEX_REVISION &&
    RUNTIME_LOOKUP_CACHE_PRODUCTS === productsLength &&
    RUNTIME_LOOKUP_CACHE_OFFERS === offersLength
  );
}

function getRuntimeOfferLookup(data, { includeClicks = false } = {}) {
  const productsLength = Array.isArray(data?.products) ? data.products.length : 0;
  const offersLength = Array.isArray(data?.offers) ? data.offers.length : 0;
  const cacheValid = runtimeOfferLookupCacheValid(data);

  if (!cacheValid) {
    RUNTIME_LOOKUP_CACHE = buildOfferLookupIndex(data);
    RUNTIME_LOOKUP_CACHE_REVISION = SEARCH_INDEX_REVISION;
    RUNTIME_LOOKUP_CACHE_PRODUCTS = productsLength;
    RUNTIME_LOOKUP_CACHE_OFFERS = offersLength;
    RUNTIME_LOOKUP_CACHE_NEXT_CLICK_ID = -1;
  }

  const nextClickId = Number(data?.meta?.nextClickId || 0);
  if (
    includeClicks &&
    (!RUNTIME_LOOKUP_CACHE.clicksByProduct || RUNTIME_LOOKUP_CACHE_NEXT_CLICK_ID !== nextClickId)
  ) {
    // Clicks deliberately do not advance the search-index revision. Keep the
    // expensive product/offer relationship cache, but refresh only the tiny
    // click relationship map when the click sequence advances. This also stays
    // correct once CLICK_LOG_LIMIT causes the array length to remain constant.
    const clicksByProduct = new Map();
    for (const click of data.clicks || []) {
      const productId = Number(click.productId);
      if (!Number.isFinite(productId)) continue;
      if (!clicksByProduct.has(productId)) clicksByProduct.set(productId, []);
      clicksByProduct.get(productId).push(click);
    }
    RUNTIME_LOOKUP_CACHE.clicksByProduct = clicksByProduct;
    RUNTIME_LOOKUP_CACHE_NEXT_CLICK_ID = nextClickId;
  }

  return RUNTIME_LOOKUP_CACHE;
}

function isEbayOffer(offer) {
  return String(offer?.provider || "").toLowerCase() === "ebay";
}

function isEbaySecondarySource(offer) {
  const source = String(offer?.matchSource || "");
  return source.startsWith("ebay-competitor:") || source.startsWith("ebay-secondary:");
}

function productEbayIdentityProofType(product) {
  if (!product) return "";
  const proof = exactCompetitorProof(product, product);
  return proof.ok ? String(proof.proofType || "") : "";
}

function primaryEbayOfferFor(data, product, lookup = null) {
  if (!product) return null;

  const numericProductId = Number(product.id);
  if (lookup?.primaryEbayOfferByNumericProductId?.has(numericProductId)) {
    return lookup.primaryEbayOfferByNumericProductId.get(numericProductId);
  }

  const sourceOffers = lookup?.offersByNumericProductId
    ? lookup.offersByNumericProductId.get(numericProductId) || []
    : data.offers;

  const broad = sourceOffers
    .filter(offer =>
      Number(offer.productId) === numericProductId &&
      isEbayOffer(offer) &&
      !isEbaySecondarySource(offer)
    )
    .sort((a, b) => Number(a.id) - Number(b.id));

  if (!broad.length) {
    if (lookup?.primaryEbayOfferByNumericProductId) {
      lookup.primaryEbayOfferByNumericProductId.set(numericProductId, null);
    }
    return null;
  }

  const persisted = broad.find(
    offer => Number(offer.id) === Number(product.primaryEbayOfferId)
  );
  if (persisted) {
    if (lookup?.primaryEbayOfferByNumericProductId) {
      lookup.primaryEbayOfferByNumericProductId.set(numericProductId, persisted);
    }
    return persisted;
  }

  const canonical = String(product.canonicalKey || "");
  if (canonical.startsWith("listing:ebay:")) {
    const exactListing = broad.find(offer =>
      candidateCanonicalKey({
        provider: "ebay",
        externalId: offer.externalId,
      }) === canonical
    );
    if (exactListing) {
      if (lookup?.primaryEbayOfferByNumericProductId) {
        lookup.primaryEbayOfferByNumericProductId.set(numericProductId, exactListing);
      }
      return exactListing;
    }
  }

  if (productEbayIdentityProofType(product)) {
    const exactIdentitySource = broad.find(offer =>
      String(offer.priceSource || "") === "ebay-item-detail" &&
      Boolean(offer.priceVerifiedAt) &&
      exactCompetitorProof(product, offer).ok
    );
    if (exactIdentitySource) {
      if (lookup?.primaryEbayOfferByNumericProductId) {
        lookup.primaryEbayOfferByNumericProductId.set(numericProductId, exactIdentitySource);
      }
      return exactIdentitySource;
    }
  }

  const hasNonEbayOffer = sourceOffers.some(offer =>
    Number(offer.productId) === numericProductId &&
    !isEbayOffer(offer)
  );
  const resolved = hasNonEbayOffer ? null : (broad[0] || null);

  if (lookup?.primaryEbayOfferByNumericProductId) {
    lookup.primaryEbayOfferByNumericProductId.set(numericProductId, resolved);
  }

  return resolved;
}

function ebayOfferTrust(data, product, offer, { allowPrimary = true, lookup = null } = {}) {
  if (!isEbayOffer(offer)) {
    return { trusted: true, role: "non-ebay", proofType: "" };
  }
  if (!product) {
    return { trusted: false, role: "orphan", proofType: "", reason: "missing-product" };
  }

  const state = String(offer.competitorIdentityStatus || "").toLowerCase();
  if (["pending", "rejected"].includes(state)) {
    return {
      trusted: false,
      role: "secondary",
      proofType: "",
      reason: `identity-${state}`,
    };
  }

  const primary = primaryEbayOfferFor(data, product, lookup);
  if (
    allowPrimary &&
    primary &&
    Number(primary.id) === Number(offer.id) &&
    !isEbaySecondarySource(offer)
  ) {
    return {
      trusted: true,
      role: "source",
      proofType: productEbayIdentityProofType(product),
      reason: "canonical-source-listing",
    };
  }

  const exactDetail =
    String(offer.priceSource || "") === "ebay-item-detail" &&
    Boolean(offer.priceVerifiedAt);

  if (!exactDetail) {
    return {
      trusted: false,
      role: "secondary",
      proofType: "",
      reason: "secondary-not-exact-item-verified",
    };
  }

  const proof = exactCompetitorProof(product, offer);
  if (!proof.ok) {
    return {
      trusted: false,
      role: "secondary",
      proofType: proof.proofType || "",
      reason: proof.reasons.join(",") || "secondary-exact-proof-failed",
    };
  }

  return {
    trusted: true,
    role: "secondary",
    proofType: proof.proofType || "",
    reason: `v4-exact-${proof.proofType || "identity"}`,
  };
}


function pendingEbayCompetitorLocallySafe(product, offer) {
  if (!product?.approved || !isEbayOffer(offer)) return false;
  if (!intelligenceEligibleListing(offer)) return false;
  if (String(offer.competitorIdentityStatus || "") !== "pending") return false;
  if (!String(offer.matchSource || "").startsWith("ebay-competitor:v4-pending")) return false;
  if (Number(offer.matchConfidence || 0) < 90) return false;
  if (!productEbayIdentityProofType(product)) return false;
  if (offer.availability === "out_of_stock" || offer.priceDisplayRestricted) return false;
  if (!safeHttpUrl(offer.affiliateUrl, 4000)) return false;

  return safeSameVariant(product.title, offer.listingTitle || product.title, {
    brandA: product.brand || "",
    brandB: offer.brand || product.brand || "",
  });
}

function identityTrustedOffersFor(data, productId, lookup = null) {
  const product = lookup?.productByNumericId
    ? lookup.productByNumericId.get(Number(productId))
    : data.products.find(p => Number(p.id) === Number(productId));
  return offersFor(data, productId, lookup).filter(offer =>
    !isEbayOffer(offer) || ebayOfferTrust(data, product, offer, { lookup }).trusted
  );
}

function trustedOffersFor(data, productId, lookup = null) {
  return identityTrustedOffersFor(data, productId, lookup)
    .filter(intelligenceEligibleListing);
}

function conditionExceptionOffersFor(data, productId, lookup = null) {
  return identityTrustedOffersFor(data, productId, lookup)
    .filter(isBrokenOrPartsListing);
}

function offerVerificationRank(offer) {
  return String(offer?.provider || "").toLowerCase() !== "ebay" || offer?.priceVerifiedAt ? 2 : 0;
}

function rankEligibleDisplayOffers(offers = []) {
  return Array.from(offers || [])
    .filter(offer =>
      offer.availability !== "out_of_stock" &&
      !offer.priceDisplayRestricted &&
      Boolean(String(offer.affiliateUrl || "").trim()) &&
      Number.isFinite(Number(offer.price)) &&
      Number(offer.price) > 0
    )
    .sort((a, b) =>
      offerVerificationRank(b) - offerVerificationRank(a) ||
      Number(a.price) - Number(b.price) ||
      Number(b.score || 0) - Number(a.score || 0) ||
      (Date.parse(b.priceVerifiedAt || b.lastSeen || 0) || 0) -
        (Date.parse(a.priceVerifiedAt || a.lastSeen || 0) || 0) ||
      Number(a.id || 0) - Number(b.id || 0)
    );
}

function bestConditionExceptionOfferFor(data, productId, lookup = null) {
  return rankEligibleDisplayOffers(conditionExceptionOffersFor(data, productId, lookup))[0] || null;
}

function bestOfferFor(data, productId, lookup = null) {
  // Verification remains the safety boundary: an unverified search-observed
  // eBay price cannot outrank an exact-detail price. Inside that boundary the
  // shopper's price is authoritative; score and freshness are tie-breakers.
  return rankEligibleDisplayOffers(trustedOffersFor(data, productId, lookup))[0] || null;
}

function blockedCompetitorHistoryOfferIds(
  data,
  { onProgress = null, lookup = null, productIds = null } = {}
) {
  // V3.7.14: runtime mutation jobs can limit trust evaluation to the products
  // they actually changed. Startup still calls this without productIds and
  // therefore performs the same complete trust audit as before.
  const effectiveLookup = lookup || buildOfferLookupIndex(data, { onProgress });
  const productById = effectiveLookup.productByNumericId;
  const targetIds = productIds
    ? new Set(Array.from(productIds || []).map(Number).filter(Number.isFinite))
    : null;
  const offers = targetIds
    ? [...targetIds].flatMap(productId =>
        effectiveLookup.offersByNumericProductId.get(productId) || []
      )
    : (Array.isArray(data.offers) ? data.offers : []);
  const total = offers.length;
  const blocked = new Set();
  const startedAt = Date.now();

  if (onProgress) {
    emitDbStartupProgress(onProgress, {
      phase: "price-signal-trust-scan",
      state: "start",
      current: 0,
      total,
      message: "checking offer trust before indexing historical prices",
    });
  }

  for (let index = 0; index < total; index++) {
    const offer = offers[index];
    if (!intelligenceEligibleListing(offer)) {
      const offerId = Number(offer.id);
      if (Number.isFinite(offerId)) blocked.add(offerId);
    } else if (isEbayOffer(offer)) {
      const product = productById.get(Number(offer.productId));
      if (!ebayOfferTrust(data, product, offer, { lookup: effectiveLookup }).trusted) {
        const offerId = Number(offer.id);
        if (Number.isFinite(offerId)) blocked.add(offerId);
      }
    }

    if (onProgress) {
      emitDbStartupProgress(onProgress, {
        phase: "price-signal-trust-scan",
        state: "progress",
        current: index + 1,
        total,
        durationMs: Date.now() - startedAt,
        message: "checking offer trust before indexing historical prices",
      });
    }
  }

  if (onProgress) {
    emitDbStartupProgress(onProgress, {
      phase: "price-signal-trust-scan",
      state: "done",
      current: total,
      total,
      durationMs: Date.now() - startedAt,
      message: `${blocked.size.toLocaleString()} untrusted eBay offer histories excluded`,
    });
  }

  return blocked;
}

function conditionUnsafeAggregateProductIds(data, {
  lookup = null,
  productIds = null,
} = {}) {
  const targetIds = productIds
    ? new Set(Array.from(productIds || []).map(Number).filter(Number.isFinite))
    : null;
  const unsafe = new Set();
  const effectiveLookup = lookup || (targetIds
    ? buildPageHydrationLookup(data, [...targetIds], { approvedOnly: false, includeClicks: false })
    : null);

  if (effectiveLookup?.offersByNumericProductId && targetIds) {
    for (const productId of targetIds) {
      const offers = effectiveLookup.offersByNumericProductId.get(Number(productId)) || [];
      if (offers.some(isBrokenOrPartsListing)) unsafe.add(Number(productId));
    }
    return unsafe;
  }

  for (const offer of data.offers || []) {
    const productId = Number(offer.productId);
    if (!Number.isFinite(productId)) continue;
    if (targetIds && !targetIds.has(productId)) continue;
    if (isBrokenOrPartsListing(offer)) unsafe.add(productId);
  }
  return unsafe;
}

function aggregateConditionEligible(aggregate, unsafeProductIds) {
  if (aggregate?.conditionScope === "deal-eligible") return true;
  // Pre-V3.7.47 aggregate buckets do not retain source offer IDs. If OfferGrid
  // still knows this product has ever-observed parts/broken inventory, do not
  // let a provenance-unknown bucket participate in normal-product intelligence.
  return !unsafeProductIds?.has(Number(aggregate?.productId));
}

function historyFor(data, productId, days = 180, lookup = null) {
  const cutoff = Date.now() - Math.max(1, Number(days)) * DAY_MS;
  const effectiveLookup = lookup || getRuntimeOfferLookup(data);

  const blockedOfferIds = blockedCompetitorHistoryOfferIds(data, {
    lookup: effectiveLookup,
    productIds: [productId],
  });
  const raw = data.priceHistory
    .filter(
      h =>
        Number(h.productId) === Number(productId) &&
        !blockedOfferIds.has(Number(h.offerId)) &&
        Date.parse(h.at) >= cutoff
    )
    .map(point => ({ ...point, aggregated: false }));

  const unsafeAggregateProducts = conditionUnsafeAggregateProductIds(data, {
    lookup: effectiveLookup,
    productIds: [productId],
  });
  const compressed = (data.priceAggregates || [])
    .filter(
      item =>
        Number(item.productId) === Number(productId) &&
        aggregateConditionEligible(item, unsafeAggregateProducts) &&
        Date.parse(item.endAt || item.startAt) >= cutoff
    )
    .map(item => ({
      productId: Number(item.productId),
      offerId: null,
      price: Number(item.average),
      low: Number(item.low),
      high: Number(item.high),
      currency: item.currency || "USD",
      merchant: "",
      source: item.source || "compressed-price-history",
      verifiedAt: Number(item.verifiedCount || 0) > 0 ? item.endAt : null,
      at: item.endAt || item.startAt,
      aggregated: true,
      granularity: item.granularity,
      sampleCount: Number(item.sampleCount || 1),
      bucket: item.bucket,
    }));

  return [...compressed, ...raw]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}


function buildDealHeatHistoryIndex(data, {
  days = 30,
  blockedOfferIds = null,
  onProgress = null,
  lookup = null,
  productIds = null,
} = {}) {
  const cutoff = Date.now() - Math.max(1, Number(days || 30)) * DAY_MS;
  const targetIds = productIds
    ? new Set(Array.from(productIds || []).map(Number).filter(Number.isFinite))
    : null;
  const blocked = blockedOfferIds instanceof Set
    ? blockedOfferIds
    : blockedCompetitorHistoryOfferIds(data, { lookup, productIds: targetIds });
  const aggregates = Array.isArray(data.priceAggregates) ? data.priceAggregates : [];
  const unsafeAggregateProducts = conditionUnsafeAggregateProductIds(data, {
    lookup,
    productIds: targetIds,
  });
  const rawHistory = Array.isArray(data.priceHistory) ? data.priceHistory : [];
  const total = aggregates.length + rawHistory.length;
  const byProduct = new Map();
  const startedAt = Date.now();

  function append(productId, point) {
    const id = Number(productId);
    if (!Number.isFinite(id)) return;
    if (targetIds && !targetIds.has(id)) return;
    if (!byProduct.has(id)) byProduct.set(id, []);
    byProduct.get(id).push(point);
  }

  emitDbStartupProgress(onProgress, {
    phase: "product-cache-history-index",
    state: "start",
    current: 0,
    total,
    message: "pre-indexing 30-day Deal Heat history once for all products",
  });

  let current = 0;

  // Preserve historyFor()'s stable ordering semantics by inserting compressed
  // aggregate rows before raw rows when timestamps are equal.
  for (const item of aggregates) {
    const at = item.endAt || item.startAt;
    if (
      aggregateConditionEligible(item, unsafeAggregateProducts) &&
      Date.parse(at) >= cutoff
    ) {
      append(item.productId, {
        productId: Number(item.productId),
        offerId: null,
        price: Number(item.average),
        low: Number(item.low),
        high: Number(item.high),
        currency: item.currency || "USD",
        merchant: "",
        source: item.source || "compressed-price-history",
        verifiedAt: Number(item.verifiedCount || 0) > 0 ? item.endAt : null,
        at,
        aggregated: true,
        granularity: item.granularity,
        sampleCount: Number(item.sampleCount || 1),
        bucket: item.bucket,
      });
    }

    current++;
    emitDbStartupProgress(onProgress, {
      phase: "product-cache-history-index",
      state: current === total ? "done" : "progress",
      current,
      total,
      durationMs: Date.now() - startedAt,
      message: "pre-indexing 30-day Deal Heat history once for all products",
    });
  }

  for (const point of rawHistory) {
    if (
      !blocked.has(Number(point.offerId)) &&
      Date.parse(point.at) >= cutoff
    ) {
      append(point.productId, { ...point, aggregated: false });
    }

    current++;
    emitDbStartupProgress(onProgress, {
      phase: "product-cache-history-index",
      state: current === total ? "done" : "progress",
      current,
      total,
      durationMs: Date.now() - startedAt,
      message: "pre-indexing 30-day Deal Heat history once for all products",
    });
  }

  for (const history of byProduct.values()) {
    history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  if (total === 0) {
    emitDbStartupProgress(onProgress, {
      phase: "product-cache-history-index",
      state: "done",
      current: 0,
      total: 0,
      durationMs: Date.now() - startedAt,
      message: "no Deal Heat history required indexing",
    });
  }

  return byProduct;
}

function pruneDealHeatHistoryOutliers(history) {
  const clean = (history || [])
    .filter(point =>
      point &&
      Number.isFinite(Number(point.price)) &&
      Number(point.price) > 0
    );

  // With fewer than five observations there is not enough evidence to call a
  // historical point an outlier safely.
  if (clean.length < 5) {
    return {
      kept: clean,
      pruned: [],
      medianPrice: median(clean.map(point => Number(point.price))),
      mad: null,
    };
  }

  const prices = clean.map(point => Number(point.price));
  const center = median(prices);
  const deviations = prices.map(price =>
    Math.abs(price - center)
  );
  const mad = median(deviations);

  if (!Number.isFinite(center) || center <= 0) {
    return {
      kept: clean,
      pruned: [],
      medianPrice: center,
      mad,
    };
  }

  const kept = [];
  const pruned = [];

  for (const point of clean) {
    const price = Number(point.price);
    let isOutlier = false;

    if (
      Number.isFinite(mad) &&
      mad > Math.max(0.01, center * 0.001)
    ) {
      // Modified Z-score is robust against one or two extreme marketplace
      // observations because it uses the median and MAD rather than mean/SD.
      const modifiedZ =
        (0.6745 * Math.abs(price - center)) / mad;

      isOutlier = modifiedZ > 4.5;
    } else {
      // When most observations are identical MAD becomes zero. Only reject a
      // large isolated deviation; ordinary sales remain in the baseline.
      const relativeDeviation =
        Math.abs(price - center) / center;

      isOutlier =
        relativeDeviation > 0.35 &&
        Math.abs(price - center) > 5;
    }

    (isOutlier ? pruned : kept).push(point);
  }

  // Never let filtering collapse a useful baseline because of a weird but
  // legitimate price regime. Fall back to the raw observations if pruning
  // would leave fewer than three samples.
  if (kept.length < 3) {
    return {
      kept: clean,
      pruned: [],
      medianPrice: center,
      mad,
    };
  }

  return {
    kept,
    pruned,
    medianPrice: center,
    mad,
  };
}

function currentPriceLooksLikeExtremeOutlier(current, priorHistory) {
  const prior = pruneDealHeatHistoryOutliers(priorHistory);
  const prices = prior.kept
    .map(point => Number(point.price))
    .filter(price => Number.isFinite(price) && price > 0);

  if (prices.length < 5) {
    return {
      suspicious: false,
      baseline: median(prices),
      ratio: null,
    };
  }

  const baseline = median(prices);
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return {
      suspicious: false,
      baseline,
      ratio: null,
    };
  }

  const ratio = Number(current) / baseline;

  // This is intentionally much looser than the historical MAD filter. A real
  // flash sale can move sharply. We only stop Deal Heat from screaming HOT
  // when one current observation is wildly implausible versus a well-formed
  // prior baseline (common with unit-price/variant/scrape mistakes).
  const suspicious =
    Number.isFinite(ratio) &&
    (ratio < 0.20 || ratio > 5.0);

  return {
    suspicious,
    baseline,
    ratio,
  };
}

function calculatePriceStats(data, productId, {
  lookup = null,
  bestOffer = undefined,
  historyOverride = null,
} = {}) {
  const best = bestOffer !== undefined
    ? bestOffer
    : bestOfferFor(data, productId, lookup);
  if (!best) {
    return {
      currentPrice: null,
      historyCount: 0,
      dealHeatHistoryCount: 0,
      dealHeatOutliersPruned: 0,
      currentPriceAnomaly: false,
      average30d: null,
      low30d: null,
      high30d: null,
      priorLow30d: null,
      previousPrice: null,
      trackingStartedAt: null,
      savingsVsAveragePct: 0,
      changeVsPreviousPct: 0,
      changeSinceTrackingPct: 0,
      dealHeat: 0,
      heatLabel: "Unavailable",
      heatConfidence: "none",
      newLow: false,
    };
  }

  const rawHistory = Array.isArray(historyOverride)
    ? historyOverride.filter(
        point => Date.parse(point.at) >= Date.now() - 30 * DAY_MS
      )
    : historyFor(data, productId, 30, lookup);
  const pruned = pruneDealHeatHistoryOutliers(rawHistory);
  const history = pruned.kept;
  const prices = history
    .map(point => Number(point.price))
    .filter(Number.isFinite);

  const current = Number(best.price);
  const average = prices.length
    ? prices.reduce((a, b) => a + b, 0) / prices.length
    : current;
  const low = prices.length
    ? Math.min(...prices)
    : current;
  const high = prices.length
    ? Math.max(...prices)
    : current;

  const previousSample =
    history.length >= 2
      ? history.at(-2)
      : null;
  const firstSample =
    history.length
      ? history[0]
      : null;

  const priorRawHistory =
    rawHistory.length &&
    Math.abs(
      Number(rawHistory.at(-1)?.price) - current
    ) <= Math.max(0.01, Math.abs(current) * 0.005)
      ? rawHistory.slice(0, -1)
      : rawHistory;

  const priorPruned =
    pruneDealHeatHistoryOutliers(priorRawHistory);

  const priorPrices = priorPruned.kept
    .map(point => Number(point.price))
    .filter(Number.isFinite);

  const priorLow = priorPrices.length
    ? Math.min(...priorPrices)
    : null;

  const currentAnomaly =
    currentPriceLooksLikeExtremeOutlier(
      current,
      priorRawHistory
    );

  const newLow =
    !currentAnomaly.suspicious &&
    priorLow != null &&
    current < priorLow - 0.005;

  const savingsVsAveragePct =
    average > 0
      ? Math.max(
          0,
          ((average - current) / average) * 100
        )
      : 0;

  const changeVsPreviousPct =
    previousSample &&
    Number(previousSample.price) > 0
      ? (
          (current - Number(previousSample.price)) /
          Number(previousSample.price)
        ) * 100
      : 0;

  const changeSinceTrackingPct =
    firstSample &&
    Number(firstSample.price) > 0
      ? (
          (current - Number(firstSample.price)) /
          Number(firstSample.price)
        ) * 100
      : 0;

  let historyComponent =
    Math.min(
      50,
      (savingsVsAveragePct / 40) * 50
    );

  const markdownComponent =
    Math.min(
      20,
      (
        discountPercent(
          best.price,
          best.originalPrice
        ) / 50
      ) * 20
    );

  const qualityComponent =
    Math.min(
      20,
      (Number(best.score || 0) / 100) * 20
    );

  let newLowBonus =
    newLow
      ? 10
      : (
          !currentAnomaly.suspicious &&
          priorLow != null &&
          current <= priorLow + 0.005
            ? 6
            : 0
        );

  // An extreme one-off current price should never create a false HOT or
  // SCORCHING result. Keep the verified listing and raw history, but withhold
  // history/new-low heat until another observation or corrected listing
  // establishes that the price is real.
  if (currentAnomaly.suspicious) {
    historyComponent = 0;
    newLowBonus = 0;
  }

  let dealHeat = Math.round(
    Math.min(
      100,
      historyComponent +
        markdownComponent +
        qualityComponent +
        newLowBonus
    )
  );

  const confidenceHistoryCount =
    Math.min(
      history.length,
      priorPruned.kept.length || history.length
    );

  let confidence =
    confidenceHistoryCount >= 5
      ? "good"
      : confidenceHistoryCount >= 2
        ? "limited"
        : "building";

  if (currentAnomaly.suspicious) {
    confidence = "anomaly";
    dealHeat = Math.min(dealHeat, 45);
  }

  // With only one usable sample, do not pretend we know historical strength.
  if (confidenceHistoryCount < 2) {
    dealHeat = Math.min(dealHeat, 45);
  }

  let heatLabel = "Watch";
  if (confidence === "anomaly") {
    heatLabel = "Verify anomaly";
  } else if (confidence === "building") {
    heatLabel = "Building history";
  } else if (dealHeat >= 90) {
    heatLabel = "Scorching";
  } else if (dealHeat >= 75) {
    heatLabel = "Hot";
  } else if (dealHeat >= 60) {
    heatLabel = "Warm";
  }

  return {
    currentPrice: current,
    historyCount: rawHistory.length,
    dealHeatHistoryCount: history.length,
    dealHeatOutliersPruned:
      Math.max(
        pruned.pruned.length,
        priorPruned.pruned.length
      ),
    currentPriceAnomaly:
      Boolean(currentAnomaly.suspicious),
    average30d:
      Math.round(average * 100) / 100,
    low30d:
      Math.round(low * 100) / 100,
    high30d:
      Math.round(high * 100) / 100,
    priorLow30d:
      priorLow == null
        ? null
        : Math.round(priorLow * 100) / 100,
    previousPrice:
      previousSample
        ? Number(previousSample.price)
        : null,
    trackingStartedAt:
      firstSample
        ? firstSample.at
        : null,
    savingsVsAveragePct:
      Math.round(savingsVsAveragePct * 10) / 10,
    changeVsPreviousPct:
      Math.round(changeVsPreviousPct * 10) / 10,
    changeSinceTrackingPct:
      Math.round(changeSinceTrackingPct * 10) / 10,
    dealHeat,
    heatLabel,
    heatConfidence: confidence,
    newLow,
  };
}

function clicksForProduct(data, productId, days = null, lookup = null) {
  const cutoff = days == null ? 0 : Date.now() - Number(days) * 86_400_000;
  const numericId = Number(productId);
  const clicks = lookup?.clicksByProduct
    ? lookup.clicksByProduct.get(numericId) || []
    : data.clicks;
  return clicks.filter(c =>
    Number(c.productId) === numericId && Date.parse(c.at) >= cutoff
  ).length;
}


function median(values) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function productMatchConfidence(product) {
  const key = String(product.canonicalKey || "");

  if (product.gtin || key.startsWith("gtin:")) {
    return {
      score: 100,
      level: "exact",
      method: "Exact GTIN / UPC / EAN",
      explanation: "Offers were grouped using an exact global product identifier.",
    };
  }

  if ((product.mpn && product.brand) || key.startsWith("mpn:")) {
    return {
      score: 96,
      level: "exact",
      method: "Brand + manufacturer part number",
      explanation: "Offers were grouped using the same brand and manufacturer part number.",
    };
  }

  if (product.epid && product.brand) {
    return {
      score: 98,
      level: "exact",
      method: "eBay product ID + brand",
      explanation: "eBay comparisons require the same ePID plus an independently matching brand and exact variant proof.",
    };
  }

  return {
    score: 0,
    level: "insufficient",
    method: "Insufficient canonical identity",
    explanation:
      "OfferGrid will not make same-product competitor claims from title similarity alone. A strong product identifier is required.",
  };
}


function calculateEbayCompetition(data, product, lookup = null) {
  const identityProofType = productEbayIdentityProofType(product);
  const allEbayOffers = offersFor(data, product.id, lookup)
    .filter(o => String(o.provider).toLowerCase() === "ebay")
    .filter(intelligenceEligibleListing);

  const ebayOffers = allEbayOffers
    .filter(o =>
      ebayOfferTrust(data, product, o, { lookup }).trusted &&
      o.availability !== "out_of_stock" &&
      Number.isFinite(Number(o.price)) &&
      Number(o.price) > 0 &&
      Boolean(o.priceVerifiedAt) &&
      !o.priceDisplayRestricted
    )
    .sort((a, b) => Number(a.price) - Number(b.price));

  const pendingOffers = allEbayOffers
    .filter(o =>
      String(o.competitorIdentityStatus || "") === "pending" &&
      o.availability !== "out_of_stock" &&
      Number.isFinite(Number(o.searchObservedPrice ?? o.price)) &&
      Number(o.searchObservedPrice ?? o.price) > 0 &&
      !o.priceDisplayRestricted
    )
    .sort(
      (a, b) =>
        Number(a.searchObservedPrice ?? a.price) -
        Number(b.searchObservedPrice ?? b.price)
    );

  if (!ebayOffers.length && !pendingOffers.length) return null;

  const prices = ebayOffers.map(o => Number(o.price));
  const low = prices.length ? Math.min(...prices) : null;
  const high = prices.length ? Math.max(...prices) : null;
  const average = prices.length
    ? prices.reduce((sum, value) => sum + value, 0) / prices.length
    : null;
  const medianPrice = median(prices);
  const sellers = new Set(
    ebayOffers.map(o => String(o.merchant || "").toLowerCase()).filter(Boolean)
  );
  const pendingSellers = new Set(
    pendingOffers.map(o => String(o.merchant || "").toLowerCase()).filter(Boolean)
  );
  const best = ebayOffers[0] || pendingOffers[0];

  return {
    comparisonAvailable: ebayOffers.length >= 2,
    identityProofAvailable: Boolean(identityProofType),
    identityProofType,
    withheldListingCount: Math.max(
      0,
      allEbayOffers.length - ebayOffers.length - pendingOffers.length
    ),
    pendingListingCount: pendingOffers.length,
    pendingSellerCount: pendingSellers.size,
    observedListingCount: ebayOffers.length + pendingOffers.length,
    trackedListingCount: ebayOffers.length + pendingOffers.length,
    identityMessage: !identityProofType
      ? "OfferGrid can show plausible eBay seller candidates discovered from available listing signals, but exact same-product verification is unavailable until stronger product identity is known."
      : pendingOffers.length
        ? `OfferGrid has ${ebayOffers.length} exact-verified eBay listing${ebayOffers.length === 1 ? "" : "s"} and ${pendingOffers.length} additional seller candidate${pendingOffers.length === 1 ? "" : "s"} awaiting exact same-product verification. Pending prices do not affect Deal Heat or the verified market range.`
        : ebayOffers.length < 2
          ? "OfferGrid has not yet verified a second same-product eBay listing through the exact identity trust filter."
          : "Every currently compared eBay listing passed OfferGrid's exact product identity trust filter.",
    listingCount: ebayOffers.length,
    sellerCount: sellers.size,
    lowPrice: low == null ? null : Math.round(low * 100) / 100,
    medianPrice: medianPrice == null ? null : Math.round(medianPrice * 100) / 100,
    highPrice: high == null ? null : Math.round(high * 100) / 100,
    averagePrice: average == null ? null : Math.round(average * 100) / 100,
    spread:
      low == null || high == null
        ? null
        : Math.round((high - low) * 100) / 100,
    currency: best?.currency || "USD",
    bestOfferId: ebayOffers[0]?.id || null,
    bestMerchant: ebayOffers[0]?.merchant || "",
    lastScanAt: product.ebayCompetitorScanAt || null,
    scanMethod: product.ebayCompetitorScanMethod || "",
    scanConfidence: Number(product.ebayCompetitorScanConfidence || 0),
    lastMatched: Number(product.ebayCompetitorScanMatched || 0),
    scanError: product.ebayCompetitorScanError || "",
    // V3.7.42 shopper-page coverage proof. This is intentionally separate
    // from lastScanAt: scheduled or older bounded scans may be useful without
    // proving that the currently normalized product exhausted progressive
    // recall (or reached the configured seller target).
    coverageCompleteAt: product.ebayCompetitorCoverageCompleteAt || null,
    coverageTargetSellers: Math.max(0, Number(product.ebayCompetitorCoverageTargetSellers || 0)),
    coverageSignalsExhausted: Boolean(product.ebayCompetitorCoverageSignalsExhausted),
    coverageSignalsRun: Math.max(0, Number(product.ebayCompetitorCoverageSignalsRun || 0)),
    coverageSellerCount: Math.max(0, Number(product.ebayCompetitorCoverageSellerCount || 0)),
    coverageStatus: String(product.ebayCompetitorCoverageStatus || ""),
    priceBasis: "Verified item price only",
    caveat:
      "Verified eBay seller comparison excludes shipping, tax, coupons, and checkout-specific discounts. Pending seller candidates are shown separately and cannot affect Deal Heat, price history, best-price ranking, or verified market statistics until exact item verification succeeds.",
    offers: ebayOffers.slice(0, 12).map((offer, index) => ({
      offerId: offer.id,
      merchant: offer.merchant,
      price: Number(offer.price),
      shippingPrice:
        offer.shippingPrice == null ? null : Number(offer.shippingPrice),
      currency: offer.currency || "USD",
      condition: offer.condition || "",
      conditionGroup: offer.conditionGroup || "unknown",
      matchConfidence:
        offer.matchConfidence == null ? null : Number(offer.matchConfidence),
      matchSource: offer.matchSource || "",
      discoveryMethods: normalizedCompetitorDiscoveryMethods(offer.competitorDiscoveryMethods),
      discoveryLabels: normalizedCompetitorDiscoveryLabels(offer.competitorDiscoveryLabels),
      discoveryPrimaryMethod: String(offer.competitorDiscoveryPrimaryMethod || "").slice(0, 40),
      discoveryPrimaryLabel: String(offer.competitorDiscoveryPrimaryLabel || "").slice(0, 80),
      discoveryTier: String(offer.competitorDiscoveryTier || "high").slice(0, 20),
      discoveryConfidence: Number(offer.competitorDiscoveryConfidence || 100),
      verificationStatus: "verified",
      verificationLabel: "Exact verified",
      rankByPrice: index + 1,
      lastSeen: offer.lastSeen,
      priceVerifiedAt: offer.priceVerifiedAt || null,
      lotSize: offer.lotSize == null ? null : Number(offer.lotSize),
      unitPrice: offer.unitPrice == null ? null : Number(offer.unitPrice),
      unitPriceCurrency: offer.unitPriceCurrency || offer.currency || "USD",
      unitPricingMeasure: offer.unitPricingMeasure || "",
    })),
    pendingOffers: pendingOffers.slice(0, 12).map(offer => ({
      offerId: offer.id,
      merchant: offer.merchant,
      observedPrice: Number(offer.searchObservedPrice ?? offer.price),
      shippingPrice:
        offer.shippingPrice == null ? null : Number(offer.shippingPrice),
      currency: offer.currency || "USD",
      condition: offer.condition || "",
      observedAt: offer.searchObservedAt || offer.lastSeen || null,
      queuedAt: offer.competitorIdentityQueuedAt || null,
      verificationStatus: "needs_verification",
      verificationLabel: "Needs verification",
      observedOnly: true,
      matchConfidence: Number(offer.matchConfidence || 0),
      discoveryMethods: normalizedCompetitorDiscoveryMethods(offer.competitorDiscoveryMethods),
      discoveryLabels: normalizedCompetitorDiscoveryLabels(offer.competitorDiscoveryLabels),
      discoveryPrimaryMethod: String(offer.competitorDiscoveryPrimaryMethod || "").slice(0, 40),
      discoveryPrimaryLabel: String(offer.competitorDiscoveryPrimaryLabel || "").slice(0, 80),
      discoveryTier: String(offer.competitorDiscoveryTier || competitorDiscoveryTier(offer.competitorDiscoveryConfidence)).slice(0, 20),
      discoveryConfidence: Number(offer.competitorDiscoveryConfidence || offer.matchConfidence || 0),
      discoveryReason: String(offer.competitorIdentityLastReason || "Browse candidate").slice(0, 240),
      exactDetailObservedAt: offer.competitorExactDetailObservedAt || null,
      outboundEligible: pendingEbayCompetitorLocallySafe(product, offer),
    })),
  };
}

function calculateMarketComparison(data, product, lookup = null) {
  const identityProofType = productEbayIdentityProofType(product);
  const active = offersFor(data, product.id, lookup)
    .filter(intelligenceEligibleListing)
    .filter(o =>
      o.availability !== "out_of_stock" &&
      !o.priceDisplayRestricted &&
      Number.isFinite(Number(o.price)) &&
      Number(o.price) > 0 &&
      (
        String(o.provider).toLowerCase() !== "ebay" ||
        (
          Boolean(o.priceVerifiedAt) &&
          ebayOfferTrust(data, product, o, { lookup }).trusted
        )
      )
    )
    .filter(o =>
      identityProofType || String(o.provider).toLowerCase() === "ebay"
    )
    .sort((a, b) => Number(a.price) - Number(b.price));

  const ebayOffers = active.filter(o => String(o.provider).toLowerCase() === "ebay");
  if (!ebayOffers.length) return null;

  // Cross-store same-product claims require a strong canonical identity too.
  // A weak title-only product may still show its source listing and its own
  // history, but OfferGrid will not imply that another merchant is the same
  // SKU until the canonical identity is provable.
  const competitors = identityProofType
    ? active.filter(o => String(o.provider).toLowerCase() !== "ebay")
    : [];
  const ebay = ebayOffers[0];
  const competitor = competitors[0] || null;
  const match = productMatchConfidence(product);
  const marketLow = active[0] || null;
  const prices = active.map(o => Number(o.price));
  const medianPrice = median(prices);
  const averagePrice = prices.length
    ? prices.reduce((sum, price) => sum + price, 0) / prices.length
    : null;

  const ebayRank =
    active.findIndex(o => o.id === ebay.id) + 1;

  const differenceVsCompetitor = competitor
    ? Number(ebay.price) - Number(competitor.price)
    : null;

  const differencePct = competitor && Number(competitor.price) > 0
    ? (differenceVsCompetitor / Number(competitor.price)) * 100
    : null;

  let verdict = "no-comparison";
  let verdictLabel = "Cross-store match not available yet";
  let marketValueScore = null;

  if (competitor) {
    if (differenceVsCompetitor < -0.005) {
      verdict = "ebay-lower";
      verdictLabel = "eBay is the lowest tracked cross-store price";
      marketValueScore = Math.min(100, 90 + Math.min(10, Math.abs(differencePct || 0) / 2));
    } else if (Math.abs(differenceVsCompetitor) <= 0.005) {
      verdict = "tied";
      verdictLabel = "eBay is tied for the lowest tracked price";
      marketValueScore = 90;
    } else if ((differencePct || 0) <= 2) {
      verdict = "competitive";
      verdictLabel = "eBay is within 2% of the lowest competing price";
      marketValueScore = 80;
    } else {
      verdict = "competitor-lower";
      verdictLabel = "A lower tracked price is available elsewhere";
      marketValueScore = Math.max(5, 75 - Math.min(70, (differencePct || 0) * 4));
    }

    marketValueScore = Math.round(
      marketValueScore * Math.max(0.65, match.score / 100)
    );
  }

  const merchantCount = new Set(
    active.map(o => `${String(o.provider).toLowerCase()}:${String(o.merchant).toLowerCase()}`)
  ).size;

  return {
    available: Boolean(competitor),
    identityProofAvailable: Boolean(identityProofType),
    identityProofType,
    identityMessage: identityProofType
      ? "Cross-store offers are only compared after canonical product identity is established."
      : "Cross-store same-product comparison is withheld because OfferGrid does not have a strong product identifier for this item.",
    ebayOfferId: ebay.id,
    ebayMerchant: ebay.merchant,
    ebayPrice: Number(ebay.price),
    currency: ebay.currency || "USD",
    competitorOfferId: competitor?.id || null,
    competitorProvider: competitor?.provider || "",
    competitorMerchant: competitor?.merchant || "",
    competitorPrice: competitor ? Number(competitor.price) : null,
    marketLowOfferId: marketLow?.id || null,
    marketLowProvider: marketLow?.provider || "",
    marketLowMerchant: marketLow?.merchant || "",
    marketLowPrice: marketLow ? Number(marketLow.price) : null,
    medianPrice: medianPrice == null ? null : Math.round(medianPrice * 100) / 100,
    averagePrice: averagePrice == null ? null : Math.round(averagePrice * 100) / 100,
    ebayRank,
    activeOfferCount: active.length,
    merchantCount,
    competitorCount: competitors.length,
    differenceVsCompetitor:
      differenceVsCompetitor == null
        ? null
        : Math.round(differenceVsCompetitor * 100) / 100,
    differencePct:
      differencePct == null
        ? null
        : Math.round(differencePct * 10) / 10,
    verdict,
    verdictLabel,
    marketValueScore,
    match,
    priceBasis: "Item price only",
    caveat:
      "Shipping, tax, membership pricing, coupons, condition, and bundle contents can differ. Verify the final merchant checkout price.",
    lastComparedAt: new Date(
      Math.max(...active.map(o => Date.parse(o.lastSeen || 0)).filter(Number.isFinite))
    ).toISOString(),
    offers: active.map((offer, index) => ({
      offerId: offer.id,
      provider: offer.provider,
      merchant: offer.merchant,
      price: Number(offer.price),
      currency: offer.currency || "USD",
      availability: offer.availability,
      score: Number(offer.score || 0),
      rankByPrice: index + 1,
      lastSeen: offer.lastSeen,
      isEbay: String(offer.provider).toLowerCase() === "ebay",
    })),
  };
}

function offerAccuracy(offer) {
  const provider = String(offer?.provider || "").toLowerCase();

  if (offer?.priceDisplayRestricted) {
    return {
      status: "restricted",
      label: "Price shown on merchant",
      verifiedAt: offer.priceVerifiedAt || null,
      source: offer.priceSource || "",
    };
  }

  if (provider !== "ebay") {
    return {
      status: "provider",
      label: "Provider-reported price",
      verifiedAt: offer.lastSeen || null,
      source: offer.priceSource || provider,
    };
  }

  if (offer?.priceVerifiedAt) {
    const ageMinutes =
      (Date.now() - Date.parse(offer.priceVerifiedAt)) / 60_000;
    return {
      status: ageMinutes <= 360 ? "verified" : "verified-stale",
      label: ageMinutes <= 360
        ? "Verified against eBay"
        : "Previously verified against eBay",
      verifiedAt: offer.priceVerifiedAt,
      source: "eBay item detail",
    };
  }

  return {
    status: "search",
    label: "Observed in eBay search",
    verifiedAt: offer.searchObservedAt || offer.lastSeen || null,
    source: "eBay search",
  };
}

function excludedConditionPriceStats(offer) {
  const price = Number(offer?.price);
  const currentPrice = Number.isFinite(price) && price > 0 ? price : null;
  return {
    currentPrice,
    historyCount: 0,
    dealHeatHistoryCount: 0,
    dealHeatOutliersPruned: 0,
    currentPriceAnomaly: false,
    average30d: null,
    low30d: null,
    high30d: null,
    priorLow30d: null,
    previousPrice: null,
    trackingStartedAt: null,
    savingsVsAveragePct: 0,
    changeVsPreviousPct: 0,
    changeSinceTrackingPct: 0,
    dealHeat: 0,
    heatLabel: "Excluded condition",
    heatConfidence: "excluded",
    newLow: false,
  };
}

function hydrateConditionExceptionProduct(data, product, { lookup = null, includeHistory = false } = {}) {
  const offers = conditionExceptionOffersFor(data, product.id, lookup)
    .filter(offer =>
      offer.availability !== "out_of_stock" &&
      !offer.priceDisplayRestricted &&
      Boolean(String(offer.affiliateUrl || "").trim())
    );
  const best = bestConditionExceptionOfferFor(data, product.id, lookup);
  if (!best) return null;

  const hydrated = {
    ...product,
    shopperVisible: true,
    conditionException: true,
    conditionExcludedFromIntelligence: true,
    conditionExclusionReason: listingConditionExclusionReason(best),
    verificationPending:
      String(best.provider || "").toLowerCase() === "ebay" && !best.priceVerifiedAt,
    offers,
    trackedOfferCount: offers.length,
    bestOffer: best,
    displayTitle: best.listingTitle || product.title,
    displayImageUrl: best.imageUrl || product.imageUrl,
    priceAccuracy: {
      ...offerAccuracy(best),
      label: best.priceVerifiedAt
        ? "Verified non-working/parts listing"
        : "Non-working/parts listing observed",
    },
    priceStats: excludedConditionPriceStats(best),
    priceSparkline: [],
    ebayCompetition: null,
    marketComparison: null,
    clicks30d: clicksForProduct(data, product.id, 30, lookup),
  };
  if (includeHistory) hydrated.priceHistory = [];
  return hydrated;
}

function hydrate(data, product, { includeHistory = false, lookup = null } = {}) {
  const offers = trustedOffersFor(data, product.id, lookup);
  // Resolve against the current offer set so a stale durable cache can never
  // put a more expensive seller on a shopper-facing card.
  const best = bestOfferFor(data, product.id, lookup);

  // Read-through is trigger-only: request handlers never perform Median/MAD or
  // whole-history reconstruction. A missing/stale snapshot is queued for the
  // CPU worker pool while the shopper receives the last durable snapshot (or a
  // conservative building-history placeholder for a brand-new product).
  maybeQueueProductSnapshot(product, { priority: "interactive", reason: "shopper-read-through" });

  const ebayCompetition = calculateEbayCompetition(data, product, lookup);
  const trackedOfferCount =
    offers.filter(offer =>
      offer.availability !== "out_of_stock" &&
      !offer.priceDisplayRestricted &&
      Boolean(String(offer.affiliateUrl || "").trim())
    ).length +
    Number(ebayCompetition?.pendingListingCount || 0);

  const hydrated = {
    ...product,
    offers,
    trackedOfferCount,
    bestOffer: best,
    displayTitle: best?.listingTitle || product.title,
    displayImageUrl: best?.imageUrl || product.imageUrl,
    priceAccuracy: best ? offerAccuracy(best) : null,
    priceStats: fallbackPriceStats(product, best),
    priceSparkline: Array.isArray(product.cachedPriceSparkline)
      ? product.cachedPriceSparkline
      : [],
    ebayCompetition,
    marketComparison: calculateMarketComparison(data, product, lookup),
    clicks30d: clicksForProduct(data, product.id, 30, lookup),
  };
  if (includeHistory) {
    // The ALL chart can span the compressed long-term archive without keeping
    // every old raw observation. Weekly/monthly buckets are lightweight.
    const historyDays = Math.max(
      Number(process.env.PRICE_HISTORY_DAYS || 365),
      Number(process.env.PRICE_AGGREGATE_RETENTION_DAYS || 3650)
    );

    hydrated.priceHistory = historyFor(
      data,
      product.id,
      historyDays,
      lookup
    );
  }

  return hydrated;
}

function rescoreProductInDb(data, productId) {
  const subset = data.offers.filter(o => o.productId === productId);
  const rescored = rescoreIntelligenceOfferGroup(subset);
  const map = new Map(rescored.map(o => [o.id, o]));
  data.offers = data.offers.map(o => map.get(o.id) || o);
}

function rescoreAllProductsInDb(data, { onProgress = null } = {}) {
  const products = Array.isArray(data.products) ? data.products : [];
  const offers = Array.isArray(data.offers) ? data.offers : [];
  const offersByProductId = new Map();

  for (const offer of offers) {
    const key = offer.productId;
    if (!offersByProductId.has(key)) offersByProductId.set(key, []);
    offersByProductId.get(key).push(offer);
  }

  const rescoredById = new Map();
  const total = products.length;
  const startedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "catalog-integrity-rescore",
    state: "start",
    current: 0,
    total,
    message: "rescoring offers once per product without whole-catalog replacement scans",
  });

  for (let index = 0; index < total; index++) {
    const product = products[index];
    const subset = offersByProductId.get(product.id) || [];
    for (const rescored of rescoreIntelligenceOfferGroup(subset)) {
      rescoredById.set(rescored.id, rescored);
    }

    emitDbStartupProgress(onProgress, {
      phase: "catalog-integrity-rescore",
      state: index + 1 === total ? "done" : "progress",
      current: index + 1,
      total,
      durationMs: Date.now() - startedAt,
      message: "rescoring integrity-repaired offers",
    });
  }

  if (!total) {
    emitDbStartupProgress(onProgress, {
      phase: "catalog-integrity-rescore",
      state: "done",
      current: 0,
      total: 0,
      durationMs: Date.now() - startedAt,
      message: "no products required rescoring",
    });
  }

  if (rescoredById.size) {
    data.offers = offers.map(offer => rescoredById.get(offer.id) || offer);
  }
}

function rescoreIntelligenceOfferGroup(offers = []) {
  const eligible = offers.filter(intelligenceEligibleListing);
  const rescoredEligible = new Map(
    rescoreOffers(eligible).map(offer => [Number(offer.id), offer])
  );

  return offers.map(offer => {
    if (!intelligenceEligibleListing(offer)) {
      return {
        ...offer,
        score: 0,
        comparisonPrice: null,
        conditionExcludedFromIntelligence: true,
        conditionExclusionReason: listingConditionExclusionReason(offer),
      };
    }
    return rescoredEligible.get(Number(offer.id)) || offer;
  });
}

function rescoreProductIdsInDb(data, productIds = [], lookup = null) {
  const targetIds = new Set(
    (productIds || []).map(Number).filter(Number.isFinite)
  );
  if (!targetIds.size) return 0;

  const effectiveLookup = lookup || buildPageHydrationLookup(data, [...targetIds], {
    approvedOnly: false,
    includeClicks: false,
  });

  for (const productId of targetIds) {
    const originals = effectiveLookup.offersByNumericProductId.get(productId) || [];
    const rescored = rescoreIntelligenceOfferGroup(originals);
    for (let index = 0; index < originals.length; index++) {
      Object.assign(originals[index], rescored[index] || {});
    }
    originals.sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.price || Infinity) - Number(b.price || Infinity));
  }

  return targetIds.size;
}

function recordBestPriceInDb(data, productId, force = false) {
  const best = bestOfferFor(data, productId);
  if (!best) return false;

  if (
    String(best.provider).toLowerCase() === "ebay" &&
    !best.priceVerifiedAt
  ) {
    return false;
  }

  const productHistory = data.priceHistory
    .filter(h => h.productId === productId)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = productHistory.at(-1);
  const sixHours = 6 * 3_600_000;
  const priceChanged = !last || Math.abs(Number(last.price) - Number(best.price)) >= 0.005;
  const oldEnough = !last || Date.now() - Date.parse(last.at) >= sixHours;

  if (!force && !priceChanged && !oldEnough) return false;

  const observedAt = nowIso();

  data.priceHistory.push({
    productId,
    offerId: best.id,
    price: Number(best.price),
    currency: best.currency,
    merchant: best.merchant,
    source:
      String(best.provider).toLowerCase() === "ebay"
        ? "ebay-item-detail"
        : String(best.provider || "provider"),
    verifiedAt: best.priceVerifiedAt || null,
    at: observedAt,
  });

  const product = data.products.find(
    item => Number(item.id) === Number(productId)
  );

  if (product) {
    product.lifecycleLastObservationAt = maxIso(
      product.lifecycleLastObservationAt,
      observedAt
    );

    if (best.availability !== "out_of_stock") {
      product.lifecycleLastActiveAt = maxIso(
        product.lifecycleLastActiveAt,
        observedAt
      );
    }
  }

  return true;
}

function recordBestPricesForIdsInDb(
  data,
  productIds = [],
  { forceProductIds = [], lookup = null } = {}
) {
  const targetIds = [...new Set(
    Array.from(productIds || []).map(Number).filter(Number.isFinite)
  )];
  if (!targetIds.length) return 0;

  const targetSet = new Set(targetIds);
  const forceSet = new Set(
    Array.from(forceProductIds || []).map(Number).filter(Number.isFinite)
  );
  const effectiveLookup = lookup || buildPageHydrationLookup(data, targetIds, {
    approvedOnly: false,
    includeClicks: false,
  });
  const lastHistoryByProduct = new Map();

  // recordBestPriceInDb() historically filtered and sorted the entire history
  // array once per product. Preserve the exact newest-observation semantics in
  // one pass across history for the whole touched set.
  for (const entry of data.priceHistory || []) {
    const productId = Number(entry.productId);
    if (!targetSet.has(productId)) continue;

    const current = lastHistoryByProduct.get(productId);
    const at = Date.parse(entry.at || "");
    const currentAt = current ? Date.parse(current.at || "") : -Infinity;
    if (!current || at >= currentAt) {
      lastHistoryByProduct.set(productId, entry);
    }
  }

  const sixHours = 6 * 3_600_000;
  let recorded = 0;

  for (const productId of targetIds) {
    const best = bestOfferFor(data, productId, effectiveLookup);
    if (!best) continue;

    if (
      String(best.provider).toLowerCase() === "ebay" &&
      !best.priceVerifiedAt
    ) {
      continue;
    }

    const last = lastHistoryByProduct.get(productId);
    const priceChanged =
      !last || Math.abs(Number(last.price) - Number(best.price)) >= 0.005;
    const oldEnough =
      !last || Date.now() - Date.parse(last.at) >= sixHours;

    if (!forceSet.has(productId) && !priceChanged && !oldEnough) continue;

    const observedAt = nowIso();
    const history = {
      productId,
      offerId: best.id,
      price: Number(best.price),
      currency: best.currency,
      merchant: best.merchant,
      source:
        String(best.provider).toLowerCase() === "ebay"
          ? "ebay-item-detail"
          : String(best.provider || "provider"),
      verifiedAt: best.priceVerifiedAt || null,
      at: observedAt,
    };

    data.priceHistory.push(history);
    lastHistoryByProduct.set(productId, history);
    recorded++;

    const product = effectiveLookup.productByNumericId.get(productId);
    if (product) {
      product.lifecycleLastObservationAt = maxIso(
        product.lifecycleLastObservationAt,
        observedAt
      );

      if (best.availability !== "out_of_stock") {
        product.lifecycleLastActiveAt = maxIso(
          product.lifecycleLastActiveAt,
          observedAt
        );
      }
    }
  }

  return recorded;
}

function compactSparklinePoints(points, maxPoints = 18) {
  const clean = (points || [])
    .filter(point =>
      point &&
      Number.isFinite(Number(point.price)) &&
      Number.isFinite(Date.parse(point.at || ""))
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  if (clean.length <= maxPoints) return clean;

  // Preserve first/last values and sample the interior evenly. This keeps
  // payloads tiny while retaining the visible long-term price shape.
  const sampled = [clean[0]];
  const interiorSlots = Math.max(1, maxPoints - 2);
  const interiorCount = clean.length - 2;

  for (let slot = 1; slot <= interiorSlots; slot++) {
    const index = Math.min(
      clean.length - 2,
      1 + Math.round(
        ((slot - 1) * Math.max(0, interiorCount - 1)) /
        Math.max(1, interiorSlots - 1)
      )
    );

    const point = clean[index];
    if (
      point &&
      sampled.at(-1)?.at !== point.at
    ) {
      sampled.push(point);
    }
  }

  const last = clean.at(-1);
  if (sampled.at(-1)?.at !== last.at) sampled.push(last);

  return sampled.slice(-maxPoints);
}

function buildPriceSparklineIndex(data, {
  days = 365,
  maxPoints = 18,
  onProgress = null,
  lookup = null,
  blockedOfferIds = null,
  productIds = null,
} = {}) {
  const cutoff = Date.now() - Math.max(30, Number(days || 365)) * DAY_MS;
  const targetIds = productIds
    ? new Set(Array.from(productIds || []).map(Number).filter(Number.isFinite))
    : null;
  const byProduct = new Map();

  function add(productId, at, price, meta = {}) {
    const id = Number(productId);
    const parsedAt = Date.parse(at || "");
    const numericPrice = Number(price);

    if (
      !Number.isFinite(id) ||
      (targetIds && !targetIds.has(id)) ||
      !Number.isFinite(parsedAt) ||
      parsedAt < cutoff ||
      !Number.isFinite(numericPrice)
    ) return;

    if (!byProduct.has(id)) byProduct.set(id, []);

    byProduct.get(id).push({
      at: new Date(parsedAt).toISOString(),
      price: Math.round(numericPrice * 100) / 100,
      low: Number.isFinite(Number(meta.low))
        ? Math.round(Number(meta.low) * 100) / 100
        : null,
      high: Number.isFinite(Number(meta.high))
        ? Math.round(Number(meta.high) * 100) / 100
        : null,
      sampleCount: Math.max(1, Number(meta.sampleCount || 1)),
      aggregated: Boolean(meta.aggregated),
      granularity: meta.granularity || null,
    });
  }

  const blockedHistoryOfferIds = blockedOfferIds instanceof Set
    ? blockedOfferIds
    : blockedCompetitorHistoryOfferIds(data, {
        onProgress,
        lookup,
        productIds: targetIds,
      });

  const rawHistory = Array.isArray(data.priceHistory) ? data.priceHistory : [];
  const rawStartedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "price-signal-raw-history",
    state: "start",
    current: 0,
    total: rawHistory.length,
    message: "indexing raw verified price observations",
  });
  for (let index = 0; index < rawHistory.length; index++) {
    const point = rawHistory[index];
    if (!blockedHistoryOfferIds.has(Number(point.offerId))) {
      add(point.productId, point.at, point.price, {
        aggregated: false,
        sampleCount: 1,
      });
    }
    emitDbStartupProgress(onProgress, {
      phase: "price-signal-raw-history",
      state: "progress",
      current: index + 1,
      total: rawHistory.length,
      durationMs: Date.now() - rawStartedAt,
      message: "indexing raw verified price observations",
    });
  }
  emitDbStartupProgress(onProgress, {
    phase: "price-signal-raw-history",
    state: "done",
    current: rawHistory.length,
    total: rawHistory.length,
    durationMs: Date.now() - rawStartedAt,
    message: "raw price-history observations indexed",
  });

  const aggregates = Array.isArray(data.priceAggregates) ? data.priceAggregates : [];
  const unsafeAggregateProducts = conditionUnsafeAggregateProductIds(data, {
    lookup,
    productIds: targetIds,
  });
  const aggregateStartedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "price-signal-aggregates",
    state: "start",
    current: 0,
    total: aggregates.length,
    message: "indexing compressed historical price aggregates",
  });
  for (let index = 0; index < aggregates.length; index++) {
    const aggregate = aggregates[index];
    if (!aggregateConditionEligible(aggregate, unsafeAggregateProducts)) {
      emitDbStartupProgress(onProgress, {
        phase: "price-signal-aggregates",
        state: "progress",
        current: index + 1,
        total: aggregates.length,
        durationMs: Date.now() - aggregateStartedAt,
        message: "skipping legacy aggregate with possible parts/broken contamination",
      });
      continue;
    }
    add(
      aggregate.productId,
      aggregate.endAt || aggregate.startAt,
      aggregate.average,
      {
        low: aggregate.low,
        high: aggregate.high,
        sampleCount: aggregate.sampleCount,
        aggregated: true,
        granularity: aggregate.granularity,
      }
    );
    emitDbStartupProgress(onProgress, {
      phase: "price-signal-aggregates",
      state: "progress",
      current: index + 1,
      total: aggregates.length,
      durationMs: Date.now() - aggregateStartedAt,
      message: "indexing compressed historical price aggregates",
    });
  }
  emitDbStartupProgress(onProgress, {
    phase: "price-signal-aggregates",
    state: "done",
    current: aggregates.length,
    total: aggregates.length,
    durationMs: Date.now() - aggregateStartedAt,
    message: "compressed historical aggregates indexed",
  });

  const result = new Map();
  const sparklineEntries = [...byProduct.entries()];
  const compactStartedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "price-signal-compaction",
    state: "start",
    current: 0,
    total: sparklineEntries.length,
    message: "sorting and compacting per-product sparkline points",
  });

  for (let index = 0; index < sparklineEntries.length; index++) {
    const [productId, points] = sparklineEntries[index];
    result.set(
      productId,
      compactSparklinePoints(points, maxPoints)
    );
    emitDbStartupProgress(onProgress, {
      phase: "price-signal-compaction",
      state: "progress",
      current: index + 1,
      total: sparklineEntries.length,
      durationMs: Date.now() - compactStartedAt,
      message: "sorting and compacting per-product sparkline points",
    });
  }

  emitDbStartupProgress(onProgress, {
    phase: "price-signal-compaction",
    state: "done",
    current: sparklineEntries.length,
    total: sparklineEntries.length,
    durationMs: Date.now() - compactStartedAt,
    message: `${result.size.toLocaleString()} product sparklines compacted`,
  });

  return result;
}


function snapshotStatsLookValid(stats) {
  if (!stats || typeof stats !== "object") return false;
  const heat = Number(stats.dealHeat);
  if (!Number.isFinite(heat) || heat < 0 || heat > 100) return false;
  if (stats.currentPrice != null) {
    const current = Number(stats.currentPrice);
    if (!Number.isFinite(current) || current <= 0) return false;
  }
  return typeof stats.heatLabel === "string" && typeof stats.heatConfidence === "string";
}

function productSnapshotNeedsRefresh(product, { allowStale = false } = {}) {
  if (!product) return false;
  if (product.intelligenceDirty) return true;
  if (Number(product.intelligenceSnapshotVersion || 0) < INTELLIGENCE_SNAPSHOT_SCHEMA_VERSION) return true;
  if (!snapshotStatsLookValid(product.cachedPriceStats)) return true;
  if (!Array.isArray(product.cachedPriceSparkline)) return true;

  if (!allowStale) {
    const computedAt = Date.parse(product.intelligenceComputedAt || "");
    if (!Number.isFinite(computedAt)) return true;
    if (Date.now() - computedAt > INTELLIGENCE_STALE_MINUTES * 60_000) return true;
  }

  return false;
}

function markProductsIntelligenceDirtyInDb(data, productIds = [], reason = "mutation") {
  const ids = new Set(Array.from(productIds || []).map(Number).filter(Number.isFinite));
  if (!ids.size) return 0;
  const at = nowIso();
  let marked = 0;

  for (const product of data.products || []) {
    const id = Number(product.id);
    if (!ids.has(id)) continue;
    product.intelligenceGeneration = Math.max(0, Number(product.intelligenceGeneration || 0)) + 1;
    product.intelligenceDirty = true;
    product.intelligenceDirtyAt = at;
    product.intelligenceDirtyReason = String(reason || "mutation").slice(0, 120);
    product.intelligenceLastError = "";
    marked++;
  }

  return marked;
}

function fallbackPriceStats(product, best) {
  if (snapshotStatsLookValid(product?.cachedPriceStats)) return product.cachedPriceStats;
  const current = best && Number.isFinite(Number(best.price)) ? Number(best.price) : null;
  return {
    currentPrice: current,
    historyCount: 0,
    dealHeatHistoryCount: 0,
    dealHeatOutliersPruned: 0,
    currentPriceAnomaly: false,
    average30d: current,
    low30d: current,
    high30d: current,
    priorLow30d: null,
    previousPrice: null,
    trackingStartedAt: null,
    savingsVsAveragePct: 0,
    changeVsPreviousPct: 0,
    changeSinceTrackingPct: 0,
    dealHeat: 0,
    heatLabel: current == null ? "Unavailable" : "Building history",
    heatConfidence: current == null ? "none" : "building",
    newLow: false,
  };
}

function verifiedEbaySellerCountInDb(data, product, lookup = null) {
  if (!product) return 0;
  const sellers = new Set();
  for (const offer of offersFor(data, product.id, lookup)) {
    if (!intelligenceEligibleListing(offer)) continue;
    if (!isEbayOffer(offer)) continue;
    if (offer.availability === "out_of_stock" || offer.priceDisplayRestricted) continue;
    if (!offer.priceVerifiedAt) continue;
    if (!Number.isFinite(Number(offer.price)) || Number(offer.price) <= 0) continue;
    if (!ebayOfferTrust(data, product, offer, { lookup }).trusted) continue;
    const merchant = String(offer.merchant || "").trim().toLowerCase();
    if (merchant) sellers.add(merchant);
  }
  return sellers.size;
}

function repairConditionAwareSellerCountCachesInDb(data, { onProgress = null } = {}) {
  data.meta ||= {};
  const requiredVersion = 5;
  const currentVersion = Math.max(0, Number(data.meta.conditionAwareSellerCountCacheVersion || 0));
  if (currentVersion >= requiredVersion) {
    return { skipped: true, version: currentVersion, scannedProducts: 0, changedProducts: 0 };
  }

  const ebayProductIds = new Set();
  for (const offer of data.offers || []) {
    if (!isEbayOffer(offer)) continue;
    const productId = Number(offer.productId);
    if (Number.isFinite(productId)) ebayProductIds.add(productId);
  }
  const candidateIds = (data.products || [])
    .map(product => Number(product.id))
    .filter(productId => Number.isFinite(productId) && ebayProductIds.has(productId));

  emitDbStartupProgress(onProgress, {
    phase: "condition-seller-cache-repair",
    state: "start",
    current: 0,
    total: candidateIds.length,
    message: "reconciling verified eBay seller caches with current trust and condition rules",
  });

  const byId = new Map((data.products || []).map(product => [Number(product.id), product]));
  const batchSize = 250;
  let changedProducts = 0;
  let invalidatedCoverage = 0;

  for (let offset = 0; offset < candidateIds.length; offset += batchSize) {
    const batchIds = candidateIds.slice(offset, offset + batchSize);
    const lookup = buildPageHydrationLookup(data, batchIds, {
      approvedOnly: false,
      includeClicks: false,
    });

    for (const productId of batchIds) {
      const product = byId.get(productId);
      if (!product) continue;
      const previous = Math.max(0, Number(product.cachedVerifiedSellerCount || 0));
      const next = verifiedEbaySellerCountInDb(data, product, lookup);
      if (next === previous) continue;

      product.cachedVerifiedSellerCount = next;
      changedProducts++;
      // A legacy completion marker may have reached its target using sellers
      // that are now condition-ineligible. Clear it so the next shopper/
      // background pass can research replacement working-condition sellers.
      if (next < previous) {
        product.ebayCompetitorCoverageCompleteAt = null;
        product.ebayCompetitorCoverageTargetSellers = 0;
        product.ebayCompetitorCoverageSellerCount = next;
        product.ebayCompetitorCoverageSignalsExhausted = false;
        product.ebayCompetitorCoverageStatus = "seller-cache-coherence-repair";
        invalidatedCoverage++;
      }
    }

    const current = Math.min(candidateIds.length, offset + batchIds.length);
    emitDbStartupProgress(onProgress, {
      phase: "condition-seller-cache-repair",
      state: current === candidateIds.length ? "done" : "progress",
      current,
      total: candidateIds.length,
      message: "reconciling verified eBay seller caches with current trust and condition rules",
    });
  }

  if (!candidateIds.length) {
    emitDbStartupProgress(onProgress, {
      phase: "condition-seller-cache-repair",
      state: "done",
      current: 0,
      total: 0,
      message: "no eBay seller caches required reconciliation",
    });
  }

  data.meta.conditionAwareSellerCountCacheVersion = requiredVersion;
  data.meta.conditionAwareSellerCountCacheLastRunAt = nowIso();
  data.meta.conditionAwareSellerCountCacheChangedProducts = changedProducts;
  data.meta.conditionAwareSellerCountCoverageInvalidated = invalidatedCoverage;
  if (changedProducts) SEARCH_INDEX_REVISION++;

  return {
    skipped: false,
    version: requiredVersion,
    scannedProducts: candidateIds.length,
    changedProducts,
    invalidatedCoverage,
  };
}

function repairBestOfferCachesInDb(data, { onProgress = null } = {}) {
  data.meta ||= {};
  const currentVersion = Math.max(0, Number(data.meta.bestOfferCacheSchemaVersion || 0));
  if (currentVersion >= BEST_OFFER_CACHE_SCHEMA_VERSION) {
    return { skipped: true, version: currentVersion, scannedProducts: 0, changedProducts: 0 };
  }

  const productIds = (data.products || [])
    .map(product => Number(product.id))
    .filter(Number.isFinite);
  const byId = new Map((data.products || []).map(product => [Number(product.id), product]));
  const batchSize = 250;
  let changedProducts = 0;

  emitDbStartupProgress(onProgress, {
    phase: "best-offer-cache-repair",
    state: "start",
    current: 0,
    total: productIds.length,
    message: "reconciling shopper cards to the lowest eligible verified offer",
  });

  for (let offset = 0; offset < productIds.length; offset += batchSize) {
    const batchIds = productIds.slice(offset, offset + batchSize);
    const lookup = buildPageHydrationLookup(data, batchIds, {
      approvedOnly: false,
      includeClicks: false,
    });

    for (const productId of batchIds) {
      const product = byId.get(productId);
      if (!product) continue;
      const previousId = product.cachedBestOfferId == null ? null : Number(product.cachedBestOfferId);
      const previousPrice = product.cachedBestPrice == null ? null : Number(product.cachedBestPrice);
      const best = bestOfferFor(data, productId, lookup);
      const nextId = best?.id == null ? null : Number(best.id);
      const nextPrice = best && Number.isFinite(Number(best.price)) ? Number(best.price) : null;

      refreshProductFastCacheInDb(data, productId, lookup);
      if (previousId === nextId && previousPrice === nextPrice) continue;

      changedProducts++;
      product.intelligenceGeneration = Math.max(0, Number(product.intelligenceGeneration || 0)) + 1;
      product.intelligenceDirty = true;
      product.intelligenceDirtyAt = nowIso();
      product.intelligenceDirtyReason = "best-offer-cache-migration";
      product.intelligenceLastError = "";
      // Never show a Deal Heat value calculated for a different seller price.
      // The background intelligence pool will replace this conservative state.
      product.cachedPriceStats = null;
      product.intelligenceSnapshotVersion = 0;
      PENDING_STARTUP_INTELLIGENCE_IDS.add(productId);
    }

    const current = Math.min(productIds.length, offset + batchIds.length);
    emitDbStartupProgress(onProgress, {
      phase: "best-offer-cache-repair",
      state: current === productIds.length ? "done" : "progress",
      current,
      total: productIds.length,
      message: "reconciling shopper cards to the lowest eligible verified offer",
    });
  }

  if (!productIds.length) {
    emitDbStartupProgress(onProgress, {
      phase: "best-offer-cache-repair",
      state: "done",
      current: 0,
      total: 0,
      message: "no shopper offer caches required reconciliation",
    });
  }

  data.meta.bestOfferCacheSchemaVersion = BEST_OFFER_CACHE_SCHEMA_VERSION;
  data.meta.bestOfferCacheLastRunAt = nowIso();
  data.meta.bestOfferCacheChangedProducts = changedProducts;
  if (changedProducts) SEARCH_INDEX_REVISION++;

  return {
    skipped: false,
    version: BEST_OFFER_CACHE_SCHEMA_VERSION,
    scannedProducts: productIds.length,
    changedProducts,
  };
}

function refreshProductFastCacheInDb(data, productId, lookup = null) {
  const product = lookup?.productByExactId
    ? lookup.productByExactId.get(Number(productId))
    : data.products.find(p => Number(p.id) === Number(productId));
  if (!product) return null;

  const best = bestOfferFor(data, product.id, lookup);
  product.searchText = [
    product.title,
    product.brand,
    product.category,
    product.editorNote,
    product.aiSummary,
    ...(Array.isArray(product.tags) ? product.tags : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  product.cachedBestOfferId = best?.id ?? null;
  product.cachedBestPrice = best && Number.isFinite(Number(best.price))
    ? Number(best.price)
    : null;
  product.cachedBestScore = Number(best?.score || 0);
  product.cachedVerificationRank = !best
    ? 0
    : String(best.provider || "").toLowerCase() !== "ebay"
      ? 2
      : best.priceVerifiedAt
        ? 2
        : 0;
  product.cachedVerifiedSellerCount = verifiedEbaySellerCountInDb(data, product, lookup);

  return product;
}

function refreshProductFastCachesForIdsInDb(data, productIds = [], { lookup = null } = {}) {
  const ids = [...new Set(Array.from(productIds || []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return 0;
  const effectiveLookup = lookup || buildPageHydrationLookup(data, ids, {
    approvedOnly: false,
    includeClicks: false,
  });
  let refreshed = 0;
  for (const id of ids) {
    if (refreshProductFastCacheInDb(data, id, effectiveLookup)) refreshed++;
  }
  if (refreshed) SEARCH_INDEX_REVISION++;
  return refreshed;
}

function maybeQueueProductSnapshot(product, { priority = "interactive", reason = "read-through" } = {}) {
  if (!product || !productSnapshotNeedsRefresh(product)) return false;

  if (!product.intelligenceDirty) {
    product.intelligenceGeneration = Math.max(0, Number(product.intelligenceGeneration || 0)) + 1;
    product.intelligenceDirty = true;
    product.intelligenceDirtyAt = nowIso();
    product.intelligenceDirtyReason = String(reason || "read-through").slice(0, 120);
  }

  enqueueIntelligenceProducts([product.id], { priority, reason });
  return true;
}

async function buildIntelligenceJobsForIds(productIds = []) {
  await waitForInteractiveIdle({
    reason: "intelligence-job-prep",
    quietMs: Math.max(25, Number(process.env.INTELLIGENCE_PREP_QUIET_MS || 50)),
  });
  const data = readDb();
  const targetIds = [...new Set(Array.from(productIds || []).map(Number).filter(Number.isFinite))];
  if (!targetIds.length) return [];

  const targetSet = new Set(targetIds);
  const lookup = buildPageHydrationLookup(data, targetIds, {
    approvedOnly: false,
    includeClicks: false,
  });
  const blockedOfferIds = blockedCompetitorHistoryOfferIds(data, {
    lookup,
    productIds: targetIds,
  });
  const unsafeAggregateProducts = conditionUnsafeAggregateProductIds(data, {
    lookup,
    productIds: targetIds,
  });
  const cutoff365 = Date.now() - 365 * DAY_MS;
  const cutoff30 = Date.now() - 30 * DAY_MS;
  const historyByProduct = new Map(targetIds.map(id => [id, []]));

  for (const aggregate of data.priceAggregates || []) {
    const productId = Number(aggregate.productId);
    if (!targetSet.has(productId)) continue;
    if (!aggregateConditionEligible(aggregate, unsafeAggregateProducts)) continue;
    const at = aggregate.endAt || aggregate.startAt;
    const parsedAt = Date.parse(at || "");
    if (!Number.isFinite(parsedAt) || parsedAt < cutoff365) continue;
    const price = Number(aggregate.average);
    if (!Number.isFinite(price) || price <= 0) continue;
    historyByProduct.get(productId).push({
      productId,
      offerId: null,
      price,
      low: Number(aggregate.low),
      high: Number(aggregate.high),
      currency: aggregate.currency || "USD",
      merchant: "",
      source: aggregate.source || "compressed-price-history",
      verifiedAt: Number(aggregate.verifiedCount || 0) > 0 ? at : null,
      at,
      aggregated: true,
      granularity: aggregate.granularity,
      sampleCount: Number(aggregate.sampleCount || 1),
      bucket: aggregate.bucket,
    });
  }

  for (const point of data.priceHistory || []) {
    const productId = Number(point.productId);
    if (!targetSet.has(productId)) continue;
    if (blockedOfferIds.has(Number(point.offerId))) continue;
    const parsedAt = Date.parse(point.at || "");
    if (!Number.isFinite(parsedAt) || parsedAt < cutoff365) continue;
    const price = Number(point.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    historyByProduct.get(productId).push({ ...point, price, aggregated: false });
  }

  const jobs = [];
  for (const productId of targetIds) {
    const product = lookup.productByNumericId.get(productId);
    if (!product) continue;
    const history = historyByProduct.get(productId) || [];
    history.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
    const best = bestOfferFor(data, productId, lookup);
    jobs.push({
      productId,
      generation: Number(product.intelligenceGeneration || 0),
      bestOffer: best ? {
        id: Number(best.id),
        price: Number(best.price),
        originalPrice: best.originalPrice == null ? null : Number(best.originalPrice),
        score: Number(best.score || 0),
      } : null,
      history30d: history.filter(point => Date.parse(point.at || 0) >= cutoff30),
      sparklineHistory: history.map(point => ({
        at: point.at,
        price: Number(point.price),
        low: Number.isFinite(Number(point.low)) ? Number(point.low) : null,
        high: Number.isFinite(Number(point.high)) ? Number(point.high) : null,
        sampleCount: Math.max(1, Number(point.sampleCount || 1)),
        aggregated: Boolean(point.aggregated),
        granularity: point.granularity || null,
      })),
    });
  }

  return jobs;
}

async function applyIntelligenceWorkerResults(results = []) {
  const data = readDb();
  const accepted = [];
  const staleIds = [];
  const byId = new Map((data.products || []).map(product => [Number(product.id), product]));

  for (const result of results || []) {
    const productId = Number(result?.productId);
    const product = byId.get(productId);
    if (!product) continue;
    if (Number(result.generation || 0) !== Number(product.intelligenceGeneration || 0)) {
      staleIds.push(productId);
      continue;
    }

    if (!snapshotStatsLookValid(result.stats) || !Array.isArray(result.sparkline)) {
      product.intelligenceDirty = true;
      product.intelligenceLastError = "worker-result-validation-failed";
      staleIds.push(productId);
      continue;
    }

    product.cachedPriceStats = result.stats;
    product.cachedPriceSparkline = result.sparkline.slice(-24);
    product.intelligenceSnapshotVersion = INTELLIGENCE_SNAPSHOT_SCHEMA_VERSION;
    product.intelligenceComputedAt = result.computedAt || nowIso();
    product.intelligenceDirty = false;
    product.intelligenceDirtyAt = null;
    product.intelligenceDirtyReason = "";
    product.intelligenceLastError = "";
    accepted.push(productId);
  }

  if (accepted.length) {
    SEARCH_INDEX_REVISION++;
    for (const productId of accepted) PENDING_INTELLIGENCE_LIVE_IDS.add(Number(productId));
    scheduleDeferredWrite(
      data,
      Math.max(1_000, Number(process.env.INTELLIGENCE_SNAPSHOT_PERSIST_MS || 15_000))
    );
  }

  return { acceptedIds: accepted, staleIds };
}

configureIntelligenceWorkerPool({
  buildJobs: buildIntelligenceJobsForIds,
  applyResults: applyIntelligenceWorkerResults,
});

function refreshProductCacheInDb(
  data,
  productId,
  sparklineIndex = null,
  cacheContext = null
) {
  const product = cacheContext?.lookup?.productByExactId
    ? cacheContext.lookup.productByExactId.get(Number(productId))
    : data.products.find(p => p.id === Number(productId));
  if (!product) return null;

  const lookup = cacheContext?.lookup || null;
  const best = bestOfferFor(data, product.id, lookup);
  const historyOverride = cacheContext?.dealHeatHistoryIndex
    ? cacheContext.dealHeatHistoryIndex.get(Number(product.id)) || []
    : null;
  const stats = best ? calculatePriceStats(data, product.id, {
    lookup,
    bestOffer: best,
    historyOverride,
  }) : {
    currentPrice: null,
    historyCount: 0,
    average30d: null,
    low30d: null,
    high30d: null,
    priorLow30d: null,
    previousPrice: null,
    trackingStartedAt: null,
    savingsVsAveragePct: 0,
    changeVsPreviousPct: 0,
    changeSinceTrackingPct: 0,
    dealHeat: 0,
    heatLabel: "Unavailable",
    heatConfidence: "none",
    newLow: false,
  };

  product.searchText = [
    product.title,
    product.brand,
    product.category,
    product.editorNote,
    product.aiSummary,
    ...(Array.isArray(product.tags) ? product.tags : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  product.cachedBestOfferId = best?.id ?? null;
  product.cachedBestPrice =
    best && Number.isFinite(Number(best.price))
      ? Number(best.price)
      : null;
  product.cachedBestScore = Number(best?.score || 0);
  product.cachedVerificationRank =
    !best
      ? 0
      : String(best.provider || "").toLowerCase() !== "ebay"
        ? 2
        : best.priceVerifiedAt
          ? 2
          : 0;
  product.cachedVerifiedSellerCount = verifiedEbaySellerCountInDb(data, product, lookup);
  product.cachedPriceStats = stats;

  const sparklinePoints = sparklineIndex
    ? sparklineIndex.get(Number(product.id)) || []
    : buildPriceSparklineIndex(data, {
        days: 365,
        maxPoints: 18,
      }).get(Number(product.id)) || [];

  product.cachedPriceSparkline = sparklinePoints;
  product.intelligenceSnapshotVersion = INTELLIGENCE_SNAPSHOT_SCHEMA_VERSION;
  product.intelligenceComputedAt = nowIso();
  product.intelligenceDirty = false;
  product.intelligenceDirtyAt = null;
  product.intelligenceDirtyReason = "";
  product.intelligenceLastError = "";
  SEARCH_INDEX_REVISION++;

  return product;
}

function liveProductSummary(data, productId, lookup = null) {
  const numericProductId = Number(productId);
  const product = lookup?.productByNumericId
    ? lookup.productByNumericId.get(numericProductId)
    : data.products.find(item => Number(item.id) === numericProductId);
  if (!product) return { id: numericProductId, deleted: true };

  const best = bestOfferFor(data, product.id, lookup);
  const stats = fallbackPriceStats(product, best);

  return {
    id: Number(product.id),
    title: String(product.title || "").slice(0, 500),
    brand: String(product.brand || "").slice(0, 200),
    category: String(product.category || "Other").slice(0, 200),
    approved: Boolean(product.approved),
    lifecycleState: String(product.lifecycleState || "ACTIVE"),
    updatedAt: product.updatedAt || null,
    heat: Number(stats?.dealHeat || 0),
    heatLabel: String(stats?.heatLabel || "Watch").slice(0, 80),
    newLow: Boolean(stats?.newLow),
    price: best && Number.isFinite(Number(best.price)) ? Number(best.price) : null,
    currency: String(best?.currency || "USD").slice(0, 12),
    verifiedAt: best?.priceVerifiedAt || null,
    provider: String(best?.provider || "").slice(0, 40),
  };
}

function publishProductLiveMutation(data, {
  type = "catalog",
  reason = "catalog-update",
  productIds = [],
  deletedProductIds = [],
  metadata = {},
  lookup = null,
} = {}) {
  const ids = [...new Set(Array.from(productIds || []).map(Number).filter(Number.isFinite))];
  // Live notifications only summarize the products named by this mutation.
  // Never rebuild the complete runtime relationship graph merely to publish an
  // SSE update after a small ingest/edit; callers may still pass an already
  // prepared scoped lookup to avoid even this one linear relationship pass.
  const liveLookup = ids.length
    ? (lookup || buildPageHydrationLookup(data, ids, {
        approvedOnly: false,
        includeClicks: false,
      }))
    : null;
  const products = ids
    .map(id => liveProductSummary(data, id, liveLookup))
    .filter(product => !product.deleted);
  const publicProducts = products.filter(product => product.approved && product.lifecycleState !== "ARCHIVED");
  const hotProductIds = publicProducts.filter(product => Number(product.heat || 0) >= 75).map(product => product.id);
  const scorchingProductIds = publicProducts.filter(product => Number(product.heat || 0) >= 90 || String(product.heatLabel || "").toLowerCase() === "scorching").map(product => product.id);

  publishLiveEvent(type, {
    reason,
    productIds: ids,
    deletedProductIds: [...new Set((deletedProductIds || []).map(Number).filter(Number.isFinite))],
    products: publicProducts,
    hotProductIds,
    scorchingProductIds,
    ...metadata,
  }, { audience: "all" });
}

function publishAdminLiveMutation(reason, metadata = {}) {
  publishLiveEvent("admin", { reason, ...metadata }, { audience: "admin" });
}

function rebuildAllProductCaches(data, { onProgress = null } = {}) {
  // V3.7.11: build ephemeral lookup tables once. The previous startup path
  // repeatedly rescanned the full offer table while rebuilding every product,
  // causing superlinear runtimes on large catalogs. These indexes are local to
  // this rebuild and do not change persisted data or trust/scoring semantics.
  const lookup = buildOfferLookupIndex(data, { onProgress });

  const historyStartedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "price-signal-index",
    state: "start",
    total: Number(data.priceHistory?.length || 0) + Number(data.priceAggregates?.length || 0),
    message: "building Price Signal sparkline index",
  });
  const blockedOfferIds = blockedCompetitorHistoryOfferIds(data, {
    onProgress,
    lookup,
  });
  const sparklineIndex = buildPriceSparklineIndex(data, {
    days: 365,
    maxPoints: 18,
    onProgress,
    lookup,
    blockedOfferIds,
  });
  emitDbStartupProgress(onProgress, {
    phase: "price-signal-index",
    state: "done",
    total: Number(data.priceHistory?.length || 0) + Number(data.priceAggregates?.length || 0),
    current: Number(data.priceHistory?.length || 0) + Number(data.priceAggregates?.length || 0),
    durationMs: Date.now() - historyStartedAt,
    message: `Price Signal index ready for ${sparklineIndex.size.toLocaleString()} products`,
  });

  const dealHeatHistoryIndex = buildDealHeatHistoryIndex(data, {
    days: 30,
    blockedOfferIds,
    onProgress,
    lookup,
  });

  const products = Array.isArray(data.products) ? data.products : [];
  const total = products.length;
  const cacheStartedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "product-cache-rebuild",
    state: "start",
    current: 0,
    total,
    message: "rebuilding product search, best-offer, Deal Heat, and Price Signal caches",
  });

  for (let index = 0; index < total; index++) {
    const product = products[index];
    refreshProductCacheInDb(
      data,
      product.id,
      sparklineIndex,
      {
        lookup,
        dealHeatHistoryIndex,
      }
    );

    const current = index + 1;
    if (onProgress) {
      emitDbStartupProgress(onProgress, {
        phase: "product-cache-rebuild",
        state: current === total ? "done" : "progress",
        current,
        total,
        durationMs: Date.now() - cacheStartedAt,
        message: "rebuilding product intelligence caches",
      });
    }
  }

  if (total === 0) {
    emitDbStartupProgress(onProgress, {
      phase: "product-cache-rebuild",
      state: "done",
      current: 0,
      total: 0,
      durationMs: Date.now() - cacheStartedAt,
      message: "no product caches needed rebuilding",
    });
  }
}

function rebuildProductCachesForIds(
  data,
  productIds = [],
  { onProgress = null, lookup = null } = {}
) {
  const targetIds = [...new Set(
    Array.from(productIds || []).map(Number).filter(Number.isFinite)
  )];
  if (!targetIds.length) return 0;

  // Runtime jobs need Price Signal / Deal Heat intelligence only for products
  // they changed. Keep relationship allocation scoped to that exact mutation
  // set; startup/global rebuild paths still use the full lookup explicitly.
  const effectiveLookup = lookup || buildPageHydrationLookup(data, targetIds, {
    approvedOnly: false,
    includeClicks: false,
  });
  const blockedOfferIds = blockedCompetitorHistoryOfferIds(data, {
    lookup: effectiveLookup,
    onProgress,
    productIds: targetIds,
  });
  const sparklineIndex = buildPriceSparklineIndex(data, {
    days: 365,
    maxPoints: 18,
    lookup: effectiveLookup,
    blockedOfferIds,
    onProgress,
    productIds: targetIds,
  });
  const dealHeatHistoryIndex = buildDealHeatHistoryIndex(data, {
    days: 30,
    blockedOfferIds,
    lookup: effectiveLookup,
    onProgress,
    productIds: targetIds,
  });

  const startedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "intelligence-rebuild",
    state: "start",
    current: 0,
    total: targetIds.length,
    message: "refreshing only products affected by competitor cleanup",
  });

  let rebuilt = 0;
  for (let index = 0; index < targetIds.length; index++) {
    const productId = targetIds[index];
    if (effectiveLookup.productByNumericId.has(Number(productId))) {
      refreshProductCacheInDb(
        data,
        Number(productId),
        sparklineIndex,
        {
          lookup: effectiveLookup,
          dealHeatHistoryIndex,
        }
      );
      rebuilt++;
    }

    emitDbStartupProgress(onProgress, {
      phase: "intelligence-rebuild",
      state: index + 1 === targetIds.length ? "done" : "progress",
      current: index + 1,
      total: targetIds.length,
      durationMs: Date.now() - startedAt,
      message: "refreshing competitor-cleanup product intelligence",
    });
  }

  return rebuilt;
}

function pruneData(data) {
  // Preserve long-term intelligence by compacting old observations instead of
  // simply deleting them. This is throttled internally to avoid expensive
  // reaggregation on every normal write.
  compressPriceHistoryInDb(data, { force: false });

  const clickLimit = Math.max(1000, Number(process.env.CLICK_LOG_LIMIT || 50000));
  if (data.clicks.length > clickLimit) {
    data.clicks = data.clicks
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, clickLimit);
  }
}

export function ingestCandidates(candidates, { targetProductId = null, deferPersistence = false } = {}) {
  const data = readDb();
  const touched = new Set();
  let productsCreated = 0;
  const reactivatedProductIds = new Set();
  let offersCreated = 0;
  let offersUpdated = 0;
  let offersRehomed = 0;
  let blockedExplicit = 0;
  const now = nowIso();

  const uniqueCandidates = [];
  const seenCandidateKeys = new Set();

  for (const rawCandidate of candidates || []) {
    if (isExplicitProduct(rawCandidate)) {
      blockedExplicit++;
      continue;
    }

    const provider = boundedToken(rawCandidate?.provider, 40).toLowerCase();
    const externalId = boundedToken(rawCandidate?.externalId, 300);
    const title = boundedText(rawCandidate?.title, 500);
    const affiliateUrl = safeHttpUrl(rawCandidate?.affiliateUrl, 4000);
    const price = finiteNumberOrNull(rawCandidate?.price, { min: 0.000001 });

    if (!provider || !/^[a-z0-9._-]+$/.test(provider) || !externalId || !title || !affiliateUrl || price == null) {
      continue;
    }

    const candidate = {
      ...rawCandidate,
      provider,
      externalId,
      title,
      affiliateUrl,
      price,
      sourceUrl: safeHttpUrl(rawCandidate?.sourceUrl, 4000),
      imageUrl: safeHttpUrl(rawCandidate?.imageUrl, 1600),
    };

    const externalKey = `${provider}:${externalId}`;
    if (seenCandidateKeys.has(externalKey)) continue;
    seenCandidateKeys.add(externalKey);
    uniqueCandidates.push(candidate);
  }

  // V3.7.47: first-paint ingestion must not rebuild the complete runtime
  // relationship graph for a bounded provider batch. Retain only the external
  // listing IDs this batch can actually reference while collecting the small
  // global ownership fact needed by the primary-eBay rule in the same offer
  // pass. Canonical product ownership still receives global product knowledge
  // below; only redundant relationship allocation is removed.
  const candidateExternalKeys = new Set(
    uniqueCandidates.map(candidate =>
      `${String(candidate.provider || "").toLowerCase()}:${String(candidate.externalId || "")}`
    )
  );
  const offerByExternal = new Map();
  const productIdsWithNonEbayOffer = new Set();
  for (const existingOffer of data.offers || []) {
    const provider = String(existingOffer.provider || "").toLowerCase();
    const externalKey = `${provider}:${String(existingOffer.externalId || "")}`;
    if (candidateExternalKeys.has(externalKey) && !offerByExternal.has(externalKey)) {
      offerByExternal.set(externalKey, existingOffer);
    }
    if (!isEbayOffer(existingOffer)) {
      const ownerId = Number(existingOffer.productId);
      if (Number.isFinite(ownerId)) productIdsWithNonEbayOffer.add(ownerId);
    }
  }

  // V3.7.21: re-key strong identities with a hard package/bundle discriminator
  // before routing new feed records. This lets a previously merged 1-year /
  // 2-year merchant product self-heal on the next feed sync without changing
  // listing ownership for unrelated products.
  const desiredStrongOwners = new Map();
  const ambiguousStrongKeys = new Set();
  for (const product of data.products) {
    if (!strongIdentityBaseKey(product)) continue;
    const desired = candidateCanonicalKey({
      gtin: product.gtin,
      brand: product.brand,
      mpn: product.mpn,
      title: product.title,
      provider: "product",
      externalId: product.id,
    });
    if (!desired) continue;
    if (desiredStrongOwners.has(desired)) {
      ambiguousStrongKeys.add(desired);
    } else {
      desiredStrongOwners.set(desired, product);
    }
  }
  for (const [desired, product] of desiredStrongOwners.entries()) {
    if (!ambiguousStrongKeys.has(desired)) product.canonicalKey = desired;
  }

  const productById = new Map();
  const productByCanonical = new Map();
  const productBuckets = new Map();
  const archivedByIdentityKey = new Map();

  // One combined product pass builds every routing index used by this ingest.
  // Strong-owner re-keying above intentionally happens first so canonical
  // routing observes the corrected keys.
  for (const product of data.products) {
    const numericProductId = Number(product.id);
    if (Number.isFinite(numericProductId) && !productById.has(numericProductId)) {
      productById.set(numericProductId, product);
    }
    if (product.canonicalKey && !productByCanonical.has(String(product.canonicalKey))) {
      productByCanonical.set(String(product.canonicalKey), product);
    }

    const bucketKey =
      `${normalizeCategory(product.category)}|${coarseVariantBucket(product.title, product.brand || "")}`;
    if (!productBuckets.has(bucketKey)) productBuckets.set(bucketKey, []);
    productBuckets.get(bucketKey).push(product);

    if (product.lifecycleState === "ARCHIVED") {
      const identityKey =
        product.lifecycleIdentityKey ||
        lifecycleIdentityKey(product);

      if (identityKey && !archivedByIdentityKey.has(identityKey)) {
        archivedByIdentityKey.set(identityKey, product);
      }
    }
  }

  for (const candidate of uniqueCandidates) {
    const incomingIdentity = sanitizeIdentityForStorage(candidate);
    const key = canonicalKey(candidate);
    const isEbayCandidate =
      String(candidate.provider || "").toLowerCase() === "ebay";
    const externalKey =
      `${String(candidate.provider).toLowerCase()}:${String(candidate.externalId)}`;

    let offer = offerByExternal.get(externalKey) || null;

    let product = null;
    let rehomeExistingOffer = false;
    let previousOwnerProductId = null;

    if (targetProductId != null) {
      product = productById.get(Number(targetProductId)) || null;
      if (!product) throw new Error(`Target product ${targetProductId} does not exist.`);
    } else if (offer) {
      // A marketplace listing normally has one stable owner. V3.7.21 adds one
      // deliberately narrow correction: non-eBay merchant-feed records may be
      // re-homed when the merchant reused the same strong identifier for two
      // explicit package variants (for example a 1-year vs 2-year combo set).
      const currentOwner = productById.get(Number(offer.productId)) || null;
      product = currentOwner;

      if (!isEbayCandidate && currentOwner) {
        // V3.7.21 closes the remaining bundle edge case: a merchant can reuse
        // the same Brand+MPN while the canonical/base title omits the package
        // duration. If the incoming listing explicitly says 1-year, 2-year,
        // etc., that explicit variant must be re-homed even when the current
        // owner has no duration discriminator at all.
        if (strongVariantOwnershipConflict(currentOwner, candidate)) {
          previousOwnerProductId = Number(currentOwner.id);
          product = productByCanonical.get(String(key)) || null;
          rehomeExistingOffer = true;
        }
      }
    } else {
      product = productByCanonical.get(String(key)) || null;

      if (!product && !isEbayCandidate) {
        const archivedIdentity = lifecycleIdentityKey({
          gtin: candidate.gtin,
          brand: candidate.brand,
          mpn: candidate.mpn,
          title: candidate.title,
        });

        const archived = archivedByIdentityKey.get(archivedIdentity) || null;

        if (
          archived &&
          safeSameVariant(archived.title, candidate.title, {
            brandA: archived.brand || "",
            brandB: candidate.brand || "",
          })
        ) {
          product = archived;
        }
      }

      if (
        !product &&
        !isEbayCandidate &&
        !String(key).startsWith("gtin:") &&
        !String(key).startsWith("mpn:")
      ) {
        const category = normalizeCategory(candidate.category);
        const bucket = coarseVariantBucket(
          candidate.title,
          candidate.brand || ""
        );

        const bucketKey = `${category}|${bucket}`;
        product = (productBuckets.get(bucketKey) || []).find(p =>
          safeSameVariant(p.title, candidate.title, {
            brandA: p.brand || "",
            brandB: candidate.brand || "",
          })
        ) || null;
      }
    }

    if (!product) {
      product = {
        id: data.meta.nextProductId++,
        canonicalKey: key,
        title: boundedText(candidate.title, 500),
        brand: incomingIdentity.brand,
        gtin: incomingIdentity.gtin,
        mpn: incomingIdentity.mpn,
        epid: incomingIdentity.epid,
        identityRejectedBrand: boundedText(incomingIdentity.rejected.brand, 200),
        identityRejectedGtin: boundedText(incomingIdentity.rejected.gtin, 200),
        identityRejectedMpn: boundedText(incomingIdentity.rejected.mpn, 200),
        identityRejectedEpid: boundedText(incomingIdentity.rejected.epid, 200),
        identityRejectedCount: Object.values(incomingIdentity.rejected).some(Boolean) ? 1 : 0,
        identityRejectedLastAt: Object.values(incomingIdentity.rejected).some(Boolean) ? now : null,
        identityRejectedLastSource: Object.values(incomingIdentity.rejected).some(Boolean) ? "candidate-create" : "",
        ebayIdentityCheckedAt: null,
        ebayCompetitorScanAt: null,
        ebayCompetitorScanMethod: "",
        ebayCompetitorScanConfidence: 0,
        ebayCompetitorScanMatched: 0,
        ebayCompetitorScanError: "",
        primaryEbayOfferId: null,
        ebayTrustPolicyVersion: 0,
        ebayTrustLastCleanedAt: null,
        integrityBucket: coarseVariantBucket(
          candidate.title,
          candidate.brand || ""
        ),
        category: normalizeCategory(candidate.category),
        imageUrl: candidate.imageUrl || "",
        aiSummary: "",
        editorNote: "",
        tags: [],
        approved: false,
        approvalSource: "draft",
        approvedAt: null,
        autoApprovalBlocked: false,
        manualReviewTouchedAt: null,
        lastAutoReviewAt: null,
        lastAutoReviewDecision: "",
        lastAutoReviewReason: "",
        autoApprovalConfidence: 0,
        lifecycleState: "ACTIVE",
        lifecycleStateChangedAt: now,
        lifecycleLastActiveAt: now,
        lifecycleLastObservationAt: now,
        lifecyclePrunableSince: null,
        lifecycleArchivedAt: null,
        lifecycleLastArchivedAt: null,
        lifecycleReactivatedAt: null,
        lifecycleReactivateCount: 0,
        lifecycleWasApproved: false,
        lifecyclePinned: false,
        lifecycleProtectionScore: 0,
        lifecycleProtectionReasons: [],
        lifecyclePriceSummary: null,
        lifecycleClickSummary: null,
        lifecycleTombstone: null,
        lifecycleNormalizedTitle:
          normalizeLifecycleIdentityText(candidate.title),
        lifecycleNormalizedBrand:
          normalizeLifecycleIdentityText(incomingIdentity.brand),
        lifecycleIdentityKey: "",
        createdAt: now,
        updatedAt: now,
      };
      product.lifecycleIdentityKey = lifecycleIdentityKey(product);
      data.products.push(product);
      productById.set(Number(product.id), product);
      productByCanonical.set(String(product.canonicalKey), product);

      const newBucketKey =
        `${normalizeCategory(product.category)}|${coarseVariantBucket(product.title, product.brand || "")}`;
      if (!productBuckets.has(newBucketKey)) productBuckets.set(newBucketKey, []);
      productBuckets.get(newBucketKey).push(product);

      productsCreated++;
    } else {
      if (!product.imageUrl && candidate.imageUrl) product.imageUrl = candidate.imageUrl;
      sanitizeStoredProductIdentifiers(product);
      applyTrustedProductIdentity(product, candidate, {
        fillOnly: true,
        source: "candidate-update",
      });

      if ((!product.category || product.category === "Other") && candidate.category) {
        product.category = normalizeCategory(candidate.category);
      }

      product.integrityBucket =
        coarseVariantBucket(product.title, product.brand || "");
      product.lifecycleNormalizedTitle =
        normalizeLifecycleIdentityText(product.title);
      product.lifecycleNormalizedBrand =
        normalizeLifecycleIdentityText(product.brand);
      product.lifecycleIdentityKey = lifecycleIdentityKey(product);

      if (
        String(candidate.availability || "in_stock") !== "out_of_stock"
      ) {
        if (reactivateProductInDb(data, product, now)) {
          reactivatedProductIds.add(Number(product.id));
        }
      } else {
        product.lifecycleLastObservationAt = maxIso(
          product.lifecycleLastObservationAt,
          candidate.searchObservedAt
        );
      }

      product.updatedAt = now;
    }

    const rate = finiteNumberOrNull(candidate.commissionRate, { min: 0, max: 1 });

    const candidatePrice = Number(candidate.price);
    const verifiedAtMs = offer?.priceVerifiedAt
      ? Date.parse(offer.priceVerifiedAt)
      : 0;

    const existingVerifiedFresh =
      verifiedAtMs &&
      Date.now() - verifiedAtMs < 6 * 3_600_000;

    const preserveVerifiedPrice =
      String(candidate.provider).toLowerCase() === "ebay" &&
      existingVerifiedFresh &&
      String(candidate.priceSource || "ebay-search") !== "ebay-item-detail";

    const effectivePrice =
      preserveVerifiedPrice
        ? Number(offer.price)
        : candidatePrice;

    const values = {
      productId: offer && !rehomeExistingOffer ? offer.productId : product.id,
      provider: String(candidate.provider),
      externalId: String(candidate.externalId),
      legacyItemId: String(candidate.legacyItemId || offer?.legacyItemId || "").slice(0, 120),
      merchant: String(candidate.merchant || "Unknown merchant").slice(0, 300),
      price: effectivePrice,
      searchObservedPrice:
        String(candidate.provider).toLowerCase() === "ebay"
          ? candidatePrice
          : null,
      searchObservedAt:
        candidate.searchObservedAt ||
        (String(candidate.provider).toLowerCase() === "ebay" ? now : null),
      originalPrice: finiteNumberOrNull(candidate.originalPrice, { min: 0 }),
      shippingPrice: finiteNumberOrNull(candidate.shippingPrice, { min: 0 }),
      currency: String(candidate.currency || "USD").slice(0, 12),
      affiliateUrl: String(candidate.affiliateUrl),
      sourceUrl: candidate.sourceUrl ? String(candidate.sourceUrl) : "",
      imageUrl: String(candidate.imageUrl || offer?.imageUrl || "").slice(0, 1200),
      availability: String(candidate.availability || "in_stock"),
      commissionRate: rate,
      commissionIsEstimate: candidate.commissionIsEstimate !== false,
      estimatedCommission:
        rate == null || !Number.isFinite(effectivePrice)
          ? null
          : Math.round(effectivePrice * rate * 100) / 100,
      merchantRatingPct: finiteNumberOrNull(candidate.merchantRatingPct, { min: 0, max: 100 }),
      condition: String(candidate.condition || "").slice(0, 120),
      conditionGroup: String(candidate.conditionGroup || "unknown").slice(0, 40),
      brand: String(candidate.brand || offer?.brand || "").slice(0, 200),
      gtin: String(candidate.gtin || offer?.gtin || "").slice(0, 100),
      mpn: String(candidate.mpn || offer?.mpn || "").slice(0, 160),
      epid: String(candidate.epid || offer?.epid || "").slice(0, 100),
      matchConfidence: finiteNumberOrNull(candidate.matchConfidence, { min: 0, max: 100 }),
      matchSource: String(candidate.matchSource || "").slice(0, 80),
      competitorDiscoveryMethods: normalizedCompetitorDiscoveryMethods(
        offer?.competitorDiscoveryMethods,
        candidate.competitorDiscoveryMethods
      ),
      competitorDiscoveryLabels: normalizedCompetitorDiscoveryLabels(
        offer?.competitorDiscoveryLabels,
        candidate.competitorDiscoveryLabels
      ),
      competitorDiscoveryPrimaryMethod: String(
        candidate.competitorDiscoveryPrimaryMethod ||
        offer?.competitorDiscoveryPrimaryMethod ||
        ""
      ).slice(0, 40),
      competitorDiscoveryPrimaryLabel: String(
        candidate.competitorDiscoveryPrimaryLabel ||
        offer?.competitorDiscoveryPrimaryLabel ||
        ""
      ).slice(0, 80),
      competitorDiscoveryConfidence: Math.max(
        Number(offer?.competitorDiscoveryConfidence || 0),
        Number(candidate.competitorDiscoveryConfidence || 0)
      ),
      competitorDiscoveryTier: competitorDiscoveryTier(
        Math.max(
          Number(offer?.competitorDiscoveryConfidence || 0),
          Number(candidate.competitorDiscoveryConfidence || 0)
        )
      ),
      competitorDiscoveryObservedAt:
        candidate.competitorDiscoveryObservedAt ||
        offer?.competitorDiscoveryObservedAt ||
        now,
      competitorIdentityStatus:
        String(candidate.matchSource || "").startsWith("ebay-competitor:v4-exact-")
          ? "verified"
          : String(offer?.competitorIdentityStatus || ""),
      competitorIdentityVerifiedAt:
        String(candidate.matchSource || "").startsWith("ebay-competitor:v4-exact-")
          ? (candidate.priceVerifiedAt || now)
          : (offer?.competitorIdentityVerifiedAt || null),
      competitorIdentityLastReason:
        String(candidate.matchSource || "").startsWith("ebay-competitor:v4-exact-")
          ? String(candidate.matchSource || "").slice(0, 500)
          : String(offer?.competitorIdentityLastReason || "").slice(0, 500),
      competitorIdentityNextAttemptAt:
        String(candidate.matchSource || "").startsWith("ebay-competitor:v4-exact-")
          ? null
          : (offer?.competitorIdentityNextAttemptAt || null),
      listingTitle: String(candidate.listingTitle || candidate.title || "").slice(0, 500),
      verificationVersion: Number(candidate.verificationVersion || 0),
      matchProofType: String(candidate.matchProofType || offer?.matchProofType || "").slice(0, 40),
      matchProofVersion: Number(candidate.matchProofVersion || offer?.matchProofVersion || 0),
      matchReferenceTitle: String(candidate.matchReferenceTitle || offer?.matchReferenceTitle || "").slice(0, 500),
      matchReferenceBrand: String(candidate.matchReferenceBrand || offer?.matchReferenceBrand || "").slice(0, 200),
      matchReferenceGtin: String(candidate.matchReferenceGtin || offer?.matchReferenceGtin || "").slice(0, 100),
      matchReferenceMpn: String(candidate.matchReferenceMpn || offer?.matchReferenceMpn || "").slice(0, 160),
      matchReferenceEpid: String(candidate.matchReferenceEpid || offer?.matchReferenceEpid || "").slice(0, 100),
      priceVerifiedAt:
        String(candidate.priceSource || "") === "ebay-item-detail"
          ? (candidate.priceVerifiedAt || now)
          : (offer?.priceVerifiedAt || null),
      lastVerifiedPrice:
        String(candidate.priceSource || "") === "ebay-item-detail"
          ? candidatePrice
          : (offer?.lastVerifiedPrice ?? null),
      priceSource:
        preserveVerifiedPrice
          ? String(offer?.priceSource || "ebay-item-detail")
          : String(candidate.priceSource || offer?.priceSource || "provider"),
      priceVerificationStatus:
        String(candidate.priceSource || "") === "ebay-item-detail"
          ? "verified"
          : (offer?.priceVerifiedAt ? "verified" : "unverified"),
      priceDiscrepancyCount: Number(offer?.priceDiscrepancyCount || 0),
      lastPriceDiscrepancy: Number(offer?.lastPriceDiscrepancy || 0),
      unitPrice: finiteNumberOrNull(candidate.unitPrice, { min: 0 }),
      unitPriceCurrency: String(candidate.unitPriceCurrency || "").slice(0, 12),
      unitPricingMeasure: String(candidate.unitPricingMeasure || "").slice(0, 80),
      lotSize: finiteNumberOrNull(candidate.lotSize, { min: 0 }),
      quantityLimitPerBuyer: finiteNumberOrNull(candidate.quantityLimitPerBuyer, { min: 0 }),
      estimatedAvailableQuantity: finiteNumberOrNull(candidate.estimatedAvailableQuantity, { min: 0 }),
      availabilityThreshold: finiteNumberOrNull(candidate.availabilityThreshold, { min: 0 }),
      availabilityThresholdType:
        String(candidate.availabilityThresholdType || "").slice(0, 40),
      primaryItemGroupId: String(candidate.primaryItemGroupId || "").slice(0, 120),
      primaryItemGroupType: String(candidate.primaryItemGroupType || "").slice(0, 80),
      itemEndDate: String(candidate.itemEndDate || "").slice(0, 80),
      priceTreatment: String(candidate.priceTreatment || "").slice(0, 80),
      priceDisplayCondition:
        String(candidate.priceDisplayCondition || "").slice(0, 120),
      priceDisplayRestricted: Boolean(candidate.priceDisplayRestricted),
      coupons: Array.isArray(candidate.coupons)
        ? candidate.coupons.slice(0, 8)
        : [],
      lastSeen: now,
      score: 0,
    };

    if (!offer) {
      offer = { id: data.meta.nextOfferId++, ...values };
      data.offers.push(offer);
      offerByExternal.set(externalKey, offer);
      offersCreated++;
    } else {
      Object.assign(offer, values);
      offersUpdated++;
    }
    if (!isEbayOffer(offer)) {
      const ownerId = Number(offer.productId);
      if (Number.isFinite(ownerId)) productIdsWithNonEbayOffer.add(ownerId);
    }

    if (rehomeExistingOffer && previousOwnerProductId != null) {
      const newProductId = Number(product.id);
      const offerId = Number(offer.id);
      for (const history of data.priceHistory) {
        if (Number(history.offerId) === offerId) history.productId = newProductId;
      }
      for (const click of data.clicks) {
        if (Number(click.offerId) === offerId) click.productId = newProductId;
      }
      data.priceAggregates = data.priceAggregates.filter(aggregate =>
        Number(aggregate.productId) !== Number(previousOwnerProductId) &&
        Number(aggregate.productId) !== newProductId
      );
      touched.add(Number(previousOwnerProductId));
      offersRehomed++;
    }

    if (
      isEbayCandidate &&
      product &&
      !isEbaySecondarySource(offer) &&
      product.primaryEbayOfferId == null &&
      !productIdsWithNonEbayOffer.has(Number(product.id))
    ) {
      product.primaryEbayOfferId = Number(offer.id);
    }

    const owner = productById.get(Number(offer.productId));
    if (owner) {
      owner.lifecycleLastObservationAt = maxIso(
        owner.lifecycleLastObservationAt,
        values.searchObservedAt,
        values.priceVerifiedAt,
        values.lastSeen
      );

      if (values.availability !== "out_of_stock") {
        owner.lifecycleLastActiveAt = maxIso(
          owner.lifecycleLastActiveAt,
          values.lastSeen
        );

        if (reactivateProductInDb(data, owner, now)) {
          reactivatedProductIds.add(Number(owner.id));
        }
      }

      owner.lifecycleNormalizedTitle =
        normalizeLifecycleIdentityText(owner.title);
      owner.lifecycleNormalizedBrand =
        normalizeLifecycleIdentityText(owner.brand);
      owner.lifecycleIdentityKey = lifecycleIdentityKey(owner);
    }

    touched.add(offer.productId);
  }

  const touchedIds = [...touched].map(Number).filter(Number.isFinite);
  let ingestLookup = null;
  if (touchedIds.length) {
    // One scoped relationship pass replaces the old full-catalog rescore pass
    // plus a second full buildOfferLookupIndex() immediately afterwards.
    ingestLookup = buildPageHydrationLookup(data, touchedIds, {
      approvedOnly: false,
      includeClicks: false,
    });
    rescoreProductIdsInDb(data, touchedIds, ingestLookup);
    queueRuntimeProductMutation(data, touchedIds, {
      reason: deferPersistence ? "bulk-candidate-ingest" : "jit-candidate-ingest",
      lookup: ingestLookup,
    });
  }

  const result = {
    blockedExplicit,
    productsCreated,
    productsReactivated: reactivatedProductIds.size,
    offersCreated,
    offersUpdated,
    offersRehomed,
    productsTouched: touched.size,
    touchedProductIds: [...touched],
  };

  if (touched.size) {
    publishProductLiveMutation(data, {
      type: "catalog",
      reason: productsCreated > 0
        ? "products-ingested"
        : reactivatedProductIds.size > 0
          ? "products-reactivated"
          : "offers-ingested",
      productIds: [...touched],
      metadata: {
        productsCreated,
        productsReactivated: reactivatedProductIds.size,
        offersCreated,
        offersUpdated,
      },
      lookup: ingestLookup,
    });
  }

  return result;
}


function competitorCleanupBackupPath() {
  return path.join(DATA_DIR, "catalog.pre-v376-universal-trust-filter.json");
}

function appendCompetitorCleanupLog(report) {
  const logPath = path.join(DATA_DIR, "ebay-competitor-cleanup.jsonl");
  try {
    fs.appendFileSync(
      logPath,
      JSON.stringify(report) + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (error) {
    console.error("[competitor-cleanup] could not write audit log:", error.message);
  }
}

export function cleanupEbayCompetitorOffers({
  reason = "scheduled",
  makeBackup = false,
  onProgress = null,
  deferPersistence = false,
} = {}) {
  const cleanupStartedAt = Date.now();
  const data = readDb();
  emitCompetitorCleanupProgress(onProgress, {
    phase: "load",
    state: "done",
    current: 1,
    total: 1,
    unit: "catalog",
    products: data.products.length,
    offers: data.offers.length,
    historyPoints: data.priceHistory.length,
    aggregateBuckets: data.priceAggregates.length,
    message: "catalog loaded",
  });
  const minScore = Math.max(
    0.88,
    Math.min(0.98, Number(process.env.EBAY_COMPETITOR_TITLE_MATCH_MIN || 0.90))
  );

  const backupPath = competitorCleanupBackupPath();
  const backupNeeded = makeBackup && !fs.existsSync(backupPath);
  emitCompetitorCleanupProgress(onProgress, {
    phase: "backup",
    state: backupNeeded ? "start" : "done",
    current: backupNeeded ? 0 : 1,
    total: 1,
    unit: "backup",
    message: backupNeeded ? "creating one-time safety backup" : "safety backup already present or not required",
  });
  if (backupNeeded) {
    fs.copyFileSync(DB_FILE, backupPath);
    emitCompetitorCleanupProgress(onProgress, {
      phase: "backup",
      state: "done",
      current: 1,
      total: 1,
      unit: "backup",
      message: "safety backup ready",
    });
  }

  const legacyIdentityPolicy =
    Number(data.meta.ebayIdentityPolicyVersion || 0) < 3;

  if (legacyIdentityPolicy) {
    for (const product of data.products) {
      product.epid = "";
      product.ebayIdentityCheckedAt = null;
    }
    data.meta.ebayIdentityPolicyVersion = 3;
  }

  // V3.7.6 extends cleanup beyond dedicated competitor-scanner offers. Any
  // broad-discovery eBay listing that was historically grouped into another
  // product now has to prove exact identity too. Unprovable secondary
  // listings are isolated into their own draft product instead of remaining
  // attached as an implied same-product competitor.
  const broadTrustCleanup = splitUnsafeGroupedEbayOffers(data, {
    onProgress,
    // Phase 2 performs one indexed rebuild after all trust decisions are known.
    // Deferring here avoids rebuilding isolated products twice.
    deferIntelligenceRebuild: true,
  });

  // Preserve legacy field-level rescoring semantics for products touched by
  // broad relationship isolation. This is the same first rescore the old
  // per-product rebuild performed, but grouped/indexed in one pass; the later
  // cleanup rescore still runs after quarantine decisions.
  rescoreProductIdsInDb(data, broadTrustCleanup.touchedProductIds || []);

  const productById = new Map(data.products.map(product => [product.id, product]));
  const removedOfferIds = new Set();
  // Preserve the cleanup report's historical meaning: productsTouched counts
  // dedicated competitor-proof mutations. Broad isolation products are added
  // only to the final intelligence rebuild set below.
  const touchedProducts = new Set();
  const aggregateInvalidationProducts = new Set();
  const reasons = {};
  let competitorOffersChecked = 0;
  let upgradedOffers = 0;
  let quarantinedOffers = 0;
  let alreadyPending = 0;
  const now = nowIso();

  function definiteLocalReject(classification, offer) {
    const text = String(classification?.reason || "");
    if (text === "missing-product" || text.includes("no-provable-reference-identity")) {
      return true;
    }

    const hasExactStoredDetail =
      String(offer?.priceSource || "") === "ebay-item-detail" &&
      Boolean(offer?.priceVerifiedAt);

    if (!hasExactStoredDetail) return false;

    // A direct identifier/variant conflict in an already exact item-detail
    // record is enough to reject locally. Missing fields are re-queried in bulk
    // because eBay metadata may have been enriched since the old observation.
    return /(?:conflict|not-exact)/.test(text);
  }

  function noteCompetitorProgress() {
    emitCompetitorCleanupProgress(onProgress, {
      phase: "competitor-proof-audit",
      state: "progress",
      current: competitorOffersChecked,
      total: competitorOffersTotal,
      unit: "offers",
      upgradedOffers,
      quarantinedOffers,
      removedOffers: removedOfferIds.size,
    });
  }

  const competitorOffersTotal = data.offers.reduce(
    (count, offer) => count + (String(offer.matchSource || "").startsWith("ebay-competitor:") ? 1 : 0),
    0
  );
  emitCompetitorCleanupProgress(onProgress, {
    phase: "competitor-proof-audit",
    state: "start",
    current: 0,
    total: competitorOffersTotal,
    unit: "offers",
    message: "checking dedicated competitor proof state",
  });

  const keptOffers = [];
  for (const offer of data.offers) {
    const source = String(offer.matchSource || "");
    if (!source.startsWith("ebay-competitor:")) {
      keptOffers.push(offer);
      continue;
    }

    competitorOffersChecked++;
    const product = productById.get(offer.productId);
    const classification = product
      ? classifyStoredCompetitorOffer(product, offer, { minScore })
      : { keep: false, reason: "missing-product" };

    if (classification.keep) {
      if (classification.upgrade) {
        Object.assign(offer, classification.upgrade);
        upgradedOffers++;
      }
      offer.competitorIdentityStatus = "verified";
      offer.competitorIdentityVerifiedAt ||= offer.priceVerifiedAt || now;
      offer.competitorIdentityLastReason = String(classification.reason || "v4-exact-proof").slice(0, 500);
      offer.competitorPreQuarantineAvailability = "";
      keptOffers.push(offer);
      noteCompetitorProgress();
      continue;
    }

    if (definiteLocalReject(classification, offer)) {
      removedOfferIds.add(offer.id);
      touchedProducts.add(offer.productId);
      aggregateInvalidationProducts.add(offer.productId);
      reasons[classification.reason] =
        Number(reasons[classification.reason] || 0) + 1;
      noteCompetitorProgress();
      continue;
    }

    const wasPending = String(offer.competitorIdentityStatus || "") === "pending";
    if (wasPending) alreadyPending++;
    else quarantinedOffers++;

    if (!offer.competitorPreQuarantineAvailability) {
      offer.competitorPreQuarantineAvailability = String(offer.availability || "in_stock");
    }
    offer.competitorIdentityStatus = "pending";
    offer.competitorIdentityQueuedAt ||= now;
    offer.competitorIdentityLastReason = String(classification.reason || "exact-proof-refresh-required").slice(0, 500);
    offer.availability = "out_of_stock";
    offer.priceVerificationStatus = "identity_pending";
    offer.score = 0;

    touchedProducts.add(offer.productId);
    aggregateInvalidationProducts.add(offer.productId);
    reasons[`quarantined:${classification.reason}`] =
      Number(reasons[`quarantined:${classification.reason}`] || 0) + 1;
    keptOffers.push(offer);
    noteCompetitorProgress();
  }

  emitCompetitorCleanupProgress(onProgress, {
    phase: "competitor-proof-audit",
    state: "done",
    current: competitorOffersTotal,
    total: competitorOffersTotal,
    unit: "offers",
    upgradedOffers,
    quarantinedOffers,
    removedOffers: removedOfferIds.size,
  });

  emitCompetitorCleanupProgress(onProgress, {
    phase: "history-sanitize",
    state: "start",
    current: 0,
    total: data.priceHistory.length + data.priceAggregates.length,
    unit: "records",
    message: "removing history tied to rejected relationships",
  });

  const beforeHistory = data.priceHistory.length;
  data.offers = keptOffers;
  data.priceHistory = data.priceHistory.filter(
    entry => !removedOfferIds.has(entry.offerId)
  );
  const removedHistoryPoints = beforeHistory - data.priceHistory.length;

  // Compressed buckets do not retain the source offer ID. If a product has a
  // questionable legacy competitor, its old aggregates cannot be attributed
  // safely, so discard those buckets rather than let potentially contaminated
  // history influence Deal Heat while exact proof is rebuilt.
  const beforeAggregates = data.priceAggregates.length;
  if (aggregateInvalidationProducts.size) {
    data.priceAggregates = data.priceAggregates.filter(
      entry => !aggregateInvalidationProducts.has(Number(entry.productId))
    );
  }
  const removedAggregateBuckets = beforeAggregates - data.priceAggregates.length;

  emitCompetitorCleanupProgress(onProgress, {
    phase: "history-sanitize",
    state: "done",
    current: beforeHistory + beforeAggregates,
    total: beforeHistory + beforeAggregates,
    unit: "records",
    removedHistoryPoints,
    removedAggregateBuckets,
  });

  const touchedProductList = [...new Set([
    ...(broadTrustCleanup.touchedProductIds || []),
    ...touchedProducts,
  ])]
    .map(Number)
    .filter(productId => Number.isFinite(productId) && productById.has(productId));
  if (touchedProductList.length) {
    rescoreProductIdsInDb(data, touchedProductList);
    const cleanupLookup = buildOfferLookupIndex(data);
    refreshProductFastCachesForIdsInDb(data, touchedProductList, { lookup: cleanupLookup });
    markProductsIntelligenceDirtyInDb(data, touchedProductList, "competitor-cleanup");
  } else {
    emitCompetitorCleanupProgress(onProgress, {
      phase: "intelligence-rebuild",
      state: "done",
      current: 0,
      total: 0,
      unit: "products",
      message: "no product intelligence changed during competitor cleanup",
    });
  }

  data.meta.ebayCompetitorCleanupVersion = 376;
  data.meta.ebayCompetitorCleanupLastRunAt = nowIso();
  data.meta.ebayCompetitorCleanupLastReason = String(reason).slice(0, 80);
  data.meta.ebayCompetitorCleanupLastRemoved = removedOfferIds.size;
  data.meta.ebayCompetitorCleanupLastQuarantined = quarantinedOffers;
  data.meta.ebayCompetitorCleanupLastAggregateBucketsRemoved = removedAggregateBuckets;
  data.meta.ebayUniversalTrustLastSplit = Number(broadTrustCleanup.splitOffers || 0);
  data.meta.ebayUniversalTrustLastVerifiedSecondaries = Number(broadTrustCleanup.trustedSecondaries || 0);
  data.meta.ebayUniversalTrustLastPrimaryAssignments = Number(broadTrustCleanup.primaryAssignments || 0);

  emitCompetitorCleanupProgress(onProgress, {
    phase: "persist",
    state: "start",
    current: 0,
    total: 1,
    unit: "catalog",
    message: "pruning and writing cleaned catalog",
  });
  pruneData(data);
  if (deferPersistence) scheduleDeferredWrite(data, 250);
  else writeDb(data);
  if (touchedProductList.length) {
    enqueueIntelligenceProducts(touchedProductList, {
      priority: "background",
      reason: "competitor-cleanup",
    });
  }
  emitCompetitorCleanupProgress(onProgress, {
    phase: "persist",
    state: "done",
    current: 1,
    total: 1,
    unit: "catalog",
    message: deferPersistence
      ? "cleaned catalog queued for off-thread persistence"
      : "cleaned catalog committed",
  });

  const pendingAfter = data.offers.filter(offer =>
    String(offer.matchSource || "").startsWith("ebay-competitor:") &&
    String(offer.competitorIdentityStatus || "") === "pending"
  ).length;

  const report = {
    at: nowIso(),
    reason: String(reason),
    competitorOffersChecked,
    upgradedOffers,
    quarantinedOffers,
    alreadyPending,
    pendingAfter,
    removedOffers: removedOfferIds.size,
    removedHistoryPoints,
    removedAggregateBuckets,
    productsTouched: touchedProducts.size,
    broadOffersSplit: Number(broadTrustCleanup.splitOffers || 0),
    broadProductsCreated: Number(broadTrustCleanup.newProducts || 0),
    broadSecondariesVerified: Number(broadTrustCleanup.trustedSecondaries || 0),
    primaryEbayOffersAssigned: Number(broadTrustCleanup.primaryAssignments || 0),
    broadSplitReasons: broadTrustCleanup.splitReasons || {},
    reasons,
    backupCreated: makeBackup && fs.existsSync(backupPath),
    backupPath: makeBackup ? backupPath : "",
    legacyIdentityPolicyReset: legacyIdentityPolicy,
    durationMs: Date.now() - cleanupStartedAt,
  };

  emitCompetitorCleanupProgress(onProgress, {
    phase: "complete",
    state: "done",
    current: 1,
    total: 1,
    unit: "cleanup",
    durationMs: report.durationMs,
    competitorOffersChecked: report.competitorOffersChecked,
    quarantinedOffers: report.quarantinedOffers,
    removedOffers: report.removedOffers,
    pendingAfter: report.pendingAfter,
    broadOffersSplit: report.broadOffersSplit,
    broadSecondariesVerified: report.broadSecondariesVerified,
  });

  appendCompetitorCleanupLog(report);
  return report;
}

export function getEbayCompetitorCleanupStatus() {
  const data = readDb();
  const pending = data.offers.filter(offer =>
    String(offer.matchSource || "").startsWith("ebay-competitor:") &&
    String(offer.competitorIdentityStatus || "") === "pending"
  ).length;

  return {
    version: Number(data.meta.ebayCompetitorCleanupVersion || 0),
    lastRunAt: data.meta.ebayCompetitorCleanupLastRunAt || null,
    lastReason: data.meta.ebayCompetitorCleanupLastReason || "",
    lastRemoved: Number(data.meta.ebayCompetitorCleanupLastRemoved || 0),
    lastQuarantined: Number(data.meta.ebayCompetitorCleanupLastQuarantined || 0),
    lastAggregateBucketsRemoved: Number(data.meta.ebayCompetitorCleanupLastAggregateBucketsRemoved || 0),
    lastBroadOffersSplit: Number(data.meta.ebayUniversalTrustLastSplit || 0),
    lastBroadSecondariesVerified: Number(data.meta.ebayUniversalTrustLastVerifiedSecondaries || 0),
    lastPrimaryAssignments: Number(data.meta.ebayUniversalTrustLastPrimaryAssignments || 0),
    pending,
    backupExists: fs.existsSync(competitorCleanupBackupPath()),
  };
}

function competitorSanitizerRetryMinutes() {
  return Math.min(
    Math.max(Number(process.env.EBAY_COMPETITOR_SANITIZER_RETRY_MINUTES || 60), 5),
    1440
  );
}



function normalizedCompetitorDiscoveryMethods(...sources) {
  const out = [];
  for (const source of sources) {
    for (const value of Array.isArray(source) ? source : []) {
      const clean = String(value || "").trim().toLowerCase().slice(0, 40);
      if (clean && !out.includes(clean)) out.push(clean);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function normalizedCompetitorDiscoveryLabels(...sources) {
  const out = [];
  for (const source of sources) {
    for (const value of Array.isArray(source) ? source : []) {
      const clean = String(value || "").trim().slice(0, 80);
      if (clean && !out.includes(clean)) out.push(clean);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function competitorDiscoveryTier(confidence) {
  const score = Number(confidence || 0);
  return score >= 95 ? "high" : score >= 84 ? "medium" : "exploratory";
}

function incompleteExactIdentityReasons(reasons = []) {
  const values = Array.isArray(reasons) ? reasons : [];
  return (
    values.length > 0 &&
    values.every(reason => {
      const value = String(reason || "");
      return (
        (value.startsWith("candidate-") && value.endsWith("-missing")) ||
        value === "no-provable-reference-identity"
      );
    })
  );
}

export function queueEbayCompetitorCandidates(
  productId,
  candidates = [],
  {
    reason = "competitor-search-prefilter",
    deferPersistence = true,
  } = {}
) {
  const data = readDb();
  const numericProductId = Number(productId);
  const product = data.products.find(item => Number(item.id) === numericProductId);
  if (!product) {
    return { productId: numericProductId, queued: 0, created: 0, updated: 0, skipped: 0 };
  }

  const now = nowIso();
  const existingByExternal = new Map(
    data.offers
      .filter(offer => String(offer.provider || "").toLowerCase() === "ebay")
      .map(offer => [String(offer.externalId || ""), offer])
  );
  const sourceOffer = sourceEbayOfferInDb(data, numericProductId);
  const sourceExternalId = String(sourceOffer?.externalId || "");
  const pendingTarget = Math.min(
    Math.max(Number(process.env.EBAY_COMPETITOR_PENDING_TARGET_PER_PRODUCT || 8), 1),
    100
  );
  const pendingSellerTarget = Math.min(
    Math.max(Number(process.env.EBAY_COMPETITOR_PENDING_SELLER_TARGET || 4), 1),
    pendingTarget
  );
  const existingPendingForProduct = data.offers.filter(offer =>
    Number(offer.productId) === numericProductId &&
    String(offer.provider || "").toLowerCase() === "ebay" &&
    String(offer.competitorIdentityStatus || "") === "pending"
  );
  let pendingSlots = existingPendingForProduct.length;
  const pendingSellers = new Set(
    existingPendingForProduct
      .map(offer => String(offer.merchant || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const initialPendingSellers = new Set(pendingSellers);
  const reference = {
    title: String(product.title || sourceOffer?.listingTitle || "").slice(0, 500),
    brand: String(product.brand || sourceOffer?.brand || "").slice(0, 200),
    gtin: String(product.gtin || sourceOffer?.gtin || "").slice(0, 100),
    mpn: String(product.mpn || sourceOffer?.mpn || "").slice(0, 160),
    epid: String(product.epid || sourceOffer?.epid || "").slice(0, 100),
  };

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let alreadyVerified = 0;
  let ownedElsewhere = 0;
  let pendingCapSkipped = 0;
  const seen = new Set();

  // V3.7.38: the documented pending targets are now enforced. Existing rows
  // are always eligible for refresh, while new rows are ordered toward seller
  // diversity and strongest discovery confidence before filling the remaining
  // per-product pending slots. This prevents one scan from creating dozens of
  // yellow rows that the exact verifier cannot drain.
  const orderedCandidates = Array.from(candidates || []).slice().sort((a, b) => {
    const aExternal = String(a?.externalId || "").trim();
    const bExternal = String(b?.externalId || "").trim();
    const aExisting = existingByExternal.has(aExternal) ? 1 : 0;
    const bExisting = existingByExternal.has(bExternal) ? 1 : 0;
    if (aExisting !== bExisting) return bExisting - aExisting;

    const aSeller = String(a?.merchant || "").trim().toLowerCase();
    const bSeller = String(b?.merchant || "").trim().toLowerCase();
    const aNewSeller = aSeller && !initialPendingSellers.has(aSeller) ? 1 : 0;
    const bNewSeller = bSeller && !initialPendingSellers.has(bSeller) ? 1 : 0;
    if (pendingSellers.size < pendingSellerTarget && aNewSeller !== bNewSeller) {
      return bNewSeller - aNewSeller;
    }

    return (
      Number(b?.competitorDiscoveryConfidence || b?.matchConfidence || 0) -
      Number(a?.competitorDiscoveryConfidence || a?.matchConfidence || 0)
    );
  });

  for (const candidate of orderedCandidates) {
    if (String(candidate?.provider || "").toLowerCase() !== "ebay") {
      skipped++;
      continue;
    }
    if (isExplicitProduct(candidate)) {
      skipped++;
      continue;
    }

    const externalId = String(candidate?.externalId || "").trim();
    const price = Number(candidate?.price);
    const affiliateUrl = safeHttpUrl(candidate?.affiliateUrl, 4000);
    if (
      !externalId ||
      externalId === sourceExternalId ||
      seen.has(externalId) ||
      !Number.isFinite(price) ||
      price <= 0 ||
      !affiliateUrl
    ) {
      skipped++;
      continue;
    }
    seen.add(externalId);

    let offer = existingByExternal.get(externalId) || null;
    if (offer && Number(offer.productId) !== numericProductId) {
      ownedElsewhere++;
      skipped++;
      continue;
    }

    if (
      offer &&
      Boolean(offer.priceVerifiedAt) &&
      ebayOfferTrust(data, product, offer).trusted
    ) {
      alreadyVerified++;
      continue;
    }

    const wasPending = Boolean(
      offer &&
      Number(offer.productId) === numericProductId &&
      String(offer.competitorIdentityStatus || "") === "pending"
    );
    if (!wasPending && pendingSlots >= pendingTarget) {
      pendingCapSkipped++;
      skipped++;
      continue;
    }

    const discoveryConfidence = Math.max(
      Number(offer?.competitorDiscoveryConfidence || 0),
      Number(candidate.competitorDiscoveryConfidence || candidate.matchConfidence || 0)
    );
    const discoveryMethods = normalizedCompetitorDiscoveryMethods(
      offer?.competitorDiscoveryMethods,
      candidate.competitorDiscoveryMethods
    );
    const discoveryLabels = normalizedCompetitorDiscoveryLabels(
      offer?.competitorDiscoveryLabels,
      candidate.competitorDiscoveryLabels
    );
    const primaryDiscoveryMethod =
      String(candidate.competitorDiscoveryPrimaryMethod || offer?.competitorDiscoveryPrimaryMethod || "").slice(0, 40);
    const primaryDiscoveryLabel =
      String(candidate.competitorDiscoveryPrimaryLabel || offer?.competitorDiscoveryPrimaryLabel || "").slice(0, 80);

    const values = {
      productId: numericProductId,
      provider: "ebay",
      externalId,
      legacyItemId: String(candidate.legacyItemId || offer?.legacyItemId || "").slice(0, 120),
      merchant: String(candidate.merchant || offer?.merchant || "eBay seller").slice(0, 300),
      price,
      searchObservedPrice: price,
      searchObservedAt: candidate.searchObservedAt || now,
      originalPrice: candidate.originalPrice == null ? null : Number(candidate.originalPrice),
      shippingPrice: candidate.shippingPrice == null ? null : Number(candidate.shippingPrice),
      currency: String(candidate.currency || offer?.currency || "USD").slice(0, 12),
      affiliateUrl,
      sourceUrl: safeHttpUrl(candidate.sourceUrl || offer?.sourceUrl || "", 1600),
      imageUrl: safeHttpUrl(candidate.imageUrl || offer?.imageUrl || "", 1200),
      availability: String(candidate.availability || offer?.availability || "in_stock"),
      commissionRate:
        candidate.commissionRate == null
          ? (offer?.commissionRate ?? null)
          : Number(candidate.commissionRate),
      commissionIsEstimate: candidate.commissionIsEstimate !== false,
      merchantRatingPct:
        candidate.merchantRatingPct == null ? null : Number(candidate.merchantRatingPct),
      condition: String(candidate.condition || offer?.condition || "").slice(0, 120),
      conditionGroup: String(candidate.conditionGroup || offer?.conditionGroup || "unknown").slice(0, 40),
      listingTitle: String(candidate.listingTitle || candidate.title || offer?.listingTitle || "").slice(0, 500),
      brand: String(candidate.brand || offer?.brand || "").slice(0, 200),
      gtin: String(candidate.gtin || offer?.gtin || "").slice(0, 100),
      mpn: String(candidate.mpn || offer?.mpn || "").slice(0, 160),
      epid: String(candidate.epid || offer?.epid || "").slice(0, 100),
      priceVerifiedAt: null,
      lastVerifiedPrice: offer?.lastVerifiedPrice ?? null,
      priceSource: "ebay-search",
      priceVerificationStatus: "identity_pending",
      verificationVersion: Math.max(0, Number(offer?.verificationVersion || 0)),
      matchConfidence: Math.max(0, Math.min(99, Number(candidate.matchConfidence || discoveryConfidence || 74))),
      matchSource: "ebay-competitor:v4-pending-search",
      competitorDiscoveryMethods: discoveryMethods,
      competitorDiscoveryLabels: discoveryLabels,
      competitorDiscoveryPrimaryMethod: primaryDiscoveryMethod,
      competitorDiscoveryPrimaryLabel: primaryDiscoveryLabel,
      competitorDiscoveryTier: competitorDiscoveryTier(discoveryConfidence),
      competitorDiscoveryConfidence: Math.max(0, Math.min(99, discoveryConfidence)),
      competitorDiscoveryObservedAt: now,
      matchProofType: "",
      matchProofVersion: 4,
      matchReferenceTitle: reference.title,
      matchReferenceBrand: reference.brand,
      matchReferenceGtin: reference.gtin,
      matchReferenceMpn: reference.mpn,
      matchReferenceEpid: reference.epid,
      competitorIdentityStatus: "pending",
      competitorIdentityQueuedAt: offer?.competitorIdentityQueuedAt || now,
      competitorIdentityLastAttemptAt:
        candidate.competitorIdentityLastAttemptAt || offer?.competitorIdentityLastAttemptAt || null,
      competitorExactDetailObservedAt:
        candidate.competitorExactDetailObservedAt || offer?.competitorExactDetailObservedAt || null,
      competitorIdentityLastReason: String(reason || "competitor-search-prefilter").slice(0, 500),
      competitorSanitizerAttempts: Number(offer?.competitorSanitizerAttempts || 0),
      competitorPreQuarantineAvailability: "",
      unitPrice: candidate.unitPrice == null ? null : Number(candidate.unitPrice),
      unitPriceCurrency: String(candidate.unitPriceCurrency || "").slice(0, 12),
      unitPricingMeasure: String(candidate.unitPricingMeasure || "").slice(0, 80),
      lotSize: candidate.lotSize == null ? null : Number(candidate.lotSize),
      quantityLimitPerBuyer:
        candidate.quantityLimitPerBuyer == null ? null : Number(candidate.quantityLimitPerBuyer),
      estimatedAvailableQuantity:
        candidate.estimatedAvailableQuantity == null ? null : Number(candidate.estimatedAvailableQuantity),
      primaryItemGroupId: String(candidate.primaryItemGroupId || "").slice(0, 120),
      primaryItemGroupType: String(candidate.primaryItemGroupType || "").slice(0, 80),
      priceDisplayRestricted: Boolean(candidate.priceDisplayRestricted),
      lastSeen: now,
      score: Number(offer?.score || 0),
    };

    if (!offer) {
      offer = { id: data.meta.nextOfferId++, ...values };
      data.offers.push(offer);
      existingByExternal.set(externalId, offer);
      created++;
    } else {
      Object.assign(offer, values);
      updated++;
    }

    if (!wasPending) pendingSlots++;
    const normalizedSeller = String(values.merchant || "").trim().toLowerCase();
    if (normalizedSeller) pendingSellers.add(normalizedSeller);
  }

  const queued = created + updated;
  if (queued) {
    product.ebayCompetitorPendingDiscoveredAt = now;
    product.ebayCompetitorPendingDiscovered = queued;
    product.updatedAt = now;
    if (deferPersistence) scheduleDeferredWrite(data, 1000);
    else writeDb(data);
    publishProductLiveMutation(data, {
      type: "catalog",
      reason: "ebay-competitor-candidates-pending",
      productIds: [numericProductId],
      metadata: { queued, created, updated, pendingCapSkipped, pendingTarget },
    });
  }

  return {
    productId: numericProductId,
    queued,
    created,
    updated,
    skipped,
    alreadyVerified,
    ownedElsewhere,
    pendingCapSkipped,
    pendingTarget,
    pendingSellerTarget,
  };
}

export function getEbayCompetitorCoverageStatus() {
  const data = readDb();
  const lookup = buildOfferLookupIndex(data);
  const products = data.products.filter(product =>
    product.approved &&
    !["PRUNABLE", "ARCHIVED"].includes(product.lifecycleState)
  );

  let zeroVerified = 0;
  let oneVerified = 0;
  let multiVerified = 0;
  let strongIdentity = 0;
  let pendingProducts = 0;
  let pendingListings = 0;
  let verifiedListings = 0;

  for (const product of products) {
    if (productEbayIdentityProofType(product)) strongIdentity++;
    const offers = lookup.offersByNumericProductId.get(Number(product.id)) || [];
    const verified = offers.filter(offer =>
      isEbayOffer(offer) &&
      offer.availability !== "out_of_stock" &&
      Boolean(offer.priceVerifiedAt) &&
      ebayOfferTrust(data, product, offer, { lookup }).trusted
    );
    const pending = offers.filter(offer =>
      isEbayOffer(offer) &&
      String(offer.competitorIdentityStatus || "") === "pending" &&
      offer.availability !== "out_of_stock"
    );

    verifiedListings += verified.length;
    pendingListings += pending.length;
    if (pending.length) pendingProducts++;
    if (verified.length === 0) zeroVerified++;
    else if (verified.length === 1) oneVerified++;
    else multiVerified++;
  }

  return {
    publicProducts: products.length,
    strongIdentityProducts: strongIdentity,
    zeroVerifiedEbayListings: zeroVerified,
    oneVerifiedEbayListing: oneVerified,
    multiVerifiedEbayListings: multiVerified,
    pendingProducts,
    pendingListings,
    verifiedListings,
    multiSellerCoveragePct: products.length
      ? Math.round((multiVerified / products.length) * 1000) / 10
      : 0,
  };
}

export function getEbayCompetitorSanitizerQueue(limit = 800) {
  const data = readDb();
  const cap = Math.min(Math.max(Number(limit) || 800, 1), 5000);
  const productById = new Map(
    data.products.map(product => [Number(product.id), product])
  );
  const approved = new Set(
    data.products.filter(product => product.approved).map(product => Number(product.id))
  );
  const retryCutoff = Date.now() - competitorSanitizerRetryMinutes() * 60_000;
  const nowMs = Date.now();

  return data.offers
    .filter(offer =>
      String(offer.provider || "").toLowerCase() === "ebay" &&
      String(offer.matchSource || "").startsWith("ebay-competitor:") &&
      String(offer.competitorIdentityStatus || "") === "pending" &&
      Boolean(String(offer.externalId || "").trim())
    )
    .filter(offer => {
      const product = productById.get(Number(offer.productId));
      // A getItems detail call cannot certify same-product identity when the
      // canonical reference itself has no provable identity. Keep the observed
      // candidate public/pending and wait for later identity enrichment instead
      // of burning exact-verification quota on an impossible proof.
      if (!product || !productEbayIdentityProofType(product)) return false;

      const nextAttempt = Date.parse(offer.competitorIdentityNextAttemptAt || "");
      if (Number.isFinite(nextAttempt) && nextAttempt > nowMs) return false;

      const attempted = Date.parse(offer.competitorIdentityLastAttemptAt || "");
      return !Number.isFinite(attempted) || attempted <= retryCutoff;
    })
    .sort((a, b) => {
      const aPublic = approved.has(Number(a.productId)) ? 1 : 0;
      const bPublic = approved.has(Number(b.productId)) ? 1 : 0;
      if (aPublic !== bPublic) return bPublic - aPublic;

      const aAttempts = Number(a.competitorSanitizerAttempts || 0);
      const bAttempts = Number(b.competitorSanitizerAttempts || 0);
      if (aAttempts !== bAttempts) return aAttempts - bAttempts;

      const aQueued = Date.parse(a.competitorIdentityQueuedAt || a.lastSeen || 0) || 0;
      const bQueued = Date.parse(b.competitorIdentityQueuedAt || b.lastSeen || 0) || 0;
      return aQueued - bQueued;
    })
    .slice(0, cap)
    .map(offer => ({ ...offer }));
}

function sourceEbayOfferInDb(data, productId, lookup = null) {
  const numericProductId = Number(productId);
  const product = lookup?.productByNumericId
    ? lookup.productByNumericId.get(numericProductId)
    : data.products.find(item => Number(item.id) === numericProductId);
  const sourceOffers = lookup?.offersByNumericProductId
    ? lookup.offersByNumericProductId.get(numericProductId) || []
    : data.offers;
  const candidates = sourceOffers
    .filter(offer =>
      Number(offer.productId) === numericProductId &&
      String(offer.provider || "").toLowerCase() === "ebay" &&
      !String(offer.matchSource || "").startsWith("ebay-competitor:") &&
      !String(offer.matchSource || "").startsWith("ebay-secondary:")
    )
    .sort((a, b) => {
      const aActive = a.availability === "out_of_stock" ? 0 : 1;
      const bActive = b.availability === "out_of_stock" ? 0 : 1;
      if (aActive !== bActive) return bActive - aActive;
      return Number(a.id) - Number(b.id);
    });

  return (
    candidates.find(offer => Number(offer.id) === Number(product?.primaryEbayOfferId)) ||
    candidates[0] ||
    null
  );
}

function sameStoredCondition(source, candidate) {
  const a = String(source?.conditionGroup || "unknown");
  const b = String(candidate?.conditionGroup || "unknown");
  if (a === "unknown" || b === "unknown") return true;
  return a === b;
}

export function applyEbayCompetitorSanitizerResults(verifications = [], { deferPersistence = false } = {}) {
  const data = readDb();
  const touchedProducts = new Set();
  const removedOfferIds = new Set();
  const results = [];
  const reasons = {};
  const now = nowIso();
  const requestedOfferIds = new Set(
    (Array.isArray(verifications) ? verifications : [])
      .map(entry => Number(entry?.offerId))
      .filter(Number.isFinite)
  );
  const verificationProductIds = new Set();
  for (const offer of data.offers || []) {
    if (!requestedOfferIds.has(Number(offer.id))) continue;
    const productId = Number(offer.productId);
    if (Number.isFinite(productId)) verificationProductIds.add(productId);
  }
  // Sanitizer results are already bounded by explicit offer IDs. Allocate
  // relationship buckets only for their products; identity decisions remain
  // unchanged because every offer attached to those products is retained in
  // the scoped lookup.
  const verificationLookup = buildPageHydrationLookup(
    data,
    [...verificationProductIds],
    { approvedOnly: false, includeClicks: false }
  );

  for (const entry of verifications) {
    const offer = verificationLookup.offerByNumericId.get(Number(entry.offerId));
    if (
      !offer ||
      String(offer.provider || "").toLowerCase() !== "ebay" ||
      !String(offer.matchSource || "").startsWith("ebay-competitor:")
    ) continue;

    const product = verificationLookup.productByNumericId.get(Number(offer.productId));
    const detail = entry.detail;
    offer.competitorIdentityLastAttemptAt = now;
    offer.competitorSanitizerAttempts = Number(offer.competitorSanitizerAttempts || 0) + 1;

    if (!product) {
      removedOfferIds.add(offer.id);
      touchedProducts.add(offer.productId);
      reasons["missing-product"] = Number(reasons["missing-product"] || 0) + 1;
      results.push({ offerId: offer.id, productId: offer.productId, status: "rejected", reason: "missing-product" });
      continue;
    }

    if (!detail || detail.missing) {
      removedOfferIds.add(offer.id);
      touchedProducts.add(offer.productId);
      reasons["ebay-item-missing"] = Number(reasons["ebay-item-missing"] || 0) + 1;
      results.push({ offerId: offer.id, productId: offer.productId, status: "rejected", reason: "ebay-item-missing" });
      continue;
    }

    const candidate = {
      ...offer,
      ...detail,
      title: detail.listingTitle || detail.title || offer.listingTitle || "",
      listingTitle: detail.listingTitle || detail.title || offer.listingTitle || "",
      brand: detail.brand || "",
      gtin: detail.gtin || "",
      mpn: detail.mpn || "",
      epid: detail.epid || "",
    };

    const reference = {
      title: product.title || offer.matchReferenceTitle || "",
      brand: product.brand || offer.matchReferenceBrand || "",
      gtin: product.gtin || offer.matchReferenceGtin || "",
      mpn: product.mpn || offer.matchReferenceMpn || "",
      epid: product.epid || offer.matchReferenceEpid || "",
    };

    const proof = exactCompetitorProof(reference, candidate);
    const sourceOffer = sourceEbayOfferInDb(data, product.id, verificationLookup);
    const conditionOk = sameStoredCondition(sourceOffer, candidate);

    if (!conditionOk) {
      const reason = "condition-conflict";
      removedOfferIds.add(offer.id);
      touchedProducts.add(offer.productId);
      reasons[reason] = Number(reasons[reason] || 0) + 1;
      results.push({ offerId: offer.id, productId: offer.productId, status: "rejected", reason });
      continue;
    }

    if (!proof.ok && incompleteExactIdentityReasons(proof.reasons)) {
      const exactObservedPrice = Number(detail.price);
      Object.assign(offer, {
        merchant: String(detail.merchant || offer.merchant || "eBay seller"),
        listingTitle: String(detail.listingTitle || detail.title || offer.listingTitle || "").slice(0, 500),
        imageUrl: safeHttpUrl(detail.imageUrl, 1200) || safeHttpUrl(offer.imageUrl, 1200),
        affiliateUrl: safeHttpUrl(detail.affiliateUrl, 4000) || safeHttpUrl(offer.affiliateUrl, 4000),
        sourceUrl: safeHttpUrl(detail.sourceUrl, 1600) || safeHttpUrl(offer.sourceUrl, 1600),
        searchObservedPrice: Number.isFinite(exactObservedPrice)
          ? exactObservedPrice
          : Number(offer.searchObservedPrice ?? offer.price),
        searchObservedAt: detail.priceVerifiedAt || now,
        condition: String(detail.condition || offer.condition || "").slice(0, 120),
        conditionGroup: String(detail.conditionGroup || offer.conditionGroup || "unknown").slice(0, 40),
        availability: String(detail.availability || offer.availability || "in_stock"),
        competitorIdentityStatus: "pending",
        competitorIdentityLastReason: `exact-detail-identity-incomplete:${proof.reasons.join(",")}`.slice(0, 500),
        competitorIdentityNextAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        competitorExactDetailObservedAt: detail.priceVerifiedAt || now,
        priceVerificationStatus: "identity_pending",
        lastSeen: now,
        score: 0,
      });
      touchedProducts.add(offer.productId);
      const reason = "exact-detail-identity-incomplete";
      reasons[reason] = Number(reasons[reason] || 0) + 1;
      results.push({
        offerId: offer.id,
        productId: offer.productId,
        status: "pending",
        reason,
        missingIdentity: proof.reasons,
      });
      continue;
    }

    if (!proof.ok) {
      const reason = proof.reasons.join(",") || "v4-exact-proof-failed";
      removedOfferIds.add(offer.id);
      touchedProducts.add(offer.productId);
      reasons[reason] = Number(reasons[reason] || 0) + 1;
      results.push({ offerId: offer.id, productId: offer.productId, status: "rejected", reason });
      continue;
    }

    const verifiedPrice = Number(detail.price);
    Object.assign(offer, {
      price: Number.isFinite(verifiedPrice) ? verifiedPrice : offer.price,
      originalPrice: detail.originalPrice == null ? null : Number(detail.originalPrice),
      shippingPrice: detail.shippingPrice == null ? null : Number(detail.shippingPrice),
      currency: String(detail.currency || offer.currency || "USD"),
      affiliateUrl: safeHttpUrl(detail.affiliateUrl, 4000) || safeHttpUrl(offer.affiliateUrl, 4000),
      sourceUrl: safeHttpUrl(detail.sourceUrl, 1600) || safeHttpUrl(offer.sourceUrl, 1600),
      imageUrl: safeHttpUrl(detail.imageUrl, 1200) || safeHttpUrl(offer.imageUrl, 1200),
      listingTitle: String(detail.listingTitle || detail.title || offer.listingTitle || ""),
      merchant: String(detail.merchant || offer.merchant || "eBay seller"),
      brand: String(detail.brand || ""),
      gtin: String(detail.gtin || ""),
      mpn: String(detail.mpn || ""),
      epid: String(detail.epid || ""),
      condition: String(detail.condition || offer.condition || ""),
      conditionGroup: String(detail.conditionGroup || offer.conditionGroup || "unknown"),
      availability: String(detail.availability || "in_stock"),
      estimatedAvailableQuantity: detail.estimatedAvailableQuantity == null ? null : Number(detail.estimatedAvailableQuantity),
      availabilityThreshold: detail.availabilityThreshold == null ? null : Number(detail.availabilityThreshold),
      availabilityThresholdType: String(detail.availabilityThresholdType || ""),
      lotSize: detail.lotSize == null ? null : Number(detail.lotSize),
      quantityLimitPerBuyer: detail.quantityLimitPerBuyer == null ? null : Number(detail.quantityLimitPerBuyer),
      unitPrice: detail.unitPrice == null ? null : Number(detail.unitPrice),
      unitPriceCurrency: String(detail.unitPriceCurrency || ""),
      unitPricingMeasure: String(detail.unitPricingMeasure || ""),
      primaryItemGroupId: String(detail.primaryItemGroupId || ""),
      primaryItemGroupType: String(detail.primaryItemGroupType || ""),
      itemEndDate: String(detail.itemEndDate || ""),
      priceTreatment: String(detail.priceTreatment || ""),
      priceDisplayCondition: String(detail.priceDisplayCondition || ""),
      priceDisplayRestricted: Boolean(detail.priceDisplayRestricted),
      coupons: Array.isArray(detail.coupons) ? detail.coupons.slice(0, 8) : [],
      priceVerifiedAt: detail.priceVerifiedAt || now,
      lastVerifiedPrice: Number.isFinite(verifiedPrice) ? verifiedPrice : offer.lastVerifiedPrice,
      priceSource: "ebay-item-detail",
      priceVerificationStatus: "verified",
      verificationVersion: 4,
      matchConfidence: 100,
      matchSource: `ebay-competitor:v4-exact-${proof.proofType}`,
      matchProofType: proof.proofType,
      matchProofVersion: 4,
      matchReferenceTitle: reference.title,
      matchReferenceBrand: reference.brand,
      matchReferenceGtin: reference.gtin,
      matchReferenceMpn: reference.mpn,
      matchReferenceEpid: reference.epid,
      competitorIdentityStatus: "verified",
      competitorIdentityVerifiedAt: detail.priceVerifiedAt || now,
      competitorIdentityLastReason: `v4-exact-${proof.proofType}`,
      competitorIdentityNextAttemptAt: null,
      competitorPreQuarantineAvailability: "",
      lastSeen: now,
    });

    touchedProducts.add(offer.productId);
    results.push({ offerId: offer.id, productId: offer.productId, status: "verified", proofType: proof.proofType });
  }

  if (removedOfferIds.size) {
    data.offers = data.offers.filter(offer => !removedOfferIds.has(Number(offer.id)));
    data.priceHistory = data.priceHistory.filter(entry => !removedOfferIds.has(Number(entry.offerId)));
  }

  if (touchedProducts.size) {
    // Any touched product may have historical compressed buckets derived from
    // a competitor that has just been rejected. Invalidate them rather than
    // preserve unattributable historical contamination.
    data.priceAggregates = data.priceAggregates.filter(
      entry => !touchedProducts.has(Number(entry.productId))
    );
  }

  const touchedProductIds = [...touchedProducts]
    .map(Number)
    .filter(productId => Number.isFinite(productId) &&
      verificationLookup.productByNumericId.has(productId));

  if (touchedProductIds.length) {
    // Removed offers must not remain visible through the pre-apply lookup, so
    // rebuild only these product buckets once after the sanitizer mutation.
    const postApplyLookup = buildPageHydrationLookup(data, touchedProductIds, {
      approvedOnly: false,
      includeClicks: false,
    });
    rescoreProductIdsInDb(data, touchedProductIds, postApplyLookup);
    queueRuntimeProductMutation(data, touchedProductIds, {
      reason: "competitor-sanitizer",
      lookup: postApplyLookup,
    });
  }

  data.meta.ebayCompetitorSanitizerLastApplyAt = now;
  data.meta.ebayCompetitorSanitizerVerifiedTotal =
    Number(data.meta.ebayCompetitorSanitizerVerifiedTotal || 0) +
    results.filter(result => result.status === "verified").length;
  data.meta.ebayCompetitorSanitizerRejectedTotal =
    Number(data.meta.ebayCompetitorSanitizerRejectedTotal || 0) +
    results.filter(result => result.status === "rejected").length;

  if (results.length) {
    publishProductLiveMutation(data, {
      type: "catalog",
      reason: "competitor-sanitizer-applied",
      productIds: [...touchedProducts],
      metadata: {
        verified: results.filter(result => result.status === "verified").length,
        rejected: results.filter(result => result.status === "rejected").length,
      },
    });
  }

  return {
    processed: results.length,
    verified: results.filter(result => result.status === "verified").length,
    rejected: results.filter(result => result.status === "rejected").length,
    removedOffers: removedOfferIds.size,
    touchedProductIds: [...touchedProducts],
    reasons,
    results,
  };
}

export function markEbayCompetitorSanitizerUnresolved(
  offerIds = [],
  reason = "getItems-no-detail",
  { deferPersistence = false } = {}
) {
  const wanted = new Set((offerIds || []).map(Number).filter(Number.isFinite));
  if (!wanted.size) return 0;
  const data = readDb();
  const now = nowIso();
  let updated = 0;

  for (const offer of data.offers) {
    if (!wanted.has(Number(offer.id))) continue;
    if (String(offer.competitorIdentityStatus || "") !== "pending") continue;
    offer.competitorIdentityLastAttemptAt = now;
    offer.competitorSanitizerAttempts = Number(offer.competitorSanitizerAttempts || 0) + 1;
    offer.competitorIdentityLastReason = String(reason || "getItems-no-detail").slice(0, 500);
    updated++;
  }

  if (updated) {
    if (deferPersistence) scheduleDeferredWrite(data, 250);
    else writeDb(data);
  }
  return updated;
}

export function noteEbayCompetitorSanitizerRun(summary = {}, { deferPersistence = false } = {}) {
  const data = readDb();
  data.meta.ebayCompetitorSanitizerLastRunAt = nowIso();
  data.meta.ebayCompetitorSanitizerLastSelected = Number(summary.selected || 0);
  data.meta.ebayCompetitorSanitizerLastVerified = Number(summary.verified || 0);
  data.meta.ebayCompetitorSanitizerLastRejected = Number(summary.rejected || 0);
  data.meta.ebayCompetitorSanitizerLastDeferred = Number(summary.deferred || 0);
  data.meta.ebayCompetitorSanitizerLastApiCalls = Number(summary.apiCalls || 0);
  data.meta.ebayCompetitorSanitizerLastCallBudget = Number(summary.callBudget || 0);
  data.meta.ebayCompetitorSanitizerLastReason = String(summary.reason || "").slice(0, 160);
  if (deferPersistence) scheduleDeferredWrite(data, 250);
  else writeDb(data);
}

export function getEbayCompetitorSanitizerStatus() {
  const data = readDb();
  const productById = new Map(
    data.products.map(product => [Number(product.id), product])
  );
  const nowMs = Date.now();
  const pendingOffers = data.offers.filter(offer =>
    String(offer.matchSource || "").startsWith("ebay-competitor:") &&
    String(offer.competitorIdentityStatus || "") === "pending"
  );
  const verified = data.offers.filter(offer =>
    String(offer.matchSource || "").startsWith("ebay-competitor:") &&
    String(offer.competitorIdentityStatus || "") === "verified"
  ).length;

  let eligiblePending = 0;
  let identityBlockedPending = 0;
  let retryDeferredPending = 0;
  for (const offer of pendingOffers) {
    const product = productById.get(Number(offer.productId));
    if (!product || !productEbayIdentityProofType(product)) {
      identityBlockedPending++;
      continue;
    }
    const nextAttempt = Date.parse(offer.competitorIdentityNextAttemptAt || "");
    if (Number.isFinite(nextAttempt) && nextAttempt > nowMs) {
      retryDeferredPending++;
      continue;
    }
    eligiblePending++;
  }

  return {
    pending: pendingOffers.length,
    eligiblePending,
    identityBlockedPending,
    retryDeferredPending,
    verified,
    lastRunAt: data.meta.ebayCompetitorSanitizerLastRunAt || null,
    lastSelected: Number(data.meta.ebayCompetitorSanitizerLastSelected || 0),
    lastVerified: Number(data.meta.ebayCompetitorSanitizerLastVerified || 0),
    lastRejected: Number(data.meta.ebayCompetitorSanitizerLastRejected || 0),
    lastDeferred: Number(data.meta.ebayCompetitorSanitizerLastDeferred || 0),
    lastApiCalls: Number(data.meta.ebayCompetitorSanitizerLastApiCalls || 0),
    lastCallBudget: Number(data.meta.ebayCompetitorSanitizerLastCallBudget || 0),
    lastReason: String(data.meta.ebayCompetitorSanitizerLastReason || ""),
    verifiedTotal: Number(data.meta.ebayCompetitorSanitizerVerifiedTotal || 0),
    rejectedTotal: Number(data.meta.ebayCompetitorSanitizerRejectedTotal || 0),
  };
}

function cachedOrCurrentBestOffer(data, product, lookup) {
  return product ? bestOfferFor(data, product.id, lookup) : null;
}

export function getSearchIndexSnapshot() {
  const data = readDb();
  const approved = (data.products || []).filter(
    product => product.approved && product.lifecycleState !== "ARCHIVED"
  );

  // V3.7.47 worker snapshots are background infrastructure, but snapshot
  // construction itself still runs on Node's main thread before structured
  // cloning. Do not build OfferGrid's general-purpose global relationship
  // graph here. The overwhelming majority of public products already have a
  // durable cached display-offer ID; resolve those IDs in one offer pass, then
  // run full trust fallback only for the small exceptional set.
  const cachedOfferIds = new Set(
    approved
      .map(product => Number(product.cachedBestOfferId))
      .filter(Number.isFinite)
  );
  const cachedOfferById = new Map();
  for (const offer of data.offers || []) {
    const offerId = Number(offer.id);
    if (cachedOfferIds.has(offerId)) cachedOfferById.set(offerId, offer);
  }

  const fastBestByProductId = new Map();
  const fallbackProductIds = [];
  for (const product of approved) {
    const cached = product.cachedBestOfferId == null
      ? null
      : cachedOfferById.get(Number(product.cachedBestOfferId)) || null;
    if (
      cached &&
      Number(cached.productId) === Number(product.id) &&
      intelligenceEligibleListing(cached) &&
      cached.availability !== "out_of_stock" &&
      !cached.priceDisplayRestricted &&
      Boolean(String(cached.affiliateUrl || "").trim())
    ) {
      fastBestByProductId.set(Number(product.id), cached);
    } else {
      fallbackProductIds.push(Number(product.id));
    }
  }

  const fallbackLookup = fallbackProductIds.length
    ? buildPageHydrationLookup(data, fallbackProductIds, {
        approvedOnly: false,
        includeClicks: false,
      })
    : null;

  return approved
    .map(product => {
      const productId = Number(product.id);
      const fastBest = fastBestByProductId.get(productId) || null;
      const best = fastBest || (fallbackLookup
        ? cachedOrCurrentBestOffer(data, product, fallbackLookup)
        : null);
      const conditionBest = best || !fallbackLookup
        ? null
        : bestConditionExceptionOfferFor(data, product.id, fallbackLookup);
      if (!best && !conditionBest) return null;
      const selected = best || conditionBest;
      const conditionException = !best && Boolean(conditionBest);
      return {
        id: product.id,
        category: product.category || "Other",
        title: product.title || "",
        brand: product.brand || "",
        searchText:
          product.searchText ||
          `${product.title} ${product.brand} ${product.category} ${product.editorNote} ${product.aiSummary}`.toLowerCase(),
        conditionException,
        heat: conditionException ? 0 : Number(product.cachedPriceStats?.dealHeat || 0),
        bestPrice: Number.isFinite(Number(selected.price)) ? Number(selected.price) : null,
        bestScore: conditionException ? 0 : Number(selected.score || 0),
        verificationRank:
          String(selected.provider || "").toLowerCase() !== "ebay" || selected.priceVerifiedAt ? 2 : 0,
        competitorSellerCount: conditionException
          ? 0
          : Math.max(0, Number(product.cachedVerifiedSellerCount || 0)),
        updatedAtMs: Date.parse(product.updatedAt || 0) || 0,
      };
    })
    .filter(Boolean);
}

export function getPublicProductsByIds(ids = [], { includeParts = false } = {}) {
  const data = readDb();
  const orderedIds = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map(Number)
      .filter(Number.isFinite)
  )];
  if (!orderedIds.length) return [];
  // If a full relationship cache is already current, reuse it. Immediately
  // after a catalog mutation, however, do NOT make this 40-card shopper read
  // rebuild relationships for every product/offer/click in the database. A
  // page-scoped lookup keeps the foreground allocation bounded while worker
  // warmup/background maintenance can rebuild global structures later.
  const lookup = runtimeOfferLookupCacheValid(data)
    ? getRuntimeOfferLookup(data, { includeClicks: true })
    : buildPageHydrationLookup(data, orderedIds, { approvedOnly: true, includeClicks: true });

  return orderedIds
    .map(id => lookup.productByNumericId.get(id))
    // Double-buffered workers may briefly serve an older revision. Never let a
    // stale worker resurrect a product an admin has hidden or archived.
    .filter(product => product?.approved && product.lifecycleState !== "ARCHIVED")
    .map(product => {
      if (cachedOrCurrentBestOffer(data, product, lookup)) {
        return hydrate(data, product, { lookup });
      }
      return includeParts
        ? hydrateConditionExceptionProduct(data, product, { lookup })
        : null;
    })
    .filter(product => product?.bestOffer);
}

function getDraftSearchCandidatesInDb(data, {
  q = "",
  category = "",
  limit = Number(process.env.LIVE_SEARCH_DRAFT_REVIEW_LIMIT || 400),
  lookup = null,
  includeParts = false,
} = {}) {
  const query = String(q || "").trim();
  if (!query || isExplicitSearchQuery(query)) return [];

  const cap = Math.min(Math.max(Number(limit || 400), 1), 2000);
  const maxAgeMs = draftAutoApprovalMaxAgeMs();
  const now = Date.now();
  const relevantProducts = [];

  // Phase 1 is product-only. A quota-constrained shopper query should not have
  // to construct the entire product/offer relationship graph just to discover
  // which draft product IDs are lexically relevant.
  for (const product of data.products || []) {
    if (product.approved) continue;
    if (String(product.lifecycleState || "ACTIVE").toUpperCase() !== "ACTIVE") continue;
    if (product.autoApprovalBlocked || product.manualReviewTouchedAt) continue;
    if (isExplicitProduct(product)) continue;
    if (category && product.category !== category) continue;

    const createdMs = Date.parse(product.createdAt || product.updatedAt || "");
    if (!Number.isFinite(createdMs) || now - createdMs > maxAgeMs) continue;

    const relevance = searchRelevance(query, {
      title: product.title,
      brand: product.brand,
      category: product.category,
      searchText:
        product.searchText ||
        `${product.title || ""} ${product.brand || ""} ${product.category || ""} ${product.editorNote || ""} ${product.aiSummary || ""}`,
    });
    if (!relevance.relevant) continue;

    relevantProducts.push({
      product,
      productId: Number(product.id),
      relevanceScore: Number(relevance.score || 0),
      createdAt: product.createdAt || product.updatedAt || null,
    });
  }

  if (!relevantProducts.length) return [];

  relevantProducts.sort((a, b) =>
    Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0) ||
    Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0) ||
    Number(b.productId) - Number(a.productId)
  );

  // Phase 2 retains relationships only for the query-relevant drafts. Global
  // uniqueness/trust knowledge remains in the separate draft-review index.
  const relevantIds = relevantProducts.map(item => item.productId);
  const effectiveLookup = lookup || buildPageHydrationLookup(data, relevantIds, {
    approvedOnly: false,
    includeClicks: false,
  });
  const offersByProduct = effectiveLookup.offersByNumericProductId;
  const matches = [];

  for (const item of relevantProducts) {
    const productOffers = (offersByProduct.get(Number(item.productId)) || [])
      .filter(offer => includeParts || intelligenceEligibleListing(offer))
      .filter(offer =>
        offer.availability !== "out_of_stock" &&
        !offer.priceDisplayRestricted &&
        String(offer.affiliateUrl || "").trim()
      );
    if (!productOffers.length) continue;

    const ebayExternalIds = [...new Set(
      productOffers
        .filter(offer =>
          String(offer.provider || "").toLowerCase() === "ebay" &&
          !offer.priceVerifiedAt &&
          String(offer.externalId || "").trim()
        )
        .map(offer => String(offer.externalId))
    )];

    matches.push({
      productId: item.productId,
      relevanceScore: item.relevanceScore,
      createdAt: item.createdAt,
      ebayExternalIds,
    });
    if (matches.length >= cap) break;
  }

  return matches;
}

export function getDraftSearchCandidates(options = {}) {
  return getDraftSearchCandidatesInDb(readDb(), options);
}

function pendingVerificationStats(offer) {
  const current = Number(offer?.price);
  return {
    currentPrice: Number.isFinite(current) ? current : null,
    average30d: null,
    low30d: null,
    high30d: null,
    previousPrice: null,
    firstTrackedPrice: null,
    changeVsPreviousPct: 0,
    changeSinceTrackingPct: 0,
    savingsVsAveragePct: 0,
    historyCount: 0,
    trackingStartedAt: null,
    newLow: false,
    dealHeat: 0,
    heatLabel: "Verification pending",
    heatConfidence: "pending",
    dealHeatOutliersPruned: 0,
  };
}

function hydratePendingVerificationProductInDb(
  data,
  product,
  verdict,
  { includeHistory = false, lookup = null } = {}
) {
  const offer = lookup?.offerByNumericId?.get(Number(verdict?.offerId)) ||
    (data.offers || []).find(item => Number(item.id) === Number(verdict?.offerId));
  if (!offer) return null;

  const observedAt =
    offer.searchObservedAt ||
    offer.lastSeen ||
    product.updatedAt ||
    product.createdAt ||
    null;

  const conditionException = Boolean(verdict?.conditionExcluded);
  const exactVerified = Boolean(offer.priceVerifiedAt);
  return {
    ...product,
    approved: false,
    shopperVisible: true,
    verificationPending: !exactVerified,
    conditionException,
    conditionExcludedFromIntelligence: conditionException,
    conditionExclusionReason: String(verdict?.conditionExclusionReason || ""),
    pendingVerification: !exactVerified ? {
      provider: "ebay",
      reason: "exact-item-verification-pending",
      observedAt,
      confidence: Number(verdict?.confidence || 0),
      message:
        "This listing matched your search and passed OfferGrid's local identity safety checks, but eBay exact-item verification is temporarily pending.",
    } : null,
    offers: [offer],
    bestOffer: offer,
    displayTitle: offer.listingTitle || product.title,
    displayImageUrl: offer.imageUrl || product.imageUrl,
    priceAccuracy: exactVerified ? {
      status: "verified",
      label: conditionException ? "Verified non-working/parts listing" : "Verified against eBay",
      verifiedAt: offer.priceVerifiedAt,
      observedAt,
      source: "eBay item detail",
    } : {
      status: "pending",
      label: conditionException ? "Non-working/parts · verification pending" : "eBay verification pending",
      verifiedAt: null,
      observedAt,
      source: "eBay search observation",
    },
    priceStats: conditionException
      ? { ...pendingVerificationStats(offer), heatLabel: "Excluded condition", heatConfidence: "excluded" }
      : pendingVerificationStats(offer),
    priceSparkline: [],
    ebayCompetition: null,
    marketComparison: null,
    clicks30d: clicksForProduct(data, product.id, 30, lookup),
    ...(includeHistory ? { priceHistory: [] } : {}),
  };
}

export function getPendingVerificationSearchProducts({
  q = "",
  category = "",
  limit = 100,
  includeParts = false,
} = {}) {
  const data = readDb();
  const matches = getDraftSearchCandidatesInDb(data, {
    q,
    category,
    limit: Math.min(Math.max(Number(limit || 100), 1), 500),
    includeParts,
  });
  if (!matches.length) return [];

  const matchIds = matches.map(match => Number(match.productId)).filter(Number.isFinite);
  const lookup = buildPageHydrationLookup(data, matchIds, {
    approvedOnly: false,
    includeClicks: true,
  });
  const reviewIndex = getRuntimeDraftAutoReviewIndex(data);
  const productById = lookup.productByNumericId;
  const out = [];

  for (const match of matches) {
    const product = productById.get(Number(match.productId));
    const verdict = evaluatePendingVerificationVisibilityInDb(
      data,
      product,
      lookup,
      reviewIndex,
      { allowConditionExcluded: includeParts }
    );
    if (!verdict.eligible) continue;

    const hydrated = hydratePendingVerificationProductInDb(
      data,
      product,
      verdict,
      { lookup }
    );
    if (hydrated) out.push(hydrated);
  }

  return out;
}

export function getShopperProduct(id, { includeParts = false } = {}) {
  const data = readDb();
  const product = data.products.find(item => Number(item.id) === Number(id));
  if (!product) return null;

  const lookup = buildPageHydrationLookup(data, [Number(product.id)], {
    approvedOnly: false,
    includeClicks: true,
  });

  if (product.approved && product.lifecycleState !== "ARCHIVED") {
    if (cachedOrCurrentBestOffer(data, product, lookup)) {
      return hydrate(data, product, { includeHistory: true, lookup });
    }
    return includeParts
      ? hydrateConditionExceptionProduct(data, product, { includeHistory: true, lookup })
      : null;
  }

  const reviewIndex = getRuntimeDraftAutoReviewIndex(data);
  const verdict = evaluatePendingVerificationVisibilityInDb(
    data,
    product,
    lookup,
    reviewIndex,
    { allowConditionExcluded: includeParts }
  );
  if (!verdict.eligible) return null;

  return hydratePendingVerificationProductInDb(
    data,
    product,
    verdict,
    { includeHistory: true, lookup }
  );
}

export function getPublicSearchMatchIds({ q = "", category = "", productIds = null, includeParts = false } = {}) {
  const data = readDb();
  const query = String(q || "").trim();
  const requestedIds = productIds == null
    ? null
    : new Set(Array.from(productIds || []).map(Number).filter(Number.isFinite));
  if (requestedIds && requestedIds.size === 0) return [];

  // Progressive discovery calls this repeatedly for tiny verified batches.
  // Build relationships only for those touched products instead of rescanning
  // every offer in the catalog after each exact-detail burst.
  const lookup = requestedIds
    ? buildPageHydrationLookup(data, [...requestedIds], { approvedOnly: false, includeClicks: false })
    : getRuntimeOfferLookup(data);
  const out = [];
  const products = requestedIds
    ? [...lookup.productByNumericId.values()]
    : data.products;

  for (const product of products) {
    if (!product.approved || product.lifecycleState === "ARCHIVED") continue;
    if (category && product.category !== category) continue;
    if (query && !searchRelevance(query, {
      title: product.title,
      brand: product.brand,
      category: product.category,
      searchText:
        product.searchText ||
        `${product.title} ${product.brand} ${product.category} ${product.editorNote} ${product.aiSummary}`,
    }).relevant) continue;
    const normalBest = cachedOrCurrentBestOffer(data, product, lookup);
    if (!normalBest && !(includeParts && bestConditionExceptionOfferFor(data, product.id, lookup))) continue;
    out.push(Number(product.id));
  }

  return out;
}

export function countPublicSearchMatches({ q = "", category = "", includeParts = false } = {}) {
  return getPublicSearchMatchIds({ q, category, includeParts }).length;
}

export function listPublicProductsPage({
  q = "",
  category = "",
  page = 1,
  pageSize = 100,
  sort = "heat",
} = {}) {
  const data = readDb();
  const query = String(q || "").trim().toLowerCase();
  const safePageSize = Math.min(Math.max(Number(pageSize || 100), 1), 100);
  const requestedPage = Math.max(Number(page || 1), 1);
  const lookup = getRuntimeOfferLookup(data, { includeClicks: true });

  let raw = data.products
    .filter(product => product.approved && product.lifecycleState !== "ARCHIVED")
    .filter(product => Boolean(cachedOrCurrentBestOffer(data, product, lookup)))
    .filter(product => !category || product.category === category)
    .filter(product =>
      !query || searchRelevance(query, {
        title: product.title,
        brand: product.brand,
        category: product.category,
        searchText:
          product.searchText ||
          `${product.title} ${product.brand} ${product.category} ${product.editorNote} ${product.aiSummary}`,
      }).relevant
    );

  if (sort === "competitors") {
    raw.sort((a, b) =>
      Number(b.cachedVerificationRank || 0) - Number(a.cachedVerificationRank || 0) ||
      Number(b.cachedVerifiedSellerCount || 0) - Number(a.cachedVerifiedSellerCount || 0) ||
      Number(b.cachedPriceStats?.dealHeat || 0) - Number(a.cachedPriceStats?.dealHeat || 0) ||
      Number(b.cachedBestScore || 0) - Number(a.cachedBestScore || 0)
    );
  } else if (sort === "price") {
    raw.sort((a, b) =>
      Number(b.cachedVerificationRank || 0) - Number(a.cachedVerificationRank || 0) ||
      Number(a.cachedBestPrice ?? Infinity) - Number(b.cachedBestPrice ?? Infinity)
    );
  } else if (sort === "new") {
    raw.sort((a, b) =>
      Number(b.cachedVerificationRank || 0) - Number(a.cachedVerificationRank || 0) ||
      Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)
    );
  } else {
    raw.sort((a, b) =>
      Number(b.cachedPriceStats?.dealHeat || 0) - Number(a.cachedPriceStats?.dealHeat || 0) ||
      Number(b.cachedVerificationRank || 0) - Number(a.cachedVerificationRank || 0) ||
      Number(b.cachedBestScore || 0) - Number(a.cachedBestScore || 0)
    );
  }

  const total = raw.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = query ? requestedPage : Math.min(requestedPage, totalPages);
  const start = (safePage - 1) * safePageSize;

  const pageProducts = raw.slice(start, start + safePageSize);

  return {
    products: pageProducts
      .map(product => hydrate(data, product, { lookup }))
      .filter(product => product.bestOffer),
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages,
  };
}

export function listPublicProducts({ q = "", category = "", limit = 120, sort = "heat" } = {}) {
  const data = readDb();
  const query = String(q || "").trim().toLowerCase();
  const cap = Math.min(Math.max(Number(limit || 120), 1), 5000);
  const lookup = getRuntimeOfferLookup(data, { includeClicks: true });

  let raw = data.products
    .filter(product => product.approved && product.lifecycleState !== "ARCHIVED")
    .filter(product => Boolean(cachedOrCurrentBestOffer(data, product, lookup)))
    .filter(product => !category || product.category === category)
    .filter(product =>
      !query || searchRelevance(query, {
        title: product.title,
        brand: product.brand,
        category: product.category,
        searchText:
          product.searchText ||
          `${product.title} ${product.brand} ${product.category} ${product.editorNote} ${product.aiSummary}`,
      }).relevant
    );

  if (sort === "competitors") {
    raw.sort((a, b) =>
      Number(b.cachedVerificationRank || 0) - Number(a.cachedVerificationRank || 0) ||
      Number(b.cachedVerifiedSellerCount || 0) - Number(a.cachedVerifiedSellerCount || 0) ||
      Number(b.cachedPriceStats?.dealHeat || 0) - Number(a.cachedPriceStats?.dealHeat || 0) ||
      Number(b.cachedBestScore || 0) - Number(a.cachedBestScore || 0)
    );
  } else if (sort === "price") {
    raw.sort((a, b) =>
      Number(b.cachedVerificationRank || 0) - Number(a.cachedVerificationRank || 0) ||
      Number(a.cachedBestPrice ?? Infinity) - Number(b.cachedBestPrice ?? Infinity)
    );
  } else if (sort === "new") {
    raw.sort((a, b) =>
      Number(b.cachedVerificationRank || 0) - Number(a.cachedVerificationRank || 0) ||
      Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)
    );
  } else {
    raw.sort((a, b) =>
      Number(b.cachedPriceStats?.dealHeat || 0) - Number(a.cachedPriceStats?.dealHeat || 0) ||
      Number(b.cachedVerificationRank || 0) - Number(a.cachedVerificationRank || 0) ||
      Number(b.cachedBestScore || 0) - Number(a.cachedBestScore || 0)
    );
  }

  return raw
    .slice(0, cap)
    .map(product => hydrate(data, product, { lookup }))
    .filter(product => product.bestOffer);
}

export function getTrendingDeals(limit = 30) {
  return listPublicProducts({ limit, sort: "heat" });
}

export function listAllProducts({ limit = 500 } = {}) {
  const data = readDb();
  return data.products
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit)
    .map(p => hydrate(data, p));
}

export function getProduct(
  id,
  publicOnly = false,
  { includeHistory = true } = {}
) {
  const data = readDb();
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return null;

  // V3.7.47: product-detail reads should never force unrelated offer/history
  // scans. Build one relationship bucket for exactly this product. Internal
  // orchestration can also opt out of historical hydration when it only needs
  // current offers/coverage metadata.
  const lookup = buildPageHydrationLookup(data, [numericId], {
    approvedOnly: false,
    includeClicks: Boolean(includeHistory),
  });
  const product = lookup.productByNumericId.get(numericId) || null;
  if (!product || (publicOnly && !product.approved)) return null;
  return hydrate(data, product, { includeHistory: Boolean(includeHistory), lookup });
}

// V3.7.47 lightweight internal read for orchestration paths that only need
// persisted coverage/identity/cache metadata. It deliberately does not hydrate
// price history, market comparison, click counts, or queue intelligence work.
export function getProductRecord(id, publicOnly = false) {
  const data = readDb();
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return null;
  const product = (data.products || []).find(item => Number(item.id) === numericId) || null;
  if (!product || (publicOnly && !product.approved)) return null;
  return product;
}

export function getProductRecordsByIds(ids = [], publicOnly = false) {
  const wanted = new Set(
    (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite)
  );
  if (!wanted.size) return [];
  const data = readDb();
  const found = new Map();
  for (const product of data.products || []) {
    const id = Number(product.id);
    if (!wanted.has(id) || (publicOnly && !product.approved)) continue;
    found.set(id, product);
    if (found.size >= wanted.size) break;
  }
  return [...wanted].map(id => found.get(id)).filter(Boolean);
}

export function getCategories() {
  const data = readDb();
  if (RUNTIME_CATEGORY_CACHE_REVISION === SEARCH_INDEX_REVISION) {
    return [...RUNTIME_CATEGORY_CACHE];
  }
  const counts = new Map();
  for (const product of data.products || []) {
    if (!product.approved || product.lifecycleState === "ARCHIVED") continue;
    const category = boundedText(product.category, 120);
    if (!category) continue;
    counts.set(category, Number(counts.get(category) || 0) + 1);
  }

  // Marketplace leaf taxonomies occasionally contain IDs, seller-generated
  // compatibility strings and one-off fragments. They remain searchable, but
  // do not belong in the shopper's primary category navigation.
  RUNTIME_CATEGORY_CACHE = [...counts]
    .filter(([category, count]) =>
      count >= 3 &&
      category.length >= 3 &&
      /[a-z]/i.test(category) &&
      !/^\d+$/.test(category) &&
      !/^(?:co|ct|counter|every other thing)$/i.test(category) &&
      !/^(?:fit for|replacement for)\b/i.test(category) &&
      !/^undersink-[a-z0-9]/i.test(category) &&
      category !== category.toLowerCase()
    )
    .map(([category]) => category)
    .sort((a, b) => a.localeCompare(b));
  RUNTIME_CATEGORY_CACHE_REVISION = SEARCH_INDEX_REVISION;
  return [...RUNTIME_CATEGORY_CACHE];
}

export function getStats() {
  const data = readDb();
  const lifecycle = {};

  for (const state of ["ACTIVE", "DORMANT", "STALE", "PRUNABLE", "ARCHIVED"]) {
    lifecycle[state] = data.products.filter(
      product => product.lifecycleState === state
    ).length;
  }

  return {
    products: data.products.length,
    liveCatalogProducts: data.products.filter(
      product => product.lifecycleState !== "ARCHIVED"
    ).length,
    archivedProducts: lifecycle.ARCHIVED,
    offers: data.offers.length,
    approved: data.products.filter(p => p.approved).length,
    draft: data.products.filter(
      p => !p.approved && p.lifecycleState !== "ARCHIVED"
    ).length,
    rules: data.discoveryRules.length,
    historyPoints: data.priceHistory.length,
    priceAggregates: data.priceAggregates.length,
    lifecycle,
  };
}

export function setApproved(id, approved) {
  const data = readDb();
  const product = data.products.find(p => p.id === Number(id));
  if (!product) return null;

  if (product.lifecycleState === "ARCHIVED" && approved) {
    return hydrate(data, product);
  }

  const decisionAt = nowIso();
  product.approved = Boolean(approved);
  product.updatedAt = decisionAt;
  product.manualReviewTouchedAt = decisionAt;
  product.approvalSource = product.approved ? "manual" : "manual-hidden";
  product.approvedAt = product.approved ? decisionAt : null;
  product.autoApprovalBlocked = !product.approved;
  product.lastAutoReviewDecision = product.approved ? "manual-approved" : "manual-hidden";
  product.lastAutoReviewReason = product.approved
    ? "Admin explicitly approved this product."
    : "Admin explicitly hid this product; automatic draft approval is locked.";
  SEARCH_INDEX_REVISION++;
  writeDb(data);

  publishProductLiveMutation(data, {
    type: "catalog",
    reason: product.approved ? "product-approved" : "product-hidden",
    productIds: [product.id],
  });

  return hydrate(data, product);
}

export function updateProduct(id, changes = {}) {
  const data = readDb();
  const product = data.products.find(p => p.id === Number(id));
  if (!product) return null;

  assertNonExplicitProduct({
    ...product,
    title: changes.title != null ? String(changes.title) : product.title,
    category: changes.category != null ? String(changes.category) : product.category,
    editorNote: changes.editorNote != null ? String(changes.editorNote) : product.editorNote,
    aiSummary: changes.aiSummary != null ? String(changes.aiSummary) : product.aiSummary,
  });

  const editoriallyTouched =
    changes.title != null ||
    changes.category != null ||
    changes.editorNote != null ||
    changes.aiSummary != null ||
    Array.isArray(changes.tags);

  if (changes.title != null) product.title = String(changes.title).trim().slice(0, 500) || product.title;
  if (changes.category != null) product.category = String(changes.category).trim().slice(0, 200) || "Other";
  if (changes.editorNote != null) product.editorNote = String(changes.editorNote).trim().slice(0, 5000);
  if (changes.aiSummary != null) product.aiSummary = String(changes.aiSummary).trim().slice(0, 1800);
  if (Array.isArray(changes.tags)) product.tags = changes.tags.map(v => String(v).slice(0, 80)).slice(0, 10);

  if (editoriallyTouched) {
    const touchedAt = nowIso();
    product.manualReviewTouchedAt = touchedAt;
    if (!product.approved) {
      product.autoApprovalBlocked = true;
      product.lastAutoReviewDecision = "manual-review";
      product.lastAutoReviewReason = "Draft was edited in Admin and now requires an explicit manual approval.";
    }
  }
  if (changes.lifecyclePinned != null) {
    product.lifecyclePinned = Boolean(changes.lifecyclePinned);
  }

  product.lifecycleNormalizedTitle =
    normalizeLifecycleIdentityText(product.title);
  product.lifecycleNormalizedBrand =
    normalizeLifecycleIdentityText(product.brand);
  product.lifecycleIdentityKey = lifecycleIdentityKey(product);

  product.updatedAt = nowIso();
  const updateLookup = buildPageHydrationLookup(data, [product.id], {
    approvedOnly: false,
    includeClicks: false,
  });
  refreshProductFastCachesForIdsInDb(data, [product.id], { lookup: updateLookup });
  markProductsIntelligenceDirtyInDb(data, [product.id], "product-edited");
  writeDb(data);
  enqueueIntelligenceProducts([product.id], { priority: "normal", reason: "product-edited" });

  publishProductLiveMutation(data, {
    type: "catalog",
    reason: "product-edited",
    productIds: [product.id],
  });

  return getProduct(product.id, false);
}

export function deleteProduct(id) {
  const data = readDb();
  const productId = Number(id);
  const before = data.products.length;
  data.products = data.products.filter(p => p.id !== productId);
  data.offers = data.offers.filter(o => o.productId !== productId);
  data.priceHistory = data.priceHistory.filter(h => h.productId !== productId);
  data.priceAggregates = data.priceAggregates.filter(
    item => Number(item.productId) !== productId
  );
  data.clicks = data.clicks.filter(c => c.productId !== productId);
  if (data.products.length === before) return false;
  SEARCH_INDEX_REVISION++;
  writeDb(data);

  publishProductLiveMutation(data, {
    type: "catalog",
    reason: "product-deleted",
    deletedProductIds: [productId],
  });

  return true;
}

export function reconcileProviderFeed(
  provider,
  {
    externalIdPrefix = "",
    priceSourcePrefix = "",
    activeExternalIds = null,
    unavailableExternalIds = null,
    replaceScope = false,
    deferPersistence = false,
    reason = "provider-feed-reconcile",
  } = {}
) {
  const data = readDb();
  const providerKey = String(provider || "").trim().toLowerCase();
  const prefix = String(externalIdPrefix || "");
  const sourcePrefix = String(priceSourcePrefix || "").trim().toLowerCase();
  const active = activeExternalIds == null
    ? null
    : new Set(Array.from(activeExternalIds || []).map(value => String(value)));
  const unavailable = new Set(
    Array.from(unavailableExternalIds || []).map(value => String(value))
  );

  if (!providerKey) throw new Error("Provider is required for feed reconciliation.");

  const touched = new Set();
  let offersMarkedUnavailable = 0;
  let offersConfirmedActive = 0;

  for (const offer of data.offers) {
    if (String(offer.provider || "").toLowerCase() !== providerKey) continue;
    const externalId = String(offer.externalId || "");
    if (prefix && !externalId.startsWith(prefix)) continue;
    if (
      sourcePrefix &&
      !String(offer.priceSource || "").toLowerCase().startsWith(sourcePrefix)
    ) continue;

    const explicitlyUnavailable = unavailable.has(externalId);
    const missingFromFullFeed = Boolean(
      replaceScope &&
      active &&
      !active.has(externalId)
    );

    if (explicitlyUnavailable || missingFromFullFeed) {
      if (offer.availability !== "out_of_stock") {
        offer.availability = "out_of_stock";
        offer.score = 0;
        offer.lastSeen = nowIso();
        touched.add(Number(offer.productId));
        offersMarkedUnavailable++;
      }
      continue;
    }

    if (active?.has(externalId) && offer.availability !== "out_of_stock") {
      offersConfirmedActive++;
    }
  }

  const touchedIds = [...touched].filter(Number.isFinite);
  if (touchedIds.length) {
    const lookup = buildPageHydrationLookup(data, touchedIds, {
      approvedOnly: false,
      includeClicks: false,
    });
    rescoreProductIdsInDb(data, touchedIds, lookup);
    queueRuntimeProductMutation(data, touchedIds, {
      forceHistoryProductIds: touchedIds,
      reason,
      lookup,
    });

    publishProductLiveMutation(data, {
      type: "price",
      reason,
      productIds: touchedIds,
      metadata: {
        provider: providerKey,
        offersMarkedUnavailable,
      },
    });
  }

  return {
    provider: providerKey,
    externalIdPrefix: prefix,
    priceSourcePrefix: sourcePrefix,
    replaceScope: Boolean(replaceScope),
    activeIds: active?.size || 0,
    unavailableIds: unavailable.size,
    offersConfirmedActive,
    offersMarkedUnavailable,
    productsTouched: touchedIds.length,
  };
}

export function markMissingOffers(days = 7) {
  const data = readDb();
  const cutoff = Date.now() - Number(days) * 86_400_000;
  const touched = new Set();
  let changed = 0;

  for (const offer of data.offers || []) {
    if (Date.parse(offer.lastSeen) < cutoff && offer.availability !== "out_of_stock") {
      changed++;
      touched.add(offer.productId);
      // Preserve object/array identity for every runtime reader. Replacing the
      // complete offer array just to mark a small stale subset unavailable
      // created avoidable allocation/GC pressure on large catalogs.
      offer.availability = "out_of_stock";
      offer.score = 0;
    }
  }

  if (changed) {
    const touchedIds = [...touched].map(Number).filter(Number.isFinite);
    const missingLookup = buildPageHydrationLookup(data, touchedIds, {
      approvedOnly: false,
      includeClicks: false,
    });
    rescoreProductIdsInDb(data, touchedIds, missingLookup);
    queueRuntimeProductMutation(data, touchedIds, {
      forceHistoryProductIds: touchedIds,
      reason: "offers-marked-missing",
      lookup: missingLookup,
    });

    publishProductLiveMutation(data, {
      type: "price",
      reason: "offers-marked-missing",
      productIds: [...touched],
      metadata: { offersChanged: changed },
    });
  }
  return changed;
}

export function getOutboundClickTarget(offerId) {
  const data = readDb();
  const offer = data.offers.find(item => Number(item.id) === Number(offerId));
  if (!offer) return null;

  const product = data.products.find(item => Number(item.id) === Number(offer.productId));
  const affiliateUrl = safeHttpUrl(offer.affiliateUrl, 4000);
  if (
    !product ||
    product.lifecycleState === "ARCHIVED" ||
    offer.availability === "out_of_stock" ||
    offer.priceDisplayRestricted ||
    !affiliateUrl
  ) return null;

  let pendingVerdict = null;
  const outboundLookup = buildPageHydrationLookup(data, [product.id], {
    approvedOnly: false,
    includeClicks: false,
  });
  if (!product.approved) {
    pendingVerdict = evaluatePendingVerificationVisibilityInDb(
      data,
      product,
      outboundLookup,
      getRuntimeDraftAutoReviewIndex(data)
    );
    if (
      !pendingVerdict.eligible ||
      Number(pendingVerdict.offerId) !== Number(offer.id)
    ) return null;
  }

  const trust = ebayOfferTrust(data, product, offer, { lookup: outboundLookup });
  const pendingCompetitor = pendingEbayCompetitorLocallySafe(product, offer);
  if (!trust.trusted && !pendingCompetitor) return null;

  const verifiedAt = Date.parse(offer.priceVerifiedAt || "") || 0;
  const staleMinutes = Math.max(1, Number(process.env.EBAY_OUTBOUND_REVALIDATE_MINUTES || 5));
  const needsRevalidation =
    !pendingCompetitor &&
    String(offer.provider || "").toLowerCase() === "ebay" &&
    (!verifiedAt || Date.now() - verifiedAt > staleMinutes * 60_000);

  return {
    id: Number(offer.id),
    productId: Number(product.id),
    provider: String(offer.provider || ""),
    availability: offer.availability || "in_stock",
    affiliateUrl,
    priceVerifiedAt: offer.priceVerifiedAt || null,
    needsRevalidation,
    verificationPending: Boolean(pendingVerdict?.eligible || pendingCompetitor),
    pendingCompetitor,
    trust,
  };
}

export function recordOutboundClick(
  offerId,
  { referrer = "", userAgent = "", clickReference = "", attribution = {} } = {}
) {
  const data = readDb();
  const offer = data.offers.find(o => o.id === Number(offerId));
  if (!offer) return null;
  const product = data.products.find(p => p.id === offer.productId);
  if (!product || product.lifecycleState === "ARCHIVED") return null;

  const clickLookup = buildPageHydrationLookup(data, [product.id], {
    approvedOnly: false,
    includeClicks: false,
  });
  if (!product.approved) {
    const pendingVerdict = evaluatePendingVerificationVisibilityInDb(
      data,
      product,
      clickLookup,
      getRuntimeDraftAutoReviewIndex(data)
    );
    if (
      !pendingVerdict.eligible ||
      Number(pendingVerdict.offerId) !== Number(offer.id)
    ) return null;
  }

  const outboundTrust = ebayOfferTrust(data, product, offer, { lookup: clickLookup });
  const pendingCompetitor = pendingEbayCompetitorLocallySafe(product, offer);
  if (
    offer.availability === "out_of_stock" ||
    (!outboundTrust.trusted && !pendingCompetitor)
  ) return null;

  const click = {
    id: data.meta.nextClickId++,
    productId: product.id,
    offerId: offer.id,
    provider: boundedToken(offer.provider, 80).toLowerCase(),
    at: nowIso(),
    referrer: String(referrer || "").slice(0, 500),
    userAgent: String(userAgent || "").slice(0, 300),
    clickReference: boundedToken(clickReference, 100),
    source: boundedToken(attribution?.source, 80).toLowerCase(),
    medium: boundedToken(attribution?.medium, 80).toLowerCase(),
    campaign: boundedToken(attribution?.campaign, 120).toLowerCase(),
    content: boundedToken(attribution?.content, 120).toLowerCase(),
    area: boundedToken(attribution?.area, 120).toLowerCase(),
    partner: boundedToken(attribution?.partner, 120).toLowerCase(),
  };
  data.clicks.push(click);

  // Clicks use an append-only ledger so a marketing burst cannot repeatedly
  // snapshot and serialize the full catalog. The next ordinary catalog write
  // may also include them; boot-time merge deduplicates both sources.
  const clickLimit = Math.max(1000, Number(process.env.CLICK_LOG_LIMIT || 50000));
  if (data.clicks.length > clickLimit) {
    data.clicks = data.clicks
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, clickLimit);
  }
  queueOutboundClickAppend(click);

  publishLiveEvent(
    "analytics",
    {
      reason: "outbound-click",
      productId: Number(product.id),
      offerId: Number(offer.id),
    },
    { audience: "admin" }
  );

  return { affiliateUrl: safeHttpUrl(offer.affiliateUrl, 4000), product, offer, click };
}

export function getOffer(id) {
  const data = readDb();
  const offer = data.offers.find(o => o.id === Number(id));
  if (!offer) return null;
  const product = data.products.find(p => p.id === offer.productId) || null;
  return { ...offer, product };
}

export function getOffersByIds(ids = []) {
  const wanted = new Set(
    (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite)
  );
  if (!wanted.size) return [];

  // V3.7.47: verification batches resolve all requested offers in one table
  // pass instead of repeating Array.find() for every ID. Callers that need
  // product detail can hydrate those products separately.
  return readDb().offers
    .filter(offer => wanted.has(Number(offer.id)))
    .map(offer => ({ ...offer }));
}

export function getEbayOffersByExternalIds(externalIds = []) {
  const wanted = new Set(
    (externalIds || []).map(value => String(value))
  );

  return readDb().offers
    .filter(offer =>
      String(offer.provider).toLowerCase() === "ebay" &&
      wanted.has(String(offer.externalId))
    )
    .map(offer => ({ ...offer }));
}

export function getEbayVerificationDemandSnapshot() {
  const data = readDb();
  const active = data.offers.filter(offer =>
    String(offer.provider || "").toLowerCase() === "ebay" &&
    offer.availability !== "out_of_stock" &&
    String(offer.externalId || "").trim()
  );

  const byExternalId = new Map();
  for (const offer of active) {
    const externalId = String(offer.externalId || "").trim();
    const existing = byExternalId.get(externalId);
    if (!existing) {
      byExternalId.set(externalId, {
        externalId,
        verified: Boolean(offer.priceVerifiedAt),
      });
    } else if (offer.priceVerifiedAt) {
      existing.verified = true;
    }
  }

  const unique = [...byExternalId.values()];
  const unverified = unique.filter(item => !item.verified);
  const fullSweepBatches = buildEbayGetItemsBatches(unique, { idOf: item => item.externalId });
  const backlogBatches = buildEbayGetItemsBatches(unverified, { idOf: item => item.externalId });
  const full = summarizeEbayGetItemsBatches(fullSweepBatches);
  const backlog = summarizeEbayGetItemsBatches(backlogBatches);

  return {
    activeOffers: active.length,
    activeUniqueListings: unique.length,
    exactUnverifiedUniqueListings: unverified.length,
    minimumCallsForFullRefreshSweep: full.calls,
    fullRefreshBatchFillPct: full.fillPct,
    minimumCallsToClearUnverifiedBacklog: backlog.calls,
    backlogBatchFillPct: backlog.fillPct,
  };
}

export function getEbayDraftOffersForVerification(limit = 40) {
  const data = readDb();
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 400);
  const approved = new Set(
    data.products.filter(product => product.approved).map(product => Number(product.id))
  );

  const sorter = (a, b) => {
    if (!a.priceVerifiedAt && b.priceVerifiedAt) return -1;
    if (a.priceVerifiedAt && !b.priceVerifiedAt) return 1;
    const at = a.priceVerifiedAt ? Date.parse(a.priceVerifiedAt) : 0;
    const bt = b.priceVerifiedAt ? Date.parse(b.priceVerifiedAt) : 0;
    return at - bt || Date.parse(a.lastSeen || 0) - Date.parse(b.lastSeen || 0);
  };

  return data.offers
    .filter(offer =>
      isEbayOffer(offer) &&
      !approved.has(Number(offer.productId)) &&
      !isEbaySecondarySource(offer) &&
      offer.availability !== "out_of_stock" &&
      String(offer.externalId || "").trim() &&
      String(offer.competitorIdentityStatus || "") !== "pending"
    )
    .sort(sorter)
    .slice(0, cap)
    .map(offer => ({ ...offer }));
}

export function getEbayOffersForVerification(limit = 40) {
  const data = readDb();
  const cap = Math.min(Math.max(Number(limit) || 160, 1), 1000);
  const approved = new Set(
    data.products.filter(product => product.approved).map(product => product.id)
  );

  const sorter = (a, b) => {
    const aMismatch =
      Number.isFinite(Number(a.searchObservedPrice)) &&
      Number.isFinite(Number(a.lastVerifiedPrice)) &&
      Math.abs(Number(a.searchObservedPrice) - Number(a.lastVerifiedPrice)) >= 0.01;
    const bMismatch =
      Number.isFinite(Number(b.searchObservedPrice)) &&
      Number.isFinite(Number(b.lastVerifiedPrice)) &&
      Math.abs(Number(b.searchObservedPrice) - Number(b.lastVerifiedPrice)) >= 0.01;

    if (aMismatch !== bMismatch) return aMismatch ? -1 : 1;
    if (!a.priceVerifiedAt && b.priceVerifiedAt) return -1;
    if (a.priceVerifiedAt && !b.priceVerifiedAt) return 1;

    const at = a.priceVerifiedAt ? Date.parse(a.priceVerifiedAt) : 0;
    const bt = b.priceVerifiedAt ? Date.parse(b.priceVerifiedAt) : 0;
    return at - bt || Date.parse(a.lastSeen || 0) - Date.parse(b.lastSeen || 0);
  };

  const active = data.offers.filter(offer =>
    String(offer.provider).toLowerCase() === "ebay" &&
    offer.availability !== "out_of_stock" &&
    String(offer.competitorIdentityStatus || "") !== "pending"
  );

  const publicOffers = active
    .filter(offer => approved.has(offer.productId))
    .sort(sorter);

  const draftOffers = active
    .filter(offer => !approved.has(offer.productId))
    .sort(sorter);

  // Reserve at least 25% of each pass for draft verification so new products
  // can eventually satisfy auto-publish thresholds instead of starving behind
  // an established public catalog.
  const draftTarget =
    draftOffers.length
      ? Math.max(1, Math.floor(cap * 0.25))
      : 0;
  const publicTarget = Math.max(0, cap - draftTarget);

  const selected = [
    ...publicOffers.slice(0, publicTarget),
    ...draftOffers.slice(0, draftTarget),
  ];

  if (selected.length < cap) {
    const used = new Set(selected.map(offer => offer.id));
    const overflow = [...publicOffers, ...draftOffers]
      .filter(offer => !used.has(offer.id))
      .slice(0, cap - selected.length);
    selected.push(...overflow);
  }

  return selected.map(offer => ({ ...offer }));
}

function applyEbayOfferVerificationInDb(
  data,
  offerId,
  detail,
  touchedProducts,
  lookup = null
) {
  const numericOfferId = Number(offerId);
  const offer = lookup?.offerByNumericId
    ? lookup.offerByNumericId.get(numericOfferId)
    : data.offers.find(o => o.id === numericOfferId);
  if (!offer || String(offer.provider).toLowerCase() !== "ebay") {
    return null;
  }

  const product = lookup?.productByNumericId
    ? lookup.productByNumericId.get(Number(offer.productId))
    : data.products.find(p => p.id === offer.productId);
  const now = nowIso();

  if (detail?.missing) {
    offer.availability = "out_of_stock";
    offer.priceVerifiedAt = detail.priceVerifiedAt || now;
    offer.priceVerificationStatus = "missing";
    offer.priceSource = "ebay-item-detail";
    offer.score = 0;

    if (product) {
      product.updatedAt = now;
      // A 404/missing response proves the old listing is dead; it is not a
      // positive price observation and therefore does not reset lifecycle age.
    }

    touchedProducts.add(offer.productId);

    return {
      offerId: offer.id,
      productId: offer.productId,
      missing: true,
      changed: false,
      oldPrice: Number(offer.price),
      newPrice: Number(offer.price),
    };
  }

  const oldPrice = Number(offer.price);
  const verifiedPrice = Number(detail.price);
  const discrepancy =
    Number.isFinite(oldPrice) && Number.isFinite(verifiedPrice)
      ? Math.round((verifiedPrice - oldPrice) * 100) / 100
      : 0;

  if (Math.abs(discrepancy) >= 0.01) {
    offer.priceDiscrepancyCount =
      Number(offer.priceDiscrepancyCount || 0) + 1;
    offer.lastPriceDiscrepancy = discrepancy;
  } else {
    offer.lastPriceDiscrepancy = 0;
  }

  Object.assign(offer, {
    price:
      Number.isFinite(verifiedPrice)
        ? verifiedPrice
        : offer.price,
    originalPrice:
      detail.originalPrice == null
        ? null
        : Number(detail.originalPrice),
    shippingPrice:
      detail.shippingPrice == null
        ? null
        : Number(detail.shippingPrice),
    currency: String(detail.currency || offer.currency || "USD"),
    affiliateUrl: safeHttpUrl(detail.affiliateUrl, 4000) || safeHttpUrl(offer.affiliateUrl, 4000),
    sourceUrl: safeHttpUrl(detail.sourceUrl, 1600) || safeHttpUrl(offer.sourceUrl, 1600),
    imageUrl: safeHttpUrl(detail.imageUrl, 1200) || safeHttpUrl(offer.imageUrl, 1200),
    listingTitle:
      String(detail.listingTitle || detail.title || offer.listingTitle || ""),
    merchant: String(detail.merchant || offer.merchant || "eBay seller"),
    brand: String(detail.brand || offer.brand || ""),
    gtin: String(detail.gtin || offer.gtin || ""),
    mpn: String(detail.mpn || offer.mpn || ""),
    epid: String(detail.epid || offer.epid || ""),
    condition: String(detail.condition || offer.condition || ""),
    conditionGroup:
      String(detail.conditionGroup || offer.conditionGroup || "unknown"),
    availability: String(detail.availability || "in_stock"),
    estimatedAvailableQuantity:
      detail.estimatedAvailableQuantity == null
        ? null
        : Number(detail.estimatedAvailableQuantity),
    availabilityThreshold:
      detail.availabilityThreshold == null
        ? null
        : Number(detail.availabilityThreshold),
    availabilityThresholdType:
      String(detail.availabilityThresholdType || ""),
    lotSize:
      detail.lotSize == null
        ? null
        : Number(detail.lotSize),
    quantityLimitPerBuyer:
      detail.quantityLimitPerBuyer == null
        ? null
        : Number(detail.quantityLimitPerBuyer),
    unitPrice:
      detail.unitPrice == null
        ? null
        : Number(detail.unitPrice),
    unitPriceCurrency: String(detail.unitPriceCurrency || ""),
    unitPricingMeasure: String(detail.unitPricingMeasure || ""),
    primaryItemGroupId: String(detail.primaryItemGroupId || ""),
    primaryItemGroupType: String(detail.primaryItemGroupType || ""),
    itemEndDate: String(detail.itemEndDate || ""),
    priceTreatment: String(detail.priceTreatment || ""),
    priceDisplayCondition: String(detail.priceDisplayCondition || ""),
    priceDisplayRestricted: Boolean(detail.priceDisplayRestricted),
    coupons: Array.isArray(detail.coupons)
      ? detail.coupons.slice(0, 8)
      : [],
    priceVerifiedAt: detail.priceVerifiedAt || now,
    lastVerifiedPrice:
      Number.isFinite(verifiedPrice)
        ? verifiedPrice
        : offer.lastVerifiedPrice,
    priceSource: "ebay-item-detail",
    priceVerificationStatus: "verified",
    lastSeen: now,
  });

  if (product && String(offer.matchSource || "").startsWith("ebay-competitor:")) {
    const classification = classifyStoredCompetitorOffer(product, offer);
    if (!classification.keep) {
      offer.availability = "out_of_stock";
      offer.score = 0;
      offer.priceVerificationStatus = "identity_mismatch";
      offer.matchIntegrityError = String(classification.reason || "identity-mismatch").slice(0, 500);
      touchedProducts.add(offer.productId);

      return {
        offerId: offer.id,
        productId: offer.productId,
        missing: false,
        identityMismatch: true,
        changed: false,
        discrepancy,
        oldPrice,
        newPrice: Number.isFinite(verifiedPrice) ? verifiedPrice : oldPrice,
      };
    }
  }

  if (product && lookup?.primaryEbayOfferByNumericProductId) {
    lookup.primaryEbayOfferByNumericProductId.delete(Number(product.id));
  }
  let postVerificationTrust = product
    ? ebayOfferTrust(data, product, offer, { lookup })
    : { trusted: false, role: "orphan", proofType: "", reason: "missing-product" };

  if (
    product &&
    isEbayOffer(offer) &&
    postVerificationTrust.role === "secondary" &&
    !String(offer.matchSource || "").startsWith("ebay-competitor:")
  ) {
    if (postVerificationTrust.trusted) {
      offer.competitorIdentityStatus = "verified";
      offer.competitorIdentityVerifiedAt ||= offer.priceVerifiedAt || now;
      offer.competitorIdentityLastReason = postVerificationTrust.reason;
      offer.matchProofVersion = 4;
      offer.matchProofType = postVerificationTrust.proofType || "";
      offer.verificationVersion = Math.max(4, Number(offer.verificationVersion || 0));
      offer.matchSource = `ebay-secondary:v4-exact-${postVerificationTrust.proofType || "identity"}`;
      offer.matchReferenceTitle = String(product.title || "").slice(0, 500);
      offer.matchReferenceBrand = String(product.brand || "").slice(0, 200);
      offer.matchReferenceGtin = String(product.gtin || "").slice(0, 100);
      offer.matchReferenceMpn = String(product.mpn || "").slice(0, 160);
      offer.matchReferenceEpid = String(product.epid || "").slice(0, 100);
    } else {
      // Keep the listing itself intact so cleanup can isolate it as its own
      // product, but never let an unprovable secondary listing enrich or
      // influence the current product while it is still grouped here.
      offer.competitorIdentityStatus = "rejected";
      offer.competitorIdentityLastReason = String(
        postVerificationTrust.reason || "unprovable-secondary"
      ).slice(0, 500);
      offer.score = 0;
    }

    lookup?.primaryEbayOfferByNumericProductId?.delete(Number(product.id));
    postVerificationTrust = ebayOfferTrust(data, product, offer, { lookup });
  }

  const mayEnrichProduct =
    product &&
    (
      !isEbayOffer(offer) ||
      postVerificationTrust.role === "source"
    );

  if (mayEnrichProduct) {
    if (
      offer.listingTitle &&
      safeSameVariant(product.title, offer.listingTitle, {
        brandA: product.brand || "",
        brandB: offer.brand || "",
      })
    ) {
      if (
        !product.title ||
        product.title.length > offer.listingTitle.length + 80
      ) {
        product.title = offer.listingTitle.slice(0, 500);
      }
    }

    if (!product.imageUrl && offer.imageUrl) {
      product.imageUrl = offer.imageUrl;
    }
    // V3.7.33: exact-verification enrichment must use the same trusted
    // identity storage boundary as every other ingestion path. A verified
    // price/detail response can still contain marketplace placeholders or
    // descriptive item-specific values; keep those only as rejected audit
    // evidence instead of reintroducing them into product identity fields.
    sanitizeStoredProductIdentifiers(product);
    applyTrustedProductIdentity(product, {
      brand: offer.brand || "",
      gtin: offer.gtin || "",
      mpn: offer.mpn || "",
      epid: offer.epid || "",
    }, {
      fillOnly: true,
      source: "ebay-exact-verification",
    });

    product.updatedAt = now;
  }

  if (product && lookup?.primaryEbayOfferByNumericProductId) {
    // Product identity can be enriched above; invalidate the memoized primary
    // so trust is resolved against the same post-update state as V3.7.13.
    lookup.primaryEbayOfferByNumericProductId.delete(Number(product.id));
  }
  const offerUsableForProduct =
    product &&
    (
      !isEbayOffer(offer) ||
      ebayOfferTrust(data, product, offer, { lookup }).trusted
    );

  if (offerUsableForProduct && offer.availability !== "out_of_stock") {
    reactivateProductInDb(data, product, now);
    product.lifecycleLastActiveAt = maxIso(
      product.lifecycleLastActiveAt,
      offer.priceVerifiedAt,
      now
    );
    product.lifecycleLastObservationAt = maxIso(
      product.lifecycleLastObservationAt,
      offer.priceVerifiedAt,
      now
    );
  }

  touchedProducts.add(offer.productId);

  return {
    offerId: offer.id,
    productId: offer.productId,
    missing: false,
    changed: Math.abs(discrepancy) >= 0.01,
    discrepancy,
    oldPrice,
    newPrice:
      Number.isFinite(verifiedPrice)
        ? verifiedPrice
        : oldPrice,
  };
}

export function applyEbayOfferVerifications(verifications = [], { deferPersistence = false } = {}) {
  const data = readDb();
  const touchedProducts = new Set();
  const results = [];
  const requestedOfferIds = new Set(
    (Array.isArray(verifications) ? verifications : [])
      .map(entry => Number(entry?.offerId))
      .filter(Number.isFinite)
  );
  const verificationProductIds = new Set();
  for (const offer of data.offers || []) {
    if (requestedOfferIds.has(Number(offer.id))) {
      const productId = Number(offer.productId);
      if (Number.isFinite(productId)) verificationProductIds.add(productId);
    }
  }
  // Exact-detail application changes only the products attached to the requested
  // offers. Keep one linear discovery pass, then allocate relationship buckets
  // only for that touched set instead of the complete catalog.
  const verificationLookup = buildPageHydrationLookup(
    data,
    [...verificationProductIds],
    { approvedOnly: false, includeClicks: false }
  );

  for (const entry of verifications) {
    const result = applyEbayOfferVerificationInDb(
      data,
      entry.offerId,
      entry.detail,
      touchedProducts,
      verificationLookup
    );
    if (result) results.push(result);
  }

  const touchedProductIds = [...touchedProducts]
    .map(Number)
    .filter(Number.isFinite);

  if (touchedProductIds.length) {
    rescoreProductIdsInDb(data, touchedProductIds, verificationLookup);

    // Exact eBay detail can promote a draft from "candidate" to a safe public
    // product. Review only the products touched by this verification batch;
    // the publication decision stays fail-closed and never weakens eBay trust.
    const verificationReviewIndex = buildDraftAutoReviewIndex(data);
    autoApproveConfidentDrafts({
      productIds: touchedProductIds,
      limit: touchedProductIds.length,
      reason: "ebay-exact-verification",
      deferPersistence: true,
      lookup: verificationLookup,
      reviewIndex: verificationReviewIndex,
    });

    const changedProductIds = new Set(
      results
        .filter(result => result.changed)
        .map(result => Number(result.productId))
        .filter(Number.isFinite)
    );
    // V3.7.46: exact-detail application does not add/remove offer rows. The
    // reusable lookup built at the start of this batch points at the same live
    // product/offer objects and applyEbayOfferVerificationInDb invalidates its
    // primary-offer memo when identity changes. Reuse it instead of scanning
    // the entire product/offer catalog a second time on every source-proof burst.
    queueRuntimeProductMutation(data, touchedProductIds, {
      forceHistoryProductIds: changedProductIds,
      reason: deferPersistence ? "scheduled-ebay-verification" : "ebay-verification",
      lookup: verificationLookup,
    });
  }

  if (results.length) {
    publishProductLiveMutation(data, {
      type: "price",
      reason: "exact-prices-verified",
      productIds: [...touchedProducts],
      metadata: {
        updated: results.length,
        missing: results.filter(result => result.missing).length,
        changed: results.filter(result => result.changed).length,
      },
    });
  }

  return {
    updated: results.length,
    missing: results.filter(result => result.missing).length,
    changed: results.filter(result => result.changed).length,
    touchedProductIds: [...touchedProducts],
    results,
  };
}

export function applyEbayOfferVerification(offerId, detail) {
  const batch = applyEbayOfferVerifications([
    { offerId, detail },
  ]);

  if (!batch.updated) return null;

  const result = batch.results[0];
  return result
    ? getProduct(result.productId, true) || getProduct(result.productId, false)
    : null;
}

function catalogIntegrityBackupPath() {
  return path.join(DATA_DIR, "catalog.pre-v313-verifier-identity-hardening.json");
}

function dedupeExactOffersInDb(data) {
  const byExternal = new Map();
  const duplicateIds = new Set();
  const remap = new Map();
  const touchedProductIds = new Set();

  const rankOffer = offer => {
    const verified = offer.priceVerifiedAt ? 1 : 0;
    const timestamp =
      Date.parse(offer.priceVerifiedAt || offer.lastSeen || 0) || 0;
    return verified * 10_000_000_000_000 + timestamp;
  };

  for (const offer of data.offers) {
    const key =
      `${String(offer.provider).toLowerCase()}:${String(offer.externalId)}`;
    const existing = byExternal.get(key);

    if (!existing) {
      byExternal.set(key, offer);
      continue;
    }

    const keep = rankOffer(offer) > rankOffer(existing) ? offer : existing;
    const drop = keep === offer ? existing : offer;

    byExternal.set(key, keep);
    duplicateIds.add(drop.id);
    remap.set(drop.id, { offerId: keep.id, productId: keep.productId });
    touchedProductIds.add(Number(drop.productId));
    touchedProductIds.add(Number(keep.productId));
  }

  if (!duplicateIds.size) return { removed: 0, touchedProductIds: [] };

  data.offers = data.offers.filter(offer => !duplicateIds.has(offer.id));

  for (const history of data.priceHistory) {
    const target = remap.get(Number(history.offerId));
    if (target) {
      history.offerId = target.offerId;
      history.productId = target.productId;
    }
  }
  for (const click of data.clicks) {
    const target = remap.get(Number(click.offerId));
    if (target) {
      click.offerId = target.offerId;
      click.productId = target.productId;
    }
  }

  const seenHistory = new Set();
  data.priceHistory = data.priceHistory.filter(item => {
    const key = `${item.productId}:${item.offerId}:${item.price}:${item.at}`;
    if (seenHistory.has(key)) return false;
    seenHistory.add(key);
    return true;
  });

  return { removed: duplicateIds.size, touchedProductIds: [...touchedProductIds] };
}

function emitCompetitorCleanupProgress(onProgress, event = {}) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress({
      at: nowIso(),
      ...event,
    });
  } catch {
    // Progress reporting is observability only. It must never interrupt cleanup.
  }
}

function splitUnsafeGroupedEbayOffers(data, {
  onProgress = null,
  deferIntelligenceRebuild = false,
} = {}) {
  let splitOffers = 0;
  let trustedSecondaries = 0;
  let primaryAssignments = 0;
  const newProducts = [];
  const contaminatedAggregateProductIds = new Set();
  const touchedProductIds = new Set();
  const relationshipProductRemapByOfferId = new Map();
  const splitReasons = {};
  const at = nowIso();
  const productsToCheck = [...data.products];
  const totalProducts = productsToCheck.length;
  let productsChecked = 0;

  // Build this lookup once. V3.7.6 filtered the entire offer array for every
  // product, which preserved correctness but made large startup migrations
  // unnecessarily expensive. The index keeps identical trust semantics while
  // reducing the relationship scan to roughly O(products + offers).
  const broadEbayOffersByProduct = new Map();
  for (const offer of data.offers) {
    if (
      !isEbayOffer(offer) ||
      String(offer.matchSource || "").startsWith("ebay-competitor:")
    ) {
      continue;
    }
    const productId = Number(offer.productId);
    if (!broadEbayOffersByProduct.has(productId)) {
      broadEbayOffersByProduct.set(productId, []);
    }
    broadEbayOffersByProduct.get(productId).push(offer);
  }
  for (const offers of broadEbayOffersByProduct.values()) {
    offers.sort((a, b) => Number(a.id) - Number(b.id));
  }

  // Reuse product/offer lookup state while resolving primaries and secondary
  // trust. Offer objects are shared with data.offers, so field updates remain
  // visible; newly isolated products are intentionally not part of this pass.
  const trustLookup = buildOfferLookupIndex(data);

  emitCompetitorCleanupProgress(onProgress, {
    phase: "broad-trust-scan",
    state: "start",
    current: 0,
    total: totalProducts,
    unit: "products",
    message: "checking legacy/broad eBay relationships",
  });

  for (const product of productsToCheck) {
    const ebayOffers = broadEbayOffersByProduct.get(Number(product.id)) || [];

    if (!ebayOffers.length) {
      productsChecked++;
      emitCompetitorCleanupProgress(onProgress, {
        phase: "broad-trust-scan",
        state: "progress",
        current: productsChecked,
        total: totalProducts,
        unit: "products",
        splitOffers,
        trustedSecondaries,
        primaryAssignments,
      });
      continue;
    }

    const primary = primaryEbayOfferFor(data, product, trustLookup);
    if (primary && Number(product.primaryEbayOfferId) !== Number(primary.id)) {
      product.primaryEbayOfferId = Number(primary.id);
      primaryAssignments++;
    }

    for (const offer of ebayOffers) {
      if (primary && Number(offer.id) === Number(primary.id)) {
        offer.competitorIdentityStatus = "";
        offer.competitorIdentityQueuedAt = null;
        offer.competitorIdentityLastReason = "canonical-source-listing";
        if (String(offer.matchSource || "").startsWith("ebay-secondary:")) {
          offer.matchSource = "ebay-source:v376-primary";
        }
        continue;
      }

      const trust = ebayOfferTrust(data, product, offer, {
        allowPrimary: false,
        lookup: trustLookup,
      });
      if (trust.trusted) {
        offer.competitorIdentityStatus = "verified";
        offer.competitorIdentityVerifiedAt ||= offer.priceVerifiedAt || at;
        offer.competitorIdentityLastReason = trust.reason;
        offer.matchProofVersion = 4;
        offer.matchProofType = trust.proofType || offer.matchProofType || "";
        offer.verificationVersion = Math.max(4, Number(offer.verificationVersion || 0));
        offer.matchSource = `ebay-secondary:v4-exact-${trust.proofType || "identity"}`;
        offer.matchReferenceTitle = String(product.title || "").slice(0, 500);
        offer.matchReferenceBrand = String(product.brand || "").slice(0, 200);
        offer.matchReferenceGtin = String(product.gtin || "").slice(0, 100);
        offer.matchReferenceMpn = String(product.mpn || "").slice(0, 160);
        offer.matchReferenceEpid = String(product.epid || "").slice(0, 100);
        trustedSecondaries++;
        continue;
      }

      const title = offer.listingTitle || product.title || "eBay listing";
      const newProductId = data.meta.nextProductId++;
      const newProduct = {
        ...product,
        id: newProductId,
        // Keep an isolated relationship on a listing-specific key until that
        // listing's exact item detail has independently established a strong
        // identifier. This prevents the integrity merge pass from immediately
        // undoing a safety split based on search-result metadata alone.
        canonicalKey: candidateCanonicalKey({
          provider: offer.provider,
          externalId: offer.externalId,
        }),
        title: String(title).slice(0, 500),
        brand: String(offer.brand || "").slice(0, 200),
        gtin: String(offer.gtin || "").slice(0, 100),
        mpn: String(offer.mpn || "").slice(0, 160),
        epid: String(offer.epid || "").slice(0, 100),
        imageUrl: offer.imageUrl || "",
        primaryEbayOfferId: Number(offer.id),
        ebayTrustPolicyVersion: 376,
        ebayTrustLastCleanedAt: at,
        ebayCompetitorScanAt: null,
        ebayCompetitorScanMethod: "",
        ebayCompetitorScanConfidence: 0,
        ebayCompetitorScanMatched: 0,
        ebayCompetitorScanError: "",
        integrityBucket: coarseVariantBucket(title, offer.brand || ""),
        approved: false,
        cachedBestOfferId: null,
        cachedBestPrice: null,
        cachedBestScore: 0,
        cachedVerificationRank: 0,
        cachedVerifiedSellerCount: 0,
        cachedPriceStats: null,
        cachedPriceSparkline: [],
        searchText: "",
        lifecyclePriceSummary: null,
        lifecycleClickSummary: null,
        lifecycleTombstone: null,
        lifecycleNormalizedTitle: normalizeLifecycleIdentityText(title),
        lifecycleNormalizedBrand: normalizeLifecycleIdentityText(offer.brand || ""),
        lifecycleIdentityKey: lifecycleIdentityKey({
          title,
          brand: offer.brand || "",
          gtin: offer.gtin || "",
          mpn: offer.mpn || "",
        }),
        createdAt: at,
        updatedAt: at,
      };

      offer.productId = newProductId;
      offer.matchSource = "ebay-source:v376-isolated";
      offer.competitorIdentityStatus = "";
      offer.competitorIdentityQueuedAt = null;
      offer.competitorIdentityLastAttemptAt = null;
      offer.competitorIdentityVerifiedAt = null;
      offer.competitorIdentityLastReason = `isolated:${trust.reason || "unprovable-secondary"}`;
      offer.competitorSanitizerAttempts = 0;
      offer.competitorPreQuarantineAvailability = "";
      offer.matchProofVersion = 0;
      offer.matchProofType = "";
      offer.matchReferenceTitle = "";
      offer.matchReferenceBrand = "";
      offer.matchReferenceGtin = "";
      offer.matchReferenceMpn = "";
      offer.matchReferenceEpid = "";

      // V3.7.13: defer dependent history/click relationship remaps until the
      // complete trust scan finishes, then apply all of them in one pass.
      // This preserves the exact isolated product assignment without scanning
      // the full history/click tables once per split eBay offer.
      relationshipProductRemapByOfferId.set(Number(offer.id), newProductId);

      newProducts.push(newProduct);
      contaminatedAggregateProductIds.add(Number(product.id));
      touchedProductIds.add(Number(product.id));
      touchedProductIds.add(Number(newProductId));
      const reason = trust.reason || "unprovable-secondary";
      splitReasons[reason] = Number(splitReasons[reason] || 0) + 1;
      splitOffers++;
    }

    product.ebayTrustPolicyVersion = 376;
    product.ebayTrustLastCleanedAt = at;

    productsChecked++;
    emitCompetitorCleanupProgress(onProgress, {
      phase: "broad-trust-scan",
      state: "progress",
      current: productsChecked,
      total: totalProducts,
      unit: "products",
      splitOffers,
      trustedSecondaries,
      primaryAssignments,
    });
  }

  emitCompetitorCleanupProgress(onProgress, {
    phase: "broad-trust-scan",
    state: "done",
    current: totalProducts,
    total: totalProducts,
    unit: "products",
    splitOffers,
    trustedSecondaries,
    primaryAssignments,
  });

  if (relationshipProductRemapByOfferId.size) {
    for (const history of data.priceHistory) {
      const newProductId = relationshipProductRemapByOfferId.get(Number(history.offerId));
      if (newProductId != null) history.productId = newProductId;
    }
    for (const click of data.clicks) {
      const newProductId = relationshipProductRemapByOfferId.get(Number(click.offerId));
      if (newProductId != null) click.productId = newProductId;
    }
  }

  if (contaminatedAggregateProductIds.size) {
    data.priceAggregates = data.priceAggregates.filter(
      aggregate => !contaminatedAggregateProductIds.has(Number(aggregate.productId))
    );
  }

  if (newProducts.length) data.products.push(...newProducts);

  const broadTouchedIds = [...touchedProductIds];
  emitCompetitorCleanupProgress(onProgress, {
    phase: "broad-trust-rebuild",
    state: "start",
    current: 0,
    total: broadTouchedIds.length,
    unit: "products",
    message: deferIntelligenceRebuild
      ? "isolated relationships will be rebuilt by the final bulk integrity cache pass"
      : "rebuilding intelligence for isolated relationships",
  });
  if (!deferIntelligenceRebuild && broadTouchedIds.length) {
    rescoreProductIdsInDb(data, broadTouchedIds);
    const broadLookup = buildOfferLookupIndex(data);
    refreshProductFastCachesForIdsInDb(data, broadTouchedIds, { lookup: broadLookup });
    markProductsIntelligenceDirtyInDb(data, broadTouchedIds, "broad-trust-rebuild");
    enqueueIntelligenceProducts(broadTouchedIds, { priority: "background", reason: "broad-trust-rebuild" });
    emitCompetitorCleanupProgress(onProgress, {
      phase: "broad-trust-rebuild",
      state: "progress",
      current: broadTouchedIds.length,
      total: broadTouchedIds.length,
      unit: "products",
    });
  }
  emitCompetitorCleanupProgress(onProgress, {
    phase: "broad-trust-rebuild",
    state: "done",
    current: broadTouchedIds.length,
    total: broadTouchedIds.length,
    unit: "products",
    message: deferIntelligenceRebuild
      ? "deferred safely to final bulk integrity rebuild"
      : "isolated relationship intelligence rebuilt",
  });

  return {
    splitOffers,
    newProducts: newProducts.length,
    trustedSecondaries,
    primaryAssignments,
    contaminatedProducts: contaminatedAggregateProductIds.size,
    splitReasons,
    touchedProductIds: [...touchedProductIds],
  };
}


function normalizationListingKeyForOffer(offer, fallbackId = "") {
  return candidateCanonicalKey({
    provider: offer?.provider || "product",
    externalId: offer?.externalId || fallbackId,
    title: offer?.listingTitle || "",
  });
}

function canonicalOwnershipOfferFor(data, product, productOffers = [], lookup = null) {
  const currentKey = String(product?.canonicalKey || "");
  if (currentKey.startsWith("listing:")) {
    const currentOwner = productOffers.find(offer =>
      normalizationListingKeyForOffer(offer, product?.id) === currentKey
    );
    if (currentOwner) return currentOwner;
  }

  // eBay competitors are observations attached to an existing product, not
  // canonical product owners. Prefer the persisted/resolved eBay source
  // listing and never promote an ebay-competitor/ebay-secondary row merely
  // because it happens to have newer verification metadata.
  const primaryEbay = primaryEbayOfferFor(data, product, lookup);
  if (primaryEbay) return primaryEbay;

  const sourceLike = productOffers
    .filter(offer => !isEbaySecondarySource(offer))
    .sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0));
  return sourceLike[0] || null;
}

function normalizedIdentityFromOffer(offer = {}, owner = {}) {
  const identity = sanitizeIdentityForStorage({
    brand: offer.brand || owner.brand || "",
    gtin: offer.gtin || "",
    mpn: offer.mpn || "",
    epid: offer.epid || "",
  });
  return {
    title: boundedText(offer.listingTitle || owner.title || "Product", 500),
    brand: identity.brand,
    gtin: identity.gtin,
    mpn: identity.mpn,
    epid: identity.epid,
    imageUrl: safeHttpUrl(offer.imageUrl || owner.imageUrl || "", 1200),
  };
}

function sanitizeStoredProductIdentifiers(product) {
  if (!product) return false;
  const before = {
    brand: String(product.brand || ""),
    gtin: String(product.gtin || ""),
    mpn: String(product.mpn || ""),
    epid: String(product.epid || ""),
  };
  const cleaned = sanitizeIdentityForStorage(before);
  let changed = noteRejectedProductIdentity(product, cleaned.rejected, "stored-product-sanitize");

  for (const field of ["brand", "gtin", "mpn", "epid"]) {
    if (String(product[field] || "") !== String(cleaned[field] || "")) {
      product[field] = cleaned[field] || "";
      changed = true;
    }
  }

  if (changed) {
    product.normalizationLastRepairedAt = nowIso();
    product.normalizationStatus = "repaired-local-identity";
  }
  return changed;
}

function invalidStrongCanonicalReason(product) {
  const key = String(product?.canonicalKey || "");
  if (key.startsWith("gtin:") && !canonicalStrongGtin(product?.gtin)) {
    return "invalid-gtin-canonical-owner";
  }
  if (
    key.startsWith("mpn:") &&
    (!canonicalStrongBrand(product?.brand) || !canonicalStrongMpn(product?.mpn))
  ) {
    return "invalid-brand-mpn-canonical-owner";
  }
  return "";
}

function resetSplitProductCaches(product, { preserveLifecycleClicks = false } = {}) {
  product.primaryEbayOfferId = null;
  product.ebayIdentityCheckedAt = null;
  product.ebayCompetitorScanAt = null;
  product.ebayCompetitorScanMethod = "";
  product.ebayCompetitorScanConfidence = 0;
  product.ebayCompetitorScanMatched = 0;
  product.ebayCompetitorScanError = "";
  product.ebayTrustPolicyVersion = 0;
  product.ebayTrustLastCleanedAt = null;
  product.cachedBestOfferId = null;
  product.cachedBestPrice = null;
  product.cachedBestScore = 0;
  product.cachedVerificationRank = 0;
  product.cachedPriceStats = null;
  product.cachedPriceSparkline = [];
  product.searchText = "";
  product.lifecyclePriceSummary = null;
  if (!preserveLifecycleClicks) product.lifecycleClickSummary = null;
  product.lifecycleTombstone = null;
}

function applyRepresentativeIdentity(product, offer) {
  const identity = normalizedIdentityFromOffer(offer, product);
  product.title = identity.title;
  product.brand = identity.brand;
  product.gtin = identity.gtin;
  product.mpn = identity.mpn;
  product.epid = identity.epid;
  product.imageUrl = identity.imageUrl;
  product.integrityBucket = coarseVariantBucket(identity.title, identity.brand);
  product.lifecycleNormalizedTitle = normalizeLifecycleIdentityText(identity.title);
  product.lifecycleNormalizedBrand = normalizeLifecycleIdentityText(identity.brand);
  product.lifecycleIdentityKey = lifecycleIdentityKey(product);
}

function splitInvalidStrongCanonicalProducts(data) {
  const offersByProduct = new Map();
  for (const offer of data.offers) {
    const id = Number(offer.productId);
    if (!offersByProduct.has(id)) offersByProduct.set(id, []);
    offersByProduct.get(id).push(offer);
  }

  const at = nowIso();
  const newProducts = [];
  const remapByOfferId = new Map();
  const contaminatedProductIds = new Set();
  let productsRepaired = 0;
  let offersRehomed = 0;
  let invalidGtinsCleared = 0;
  let invalidMpnsCleared = 0;

  for (const owner of [...data.products]) {
    const reason = invalidStrongCanonicalReason(owner);
    if (!reason) continue;

    const originalGtin = String(owner.gtin || "");
    const originalMpn = String(owner.mpn || "");
    const offers = (offersByProduct.get(Number(owner.id)) || [])
      .slice()
      .sort((a, b) => Number(a.id) - Number(b.id));

    if (originalGtin && !canonicalStrongGtin(originalGtin)) invalidGtinsCleared++;
    if (originalMpn && !canonicalStrongMpn(originalMpn)) invalidMpnsCleared++;

    const groups = new Map();
    for (const offer of offers) {
      const desired = candidateCanonicalKey({
        provider: offer.provider,
        externalId: offer.externalId,
        title: offer.listingTitle || owner.title,
        brand: offer.brand,
        gtin: offer.gtin,
        mpn: offer.mpn,
      });
      if (!groups.has(desired)) groups.set(desired, []);
      groups.get(desired).push(offer);
    }

    if (!offers.length) {
      sanitizeStoredProductIdentifiers(owner);
      owner.canonicalKey = candidateCanonicalKey({
        provider: "product",
        externalId: owner.id,
        title: owner.title,
        brand: owner.brand,
        gtin: owner.gtin,
        mpn: owner.mpn,
      });
      owner.normalizationStatus = "repaired-invalid-canonical-no-offers";
      owner.normalizationLastReason = reason;
      owner.normalizationLastRepairedAt = at;
      productsRepaired++;
      contaminatedProductIds.add(Number(owner.id));
      continue;
    }

    const primaryOfferId = Number(owner.primaryEbayOfferId || 0);
    const rankedGroups = [...groups.entries()].map(([key, groupOffers]) => {
      const representative = groupOffers[0];
      let score = groupOffers.length;
      if (primaryOfferId && groupOffers.some(offer => Number(offer.id) === primaryOfferId)) score += 10_000;
      const candidateTitle = representative?.listingTitle || "";
      if (
        candidateTitle &&
        (normalizeLifecycleIdentityText(candidateTitle) === normalizeLifecycleIdentityText(owner.title) ||
          safeSameVariant(owner.title, candidateTitle, {
            brandA: owner.brand || "",
            brandB: representative?.brand || owner.brand || "",
          }))
      ) score += 1_000;
      return { key, groupOffers, representative, score };
    }).sort((a, b) => b.score - a.score || Number(a.representative?.id || 0) - Number(b.representative?.id || 0));

    const retained = rankedGroups[0];
    const originalApproved = Boolean(owner.approved);
    applyRepresentativeIdentity(owner, retained.representative);
    owner.canonicalKey = retained.key;
    owner.normalizationStatus = "repaired-contaminated-owner";
    owner.normalizationLastReason = reason;
    owner.normalizationLastRepairedAt = at;
    owner.approved = originalApproved;
    resetSplitProductCaches(owner, { preserveLifecycleClicks: true });
    owner.approved = originalApproved;
    if (String(retained.representative?.provider || "").toLowerCase() === "ebay") {
      owner.primaryEbayOfferId = Number(retained.representative.id);
    }
    productsRepaired++;
    contaminatedProductIds.add(Number(owner.id));

    for (const group of rankedGroups.slice(1)) {
      const representative = group.representative;
      const newProduct = {
        ...owner,
        id: data.meta.nextProductId++,
        canonicalKey: group.key,
        approved: false,
        lifecycleWasApproved: false,
        lifecycleState: "ACTIVE",
        normalizationStatus: "split-from-contaminated-owner",
        normalizationLastReason: reason,
        normalizationLastRepairedAt: at,
        createdAt: at,
        updatedAt: at,
      };
      resetSplitProductCaches(newProduct);
      applyRepresentativeIdentity(newProduct, representative);
      if (String(representative?.provider || "").toLowerCase() === "ebay") {
        newProduct.primaryEbayOfferId = Number(representative.id);
      }
      newProducts.push(newProduct);
      contaminatedProductIds.add(Number(newProduct.id));

      for (const offer of group.groupOffers) {
        offer.productId = Number(newProduct.id);
        remapByOfferId.set(Number(offer.id), Number(newProduct.id));
        offersRehomed++;
      }
    }

    // Ensure every retained offer points at the retained owner even if a prior
    // damaged relationship contained inconsistent product IDs in history rows.
    for (const offer of retained.groupOffers) {
      offer.productId = Number(owner.id);
      remapByOfferId.set(Number(offer.id), Number(owner.id));
    }
  }

  if (newProducts.length) data.products.push(...newProducts);

  if (remapByOfferId.size) {
    for (const history of data.priceHistory) {
      const target = remapByOfferId.get(Number(history.offerId));
      if (target != null) history.productId = target;
    }
    for (const click of data.clicks) {
      const target = remapByOfferId.get(Number(click.offerId));
      if (target != null) click.productId = target;
    }
  }

  if (contaminatedProductIds.size) {
    data.priceAggregates = data.priceAggregates.filter(
      aggregate => !contaminatedProductIds.has(Number(aggregate.productId))
    );
  }

  return {
    productsRepaired,
    newProducts: newProducts.length,
    offersRehomed,
    invalidGtinsCleared,
    invalidMpnsCleared,
    touchedProductIds: [...contaminatedProductIds],
  };
}

function splitExplicitStrongVariantOffers(data) {
  const productById = new Map(
    data.products.map(product => [Number(product.id), product])
  );
  const productByDesiredCanonical = new Map();

  for (const product of data.products) {
    const strong = strongIdentityBaseKey(product);
    if (!strong) continue;
    const desired = candidateCanonicalKey({
      gtin: product.gtin,
      brand: product.brand,
      mpn: product.mpn,
      title: product.title,
      provider: "product",
      externalId: product.id,
    });
    if (desired && !productByDesiredCanonical.has(desired)) {
      productByDesiredCanonical.set(desired, product);
    }
  }

  const at = nowIso();
  const newProducts = [];
  const remapByOfferId = new Map();
  const contaminatedProductIds = new Set();
  let splitOffers = 0;

  for (const offer of data.offers) {
    if (String(offer.provider || "").toLowerCase() === "ebay") continue;

    const owner = productById.get(Number(offer.productId));
    if (!owner) continue;

    // A startup repair must have strong identity evidence on the offer itself;
    // never infer a split from title text alone. Re-observation can still repair
    // offers whose provider later supplies the missing identity fields.
    const offerStrong = strongIdentityBaseKey({
      gtin: offer.gtin,
      brand: offer.brand,
      mpn: offer.mpn,
    });
    const ownerStrong = strongIdentityBaseKey(owner);
    if (!offerStrong || !ownerStrong || offerStrong !== ownerStrong) continue;

    const candidate = {
      provider: offer.provider,
      externalId: offer.externalId,
      title: offer.listingTitle || owner.title || "",
      listingTitle: offer.listingTitle || "",
      brand: offer.brand || owner.brand || "",
      gtin: offer.gtin || "",
      mpn: offer.mpn || "",
      epid: offer.epid || "",
    };

    if (!strongVariantOwnershipConflict(owner, candidate)) continue;

    const desiredKey = candidateCanonicalKey(candidate);
    if (!desiredKey) continue;

    let target = productByDesiredCanonical.get(desiredKey) || null;
    if (!target) {
      const title = String(candidate.title || owner.title || "Product").slice(0, 500);
      const newProductId = data.meta.nextProductId++;
      target = {
        ...owner,
        id: newProductId,
        canonicalKey: desiredKey,
        title,
        brand: String(offer.brand || owner.brand || "").slice(0, 200),
        gtin: String(offer.gtin || "").slice(0, 100),
        mpn: String(offer.mpn || "").slice(0, 160),
        epid: String(offer.epid || "").slice(0, 100),
        imageUrl: String(offer.imageUrl || owner.imageUrl || "").slice(0, 1200),
        primaryEbayOfferId: null,
        ebayIdentityCheckedAt: null,
        ebayCompetitorScanAt: null,
        ebayCompetitorScanMethod: "",
        ebayCompetitorScanConfidence: 0,
        ebayCompetitorScanMatched: 0,
        ebayCompetitorScanError: "",
        ebayTrustPolicyVersion: 0,
        ebayTrustLastCleanedAt: null,
        integrityBucket: coarseVariantBucket(title, offer.brand || owner.brand || ""),
        cachedBestOfferId: null,
        cachedBestPrice: null,
        cachedBestScore: 0,
        cachedVerificationRank: 0,
        cachedVerifiedSellerCount: 0,
        cachedPriceStats: null,
        cachedPriceSparkline: [],
        searchText: "",
        lifecyclePriceSummary: null,
        lifecycleClickSummary: null,
        lifecycleTombstone: null,
        lifecycleNormalizedTitle: normalizeLifecycleIdentityText(title),
        lifecycleNormalizedBrand: normalizeLifecycleIdentityText(offer.brand || owner.brand || ""),
        lifecycleIdentityKey: lifecycleIdentityKey({
          title,
          brand: offer.brand || owner.brand || "",
          gtin: offer.gtin || "",
          mpn: offer.mpn || "",
        }),
        createdAt: at,
        updatedAt: at,
      };
      newProducts.push(target);
      productById.set(Number(target.id), target);
      productByDesiredCanonical.set(desiredKey, target);
    }

    if (Number(target.id) === Number(owner.id)) continue;

    offer.productId = Number(target.id);
    remapByOfferId.set(Number(offer.id), Number(target.id));
    contaminatedProductIds.add(Number(owner.id));
    contaminatedProductIds.add(Number(target.id));
    splitOffers++;
  }

  if (remapByOfferId.size) {
    for (const history of data.priceHistory) {
      const targetId = remapByOfferId.get(Number(history.offerId));
      if (targetId != null) history.productId = targetId;
    }
    for (const click of data.clicks) {
      const targetId = remapByOfferId.get(Number(click.offerId));
      if (targetId != null) click.productId = targetId;
    }
  }

  if (contaminatedProductIds.size) {
    data.priceAggregates = data.priceAggregates.filter(
      aggregate => !contaminatedProductIds.has(Number(aggregate.productId))
    );
  }

  if (newProducts.length) data.products.push(...newProducts);

  return {
    splitOffers,
    newProducts: newProducts.length,
    touchedProductIds: [...contaminatedProductIds],
  };
}

function mergeDuplicateCanonicalProducts(data) {
  const groups = new Map();

  for (const product of data.products) {
    const key = String(product.canonicalKey || "");
    const strong = strongIdentityBaseKey(product);
    if (
      !key ||
      !strong ||
      key.startsWith("listing:") ||
      (!key.startsWith("gtin:") && !key.startsWith("mpn:"))
    ) {
      continue;
    }

    const desired = candidateCanonicalKey({
      gtin: product.gtin,
      brand: product.brand,
      mpn: product.mpn,
      title: product.title,
      provider: "product",
      externalId: product.id,
    });
    if (desired !== key) continue;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }

  let merged = 0;
  const removeProductIds = new Set();
  const productIdRemap = new Map();
  const touchedProductIds = new Set();

  for (const products of groups.values()) {
    if (products.length < 2) continue;

    products.sort((a, b) =>
      Number(a.lifecycleState === "ARCHIVED") -
        Number(b.lifecycleState === "ARCHIVED") ||
      Number(Boolean(b.approved)) - Number(Boolean(a.approved)) ||
      a.id - b.id
    );

    const keep = products[0];

    for (const duplicate of products.slice(1)) {
      // V3.7.13: collect relationship remaps and apply them once after all
      // duplicate groups are resolved. The legacy implementation rescanned
      // offers/history/aggregates/clicks once per duplicate product.
      productIdRemap.set(duplicate.id, keep.id);
      touchedProductIds.add(Number(keep.id));
      touchedProductIds.add(Number(duplicate.id));

      keep.approved = keep.approved || duplicate.approved;
      keep.lifecycleWasApproved =
        keep.lifecycleWasApproved ||
        duplicate.lifecycleWasApproved ||
        duplicate.approved;
      keep.lifecycleLastActiveAt = maxIso(
        keep.lifecycleLastActiveAt,
        duplicate.lifecycleLastActiveAt
      );
      keep.lifecycleLastObservationAt = maxIso(
        keep.lifecycleLastObservationAt,
        duplicate.lifecycleLastObservationAt
      );
      keep.lifecycleReactivateCount =
        Math.max(0, Number(keep.lifecycleReactivateCount || 0)) +
        Math.max(0, Number(duplicate.lifecycleReactivateCount || 0));

      if (duplicate.lifecycleClickSummary?.lifetimeClicks) {
        keep.lifecycleClickSummary ||= {
          lifetimeClicks: 0,
          firstClickAt: null,
          lastClickAt: null,
        };
        keep.lifecycleClickSummary.lifetimeClicks =
          Math.max(0, Number(keep.lifecycleClickSummary.lifetimeClicks || 0)) +
          Math.max(0, Number(duplicate.lifecycleClickSummary.lifetimeClicks || 0));
        keep.lifecycleClickSummary.firstClickAt =
          [keep.lifecycleClickSummary.firstClickAt, duplicate.lifecycleClickSummary.firstClickAt]
            .filter(Boolean)
            .sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
        keep.lifecycleClickSummary.lastClickAt = maxIso(
          keep.lifecycleClickSummary.lastClickAt,
          duplicate.lifecycleClickSummary.lastClickAt
        );
      }
      if (!keep.imageUrl && duplicate.imageUrl) keep.imageUrl = duplicate.imageUrl;
      if (!keep.brand && duplicate.brand) keep.brand = duplicate.brand;
      if (!keep.gtin && duplicate.gtin) keep.gtin = duplicate.gtin;
      if (!keep.mpn && duplicate.mpn) keep.mpn = duplicate.mpn;

      removeProductIds.add(duplicate.id);
      merged++;
    }
  }

  if (productIdRemap.size) {
    for (const offer of data.offers) {
      if (productIdRemap.has(offer.productId)) {
        offer.productId = productIdRemap.get(offer.productId);
      }
    }
    for (const history of data.priceHistory) {
      if (productIdRemap.has(history.productId)) {
        history.productId = productIdRemap.get(history.productId);
      }
    }
    for (const aggregate of data.priceAggregates) {
      if (productIdRemap.has(aggregate.productId)) {
        aggregate.productId = productIdRemap.get(aggregate.productId);
      }
    }
    for (const click of data.clicks) {
      if (productIdRemap.has(click.productId)) {
        click.productId = productIdRemap.get(click.productId);
      }
    }
  }

  if (removeProductIds.size) {
    data.products = data.products.filter(
      product => !removeProductIds.has(product.id)
    );
  }

  return { merged, touchedProductIds: [...touchedProductIds] };
}

function mergeStrongEvidenceListingDuplicates(data) {
  const groups = new Map();

  for (const product of data.products) {
    if (product.lifecycleState === "ARCHIVED") continue;
    const strong = strongIdentityBaseKey(product);
    const brand = canonicalStrongBrand(product.brand);
    const title = normalizeLifecycleIdentityText(product.title);
    if (!strong || !brand || title.length < 20) continue;

    // This is intentionally stricter than generic strong-key dedupe. It exists
    // to reunify listing-scoped rows that already carry the same validated
    // product identity but were isolated before exact-verification provenance was
    // available. No fuzzy title ownership is permitted.
    const key = `${strong}:${brand}:${title}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }

  let merged = 0;
  const removeProductIds = new Set();
  const remap = new Map();
  const touchedProductIds = new Set();

  for (const products of groups.values()) {
    if (products.length < 2) continue;

    const strongKeys = new Set(products.map(product => strongIdentityBaseKey(product)).filter(Boolean));
    const gtins = new Set(products.map(product => canonicalStrongGtin(product.gtin)).filter(Boolean));
    const mpns = new Set(products.map(product => canonicalStrongMpn(product.mpn)).filter(Boolean));
    const epids = new Set(products.map(product => canonicalStrongEpid(product.epid)).filter(Boolean));
    if (strongKeys.size !== 1 || gtins.size > 1 || mpns.size > 1 || epids.size > 1) continue;

    let incompatible = false;
    for (let i = 0; i < products.length && !incompatible; i++) {
      for (let j = i + 1; j < products.length; j++) {
        const a = products[i];
        const b = products[j];
        if (
          strongVariantOwnershipConflict(a, {
            title: b.title,
            brand: b.brand,
            gtin: b.gtin,
            mpn: b.mpn,
            epid: b.epid,
          }) ||
          strongVariantOwnershipConflict(b, {
            title: a.title,
            brand: a.brand,
            gtin: a.gtin,
            mpn: a.mpn,
            epid: a.epid,
          })
        ) {
          incompatible = true;
          break;
        }
      }
    }
    if (incompatible) continue;

    const desiredStrongKey = candidateCanonicalKey({
      gtin: products[0].gtin,
      brand: products[0].brand,
      mpn: products[0].mpn,
      title: products[0].title,
      provider: "product",
      externalId: products[0].id,
    });
    if (!desiredStrongKey || desiredStrongKey.startsWith("listing:")) continue;

    products.sort((a, b) =>
      Number(String(b.canonicalKey || "") === desiredStrongKey) -
        Number(String(a.canonicalKey || "") === desiredStrongKey) ||
      Number(Boolean(b.approved)) - Number(Boolean(a.approved)) ||
      Number(a.id) - Number(b.id)
    );

    const keep = products[0];
    keep.canonicalKey = desiredStrongKey;
    keep.normalizationStatus = "strong-evidence-duplicate-merged";
    keep.normalizationLastReason = "validated-identity-exact-brand-title";
    keep.normalizationLastRepairedAt = nowIso();

    for (const duplicate of products.slice(1)) {
      remap.set(Number(duplicate.id), Number(keep.id));
      removeProductIds.add(Number(duplicate.id));
      touchedProductIds.add(Number(keep.id));
      touchedProductIds.add(Number(duplicate.id));
      keep.approved = Boolean(keep.approved || duplicate.approved);
      keep.lifecycleWasApproved = Boolean(
        keep.lifecycleWasApproved || duplicate.lifecycleWasApproved || duplicate.approved
      );
      keep.lifecycleLastActiveAt = maxIso(keep.lifecycleLastActiveAt, duplicate.lifecycleLastActiveAt);
      keep.lifecycleLastObservationAt = maxIso(keep.lifecycleLastObservationAt, duplicate.lifecycleLastObservationAt);
      if (!keep.imageUrl && duplicate.imageUrl) keep.imageUrl = duplicate.imageUrl;
      if (!keep.epid && duplicate.epid) keep.epid = duplicate.epid;
      merged++;
    }
  }

  if (remap.size) {
    for (const offer of data.offers) if (remap.has(Number(offer.productId))) offer.productId = remap.get(Number(offer.productId));
    for (const history of data.priceHistory) if (remap.has(Number(history.productId))) history.productId = remap.get(Number(history.productId));
    for (const aggregate of data.priceAggregates) if (remap.has(Number(aggregate.productId))) aggregate.productId = remap.get(Number(aggregate.productId));
    for (const click of data.clicks) if (remap.has(Number(click.productId))) click.productId = remap.get(Number(click.productId));
  }

  if (removeProductIds.size) {
    data.products = data.products.filter(product => !removeProductIds.has(Number(product.id)));
  }

  return { merged, touchedProductIds: [...touchedProductIds] };
}

function mergeExactBrandTitleDuplicates(data) {
  const groups = new Map();
  for (const product of data.products) {
    if (strongIdentityBaseKey(product)) continue;
    if (!String(product.canonicalKey || "").startsWith("listing:")) continue;
    if (product.lifecycleState === "ARCHIVED") continue;

    const brand = canonicalStrongBrand(product.brand);
    const title = normalizeLifecycleIdentityText(product.title);
    if (!brand || title.length < 20) continue;

    // Exact normalized brand + title is intentionally the only identifier-free
    // merge rule. Fuzzy title similarity remains discovery evidence, not ownership.
    const key = `${brand}:${title}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }

  let merged = 0;
  const removeProductIds = new Set();
  const remap = new Map();
  const touchedProductIds = new Set();

  for (const products of groups.values()) {
    if (products.length < 2) continue;
    products.sort((a, b) =>
      Number(Boolean(b.approved)) - Number(Boolean(a.approved)) ||
      Number(a.id) - Number(b.id)
    );
    const keep = products[0];
    for (const duplicate of products.slice(1)) {
      remap.set(Number(duplicate.id), Number(keep.id));
      removeProductIds.add(Number(duplicate.id));
      touchedProductIds.add(Number(keep.id));
      touchedProductIds.add(Number(duplicate.id));
      keep.approved = Boolean(keep.approved || duplicate.approved);
      keep.lifecycleWasApproved = Boolean(
        keep.lifecycleWasApproved || duplicate.lifecycleWasApproved || duplicate.approved
      );
      keep.lifecycleLastActiveAt = maxIso(keep.lifecycleLastActiveAt, duplicate.lifecycleLastActiveAt);
      keep.lifecycleLastObservationAt = maxIso(keep.lifecycleLastObservationAt, duplicate.lifecycleLastObservationAt);
      if (!keep.imageUrl && duplicate.imageUrl) keep.imageUrl = duplicate.imageUrl;
      merged++;
    }
  }

  if (remap.size) {
    for (const offer of data.offers) if (remap.has(Number(offer.productId))) offer.productId = remap.get(Number(offer.productId));
    for (const history of data.priceHistory) if (remap.has(Number(history.productId))) history.productId = remap.get(Number(history.productId));
    for (const aggregate of data.priceAggregates) if (remap.has(Number(aggregate.productId))) aggregate.productId = remap.get(Number(aggregate.productId));
    for (const click of data.clicks) if (remap.has(Number(click.productId))) click.productId = remap.get(Number(click.productId));
  }
  if (removeProductIds.size) {
    data.products = data.products.filter(product => !removeProductIds.has(Number(product.id)));
  }

  return { merged, touchedProductIds: [...touchedProductIds] };
}

function repairListingCanonicalOwnershipAfterMerges(data, candidateProductIds = []) {
  const ids = new Set((candidateProductIds || []).map(Number).filter(Number.isFinite));
  if (!ids.size) return { repaired: 0, touchedProductIds: [] };

  const productsById = new Map(data.products.map(product => [Number(product.id), product]));
  const offersByProduct = new Map();
  for (const offer of data.offers) {
    const productId = Number(offer.productId);
    if (!ids.has(productId)) continue;
    if (!offersByProduct.has(productId)) offersByProduct.set(productId, []);
    offersByProduct.get(productId).push(offer);
  }
  const lookup = buildOfferLookupIndex(data);
  let repaired = 0;
  const touched = [];

  for (const id of ids) {
    const product = productsById.get(id);
    if (!product || strongIdentityBaseKey(product)) continue;
    const offers = offersByProduct.get(id) || [];
    const currentKey = String(product.canonicalKey || "");
    const currentOwned =
      currentKey.startsWith("listing:") &&
      offers.some(offer => normalizationListingKeyForOffer(offer, product.id) === currentKey);
    if (currentOwned) continue;

    const owner = canonicalOwnershipOfferFor(data, product, offers, lookup);
    const desired = owner
      ? normalizationListingKeyForOffer(owner, product.id)
      : candidateCanonicalKey({
          provider: "product",
          externalId: product.id,
          title: product.title,
        });
    if (!desired || desired === currentKey) continue;

    product.canonicalKey = desired;
    product.normalizationStatus = "locally-normalized";
    product.normalizationLastReason = "post-merge-owner-repair";
    product.normalizationLastRepairedAt = nowIso();
    repaired++;
    touched.push(id);
  }

  return { repaired, touchedProductIds: touched };
}

export function runCatalogIntegrityRepair({
  reason = "scheduled",
  makeBackup = false,
  onProgress = null,
  deferPersistence = false,
} = {}) {
  const data = readDb();
  const backupPath = catalogIntegrityBackupPath();

  if (makeBackup && !fs.existsSync(backupPath)) {
    fs.copyFileSync(DB_FILE, backupPath);
  }

  const dedupe = dedupeExactOffersInDb(data);
  const invalidIdentityRepair = splitInvalidStrongCanonicalProducts(data);
  const split = splitUnsafeGroupedEbayOffers(data, {
    onProgress,
    // The integrity cycle performs a complete accelerated cache rebuild below,
    // so rebuilding split products here would duplicate expensive work.
    deferIntelligenceRebuild: true,
  });

  // V3.7.21 startup/self-heal pass for non-eBay offers that were already
  // stored before the explicit-vs-unlabeled ownership rule existed. This is
  // strong-ID gated and only splits when the offer itself states the identity
  // plus a conflicting explicit hard package fact.
  const merchantVariantSplit = splitExplicitStrongVariantOffers(data);

  const normalizationLookup = buildOfferLookupIndex(data);
  const normalizationOffersByProduct = new Map();
  for (const offer of data.offers) {
    if (!normalizationOffersByProduct.has(offer.productId)) {
      normalizationOffersByProduct.set(offer.productId, []);
    }
    normalizationOffersByProduct.get(offer.productId).push(offer);
  }

  const normalizationStartedAt = Date.now();
  emitDbStartupProgress(onProgress, {
    phase: "catalog-integrity-normalize",
    state: "start",
    current: 0,
    total: data.products.length,
    message: "normalizing canonical identity and lifecycle keys",
  });

  let identifiersSanitized = 0;
  for (let productIndex = 0; productIndex < data.products.length; productIndex++) {
    const product = data.products[productIndex];
    if (sanitizeStoredProductIdentifiers(product)) identifiersSanitized++;
    const productOffers = normalizationOffersByProduct.get(product.id) || [];
    const primaryEbay = primaryEbayOfferFor(data, product, normalizationLookup);
    const representative = canonicalOwnershipOfferFor(
      data,
      product,
      productOffers,
      normalizationLookup
    );
    const listingScopedEbayProduct =
      String(product.canonicalKey || "").startsWith("listing:ebay:");
    const primaryExactIdentity =
      primaryEbay &&
      String(primaryEbay.priceSource || "") === "ebay-item-detail" &&
      Boolean(primaryEbay.priceVerifiedAt) &&
      exactCompetitorProof(product, primaryEbay).ok;
    const allowStrongRekey =
      !listingScopedEbayProduct || Boolean(primaryExactIdentity);

    if (product.gtin && allowStrongRekey) {
      product.canonicalKey = candidateCanonicalKey({
        gtin: product.gtin,
        title: product.title,
        provider: representative?.provider || "product",
        externalId: representative?.externalId || product.id,
      });
    } else if (product.brand && product.mpn && allowStrongRekey) {
      product.canonicalKey = candidateCanonicalKey({
        brand: product.brand,
        mpn: product.mpn,
        title: product.title,
        provider: representative?.provider || "product",
        externalId: representative?.externalId || product.id,
      });
    } else if (representative) {
      product.canonicalKey = candidateCanonicalKey({
        provider: representative.provider,
        externalId: representative.externalId,
        title: representative.listingTitle || product.title,
      });
    } else {
      // A product with no surviving offers must not keep a listing-scoped key
      // that points at a relationship that no longer exists. Preserve the row
      // as a product tombstone/local catalog identity instead.
      product.canonicalKey = candidateCanonicalKey({
        provider: "product",
        externalId: product.id,
        title: product.title,
      });
    }

    product.integrityBucket =
      coarseVariantBucket(product.title, product.brand || "");
    product.lifecycleNormalizedTitle =
      normalizeLifecycleIdentityText(product.title);
    product.lifecycleNormalizedBrand =
      normalizeLifecycleIdentityText(product.brand);
    product.lifecycleIdentityKey = lifecycleIdentityKey(product);

    emitDbStartupProgress(onProgress, {
      phase: "catalog-integrity-normalize",
      state: productIndex + 1 === data.products.length ? "done" : "progress",
      current: productIndex + 1,
      total: data.products.length,
      durationMs: Date.now() - normalizationStartedAt,
      message: "normalizing canonical identity and lifecycle keys",
    });
  }

  if (!data.products.length) {
    emitDbStartupProgress(onProgress, {
      phase: "catalog-integrity-normalize",
      state: "done",
      current: 0,
      total: 0,
      durationMs: Date.now() - normalizationStartedAt,
      message: "no product identities required normalization",
    });
  }

  const merged = mergeDuplicateCanonicalProducts(data);
  const strongEvidenceListingDuplicates = mergeStrongEvidenceListingDuplicates(data);
  const localExactDuplicates = mergeExactBrandTitleDuplicates(data);
  const postMergeOwnership = repairListingCanonicalOwnershipAfterMerges(data, [
    ...(merged.touchedProductIds || []),
    ...(strongEvidenceListingDuplicates.touchedProductIds || []),
    ...(localExactDuplicates.touchedProductIds || []),
  ]);

  // Canonical/local exact merges can make two compressed buckets share the same product
  // ID. Recompact once so long-term history remains canonical and deduplicated.
  const integrityCompression = compressPriceHistoryInDb(data, {
    force: true,
  });

  let resetHistory = 0;

  if (Number(data.meta.priceAccuracyVersion || 0) < 4) {
    const ebayOfferIds = new Set(
      data.offers
        .filter(offer =>
          String(offer.provider).toLowerCase() === "ebay"
        )
        .map(offer => offer.id)
    );

    const before = data.priceHistory.length;
    data.priceHistory = data.priceHistory.filter(
      history => !ebayOfferIds.has(history.offerId)
    );
    resetHistory = before - data.priceHistory.length;

    for (const offer of data.offers) {
      if (String(offer.provider).toLowerCase() !== "ebay") continue;
      offer.priceVerifiedAt = null;
      offer.lastVerifiedPrice = null;
      offer.priceVerificationStatus = "unverified";
      if (!offer.priceSource || offer.priceSource === "ebay-item-detail") {
        offer.priceSource = "legacy-reset";
      }
    }

    data.meta.priceAccuracyVersion = 4;
  }

  // V3.7.23: integrity may change ownership/trust for many offers. Rebuild
  // only the cheap best-offer/search materialization synchronously; historical
  // Deal Heat/MAD/sparkline work is delegated to the worker pool.
  rescoreAllProductsInDb(data, { onProgress });
  const integrityIds = data.products.map(product => Number(product.id)).filter(Number.isFinite);
  const integrityLookup = buildOfferLookupIndex(data, { onProgress });
  refreshProductFastCachesForIdsInDb(data, integrityIds, { lookup: integrityLookup });
  markProductsIntelligenceDirtyInDb(data, integrityIds, "catalog-integrity");

  data.meta.catalogIntegrityVersion = 313;
  data.meta.catalogIntegrityLastRunAt = nowIso();
  data.meta.catalogIntegrityLastReason = String(reason).slice(0, 80);

  pruneData(data);
  if (deferPersistence) scheduleDeferredWrite(data, 250);
  else writeDb(data);
  enqueueIntelligenceProducts(integrityIds, {
    priority: "background",
    reason: "catalog-integrity",
  });

  const report = {
    at: nowIso(),
    reason,
    duplicateOffersRemoved: dedupe.removed,
    invalidCanonicalProductsRepaired: invalidIdentityRepair.productsRepaired,
    invalidCanonicalOffersRehomed: invalidIdentityRepair.offersRehomed,
    productsCreatedByInvalidCanonicalSplit: invalidIdentityRepair.newProducts,
    invalidGtinsCleared: invalidIdentityRepair.invalidGtinsCleared,
    invalidMpnsCleared: invalidIdentityRepair.invalidMpnsCleared,
    identifiersSanitized,
    incompatibleOffersSplit: split.splitOffers,
    productsCreatedBySplit: split.newProducts,
    explicitMerchantVariantOffersSplit: merchantVariantSplit.splitOffers,
    productsCreatedByMerchantVariantSplit: merchantVariantSplit.newProducts,
    duplicateProductsMerged: merged.merged,
    strongEvidenceListingDuplicatesMerged: strongEvidenceListingDuplicates.merged,
    exactBrandTitleDuplicatesMerged: localExactDuplicates.merged,
    postMergeCanonicalOwnersRepaired: postMergeOwnership.repaired,
    compressedHistoryBuckets: integrityCompression.aggregatesRetained,
    legacyEbayHistoryReset: resetHistory,
    products: data.products.length,
    offers: data.offers.length,
    backupCreated: makeBackup && fs.existsSync(backupPath),
    backupPath: makeBackup ? backupPath : "",
  };

  try {
    fs.appendFileSync(
      path.join(DATA_DIR, "catalog-integrity.jsonl"),
      JSON.stringify(report) + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
  } catch {}

  return report;
}


export function runLocalDatabaseCleanup({
  reason = "scheduled-local",
  maxProducts = Number(process.env.LOCAL_NORMALIZATION_PRODUCTS_PER_PASS || 2500),
  deferPersistence = true,
} = {}) {
  const startedAt = Date.now();
  const data = readDb();
  const requiredIntegrityVersion = 313;
  if (Number(data.meta?.catalogIntegrityVersion || 0) < requiredIntegrityVersion) {
    return {
      skipped: true,
      skipReason: "catalog-integrity-migration-pending",
      integrityVersion: Number(data.meta?.catalogIntegrityVersion || 0),
      requiredIntegrityVersion,
      scannedProducts: 0,
      touchedProducts: 0,
      durationMs: Date.now() - startedAt,
    };
  }
  const touched = new Set();

  const dedupe = dedupeExactOffersInDb(data);
  for (const id of dedupe.touchedProductIds || []) touched.add(Number(id));

  const invalidRepair = splitInvalidStrongCanonicalProducts(data);
  for (const id of invalidRepair.touchedProductIds || []) touched.add(Number(id));

  // This repair is entirely local: it only separates provider offers that carry
  // the same validated strong identity but an explicit incompatible bundle fact.
  const variantSplit = splitExplicitStrongVariantOffers(data);
  for (const id of variantSplit.touchedProductIds || []) touched.add(Number(id));

  const offersByProduct = new Map();
  for (const offer of data.offers) {
    const productId = Number(offer.productId);
    if (!offersByProduct.has(productId)) offersByProduct.set(productId, []);
    offersByProduct.get(productId).push(offer);
  }

  const normalizationLookup = buildOfferLookupIndex(data);
  const products = data.products || [];
  const limit = Math.min(Math.max(Number(maxProducts || 2500), 100), Math.max(products.length, 100));
  const start = products.length
    ? Math.max(0, Number(data.meta.localNormalizationCursor || 0)) % products.length
    : 0;
  const count = Math.min(limit, products.length);
  let identifiersSanitized = 0;
  let canonicalKeysRepaired = 0;

  for (let offset = 0; offset < count; offset++) {
    const product = products[(start + offset) % products.length];
    if (!product) continue;
    let changed = sanitizeStoredProductIdentifiers(product);
    if (changed) identifiersSanitized++;

    const productOffers = offersByProduct.get(Number(product.id)) || [];
    const primaryEbay = primaryEbayOfferFor(data, product, normalizationLookup);
    const representative = canonicalOwnershipOfferFor(
      data,
      product,
      productOffers,
      normalizationLookup
    );

    let desired = "";
    const strong = strongIdentityBaseKey(product);
    if (strong) {
      // Listing-scoped eBay products remain isolated until their canonical
      // source listing (not a secondary competitor) has exact item detail that
      // proves the identity. This mirrors the full integrity migration exactly.
      const listingScopedEbay = String(product.canonicalKey || "").startsWith("listing:ebay:");
      const primaryExactIdentity =
        primaryEbay &&
        String(primaryEbay.priceSource || "") === "ebay-item-detail" &&
        Boolean(primaryEbay.priceVerifiedAt) &&
        exactCompetitorProof(product, primaryEbay).ok;
      const allowStrongRekey = !listingScopedEbay || Boolean(primaryExactIdentity);
      if (allowStrongRekey) {
        desired = candidateCanonicalKey({
          gtin: product.gtin,
          brand: product.brand,
          mpn: product.mpn,
          title: product.title,
          provider: representative?.provider || "product",
          externalId: representative?.externalId || product.id,
        });
      }
    }

    if (!desired) {
      const currentKey = String(product.canonicalKey || "");
      const currentListingStillOwned =
        currentKey.startsWith("listing:") &&
        productOffers.some(offer => normalizationListingKeyForOffer(offer, product.id) === currentKey);
      if (currentListingStillOwned) desired = currentKey;
    }
    if (!desired && representative) {
      desired = normalizationListingKeyForOffer(representative, product.id);
    }
    if (!desired) {
      desired = candidateCanonicalKey({
        provider: "product",
        externalId: product.id,
        title: product.title,
      });
    }

    if (desired && String(product.canonicalKey || "") !== desired) {
      product.canonicalKey = desired;
      product.normalizationStatus = "locally-normalized";
      product.normalizationLastReason = String(reason || "scheduled-local").slice(0, 120);
      product.normalizationLastRepairedAt = nowIso();
      canonicalKeysRepaired++;
      changed = true;
    }

    if (changed) {
      product.integrityBucket = coarseVariantBucket(product.title, product.brand || "");
      product.lifecycleNormalizedTitle = normalizeLifecycleIdentityText(product.title);
      product.lifecycleNormalizedBrand = normalizeLifecycleIdentityText(product.brand);
      product.lifecycleIdentityKey = lifecycleIdentityKey(product);
      product.updatedAt = nowIso();
      touched.add(Number(product.id));
    }
  }

  data.meta.localNormalizationCursor = products.length ? (start + count) % products.length : 0;

  const strongMerged = mergeDuplicateCanonicalProducts(data);
  for (const id of strongMerged.touchedProductIds || []) touched.add(Number(id));
  const strongEvidenceListingMerged = mergeStrongEvidenceListingDuplicates(data);
  for (const id of strongEvidenceListingMerged.touchedProductIds || []) touched.add(Number(id));
  data.meta.strongEvidenceDuplicateMergeVersion = 1;
  const localMerged = mergeExactBrandTitleDuplicates(data);
  for (const id of localMerged.touchedProductIds || []) touched.add(Number(id));
  const postMergeOwnership = repairListingCanonicalOwnershipAfterMerges(data, [
    ...(strongMerged.touchedProductIds || []),
    ...(strongEvidenceListingMerged.touchedProductIds || []),
    ...(localMerged.touchedProductIds || []),
  ]);
  for (const id of postMergeOwnership.touchedProductIds || []) touched.add(Number(id));
  canonicalKeysRepaired += Number(postMergeOwnership.repaired || 0);

  const existingProductIds = new Set(data.products.map(product => Number(product.id)));
  const touchedIds = [...touched].filter(id => existingProductIds.has(Number(id)));

  if (touchedIds.length) {
    // Any product whose ownership changed loses compressed aggregate buckets;
    // raw offer-attributed observations remain attached/remapped and can be
    // recomputed safely by the intelligence workers.
    data.priceAggregates = data.priceAggregates.filter(
      aggregate => !touched.has(Number(aggregate.productId))
    );
    rescoreProductIdsInDb(data, touchedIds);
    const lookup = buildOfferLookupIndex(data);
    refreshProductFastCachesForIdsInDb(data, touchedIds, { lookup });
    markProductsIntelligenceDirtyInDb(data, touchedIds, "local-normalization-cleanup");
    enqueueIntelligenceProducts(touchedIds, {
      priority: "background",
      reason: "local-normalization-cleanup",
    });
  }

  // V3.7.32: only runCatalogIntegrityCycle() may advance the global catalog
  // integrity version. A bounded recurring cleanup can improve local records,
  // but it must never certify that the one-time full-catalog v313 migration ran.
  data.meta.localNormalizationLastRunAt = nowIso();
  data.meta.localNormalizationLastReason = String(reason || "scheduled-local").slice(0, 120);
  data.meta.localNormalizationLastTouched = touchedIds.length;
  data.meta.localNormalizationLastDurationMs = Date.now() - startedAt;
  data.meta.localNormalizationLastReport = {
    duplicateOffersRemoved: dedupe.removed,
    invalidCanonicalProductsRepaired: invalidRepair.productsRepaired,
    invalidCanonicalOffersRehomed: invalidRepair.offersRehomed,
    identifiersSanitized,
    canonicalKeysRepaired,
    explicitVariantOffersSplit: variantSplit.splitOffers,
    strongDuplicatesMerged: strongMerged.merged,
    strongEvidenceListingDuplicatesMerged: strongEvidenceListingMerged.merged,
    exactBrandTitleDuplicatesMerged: localMerged.merged,
  };

  pruneData(data);
  if (deferPersistence) scheduleDeferredWrite(data, 1000);
  else writeDb(data);

  return {
    at: data.meta.localNormalizationLastRunAt,
    reason: data.meta.localNormalizationLastReason,
    scannedProducts: count,
    nextCursor: data.meta.localNormalizationCursor,
    touchedProducts: touchedIds.length,
    durationMs: data.meta.localNormalizationLastDurationMs,
    ...data.meta.localNormalizationLastReport,
  };
}

export function getLocalDatabaseCleanupStatus() {
  const data = readDb();
  return {
    lastRunAt: data.meta.localNormalizationLastRunAt || null,
    lastReason: data.meta.localNormalizationLastReason || "",
    lastTouched: Number(data.meta.localNormalizationLastTouched || 0),
    lastDurationMs: Number(data.meta.localNormalizationLastDurationMs || 0),
    cursor: Number(data.meta.localNormalizationCursor || 0),
    report: data.meta.localNormalizationLastReport || {},
    strongEvidenceDuplicateMergeVersion: Number(data.meta.strongEvidenceDuplicateMergeVersion || 0),
  };
}

export function getDataIntegrityStats() {
  const data = readDb();

  const externalCounts = new Map();
  for (const offer of data.offers) {
    const key =
      `${String(offer.provider).toLowerCase()}:${String(offer.externalId)}`;
    externalCounts.set(key, (externalCounts.get(key) || 0) + 1);
  }

  const canonicalCounts = new Map();
  for (const product of data.products) {
    const key = String(product.canonicalKey || "");
    if (!key) continue;
    canonicalCounts.set(key, (canonicalCounts.get(key) || 0) + 1);
  }

  const invalidCanonicalProducts = data.products.filter(product => Boolean(invalidStrongCanonicalReason(product))).length;
  const invalidStoredGtins = data.products.filter(product =>
    String(product.gtin || "").trim() && !canonicalStrongGtin(product.gtin)
  ).length;
  const invalidStoredMpns = data.products.filter(product =>
    String(product.mpn || "").trim() && !canonicalStrongMpn(product.mpn)
  ).length;
  const invalidStoredEpids = data.products.filter(product =>
    String(product.epid || "").trim() && !canonicalStrongEpid(product.epid)
  ).length;
  const placeholderBrands = data.products.filter(product =>
    String(product.brand || "").trim() && isPlaceholderIdentifier(product.brand)
  ).length;

  const approved = new Set(
    data.products
      .filter(product => product.approved)
      .map(product => product.id)
  );

  const ebayPublic = data.offers.filter(offer =>
    String(offer.provider).toLowerCase() === "ebay" &&
    approved.has(offer.productId) &&
    offer.availability !== "out_of_stock"
  );

  const staleCutoff = Date.now() - 6 * 3_600_000;
  // Build the product/offer lookup once. Without this, each ebayOfferTrust()
  // call can rediscover the product's primary eBay offer by scanning the full
  // offer array, turning an Admin/startup status read into an O(products*offers)
  // main-thread stall on a large catalog.
  const integrityLookup = buildOfferLookupIndex(data);
  const productById = integrityLookup.productByNumericId;
  const untrustedPublicEbayOffers = ebayPublic.filter(offer => {
    const product = productById.get(Number(offer.productId));
    return !ebayOfferTrust(data, product, offer, { lookup: integrityLookup }).trusted;
  }).length;
  const weakIdentityPublicProducts = data.products.filter(product =>
    product.approved &&
    product.lifecycleState !== "ARCHIVED" &&
    !productEbayIdentityProofType(product)
  ).length;

  return {
    duplicateExternalOffers:
      [...externalCounts.values()].filter(count => count > 1).length,
    duplicateCanonicalProducts:
      [...canonicalCounts.entries()].filter(([key, count]) =>
        count > 1 &&
        (key.startsWith("gtin:") || key.startsWith("mpn:"))
      ).length,
    invalidCanonicalProducts,
    invalidStoredGtins,
    invalidStoredMpns,
    invalidStoredEpids,
    placeholderBrands,
    rejectedAffiliateUrls: data.offers.filter(offer => Boolean(offer.affiliateUrlRejected)).length,
    publicEbayOffers: ebayPublic.length,
    untrustedPublicEbayOffers,
    weakIdentityPublicProducts,
    unverifiedPublicEbayOffers:
      ebayPublic.filter(offer => !offer.priceVerifiedAt).length,
    staleVerifiedPublicEbayOffers:
      ebayPublic.filter(offer =>
        offer.priceVerifiedAt &&
        Date.parse(offer.priceVerifiedAt) < staleCutoff
      ).length,
    restrictedPriceOffers:
      ebayPublic.filter(offer => offer.priceDisplayRestricted).length,
    lastIntegrityRunAt:
      data.meta.catalogIntegrityLastRunAt || null,
    integrityVersion:
      Number(data.meta.catalogIntegrityVersion || 0),
    priceAccuracyVersion:
      Number(data.meta.priceAccuracyVersion || 0),
  };
}

export function getCatalogIntegrityVersionStatus() {
  const data = readDb();
  return {
    integrityVersion: Number(data.meta?.catalogIntegrityVersion || 0),
    priceAccuracyVersion: Number(data.meta?.priceAccuracyVersion || 0),
    lastIntegrityRunAt: data.meta?.catalogIntegrityLastRunAt || null,
  };
}

export function getEbayVerificationBacklogStatus() {
  const data = readDb();
  const approved = new Set(
    data.products
      .filter(product =>
        product.approved &&
        !["PRUNABLE", "ARCHIVED"].includes(String(product.lifecycleState || "ACTIVE"))
      )
      .map(product => Number(product.id))
  );

  let publicEbayOffers = 0;
  let unverifiedPublicEbayOffers = 0;
  for (const offer of data.offers) {
    if (String(offer.provider || "").toLowerCase() !== "ebay") continue;
    if (!approved.has(Number(offer.productId))) continue;
    if (offer.availability === "out_of_stock") continue;
    publicEbayOffers++;
    if (!offer.priceVerifiedAt) unverifiedPublicEbayOffers++;
  }

  return {
    publicEbayOffers,
    unverifiedPublicEbayOffers,
  };
}

// Lightweight Admin/status integrity summary. The full getDataIntegrityStats()
// deliberately retains its stricter trust audit for manual diagnostics, but it
// is too expensive to run on every SSE/admin refresh or startup recovery pass.
export function getAdminIntegritySummary() {
  const data = readDb();
  const canonicalCounts = new Map();
  let invalidCanonicalProducts = 0;
  let invalidStoredGtins = 0;
  let invalidStoredMpns = 0;
  let invalidStoredEpids = 0;
  let rejectedAffiliateUrls = 0;
  let unverifiedPublicEbayOffers = 0;

  const approved = new Set();
  for (const product of data.products) {
    if (
      product.approved &&
      !["PRUNABLE", "ARCHIVED"].includes(String(product.lifecycleState || "ACTIVE"))
    ) {
      approved.add(Number(product.id));
    }

    const canonicalKey = String(product.canonicalKey || "");
    if (canonicalKey) {
      canonicalCounts.set(canonicalKey, (canonicalCounts.get(canonicalKey) || 0) + 1);
    }
    if (invalidStrongCanonicalReason(product)) invalidCanonicalProducts++;
    if (String(product.gtin || "").trim() && !canonicalStrongGtin(product.gtin)) invalidStoredGtins++;
    if (String(product.mpn || "").trim() && !canonicalStrongMpn(product.mpn)) invalidStoredMpns++;
    if (String(product.epid || "").trim() && !canonicalStrongEpid(product.epid)) invalidStoredEpids++;
  }

  for (const offer of data.offers) {
    if (offer.affiliateUrlRejected) rejectedAffiliateUrls++;
    if (
      String(offer.provider || "").toLowerCase() === "ebay" &&
      approved.has(Number(offer.productId)) &&
      offer.availability !== "out_of_stock" &&
      !offer.priceVerifiedAt
    ) {
      unverifiedPublicEbayOffers++;
    }
  }

  return {
    unverifiedPublicEbayOffers,
    invalidCanonicalProducts,
    invalidStoredGtins,
    invalidStoredMpns,
    invalidStoredEpids,
    rejectedAffiliateUrls,
    duplicateCanonicalProducts:
      [...canonicalCounts.entries()].filter(([key, count]) =>
        count > 1 && (key.startsWith("gtin:") || key.startsWith("mpn:"))
      ).length,
    lastIntegrityRunAt: data.meta?.catalogIntegrityLastRunAt || null,
    integrityVersion: Number(data.meta?.catalogIntegrityVersion || 0),
    priceAccuracyVersion: Number(data.meta?.priceAccuracyVersion || 0),
  };
}

// Fast telemetry-only coverage summary for the Admin panel. Shopper ranking,
// Deal Heat, and public verified-offer calculations continue to use the full
// ebayOfferTrust() boundary. This avoids repeating an expensive trust audit on
// every live Admin refresh while retaining exact stored verification states.
export function getAdminEbayCompetitorCoverageStatus() {
  const data = readDb();
  const products = data.products.filter(product =>
    product.approved &&
    !["PRUNABLE", "ARCHIVED"].includes(String(product.lifecycleState || "ACTIVE"))
  );
  const active = new Set(products.map(product => Number(product.id)));
  const verifiedByProduct = new Map();
  const pendingByProduct = new Map();

  for (const offer of data.offers) {
    const productId = Number(offer.productId);
    if (!active.has(productId)) continue;
    if (String(offer.provider || "").toLowerCase() !== "ebay") continue;
    if (offer.availability === "out_of_stock") continue;

    const competitor = String(offer.matchSource || "").startsWith("ebay-competitor:");
    const identityStatus = String(offer.competitorIdentityStatus || "");
    if (competitor && identityStatus === "pending") {
      pendingByProduct.set(productId, Number(pendingByProduct.get(productId) || 0) + 1);
      continue;
    }

    const verified = Boolean(offer.priceVerifiedAt) && (
      competitor ? identityStatus === "verified" : identityStatus !== "rejected"
    );
    if (verified) {
      verifiedByProduct.set(productId, Number(verifiedByProduct.get(productId) || 0) + 1);
    }
  }

  let zeroVerified = 0;
  let oneVerified = 0;
  let multiVerified = 0;
  let pendingProducts = 0;
  let pendingListings = 0;
  let verifiedListings = 0;
  let strongIdentity = 0;

  for (const product of products) {
    const productId = Number(product.id);
    const verified = Number(verifiedByProduct.get(productId) || 0);
    const pending = Number(pendingByProduct.get(productId) || 0);
    verifiedListings += verified;
    pendingListings += pending;
    if (pending > 0) pendingProducts++;
    if (verified === 0) zeroVerified++;
    else if (verified === 1) oneVerified++;
    else multiVerified++;

    const canonicalKey = String(product.canonicalKey || "");
    if (
      canonicalKey.startsWith("gtin:") ||
      canonicalKey.startsWith("mpn:") ||
      Boolean(canonicalStrongEpid(product.epid))
    ) {
      strongIdentity++;
    }
  }

  return {
    publicProducts: products.length,
    strongIdentityProducts: strongIdentity,
    zeroVerifiedEbayListings: zeroVerified,
    oneVerifiedEbayListing: oneVerified,
    multiVerifiedEbayListings: multiVerified,
    pendingProducts,
    pendingListings,
    verifiedListings,
    multiSellerCoveragePct: products.length
      ? Math.round((multiVerified / products.length) * 1000) / 10
      : 0,
    telemetryMode: "stored-verification-state",
  };
}

export function getAnalytics() {
  const data = readDb();
  const now = Date.now();
  const resetAt = Date.parse(data.meta?.analyticsClickResetAt || "") || 0;
  const resetClickId = Math.max(0, Number(data.meta?.analyticsClickResetClickId || 0));
  const visibleClicks = data.clicks.filter(click => {
    const at = Date.parse(click.at || "");
    if (!Number.isFinite(at)) return false;
    if (resetClickId > 0) return Number(click.id || 0) >= resetClickId;
    return at >= resetAt;
  });
  const countSince = days => {
    const cutoff = Math.max(resetAt, now - days * 86_400_000);
    return visibleClicks.filter(click => Date.parse(click.at || "") >= cutoff).length;
  };

  const archivedHistoricalClicks = data.products.reduce(
    (sum, product) =>
      sum + Math.max(
        0,
        Number(product.lifecycleClickSummary?.lifetimeClicks || 0)
      ),
    0
  );
  const rawLifetimeClicks = data.clicks.length + archivedHistoricalClicks;
  const baselineLifetimeClicks = Math.max(
    0,
    Number(data.meta?.analyticsClickBaselineLifetime || 0)
  );

  const lifetimeByProduct = new Map();
  for (const product of data.products) {
    const archived = Math.max(0, Number(product.lifecycleClickSummary?.lifetimeClicks || 0));
    if (archived) lifetimeByProduct.set(Number(product.id), archived);
  }
  for (const click of data.clicks) {
    const productId = Number(click.productId);
    lifetimeByProduct.set(productId, Number(lifetimeByProduct.get(productId) || 0) + 1);
  }

  const baselineByProduct = data.meta?.analyticsClickBaselineByProduct || {};
  const productById = new Map(
    data.products.map(product => [Number(product.id), product])
  );
  const topProducts = [...lifetimeByProduct.entries()]
    .map(([productId, lifetimeClicks]) => {
      const clicks = Math.max(
        0,
        Number(lifetimeClicks || 0) - Number(baselineByProduct[String(productId)] || 0)
      );
      if (!clicks) return null;
      const product = productById.get(Number(productId));
      return product ? { productId, title: product.title, clicks } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10);

  return {
    totalClicks: Math.max(0, rawLifetimeClicks - baselineLifetimeClicks),
    archivedHistoricalClicks,
    clicks24h: countSince(1),
    clicks7d: countSince(7),
    clicks30d: countSince(30),
    topProducts,
    resetAt: resetAt ? new Date(resetAt).toISOString() : null,
  };
}

export function resetClickAnalytics() {
  const data = readDb();
  const lifetimeByProduct = new Map();

  for (const product of data.products) {
    const archived = Math.max(0, Number(product.lifecycleClickSummary?.lifetimeClicks || 0));
    if (archived) lifetimeByProduct.set(Number(product.id), archived);
  }
  for (const click of data.clicks) {
    const productId = Number(click.productId);
    lifetimeByProduct.set(productId, Number(lifetimeByProduct.get(productId) || 0) + 1);
  }

  const archivedHistoricalClicks = data.products.reduce(
    (sum, product) => sum + Math.max(0, Number(product.lifecycleClickSummary?.lifetimeClicks || 0)),
    0
  );

  data.meta.analyticsClickResetAt = nowIso();
  // nextClickId is the first click that should count after the reset. Using an
  // ID boundary avoids millisecond timestamp ties under rapid admin/click traffic.
  data.meta.analyticsClickResetClickId = Math.max(1, Number(data.meta.nextClickId || 1));
  data.meta.analyticsClickBaselineLifetime = data.clicks.length + archivedHistoricalClicks;
  data.meta.analyticsClickBaselineByProduct = Object.fromEntries(
    [...lifetimeByProduct.entries()]
      .filter(([, count]) => Number(count || 0) > 0)
      .map(([productId, count]) => [String(productId), Number(count)])
  );

  // Resetting the admin counter does not erase lifecycle click evidence. It
  // establishes a reporting baseline, preserving ranking/protection accuracy.
  // Persistence is deferred so the admin click receives an immediate response.
  scheduleDeferredWrite(
    data,
    Math.max(250, Number(process.env.RUNTIME_PERSIST_DELAY_MS || 1000))
  );
  publishLiveEvent(
    "analytics",
    { reason: "click-counter-reset", resetAt: data.meta.analyticsClickResetAt },
    { audience: "admin" }
  );
  return getAnalytics();
}


export function countCatalogProducts() {
  return readDb().products.filter(
    product => product.lifecycleState !== "ARCHIVED"
  ).length;
}

export function countPublicProducts() {
  return readDb().products.filter(
    product =>
      product.approved &&
      product.lifecycleState !== "ARCHIVED"
  ).length;
}

export function getDiscoveryRulesForCycle(limit = 24) {
  const data = readDb();
  const cap = Math.min(Math.max(Number(limit) || 24, 1), 100);

  return data.discoveryRules
    .filter(rule => rule.enabled)
    .sort((a, b) => {
      const at = a.lastRunAt ? Date.parse(a.lastRunAt) : 0;
      const bt = b.lastRunAt ? Date.parse(b.lastRunAt) : 0;

      // Never-run rules go first; after that the oldest scan wins.
      if (!a.lastRunAt && b.lastRunAt) return -1;
      if (a.lastRunAt && !b.lastRunAt) return 1;
      return at - bt || Number(a.generationDepth || 0) - Number(b.generationDepth || 0) || a.id - b.id;
    })
    .slice(0, cap);
}

export function approveProductIds(productIds, maxCount = Infinity, { deferPersistence = false } = {}) {
  const data = readDb();
  const uniqueIds = [...new Set(Array.from(productIds || []).map(Number).filter(Number.isFinite))];

  const ranked = uniqueIds
    .map(productId => {
      const product = data.products.find(p => p.id === productId);
      const best = product ? bestOfferFor(data, productId) : null;
      return product && best && !product.autoApprovalBlocked ? { product, best } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.best.score || 0) - Number(a.best.score || 0) || Number(a.best.price || 0) - Number(b.best.price || 0))
    .slice(0, Number.isFinite(Number(maxCount)) ? Math.max(0, Number(maxCount)) : uniqueIds.length);

  const approved = [];
  const approvedAt = nowIso();
  for (const item of ranked) {
    item.product.approved = true;
    item.product.updatedAt = approvedAt;
    item.product.approvedAt = approvedAt;
    item.product.approvalSource = "auto-bulk";
    item.product.autoApprovalBlocked = false;
    item.product.lastAutoReviewAt = approvedAt;
    item.product.lastAutoReviewDecision = "approved";
    item.product.lastAutoReviewReason = "Approved by a trusted bulk-ingestion publication policy.";
    approved.push(item.product.id);
  }

  if (approved.length) {
    SEARCH_INDEX_REVISION++;
    if (!deferPersistence) {
      writeDb(data);
    }
    // deferPersistence is used by Rakuten Product Catalog chunk ingestion.
    // Those approvals live in the same in-memory catalog object as the queued
    // offer mutations and are persisted by that batch's mutation-buffer flush;
    // scheduling an independent JSON snapshot here would reintroduce write
    // amplification and could persist a feed before its raw history boundary.

    publishProductLiveMutation(data, {
      type: "catalog",
      reason: "products-approved",
      productIds: approved,
      metadata: { approved: approved.length },
    });
  }
  return approved;
}

function sanitizeRule(input, existing = {}) {
  const provider = ["ebay", "awin"].includes(String(input.provider || existing.provider))
    ? String(input.provider || existing.provider)
    : "ebay";
  return {
    ...existing,
    name: String(input.name ?? existing.name ?? "Discovery rule").trim().slice(0, 120),
    provider,
    query: String(input.query ?? existing.query ?? "").trim().slice(0, 200),
    advertiserId: String(input.advertiserId ?? existing.advertiserId ?? "").replace(/[^0-9]/g, "").slice(0, 20),
    locale: String(input.locale ?? existing.locale ?? "en_US").replace(/[^A-Za-z_]/g, "").slice(0, 20) || "en_US",
    limit: Math.min(Math.max(Number(input.limit ?? existing.limit ?? 50), 1), provider === "ebay" ? 200 : 5000),
    enabled: input.enabled == null ? Boolean(existing.enabled ?? true) : Boolean(input.enabled),
    autoApprove: input.autoApprove == null ? Boolean(existing.autoApprove ?? false) : Boolean(input.autoApprove),
    starter: input.starter == null ? Boolean(existing.starter ?? false) : Boolean(input.starter),
    starterKey: String(input.starterKey ?? existing.starterKey ?? "").trim().slice(0, 120),
    categoryOverride: String(input.categoryOverride ?? existing.categoryOverride ?? "").trim().slice(0, 120),
    generated: input.generated == null ? Boolean(existing.generated ?? false) : Boolean(input.generated),
    parentRuleId:
      input.parentRuleId == null
        ? (existing.parentRuleId == null ? null : Number(existing.parentRuleId))
        : Number(input.parentRuleId),
    generationDepth: Math.max(0, Math.min(20, Number(input.generationDepth ?? existing.generationDepth ?? 0))),
    familyKey: String(input.familyKey ?? existing.familyKey ?? "").trim().slice(0, 80),
    stallCount: Math.max(0, Number(input.stallCount ?? existing.stallCount ?? 0)),
    expansionCount: Math.max(0, Number(input.expansionCount ?? existing.expansionCount ?? 0)),
    lastExpansionAt: input.lastExpansionAt ?? existing.lastExpansionAt ?? null,
    minScore: Math.min(100, Math.max(0, Number(input.minScore ?? existing.minScore ?? 70))),
    minHeat: Math.min(100, Math.max(0, Number(input.minHeat ?? existing.minHeat ?? 0))),
    minDiscount: Math.min(100, Math.max(0, Number(input.minDiscount ?? existing.minDiscount ?? 0))),
    minCommissionRate: Math.min(1, Math.max(0, Number(input.minCommissionRate ?? existing.minCommissionRate ?? 0))),
  };
}


export function updateProductIdentity(id, identity = {}, { deferPersistence = false } = {}) {
  const data = readDb();
  const product = data.products.find(p => p.id === Number(id));
  if (!product) return null;

  // V3.7.32: product identity is sanitized at the ingestion boundary. Historical
  // invalid values are cleared before new evidence is considered, and rejected
  // marketplace metadata is retained only as an audit breadcrumb.
  sanitizeStoredProductIdentifiers(product);
  applyTrustedProductIdentity(product, identity, {
    fillOnly: true,
    source: "identity-enrichment",
  });

  if (identity.checkedAt !== undefined) {
    product.ebayIdentityCheckedAt = identity.checkedAt || nowIso();
  }

  // Promote a title/listing-keyed product to a stronger canonical key when the
  // now-sanitized identity proves one and no other product already owns it.
  let strongerKey = "";
  if (strongIdentityBaseKey(product)) {
    strongerKey = candidateCanonicalKey({
      gtin: product.gtin,
      brand: product.brand,
      mpn: product.mpn,
      title: product.title,
      provider: "product",
      externalId: product.id,
    });
  }

  if (
    strongerKey &&
    product.canonicalKey !== strongerKey &&
    !data.products.some(p => p.id !== product.id && p.canonicalKey === strongerKey)
  ) {
    product.canonicalKey = strongerKey;
  }

  product.updatedAt = nowIso();
  const identityLookup = buildOfferLookupIndex(data);
  refreshProductFastCachesForIdsInDb(data, [product.id], { lookup: identityLookup });
  markProductsIntelligenceDirtyInDb(data, [product.id], "identity-updated");
  if (deferPersistence) scheduleDeferredWrite(data, 250);
  else writeDb(data);
  enqueueIntelligenceProducts([product.id], { priority: "normal", reason: "identity-updated" });
  return hydrate(data, product);
}


export function markEbayExactSearchRejected(
  productId,
  {
    method = "",
    value = "",
    errorId = 12001,
  } = {},
  { deferPersistence = false } = {}
) {
  const data = readDb();
  const product = data.products.find(
    item => Number(item.id) === Number(productId)
  );

  if (!product) return null;

  product.ebayExactSearchRejectedAt = nowIso();
  product.ebayExactSearchRejectedMethod =
    String(method || "").slice(0, 20);
  product.ebayExactSearchRejectedValue =
    String(value || "").slice(0, 80);
  product.ebayExactSearchRejectedErrorId =
    Number(errorId || 12001) || 12001;
  product.updatedAt = nowIso();

  if (deferPersistence) scheduleDeferredWrite(data, 250);
  else writeDb(data);
  publishAdminLiveMutation("ebay-exact-search-rejected", {
    productId: Number(product.id),
    method: product.ebayExactSearchRejectedMethod,
    errorId: product.ebayExactSearchRejectedErrorId,
  });

  return hydrate(data, product, {
    includeHistory: false,
  });
}

export function clearEbayExactSearchRejected(productId, { deferPersistence = false } = {}) {
  const data = readDb();
  const product = data.products.find(
    item => Number(item.id) === Number(productId)
  );

  if (!product) return null;

  if (
    !product.ebayExactSearchRejectedAt &&
    !product.ebayExactSearchRejectedMethod &&
    !product.ebayExactSearchRejectedValue
  ) {
    return hydrate(data, product, {
      includeHistory: false,
    });
  }

  product.ebayExactSearchRejectedAt = null;
  product.ebayExactSearchRejectedMethod = "";
  product.ebayExactSearchRejectedValue = "";
  product.ebayExactSearchRejectedErrorId = null;
  product.updatedAt = nowIso();

  if (deferPersistence) scheduleDeferredWrite(data, 250);
  else writeDb(data);
  return hydrate(data, product, {
    includeHistory: false,
  });
}


export function markEbayCompetitorScan(id, {
  method = "",
  confidence = 0,
  matched = 0,
  error = "",
  coverageComplete = undefined,
  coverageTargetSellers = undefined,
  coverageSignalsExhausted = undefined,
  coverageSignalsRun = undefined,
  coverageSellerCount = undefined,
  coverageStatus = undefined,
} = {}) {
  const data = readDb();
  const product = data.products.find(p => p.id === Number(id));
  if (!product) return null;

  product.ebayCompetitorScanAt = nowIso();
  product.ebayCompetitorScanMethod = String(method || "").slice(0, 80);
  product.ebayCompetitorScanConfidence = Math.max(0, Math.min(100, Number(confidence || 0)));
  product.ebayCompetitorScanMatched = Math.max(0, Number(matched || 0));
  product.ebayCompetitorScanError = String(error || "").slice(0, 500);

  // V3.7.42: only the ordered progressive shopper-page pass sets these
  // fields. Legacy/background calls leave the previous coverage proof alone.
  // A failed/deferred progressive pass explicitly clears completeness so a
  // later shopper search can resume instead of trusting a shallow timestamp.
  if (coverageComplete !== undefined) {
    product.ebayCompetitorCoverageCompleteAt = coverageComplete ? nowIso() : null;
  }
  if (coverageTargetSellers !== undefined) {
    product.ebayCompetitorCoverageTargetSellers = Math.max(0, Number(coverageTargetSellers || 0));
  }
  if (coverageSignalsExhausted !== undefined) {
    product.ebayCompetitorCoverageSignalsExhausted = Boolean(coverageSignalsExhausted);
  }
  if (coverageSignalsRun !== undefined) {
    product.ebayCompetitorCoverageSignalsRun = Math.max(0, Number(coverageSignalsRun || 0));
  }
  if (coverageSellerCount !== undefined) {
    product.ebayCompetitorCoverageSellerCount = Math.max(0, Number(coverageSellerCount || 0));
  }
  if (coverageStatus !== undefined) {
    product.ebayCompetitorCoverageStatus = String(coverageStatus || "").slice(0, 80);
  }
  product.updatedAt = nowIso();

  scheduleDeferredWrite(data, 1000);
  return hydrate(data, product);
}

export function getProductsForEbayCompetitorScan(limit = 40) {
  const data = readDb();
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 250);
  const now = Date.now();
  const lookup = buildOfferLookupIndex(data);

  const activeMinutes = Math.max(
    15,
    Number(process.env.EBAY_COMPETITOR_SCAN_MINUTES || 60)
  );
  const dormantDays = Math.max(
    1,
    Number(process.env.PRODUCT_DORMANT_REFRESH_DAYS || 7)
  );
  const staleDays = Math.max(
    dormantDays,
    Number(process.env.PRODUCT_STALE_REFRESH_DAYS || 30)
  );

  const latestClickAtByProduct = new Map();
  for (const click of data.clicks || []) {
    const productId = Number(click.productId);
    const at = Date.parse(click.at || "");
    if (!Number.isFinite(productId) || !Number.isFinite(at)) continue;
    if (at > Number(latestClickAtByProduct.get(productId) || 0)) {
      latestClickAtByProduct.set(productId, at);
    }
  }

  const ebayStateByProduct = new Map();
  function ebayState(product) {
    const numericId = Number(product.id);
    if (ebayStateByProduct.has(numericId)) return ebayStateByProduct.get(numericId);
    const offers = lookup.offersByNumericProductId.get(numericId) || [];
    const trustedActive = offers.filter(offer =>
      isEbayOffer(offer) &&
      offer.availability !== "out_of_stock" &&
      ebayOfferTrust(data, product, offer, { lookup }).trusted
    );
    const verifiedActive = trustedActive.filter(offer => Boolean(offer.priceVerifiedAt));
    const pending = offers.filter(offer =>
      isEbayOffer(offer) &&
      String(offer.competitorIdentityStatus || "") === "pending" &&
      offer.availability !== "out_of_stock"
    );
    const state = {
      trustedActive: trustedActive.length,
      verifiedActive: verifiedActive.length,
      verifiedSellers: new Set(
        verifiedActive.map(offer => String(offer.merchant || "").trim().toLowerCase()).filter(Boolean)
      ).size,
      pending: pending.length,
    };
    ebayStateByProduct.set(numericId, state);
    return state;
  }

  function intervalMs(product) {
    const state = product.lifecycleState || "ACTIVE";
    return state === "DORMANT"
      ? dormantDays * DAY_MS
      : state === "STALE"
        ? staleDays * DAY_MS
        : activeMinutes * 60_000;
  }

  function dueAt(product) {
    const last = product.ebayCompetitorScanAt
      ? Date.parse(product.ebayCompetitorScanAt)
      : 0;
    return last + intervalMs(product);
  }

  function hasProvableIdentity(product) {
    return Boolean(productEbayIdentityProofType(product));
  }

  function priorityScore(product) {
    const interval = Math.max(1, intervalMs(product));
    const overdueMs = Math.max(0, now - dueAt(product));
    const overdueIntervals = overdueMs / interval;
    const heat = Math.max(
      0,
      Math.min(100, Number(product.cachedPriceStats?.dealHeat || 0))
    );
    const coverage = ebayState(product);

    let score = Math.min(6, overdueIntervals) * 250;
    if ((product.lifecycleState || "ACTIVE") === "ACTIVE") score += 200;
    score += heat * 6;

    // V3.7.29: seller-coverage deficit is now the dominant tiebreaker. The
    // scanner spends Browse calls first on products where customers currently
    // have no meaningful seller choice, instead of repeatedly polishing items
    // that already have several verified eBay sellers.
    if (coverage.verifiedSellers === 0) score += 1_150;
    else if (coverage.verifiedSellers === 1) score += 950;
    else if (coverage.verifiedSellers === 2) score += 250;
    else score -= Math.min(400, (coverage.verifiedSellers - 2) * 80);

    if (coverage.pending > 0) score -= Math.min(250, coverage.pending * 25);

    const lastClickAt = Number(latestClickAtByProduct.get(Number(product.id)) || 0);
    if (lastClickAt) {
      const clickAgeMs = Math.max(0, now - lastClickAt);
      if (clickAgeMs <= 24 * 60 * 60 * 1000) score += 700;
      else if (clickAgeMs <= 7 * DAY_MS) score += 350;
      else if (clickAgeMs <= 30 * DAY_MS) score += 175;
    }

    if (
      (product.lifecycleState || "ACTIVE") === "ACTIVE" &&
      hasProvableIdentity(product) &&
      coverage.trustedActive === 0
    ) {
      score += 500;
    }

    return score;
  }

  return data.products
    .filter(product => product.approved || product.lifecycleWasApproved)
    .filter(product => !["PRUNABLE", "ARCHIVED"].includes(product.lifecycleState))
    .filter(product => {
      const coverage = ebayState(product);
      if (product.lifecycleState === "ACTIVE") {
        return coverage.trustedActive > 0 || hasProvableIdentity(product);
      }
      return Boolean(hasProvableIdentity(product) || product.title);
    })
    .filter(product => dueAt(product) <= now)
    .sort((a, b) =>
      priorityScore(b) - priorityScore(a) ||
      dueAt(a) - dueAt(b) ||
      Date.parse(a.lifecycleLastObservationAt || 0) -
        Date.parse(b.lifecycleLastObservationAt || 0)
    )
    .slice(0, cap)
    .map(product => ({
      ...product,
      offers: trustedOffersFor(data, product.id, lookup).map(offer => ({ ...offer })),
    }));
}

export function installDiscoverySearchPack(searches, version, defaults = {}) {
  const data = readDb();
  const targetVersion = Math.max(1, Number(version) || 1);
  const currentVersion = Number(data.meta.discoverySearchPackVersion || 0);

  if (currentVersion >= targetVersion) {
    return {
      version: currentVersion,
      installed: 0,
      updated: 0,
      skipped: Array.isArray(searches) ? searches.length : 0,
    };
  }

  let installed = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of searches || []) {
    const query = String(item.query || "").trim();
    if (!query) continue;

    const existing = data.discoveryRules.find(rule =>
      rule.provider === "ebay" &&
      String(rule.query || "").trim().toLowerCase() === query.toLowerCase()
    );

    if (existing) {
      let changed = false;
      if (!existing.starterKey && item.key) {
        existing.starterKey = String(item.key).slice(0, 120);
        changed = true;
      }
      if (!existing.categoryOverride && item.category) {
        existing.categoryOverride = String(item.category).slice(0, 120);
        changed = true;
      }
      if (!existing.starter) {
        existing.starter = true;
        changed = true;
      }
      if (
        defaults.limit != null &&
        Number(existing.limit || 0) < Number(defaults.limit) &&
        (existing.starter || existing.generated)
      ) {
        existing.limit = Math.min(
          Math.max(Number(defaults.limit), 1),
          existing.provider === "ebay" ? 200 : 5000
        );
        changed = true;
      }
      if (changed) updated++;
      else skipped++;
      continue;
    }

    const rule = sanitizeRule({
      ...defaults,
      name: `Starter · ${item.name || query}`,
      provider: "ebay",
      query,
      categoryOverride: item.category || "",
      starterKey: item.key || "",
      starter: true,
    });

    rule.id = data.meta.nextRuleId++;
    rule.createdAt = nowIso();
    rule.lastRunAt = null;
    rule.lastResult = null;
    rule.lastError = "";
    data.discoveryRules.push(rule);
    installed++;
  }

  data.meta.discoverySearchPackVersion = targetVersion;
  writeDb(data);

  return {
    version: targetVersion,
    installed,
    updated,
    skipped,
  };
}

export function getDiscoveryRules() {
  return readDb().discoveryRules.slice().sort((a, b) => a.id - b.id);
}

export function createDiscoveryRule(input, { deferPersistence = false } = {}) {
  const data = readDb();
  const rule = sanitizeRule(input);
  if (rule.provider === "ebay" && isExplicitSearchQuery(rule.query || "")) {
    const error = new Error("Explicit discovery queries are not permitted in OfferGrid.");
    error.code = "EXPLICIT_SEARCH_BLOCKED";
    error.status = 400;
    throw error;
  }
  rule.id = data.meta.nextRuleId++;
  rule.createdAt = nowIso();
  rule.lastRunAt = null;
  rule.lastResult = null;
  rule.lastError = "";
  data.discoveryRules.push(rule);
  if (deferPersistence) {
    scheduleDeferredWrite(data, Math.max(250, Number(process.env.RUNTIME_PERSIST_DELAY_MS || 1000)));
  } else {
    writeDb(data);
  }
  publishAdminLiveMutation("rule-created");
  return rule;
}

export function updateDiscoveryRule(id, input) {
  const data = readDb();
  const index = data.discoveryRules.findIndex(r => r.id === Number(id));
  if (index === -1) return null;
  const nextRule = sanitizeRule(input, data.discoveryRules[index]);
  if (nextRule.provider === "ebay" && isExplicitSearchQuery(nextRule.query || "")) {
    const error = new Error("Explicit discovery queries are not permitted in OfferGrid.");
    error.code = "EXPLICIT_SEARCH_BLOCKED";
    error.status = 400;
    throw error;
  }
  data.discoveryRules[index] = nextRule;
  writeDb(data);
  publishAdminLiveMutation("rule-updated");
  return data.discoveryRules[index];
}

export function deleteDiscoveryRule(id) {
  const data = readDb();
  const before = data.discoveryRules.length;
  data.discoveryRules = data.discoveryRules.filter(r => r.id !== Number(id));
  if (data.discoveryRules.length === before) return false;
  writeDb(data);
  publishAdminLiveMutation("rule-deleted");
  return true;
}

export function markRuleRun(id, { result = null, error = "", deferPersistence = false } = {}) {
  const data = readDb();
  const rule = data.discoveryRules.find(r => r.id === Number(id));
  if (!rule) return null;
  rule.lastRunAt = nowIso();
  rule.lastResult = result;
  rule.lastError = String(error || "").slice(0, 700);

  if (result && Number(result.productsCreated || 0) > 0) {
    rule.stallCount = 0;
  } else if (result && Number(result.productsCreated || 0) === 0) {
    rule.stallCount = Math.max(0, Number(rule.stallCount || 0)) + 1;
  }

  if (deferPersistence) {
    scheduleDeferredWrite(data, Math.max(250, Number(process.env.RUNTIME_PERSIST_DELAY_MS || 1000)));
  } else {
    writeDb(data);
  }
  publishAdminLiveMutation("rule-run");
  return rule;
}


export function markRuleExpanded(id, addedCount, { deferPersistence = false } = {}) {
  const data = readDb();
  const rule = data.discoveryRules.find(r => r.id === Number(id));
  if (!rule) return null;

  rule.expansionCount =
    Math.max(0, Number(rule.expansionCount || 0)) +
    Math.max(0, Number(addedCount || 0));
  rule.lastExpansionAt = nowIso();
  if (deferPersistence) {
    scheduleDeferredWrite(data, Math.max(250, Number(process.env.RUNTIME_PERSIST_DELAY_MS || 1000)));
  } else {
    writeDb(data);
  }
  publishAdminLiveMutation("rule-expanded");
  return rule;
}

export function getDiscoveryGrowthStatus() {
  const data = readDb();
  return {
    catalogProducts: data.products.filter(
      product => product.lifecycleState !== "ARCHIVED"
    ).length,
    totalCanonicalRecords: data.products.length,
    archivedCanonicalRecords: data.products.filter(
      product => product.lifecycleState === "ARCHIVED"
    ).length,
    publicProducts: data.products.filter(
      product =>
        product.approved &&
        product.lifecycleState !== "ARCHIVED"
    ).length,
    totalRules: data.discoveryRules.length,
    generatedRules: data.discoveryRules.filter(rule => rule.generated).length,
    stalledRules: data.discoveryRules.filter(rule => Number(rule.stallCount || 0) > 0).length,
  };
}


const DRAFT_AUTO_REVIEW_STATUS = {
  lastRunAt: null,
  lastReason: "",
  lastScanned: 0,
  lastApproved: 0,
  approvedTotal: 0,
  lastSkipped: {},
};

function draftAutoApprovalMaxAgeMs() {
  const hours = Math.min(
    Math.max(Number(process.env.DRAFT_AUTO_APPROVE_MAX_AGE_HOURS || 168), 1),
    24 * 90
  );
  return hours * 60 * 60 * 1000;
}

function draftAutoApprovalThreshold() {
  return Math.min(
    Math.max(Number(process.env.DRAFT_AUTO_APPROVE_MIN_CONFIDENCE || 80), 60),
    100
  );
}

function buildDraftAutoReviewIndex(data) {
  const canonicalCounts = new Map();
  const strongBaseProducts = new Map();

  for (const product of data.products || []) {
    if (String(product.lifecycleState || "ACTIVE").toUpperCase() === "ARCHIVED") continue;
    const canonical = String(product.canonicalKey || "");
    if (canonical) canonicalCounts.set(canonical, Number(canonicalCounts.get(canonical) || 0) + 1);

    const base = strongIdentityBaseKey(product);
    if (base) {
      if (!strongBaseProducts.has(base)) strongBaseProducts.set(base, []);
      strongBaseProducts.get(base).push(product);
    }
  }

  return { canonicalCounts, strongBaseProducts };
}

function getRuntimeDraftAutoReviewIndex(data) {
  const productsLength = Array.isArray(data?.products) ? data.products.length : 0;
  if (
    !RUNTIME_DRAFT_REVIEW_CACHE ||
    RUNTIME_DRAFT_REVIEW_CACHE_REVISION !== SEARCH_INDEX_REVISION ||
    RUNTIME_DRAFT_REVIEW_CACHE_PRODUCTS !== productsLength
  ) {
    RUNTIME_DRAFT_REVIEW_CACHE = buildDraftAutoReviewIndex(data);
    RUNTIME_DRAFT_REVIEW_CACHE_REVISION = SEARCH_INDEX_REVISION;
    RUNTIME_DRAFT_REVIEW_CACHE_PRODUCTS = productsLength;
  }
  return RUNTIME_DRAFT_REVIEW_CACHE;
}

function evaluateDraftAutoApprovalInDb(data, product, lookup = null, reviewIndex = null) {
  const reasons = [];
  let confidence = 0;

  if (!product) return { eligible: false, confidence: 0, reasons: ["missing-product"] };
  if (product.approved) return { eligible: false, confidence: 100, reasons: ["already-approved"] };
  if (String(product.lifecycleState || "ACTIVE").toUpperCase() !== "ACTIVE") {
    return { eligible: false, confidence: 0, reasons: ["not-active"] };
  }
  if (product.autoApprovalBlocked || product.manualReviewTouchedAt) {
    return { eligible: false, confidence: 0, reasons: ["manual-review-lock"] };
  }
  if (isExplicitProduct(product)) {
    return { eligible: false, confidence: 0, reasons: ["explicit-product"] };
  }

  const createdMs = Date.parse(product.createdAt || product.updatedAt || "");
  if (!Number.isFinite(createdMs)) {
    return { eligible: false, confidence: 0, reasons: ["unknown-draft-age"] };
  }
  if (Date.now() - createdMs > draftAutoApprovalMaxAgeMs()) {
    return { eligible: false, confidence: 0, reasons: ["draft-too-old"] };
  }

  const canonical = String(product.canonicalKey || "");
  if (!canonical) {
    return { eligible: false, confidence: 0, reasons: ["missing-canonical-key"] };
  }
  const effectiveReviewIndex = reviewIndex || buildDraftAutoReviewIndex(data);
  const duplicateCanonical = Number(effectiveReviewIndex.canonicalCounts.get(canonical) || 0) > 1;
  if (duplicateCanonical) {
    return { eligible: false, confidence: 0, reasons: ["duplicate-canonical-owner"] };
  }

  const offers = trustedOffersFor(data, product.id, lookup)
    .filter(offer =>
      offer.availability !== "out_of_stock" &&
      !offer.priceDisplayRestricted &&
      Number.isFinite(Number(offer.price)) &&
      Number(offer.price) > 0 &&
      String(offer.affiliateUrl || "").trim()
    );

  if (!offers.length) {
    return { eligible: false, confidence: 0, reasons: ["no-trusted-active-offer"] };
  }

  const best = bestOfferFor(data, product.id, lookup);
  if (!best || !offers.some(offer => Number(offer.id) === Number(best.id))) {
    return { eligible: false, confidence: 0, reasons: ["no-usable-best-offer"] };
  }

  const provider = String(best.provider || "").toLowerCase();
  const matchSource = String(best.matchSource || best.priceSource || "").toLowerCase();
  const identityProof = productEbayIdentityProofType(product);
  const isolatedVerifiedEbay =
    provider === "ebay" &&
    Boolean(best.priceVerifiedAt) &&
    String(best.priceSource || "") === "ebay-item-detail" &&
    canonical.startsWith("listing:ebay:");

  if (provider === "ebay") {
    if (!best.priceVerifiedAt || String(best.priceSource || "") !== "ebay-item-detail") {
      return { eligible: false, confidence: 0, reasons: ["ebay-not-exact-verified"] };
    }
    confidence += 45;
    reasons.push("exact-ebay-item");
  } else if (matchSource.includes("rakuten-product-catalog")) {
    confidence += 45;
    reasons.push("rakuten-catalog-source");
  } else if (provider === "rakuten" && matchSource.includes("rakuten-product-search")) {
    confidence += 35;
    reasons.push("rakuten-product-search");
  } else {
    confidence += 20;
    reasons.push("trusted-non-ebay-source");
  }

  if (identityProof === "gtin") {
    confidence += 35;
    reasons.push("gtin-identity");
  } else if (identityProof === "brand-mpn") {
    confidence += 30;
    reasons.push("brand-mpn-identity");
  } else if (identityProof === "epid-brand") {
    confidence += 25;
    reasons.push("epid-brand-identity");
  } else if (isolatedVerifiedEbay) {
    // A title-only eBay discovery remains isolated by its immutable listing ID.
    // It cannot merge into another normalized product until stronger identity
    // evidence exists, so exact item verification is safe to publish as its own
    // catalog record without contaminating another product family.
    confidence += 30;
    reasons.push("isolated-ebay-listing");
  } else {
    reasons.push("weak-product-identity");
  }

  const strongBase = strongIdentityBaseKey(product);
  if (strongBase) {
    const siblings = (effectiveReviewIndex.strongBaseProducts.get(strongBase) || [])
      .filter(other => Number(other.id) !== Number(product.id));
    const ambiguousSibling = siblings.some(other =>
      !safeSameVariant(product.title, other.title, {
        brandA: product.brand || "",
        brandB: other.brand || "",
      }) &&
      !variantIdentityDiscriminator(product.title)
    );
    if (ambiguousSibling) {
      return {
        eligible: false,
        confidence: Math.min(100, confidence),
        reasons: [...reasons, "ambiguous-strong-identity-variant"],
      };
    }
  }

  const title = String(product.title || "").trim();
  if (title.length >= 8) {
    confidence += 8;
    reasons.push("usable-title");
  }
  if (String(product.category || "").trim() && String(product.category || "").toLowerCase() !== "other") {
    confidence += 4;
    reasons.push("classified-category");
  }
  if (String(product.imageUrl || best.imageUrl || "").trim()) {
    confidence += 4;
    reasons.push("product-image");
  }
  if (Number(best.score || 0) >= 40) {
    confidence += 4;
    reasons.push("usable-offer-score");
  }

  confidence = Math.min(100, Math.max(0, confidence));
  const threshold = draftAutoApprovalThreshold();
  if (confidence < threshold) reasons.push(`confidence-below-${threshold}`);

  return {
    eligible: confidence >= threshold,
    confidence,
    threshold,
    reasons,
    bestOfferId: Number(best.id),
    provider,
    identityProof: identityProof || (isolatedVerifiedEbay ? "isolated-ebay-listing" : ""),
  };
}

function pendingVerificationEnabled() {
  return String(process.env.PENDING_VERIFICATION_FALLBACK_ENABLED || "true").toLowerCase() !== "false";
}

function pendingVerificationThreshold() {
  return Math.min(
    Math.max(Number(process.env.PENDING_VERIFICATION_MIN_CONFIDENCE || 70), 60),
    100
  );
}

function pendingVerificationMaxObservationAgeMs() {
  const hours = Math.min(
    Math.max(Number(process.env.PENDING_VERIFICATION_MAX_AGE_HOURS || 72), 1),
    24 * 14
  );
  return hours * 60 * 60 * 1000;
}

function evaluatePendingVerificationVisibilityInDb(
  data,
  product,
  lookup = null,
  reviewIndex = null,
  { allowConditionExcluded = false } = {}
) {
  const reasons = [];
  let confidence = 0;

  if (!pendingVerificationEnabled()) {
    return { eligible: false, confidence: 0, reasons: ["pending-fallback-disabled"] };
  }
  if (!product) return { eligible: false, confidence: 0, reasons: ["missing-product"] };
  if (product.approved) return { eligible: false, confidence: 100, reasons: ["already-approved"] };
  if (String(product.lifecycleState || "ACTIVE").toUpperCase() !== "ACTIVE") {
    return { eligible: false, confidence: 0, reasons: ["not-active"] };
  }
  if (product.autoApprovalBlocked || product.manualReviewTouchedAt) {
    return { eligible: false, confidence: 0, reasons: ["manual-review-lock"] };
  }
  if (isExplicitProduct(product)) {
    return { eligible: false, confidence: 0, reasons: ["explicit-product"] };
  }

  const canonical = String(product.canonicalKey || "");
  if (!canonical) {
    return { eligible: false, confidence: 0, reasons: ["missing-canonical-key"] };
  }

  const effectiveReviewIndex = reviewIndex || buildDraftAutoReviewIndex(data);
  if (Number(effectiveReviewIndex.canonicalCounts.get(canonical) || 0) > 1) {
    return { eligible: false, confidence: 0, reasons: ["duplicate-canonical-owner"] };
  }

  const effectiveLookup = lookup || getRuntimeOfferLookup(data);
  const candidateOffers = allowConditionExcluded
    ? identityTrustedOffersFor(data, product.id, effectiveLookup)
    : trustedOffersFor(data, product.id, effectiveLookup);
  const offers = candidateOffers
    .filter(offer =>
      String(offer.provider || "").toLowerCase() === "ebay" &&
      (!offer.priceVerifiedAt || (allowConditionExcluded && isBrokenOrPartsListing(offer))) &&
      (allowConditionExcluded || intelligenceEligibleListing(offer)) &&
      offer.availability !== "out_of_stock" &&
      !offer.priceDisplayRestricted &&
      Number.isFinite(Number(offer.price)) &&
      Number(offer.price) > 0 &&
      String(offer.affiliateUrl || "").trim()
    );

  if (!offers.length) {
    return { eligible: false, confidence: 0, reasons: ["no-pending-ebay-source"] };
  }

  const primary = primaryEbayOfferFor(data, product, effectiveLookup);
  const offer = primary && offers.some(item => Number(item.id) === Number(primary.id))
    ? primary
    : offers[0];

  const trust = ebayOfferTrust(data, product, offer, {
    lookup: effectiveLookup,
  });
  if (!trust.trusted || trust.role !== "source") {
    return {
      eligible: false,
      confidence: 0,
      reasons: ["pending-offer-not-canonical-source"],
    };
  }

  const observedAt = Date.parse(
    offer.searchObservedAt ||
    offer.lastSeen ||
    product.updatedAt ||
    product.createdAt ||
    ""
  );
  if (
    !Number.isFinite(observedAt) ||
    Date.now() - observedAt > pendingVerificationMaxObservationAgeMs()
  ) {
    return {
      eligible: false,
      confidence: 0,
      reasons: ["pending-observation-stale"],
    };
  }

  confidence += 45;
  reasons.push("trusted-ebay-source-listing");

  const identityProof = productEbayIdentityProofType(product);
  const isolatedListing = canonical.startsWith("listing:ebay:");

  if (identityProof === "gtin") {
    confidence += 35;
    reasons.push("gtin-identity");
  } else if (identityProof === "brand-mpn") {
    confidence += 30;
    reasons.push("brand-mpn-identity");
  } else if (identityProof === "epid-brand") {
    confidence += 25;
    reasons.push("epid-brand-identity");
  } else if (isolatedListing) {
    // Listing isolation prevents an unverified eBay search observation from
    // contaminating another canonical product while exact item detail is
    // unavailable. It is displayable only as a clearly pending source listing.
    confidence += 20;
    reasons.push("isolated-ebay-listing");
  } else {
    return {
      eligible: false,
      confidence,
      reasons: [...reasons, "weak-product-identity"],
    };
  }

  const strongBase = strongIdentityBaseKey(product);
  if (strongBase) {
    const siblings = (effectiveReviewIndex.strongBaseProducts.get(strongBase) || [])
      .filter(other => Number(other.id) !== Number(product.id));
    const ambiguousSibling = siblings.some(other =>
      !safeSameVariant(product.title, other.title, {
        brandA: product.brand || "",
        brandB: other.brand || "",
      }) &&
      !variantIdentityDiscriminator(product.title)
    );
    if (ambiguousSibling) {
      return {
        eligible: false,
        confidence: Math.min(100, confidence),
        reasons: [...reasons, "ambiguous-strong-identity-variant"],
      };
    }
  }

  const title = String(product.title || offer.listingTitle || "").trim();
  if (title.length >= 8) {
    confidence += 8;
    reasons.push("usable-title");
  }
  if (String(product.category || "").trim() &&
      String(product.category || "").toLowerCase() !== "other") {
    confidence += 4;
    reasons.push("classified-category");
  }
  if (String(product.imageUrl || offer.imageUrl || "").trim()) {
    confidence += 4;
    reasons.push("product-image");
  }
  if (Number(offer.score || 0) >= 40) {
    confidence += 4;
    reasons.push("usable-offer-score");
  }

  confidence = Math.min(100, Math.max(0, confidence));
  const threshold = pendingVerificationThreshold();
  if (confidence < threshold) reasons.push(`confidence-below-${threshold}`);

  return {
    eligible: confidence >= threshold,
    confidence,
    threshold,
    reasons,
    offerId: Number(offer.id),
    provider: "ebay",
    identityProof: identityProof || (isolatedListing ? "isolated-ebay-listing" : ""),
    observedAt: new Date(observedAt).toISOString(),
    conditionExcluded: isBrokenOrPartsListing(offer),
    conditionExclusionReason: listingConditionExclusionReason(offer),
    exactVerified: Boolean(offer.priceVerifiedAt),
  };
}

export function inspectDraftAutoApproval(productId) {
  const data = readDb();
  const product = data.products.find(item => Number(item.id) === Number(productId));
  if (!product) return null;
  const lookup = getRuntimeOfferLookup(data);
  const reviewIndex = getRuntimeDraftAutoReviewIndex(data);
  return evaluateDraftAutoApprovalInDb(data, product, lookup, reviewIndex);
}

export function autoApproveConfidentDrafts({
  productIds = null,
  limit = Number(process.env.DRAFT_AUTO_APPROVE_BATCH || 200),
  reason = "background-review",
  deferPersistence = true,
  lookup = null,
  reviewIndex = null,
} = {}) {
  const enabled = String(process.env.DRAFT_AUTO_APPROVE_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    return { enabled: false, scanned: 0, approved: [], skipped: { disabled: 1 } };
  }

  const data = readDb();
  const requestedIds = productIds == null
    ? null
    : new Set(Array.from(productIds || []).map(Number).filter(Number.isFinite));
  const cap = Math.min(Math.max(Number(limit || 200), 1), 2000);
  const maxAgeMs = draftAutoApprovalMaxAgeMs();
  const now = Date.now();
  // Scheduled sweeps used to revisit the same exact-unverified eBay drafts every
  // minute. Interactive/source-verification calls pass productIds and bypass
  // this backoff, while unchanged deferred drafts cool down before another scan.
  const deferredRetryMs = requestedIds == null
    ? Math.min(Math.max(Number(process.env.DRAFT_AUTO_REVIEW_DEFERRED_RETRY_MINUTES || 30), 1), 24 * 60) * 60_000
    : 0;

  const candidates = data.products
    .filter(product =>
      !product.approved &&
      String(product.lifecycleState || "ACTIVE").toUpperCase() === "ACTIVE" &&
      !product.autoApprovalBlocked &&
      !product.manualReviewTouchedAt &&
      (requestedIds == null || requestedIds.has(Number(product.id))) &&
      (deferredRetryMs <= 0 || !product.lastAutoReviewAt || now - (Date.parse(product.lastAutoReviewAt) || 0) >= deferredRetryMs) &&
      Number.isFinite(Date.parse(product.createdAt || product.updatedAt || "")) &&
      now - Date.parse(product.createdAt || product.updatedAt || "") <= maxAgeMs
    )
    .sort((a, b) => {
      const aReviewed = Date.parse(a.lastAutoReviewAt || "") || 0;
      const bReviewed = Date.parse(b.lastAutoReviewAt || "") || 0;
      return aReviewed - bReviewed ||
        Date.parse(a.createdAt || a.updatedAt || 0) - Date.parse(b.createdAt || b.updatedAt || 0) ||
        Number(a.id) - Number(b.id);
    })
    .slice(0, cap);

  const effectiveLookup = lookup || (requestedIds
    ? buildPageHydrationLookup(data, [...requestedIds], { approvedOnly: false, includeClicks: false })
    : getRuntimeOfferLookup(data));
  const effectiveReviewIndex = reviewIndex || getRuntimeDraftAutoReviewIndex(data);
  const approved = [];
  const skipped = {};
  const reviewedAt = nowIso();
  let reviewMetadataChanged = false;

  for (const product of candidates) {
    const verdict = evaluateDraftAutoApprovalInDb(data, product, effectiveLookup, effectiveReviewIndex);
    if (!verdict.eligible) {
      const key = verdict.reasons?.at(-1) || "not-confident";
      skipped[key] = Number(skipped[key] || 0) + 1;
      product.lastAutoReviewAt = reviewedAt;
      product.lastAutoReviewDecision = "deferred";
      product.lastAutoReviewReason = String((verdict.reasons || []).join(", ")).slice(0, 500);
      product.autoApprovalConfidence = Number(verdict.confidence || 0);
      reviewMetadataChanged = true;
      continue;
    }

    product.approved = true;
    product.updatedAt = reviewedAt;
    product.approvedAt = reviewedAt;
    product.approvalSource = "auto-confidence";
    product.autoApprovalBlocked = false;
    product.lastAutoReviewAt = reviewedAt;
    product.lastAutoReviewDecision = "approved";
    product.lastAutoReviewReason = String(verdict.reasons.join(", ")).slice(0, 500);
    product.autoApprovalConfidence = verdict.confidence;
    approved.push(Number(product.id));
  }

  DRAFT_AUTO_REVIEW_STATUS.lastRunAt = reviewedAt;
  DRAFT_AUTO_REVIEW_STATUS.lastReason = String(reason || "background-review").slice(0, 120);
  DRAFT_AUTO_REVIEW_STATUS.lastScanned = candidates.length;
  DRAFT_AUTO_REVIEW_STATUS.lastApproved = approved.length;
  DRAFT_AUTO_REVIEW_STATUS.approvedTotal += approved.length;
  DRAFT_AUTO_REVIEW_STATUS.lastSkipped = skipped;

  if (approved.length) {
    SEARCH_INDEX_REVISION++;
  }

  if (approved.length || reviewMetadataChanged) {
    if (deferPersistence) {
      scheduleDeferredWrite(data, MUTATION_BUFFER_WINDOW_MS);
    } else {
      writeDb(data);
    }
  }

  if (approved.length) {
    publishProductLiveMutation(data, {
      type: "catalog",
      reason: "confident-drafts-auto-approved",
      productIds: approved,
      metadata: {
        approved: approved.length,
        scanned: candidates.length,
        source: reason,
        minConfidence: draftAutoApprovalThreshold(),
      },
    });
  }

  return {
    enabled: true,
    scanned: candidates.length,
    approved,
    skipped,
    minConfidence: draftAutoApprovalThreshold(),
    maxAgeHours: Math.round(maxAgeMs / 3_600_000),
  };
}

export function getDraftAutoReviewStatus() {
  const data = readDb();
  const maxAgeMs = draftAutoApprovalMaxAgeMs();
  const now = Date.now();
  const drafts = data.products.filter(product =>
    !product.approved && String(product.lifecycleState || "ACTIVE").toUpperCase() === "ACTIVE"
  );
  const recentUnlocked = drafts.filter(product => {
    const createdMs = Date.parse(product.createdAt || product.updatedAt || "");
    return !product.autoApprovalBlocked &&
      !product.manualReviewTouchedAt &&
      Number.isFinite(createdMs) &&
      now - createdMs <= maxAgeMs;
  });

  return {
    enabled: String(process.env.DRAFT_AUTO_APPROVE_ENABLED || "true").toLowerCase() !== "false",
    intervalMinutes: Math.max(1, Number(process.env.DRAFT_AUTO_APPROVE_MINUTES || 1)),
    batch: Math.min(Math.max(Number(process.env.DRAFT_AUTO_APPROVE_BATCH || 200), 1), 2000),
    minConfidence: draftAutoApprovalThreshold(),
    maxAgeHours: Math.round(maxAgeMs / 3_600_000),
    activeDrafts: drafts.length,
    recentUnlockedDrafts: recentUnlocked.length,
    manualLockedDrafts: drafts.filter(product => product.autoApprovalBlocked || product.manualReviewTouchedAt).length,
    ...DRAFT_AUTO_REVIEW_STATUS,
  };
}

export const __boundaryHardeningTest = {
  safeHttpUrl,
  finiteNumberOrNull,
  boundedText,
};

export const __bestOfferSelectionTest = {
  offerVerificationRank,
  rankEligibleDisplayOffers,
};

export const __normalizationRepairTest = {
  mergeStrongEvidenceListingDuplicates,
};

export const __draftAutoApprovalTest = {
  evaluateDraftAutoApprovalInDb,
  evaluatePendingVerificationVisibilityInDb,
  getDraftSearchCandidatesInDb,
  hydratePendingVerificationProductInDb,
  threshold: draftAutoApprovalThreshold,
  pendingThreshold: pendingVerificationThreshold,
  pendingEnabled: pendingVerificationEnabled,
};

export function autoApproveFromRule(productIds, rule, { deferPersistence = false } = {}) {
  if (!rule?.autoApprove) return [];
  const data = readDb();
  const approved = [];
  const targetIds = new Set(
    Array.from(productIds || []).map(Number).filter(Number.isFinite)
  );
  const lookup = buildPageHydrationLookup(data, [...targetIds], {
    approvedOnly: false,
    includeClicks: false,
  });

  for (const productId of targetIds) {
    const product = lookup.productByNumericId.get(Number(productId));
    if (!product || product.approved || product.autoApprovalBlocked) continue;
    const best = bestOfferFor(data, product.id, lookup);
    if (!best) continue;

    if (
      String(best.provider).toLowerCase() === "ebay" &&
      !best.priceVerifiedAt
    ) {
      continue;
    }

    if (!snapshotStatsLookValid(product.cachedPriceStats) && Number(rule.minHeat || 0) > 0) {
      maybeQueueProductSnapshot(product, {
        priority: "background",
        reason: "auto-approve-needs-fresh-heat",
      });
      continue;
    }

    const stats = fallbackPriceStats(product, best);
    const markdown = discountPercent(best.price, best.originalPrice);
    const commission = Number(best.commissionRate || 0);

    if (Number(best.score || 0) < Number(rule.minScore || 0)) continue;
    if (Number(stats.dealHeat || 0) < Number(rule.minHeat || 0)) continue;
    if (markdown < Number(rule.minDiscount || 0)) continue;
    if (commission < Number(rule.minCommissionRate || 0)) continue;

    const approvedAt = nowIso();
    product.approved = true;
    product.updatedAt = approvedAt;
    product.approvedAt = approvedAt;
    product.approvalSource = "auto-rule";
    product.autoApprovalBlocked = false;
    product.lastAutoReviewAt = approvedAt;
    product.lastAutoReviewDecision = "approved";
    product.lastAutoReviewReason = `Discovery rule ${Number(rule?.id || 0) || "automatic"} passed its publication thresholds.`;
    product.autoApprovalConfidence = Math.max(Number(product.autoApprovalConfidence || 0), 80);
    approved.push(product.id);
  }

  if (approved.length) {
    SEARCH_INDEX_REVISION++;
    if (deferPersistence) {
      scheduleDeferredWrite(data, MUTATION_BUFFER_WINDOW_MS);
    } else {
      writeDb(data);
    }

    publishProductLiveMutation(data, {
      type: "catalog",
      reason: "rule-auto-approved",
      productIds: approved,
      metadata: {
        approved: approved.length,
        ruleId: Number(rule?.id || 0) || null,
      },
    });
  }
  return approved;
}
