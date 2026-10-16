import {
  autoApproveConfidentDrafts,
  countPublicSearchMatches,
  getPublicSearchMatchIds,
  createDiscoveryRule,
  getDiscoveryRules,
  getDraftSearchCandidates,
  getProduct,
  getProductRecord,
  getProductRecordsByIds,
  ingestCandidates,
} from "../lib/db.js";
import { searchEbayAndRakuten } from "./marketplaceSearch.js";
import { verifyEbayExternalIds } from "./ebayPriceVerifier.js";
import {
  scanEbayCompetitorsForProduct,
  scanEbayCompetitorsProgressivelyForProduct,
  enqueueEbayCompetitorBackgroundProducts,
} from "./ebayCompetitorScanner.js";
import { publishLiveEvent } from "../lib/liveEvents.js";
import { opLog, opWarn, timedOp } from "../lib/opsLog.js";
import {
  getEbayRateGuardStatus,
  isEbayRateGuardError,
} from "../lib/ebayRateGuard.js";
import { searchRelevance, normalizeSearchText } from "../lib/searchRelevance.js";
import { isExplicitProduct, isExplicitSearchQuery } from "../lib/contentSafety.js";
import { isBrokenOrPartsListing } from "../lib/listingCondition.js";
import { generatePrecisionSearchVariants } from "./searchExpansion.js";
import { buildEbayGetItemsBatches } from "../lib/ebayBatching.js";
import { backgroundCheckpoint } from "../lib/requestPriority.js";
import { CATALOG_SHOPPER_PAGE_SIZE } from "./catalogSearchCore.js";

const LIVE_SEARCH_SHOPPER_PAGE_SIZE = CATALOG_SHOPPER_PAGE_SIZE;

const searchSessions = new Map();
const backgroundDiscoveryContinuations = new Map();
const backgroundDiscoveryWaiters = new Map();
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

function exhaustedRetryMs() {
  return Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_EXHAUSTED_RETRY_MINUTES || 15), 1),
    240
  ) * 60 * 1000;
}

function resetDiscoveryState(state) {
  state.pagesSearched = 0;
  state.exhausted = false;
  state.budgetExhausted = false;
  state.deferred = false;
  state.exhaustedAt = null;
  state.variantCursor = 0;
  state.variantStates = {};
  state.draftVerifyTried = new Set();
  state.backgroundNoGrowthSteps = 0;
  state.backgroundStopReason = "";
}

function maybeResetExhaustedSession(state) {
  if (!state?.exhaustedAt) return;
  if (Date.now() - Number(state.exhaustedAt || 0) < exhaustedRetryMs()) return;
  resetDiscoveryState(state);
  opLog("live-search", "expired search-exhaustion cache; query can be probed again", { query: state.query });
}


function sessionKey(query, category = "", includeParts = false) {
  return `${normalizeSearchText(query)}|${normalizeSearchText(category)}|${includeParts ? "parts" : "normal"}`;
}

function registerBackgroundDiscoveryWaiter(key, {
  interactionId = "",
  page = 1,
  sort = "heat",
  targetCount = LIVE_SEARCH_SHOPPER_PAGE_SIZE,
} = {}) {
  const safeInteractionId = String(interactionId || "").trim().slice(0, 96);
  if (!safeInteractionId) return false;

  let waiters = backgroundDiscoveryWaiters.get(key);
  if (!waiters) {
    waiters = new Map();
    backgroundDiscoveryWaiters.set(key, waiters);
  }
  waiters.set(safeInteractionId, {
    interactionId: safeInteractionId,
    page: Math.max(1, Number(page || 1)),
    sort: ["heat", "new", "price", "competitors"].includes(String(sort)) ? String(sort) : "heat",
    targetCount: Math.min(Math.max(Number(targetCount || LIVE_SEARCH_SHOPPER_PAGE_SIZE), 1), 2400),
  });
  return true;
}

function publishBackgroundDiscoveryReadyToWaiters({
  key,
  query,
  category = "",
  includeParts = false,
  currentCount = 0,
  state,
  reason = "background-page-fill-complete",
  productIds = [],
} = {}) {
  const waiters = backgroundDiscoveryWaiters.get(key);
  if (!waiters?.size) return 0;

  let published = 0;
  for (const waiter of waiters.values()) {
    const ready =
      Number(currentCount || 0) >= Number(waiter.targetCount || 0) ||
      Boolean(state?.exhausted) ||
      Boolean(state?.budgetExhausted) ||
      Boolean(state?.deferred);
    if (!ready) continue;

    publishLiveEvent("hydration", {
      phase: "discovery-results-ready",
      interactionId: waiter.interactionId,
      query: String(query || "").trim(),
      category: category || "",
      sort: waiter.sort,
      page: waiter.page,
      pageSize: LIVE_SEARCH_SHOPPER_PAGE_SIZE,
      reason: `${reason}-shopper-handoff`,
      currentCount: Number(currentCount || 0),
      targetCount: waiter.targetCount,
      productIds: [...new Set((productIds || []).map(Number).filter(Number.isFinite))].slice(0, waiter.targetCount),
      includeParts: Boolean(includeParts),
      background: false,
      continuationHandoff: true,
    }, { audience: "public" });
    published += 1;
  }

  backgroundDiscoveryWaiters.delete(key);
  return published;
}

function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, state] of searchSessions) {
    if (Number(state.lastUsedAt || 0) < cutoff) searchSessions.delete(key);
  }
}

function getOrCreateSession(query, category = "", includeParts = false) {
  pruneSessions();
  const key = sessionKey(query, category, includeParts);
  let state = searchSessions.get(key);
  if (!state) {
    state = {
      key,
      query: String(query || "").trim(),
      category: String(category || "").trim(),
      includeParts: Boolean(includeParts),
      pagesSearched: 0,
      exhausted: false,
      budgetExhausted: false,
      deferred: false,
      exhaustedAt: null,
      variantCursor: 0,
      variantStates: {},
      draftVerifyTried: new Set(),
      backgroundNoGrowthSteps: 0,
      backgroundStopReason: "",
      lastUsedAt: Date.now(),
    };
    searchSessions.set(key, state);
  }
  maybeResetExhaustedSession(state);
  state.lastUsedAt = Date.now();
  return state;
}

export function getUserSearchDiscoveryState({ query = "", category = "", includeParts = false } = {}) {
  const key = sessionKey(query, category, includeParts);
  const state = searchSessions.get(key);
  if (!state) {
    return {
      searched: false,
      pagesSearched: 0,
      exhausted: false,
      budgetExhausted: false,
      deferred: false,
      canDiscoverMore: true,
      backgroundActive: backgroundDiscoveryContinuations.has(key),
    };
  }
  maybeResetExhaustedSession(state);
  state.lastUsedAt = Date.now();
  const variants = Object.values(state.variantStates || {});
  return {
    searched: state.pagesSearched > 0,
    pagesSearched: state.pagesSearched,
    exhausted: Boolean(state.exhausted),
    budgetExhausted: Boolean(state.budgetExhausted),
    deferred: Boolean(state.deferred),
    canDiscoverMore: !state.exhausted && !state.budgetExhausted,
    backgroundActive: backgroundDiscoveryContinuations.has(key),
    variantsTried: variants.filter(item => Number(item.pages || 0) > 0).length,
    retryAfterMs: state.exhaustedAt
      ? Math.max(0, exhaustedRetryMs() - (Date.now() - Number(state.exhaustedAt)))
      : 0,
  };
}

function ensureUserSearchRule(query, category, { deferPersistence = true } = {}) {
  const enabled =
    String(process.env.LIVE_SEARCH_ENABLED || "true").toLowerCase() === "true";
  if (!enabled || isExplicitSearchQuery(query)) return null;

  const normalized = normalizeSearchText(query);
  if (normalized.length < 2) return null;

  const existing = getDiscoveryRules().find(rule =>
    rule.provider === "ebay" &&
    normalizeSearchText(rule.query) === normalized
  );

  if (existing) return existing;

  const userRules = getDiscoveryRules()
    .filter(rule => String(rule.name || "").startsWith("User search · "));

  const cap = Math.max(
    10,
    Number(process.env.USER_SEARCH_RULE_LIMIT || 120)
  );

  if (userRules.length >= cap) {
    opWarn("live-search", "user-search rule cap reached; not persisting another query", {
      cap,
      query,
    });
    return null;
  }

  const rule = createDiscoveryRule({
    name: `User search · ${query}`,
    provider: "ebay",
    query,
    categoryOverride: category || "",
    limit: Math.min(
      Math.max(Number(process.env.DISCOVERY_RESULTS_PER_RULE || 50), 20),
      100
    ),
    enabled: true,
    autoApprove: true,
    starter: false,
    generated: true,
    generationDepth: 0,
    familyKey: "",
    minScore: 0,
    minHeat: 0,
    minDiscount: 0,
    minCommissionRate: 0,
  }, { deferPersistence });

  opLog("live-search", "persisted user query as discovery rule", {
    ruleId: rule.id,
    query,
    category: category || "automatic",
  });

  return rule;
}

function variantStateFor(state, variant) {
  const key = normalizeSearchText(variant.query);
  if (!state.variantStates[key]) {
    state.variantStates[key] = {
      query: variant.query,
      reason: variant.reason || "recall",
      nextOffset: 0,
      pages: 0,
      exhausted: false,
    };
  }
  return state.variantStates[key];
}

