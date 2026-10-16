import {
  escapeHtml,
  money,
  getConfig,
  renderAd,
  connectOfferGridLive,
  restoreScrollAnchor,
  takePreservedViewState,
} from "./common.js?v=3.7.61";

const productGrid = document.querySelector("#products");
const empty = document.querySelector("#empty");
const form = document.querySelector("#search-form");
const searchInput = document.querySelector("#search-input");
const categorySelect = document.querySelector("#category-select");
const sortSelect = document.querySelector("#sort-select");
const includePartsToggle = document.querySelector("#include-parts-toggle");
const trendingPreview = document.querySelector("#trending-preview");
const resultsStatus = document.querySelector("#results-status");
const pagination = document.querySelector("#pagination");
const pagePrev = document.querySelector("#page-prev");
const pageNext = document.querySelector("#page-next");
const pageInfo = document.querySelector("#page-info");

const PAGE_SIZE = 40;
const SHOPPER_VIEW_CLIENT_STORAGE_KEY = "offergrid-shopper-view-client-v1";

function randomViewToken(prefix = "view") {
  const random = globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

const SHOPPER_VIEW_CLIENT_ID = (() => {
  try {
    const existing = sessionStorage.getItem(SHOPPER_VIEW_CLIENT_STORAGE_KEY);
    if (existing) return existing;
    const created = randomViewToken("tab");
    sessionStorage.setItem(SHOPPER_VIEW_CLIENT_STORAGE_KEY, created);
    return created;
  } catch {
    return randomViewToken("tab");
  }
})();
let activeViewId = randomViewToken("view");
let activeDiscoveryInteractionId = "";
let activeHydrationInteractionId = "";

const restoredViewState = takePreservedViewState();
const restoredStoreState =
  restoredViewState?.pageState?.type === "store"
    ? restoredViewState.pageState
    : null;
let pendingRestoredCategory =
  restoredStoreState && typeof restoredStoreState.category === "string"
    ? restoredStoreState.category
    : null;

if (restoredStoreState?.query != null) {
  searchInput.value = String(restoredStoreState.query);
}
if (restoredStoreState?.sort && [...sortSelect.options].some(option => option.value === restoredStoreState.sort)) {
  sortSelect.value = restoredStoreState.sort;
}
if (includePartsToggle && restoredStoreState?.includeParts === true) includePartsToggle.checked = true;
let appliedQuery = String(searchInput?.value || "").trim();

const liveStoreStatus = document.querySelector("#live-store-status");
const searchActivity = document.querySelector("#search-activity");
const searchActivityStage = document.querySelector("#search-activity-stage");
const searchActivityTitle = document.querySelector("#search-activity-title");
const searchActivityDetail = document.querySelector("#search-activity-detail");
const searchActivityProgress = document.querySelector("#search-activity-progress");
const searchActivitySellers = document.querySelector("#search-activity-sellers");
const searchActivitySort = document.querySelector("#search-activity-sort");
const searchActivityBar = document.querySelector("#search-activity-bar");
let liveCatalogTimer = null;
let competitorLiveSortTimer = null;
let sortOnlyRefreshToken = 0;
const liveCompetitorSellerCounts = new Map();
const liveSortAnimations = new WeakMap();
let liveTrendingTimer = null;
let liveCatalogRefreshRunning = false;
let liveCatalogRefreshQueued = false;
let pendingLiveProductIds = new Set();
// V3.7.46 render barrier: discovery may safely publish new normalized products
// before competitor indexing begins. This flag makes the catalog refresh first,
// then starts a separate hydration-mode job using the cards now in the DOM.
let discoveryRenderBarrierPending = false;
let discoveryFallbackTimer = null;
let discoveryFallbackSignature = "";
let discoveryFallbackViewId = "";
// V3.7.55: one foreground competitor pass per shopper interaction. A bounded
// incomplete/paused/completed pass settles this view so late discovery or
// recovery events cannot immediately re-arm the same blue scanner. Sort-only
// changes keep the same view and therefore keep this guard; a real navigation
// or new query gets a fresh view ID and may scan again.
let settledHydrationViewId = "";

// V3.7.45 preserves the visible, ordered competitor indexing
// cursor. Keep this state outside the DOM so safe rerenders can reapply the
// current blue highlight without losing the shopper's sense of progress.
let competitorHydrationUi = {
  active: false,
  passId: "",
  query: "",
  category: "",
  sort: "heat",
  includeParts: false,
  page: 1,
  currentProductId: null,
  currentDisplayNumber: 0,
  visibleProducts: 0,
  currentScanNumber: 0,
  scanTotal: 0,
  currentSignal: "",
  completedIds: new Set(),
  unresolvedIds: new Set(),
};

const SEARCH_ACTIVITY_LABELS = {
  idle: "READY",
  loading: "LOADING",
  discovering: "DISCOVERY",
  hydrating: "COMPETITOR SCAN",
  complete: "COMPLETE",
  paused: "PAUSED",
  error: "ATTENTION",
};

function currentSortLabel() {
  const option = sortSelect?.selectedOptions?.[0];
  return String(option?.textContent || sortSelect?.value || "Default").trim();
}

function updateSearchActivity({
  stage = null,
  title = null,
  detail = null,
  progressCurrent = null,
  progressTotal = null,
  sellers = null,
  sortLabel = null,
  visible = true,
} = {}) {
  if (!searchActivity) return;

  searchActivity.classList.toggle("hidden", !visible);
  if (!visible) return;

  if (stage) {
    searchActivity.dataset.stage = stage;
    if (searchActivityStage) searchActivityStage.textContent = SEARCH_ACTIVITY_LABELS[stage] || String(stage).toUpperCase();
  }
  if (title != null && searchActivityTitle) searchActivityTitle.textContent = String(title);
  if (detail != null && searchActivityDetail) searchActivityDetail.textContent = String(detail);

  const current = Number(progressCurrent);
  const total = Number(progressTotal);
  const progressValid = Number.isFinite(current) && Number.isFinite(total) && total > 0;
  if (searchActivityProgress) {
    searchActivityProgress.textContent = progressValid
      ? `${Math.min(Math.max(0, current), total).toLocaleString()}/${total.toLocaleString()}`
      : "—";
  }
  if (searchActivityBar) {
    const pct = progressValid ? Math.max(0, Math.min(100, (current / total) * 100)) : 0;
    searchActivityBar.style.width = `${pct.toFixed(2)}%`;
    const track = searchActivityBar.parentElement;
    track?.classList.toggle("indeterminate", !progressValid && stage !== "complete");
    if (progressValid) track?.setAttribute("aria-valuenow", String(Math.round(pct)));
    else track?.removeAttribute("aria-valuenow");
  }
  if (searchActivitySellers && sellers != null) {
    const count = Math.max(0, Number(sellers || 0));
    searchActivitySellers.textContent = Number.isFinite(count) ? count.toLocaleString() : "—";
  } else if (searchActivitySellers && stage && stage !== "hydrating") {
    // Stage transitions own their own metrics. Never let the previous product's
    // seller count leak into discovery/loading/completed/error states.
    searchActivitySellers.textContent = "—";
  }
  if (searchActivitySort) searchActivitySort.textContent = sortLabel || currentSortLabel();
}

function hideSearchActivityIfIdle() {
  if (!appliedQuery) {
    updateSearchActivity({ visible: false });
  }
}

function renderedSellerCount(card) {
  const value = Number(card?.dataset?.verifiedSellerCount || 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function setLiveCompetitorSellerCount(productId, sellerCount, { authoritative = false, listingCount = null } = {}) {
  const id = Number(productId);
  const nextRaw = Math.max(0, Number(sellerCount || 0));
  if (!Number.isFinite(id) || !Number.isFinite(nextRaw)) return;

  const card = document.querySelector(`.product-card[data-product-id="${id}"]`);
  const rendered = renderedSellerCount(card);
  const previous = liveCompetitorSellerCounts.has(id)
    ? Number(liveCompetitorSellerCounts.get(id) || 0)
    : rendered;
  const next = authoritative ? nextRaw : Math.max(previous, rendered, nextRaw);
  liveCompetitorSellerCounts.set(id, next);
  updateVisibleSellerCount(id, next, listingCount);
}

function applyLiveCompetitorCountsToCards() {
  for (const [id, count] of liveCompetitorSellerCounts) {
    updateVisibleSellerCount(id, count);
  }
}

function animateLiveSortMoves(beforePositions) {
  if (!beforePositions?.size) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;

  requestAnimationFrame(() => {
    for (const card of document.querySelectorAll(".product-card[data-product-id]")) {
      const id = Number(card.dataset.productId);
      const before = beforePositions.get(id);
      if (!before) continue;
      const after = card.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

      liveSortAnimations.get(card)?.cancel?.();
      if (typeof card.animate !== "function") continue;
      const animation = card.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.94 },
          { transform: "translate(0, 0)", opacity: 1 },
        ],
        {
          duration: 120,
          easing: "cubic-bezier(.2,.72,.2,1)",
        }
      );
      liveSortAnimations.set(card, animation);
      animation.addEventListener?.("finish", () => {
        if (liveSortAnimations.get(card) === animation) liveSortAnimations.delete(card);
      }, { once: true });
    }
  });
}

function applyLiveCompetitorSort() {
  if (!competitorLiveSortViewIsCurrent()) return false;

  const cards = [...productGrid.querySelectorAll(":scope > .product-card[data-product-id]")];
  if (cards.length < 2) return false;

  const ranked = cards.map((card, index) => {
    const id = Number(card.dataset.productId);
    const liveCount = liveCompetitorSellerCounts.has(id)
      ? Number(liveCompetitorSellerCounts.get(id) || 0)
      : renderedSellerCount(card);
    return {
      card,
      id,
      index,
      sellerCount: Math.max(0, Number(liveCount || 0)),
    };
  });

  ranked.sort((a, b) => b.sellerCount - a.sellerCount || a.index - b.index);
  const changed = ranked.some((item, index) => item.card !== cards[index]);
  if (!changed) return false;

  const beforePositions = new Map(
    cards.map(card => [Number(card.dataset.productId), card.getBoundingClientRect()])
  );
  const boundary = [...productGrid.children].find(child => !child.matches?.(".product-card[data-product-id]")) || null;
  for (const item of ranked) productGrid.insertBefore(item.card, boundary);
  productGrid.dataset.liveSort = "active";
  animateLiveSortMoves(beforePositions);
  return true;
}

