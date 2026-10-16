import {
  escapeHtml,
  money,
  getConfig,
  renderAd,
  connectOfferGridLive,
  captureScrollAnchor,
  restoreScrollAnchor,
  takePreservedViewState,
} from "./common.js?v=3.7.61";

const grid = document.querySelector("#trending-products");
const restoredViewState = takePreservedViewState();

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

function ebayCompetitionBadge(product) {
  const c = product.ebayCompetition;
  if (!c || c.listingCount < 2) return "";
  return `<span class="market-badge neutral">${c.listingCount} verified eBay sellers</span>`;
}

function marketBadge(product) {
  const m = product.marketComparison;
  if (!m) return "";

  if (m.available && (m.verdict === "ebay-lower" || m.verdict === "tied")) {
    return `<span class="market-badge good" title="Based on offers currently tracked by OfferGrid. A lower price may exist elsewhere.">✓ Lowest verified tracked</span>`;
  }

  if (m.available && m.verdict === "competitor-lower") {
    return `<span class="market-badge warn" title="Based on offers currently tracked by OfferGrid. A lower price may exist elsewhere.">Lower tracked price found</span>`;
  }

  if (m) return `<span class="market-badge neutral">Cross-store checked</span>`;
  return "";
}

function priceHistoryMicrochart(product) {
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
        href="/product.html?id=${product.id}"
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
      href="/product.html?id=${product.id}"
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

function card(product) {
  const offer = product.bestOffer;
  const stats = product.priceStats || {};
  const title = product.displayTitle || product.title;
  const imageUrl = product.displayImageUrl || product.imageUrl;

  const image = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async" fetchpriority="low">`
    : `<div class="placeholder-art"><span>${escapeHtml(product.category)}</span></div>`;

  return `
    <article class="product-card" data-product-id="${product.id}">
      <div class="product-visual-stack">
        <a class="product-image" href="/product.html?id=${product.id}">${image}</a>
        ${priceHistoryMicrochart(product)}
      </div>

      <div class="product-body">
        <div class="card-badges">
          ${accuracyBadge(product)}
          ${offer?.priceVerifiedAt || String(offer?.provider || "").toLowerCase() !== "ebay"
            ? `<span class="heat-badge ${stats.dealHeat >= 75 ? "hot" : stats.dealHeat >= 60 ? "warm" : ""}">
                 🔥 ${stats.dealHeat || 0} · ${escapeHtml(stats.heatLabel || "Watch")}
               </span>`
            : `<span class="heat-badge">Heat pending verification</span>`}
          ${ebayCompetitionBadge(product)}
          ${marketBadge(product)}
          ${stats.newLow ? `<span class="new-low">NEW LOW</span>` : ""}
        </div>

        <div class="meta">
          ${escapeHtml(product.category)}
          ${product.brand ? ` · ${escapeHtml(product.brand)}` : ""}
        </div>

        <h2><a href="/product.html?id=${product.id}">${escapeHtml(title)}</a></h2>

        <div class="price-line">
          <strong>${displayPrice(offer)}</strong>
        </div>

        ${stats.historyCount >= 2 && offer?.priceVerifiedAt
          ? `<div class="price-intel">
               <span>${stats.savingsVsAveragePct.toFixed(1)}% below 30d avg</span>
               <span>Low ${money(stats.low30d, offer.currency)}</span>
             </div>`
          : `<div class="price-intel"><span>Verified price history building</span></div>`}

        <div class="card-trust-meta">
          <span>${escapeHtml(product.priceAccuracy?.label || "Verification queued")}</span>
          <a href="/methodology.html#data-accuracy">Data accuracy</a>
        </div>

        <a class="primary-button" href="/product.html?id=${product.id}">
          View price intelligence
        </a>
      </div>
    </article>
  `;
}

let trendingLiveTimer = null;

async function loadTrending({ preservePosition = false } = {}) {
  const response = await fetch("/api/deals/trending?limit=60", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load deals.");
  const viewport = preservePosition
    ? captureScrollAnchor(".product-card[data-product-id]")
    : null;
  grid.innerHTML = data.products.length
    ? data.products.map(card).join("")
    : `<div class="empty"><h2>No strong price signals yet.</h2><p>Verified price history is still building enough context to rank purchasing signals.</p></div>`;
  if (viewport) restoreScrollAnchor(viewport, { retries: 1 });
}

function handleTrendingLiveEvent(event) {
  if (!["catalog", "price"].includes(event.type)) return;
  const shouldRefresh = event.type === "price" || (event.hotProductIds || []).length > 0 || (event.scorchingProductIds || []).length > 0 || event.reason === "product-hidden" || event.reason === "product-deleted";
  if (!shouldRefresh) return;
  if (trendingLiveTimer) clearTimeout(trendingLiveTimer);
  trendingLiveTimer = setTimeout(() => {
    trendingLiveTimer = null;
    loadTrending({ preservePosition: true }).catch(() => {});
  }, 300);
}

(async () => {
  try {
    const cfg = await getConfig();
    renderAd(document.querySelector("#ad-slot"), cfg);
    await loadTrending();
    if (restoredViewState?.viewport) {
      restoreScrollAnchor(restoredViewState.viewport, { retries: 6 });
    }
    connectOfferGridLive({ onEvent: handleTrendingLiveEvent });
  } catch (error) {
    grid.innerHTML = `<div class="empty"><h2>Could not load deals.</h2><p>${escapeHtml(error.message)}</p></div>`;
  }
})();