function nextSearchVariant(state, plan) {
  if (!plan.length) return null;
  for (let attempt = 0; attempt < plan.length; attempt++) {
    const index = (Number(state.variantCursor || 0) + attempt) % plan.length;
    const variant = plan[index];
    const local = variantStateFor(state, variant);
    if (local.exhausted) continue;
    state.variantCursor = (index + 1) % plan.length;
    return { variant, local };
  }
  return null;
}

async function promoteMatchingDraftsForSearch({
  query,
  category = "",
  state,
  verifyLimit = 100,
  fastFirstPaint = false,
} = {}) {
  // V3.7.46: a zero-result shopper search is a first-paint path, not a backlog
  // curator. Review/verify only a small query-local slice so old drafts cannot
  // monopolize the server before any result card is visible. The scheduled
  // verifier retains ownership of the remaining draft backlog.
  const reviewLimit = fastFirstPaint
    ? Math.min(Math.max(Number(process.env.LIVE_SEARCH_FIRST_PAINT_DRAFT_REVIEW_LIMIT || 80), 1), 240)
    : Math.min(Math.max(Number(process.env.LIVE_SEARCH_DRAFT_REVIEW_LIMIT || 400), 1), 2000);
  const verifyCap = fastFirstPaint
    ? Math.min(Math.max(Number(process.env.LIVE_SEARCH_FIRST_PAINT_DRAFT_VERIFY_LIMIT || 6), 1), 20)
    : Math.min(Math.max(Number(process.env.LIVE_SEARCH_DRAFT_VERIFY_LIMIT || verifyLimit || 100), 1), 400);
  const maxApiCalls = fastFirstPaint
    ? Math.min(Math.max(Number(process.env.LIVE_SEARCH_FIRST_PAINT_DRAFT_API_CALLS || 1), 1), 2)
    : Math.min(Math.max(Number(process.env.LIVE_SEARCH_DRAFT_VERIFY_MAX_API_CALLS || 6), 1), 20);
  // Select against the real 20-single / 10-variation getItems packing rules
  // rather than the old worst-case 10-per-call cap. This lets a shopper use
  // every permitted bulk slot without marking IDs as attempted unless they are
  // actually scheduled inside this request's call budget.
  const effectiveVerifyCap = Math.min(verifyCap, maxApiCalls * 20);

  const matches = getDraftSearchCandidates({
    q: query,
    category,
    limit: reviewLimit,
  });

  if (!matches.length) {
    return {
      matchedDrafts: 0,
      approvedBeforeVerification: 0,
      approvedAfterVerification: 0,
      verificationSelected: 0,
      verified: 0,
      approvedProductIds: [],
      failures: [],
    };
  }

  const productIds = [...new Set(matches.map(item => Number(item.productId)).filter(Number.isFinite))];
  const before = autoApproveConfidentDrafts({
    productIds,
    limit: productIds.length,
    reason: "interactive-search-preflight",
    deferPersistence: true,
  });

  if (fastFirstPaint) {
    // First paint never spends marketplace calls draining an old verification
    // backlog. Already-exact-safe drafts can publish from local state; every
    // unresolved draft remains owned by the scheduled verifier. If eBay returns
    // the same listing for this shopper, it will be source-verified naturally
    // in the query-local marketplace path below.
    opLog("live-search", "first-paint draft preflight stayed local-only", {
      query,
      matchedDrafts: matches.length,
      approved: Number(before.approved?.length || 0),
    });
    return {
      matchedDrafts: matches.length,
      approvedBeforeVerification: Number(before.approved?.length || 0),
      approvedAfterVerification: 0,
      verificationSelected: 0,
      verified: 0,
      approvedProductIds: [...new Set((before.approved || []).map(Number).filter(Number.isFinite))],
      failures: [],
      firstPaintReady: Number(before.approved?.length || 0) > 0,
    };
  }

  state.draftVerifyTried ||= new Set();
  const candidateExternalIds = [];
  for (const match of matches) {
    for (const externalId of match.ebayExternalIds || []) {
      const key = String(externalId || "").trim();
      if (!key || state.draftVerifyTried.has(key) || candidateExternalIds.includes(key)) continue;
      candidateExternalIds.push(key);
      if (candidateExternalIds.length >= effectiveVerifyCap) break;
    }
    if (candidateExternalIds.length >= effectiveVerifyCap) break;
  }

  const verificationBatches = buildEbayGetItemsBatches(candidateExternalIds)
    .slice(0, maxApiCalls);
  const externalIds = verificationBatches.flatMap(batch => batch.ids);
  for (const externalId of externalIds) state.draftVerifyTried.add(externalId);

  let verification = { verified: 0, failures: [], selected: 0, deferred: 0 };
  if (externalIds.length) {
    verification = await verifyEbayExternalIds(externalIds, {
      priority: "interactive",
      maxApiCalls,
      deferPersistence: true,
    });
  }

  // Exact verification already re-runs the confidence gate for touched eBay
  // products. The legacy/non-first-paint path keeps its explicit final pass for
  // compatibility, while V3.7.46 first-paint discovery avoids rebuilding the
  // full draft-review indexes a second time after the verifier already did it.
  const after = fastFirstPaint
    ? { approved: [] }
    : autoApproveConfidentDrafts({
        productIds,
        limit: productIds.length,
        reason: "interactive-search-post-verify",
        deferPersistence: true,
      });

  opLog("live-search", "current-query draft batch reviewed before marketplace expansion", {
    query,
    matchedDrafts: matches.length,
    verifiedEbay: Number(verification.verified || 0),
    verificationSelected: Number(verification.selected || externalIds.length),
    approved: Number(before.approved?.length || 0) + Number(after.approved?.length || 0),
  });

  return {
    matchedDrafts: matches.length,
    approvedBeforeVerification: Number(before.approved?.length || 0),
    approvedAfterVerification: Number(after.approved?.length || 0),
    verificationSelected: Number(verification.selected || externalIds.length),
    verified: Number(verification.verified || 0),
    approvedProductIds: [...new Set([
      ...(before.approved || []),
      ...(after.approved || []),
    ].map(Number).filter(Number.isFinite))],
    failures: verification.failures || [],
    firstPaintReady:
      fastFirstPaint &&
      (Number(before.approved?.length || 0) + Number(after.approved?.length || 0) > 0),
  };
}

function competitorPageFailurePolicy(error) {
  const quotaDeferred = isEbayRateGuardError(error);
  return {
    quotaDeferred,
    haltPage: quotaDeferred,
    continuePage: !quotaDeferred,
  };
}