function applyLocalCardSort(sort = "heat") {
  if (sort === "competitors") return applyLiveCompetitorSort();
  const cards = [...productGrid.querySelectorAll(":scope > .product-card[data-product-id]")];
  if (cards.length < 2) return false;

  const numberFrom = (card, key, fallback = 0) => {
    const raw = card.dataset[key];
    if (raw == null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const ranked = cards.map((card, index) => ({ card, index }));
  ranked.sort((a, b) => {
    const aException = a.card.dataset.conditionException === "true";
    const bException = b.card.dataset.conditionException === "true";
    if (sort === "heat" && aException !== bException) return aException ? 1 : -1;

    if (sort === "price") {
      return (
        numberFrom(b.card, "verificationRank") - numberFrom(a.card, "verificationRank") ||
        numberFrom(a.card, "bestPrice", Number.POSITIVE_INFINITY) -
          numberFrom(b.card, "bestPrice", Number.POSITIVE_INFINITY) ||
        a.index - b.index
      );
    }
    if (sort === "new") {
      return (
        numberFrom(b.card, "verificationRank") - numberFrom(a.card, "verificationRank") ||
        numberFrom(b.card, "updatedAt") - numberFrom(a.card, "updatedAt") ||
        a.index - b.index
      );
    }
    return (
      numberFrom(b.card, "dealHeat") - numberFrom(a.card, "dealHeat") ||
      numberFrom(b.card, "verificationRank") - numberFrom(a.card, "verificationRank") ||
      numberFrom(b.card, "bestScore") - numberFrom(a.card, "bestScore") ||
      a.index - b.index
    );
  });

  const changed = ranked.some((item, index) => item.card !== cards[index]);
  if (!changed) return false;
  const beforePositions = new Map(
    cards.map(card => [Number(card.dataset.productId), card.getBoundingClientRect()])
  );
  const boundary = [...productGrid.children].find(child => !child.matches?.(".product-card[data-product-id]")) || null;
  for (const item of ranked) productGrid.insertBefore(item.card, boundary);
  animateLiveSortMoves(beforePositions);
  return true;
}

function beginShopperView() {
  stopDiscoveryFallbackPoll();
  stopCompetitorLiveSortLoop();
  sortOnlyRefreshToken++;
  liveCompetitorSellerCounts.clear();
  productGrid?.removeAttribute("data-live-sort");
  activeViewId = randomViewToken("view");
  activeDiscoveryInteractionId = "";
  activeHydrationInteractionId = "";
  settledHydrationViewId = "";
  // The old page's blue cursor is no longer authoritative once navigation has
  // begun. The server receives this new view ID on the very next catalog GET
  // and demotes the old page's unfinished interactive job to background work.
  competitorHydrationUi.active = false;
  competitorHydrationUi.passId = "";
  competitorHydrationUi.currentProductId = null;
  competitorHydrationUi.currentDisplayNumber = 0;
  competitorHydrationUi.visibleProducts = 0;
  competitorHydrationUi.currentScanNumber = 0;
  competitorHydrationUi.scanTotal = 0;
  competitorHydrationUi.currentSignal = "";
  competitorHydrationUi.completedIds = new Set();
  competitorHydrationUi.unresolvedIds = new Set();
  return activeViewId;
}

function releaseActiveShopperView() {
  stopCompetitorLiveSortLoop();
  if (!SHOPPER_VIEW_CLIENT_ID || !activeViewId) return;
  const payload = JSON.stringify({
    viewClientId: SHOPPER_VIEW_CLIENT_ID,
    viewId: activeViewId,
  });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        "/api/search/live/release",
        new Blob([payload], { type: "application/json" })
      );
      return;
    }
  } catch {}
  fetch("/api/search/live/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

function shopperScopeMatches(event, { requirePage = false } = {}) {
  if (!event) return false;
  const query = appliedQuery.toLowerCase();
  const category = String(categorySelect?.value || "").trim();
  if (
    String(event.query || "").trim().toLowerCase() !== query ||
    String(event.category || "").trim() !== category ||
    Boolean(event.includeParts) !== Boolean(includePartsToggle?.checked)
  ) return false;
  return !requirePage || Number(event.page || 1) === Number(currentPage || 1);
}

function discoveryScopeMatches(event) {
  return shopperScopeMatches(event);
}

function hydrationViewMatches(event) {
  // Sort is presentation-only. Query/category/page/condition mode define the
  // current result view; interactionId/passId separately define event ownership.
  return shopperScopeMatches(event, { requirePage: true });
}

function foregroundDiscoveryEventMatches(event) {
  if (!event || event.background) return false;
  const interactionId = String(event.interactionId || "");
  return Boolean(
    interactionId &&
    activeDiscoveryInteractionId &&
    interactionId === activeDiscoveryInteractionId &&
    hydrationViewMatches(event)
  );
}

function hydrationInteractionMatches(event) {
  if (!event || event.background) return false;
  const interactionId = String(event.interactionId || "");
  return Boolean(
    interactionId &&
    activeHydrationInteractionId &&
    interactionId === activeHydrationInteractionId &&
    hydrationViewMatches(event)
  );
}

function discoveryPageFill(event = {}) {
  const page = Math.max(1, Number(event.page || currentPage || 1));
  const pageStart = (page - 1) * PAGE_SIZE;
  const cumulative = Math.max(0, Number(event.currentCount || 0));
  const rendered = document.querySelectorAll(".product-card[data-product-id]").length;
  const current = cumulative > 0
    ? Math.max(0, Math.min(PAGE_SIZE, cumulative - pageStart))
    : Math.max(0, Math.min(PAGE_SIZE, rendered));
  return { current, total: PAGE_SIZE };
}

function queueBackgroundDiscoveryCatalogRefresh(event) {
  if (!discoveryScopeMatches(event)) return;
  for (const id of event.productIds || []) {
    const number = Number(id);
    if (Number.isFinite(number)) pendingLiveProductIds.add(number);
  }

  // Shared/scheduled discovery is catalog growth, not lifecycle ownership. It
  // may update the numeric page-fill for an interaction that is already in the
  // DISCOVERY stage, but it can never demote/overwrite an active competitor
  // pass or establish a hydration barrier by itself.
  if (activeDiscoveryInteractionId && !competitorHydrationUi.active) {
    const pageFill = discoveryPageFill({ ...event, page: currentPage });
    if (String(event.phase || "") === "discovery-safe-results-progress") {
      updateSearchActivity({
        stage: "discovering",
        title: "Filling this page",
        detail: "Verified exact matches are continuing to arrive in the background for this page.",
        progressCurrent: pageFill.current,
        progressTotal: pageFill.total,
      });
    }
  }

  // During an active competitor pass do not rebuild the fixed 40-card DOM
  // underneath the local 150ms sorter; pass-end reconciliation adopts growth.
  if (competitorHydrationUi.active && hydrationViewMatches(competitorHydrationUi)) return;
  scheduleCatalogLiveRefresh({
    productIds: Array.isArray(event.productIds) ? event.productIds : [],
    reason: `background-${String(event.phase || "discovery")}`,
  });
}

function applyCompetitorHydrationUi() {
  for (const card of document.querySelectorAll(".product-card[data-product-id]")) {
    const id = Number(card.dataset.productId);
    card.classList.remove("competitor-inspecting", "competitor-indexed", "competitor-index-unresolved");
    card.removeAttribute("data-competitor-scan-label");

    if (competitorHydrationUi.completedIds.has(id)) {
      card.classList.add("competitor-indexed");
    }
    if (competitorHydrationUi.unresolvedIds.has(id)) {
      card.classList.add("competitor-index-unresolved");
    }
    if (competitorHydrationUi.active && Number(competitorHydrationUi.currentProductId) === id) {
      card.classList.add("competitor-inspecting");
      const ordinal = competitorHydrationUi.currentScanNumber || 0;
      const total = competitorHydrationUi.scanTotal || 0;
      const signal = competitorHydrationUi.currentSignal
        ? ` · ${competitorHydrationUi.currentSignal}`
        : "";
      card.dataset.competitorScanLabel =
        `CHECKING COMPETITORS${ordinal && total ? ` ${ordinal}/${total}` : ""}${signal}`;
    }
  }
}

function updateVisibleSellerCount(productId, sellerCount, listingCount = null) {
  const card = document.querySelector(`.product-card[data-product-id="${Number(productId)}"]`);
  if (!card) return;
  const cell = card.querySelector("[data-market-sellers]");
  if (!cell) return;
  const strong = cell.querySelector("strong");
  const small = cell.querySelector("small");
  const count = Math.max(0, Number(sellerCount || 0));
  const currentListings = Math.max(0, Number(card.dataset.verifiedListingCount || 0));
  const incomingListings = Number(listingCount);
  const listings = Number.isFinite(incomingListings) && incomingListings >= 0
    ? incomingListings
    : currentListings;
  card.dataset.verifiedSellerCount = String(count);
  card.dataset.verifiedListingCount = String(listings);
  if (strong) strong.textContent = count ? String(count) : "—";
  if (small) {
    small.textContent = count
      ? `verified seller${count === 1 ? "" : "s"}${listings ? ` · ${listings} listing${listings === 1 ? "" : "s"}` : ""}`
      : listings
        ? `${listings} verified listing${listings === 1 ? "" : "s"}`
        : "Comparison building";
  }
}

const COMPETITOR_LIVE_SORT_INTERVAL_MS = 150;

function competitorLiveSortViewIsCurrent() {
  if (!competitorHydrationUi.active) return false;
  if (String(sortSelect?.value || "heat") !== "competitors") return false;
  if (!appliedQuery) return false;

  return hydrationViewMatches({
    query: competitorHydrationUi.query,
    category: competitorHydrationUi.category,
    sort: competitorHydrationUi.sort,
    page: competitorHydrationUi.page,
    includeParts: competitorHydrationUi.includeParts,
  });
}

function stopCompetitorLiveSortLoop() {
  if (competitorLiveSortTimer) clearTimeout(competitorLiveSortTimer);
  competitorLiveSortTimer = null;
}

function startCompetitorLiveSortLoop() {
  if (competitorLiveSortTimer || !competitorLiveSortViewIsCurrent()) return;

  const tick = () => {
    competitorLiveSortTimer = null;
    if (!competitorLiveSortViewIsCurrent()) return;

    // V3.7.54: product-progress seller counts are newer than the persisted
    // search snapshot until the pass commits. During an active competitor scan,
    // the current 40-card membership has exactly one ordering authority: this
    // local 150ms sorter. Do not let product-complete server rerenders fight it.
    // The backend hydration queue remains fixed and one authoritative full-query
    // refresh runs when the pass ends.
    applyLiveCompetitorCountsToCards();
    applyLiveCompetitorSort();

    competitorLiveSortTimer = setTimeout(
      tick,
      COMPETITOR_LIVE_SORT_INTERVAL_MS
    );
  };

  competitorLiveSortTimer = setTimeout(
    tick,
    COMPETITOR_LIVE_SORT_INTERVAL_MS
  );
}

function handleCompetitorHydrationEvent(event) {
  const phase = String(event?.phase || "");
  const discoveryPhase =
    phase === "discovery-listings-arrived" ||
    phase === "discovery-safe-results-progress" ||
    phase === "discovery-results-ready";

  // V3.7.61: shared background discovery may grow the catalog, but it is never
  // authoritative shopper-progress state. It cannot demote an active blue
  // competitor pass, stop its live sorter, overwrite its progress card, or
  // establish a discovery→hydration barrier for another browser/tab.
  if (discoveryPhase && event?.background) {
    queueBackgroundDiscoveryCatalogRefresh(event);
    return;
  }

  if (discoveryPhase) {
    if (!foregroundDiscoveryEventMatches(event)) return;

    const pageFill = discoveryPageFill(event);
    if (phase === "discovery-listings-arrived") {
      updateSearchActivity({
        stage: "discovering",
        title: "Finding exact matches",
        detail: "Marketplace listings arrived. Exact verification is filtering what can enter this page.",
        progressCurrent: pageFill.current,
        progressTotal: pageFill.total,
      });
      scheduleCatalogLiveRefresh({
        productIds: Array.isArray(event.productIds) ? event.productIds : [],
        reason: "discovery-listings-arrived",
      });
      return;
    }

    if (phase === "discovery-safe-results-progress") {
      updateSearchActivity({
        stage: "discovering",
        title: "Filling this page",
        detail: "Safe exact matches are appearing while marketplace discovery continues.",
        progressCurrent: pageFill.current,
        progressTotal: pageFill.total,
      });
      scheduleCatalogLiveRefresh({
        productIds: Array.isArray(event.productIds) ? event.productIds : [],
        reason: "discovery-safe-results-progress",
      });
      return;
    }

    stopDiscoveryFallbackPoll();
    activeDiscoveryInteractionId = "";

    if (settledHydrationViewId === activeViewId) {
      discoveryRenderBarrierPending = false;
      updateSearchActivity({
        stage: "complete",
        title: "Results updated",
        detail: "Additional verified matches were adopted without restarting the completed competitor scan.",
        progressCurrent: pageFill.current,
        progressTotal: pageFill.total,
      });
      scheduleCatalogLiveRefresh({
        productIds: Array.isArray(event.productIds) ? event.productIds : [],
        reason: "discovery-results-ready-after-settled-hydration",
      });
      return;
    }

    discoveryRenderBarrierPending = true;
    updateSearchActivity({
      stage: "hydrating",
      title: "Preparing competitor scan",
      detail: "Page-fill discovery is complete. Verified seller ranking will now update live.",
      progressCurrent: 0,
      progressTotal: 0,
    });
    scheduleCatalogLiveRefresh({
      productIds: Array.isArray(event.productIds) ? event.productIds : [],
      reason: "discovery-results-ready-render-barrier",
    });
    return;
  }

  if (!hydrationInteractionMatches(event)) return;

  // Only page-start may establish a pass. Once a pass is active, stale events
  // from any other passId are ignored rather than being allowed to resurrect an
  // older cursor and overwrite the progress card.
  if (phase === "page-start") {
    if (settledHydrationViewId === activeViewId) return;
    const incomingPassId = String(event.passId || "");
    if (!incomingPassId) return;
    if (competitorHydrationUi.passId && competitorHydrationUi.active && competitorHydrationUi.passId !== incomingPassId) {
      return;
    }

    liveCompetitorSellerCounts.clear();
    productGrid?.removeAttribute("data-live-sort");
    competitorHydrationUi = {
      active: true,
      passId: incomingPassId,
      query: String(event.query || ""),
      category: String(event.category || ""),
      sort: String(event.sort || "heat"),
      includeParts: Boolean(event.includeParts),
      page: Number(event.page || currentPage || 1),
      currentProductId: null,
      currentDisplayNumber: 0,
      visibleProducts: Number(event.visibleProducts || 0),
      currentScanNumber: 0,
      scanTotal: Number(event.scanTotal ?? event.productsNeedingCoverage ?? 0),
      currentSignal: "",
      completedIds: new Set(),
      unresolvedIds: new Set(),
    };

    startCompetitorLiveSortLoop();
    const due = Number(event.productsNeedingCoverage || 0);
    const stale = Number(event.staleProducts || 0);
    const unresearched = Number(event.unresearchedProducts || 0);
    const freshReused = Number(event.freshCoverageReused || 0);
    updateSearchActivity({
      stage: "hydrating",
      title: "Scanning verified competitors",
      detail: `${due.toLocaleString()} product${due === 1 ? "" : "s"} need fresh coverage${stale || unresearched ? ` · ${stale} stale · ${unresearched} unresearched` : ""}${freshReused ? ` · ${freshReused} recent coverage reused` : ""}.`,
      progressCurrent: 0,
      progressTotal: competitorHydrationUi.scanTotal,
      sellers: 0,
    });
    applyCompetitorHydrationUi();
    return;
  }

  if (phase === "page-error" && !event.passId && !competitorHydrationUi.passId) {
    stopCompetitorLiveSortLoop();
    activeHydrationInteractionId = "";
    updateSearchActivity({
      stage: "error",
      title: "Competitor scan interrupted",
      detail: "A temporary server error stopped this pass. Existing verified seller counts remain valid.",
    });
    return;
  }

  if (!competitorHydrationUi.passId || String(event.passId || "") !== competitorHydrationUi.passId) return;

  const scanNumber = Math.max(0, Number(event.scanNumber || competitorHydrationUi.currentScanNumber || 0));
  const scanTotal = Math.max(0, Number(event.scanTotal || competitorHydrationUi.scanTotal || 0));
  const displayNumber = Math.max(0, Number(event.displayNumber || competitorHydrationUi.currentDisplayNumber || 0));
  const visibleProducts = Math.max(0, Number(event.visibleProducts || competitorHydrationUi.visibleProducts || 0));

  if (phase === "product-start") {
    competitorHydrationUi.active = true;
    competitorHydrationUi.currentProductId = Number(event.productId);
    competitorHydrationUi.currentDisplayNumber = displayNumber;
    competitorHydrationUi.visibleProducts = visibleProducts;
    competitorHydrationUi.currentScanNumber = scanNumber;
    competitorHydrationUi.scanTotal = scanTotal;
    competitorHydrationUi.currentSignal = "";
    startCompetitorLiveSortLoop();
    setLiveCompetitorSellerCount(Number(event.productId), Number(event.sellerCount || 0), {
      authoritative: false,
      listingCount: event.listingCount,
    });
    updateSearchActivity({
      stage: "hydrating",
      title: "Scanning competitors",
      detail: `${String(event.title || "Normalized product")}${displayNumber && visibleProducts ? ` · card ${displayNumber}/${visibleProducts}` : ""}`,
      progressCurrent: scanNumber,
      progressTotal: scanTotal,
      sellers: Number(liveCompetitorSellerCounts.get(Number(event.productId)) ?? event.sellerCount ?? 0),
    });
  } else if (phase === "product-progress") {
    competitorHydrationUi.currentProductId = Number(event.productId);
    competitorHydrationUi.currentDisplayNumber = displayNumber;
    competitorHydrationUi.visibleProducts = visibleProducts;
    competitorHydrationUi.currentScanNumber = scanNumber;
    competitorHydrationUi.scanTotal = scanTotal;
    competitorHydrationUi.currentSignal = String(event.signal || "");
    setLiveCompetitorSellerCount(Number(event.productId), Number(event.sellerCount || 0), {
      authoritative: false,
      listingCount: event.listingCount,
    });
    updateSearchActivity({
      stage: "hydrating",
      title: "Scanning competitors",
      detail: `${event.signal ? `${String(event.signal)} · ` : ""}${String(event.title || "Normalized product")}${displayNumber && visibleProducts ? ` · card ${displayNumber}/${visibleProducts}` : ""}`,
      progressCurrent: scanNumber,
      progressTotal: scanTotal,
      sellers: Number(liveCompetitorSellerCounts.get(Number(event.productId)) ?? event.sellerCount ?? 0),
    });
  } else if (phase === "product-complete") {
    const id = Number(event.productId);
    competitorHydrationUi.completedIds.add(id);
    competitorHydrationUi.unresolvedIds.delete(id);
    competitorHydrationUi.currentScanNumber = scanNumber;
    competitorHydrationUi.scanTotal = scanTotal;
    setLiveCompetitorSellerCount(id, Number(event.sellerCount || 0), {
      authoritative: true,
      listingCount: event.listingCount,
    });
    updateSearchActivity({
      stage: "hydrating",
      title: "Competitor check complete",
      detail: `${String(event.title || "Product")} · live ranking updated`,
      progressCurrent: scanNumber,
      progressTotal: scanTotal,
      sellers: Number(event.sellerCount || 0),
    });
    competitorHydrationUi.currentProductId = null;
    competitorHydrationUi.currentSignal = "";
    applyLiveCompetitorSort();
  } else if (phase === "product-incomplete" || phase === "product-error") {
    const id = Number(event.productId);
    competitorHydrationUi.unresolvedIds.add(id);
    competitorHydrationUi.currentScanNumber = scanNumber;
    competitorHydrationUi.scanTotal = scanTotal;
    setLiveCompetitorSellerCount(id, Number(event.sellerCount || 0), {
      authoritative: true,
      listingCount: event.listingCount,
    });
    updateSearchActivity({
      stage: "hydrating",
      title: phase === "product-error"
        ? (event.pageWillContinue ? "Competitor check failed — continuing page" : "Competitor check needs another pass")
        : "Competitor check time-sliced",
      detail: phase === "product-error" && event.pageWillContinue
        ? `${String(event.title || "Product")} · moving to the next page listing`
        : String(event.title || "Product"),
      progressCurrent: scanNumber,
      progressTotal: scanTotal,
      sellers: Number(event.sellerCount || 0),
    });
    applyLiveCompetitorSort();
  } else if (phase === "page-paused") {
    stopCompetitorLiveSortLoop();
    settledHydrationViewId = activeViewId;
    competitorHydrationUi.active = false;
    competitorHydrationUi.currentProductId = null;
    competitorHydrationUi.currentScanNumber = scanNumber;
    competitorHydrationUi.scanTotal = scanTotal;
    activeHydrationInteractionId = "";
    updateSearchActivity({
      stage: "paused",
      title: "Competitor scan paused",
      detail: "The protected eBay quota budget is temporarily unavailable. Existing verified results remain usable; unresolved coverage moved to background work.",
      progressCurrent: scanNumber,
      progressTotal: scanTotal,
      sellers: Number(event.sellerCount || 0),
    });
  } else if (phase === "page-complete" || phase === "page-incomplete") {
    stopCompetitorLiveSortLoop();
    settledHydrationViewId = activeViewId;
    competitorHydrationUi.active = false;
    competitorHydrationUi.currentProductId = null;
    competitorHydrationUi.currentSignal = "";
    const completed = Number(event.completed || competitorHydrationUi.completedIds.size || 0);
    const selected = Number(event.selected ?? event.scanTotal ?? competitorHydrationUi.scanTotal ?? 0);
    updateSearchActivity({
      stage: "complete",
      title: phase === "page-complete" ? "Competitor scan complete" : "Competitor pass finished",
      detail: phase === "page-complete"
        ? "Every visible product that needed fresh competitor coverage was attempted. Applying one final full-result sort."
        : event.attemptedAllSelected
          ? "Every visible product that needed coverage was attempted. Unresolved products are queued for background verification without restarting this page scan."
          : "A hard provider/quota stop prevented the remaining page checks. Unresolved products were queued for background verification without restarting this page scan.",
      progressCurrent: completed,
      progressTotal: selected,
    });
    activeHydrationInteractionId = "";
    scheduleCatalogLiveRefresh({
      productIds: phase === "page-complete"
        ? [...competitorHydrationUi.completedIds]
        : [...competitorHydrationUi.completedIds, ...competitorHydrationUi.unresolvedIds],
      reason: phase === "page-complete"
        ? "competitor-pass-complete-resort"
        : "competitor-pass-incomplete-resort",
    });
  } else if (phase === "page-demoted") {
    stopCompetitorLiveSortLoop();
    competitorHydrationUi.active = false;
    competitorHydrationUi.currentProductId = null;
    competitorHydrationUi.currentSignal = "";
    activeHydrationInteractionId = "";
    updateSearchActivity({
      stage: "paused",
      title: "Competitor scan moved to background",
      detail: "You changed views. Unfinished coverage will continue without controlling this page.",
      progressCurrent: Number(event.completed || 0),
      progressTotal: scanTotal,
    });
  } else if (phase === "page-error") {
    stopCompetitorLiveSortLoop();
    competitorHydrationUi.active = false;
    competitorHydrationUi.currentProductId = null;
    competitorHydrationUi.currentSignal = "";
    activeHydrationInteractionId = "";
    updateSearchActivity({
      stage: "error",
      title: "Competitor scan interrupted",
      detail: "A temporary server error stopped this pass. Existing verified seller counts remain valid.",
      progressCurrent: Number(event.completed || 0),
      progressTotal: scanTotal,
    });
  }

  applyCompetitorHydrationUi();
}

function setLiveStoreStatus(state, detail = "") {
  if (!liveStoreStatus) return;
  liveStoreStatus.dataset.state = state;
  liveStoreStatus.classList.remove("connected", "reconnecting", "updating");
  if (state === "connected") {
    liveStoreStatus.classList.add("connected");
    liveStoreStatus.textContent = detail || "LIVE";
  } else if (state === "updating") {
    liveStoreStatus.classList.add("updating");
    liveStoreStatus.textContent = detail || "UPDATING";
  } else {
    liveStoreStatus.classList.add("reconnecting");
    liveStoreStatus.textContent = detail || "LIVE RECONNECTING";
  }
}

function visibleProductIds() {
  return new Set([...document.querySelectorAll(".product-card[data-product-id]")].map(card => Number(card.dataset.productId)).filter(Number.isFinite));
}

function normalizedTokens(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function liveSummaryMatchesCurrentView(product) {
  if (!product || !product.approved) return false;
  const category = String(categorySelect?.value || "").trim();
  if (category && String(product.category || "") !== category) return false;
  const query = appliedQuery;
  if (!query) return true;
  const haystack = [product.title, product.brand, product.category].filter(Boolean).join(" ").toLowerCase();
  return normalizedTokens(query).every(token => haystack.includes(token));
}

function liveEventAffectsCurrentCatalog(event) {
  if (!event || !["catalog", "price"].includes(event.type)) return false;
  const visible = visibleProductIds();
  const touched = new Set((event.productIds || []).map(Number).filter(Number.isFinite));
  const deleted = new Set((event.deletedProductIds || []).map(Number).filter(Number.isFinite));
  for (const id of [...touched, ...deleted]) if (visible.has(id)) return true;

  const matching = (Array.isArray(event.products) ? event.products : []).filter(liveSummaryMatchesCurrentView);
  if (!matching.length) return event.reason === "product-lifecycle";
  if (currentPage !== 1) return false;
  const sort = String(sortSelect?.value || "heat");
  if (sort === "new") return event.type === "catalog";
  if (sort === "competitors") return event.type === "catalog" || event.type === "price";
  if (sort === "heat") return matching.some(product => Number(product.heat || 0) >= 75);
  return false;
}

function highlightLiveProducts(productIds = []) {
  const ids = new Set(productIds.map(Number).filter(Number.isFinite));
  for (const card of document.querySelectorAll(".product-card[data-product-id]")) {
    if (!ids.has(Number(card.dataset.productId))) continue;
    card.classList.remove("live-updated");
    requestAnimationFrame(() => {
      card.classList.add("live-updated");
      setTimeout(() => card.classList.remove("live-updated"), 1800);
    });
  }
}

function scheduleTrendingLiveRefresh() {
  if (liveTrendingTimer) clearTimeout(liveTrendingTimer);
  liveTrendingTimer = setTimeout(() => {
    liveTrendingTimer = null;
    loadTrendingPreview().catch(() => {});
  }, 450);
}

async function refreshCatalogFromLive() {
  if (liveCatalogRefreshRunning) {
    liveCatalogRefreshQueued = true;
    return;
  }
  liveCatalogRefreshRunning = true;
  liveCatalogRefreshQueued = false;
  const tokenAtStart = activeLoadToken;
  const highlighted = [...pendingLiveProductIds];
  pendingLiveProductIds.clear();
  setLiveStoreStatus("updating");
  try {
    const data = await fetchCatalogPage({ viewId: activeViewId, preferFresh: true });
    if (tokenAtStart !== activeLoadToken) {
      setLiveStoreStatus("connected", "LIVE");
      return;
    }
    renderCatalogResponse(data);
    highlightLiveProducts(highlighted);
    setLiveStoreStatus("connected", "LIVE");

    if (discoveryRenderBarrierPending && data.products?.length) {
      discoveryRenderBarrierPending = false;
      const query = appliedQuery;
      if (query && data.canLiveSearch && data.needsHydration && settledHydrationViewId !== activeViewId) {
        updateSearchActivity({
          stage: "hydrating",
          title: "Starting competitor scan",
          detail: "Results are on screen. Verified seller counts and competitor ranking will update live without moving your scroll position.",
          progressCurrent: 0,
          progressTotal: Number(data.products.length || 0),
          sellers: "—",
        });
        launchDetachedSearchWork(query, activeLoadToken, activeViewId, { workMode: "hydrate" });
      }
    }
  } catch {
    setLiveStoreStatus("reconnecting");
  } finally {
    liveCatalogRefreshRunning = false;

    if (liveCatalogRefreshQueued || pendingLiveProductIds.size) {
      liveCatalogRefreshQueued = false;
      if (liveCatalogTimer) clearTimeout(liveCatalogTimer);
      liveCatalogTimer = setTimeout(() => {
        liveCatalogTimer = null;
        refreshCatalogFromLive().catch(() => {});
      }, 120);
    }
  }
}

function scheduleCatalogLiveRefresh(event) {
  for (const id of event.productIds || []) {
    const number = Number(id);
    if (Number.isFinite(number)) pendingLiveProductIds.add(number);
  }

  if (liveCatalogTimer) clearTimeout(liveCatalogTimer);
  liveCatalogTimer = setTimeout(() => {
    liveCatalogTimer = null;
    refreshCatalogFromLive().catch(() => {});
  }, 100);
}

function catalogProgressSignature(data) {
  const products = Array.isArray(data?.products) ? data.products : [];
  return JSON.stringify([
    Number(data?.total || 0),
    Number(data?.pendingVerificationCount || 0),
    Boolean(data?.foregroundLiveSearchActive),
    Boolean(data?.backgroundDiscoveryActive),
    products.map(product => [
      Number(product?.id),
      Boolean(product?.verificationPending),
      Boolean(product?.conditionException),
      Number(product?.bestOffer?.id || 0),
      Number(product?.bestOffer?.price || 0),
      String(product?.bestOffer?.priceVerifiedAt || ""),
      String(product?.updatedAt || ""),
      Number(product?.ebayCompetition?.sellerCount || product?.cachedVerifiedSellerCount || 0),
    ]),
  ]);
}

function stopDiscoveryFallbackPoll() {
  if (discoveryFallbackTimer) clearTimeout(discoveryFallbackTimer);
  discoveryFallbackTimer = null;
  discoveryFallbackSignature = "";
  discoveryFallbackViewId = "";
}

function startDiscoveryFallbackPoll(query, token, viewId) {
  stopDiscoveryFallbackPoll();
  const expectedQuery = String(query || "").trim();
  const expectedViewId = String(viewId || activeViewId);
  discoveryFallbackViewId = expectedViewId;

  const poll = async () => {
    if (
      token !== activeLoadToken ||
      expectedViewId !== activeViewId ||
      expectedQuery !== appliedQuery
    ) {
      stopDiscoveryFallbackPoll();
      return;
    }

    try {
      // SSE is the fast path. This low-frequency poll is only a recovery path
      // for a dropped/missed event and uses the current catalog membership when
      // a double-buffered search worker is still warming in the background.
      const data = await fetchCatalogPage({ viewId: expectedViewId, preferFresh: true });
      if (token !== activeLoadToken || expectedViewId !== activeViewId) {
        stopDiscoveryFallbackPoll();
        return;
      }

      const signature = catalogProgressSignature(data);
      if (signature !== discoveryFallbackSignature) {
        discoveryFallbackSignature = signature;
        if (data.products?.length || data.endOfResults) {
          renderCatalogResponse(data);
        }
      }

      const foregroundActive = data.foregroundLiveSearchActive != null
        ? Boolean(data.foregroundLiveSearchActive)
        : Boolean(data.liveSearchActive && !data.backgroundDiscoveryActive);

      if (!foregroundActive) {
        if (data.backgroundDiscoveryActive) {
          // Shared page-fill continuation is still working for this query. Do
          // not launch another foreground discovery job and do not treat it as
          // a blocker forever: keep polling until the scoped continuation
          // barrier arrives or the background job actually settles.
          const pageStart = (Math.max(1, Number(data.page || currentPage || 1)) - 1) * PAGE_SIZE;
          const pageFill = Math.max(0, Math.min(PAGE_SIZE, Number(data.total || 0) - pageStart));
          updateSearchActivity({
            stage: "discovering",
            title: "Filling this page",
            detail: "Verified exact matches are continuing in the background. Competitor scanning will start when this page is ready or discovery reaches its bounded stop.",
            progressCurrent: pageFill,
            progressTotal: PAGE_SIZE,
          });
        } else if (data.needsDiscovery && data.canDiscoverMore) {
          // No foreground or shared continuation owns page fill anymore. Start
          // one bounded recovery interaction rather than mistaking quiet time
          // for discovery completion.
          launchDetachedSearchWork(expectedQuery, token, expectedViewId, { workMode: "discover" });
          stopDiscoveryFallbackPoll();
          return;
        } else if (data.products?.length && data.needsHydration && settledHydrationViewId !== expectedViewId) {
          // If the scoped TRUE discovery-barrier SSE event was lost, the poll
          // can safely complete the handoff after both foreground and shared
          // background discovery have settled.
          discoveryRenderBarrierPending = false;
          launchDetachedSearchWork(expectedQuery, token, expectedViewId, { workMode: "hydrate" });
          stopDiscoveryFallbackPoll();
          return;
        } else if (!data.products?.length && data.endOfResults) {
          renderCatalogResponse(data);
          stopDiscoveryFallbackPoll();
          return;
        } else if (!data.products?.length) {
          updateSearchActivity({
            stage: "paused",
            title: "Discovery is continuing in background",
            detail: "No additional safe exact matches are publishable yet. OfferGrid retained this query for continued discovery.",
            progressCurrent: 0,
            progressTotal: PAGE_SIZE,
          });
          stopDiscoveryFallbackPoll();
          return;
        }
      }
    } catch {
      // Do not disturb an already-useful grid for a recovery-only poll failure.
    }

    discoveryFallbackTimer = setTimeout(poll, 1000);
  };

  discoveryFallbackTimer = setTimeout(poll, 900);
}

function handleStoreLiveEvent(event) {
  if (!event) return;
  if (event.type === "hello") {
    setLiveStoreStatus("connected", "LIVE");
    return;
  }
  if (event.type === "hydration") {
    handleCompetitorHydrationEvent(event);
    return;
  }
  if (!["catalog", "price"].includes(event.type)) return;

  const hasHot = (event.hotProductIds || []).length > 0;
  const hasScorching = (event.scorchingProductIds || []).length > 0;
  if (hasHot || hasScorching || event.type === "price") scheduleTrendingLiveRefresh();
  if (!liveEventAffectsCurrentCatalog(event)) return;

  // While the sequential competitor cursor is active, hydration events own
  // the per-card resort path. Suppress duplicate catalog/price-triggered
  // refreshes here so the browser does not rerender twice for the same scan.
  if (competitorHydrationUi.active && hydrationViewMatches(competitorHydrationUi)) return;

  // Keep the left-side results summary stable. Connection/update state is
  // already represented by the LIVE pill, while the structured activity panel
  // owns long-running search/discovery/competitor progress.
  scheduleCatalogLiveRefresh(event);
}

let currentPage = Math.max(1, Number(restoredStoreState?.page || 1));
let lastTotalPages = 1;
let activeLoadToken = 0;

window.__OFFERGRID_CAPTURE_VIEW_STATE__ = () => ({
  type: "store",
  query: appliedQuery,
  category: String(categorySelect?.value || pendingRestoredCategory || ""),
  sort: String(sortSelect?.value || "heat"),
  includeParts: Boolean(includePartsToggle?.checked),
  page: Number(currentPage || 1),
});

function relativeChecked(value) {
  if (!value) return "verification queued";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "verification queued";

  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (minutes < 2) return "checked just now";
  if (minutes < 60) return `checked ${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `checked ${hours}h ago`;

  return `checked ${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })}`;
}

function isVerifiedEbay(offer) {
  return (
    String(offer?.provider || "").toLowerCase() === "ebay" &&
    Boolean(offer?.priceVerifiedAt)
  );
}

function displayPrice(offer) {
  if (!offer) return "Unavailable";
  if (offer.priceDisplayRestricted) return "See eBay for price";

  if (
    String(offer.provider || "").toLowerCase() === "ebay" &&
    !offer.priceVerifiedAt
  ) {
    return "Verifying price…";
  }

  return money(offer.price, offer.currency);
}

function accuracyBadge(product) {
  const accuracy = product.priceAccuracy || {};

  if (product.verificationPending || accuracy.status === "pending") {
    return `<span class="accuracy-badge pending">◷ eBay verification pending</span>`;
  }

  if (accuracy.status === "verified") {
    return `<span class="accuracy-badge verified">✓ eBay price verified</span>`;
  }
  if (accuracy.status === "verified-stale") {
    return `<span class="accuracy-badge stale">eBay detail verified</span>`;
  }
  if (accuracy.status === "restricted") {
    return `<span class="accuracy-badge neutral">Price shown on merchant</span>`;
  }
  if (accuracy.status === "provider") {
    return `<span class="accuracy-badge neutral">Provider price</span>`;
  }

  return `<span class="accuracy-badge neutral">Verification queued</span>`;
}

function offerPriceMeta(offer) {
  const parts = [];

  if (offer?.lotSize && Number(offer.lotSize) > 1) {
    parts.push(`lot of ${Number(offer.lotSize)}`);
  }

  if (offer?.unitPrice != null && offer?.unitPricingMeasure) {
    parts.push(
      `${money(
        offer.unitPrice,
        offer.unitPriceCurrency || offer.currency
      )} / ${escapeHtml(offer.unitPricingMeasure)}`
    );
  }

  if (offer?.shippingPrice === 0) {
    parts.push("free shipping");
  } else if (offer?.shippingPrice != null) {
    parts.push(`+ ${money(offer.shippingPrice, offer.currency)} shipping`);
  }

  return parts.join(" · ");
}

function ebayCompetitionBadge(product) {
  const c = product.ebayCompetition;
  const listings = Math.max(0, Number(c?.listingCount || 0));
  const sellers = Math.max(0, Number(c?.sellerCount || 0));
  if (!c || listings < 2) return "";
  return `<span class="market-badge neutral" title="${sellers} unique verified seller${sellers === 1 ? "" : "s"}">${listings} verified eBay listing${listings === 1 ? "" : "s"}</span>`;
}

function marketBadge(product) {
  const m = product.marketComparison;
  if (!m) return "";

  if (!m.available) {
    return `<span class="market-badge neutral">Market check building</span>`;
  }

  if (m.verdict === "ebay-lower" || m.verdict === "tied") {
    return `<span class="market-badge good" title="Based on offers currently tracked by OfferGrid. A lower price may exist elsewhere.">✓ Lowest verified tracked</span>`;
  }

  if (m.verdict === "competitor-lower") {
    return `<span class="market-badge warn" title="Based on offers currently tracked by OfferGrid. A lower price may exist elsewhere.">Lower tracked price found</span>`;
  }

  return `<span class="market-badge neutral">Cross-store checked</span>`;
}

function heatBadge(product) {
  if (
    String(product.bestOffer?.provider || "").toLowerCase() === "ebay" &&
    !product.bestOffer?.priceVerifiedAt
  ) {
    return `<span class="heat-badge">Heat pending verification</span>`;
  }

  const s = product.priceStats || {};
  const cls = s.dealHeat >= 75 ? "hot" : s.dealHeat >= 60 ? "warm" : "";
  return `<span class="heat-badge ${cls}">🔥 ${Number(s.dealHeat || 0)} · ${escapeHtml(s.heatLabel || "Watch")}</span>`;
}

function cardPriceSignal(product) {
  const stats = product.priceStats || {};
  const historyCount = Number(stats.historyCount || 0);
  const heat = Number(stats.dealHeat || 0);
  const belowAverage = Number(stats.savingsVsAveragePct || 0);

  if (historyCount < 2) {
    return {
      label: "HISTORY BUILDING",
      cls: "neutral",
      detail: "More verified observations needed",
    };
  }

  if (stats.newLow && heat >= 70) {
    return {
      label: "NEW TRACKED LOW",
      cls: "good",
      detail: "Strong current price signal",
    };
  }

  if (heat >= 75 || belowAverage >= 10) {
    return {
      label: "BUY WINDOW",
      cls: "good",
      detail: "Materially below recent baseline",
    };
  }

  if (heat >= 60 || belowAverage >= 5) {
    return {
      label: "WORTH CONSIDERING",
      cls: "neutral",
      detail: "Better than recent context",
    };
  }

  if (belowAverage <= -3) {
    return {
      label: "WAIT / COMPARE",
      cls: "warn",
      detail: "Above recent tracked average",
    };
  }

  return {
    label: "TYPICAL PRICE",
    cls: "neutral",
    detail: "Near recent tracked baseline",
  };
}

function cardPricePosition(product) {
  const stats = product.priceStats || {};
  const current = Number(stats.currentPrice);
  const low = Number(stats.low30d);
  const high = Number(stats.high30d);

  if (
    Number(stats.historyCount || 0) < 2 ||
    !Number.isFinite(current) ||
    !Number.isFinite(low) ||
    !Number.isFinite(high)
  ) {
    return { label: "Range building", cls: "neutral" };
  }

  if (high <= low) {
    return { label: "Flat tracked range", cls: "neutral" };
  }

  const pct = Math.max(
    0,
    Math.min(100, ((current - low) / (high - low)) * 100)
  );

  if (pct <= 20) return { label: "Near 30d low", cls: "good" };
  if (pct <= 45) return { label: "Lower half", cls: "good" };
  if (pct <= 65) return { label: "Mid-range", cls: "neutral" };
  if (pct <= 85) return { label: "Upper half", cls: "warn" };
  return { label: "Near 30d high", cls: "warn" };
}

function cardMomentum(product) {
  const stats = product.priceStats || {};
  const historyCount = Number(stats.historyCount || 0);
  const previous = Number(stats.changeVsPreviousPct || 0);

  if (historyCount < 2) {
    return { label: "Building", cls: "neutral" };
  }

  if (previous <= -1) {
    return {
      label: `↓ ${Math.abs(previous).toFixed(1)}%`,
      cls: "good",
    };
  }

  if (previous >= 1) {
    return {
      label: `↑ ${Math.abs(previous).toFixed(1)}%`,
      cls: "warn",
    };
  }

  return { label: "→ Stable", cls: "neutral" };
}

function cardMarketCount(product) {
  const verifiedSellers = Number(product.ebayCompetition?.sellerCount);
  const verifiedListings = Number(product.ebayCompetition?.listingCount);
  if (Number.isFinite(verifiedSellers) && verifiedSellers > 0) {
    return {
      count: Math.round(verifiedSellers),
      verifiedSellers: true,
      listingCount: Number.isFinite(verifiedListings) && verifiedListings > 0
        ? Math.round(verifiedListings)
        : 0,
    };
  }

  const candidates = [
    product.marketComparison?.activeOfferCount,
    product.trackedOfferCount,
    product.ebayCompetition?.trackedListingCount,
    product.ebayCompetition?.observedListingCount,
    product.offers?.length,
  ];

  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return { count: Math.round(number), verifiedSellers: false, listingCount: 0 };
    }
  }

  return { count: 0, verifiedSellers: false, listingCount: 0 };
}

function cardIntelligence(product) {
  if (product.verificationPending) {
    return `
      <div class="card-intelligence pending-verification-intel">
        <div class="card-signal warn">
          <span>PRICE SIGNAL</span>
          <strong>VERIFICATION PENDING</strong>
          <small>OfferGrid is withholding Deal Heat until eBay exact-item verification succeeds.</small>
        </div>
        <div class="pending-verification-facts">
          <span><b>Observed listing</b> matched your search</span>
          <span><b>History</b> not counted yet</span>
          <span><b>Cross-store claims</b> withheld</span>
        </div>
      </div>
    `;
  }

  const stats = product.priceStats || {};
  const signal = cardPriceSignal(product);
  const position = cardPricePosition(product);
  const momentum = cardMomentum(product);
  const market = cardMarketCount(product);
  const sellerCount = market.count;
  const historyCount = Number(stats.historyCount || 0);
  const currency = product.bestOffer?.currency || "USD";

  const averageText =
    historyCount >= 2 &&
    Number.isFinite(Number(stats.average30d))
      ? money(Number(stats.average30d), currency)
      : "Building";

  const lowText =
    historyCount >= 2 &&
    Number.isFinite(Number(stats.low30d))
      ? money(Number(stats.low30d), currency)
      : "Building";

  const versusAverage =
    historyCount >= 2 &&
    Number.isFinite(Number(stats.savingsVsAveragePct))
      ? Number(stats.savingsVsAveragePct) >= 0
        ? `${Number(stats.savingsVsAveragePct).toFixed(1)}% below avg`
        : `${Math.abs(Number(stats.savingsVsAveragePct)).toFixed(1)}% above avg`
      : "History building";

  return `
    <div class="card-intelligence">
      <div class="card-signal ${signal.cls}">
        <span>PRICE SIGNAL</span>
        <strong>${escapeHtml(signal.label)}</strong>
        <small>${escapeHtml(signal.detail)}</small>
      </div>

      <div class="card-intel-grid">
        <div class="card-intel-cell">
          <span>30D AVG</span>
          <strong>${escapeHtml(averageText)}</strong>
          <small>${escapeHtml(versusAverage)}</small>
        </div>

        <div class="card-intel-cell">
          <span>30D LOW</span>
          <strong>${escapeHtml(lowText)}</strong>
          <small class="${position.cls}">${escapeHtml(position.label)}</small>
        </div>

        <div class="card-intel-cell">
          <span>MOMENTUM</span>
          <strong class="${momentum.cls}">${escapeHtml(momentum.label)}</strong>
          <small>${historyCount ? `${historyCount} tracked sample${historyCount === 1 ? "" : "s"}` : "No history yet"}</small>
        </div>

        <div class="card-intel-cell" data-market-sellers>
          <span>MARKET</span>
          <strong>${sellerCount || "—"}</strong>
          <small>${sellerCount
            ? market.verifiedSellers
              ? `verified seller${sellerCount === 1 ? "" : "s"}${market.listingCount ? ` · ${market.listingCount} listing${market.listingCount === 1 ? "" : "s"}` : ""}`
              : `tracked offer${sellerCount === 1 ? "" : "s"}`
            : market.listingCount
              ? `${market.listingCount} verified listing${market.listingCount === 1 ? "" : "s"}`
              : "Comparison building"}</small>
        </div>
      </div>
    </div>
  `;
}

function priceHistoryMicrochart(product) {
  const conditionException = Boolean(product?.conditionException);
  const productHref = `/product.html?id=${product.id}${conditionException ? "&includeParts=true" : ""}`;
  const points = Array.isArray(product.priceSparkline)
    ? product.priceSparkline
        .filter(point =>
          point &&
          Number.isFinite(Number(point.price)) &&
          Number.isFinite(Date.parse(point.at || ""))
        )
        .slice(-18)
    : [];

  if (points.length < 2) {
    return `
      <a
        class="product-mini-chart product-mini-chart-empty"
        href="${productHref}"
        aria-label="Open price history for ${escapeHtml(product.displayTitle || product.title)}"
      >
        <span class="mini-chart-kicker">PRICE HISTORY</span>
        <strong>Building</strong>
        <small>More verified observations needed</small>
      </a>
    `;
  }

  const prices = points.map(point => Number(point.price));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = Math.max(max - min, Math.max(max * 0.01, 0.01));

  const width = 100;
  const height = 100;
  const left = 10;
  const right = 6;
  const top = 24;
  const bottom = 20;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const coordinates = points.map((point, index) => {
    const x =
      left +
      (index / Math.max(1, points.length - 1)) *
        plotWidth;

    const y =
      top +
      ((max - Number(point.price)) / range) *
        plotHeight;

    return {
      x,
      y,
      price: Number(point.price),
      at: point.at,
    };
  });

  const line = coordinates
    .map((point, index) =>
      `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
    )
    .join(" ");

  const area =
    `${line} ` +
    `L ${coordinates.at(-1).x.toFixed(2)} ${(top + plotHeight).toFixed(2)} ` +
    `L ${coordinates[0].x.toFixed(2)} ${(top + plotHeight).toFixed(2)} Z`;

  const firstAt = Date.parse(points[0].at);
  const lastAt = Date.parse(points.at(-1).at);
  const spanDays =
    Number.isFinite(firstAt) && Number.isFinite(lastAt)
      ? Math.max(1, Math.round((lastAt - firstAt) / 86_400_000))
      : null;

  const spanLabel =
    spanDays == null
      ? "TRACKED"
      : spanDays <= 35
        ? "30D"
        : spanDays <= 100
          ? "90D"
          : "1Y";

  const currency =
    product.bestOffer?.currency ||
    "USD";

  const latest = prices.at(-1);
  const previous = prices.at(-2);
  const delta =
    Number.isFinite(previous) && previous !== 0
      ? ((latest - previous) / previous) * 100
      : 0;

  const trendClass =
    delta < -0.15
      ? "down"
      : delta > 0.15
        ? "up"
        : "flat";

  const trendText =
    trendClass === "down"
      ? `↓ ${Math.abs(delta).toFixed(1)}%`
      : trendClass === "up"
        ? `↑ ${Math.abs(delta).toFixed(1)}%`
        : "→ stable";

  return `
    <a
      class="product-mini-chart"
      href="${productHref}"
      aria-label="Open tracked price history for ${escapeHtml(product.displayTitle || product.title)}"
    >
      <div class="mini-chart-heading">
        <span>PRICE HISTORY</span>
        <b>${spanLabel}</b>
      </div>

      <svg
        class="mini-chart-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label="Tracked price history from ${money(min, currency)} to ${money(max, currency)}"
      >
        <line x1="10" y1="24" x2="94" y2="24" class="mini-chart-grid"/>
        <line x1="10" y1="52" x2="94" y2="52" class="mini-chart-grid"/>
        <line x1="10" y1="80" x2="94" y2="80" class="mini-chart-grid"/>
        <path d="${area}" class="mini-chart-area"/>
        <path d="${line}" class="mini-chart-line"/>
        <circle
          cx="${coordinates.at(-1).x.toFixed(2)}"
          cy="${coordinates.at(-1).y.toFixed(2)}"
          r="2.2"
          class="mini-chart-dot"
        />
      </svg>

      <div class="mini-chart-footer">
        <span>${money(min, currency)} low</span>
        <strong class="${trendClass}">${trendText}</strong>
      </div>
    </a>
  `;
}

function productCard(product) {
  const offer = product.bestOffer;
  const stats = product.priceStats || {};
  const pendingVerification = Boolean(product.verificationPending);
  const conditionException = Boolean(product.conditionException);
  const productHref = `/product.html?id=${product.id}${conditionException ? "&includeParts=true" : ""}`;
  const title = product.displayTitle || product.title;
  const imageUrl = product.displayImageUrl || product.imageUrl;

  const image = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async" fetchpriority="low">`
    : `<div class="placeholder-art"><span>${escapeHtml((product.category || "Deal").slice(0, 18))}</span></div>`;

  const note = product.editorNote || product.aiSummary || "";
  const verifiedPrice = isVerifiedEbay(offer) || String(offer?.provider || "").toLowerCase() !== "ebay";
  const original =
    verifiedPrice &&
    offer?.originalPrice &&
    offer.originalPrice > offer.price &&
    !offer.priceDisplayRestricted
      ? `<span class="old-price">${money(offer.originalPrice, offer.currency)}</span>`
      : "";

  const history = conditionException
    ? `<div class="price-intel pending"><span>For-parts / non-working listing · always excluded from Deal Heat and competitor ranking</span></div>`
    : pendingVerification
      ? `<div class="price-intel pending"><span>Observed listing only · excluded from Deal Heat until exact eBay verification</span></div>`
    : verifiedPrice && stats.historyCount >= 2
      ? `<div class="price-intel">
           <span>30d avg <b>${money(stats.average30d, offer.currency)}</b></span>
           <span>30d low <b>${money(stats.low30d, offer.currency)}</b></span>
         </div>`
      : `<div class="price-intel"><span>${verifiedPrice ? "Verified price history is building" : "Exact price verification queued"}</span></div>`;

  const displayedCardPrice = pendingVerification && offer && Number.isFinite(Number(offer.price))
    ? `${money(Number(offer.price), offer.currency)} <small>observed</small>`
    : displayPrice(offer);

  const priceMeta = offerPriceMeta(offer);

  return `
    <article class="product-card ${conditionException ? "condition-exception" : ""}" data-product-id="${product.id}" data-condition-exception="${conditionException}" data-deal-heat="${Number(stats.dealHeat || 0)}" data-best-price="${Number.isFinite(Number(offer?.price)) ? Number(offer.price) : ""}" data-best-score="${Number(offer?.score || 0)}" data-verification-rank="${verifiedPrice ? 2 : 0}" data-updated-at="${Date.parse(product.updatedAt || 0) || 0}" data-verified-seller-count="${conditionException ? 0 : cardMarketCount(product).count}" data-verified-listing-count="${conditionException ? 0 : cardMarketCount(product).listingCount}">
      <div class="product-visual-stack">
        <a class="product-image" href="${productHref}">${image}</a>
        ${conditionException
          ? `<a class="product-mini-chart product-mini-chart-empty condition-exception-chart" href="${productHref}" aria-label="Open condition-specific listing for ${escapeHtml(title)}">
               <span class="mini-chart-kicker">CONDITION MODE</span>
               <strong>Excluded</strong>
               <small>No Deal Heat, price history, or competitor ranking</small>
             </a>`
          : priceHistoryMicrochart(product)}
      </div>
      <div class="product-body">
        <div class="card-badges">
          ${accuracyBadge(product)}
          ${conditionException ? `<span class="condition-exception-badge">FOR PARTS / NON-WORKING / NOT TESTED</span>` : ""}
          ${conditionException ? "" : heatBadge(product)}
          ${ebayCompetitionBadge(product)}
          ${conditionException ? "" : marketBadge(product)}
          ${conditionException ? "" : (stats.newLow ? `<span class="new-low">NEW LOW</span>` : "")}
        </div>

        <div class="meta">
          ${escapeHtml(product.category)}
          ${product.brand ? ` · ${escapeHtml(product.brand)}` : ""}
        </div>

        <h2><a href="${productHref}">${escapeHtml(title)}</a></h2>

        ${note
          ? `<p>${escapeHtml(note.slice(0, 165))}${note.length > 165 ? "…" : ""}</p>`
          : ""}

        <div class="price-line ${pendingVerification ? "pending" : ""}">
          <strong>${displayedCardPrice}</strong>${pendingVerification ? "" : original}
        </div>

        ${priceMeta ? `<div class="offer-price-meta">${priceMeta}</div>` : ""}

        ${history}

        <div class="rank-line">
          <span>${escapeHtml(offer?.merchant || "Merchant")}</span>
          <b>${escapeHtml(product.priceAccuracy?.label || "Price source pending")}</b>
        </div>

        <div class="card-trust-meta">
          <span>${escapeHtml(relativeChecked(product.priceAccuracy?.verifiedAt || offer?.lastSeen))}</span>
          <a href="/methodology.html#data-accuracy">Data accuracy</a>
        </div>
        ${conditionException ? "" : cardIntelligence(product)}

        <a
          class="primary-button ${pendingVerification ? "pending-verification-button" : ""}"
          href="${productHref}"
        >${conditionException ? "View excluded-condition listing" : pendingVerification ? "View pending listing" : "View price intelligence"}</a>
      </div>
    </article>
  `;
}