async function hydrateInteractiveCompetitorCoverageForPage({
  query = "",
  category = "",
  sort = "heat",
  page = 1,
  pageSize = LIVE_SEARCH_SHOPPER_PAGE_SIZE,
  visibleProductIds = [],
  jobControl = null,
  interactionId = "",
  includeParts = false,
} = {}) {
  const enabled =
    String(process.env.LIVE_SEARCH_COMPETITOR_HYDRATE_ENABLED || "true").toLowerCase() !== "false";
  const safePage = Math.max(1, Number(page || 1));
  const safePageSize = LIVE_SEARCH_SHOPPER_PAGE_SIZE;
  const preferredVisibleIds = [...new Set(
    (Array.isArray(visibleProductIds) ? visibleProductIds : [])
      .map(Number)
      .filter(Number.isFinite)
  )].slice(0, safePageSize);

  if (!enabled) {
    return {
      enabled: false,
      page: safePage,
      pageSize: safePageSize,
      pageProducts: preferredVisibleIds.length,
      selected: 0,
      attempted: 0,
      scanned: 0,
      matched: 0,
      pendingQueued: 0,
      deferred: 0,
      complete: true,
      failures: [],
    };
  }

  // V3.7.47: the browser owns the authoritative visible page. Do not re-run the
  // catalog worker before or during hydration: doing so used to add worker/index
  // latency to first interaction and could reshuffle cards underneath the blue
  // cursor. Read only the exact product IDs already painted in the DOM, process
  // stale/unresearched cards sequentially, then let the browser perform one
  // full-query re-sort after the pass completes.
  const signalCap = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_COMPETITOR_SIGNALS || 5), 1),
    5
  );
  const exactCandidateCap = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_COMPETITOR_EXACT_CANDIDATES || 6), 1),
    20
  );
  const targetSellers = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_COMPETITOR_TARGET_SELLERS || 3), 2),
    8
  );
  const freshnessMinutes = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_COMPETITOR_PAGE_FRESH_MINUTES || 60), 1),
    24 * 60
  );
  const freshnessMs = freshnessMinutes * 60_000;
  const passId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const safeInteractionId = String(interactionId || "").trim().slice(0, 96);
  const superseded = () => {
    try { return Boolean(jobControl?.isSuperseded?.()); }
    catch { return false; }
  };

  function queueForBackground(productIds, reason = "shopper-page-superseded") {
    return enqueueEbayCompetitorBackgroundProducts(
      [...new Set((productIds || []).map(Number).filter(Number.isFinite))],
      { reason }
    );
  }

  function coverageState(product, now = Date.now()) {
    const competition = product?.ebayCompetition || {};
    const completeAt = Date.parse(String(
      competition.coverageCompleteAt || product?.ebayCompetitorCoverageCompleteAt || ""
    ));
    const completedTarget = Math.max(0, Number(
      competition.coverageTargetSellers || product?.ebayCompetitorCoverageTargetSellers || 0
    ));
    const researched = Number.isFinite(completeAt) && completedTarget >= targetSellers;
    const stale = researched && now - completeAt >= freshnessMs;
    return {
      due: !researched || stale,
      researched,
      stale,
      unresearched: !researched,
      completeAt: Number.isFinite(completeAt) ? completeAt : 0,
      completedTarget,
    };
  }

  function currentCompetitionCounts(productOrId) {
    const productId = Number(productOrId?.id ?? productOrId);
    const hydrated = Number.isFinite(productId)
      ? getProduct(productId, true, { includeHistory: false })
      : null;
    const source = hydrated || productOrId || {};
    const competition = source?.ebayCompetition || {};
    const sellerCount = Number(competition.sellerCount);
    const listingCount = Number(competition.listingCount);
    return {
      sellerCount: Number.isFinite(sellerCount) && sellerCount >= 0
        ? sellerCount
        : Math.max(0, Number(source?.cachedVerifiedSellerCount || 0)),
      listingCount: Number.isFinite(listingCount) && listingCount >= 0
        ? listingCount
        : 0,
    };
  }

  function currentSellerCount(productOrId) {
    return currentCompetitionCounts(productOrId).sellerCount;
  }

  function publishHydration(phase, payload = {}) {
    publishLiveEvent("hydration", {
      ...payload,
      phase,
      passId,
      interactionId: safeInteractionId,
      query,
      category: category || "",
      sort,
      page: safePage,
      pageSize: safePageSize,
      targetSellers,
      includeParts: Boolean(includeParts),
    }, { audience: "public" });
  }

  const visibleProducts = getProductRecordsByIds(preferredVisibleIds, true);
  // Condition-exception inventory can be shown when explicitly requested, but
  // it never enters the normal competitor-intelligence lane.
  const eligibleVisibleProducts = visibleProducts.filter(product => !isBrokenOrPartsListing(product));
  const products = eligibleVisibleProducts.filter(product => coverageState(product).due);
  const dueStates = products.map(product => coverageState(product));
  const staleProducts = dueStates.filter(state => state.stale).length;
  const unresearchedProducts = dueStates.filter(state => state.unresearched).length;
  const freshCoverageReused = Math.max(0, eligibleVisibleProducts.length - products.length);

  const attemptedIds = new Set();
  const completedIds = new Set();
  const incompleteIds = new Set();
  const failures = [];
  let matched = 0;
  let pendingQueued = 0;
  let scanned = 0;
  let deferred = 0;
  let halted = false;
  let demoted = false;

  opLog("live-search", "hydrating fixed shopper-visible competitor page", {
    query,
    category: category || null,
    sort,
    page: safePage,
    pageSize: safePageSize,
    visibleProducts: preferredVisibleIds.length,
    publicProductsResolved: visibleProducts.length,
    productsNeedingCoverage: products.length,
    staleProducts,
    unresearchedProducts,
    freshCoverageReused,
    targetSellers,
    signalCap,
    exactCandidateCap,
    freshnessMinutes,
    order: "fixed-browser-dom",
  });

  if (superseded()) {
    const queued = queueForBackground(products.map(product => product.id), "shopper-navigation-before-hydration");
    publishHydration("page-demoted", {
      visibleProducts: preferredVisibleIds.length,
      queuedBackground: queued.queued,
      reason: "shopper-navigation",
    });
    return {
      enabled: true,
      passId,
      page: safePage,
      pageSize: safePageSize,
      pageProducts: preferredVisibleIds.length,
      selected: products.length,
      attempted: 0,
      scanned: 0,
      matched: 0,
      pendingQueued: 0,
      deferred: 0,
      complete: false,
      demoted: true,
      failures: [],
    };
  }

  publishHydration("page-start", {
    visibleProducts: preferredVisibleIds.length,
    productsNeedingCoverage: products.length,
    scanTotal: products.length,
    staleProducts,
    unresearchedProducts,
    freshCoverageReused,
    completed: 0,
  });

  for (let productIndex = 0; productIndex < products.length; productIndex++) {
    const product = products[productIndex];
    const productId = Number(product.id);
    const displayIndex = Math.max(0, preferredVisibleIds.indexOf(productId));

    if (superseded()) {
      const queued = queueForBackground(
        products.slice(productIndex).map(item => item.id),
        "shopper-navigation-before-next-product"
      );
      demoted = true;
      halted = true;
      publishHydration("page-demoted", {
        productId,
        displayIndex,
        displayNumber: displayIndex + 1,
        visibleProducts: preferredVisibleIds.length,
        scanIndex: productIndex,
        scanNumber: productIndex + 1,
        scanTotal: products.length,
        completed: completedIds.size,
        queuedBackground: queued.queued,
        reason: "shopper-navigation",
      });
      break;
    }

    attemptedIds.add(productId);
    const countsBefore = currentCompetitionCounts(productId);
    const sellerCountBefore = countsBefore.sellerCount;
    const listingCountBefore = countsBefore.listingCount;
    const productCoverageState = coverageState(product);
    publishHydration("product-start", {
      productId,
      title: product.title || "",
      displayIndex,
      displayNumber: displayIndex + 1,
      visibleProducts: preferredVisibleIds.length,
      scanIndex: productIndex,
      scanNumber: productIndex + 1,
      scanTotal: products.length,
      completed: completedIds.size,
      sellerCount: sellerCountBefore,
      listingCount: listingCountBefore,
      coverageReason: productCoverageState.stale ? "stale" : "unresearched",
    });

    let result;
    try {
      result = await scanEbayCompetitorsProgressivelyForProduct(product, {
        priority: "interactive",
        targetSellers,
        maxSignals: signalCap,
        maxExactCandidates: exactCandidateCap,
        deferPersistence: true,
        onProgress(progress) {
          publishHydration("product-progress", {
            productId,
            title: product.title || "",
            displayIndex,
            displayNumber: displayIndex + 1,
            visibleProducts: preferredVisibleIds.length,
        scanIndex: productIndex,
        scanNumber: productIndex + 1,
        scanTotal: products.length,
            completed: completedIds.size,
            ...progress,
          });
        },
        shouldStop: superseded,
        forceCoverageRefresh: true,
      });
    } catch (error) {
      const failurePolicy = competitorPageFailurePolicy(error);
      const rateDeferred = failurePolicy.quotaDeferred;
      const countsAfterError = currentCompetitionCounts(productId);
      incompleteIds.add(productId);
      if (rateDeferred) deferred++;
      failures.push({
        productId,
        error: error?.message || String(error),
        deferred: rateDeferred,
      });
      opWarn("live-search", "interactive page competitor coverage failed for one product", {
        productId,
        deferred: rateDeferred,
        continuePage: failurePolicy.continuePage,
        error: error?.message || String(error),
      });
      publishHydration(rateDeferred ? "page-paused" : "product-error", {
        productId,
        title: product.title || "",
        displayIndex,
        displayNumber: displayIndex + 1,
        visibleProducts: preferredVisibleIds.length,
        scanIndex: productIndex,
        scanNumber: productIndex + 1,
        scanTotal: products.length,
        completed: completedIds.size,
        sellerCount: countsAfterError.sellerCount,
        listingCount: countsAfterError.listingCount,
        error: error?.message || String(error),
        deferred: rateDeferred,
        pageWillContinue: failurePolicy.continuePage,
      });
      if (failurePolicy.haltPage) {
        halted = true;
        break;
      }
      await new Promise(resolve => setImmediate(resolve));
      continue;
    }

    if (result?.cancelled || superseded()) {
      const queued = queueForBackground(
        [productId, ...products.slice(productIndex + 1).map(item => item.id)],
        "shopper-navigation-during-product"
      );
      incompleteIds.add(productId);
      demoted = true;
      halted = true;
      publishHydration("page-demoted", {
        productId,
        title: product.title || "",
        displayIndex,
        displayNumber: displayIndex + 1,
        visibleProducts: preferredVisibleIds.length,
        scanIndex: productIndex,
        scanNumber: productIndex + 1,
        scanTotal: products.length,
        completed: completedIds.size,
        sellerCount: Number(result?.sellerCountAfter ?? sellerCountBefore),
        listingCount: Number(result?.listingCountAfter ?? listingCountBefore),
        queuedBackground: queued.queued,
        reason: "shopper-navigation",
      });
      break;
    }

    scanned++;
    matched += Number(result?.matched || 0);
    pendingQueued += Number(result?.pendingQueued || 0);

    if (result?.deferred) {
      deferred++;
      incompleteIds.add(productId);
      failures.push({
        productId,
        error: "Exact competitor detail was deferred by the protected quota budget.",
        deferred: true,
      });
      publishHydration("page-paused", {
        productId,
        title: product.title || "",
        displayIndex,
        displayNumber: displayIndex + 1,
        visibleProducts: preferredVisibleIds.length,
        scanIndex: productIndex,
        scanNumber: productIndex + 1,
        scanTotal: products.length,
        completed: completedIds.size,
        sellerCount: Number(result?.sellerCountAfter ?? sellerCountBefore),
        listingCount: Number(result?.listingCountAfter ?? listingCountBefore),
        signalsRun: result?.signalsRun || [],
        coverageStatus: result?.coverageStatus || "quota-deferred",
        deferred: true,
      });
      halted = true;
      break;
    }

    if (!result?.coverageComplete) {
      incompleteIds.add(productId);
      failures.push({
        productId,
        error: `Normalized-product competitor pass time-sliced (${result?.coverageStatus || "incomplete"}).`,
        deferred: false,
      });
      publishHydration("product-incomplete", {
        productId,
        title: product.title || "",
        displayIndex,
        displayNumber: displayIndex + 1,
        visibleProducts: preferredVisibleIds.length,
        scanIndex: productIndex,
        scanNumber: productIndex + 1,
        scanTotal: products.length,
        completed: completedIds.size,
        sellerCount: Number(result?.sellerCountAfter ?? sellerCountBefore),
        listingCount: Number(result?.listingCountAfter ?? listingCountBefore),
        signalsRun: result?.signalsRun || [],
        coverageStatus: result?.coverageStatus || "incomplete",
        deferred: false,
      });
      await new Promise(resolve => setImmediate(resolve));
      continue;
    }

    incompleteIds.delete(productId);
    completedIds.add(productId);
    publishHydration("product-complete", {
      productId,
      title: product.title || "",
      displayIndex,
      displayNumber: displayIndex + 1,
      visibleProducts: preferredVisibleIds.length,
      scanIndex: productIndex,
      scanNumber: productIndex + 1,
      scanTotal: products.length,
      completed: completedIds.size,
      sellerCount: Number(result?.sellerCountAfter ?? sellerCountBefore),
      listingCount: Number(result?.listingCountAfter ?? listingCountBefore),
      sellerCountBefore: Number(result?.sellerCountBefore ?? sellerCountBefore),
      listingCountBefore: Number(result?.listingCountBefore ?? listingCountBefore),
      targetReached: Boolean(result?.targetReached),
      signalsExhausted: Boolean(result?.signalsExhausted),
      signalsRun: result?.signalsRun || [],
      matched: Number(result?.matched || 0),
    });

    await new Promise(resolve => setImmediate(resolve));
  }

  if (demoted) {
    return {
      enabled: true,
      passId,
      page: safePage,
      pageSize: safePageSize,
      pageProducts: preferredVisibleIds.length,
      selected: products.length,
      attempted: attemptedIds.size,
      scanned,
      matched,
      pendingQueued,
      deferred,
      complete: false,
      demoted: true,
      failures,
    };
  }

  // Re-read only the fixed visible IDs to observe the scan results. The one
  // full matching-query sort is deliberately owned by the browser after this
  // completion event, not by this foreground hydration pass.
  const finalVisibleProducts = getProductRecordsByIds(preferredVisibleIds, true)
    .filter(product => !isBrokenOrPartsListing(product));
  const finalStaleUnderTarget = finalVisibleProducts.filter(product => coverageState(product).due);
  const finalUnattempted = finalStaleUnderTarget.filter(
    product => !attemptedIds.has(Number(product.id))
  );
  const finalUnderTarget = finalVisibleProducts.filter(
    product => currentSellerCount(product) < targetSellers
  );
  const complete =
    !halted &&
    finalUnattempted.length === 0 &&
    deferred === 0 &&
    incompleteIds.size === 0;

  // V3.7.55: unresolved foreground coverage belongs to the background lane
  // after this bounded pass ends. This preserves eventual competitor coverage
  // without immediately restarting the same shopper-visible scan.
  const unresolvedBackgroundIds = [...new Set([
    ...incompleteIds,
    ...finalUnattempted.map(product => Number(product.id)),
  ].map(Number).filter(Number.isFinite))];
  const backgroundCoverage = !complete && unresolvedBackgroundIds.length
    ? queueForBackground(unresolvedBackgroundIds, "shopper-page-bounded-pass-incomplete")
    : { queued: 0, deduplicated: 0 };

  opLog("live-search", "fixed shopper-visible competitor hydration complete", {
    query,
    page: safePage,
    pageSize: safePageSize,
    pageProducts: preferredVisibleIds.length,
    selected: products.length,
    attempted: attemptedIds.size,
    completed: completedIds.size,
    incomplete: incompleteIds.size,
    scanned,
    matched,
    pendingQueued,
    deferred,
    underTargetAfterHydration: finalUnderTarget.length,
    staleOrUnresearchedAfterHydration: finalStaleUnderTarget.length,
    unattemptedVisibleAfterHydration: finalUnattempted.length,
    roundsRun: 1,
    complete,
    halted,
    failures: failures.length,
    unresolvedBackgroundQueued: Number(backgroundCoverage?.queued || 0),
    attemptedAllSelected: attemptedIds.size >= products.length,
  });

  publishHydration(complete ? "page-complete" : "page-incomplete", {
    visibleProducts: preferredVisibleIds.length,
    selected: products.length,
    scanTotal: products.length,
    freshCoverageReused,
    attempted: attemptedIds.size,
    completed: completedIds.size,
    incomplete: incompleteIds.size,
    scanned,
    matched,
    pendingQueued,
    deferred,
    underTarget: finalUnderTarget.length,
    staleUnderTarget: finalStaleUnderTarget.length,
    staleOrUnresearched: finalStaleUnderTarget.length,
    unattempted: finalUnattempted.length,
    roundsRun: 1,
    complete,
    unresolvedBackgroundQueued: Number(backgroundCoverage?.queued || 0),
    attemptedAllSelected: attemptedIds.size >= products.length,
  });

  return {
    enabled: true,
    passId,
    page: safePage,
    pageSize: safePageSize,
    pageProducts: preferredVisibleIds.length,
    selected: products.length,
    attempted: attemptedIds.size,
    completed: completedIds.size,
    incomplete: incompleteIds.size,
    scanned,
    matched,
    pendingQueued,
    deferred,
    targetSellers,
    freshnessMinutes,
    underTargetAfterHydration: finalUnderTarget.length,
    staleUnderTargetAfterHydration: finalStaleUnderTarget.length,
    staleOrUnresearchedAfterHydration: finalStaleUnderTarget.length,
    unattemptedVisibleAfterHydration: finalUnattempted.length,
    roundsRun: 1,
    complete,
    halted,
    failures,
    unresolvedBackgroundQueued: Number(backgroundCoverage?.queued || 0),
  };
}
async function mapConcurrent(values, concurrency, fn) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(values.length, 1)) }, () => worker())
  );
  return results;
}