function trendingMiniCard(product) {
  const offer = product.bestOffer;
  const stats = product.priceStats || {};
  const title = product.displayTitle || product.title;
  const imageUrl = product.displayImageUrl || product.imageUrl;

  const image = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async" fetchpriority="low">`
    : `<div class="placeholder-art mini-placeholder"><span>${escapeHtml((product.category || "Deal").slice(0, 16))}</span></div>`;

  return `
    <article class="trend-mini">
      <a class="trend-mini-image" href="/product.html?id=${product.id}">${image}</a>
      <div class="trend-mini-body">
        ${accuracyBadge(product)}
        <span class="heat-badge ${stats.dealHeat >= 75 ? "hot" : stats.dealHeat >= 60 ? "warm" : ""}">
          🔥 ${Number(stats.dealHeat || 0)} · ${escapeHtml(stats.heatLabel || "Watch")}
        </span>
        <h3><a href="/product.html?id=${product.id}">${escapeHtml(title)}</a></h3>
        <div class="trend-mini-price">${displayPrice(offer)}</div>
        <div class="mini-accuracy">${escapeHtml(product.priceAccuracy?.label || "")}</div>
        <a href="/product.html?id=${product.id}" class="secondary-link">Analyze price →</a>
      </div>
    </article>
  `;
}

async function loadTrendingPreview() {
  if (!trendingPreview) return;

  const response = await fetch("/api/deals/trending?limit=6");
  const data = await readJsonResponse(response, "Could not decode the catalog response.");

  if (!response.ok) {
    throw new Error(data.error || "Could not load trending deals.");
  }

  trendingPreview.innerHTML = data.products.length
    ? data.products.map(trendingMiniCard).join("")
    : `<div class="empty compact-empty">
         <h3>Price signals will appear here automatically.</h3>
         <p>OfferGrid is building verified price history and market context from connected sources.</p>
       </div>`;
}

function setSearchState(
  query,
  detail = "Searching additional marketplace pages for exact, relevant products…",
  { preserveResults = true } = {}
) {
  const existingCards = productGrid.querySelectorAll(".product-card").length;

  if (preserveResults && existingCards) {
    productGrid.querySelector(".search-expansion-card")?.remove();
    productGrid.insertAdjacentHTML("beforeend", `
      <div class="search-expansion-card" aria-live="polite">
        <div class="searching-orbit" aria-hidden="true"></div>
        <div>
          <div class="eyebrow">PRECISION CATALOG EXPANSION</div>
          <strong>Finding more exact matches for “${escapeHtml(query)}”</strong>
          <p>${escapeHtml(detail)}</p>
        </div>
      </div>
    `);
  } else {
    productGrid.innerHTML = `
      <div class="live-search-state">
        <div class="searching-orbit" aria-hidden="true"></div>
        <div>
          <div class="eyebrow">LIVE PRICE INTELLIGENCE SEARCH</div>
          <h2>Finding products for “${escapeHtml(query)}”</h2>
          <p>${escapeHtml(detail)}</p>
        </div>
      </div>
    `;
    pagination?.classList.add("hidden");
  }

  empty.classList.add("hidden");
  if (pageNext) pageNext.disabled = true;

  if (resultsStatus) {
    resultsStatus.textContent = existingCards
      ? `${existingCards.toLocaleString()} relevant result${existingCards === 1 ? "" : "s"} currently on screen`
      : "Waiting for the first safe exact matches";
  }
  updateSearchActivity({
    stage: "discovering",
    title: existingCards ? "Filling this page" : "Searching marketplaces",
    detail,
    progressCurrent: existingCards,
    progressTotal: PAGE_SIZE,
  });
}