function filterRelevantCandidates(query, category, candidates, { includeParts = false } = {}) {
  return (candidates || [])
    .filter(candidate => !isExplicitProduct(candidate))
    .filter(candidate => includeParts || !isBrokenOrPartsListing(candidate))
    .map(candidate => ({
      candidate: {
        ...candidate,
        category: category || candidate.category,
      },
      relevance: searchRelevance(query, {
        title: candidate.title,
        listingTitle: candidate.listingTitle,
        brand: candidate.brand,
        // Relevance is judged from marketplace-supplied identity/category. The
        // shopper's selected OfferGrid category may classify the product after
        // it passes, but it must never manufacture a missing query term.
        category: candidate.category,
        searchText: `${candidate.title || ""} ${candidate.brand || ""} ${candidate.category || ""}`,
      }),
    }))
    .filter(item => item.relevance.relevant)
    .sort((a, b) => b.relevance.score - a.relevance.score)
    .map(item => item.candidate);
}

// V3.7.46: after first paint / visible-card hydration, unfinished catalog
// expansion becomes low-priority work instead of remaining in the shopper lane.
// One continuation probe per query is enough to keep growth moving while the
// query-local background continuation exact-verifies a bounded source slice so
// an active shopper search can actually grow toward its requested page size.

async function runUserSearchBackgroundContinuation({ query, category = "", targetCount = LIVE_SEARCH_SHOPPER_PAGE_SIZE, includeParts = false } = {}) {
  const q = String(query || "").trim();
  if (q.length < 2 || isExplicitSearchQuery(q)) return { skipped: true, reason: "invalid-query" };

  await backgroundCheckpoint("live-search:background-discovery-start", { quietMs: 250 });
  const state = getOrCreateSession(q, category, includeParts);
  const requestedTarget = Math.min(Math.max(Number(targetCount || LIVE_SEARCH_SHOPPER_PAGE_SIZE), 1), 2400);
  const maxPagesPerQuery = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_MAX_PAGES_PER_QUERY || 8), 2),
    20
  );
  const currentCountBefore = countPublicSearchMatches({ q, category, includeParts });
  if (state.pagesSearched >= maxPagesPerQuery && currentCountBefore < requestedTarget) {
    state.budgetExhausted = true;
    state.exhaustedAt ||= Date.now();
  }
  if (currentCountBefore >= requestedTarget || state.exhausted || state.budgetExhausted) {
    return {
      skipped: true,
      reason: "capacity-or-exhaustion",
      currentCount: currentCountBefore,
      continueNeeded: false,
    };
  }

  ensureUserSearchRule(q, category, { deferPersistence: true });
  const plan = generatePrecisionSearchVariants({
    query: q,
    category,
    limit: Math.min(Math.max(Number(process.env.LIVE_SEARCH_QUERY_VARIANTS || 6), 1), 12),
  });
  const selected = nextSearchVariant(state, plan);
  if (!selected) {
    state.exhausted = true;
    state.exhaustedAt ||= Date.now();
    return {
      skipped: true,
      reason: "signals-exhausted",
      currentCount: currentCountBefore,
      continueNeeded: false,
    };
  }

  const { variant, local } = selected;
  const configuredBackgroundPageSize = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_BACKGROUND_PAGE_SIZE || 50), 20),
    80
  );
  // eBay Browse requires offset=0 or an exact multiple of limit. A search
  // variant may begin in the first-paint lane with a 30-item page and later
  // continue in the background. Keep that variant's original page size so the
  // saved offset remains valid and no result range is skipped or duplicated.
  const pageSize = Math.min(
    Math.max(Number(local.pageSize || configuredBackgroundPageSize), 1),
    200
  );
  local.pageSize = pageSize;
  const requestOffset = Number(local.nextOffset || 0);
  const marketplace = await searchEbayAndRakuten(variant.query, pageSize, {
    priority: "background",
    offset: requestOffset,
  });

  state.pagesSearched++;
  local.pages = Number(local.pages || 0) + 1;
  // Never skip an eBay result page after a provider failure. Rakuten is an
  // additive fallback and may still contribute candidates, but the eBay cursor
  // remains on the failed offset so a later continuation can retry it.
  local.nextOffset = marketplace.ebayError
    ? requestOffset
    : requestOffset + pageSize;
  const relevant = filterRelevantCandidates(q, category, marketplace.candidates, { includeParts }).slice(0, pageSize);

  if (
    !marketplace.ebayError && marketplace.ebayCandidates.length < pageSize &&
    (!marketplace.rakutenConfigured || (!marketplace.rakutenError && marketplace.rakutenCandidates.length < Math.min(pageSize, 100)))
  ) {
    local.exhausted = true;
  }

  if (!relevant.length) {
    if (marketplace.ebayError) {
      state.deferred = true;
      opWarn("live-search", "background eBay continuation failed; additive providers returned no usable fallback candidates", {
        query: q,
        marketplaceQuery: variant.query,
        pageSize,
        offset: requestOffset,
        ebayStatus: Number(marketplace.ebayError?.status || 0) || null,
        ebayCode: marketplace.ebayError?.code || null,
        rakutenReturned: marketplace.rakutenCandidates.length,
      });
    } else {
      opLog("live-search", "background query continuation found no relevant candidates", {
        query: q,
        marketplaceQuery: variant.query,
        returned: marketplace.candidates.length,
      });
    }

    const remainingVariant = plan.some(planItem => !variantStateFor(state, planItem).exhausted);
    if (!remainingVariant) {
      state.exhausted = true;
      state.exhaustedAt ||= Date.now();
    }
    const currentCount = countPublicSearchMatches({ q, category, includeParts });
    if (!marketplace.ebayError && currentCount <= currentCountBefore) {
      state.backgroundNoGrowthSteps = Number(state.backgroundNoGrowthSteps || 0) + 1;
    } else if (currentCount > currentCountBefore) {
      state.backgroundNoGrowthSteps = 0;
      state.backgroundStopReason = "";
    }
    return {
      received: marketplace.candidates.length,
      relevant: 0,
      currentCount,
      publicGrowth: Math.max(0, currentCount - currentCountBefore),
      noGrowthSteps: Number(state.backgroundNoGrowthSteps || 0),
      providerFailure: Boolean(marketplace.ebayError),
      continueNeeded: !marketplace.ebayError && currentCount < requestedTarget && !state.exhausted && !state.budgetExhausted,
    };
  }

  await backgroundCheckpoint("live-search:background-discovery-ingest", { quietMs: 250 });
  const ingest = ingestCandidates(relevant, { deferPersistence: true });

  // Publish any non-eBay/already-exact rows immediately, then spend a small
  // quota-aware background source-verification slice on this ACTIVE shopper
  // query. This is deliberately bounded: it helps the visible search actually
  // fill toward 40 without turning background continuation into a quota drain.
  const approvalBefore = autoApproveConfidentDrafts({
    productIds: ingest.touchedProductIds,
    limit: ingest.touchedProductIds.length,
    reason: "user-search-background-continuation-preverify",
    deferPersistence: true,
  });

  const verifyLimit = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_BACKGROUND_VERIFY_LIMIT || 8), 1),
    20
  );
  const externalIds = [...new Set(
    relevant
      .filter(candidate => String(candidate.provider || "").toLowerCase() === "ebay")
      .map(candidate => String(candidate.externalId || "").trim())
      .filter(Boolean)
  )].slice(0, verifyLimit);

  let verification = {
    verified: 0,
    deferred: 0,
    failures: [],
    touchedProductIds: [],
  };
  if (externalIds.length) {
    await backgroundCheckpoint("live-search:background-discovery-source-proof", { quietMs: 250 });
    verification = await verifyEbayExternalIds(externalIds, {
      priority: "background",
      maxApiCalls: 1,
      deferPersistence: true,
    });
  }

  const touchedForApproval = [...new Set([
    ...ingest.touchedProductIds,
    ...(verification.touchedProductIds || []),
  ].map(Number).filter(Number.isFinite))];
  const approvalAfter = touchedForApproval.length
    ? autoApproveConfidentDrafts({
        productIds: touchedForApproval,
        limit: touchedForApproval.length,
        reason: "user-search-background-continuation-postverify",
        deferPersistence: true,
      })
    : { approved: [] };

  if (ingest.touchedProductIds.length) {
    publishLiveEvent("hydration", {
      phase: "discovery-listings-arrived",
      query: q,
      category: category || "",
      reason: "background-continuation-listings",
      productIds: [...new Set(ingest.touchedProductIds.map(Number).filter(Number.isFinite))],
      includeParts: Boolean(includeParts),
      background: true,
    }, { audience: "public" });
  }

  const progressIds = [...new Set([
    ...(approvalBefore.approved || []),
    ...(verification.touchedProductIds || []),
    ...(approvalAfter.approved || []),
  ].map(Number).filter(Number.isFinite))];
  const currentCount = countPublicSearchMatches({ q, category, includeParts });
  if (progressIds.length || currentCount > currentCountBefore) {
    publishLiveEvent("hydration", {
      phase: "discovery-safe-results-progress",
      query: q,
      category: category || "",
      reason: "background-continuation-safe-results",
      productIds: progressIds,
      currentCount,
      targetCount: requestedTarget,
      includeParts: Boolean(includeParts),
      background: true,
    }, { audience: "public" });
  }

  if (currentCount > currentCountBefore) {
    state.backgroundNoGrowthSteps = 0;
    state.backgroundStopReason = "";
  } else {
    state.backgroundNoGrowthSteps = Number(state.backgroundNoGrowthSteps || 0) + 1;
  }

  const remainingVariant = plan.some(planItem => !variantStateFor(state, planItem).exhausted);
  if (!remainingVariant) {
    state.exhausted = true;
    state.exhaustedAt ||= Date.now();
  }

  if (Number(verification.deferred || 0) > 0 && !Number(verification.verified || 0)) {
    state.deferred = true;
  }

  const continueNeeded =
    currentCount < requestedTarget &&
    !state.exhausted &&
    !state.budgetExhausted &&
    !state.deferred;

  opLog("live-search", "background query continuation ingested and source-verified one bounded page", {
    query: q,
    marketplaceQuery: variant.query,
    relevant: relevant.length,
    productsTouched: ingest.touchedProductIds.length,
    productsCreated: ingest.productsCreated,
    verified: Number(verification.verified || 0),
    verificationDeferred: Number(verification.deferred || 0),
    autoApproved: Number(approvalBefore.approved?.length || 0) + Number(approvalAfter.approved?.length || 0),
    currentCount,
    targetCount: requestedTarget,
    continueNeeded,
  });

  return {
    received: marketplace.candidates.length,
    relevant: relevant.length,
    productsTouched: ingest.touchedProductIds.length,
    productsCreated: ingest.productsCreated,
    verified: Number(verification.verified || 0),
    autoApproved: Number(approvalBefore.approved?.length || 0) + Number(approvalAfter.approved?.length || 0),
    currentCount,
    publicGrowth: Math.max(0, currentCount - currentCountBefore),
    noGrowthSteps: Number(state.backgroundNoGrowthSteps || 0),
    providerFailure: Boolean(marketplace.ebayError),
    deferred: Boolean(state.deferred),
    continueNeeded,
  };
}