function updatePagination(data) {
  currentPage = Number(data.page || currentPage || 1);
  lastTotalPages = Math.max(1, Number(data.totalPages || 1));
  if (pagination) pagination.dataset.currentPage = String(currentPage);

  const total = Number(data.total || 0);
  const hasTrackedNext = currentPage < lastTotalPages;
  const canDiscoverMore = Boolean(data.canDiscoverMore);

  if (pageInfo) {
    const discoverySuffix = canDiscoverMore && currentPage >= lastTotalPages
      ? " · more exact results can be discovered"
      : "";
    pageInfo.textContent =
      `Page ${currentPage} of ${lastTotalPages} · ${total.toLocaleString()} relevant item${total === 1 ? "" : "s"}${discoverySuffix}`;
  }

  if (pagePrev) pagePrev.disabled = currentPage <= 1;
  if (pageNext) pageNext.disabled = !hasTrackedNext && !canDiscoverMore;

  const queryActive = Boolean(appliedQuery);
  pagination.classList.toggle(
    "hidden",
    !queryActive && total <= PAGE_SIZE
  );
}

function endOfResultsCard(data) {
  const deferred = Boolean(data.discoveryDeferred);
  return `
    <div class="end-results-card ${deferred ? "deferred" : ""}">
      <div class="end-results-icon" aria-hidden="true">${deferred ? "◷" : "✓"}</div>
      <div>
        <div class="eyebrow">${deferred ? "DISCOVERY PAUSED" : "SEARCH COMPLETE"}</div>
        <strong>${deferred ? "More exact results may appear later" : "End of Results"}</strong>
        <p>${deferred
          ? "OfferGrid reached the current marketplace API allowance. Existing results remain strictly matched to your search; no unrelated products are being used as filler."
          : "OfferGrid searched the available marketplace result budget and found no more products that meet this search precisely. Unrelated category-adjacent products are intentionally omitted."}</p>
      </div>
    </div>
  `;
}

function renderCatalogResponse(data) {
  applyCatalogCategories(data);
  const products = Array.isArray(data.products) ? data.products : [];
  const total = Number(data.total || 0);
  const page = Number(data.page || currentPage || 1);
  const totalPages = Math.max(1, Number(data.totalPages || 1));
  const isLastKnownPage = page >= totalPages;
  const showEnd = Boolean(data.endOfResults) && isLastKnownPage;

  productGrid.innerHTML =
    products.map(productCard).join("") +
    (showEnd ? endOfResultsCard(data) : "");

  applyCompetitorHydrationUi();
  applyLiveCompetitorCountsToCards();
  applyLiveCompetitorSort();
  empty.classList.toggle("hidden", products.length !== 0 || showEnd);

  if (resultsStatus) {
    const start =
      total > 0 && products.length
        ? ((page - 1) * Number(data.pageSize || PAGE_SIZE)) + 1
        : 0;
    const end = products.length
      ? Math.min(total, start + products.length - 1)
      : 0;

    if (products.length) {
      const pendingCount = Number(data.pendingVerificationCount || 0);
      const pendingSuffix = pendingCount
        ? ` · ${pendingCount.toLocaleString()} eBay result${pendingCount === 1 ? "" : "s"} awaiting exact verification`
        : "";
      resultsStatus.textContent =
        `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} strictly relevant products${pendingSuffix}`;
    } else if (showEnd) {
      resultsStatus.textContent = "No products met this search precisely.";
    } else {
      resultsStatus.textContent = "";
    }
  }

  updatePagination(data);
  if (!appliedQuery && !competitorHydrationUi.active) {
    hideSearchActivityIfIdle();
  }
}

async function readJsonResponse(response, fallbackMessage = "OfferGrid returned an invalid API response.") {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const text = await response.text();
  let data = null;
  if (contentType.includes("application/json") || /^[\s]*[\[{]/.test(text)) {
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = null;
    }
  }
  if (!data || typeof data !== "object") {
    const error = new Error(
      response.ok
        ? fallbackMessage
        : `OfferGrid API temporarily returned HTTP ${response.status}. Retrying live updates…`
    );
    error.code = "NON_JSON_API_RESPONSE";
    error.status = response.status;
    throw error;
  }
  return data;
}

async function fetchCatalogPage({ viewId = activeViewId, preferFresh = false } = {}) {
  const params = new URLSearchParams();

  if (appliedQuery) params.set("q", appliedQuery);
  const requestedCategory = pendingRestoredCategory != null
    ? String(pendingRestoredCategory)
    : String(categorySelect.value || "");
  if (requestedCategory) params.set("category", requestedCategory);
  if (sortSelect?.value) params.set("sort", sortSelect.value);
  if (includePartsToggle?.checked) params.set("includeParts", "true");

  params.set("page", String(currentPage));
  params.set("pageSize", String(PAGE_SIZE));
  params.set("viewClientId", SHOPPER_VIEW_CLIENT_ID);
  params.set("viewId", String(viewId || activeViewId));
  if (preferFresh) params.set("fresh", "1");

  const response = await fetch(`/api/products?${params}`, {
    cache: "no-store",
  });
  const data = await readJsonResponse(response, "Could not decode the catalog response.");

  if (!response.ok) {
    const error = new Error(data.error || "Could not load products.");
    error.code = data.code || "";
    throw error;
  }

  Object.defineProperty(data, "__requestedCategory", {
    value: requestedCategory,
    configurable: true,
  });

  return data;
}

function applyCatalogCategories(data) {
  if (!categorySelect || !Object.prototype.hasOwnProperty.call(data || {}, "__requestedCategory")) return;
  const currentCategory = String(data.__requestedCategory || "");
  const categories = Array.isArray(data.categories) ? data.categories : [];
  categorySelect.innerHTML =
    `<option value="">All categories</option>` +
    categories
      .map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
      .join("");
  categorySelect.value = [...categorySelect.options].some(option => option.value === currentCategory)
    ? currentCategory
    : "";
  pendingRestoredCategory = null;
}

async function startDetachedSearchWork(query, token, viewId, { workMode = "auto" } = {}) {
  const targetCount = currentPage * PAGE_SIZE;
  if (token !== activeLoadToken) return null;

  const response = await fetch("/api/search/live", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: query,
      category: categorySelect.value,
      sort: sortSelect?.value || "heat",
      includeParts: Boolean(includePartsToggle?.checked),
      page: currentPage,
      pageSize: PAGE_SIZE,
      targetCount,
      visibleProductIds: [...visibleProductIds()],
      workMode,
      viewClientId: SHOPPER_VIEW_CLIENT_ID,
      viewId: String(viewId || activeViewId),
    }),
  });

  const data = await readJsonResponse(response, "Could not start live competitor indexing.");
  if (!response.ok) {
    const error = new Error(data.error || "Live marketplace indexing could not start.");
    error.code = data.code || "";
    throw error;
  }

  if (token !== activeLoadToken) return null;
  const effectiveMode = String(data.workMode || workMode || "auto");
  const interactionId = String(data.interactionId || "");
  if (effectiveMode === "discover") {
    activeDiscoveryInteractionId = interactionId;
  } else if (effectiveMode === "hydrate") {
    activeHydrationInteractionId = interactionId;
    activeDiscoveryInteractionId = "";
  }
  if (data.searching) {
    if (effectiveMode === "discover") {
      updateSearchActivity({
        stage: "discovering",
        title: "Searching marketplaces",
        detail: data.started
          ? "Finding and exact-verifying relevant listings until this page is full or the source is exhausted/deferred."
          : "Marketplace discovery is already active for this search.",
        progressCurrent: Number.isFinite(Number(data.currentCount)) && Number(data.currentCount) > 0
          ? Math.max(0, Math.min(PAGE_SIZE, Number(data.currentCount) - ((currentPage - 1) * PAGE_SIZE)))
          : Math.max(0, Math.min(PAGE_SIZE, document.querySelectorAll(".product-card[data-product-id]").length)),
        progressTotal: PAGE_SIZE,
      });
    } else {
      updateSearchActivity({
        stage: "hydrating",
        title: "Scanning verified competitors",
        detail: data.started
          ? "The page is ready. Verified seller counts and competitor ranking will update live."
          : "A competitor scan is already active for this page.",
        progressCurrent: 0,
        progressTotal: Number(data.visibleProducts || document.querySelectorAll(".product-card[data-product-id]").length || 0),
        sellers: 0,
      });
    }
  }
  return data;
}