function queueUserSearchBackgroundContinuation({
  query,
  category = "",
  targetCount = LIVE_SEARCH_SHOPPER_PAGE_SIZE,
  includeParts = false,
  reason = "render-first-handoff",
  delayMs = 0,
  interactionId = "",
  page = 1,
  sort = "heat",
} = {}) {
  const key = sessionKey(query, category, includeParts);
  if (!String(query || "").trim()) {
    return { queued: false, deduplicated: false };
  }
  registerBackgroundDiscoveryWaiter(key, { interactionId, page, sort, targetCount });
  if (backgroundDiscoveryContinuations.has(key)) {
    return { queued: false, deduplicated: true };
  }

  const delay = Math.min(Math.max(Number(delayMs || 0), 0), 10000);
  const maxSteps = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_BACKGROUND_CHAIN_STEPS || 8), 1),
    20
  );
  const stepDelayMs = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_BACKGROUND_STEP_DELAY_MS || 500), 100),
    5000
  );

  const promise = (async () => {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    else await new Promise(resolve => setImmediate(resolve));

    let last = null;
    let stepsRun = 0;
    const noGrowthStepCap = Math.min(
      Math.max(Number(process.env.LIVE_SEARCH_BACKGROUND_NO_GROWTH_STEPS || 3), 1),
      8
    );

    for (let step = 0; step < maxSteps; step++) {
      stepsRun = step + 1;
      last = await runUserSearchBackgroundContinuation({
        query,
        category,
        targetCount,
        includeParts,
      });
      if (!last?.continueNeeded) break;

      const state = getOrCreateSession(query, category, includeParts);
      if (Number(state.backgroundNoGrowthSteps || 0) >= noGrowthStepCap) {
        state.budgetExhausted = true;
        state.exhaustedAt ||= Date.now();
        state.backgroundStopReason = "no-public-growth";
        last = {
          ...last,
          continueNeeded: false,
          boundedStop: true,
          stopReason: state.backgroundStopReason,
        };
        opLog("live-search", "background shopper page-fill stopped after repeated no-growth pages", {
          query,
          currentCount: Number(last.currentCount || 0),
          targetCount,
          noGrowthSteps: Number(state.backgroundNoGrowthSteps || 0),
          noGrowthStepCap,
        });
        break;
      }

      await backgroundCheckpoint("live-search:background-discovery-between-pages", { quietMs: 350 });
      await new Promise(resolve => setTimeout(resolve, stepDelayMs));
    }

    const state = getOrCreateSession(query, category, includeParts);
    const currentCount = countPublicSearchMatches({ q: query, category, includeParts });

    // A continuation chain is an interaction budget, not an invitation to
    // immediately start the same chain again. If every allowed step was used
    // and discovery still says it could continue, close this interaction as
    // budget-exhausted and publish the normal discovery barrier. This fixes the
    // narrow-query loop where the browser repeatedly relaunched an underfilled
    // search (for example Microsoft HoloLens) after each max-length chain.
    if (stepsRun >= maxSteps && last?.continueNeeded) {
      state.budgetExhausted = true;
      state.exhaustedAt ||= Date.now();
      state.backgroundStopReason = "chain-step-cap";
      last = {
        ...last,
        continueNeeded: false,
        boundedStop: true,
        stopReason: state.backgroundStopReason,
      };
      opLog("live-search", "background shopper page-fill reached its bounded chain cap", {
        query,
        currentCount,
        targetCount,
        stepsRun,
        maxSteps,
      });
    }
    const target = Math.min(Math.max(Number(targetCount || LIVE_SEARCH_SHOPPER_PAGE_SIZE), 1), 2400);
    const readyForHydration =
      currentCount >= target ||
      state.exhausted ||
      state.budgetExhausted ||
      state.deferred ||
      !last?.continueNeeded;

    // This is the TRUE discovery→hydration barrier for an underfilled new
    // search. First paint may yield to background work, but hydration does not
    // begin until the page reaches its requested capacity or discovery really
    // cannot continue right now.
    if (currentCount > 0 && readyForHydration) {
      const readyReason = currentCount >= target
        ? "background-page-target-reached"
        : state.deferred
          ? "background-page-fill-deferred"
          : state.backgroundStopReason === "no-public-growth"
            ? "background-page-fill-no-growth-cap"
            : state.backgroundStopReason === "chain-step-cap"
              ? "background-page-fill-chain-cap"
              : "background-page-fill-complete";
      const readyProductIds = getPublicSearchMatchIds({
        q: query,
        category,
        includeParts,
      }).slice(0, target);

      // Shared background catalog growth remains a background event, but the
      // shopper interaction that handed page-fill work to this continuation
      // receives its own scoped barrier. That barrier carries the original
      // interactionId/page and is the only background-derived event allowed to
      // advance that shopper from "Filling this page" into hydration.
      publishLiveEvent("hydration", {
        phase: "discovery-results-ready",
        query: String(query || "").trim(),
        category: category || "",
        reason: readyReason,
        currentCount,
        targetCount: target,
        pageSize: LIVE_SEARCH_SHOPPER_PAGE_SIZE,
        productIds: readyProductIds,
        includeParts: Boolean(includeParts),
        background: true,
      }, { audience: "public" });

      publishBackgroundDiscoveryReadyToWaiters({
        key,
        query,
        category,
        includeParts,
        currentCount,
        state,
        reason: readyReason,
        productIds: readyProductIds,
      });
    }

    opLog("live-search", "background shopper page-fill session complete", {
      query,
      currentCount,
      targetCount: target,
      exhausted: Boolean(state.exhausted),
      budgetExhausted: Boolean(state.budgetExhausted),
      deferred: Boolean(state.deferred),
      readyForHydration,
      stepsRun,
      stopReason: state.backgroundStopReason || null,
    });

    return {
      ...(last || {}),
      currentCount,
      targetCount: target,
      readyForHydration,
    };
  })()
    .catch(error => {
      opWarn("live-search", "background query continuation failed", {
        query,
        reason,
        error: error?.message || String(error),
      });
      return { failed: true, error: error?.message || String(error) };
    })
    .finally(() => {
      backgroundDiscoveryContinuations.delete(key);
      backgroundDiscoveryWaiters.delete(key);
    });

  backgroundDiscoveryContinuations.set(key, promise);
  opLog("live-search", "unfinished shopper discovery queued behind interactive traffic", {
    query,
    targetCount,
    reason,
    delayMs: delay,
    maxSteps,
  });
  return { queued: true, deduplicated: false };
}