function launchDetachedSearchWork(query, token, viewId, options = {}) {
  startDetachedSearchWork(query, token, viewId, options).catch(error => {
    if (token !== activeLoadToken) return;
    // Background enrichment failure must never replace a usable product grid.
    updateSearchActivity({
      stage: "error",
      title: "Live indexing paused",
      detail: error?.code === "NON_JSON_API_RESPONSE"
        ? "The live API connection was interrupted. Existing verified seller counts remain valid while OfferGrid reconnects."
        : String(error?.message || "Temporary live indexing error"),
    });
    setLiveStoreStatus("reconnecting");
  });
}

async function applySortOnly() {
  const requestToken = ++sortOnlyRefreshToken;
  const selectedSort = String(sortSelect?.value || "heat");
  const scanActive = Boolean(competitorHydrationUi.active) &&
    hydrationViewMatches({
      query: competitorHydrationUi.query,
      category: competitorHydrationUi.category,
      page: competitorHydrationUi.page,
      includeParts: competitorHydrationUi.includeParts,
    });

  if (searchActivitySort) searchActivitySort.textContent = currentSortLabel();

  // Sort changes are presentation-only. Never call beginShopperView() and never
  // POST /api/search/live from this path, so changing the dropdown cannot
  // demote/restart discovery or competitor hydration.
  if (scanActive) {
    applyLiveCompetitorCountsToCards();
    applyLocalCardSort(selectedSort);
    if (selectedSort === "competitors") startCompetitorLiveSortLoop();
    else {
      stopCompetitorLiveSortLoop();
      productGrid?.removeAttribute("data-live-sort");
    }
    updateSearchActivity({
      stage: "hydrating",
      title: "Scanning competitors",
      detail: "Sort changed without restarting the scan. The current cards were re-ranked locally; the full result set will reconcile when scanning finishes.",
      progressCurrent: competitorHydrationUi.currentScanNumber,
      progressTotal: competitorHydrationUi.scanTotal,
      sellers: competitorHydrationUi.currentProductId != null
        ? Number(liveCompetitorSellerCounts.get(Number(competitorHydrationUi.currentProductId)) || 0)
        : 0,
      sortLabel: currentSortLabel(),
    });
    return;
  }

  if (selectedSort !== "competitors") {
    stopCompetitorLiveSortLoop();
    productGrid?.removeAttribute("data-live-sort");
  }

  // For non-competitor sorts (or an idle competitor sort), ask only the catalog
  // search endpoint to re-rank the existing discovered dataset. Reuse the same
  // shopper view ID and never launch discovery/hydration as a side effect.
  const data = await fetchCatalogPage({ viewId: activeViewId, preferFresh: true });
  if (requestToken !== sortOnlyRefreshToken) return;

  renderCatalogResponse(data);
  applyLiveCompetitorCountsToCards();

  if (scanActive) {
    applyCompetitorHydrationUi();
    updateSearchActivity({
      stage: "hydrating",
      title: "Competitor scan still running",
      detail: "The display sort changed without restarting or rescanning this page.",
      progressCurrent: competitorHydrationUi.currentScanNumber,
      progressTotal: competitorHydrationUi.scanTotal,
      sellers: competitorHydrationUi.currentProductId != null
        ? Number(liveCompetitorSellerCounts.get(Number(competitorHydrationUi.currentProductId)) || 0)
        : 0,
      sortLabel: currentSortLabel(),
    });
    if (selectedSort === "competitors") startCompetitorLiveSortLoop();
  } else {
    updateSearchActivity({
      stage: "complete",
      title: "Sort updated",
      detail: "Existing discovered results were re-ranked. No marketplace search or competitor rescan was started.",
      sortLabel: currentSortLabel(),
    });
  }
}

async function loadProducts({
  allowLiveSearch = true,
  resetPage = false,
} = {}) {
  const token = ++activeLoadToken;
  // Every user-initiated search/category/sort/page load is a new authoritative
  // view. Sending this ID with the catalog request demotes stale-page work on
  // the server before the new page does any meaningful work.
  const viewId = beginShopperView();

  if (resetPage) currentPage = 1;

  updateSearchActivity({
    stage: "loading",
    title: "Loading results",
    detail: appliedQuery
      ? `Preparing the current 40-card view for “${appliedQuery}”.`
      : "Preparing the catalog.",
    sortLabel: currentSortLabel(),
  });

  productGrid.innerHTML = `<div class="loading">Loading catalog page…</div>`;
  empty.classList.add("hidden");

  let data;
  try {
    data = await fetchCatalogPage();
  } catch (error) {
    if (error.code === "SEARCH_BLOCKED") {
      productGrid.innerHTML = `
        <div class="end-results-card blocked-search">
          <div class="end-results-icon" aria-hidden="true">×</div>
          <div>
            <div class="eyebrow">SEARCH NOT AVAILABLE</div>
            <strong>This query is outside OfferGrid's catalog policy.</strong>
            <p>OfferGrid does not search for or add explicit products to its database.</p>
          </div>
        </div>`;
      empty.classList.add("hidden");
      pagination.classList.add("hidden");
      if (resultsStatus) resultsStatus.textContent = "";
      updateSearchActivity({
        stage: "error",
        title: "Search not available",
        detail: "This query is outside OfferGrid's catalog policy.",
      });
      return;
    }
    throw error;
  }

  if (token !== activeLoadToken) return;

  const query = appliedQuery;
  let preserveDiscoveryState = false;

  if (
    allowLiveSearch &&
    query &&
    (data.needsDiscovery || data.needsHydration || data.foregroundLiveSearchActive) &&
    data.canLiveSearch
  ) {
    // Discovery owns first paint until the requested page has had a bounded
    // chance to fill. Competitor hydration never starts merely because the
    // first one or two safe products appeared. Existing cards remain usable
    // while the discovery lane continues filling the page.
    const workMode = data.needsDiscovery || !data.products.length
      ? "discover"
      : "hydrate";

    if (data.products.length) {
      renderCatalogResponse(data);
      const message = workMode === "discover"
        ? "Safe matches are ready now while OfferGrid continues filling this page before competitor indexing."
        : "Database results are ready — live competitor indexing will move through this page in display order.";
      setSearchState(query, message, { preserveResults: true });
    } else if (workMode === "discover") {
      // Critical V3.7.47 zero-result fix: do not let the original empty catalog
      // response overwrite the Searching card after detached discovery starts.
      setSearchState(
        query,
        "Marketplace discovery is running now. Safe listings will appear here as soon as they pass the local trust gate — before competitor hydration begins.",
        { preserveResults: false }
      );
      preserveDiscoveryState = true;
    }

    launchDetachedSearchWork(query, token, viewId, { workMode });
    if (workMode === "discover") {
      startDiscoveryFallbackPoll(query, token, viewId);
    }
  }

  // If discovery proves the requested page is beyond the real end, move to the
  // last populated page and put the End of Results card after its final item.
  if (
    query &&
    data.endOfResults &&
    !data.products.length &&
    Number(data.total || 0) > 0
  ) {
    const lastPage = Math.max(1, Math.ceil(Number(data.total) / PAGE_SIZE));
    if (currentPage > lastPage) {
      currentPage = lastPage;
      data = await fetchCatalogPage({ viewId });
      if (token !== activeLoadToken) return;
      data.endOfResults = true;
    }
  }

  if (preserveDiscoveryState && !data.products.length) return;
  renderCatalogResponse(data);
}

form.addEventListener("submit", event => {
  event.preventDefault();
  appliedQuery = String(searchInput.value || "").trim();
  loadProducts({
    allowLiveSearch: true,
    resetPage: true,
  }).catch(showError);
});

categorySelect?.addEventListener("change", () => {
  loadProducts({
    allowLiveSearch: true,
    resetPage: true,
  }).catch(showError);
});

sortSelect?.addEventListener("change", () => {
  applySortOnly().catch(showError);
});

includePartsToggle?.addEventListener("change", () => {
  loadProducts({
    allowLiveSearch: Boolean(appliedQuery),
    resetPage: true,
  }).catch(showError);
});

pagePrev?.addEventListener("click", () => {
  if (currentPage <= 1) return;
  currentPage--;
  window.scrollTo({ top: 0, behavior: "smooth" });
  loadProducts({ allowLiveSearch: Boolean(appliedQuery) }).catch(showError);
});

pageNext?.addEventListener("click", () => {
  if (pageNext.disabled) return;
  currentPage++;
  window.scrollTo({ top: 0, behavior: "smooth" });
  loadProducts({ allowLiveSearch: true }).catch(showError);
});

function showError(error) {
  const hasVisibleProducts = Boolean(productGrid.querySelector(".product-card[data-product-id]"));
  if (hasVisibleProducts) {
    updateSearchActivity({
      stage: "error",
      title: "Live update interrupted",
      detail: `${String(error?.message || "Temporary API error")}. Keeping the current verified results on screen.`,
    });
    setLiveStoreStatus("reconnecting");
    return;
  }
  updateSearchActivity({
    stage: "error",
    title: "Could not load offers",
    detail: String(error?.message || "Temporary error"),
  });
  productGrid.innerHTML = `
    <div class="empty">
      <h2>Could not load offers.</h2>
      <p>${escapeHtml(error.message)}</p>
    </div>
  `;
}

window.addEventListener("pagehide", releaseActiveShopperView);

(async () => {
  try {
    const config = await getConfig();
    renderAd(document.querySelector("#ad-slot"), config);

    // V3.7.45: connect SSE before the first searchable catalog load. A DB-only
    // query can begin normalized-product hydration inside loadProducts(), so
    // waiting until that promise resolves would miss the entire blue indexing
    // cursor on the initial page load.
    connectOfferGridLive({
      onEvent: handleStoreLiveEvent,
      onStatus: status => {
        if (status === "connected") setLiveStoreStatus("connected", "LIVE");
        else if (status === "reconnecting") setLiveStoreStatus("reconnecting");
      },
    });

    await Promise.all([
      loadTrendingPreview(),
      loadProducts({ allowLiveSearch: Boolean(appliedQuery) }),
    ]);

    if (restoredViewState?.viewport) {
      restoreScrollAnchor(restoredViewState.viewport, { retries: 6 });
    }
  } catch (error) {
    showError(error);
  }
})();