export async function discoverForUserSearch({
  query,
  category = "",
  targetCount = LIVE_SEARCH_SHOPPER_PAGE_SIZE,
  sort = "heat",
  page = 1,
  pageSize = LIVE_SEARCH_SHOPPER_PAGE_SIZE,
  visibleProductIds = [],
  jobControl = null,
  interactionId = "",
  workMode = "auto",
  includeParts = false,
} = {}) {
  const q = String(query || "").trim();
  const safeInteractionId = String(interactionId || "").trim().slice(0, 96);
  const normalizedVisibleProductIds = [...new Set(
    (Array.isArray(visibleProductIds) ? visibleProductIds : [])
      .map(Number)
      .filter(Number.isFinite)
  )].slice(0, LIVE_SEARCH_SHOPPER_PAGE_SIZE);
  const mode = workMode === "discover" || workMode === "hydrate"
    ? workMode
    : normalizedVisibleProductIds.length
      ? "hydrate"
      : "discover";
  const superseded = () => {
    try { return Boolean(jobControl?.isSuperseded?.()); }
    catch { return false; }
  };
  const handOffSupersededWork = reason => {
    const queued = enqueueEbayCompetitorBackgroundProducts(normalizedVisibleProductIds, { reason });
    ensureUserSearchRule(q, category, { deferPersistence: true });
    opLog("live-search", "superseded shopper search handed to background scheduling", {
      query: q,
      page,
      mode,
      reason,
      visibleProducts: normalizedVisibleProductIds.length,
      competitorProductsQueued: queued.queued,
    });
    return queued;
  };

  if (!q) {
    return {
      received: 0,
      relevant: 0,
      verified: 0,
      productsCreated: 0,
      autoApproved: 0,
      failures: [],
      exhausted: true,
      canDiscoverMore: false,
      workMode: mode,
    };
  }

  if (isExplicitSearchQuery(q)) {
    return {
      received: 0,
      relevant: 0,
      verified: 0,
      productsCreated: 0,
      autoApproved: 0,
      failures: [],
      blocked: true,
      blockedReason: "explicit-query",
      exhausted: true,
      canDiscoverMore: false,
      workMode: mode,
    };
  }

  const state = getOrCreateSession(q, category, includeParts);
  state.deferred = false;

  // V3.7.46 intentionally separates first-paint discovery from visible-card
  // competitor indexing. Marketplace search only needs enough data to publish
  // the first safe normalized results. Once cards exist, the browser starts a
  // distinct hydrate job with the exact visible DOM order.
  const marketplacePageSize = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_FIRST_PAINT_MARKETPLACE_PAGE_SIZE || 30), 20),
    40
  );
  const maxPagesPerInteraction = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_FIRST_PAINT_MAX_PAGES || 2), 1),
    4
  );
  const maxPagesPerQuery = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_MAX_PAGES_PER_QUERY || 8), 2),
    24
  );
  const verifyLimit = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_FIRST_PAINT_VERIFY_LIMIT || 8), 1),
    40
  );
  const verifyBurst = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_FIRST_PAINT_VERIFY_BURST || 3), 1),
    10
  );
  const ingestLimit = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_FIRST_PAINT_INGEST_LIMIT || 20), 10),
    80
  );
  const firstPaintBudgetMs = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_FIRST_PAINT_BUDGET_MS || 6000), 2000),
    30000
  );
  const requestedTarget = Math.min(
    Math.max(Number(targetCount || LIVE_SEARCH_SHOPPER_PAGE_SIZE), 1),
    2400
  );

  const variantLimit = Math.min(
    Math.max(Number(process.env.LIVE_SEARCH_QUERY_VARIANTS || 6), 1),
    12
  );
  const searchPlan = generatePrecisionSearchVariants({
    query: q,
    category,
    limit: variantLimit,
  });

  const finish = timedOp("live-search", `${mode} lane for "${q}"`, {
    targetCount: requestedTarget,
    category: category || "automatic",
    queryVariants: searchPlan.length,
    mode,
  });

  const publicMatchIds = new Set(getPublicSearchMatchIds({ q, category, includeParts }));
  let currentCount = publicMatchIds.size;
  const reconcilePublicMatches = productIds => {
    const touchedIds = [...new Set(
      (Array.isArray(productIds) ? productIds : [])
        .map(Number)
        .filter(Number.isFinite)
    )];
    if (!touchedIds.length) return [];

    const previouslyMatched = new Set(
      touchedIds.filter(productId => publicMatchIds.has(productId))
    );
    for (const productId of touchedIds) publicMatchIds.delete(productId);

    const matchingTouchedIds = getPublicSearchMatchIds({
      q,
      category,
      productIds: touchedIds,
      includeParts,
    });
    for (const productId of matchingTouchedIds) publicMatchIds.add(Number(productId));
    currentCount = publicMatchIds.size;

    return matchingTouchedIds.filter(productId => !previouslyMatched.has(Number(productId)));
  };
  let received = 0;
  let relevantCount = 0;
  let verified = 0;
  let productsCreated = 0;
  let offersCreated = 0;
  let offersUpdated = 0;
  let autoApproved = 0;
  let blockedExplicit = 0;
  const failures = [];
  let pagesThisInteraction = 0;
  let competitorCoverage = {
    enabled: mode === "hydrate",
    page,
    pageSize,
    pageProducts: normalizedVisibleProductIds.length,
    selected: 0,
    attempted: 0,
    scanned: 0,
    matched: 0,
    pendingQueued: 0,
    deferred: 0,
    complete: false,
    failures: [],
    skippedReason: mode === "discover" ? "render-barrier" : "",
  };

  const publishDiscoveryProgress = (reason, productIds = []) => {
    publishLiveEvent("hydration", {
      phase: "discovery-safe-results-progress",
      interactionId: safeInteractionId,
      query: q,
      category: category || "",
      sort,
      page: Math.max(1, Number(page || 1)),
      pageSize: LIVE_SEARCH_SHOPPER_PAGE_SIZE,
      reason,
      currentCount,
      targetCount: requestedTarget,
      productIds: [...new Set((productIds || []).map(Number).filter(Number.isFinite))],
      includeParts: Boolean(includeParts),
    }, { audience: "public" });
  };

  const publishDiscoveryReady = (reason, productIds = []) => {
    publishLiveEvent("hydration", {
      phase: "discovery-results-ready",
      interactionId: safeInteractionId,
      query: q,
      category: category || "",
      sort,
      page: Math.max(1, Number(page || 1)),
      pageSize: LIVE_SEARCH_SHOPPER_PAGE_SIZE,
      reason,
      currentCount,
      targetCount: requestedTarget,
      productIds: [...new Set((productIds || []).map(Number).filter(Number.isFinite))],
      includeParts: Boolean(includeParts),
    }, { audience: "public" });
  };

  const resultBase = () => ({
    received,
    relevant: relevantCount,
    verified,
    productsCreated,
    offersCreated,
    offersUpdated,
    autoApproved,
    blockedExplicit,
    failures,
    pagesSearched: state.pagesSearched,
    currentCount,
    targetCount: requestedTarget,
    variantsTried: Object.values(state.variantStates || {})
      .filter(item => Number(item.pages || 0) > 0).length,
    competitorCoverage,
    workMode: mode,
  });

  if (superseded()) {
    handOffSupersededWork(`shopper-navigation-before-${mode}`);
    finish("superseded to background", { currentCount, targetCount: requestedTarget, mode });
    return { ...resultBase(), deferred: true, superseded: true };
  }

  // Hydration lane: never do marketplace discovery before visible cards. The
  // browser already rendered these normalized products, so exact competitor
  // indexing gets the foreground lane immediately. Missing catalog capacity is
  // left represented by the normal discovery rule instead of competing with
  // the shopper's current page.
  if (mode === "hydrate") {
    // database page already has capacity; skipping draft preflight before competitor indexing
    // remains the V3.7.43 invariant. V3.7.46 strengthens it: any rendered page
    // skips foreground marketplace expansion too, so visible-card hydration can
    // start without source-discovery contention.
    if (currentCount < requestedTarget) {
      ensureUserSearchRule(q, category, { deferPersistence: true });
    }

    if (normalizedVisibleProductIds.length && currentCount > 0) {
      competitorCoverage = await hydrateInteractiveCompetitorCoverageForPage({
        query: q,
        category,
        sort,
        page,
        pageSize,
        visibleProductIds: normalizedVisibleProductIds,
        jobControl,
        interactionId: safeInteractionId,
        includeParts,
      });
      failures.push(...(competitorCoverage.failures || []));
    }

    const canDiscoverMoreAfterHydration = !state.exhausted && !state.budgetExhausted;

    // V3.7.55: hydration is a terminal foreground phase for this shopper
    // interaction. Do not immediately re-queue marketplace discovery merely
    // because the verified page contains fewer than 40 products. That old
    // post-hydration continuation could publish another discovery-ready barrier
    // and re-arm the same blue competitor scanner indefinitely on narrow
    // searches. The persisted discovery rule/scheduled background system can
    // continue improving catalog coverage later without restarting this pass.
    const backgroundContinuation = {
      queued: false,
      deduplicated: false,
      suppressed: true,
      reason: "foreground-hydration-terminal",
    };

    finish("visible page hydration complete", {
      currentCount,
      targetCount: requestedTarget,
      visibleProducts: normalizedVisibleProductIds.length,
      complete: Boolean(competitorCoverage.complete),
      backgroundContinuationQueued: false,
      foregroundHydrationTerminal: true,
    });
    return {
      ...resultBase(),
      exhausted: Boolean(state.exhausted || state.budgetExhausted),
      sourceExhausted: Boolean(state.exhausted),
      budgetExhausted: Boolean(state.budgetExhausted),
      canDiscoverMore: canDiscoverMoreAfterHydration,
      backgroundContinuation,
      foregroundHydrationTerminal: true,
    };
  }

  // Discovery lane: a partially populated catalog is progress, not a reason to
  // stop. Keep filling the query for a bounded first-paint window while the
  // browser can already render the safe cards that exist. Only a full target
  // skips marketplace work entirely.
  if (currentCount >= requestedTarget) {
    publishDiscoveryReady("catalog-target-already-ready", [...publicMatchIds]);
    finish("safe result target already ready", { currentCount, targetCount: requestedTarget });
    return {
      ...resultBase(),
      exhausted: false,
      canDiscoverMore: true,
      firstPaintReady: true,
    };
  }
  if (currentCount > 0) {
    publishDiscoveryProgress("catalog-partially-ready-before-discovery", [...publicMatchIds]);
  }

  const firstPaintStartedAt = Date.now();

  // Fast query-local draft recovery is local-only. Hundreds of stale exact
  // verification candidates remain the scheduled verifier's job; first paint
  // must reach the marketplace source the shopper actually asked for.
  await backgroundCheckpoint("live-search:first-paint-draft-preflight", { quietMs: 25 });
  const draftPreflight = await promoteMatchingDraftsForSearch({
    query: q,
    category,
    state,
    verifyLimit,
    fastFirstPaint: true,
  });
  verified += Number(draftPreflight.verified || 0);
  autoApproved += Number(draftPreflight.approvedBeforeVerification || 0) +
    Number(draftPreflight.approvedAfterVerification || 0);
  failures.push(...(draftPreflight.failures || []));
  const draftAddedIds = reconcilePublicMatches(draftPreflight.approvedProductIds || []);
  if (draftAddedIds.length) {
    publishDiscoveryProgress("draft-first-paint-progress", draftAddedIds);
  }

  if (superseded()) {
    handOffSupersededWork("shopper-navigation-after-fast-draft-preflight");
    finish("superseded to background", { currentCount, targetCount: requestedTarget });
    return { ...resultBase(), deferred: true, superseded: true };
  }

  while (
    currentCount < requestedTarget &&
    !state.exhausted &&
    !state.budgetExhausted &&
    pagesThisInteraction < maxPagesPerInteraction &&
    Date.now() - firstPaintStartedAt < firstPaintBudgetMs
  ) {
    if (superseded()) {
      handOffSupersededWork("shopper-navigation-between-marketplace-pages");
      finish("superseded to background", {
        currentCount,
        targetCount: requestedTarget,
        pagesSearched: state.pagesSearched,
      });
      return { ...resultBase(), deferred: true, superseded: true };
    }
    if (state.pagesSearched >= maxPagesPerQuery) {
      state.budgetExhausted = true;
      break;
    }

    const selected = nextSearchVariant(state, searchPlan);
    if (!selected) {
      state.exhausted = true;
      break;
    }

    const { variant, local } = selected;
    // Persist the eBay limit with this variant. Background continuation must
    // reuse the same limit because Browse rejects offsets that are not a
    // multiple of the request limit (error 12515).
    local.pageSize = Number(local.pageSize || marketplacePageSize);
    const requestPageSize = Math.min(Math.max(Number(local.pageSize), 1), 200);
    const requestOffset = Number(local.nextOffset || 0);

    // Let pending HTTP/SSE callbacks run before each external search. A live
    // marketplace probe is important, but it must never create an unbroken
    // wall of JS work that starves other shoppers.
    await new Promise(resolve => setImmediate(resolve));

    const marketplace = await searchEbayAndRakuten(
      variant.query,
      requestPageSize,
      {
        priority: "interactive",
        offset: requestOffset,
        // eBay owns the first-paint lane. Rakuten is additive and runs in the
        // background continuation so a slow mirror cannot delay visible cards.
        skipRakuten: true,
      }
    );
    const candidates = marketplace.candidates;
    failures.push(...marketplace.failures);

    const ebayDeferred =
      marketplace.ebayError && isEbayRateGuardError(marketplace.ebayError);

    if (
      marketplace.ebayError &&
      !ebayDeferred &&
      !marketplace.rakutenCandidates.length
    ) {
      throw marketplace.ebayError;
    }

    if (ebayDeferred) {
      state.deferred = true;
      opLog("live-search", "eBay side deferred during first-paint discovery", {
        query: q,
        marketplaceQuery: variant.query,
        rakutenReturned: marketplace.rakutenCandidates.length,
      });
    }

    pagesThisInteraction++;
    state.pagesSearched++;
    local.pages = Number(local.pages || 0) + 1;
    // A rate-guard/provider failure did not consume this eBay page. Keep the
    // cursor on the same offset so a later foreground/background continuation
    // retries it instead of silently skipping a result range.
    local.nextOffset = marketplace.ebayError
      ? requestOffset
      : requestOffset + requestPageSize;
    received += candidates.length;

    const ebayPageExhausted =
      !marketplace.ebayError &&
      marketplace.ebayCandidates.length < requestPageSize;
    const rakutenPageSize = Math.min(requestPageSize, 100);
    const rakutenPageExhausted =
      !marketplace.rakutenConfigured ||
      (!marketplace.rakutenError && marketplace.rakutenCandidates.length < rakutenPageSize);

    if (ebayPageExhausted && rakutenPageExhausted) {
      local.exhausted = true;
    }

    const explicitOnPage = candidates.filter(isExplicitProduct).length;
    blockedExplicit += explicitOnPage;

    const relevant = filterRelevantCandidates(q, category, candidates, { includeParts });
    relevantCount += relevant.length;
    const interactiveRelevant = relevant.slice(0, ingestLimit);
    const verifyNow = interactiveRelevant
      .filter(candidate => String(candidate.provider || "").toLowerCase() === "ebay")
      .slice(0, verifyLimit);

    opLog("live-search", "first-paint marketplace recall bounded before catalog mutation", {
      query: q,
      marketplaceQuery: variant.query,
      variantReason: variant.reason,
      offset: requestOffset,
      received: candidates.length,
      relevant: relevant.length,
      ingestNow: interactiveRelevant.length,
      ebayVerifyBudget: verifyNow.length,
      blockedExplicit: explicitOnPage,
      pagesSearched: state.pagesSearched,
      elapsedMs: Date.now() - firstPaintStartedAt,
    });

    if (interactiveRelevant.length) {
      // One bounded normalization mutation, deferred persistence, then yield.
      // This preserves every existing canonical identity/trust rule while
      // avoiding the old 200-candidate foreground mutation + huge verification
      // batch before any card could render.
      await backgroundCheckpoint("live-search:first-paint-ingest", { quietMs: 25 });
      const mutationStartedAt = Date.now();
      const ingest = ingestCandidates(interactiveRelevant, { deferPersistence: true });
      productsCreated += ingest.productsCreated;
      offersCreated += ingest.offersCreated;
      offersUpdated += ingest.offersUpdated;
      blockedExplicit += Number(ingest.blockedExplicit || 0);

      // V3.7.47 progressive first paint: these query-local rows have already
      // passed content/relevance/normalization safety. Let the browser fetch
      // their observed-only cards now instead of holding an empty Searching
      // state until exact eBay detail verification finishes. They remain
      // excluded from Deal Heat and competitor intelligence until verified.
      if (ingest.touchedProductIds.length) {
        publishLiveEvent("hydration", {
          phase: "discovery-listings-arrived",
          interactionId: safeInteractionId,
          query: q,
          category: category || "",
          sort,
          page: Math.max(1, Number(page || 1)),
          pageSize: LIVE_SEARCH_SHOPPER_PAGE_SIZE,
          productIds: [...new Set(ingest.touchedProductIds.map(Number).filter(Number.isFinite))],
          includeParts: Boolean(includeParts),
        }, { audience: "public" });
      }

      // First-paint marketplace recall is intentionally eBay-only. Newly
      // ingested eBay sources cannot become public until exact item detail is
      // verified, so running the full draft-auto-review index here is pure
      // duplicate work. The exact verifier below owns the confidence gate.
      const safeAfterIngest = reconcilePublicMatches(ingest.touchedProductIds);
      if (safeAfterIngest.length) {
        publishDiscoveryProgress("safe-existing-normalized-progress", safeAfterIngest);
      }

      opLog("live-search", "first-paint normalization mutation complete", {
        query: q,
        touchedProducts: ingest.touchedProductIds.length,
        currentCount,
        durationMs: Date.now() - mutationStartedAt,
      });

      await new Promise(resolve => setImmediate(resolve));

      // eBay source proof is performed in tiny exact-detail bursts. After each
      // burst, only the touched products are reconciled into the query's safe
      // set and the browser gets a progress event. Discovery keeps filling the
      // page until the target or bounded first-paint barrier is reached.
      const externalIds = [...new Set(
        verifyNow.map(candidate => String(candidate.externalId || "").trim()).filter(Boolean)
      )];
      for (let offset = 0; offset < externalIds.length; offset += verifyBurst) {
        if (Date.now() - firstPaintStartedAt >= firstPaintBudgetMs) break;
        if (superseded()) break;

        const burst = externalIds.slice(offset, offset + verifyBurst);
        const verification = await verifyEbayExternalIds(burst, {
          priority: "interactive",
          maxApiCalls: 1,
          deferPersistence: true,
        });
        verified += Number(verification.verified || 0);
        failures.push(...(verification.failures || []));

        // applyEbayOfferVerifications() already re-runs the exact confidence
        // gate for this touched source batch. Reconcile only those products; a
        // verification burst must not trigger another whole-catalog match scan.
        const newlySafeIds = reconcilePublicMatches(verification.touchedProductIds || []);
        if (newlySafeIds.length) {
          publishDiscoveryProgress("ebay-source-exact-progress", newlySafeIds);
        }
        if (currentCount >= requestedTarget) break;

        await new Promise(resolve => setImmediate(resolve));
      }
    }

    if (superseded()) {
      handOffSupersededWork("shopper-navigation-during-first-paint-source-proof");
      finish("superseded to background", {
        currentCount,
        targetCount: requestedTarget,
        pagesSearched: state.pagesSearched,
      });
      return { ...resultBase(), deferred: true, superseded: true };
    }

    if (
      ebayDeferred &&
      !marketplace.rakutenCandidates.length &&
      (marketplace.skippedRakuten || !marketplace.rakutenConfigured || marketplace.rakutenError)
    ) {
      ensureUserSearchRule(q, category, { deferPersistence: true });
      const rateGuard = getEbayRateGuardStatus();
      finish("marketplace providers temporarily deferred", {
        pagesSearched: state.pagesSearched,
        currentCount,
        queryVariant: variant.query,
      });
      return {
        ...resultBase(),
        deferred: true,
        rateGuard,
        exhausted: false,
        canDiscoverMore: true,
      };
    }

    const remainingVariant = searchPlan.some(planItem =>
      !variantStateFor(state, planItem).exhausted
    );
    if (!remainingVariant) state.exhausted = true;
  }

  if (state.pagesSearched >= maxPagesPerQuery && currentCount < requestedTarget) {
    state.budgetExhausted = true;
  }

  if ((state.exhausted || state.budgetExhausted) && !state.exhaustedAt) {
    state.exhaustedAt = Date.now();
  }

  ensureUserSearchRule(q, category, { deferPersistence: true });

  const canDiscoverMore = !state.exhausted && !state.budgetExhausted;
  const firstPaintBudgetExpired = Date.now() - firstPaintStartedAt >= firstPaintBudgetMs;

  let backgroundContinuation = { queued: false, deduplicated: false };
  if (currentCount > 0) {
    if (currentCount >= requestedTarget || !canDiscoverMore || state.deferred) {
      // True discovery barrier: hydrate only when this requested page is full,
      // the source is actually exhausted/budgeted out, or provider capacity is
      // temporarily deferred. A six-second first-paint slice by itself is no
      // longer allowed to turn a 9-card page into a "completed" hydration pass.
      publishDiscoveryReady(
        currentCount >= requestedTarget
          ? "first-paint-target-reached"
          : state.deferred
            ? "first-paint-page-fill-deferred"
            : "first-paint-source-exhausted",
        [...publicMatchIds]
      );
    } else {
      publishDiscoveryProgress("first-paint-yielded-page-fill-continuing", [...publicMatchIds]);
      backgroundContinuation = queueUserSearchBackgroundContinuation({
        query: q,
        category,
        targetCount: requestedTarget,
        includeParts,
        reason: "partial-first-paint-page-fill",
        delayMs: 250,
        interactionId: safeInteractionId,
        page,
        sort,
      });
    }
  } else if (canDiscoverMore) {
    // Nothing safe is available to hydrate, so continuation cannot interfere
    // with a visible blue-card pass and can enter the background lane now.
    backgroundContinuation = queueUserSearchBackgroundContinuation({
      query: q,
      category,
      targetCount: requestedTarget,
      includeParts,
      reason: "zero-safe-first-paint-handoff",
      interactionId: safeInteractionId,
      page,
      sort,
    });
  }

  opLog("live-search", "first-paint discovery yielded without competitor hydration", {
    query: q,
    currentCount,
    targetCount: requestedTarget,
    pagesThisInteraction,
    elapsedMs: Date.now() - firstPaintStartedAt,
    firstPaintBudgetExpired,
    canDiscoverMore,
  });

  finish("discovery slice complete", {
    received,
    relevant: relevantCount,
    verified,
    currentCount,
    targetCount: requestedTarget,
    pagesSearched: state.pagesSearched,
    exhausted: state.exhausted,
    budgetExhausted: state.budgetExhausted,
    firstPaintBudgetExpired,
  });

  return {
    ...resultBase(),
    exhausted: Boolean(state.exhausted || state.budgetExhausted),
    sourceExhausted: Boolean(state.exhausted),
    budgetExhausted: Boolean(state.budgetExhausted),
    canDiscoverMore,
    firstPaintReady: currentCount > 0,
    firstPaintBudgetExpired,
    backgroundContinuation,
  };
}

export const __liveSearchTest = {
  competitorPageFailurePolicy,
};
