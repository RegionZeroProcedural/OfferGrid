import {
  escapeHtml,
  money,
  percent,
  getConfig,
  renderAd,
  connectOfferGridLive,
  captureScrollAnchor,
  restoreScrollAnchor,
  takePreservedViewState,
} from "./common.js?v=3.7.61";

const view = document.querySelector("#product-view");
const restoredViewState = takePreservedViewState();
const productParams = new URLSearchParams(location.search);
const id = Number(productParams.get("id"));
const includeParts = String(productParams.get("includeParts") || "").toLowerCase() === "true";
const productApiSuffix = includeParts ? "?includeParts=true" : "";

let chartController = null;

function formatDate(value, withYear = false) {
  const date = new Date(value);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {})
  });
}

function formatDateTime(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function providerName(value) {
  const provider = String(value || "").toLowerCase();
  if (provider === "ebay") return "eBay";
  if (provider === "bestbuy") return "Best Buy";
  if (provider === "awin") return "Awin merchant";
  if (provider === "rakuten") return "Rakuten merchant";
  if (provider === "amazon") return "Amazon";
  return String(value || "Merchant");
}


function rangeHistory(history, range) {
  if (range === "all") return history.slice();

  const days = Number(range);
  const cutoff = Date.now() - days * 86_400_000;
  const filtered = history.filter(point => Date.parse(point.at) >= cutoff);

  // If a requested range has only one recent point, include the immediately
  // preceding point so the chart can still show how the price arrived there.
  if (filtered.length === 1) {
    const firstIndex = history.indexOf(filtered[0]);
    if (firstIndex > 0) return [history[firstIndex - 1], ...filtered];
  }

  return filtered;
}

function calculateVisibleStats(history) {
  if (!history.length) return null;

  const prices = history.map(p => Number(p.price)).filter(Number.isFinite);
  if (!prices.length) return null;

  const current = prices.at(-1);
  const first = prices[0];
  const average = prices.reduce((a, b) => a + b, 0) / prices.length;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const change = first > 0 ? ((current - first) / first) * 100 : 0;

  return { current, first, average, low, high, change, count: prices.length };
}

class PriceHistoryChart {
  constructor(canvas, history, currency, tooltip, summary) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.history = history.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    this.currency = currency;
    this.tooltip = tooltip;
    this.summary = summary;
    this.range = "30";
    this.hoverIndex = null;

    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvas);

    canvas.addEventListener("mousemove", event => this.onMouseMove(event));
    canvas.addEventListener("mouseleave", () => {
      this.hoverIndex = null;
      this.tooltip.classList.add("hidden");
      this.draw();
    });

    this.draw();
  }

  setRange(range) {
    this.range = range;
    this.hoverIndex = null;
    this.tooltip.classList.add("hidden");
    this.draw();
  }

  destroy() {
    this.resizeObserver?.disconnect();
    this.tooltip?.classList.add("hidden");
  }

  get visible() {
    return rangeHistory(this.history, this.range);
  }

  dimensions() {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(320, this.canvas.clientWidth || 800);
    const height = Math.max(300, this.canvas.clientHeight || 340);

    if (this.canvas.width !== Math.round(width * ratio) ||
        this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }

    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width, height };
  }

  plotGeometry(history, width, height) {
    const pad = { left: 74, right: 22, top: 28, bottom: 48 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const prices = history.map(p => Number(p.price));
    let min = Math.min(...prices);
    let max = Math.max(...prices);

    if (min === max) {
      const spread = Math.max(1, min * 0.05);
      min -= spread;
      max += spread;
    } else {
      const spread = (max - min) * 0.12;
      min -= spread;
      max += spread;
    }

    const t0 = Date.parse(history[0].at);
    const t1 = Date.parse(history.at(-1).at);
    const span = Math.max(1, t1 - t0);

    const x = at => pad.left + ((Date.parse(at) - t0) / span) * plotW;
    const y = price => pad.top + (1 - ((Number(price) - min) / (max - min))) * plotH;

    return { pad, plotW, plotH, min, max, t0, t1, span, x, y };
  }

  draw() {
    const history = this.visible;
    const { width, height } = this.dimensions();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);

    if (!history.length) {
      ctx.fillStyle = "#97a2af";
      ctx.font = "14px system-ui";
      ctx.fillText("No recorded price samples yet.", 20, 40);
      return;
    }

    const geo = this.plotGeometry(history, width, height);
    const { pad, min, max, x, y } = geo;

    // Background
    ctx.fillStyle = "#0a0e12";
    ctx.fillRect(0, 0, width, height);

    // Horizontal grid + y labels
    ctx.font = "12px system-ui";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= 4; i++) {
      const fraction = i / 4;
      const value = max - (max - min) * fraction;
      const yy = pad.top + geo.plotH * fraction;

      ctx.strokeStyle = "#222b34";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(width - pad.right, yy);
      ctx.stroke();

      ctx.fillStyle = "#8995a3";
      const label = money(value, this.currency);
      ctx.fillText(label, 8, yy);
    }

    // Average line
    const visibleStats = calculateVisibleStats(history);
    if (visibleStats) {
      const avgY = y(visibleStats.average);
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "#596777";
      ctx.beginPath();
      ctx.moveTo(pad.left, avgY);
      ctx.lineTo(width - pad.right, avgY);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = "#8995a3";
      ctx.font = "11px system-ui";
      ctx.fillText(
        `Avg ${money(visibleStats.average, this.currency)}`,
        Math.max(pad.left + 4, width - pad.right - 145),
        avgY - 10
      );
    }

    // Area under the line
    if (history.length >= 2) {
      const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
      gradient.addColorStop(0, "rgba(239, 244, 249, 0.18)");
      gradient.addColorStop(1, "rgba(239, 244, 249, 0.01)");

      ctx.beginPath();
      history.forEach((point, index) => {
        const xx = x(point.at);
        const yy = y(point.price);
        if (index === 0) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      });
      ctx.lineTo(x(history.at(-1).at), height - pad.bottom);
      ctx.lineTo(x(history[0].at), height - pad.bottom);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    // Price line
    ctx.strokeStyle = "#f1f5f9";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    history.forEach((point, index) => {
      const xx = history.length === 1 ? pad.left + geo.plotW / 2 : x(point.at);
      const yy = y(point.price);
      if (index === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    });
    ctx.stroke();

    // Point markers
    history.forEach((point, index) => {
      const xx = history.length === 1 ? pad.left + geo.plotW / 2 : x(point.at);
      const yy = y(point.price);
      const selected = index === this.hoverIndex;

      ctx.beginPath();
      ctx.arc(xx, yy, selected ? 5 : history.length <= 16 ? 3 : 2, 0, Math.PI * 2);
      ctx.fillStyle = selected ? "#ffffff" : "#cbd5e1";
      ctx.fill();
    });

    // X labels
    ctx.fillStyle = "#8995a3";
    ctx.font = "12px system-ui";
    ctx.textBaseline = "alphabetic";

    const leftLabel = formatDate(history[0].at, true);
    const rightLabel = formatDate(history.at(-1).at, true);
    ctx.fillText(leftLabel, pad.left, height - 16);

    const rightWidth = ctx.measureText(rightLabel).width;
    ctx.fillText(rightLabel, width - pad.right - rightWidth, height - 16);

    // Hover line
    if (this.hoverIndex != null && history[this.hoverIndex]) {
      const point = history[this.hoverIndex];
      const xx = history.length === 1 ? pad.left + geo.plotW / 2 : x(point.at);

      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xx, pad.top);
      ctx.lineTo(xx, height - pad.bottom);
      ctx.stroke();
    }

    this.renderSummary(history);
  }

  renderSummary(history) {
    if (!this.summary) return;
    const stats = calculateVisibleStats(history);
    if (!stats) {
      this.summary.innerHTML = "";
      return;
    }

    const direction =
      stats.change < -0.05 ? "down" :
      stats.change > 0.05 ? "up" :
      "flat";

    const changeText =
      direction === "flat"
        ? "No net change"
        : `${Math.abs(stats.change).toFixed(1)}% ${direction === "down" ? "lower" : "higher"}`;

    this.summary.innerHTML = `
      <div><span>Range low</span><strong>${money(stats.low, this.currency)}</strong></div>
      <div><span>Range high</span><strong>${money(stats.high, this.currency)}</strong></div>
      <div><span>Range average</span><strong>${money(stats.average, this.currency)}</strong></div>
      <div><span>Since range start</span><strong class="${direction}">${changeText}</strong></div>
    `;
  }

  onMouseMove(event) {
    const history = this.visible;
    if (!history.length) return;

    const rect = this.canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const { width, height } = this.dimensions();
    const geo = this.plotGeometry(history, width, height);

    let nearestIndex = 0;
    let nearestDistance = Infinity;

    history.forEach((point, index) => {
      const xx =
        history.length === 1
          ? geo.pad.left + geo.plotW / 2
          : geo.x(point.at);
      const distance = Math.abs(mouseX - xx);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    this.hoverIndex = nearestIndex;
    const point = history[nearestIndex];

    this.tooltip.innerHTML = `
      <strong>${money(point.price, this.currency)}</strong>
      <span>${escapeHtml(formatDate(point.at, true))}</span>
      <span>${escapeHtml(point.merchant || "Recorded offer")}</span>
    `;
    this.tooltip.classList.remove("hidden");

    const tooltipX = Math.min(
      Math.max(event.clientX - rect.left + 14, 8),
      Math.max(8, rect.width - 190)
    );
    const tooltipY = Math.max(8, event.clientY - rect.top - 74);
    this.tooltip.style.left = `${tooltipX}px`;
    this.tooltip.style.top = `${tooltipY}px`;

    this.draw();
  }
}

function accuracyText(offer) {
  if (offer.priceDisplayRestricted) return "Price displayed by merchant";
  if (String(offer.provider).toLowerCase() !== "ebay") return "Provider-reported";
  if (offer.priceVerifiedAt) return `Verified ${formatDateTime(offer.priceVerifiedAt)}`;
  return "Awaiting exact eBay item verification";
}

function priceBasisText(offer) {
  const parts = [];

  if (offer.lotSize && Number(offer.lotSize) > 1) {
    parts.push(`lot of ${Number(offer.lotSize)}`);
  }

  if (offer.unitPrice != null && offer.unitPricingMeasure) {
    parts.push(
      `${money(
        offer.unitPrice,
        offer.unitPriceCurrency || offer.currency
      )} / ${offer.unitPricingMeasure}`
    );
  }

  if (offer.shippingPrice === 0) {
    parts.push("free shipping");
  } else if (offer.shippingPrice != null) {
    parts.push(`+ ${money(offer.shippingPrice, offer.currency)} shipping`);
  }

  return parts.join(" · ");
}

function displayOfferPrice(offer) {
  if (!offer) return "Unavailable";
  if (offer.priceDisplayRestricted) return "See eBay for price";

  if (
    String(offer.provider).toLowerCase() === "ebay" &&
    !offer.priceVerifiedAt
  ) {
    return "Verifying price…";
  }

  return money(offer.price, offer.currency);
}

function offerRow(offer, bestOfferId) {
  return `
    <div class="offer-row ${offer.id === bestOfferId ? "best-row" : ""}">
      <div>
        <strong>${escapeHtml(offer.merchant)}</strong>
        <div class="meta">
          ${escapeHtml(offer.provider.toUpperCase())} ·
          ${escapeHtml(offer.condition || offer.availability)}
          ${offer.id === bestOfferId ? " · CURRENT DISPLAY OFFER" : ""}
        </div>
        <div class="offer-accuracy-line">${escapeHtml(accuracyText(offer))}</div>
      </div>

      <div>
        <strong>${displayOfferPrice(offer)}</strong>
        ${priceBasisText(offer)
          ? `<div class="meta">${escapeHtml(priceBasisText(offer))}</div>`
          : ""}
      </div>

      <div class="offer-score">${Number(offer.score || 0).toFixed(1)}</div>

      <a
        class="small-button"
        target="_blank"
        rel="sponsored nofollow noopener"
        href="/go/${offer.id}"
      >View</a>
    </div>
  `;
}


function conditionOfferRow(offer, bestOfferId) {
  return `
    <div class="offer-row ${offer.id === bestOfferId ? "best-row" : ""}">
      <div>
        <strong>${escapeHtml(offer.merchant)}</strong>
        <div class="meta">
          ${escapeHtml(String(offer.provider || "merchant").toUpperCase())} ·
          ${escapeHtml(offer.condition || "For parts / non-working")}
          ${offer.id === bestOfferId ? " · DISPLAYED CONDITION LISTING" : ""}
        </div>
        <div class="offer-accuracy-line">${escapeHtml(accuracyText(offer))}</div>
      </div>

      <div>
        <strong>${displayOfferPrice(offer)}</strong>
        ${priceBasisText(offer)
          ? `<div class="meta">${escapeHtml(priceBasisText(offer))}</div>`
          : ""}
      </div>

      <div class="offer-score offer-score-pending">EXCLUDED</div>

      <a
        class="small-button"
        target="_blank"
        rel="sponsored nofollow noopener"
        href="/go/${offer.id}"
      >View</a>
    </div>
  `;
}


function discoverySignalBadges(offer = {}) {
  const labels = Array.isArray(offer.discoveryLabels)
    ? offer.discoveryLabels
    : [];
  const methods = Array.isArray(offer.discoveryMethods)
    ? offer.discoveryMethods
    : [];

  const pairs = [];
  const max = Math.max(labels.length, methods.length);
  for (let index = 0; index < max; index++) {
    const method = String(methods[index] || offer.discoveryPrimaryMethod || "unknown").toLowerCase();
    const label = String(labels[index] || offer.discoveryPrimaryLabel || method || "Observed signal");
    if (!label) continue;
    pairs.push({ method, label });
  }

  if (!pairs.length && offer.discoveryPrimaryLabel) {
    pairs.push({
      method: String(offer.discoveryPrimaryMethod || "unknown").toLowerCase(),
      label: String(offer.discoveryPrimaryLabel),
    });
  }

  const unique = [];
  const seen = new Set();
  for (const pair of pairs) {
    const key = `${pair.method}:${pair.label}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pair);
  }

  return unique.slice(0, 5).map(pair => {
    const cls =
      ["gtin", "epid", "brand-mpn"].includes(pair.method)
        ? "signal-high"
        : pair.method === "mpn"
          ? "signal-medium"
          : "signal-exploratory";
    return `<span class="discovery-signal-badge ${cls}">${escapeHtml(pair.label)}</span>`;
  }).join("");
}

function discoveryAccuracyText(offer = {}) {
  const tier = String(offer.discoveryTier || "").toLowerCase();
  if (tier === "high") return "High-confidence discovery signal";
  if (tier === "medium") return "Moderate discovery signal";
  return "Exploratory listing match";
}

function pendingTrackedOfferRow(offer = {}) {
  const signals = discoverySignalBadges(offer);
  return `
    <div class="offer-row tracked-pending-offer">
      <div>
        <strong>${escapeHtml(offer.merchant || "eBay seller")}</strong>
        <div class="meta">
          EBAY · ${escapeHtml(offer.condition || "Observed listing")}
        </div>
        <div class="tracked-offer-badges">
          <span class="verification-badge needs-verification">Needs verification</span>
          ${signals}
        </div>
        <div class="offer-accuracy-line">${escapeHtml(discoveryAccuracyText(offer))} · Same-product identity is not yet exact-verified.</div>
      </div>

      <div>
        <strong>${money(Number(offer.observedPrice), offer.currency || "USD")}</strong>
        <div class="meta">Observed price · excluded from verified price intelligence</div>
      </div>

      <div class="offer-score offer-score-pending">—</div>

      ${offer.outboundEligible
        ? `<a class="small-button pending-verification-button" target="_blank" rel="sponsored nofollow noopener" href="/go/${offer.offerId}">Check</a>`
        : `<span class="small-button disabled-button" title="OfferGrid has not yet established enough local identity confidence to enable this listing.">Pending</span>`}
    </div>
  `;
}


function ebayCompetitionSection(product) {
  const competition = product.ebayCompetition;
  if (!competition) return "";

  const scanAge = competition.lastScanAt
    ? `Last dedicated scan ${formatDateTime(competition.lastScanAt)}`
    : "Dedicated competitor scan is queued";

  const method = competition.scanMethod
    ? `${competition.scanMethod}${competition.scanConfidence ? ` · ${competition.scanConfidence}% confidence` : ""}`
    : "Identity method pending";

  const rows = (competition.offers || []).map(offer => `
    <div class="market-row ${offer.rankByPrice === 1 ? "market-low" : ""}">
      <div class="market-rank">#${offer.rankByPrice}</div>
      <div class="market-merchant">
        <strong>${escapeHtml(offer.merchant)}</strong>
        <span>Verified eBay seller${offer.condition ? ` · ${escapeHtml(offer.condition)}` : ""}</span>
        <div class="tracked-offer-badges">
          <span class="verification-badge exact-verified">Exact verified</span>
          ${discoverySignalBadges(offer)}
        </div>
      </div>
      <div class="market-observed">
        <span>Verified</span>
        <strong>${escapeHtml(formatDateTime(offer.priceVerifiedAt || offer.lastSeen))}</strong>
      </div>
      <div class="market-price">
        <strong>${money(offer.price, offer.currency)}</strong>
        ${offer.shippingPrice != null
          ? `<span>+ ${money(offer.shippingPrice, offer.currency)} shipping</span>`
          : offer.rankByPrice === 1
            ? `<span>Lowest verified tracked item price</span>`
            : ""}
      </div>
      <a class="market-action" href="/go/${offer.offerId}" target="_blank" rel="sponsored nofollow noopener">View</a>
    </div>
  `).join("");

  const pendingRows = (competition.pendingOffers || []).map(offer => `
    <div class="market-row market-pending">
      <div class="market-rank">◷</div>
      <div class="market-merchant">
        <strong>${escapeHtml(offer.merchant)}</strong>
        <span>eBay seller candidate${offer.condition ? ` · ${escapeHtml(offer.condition)}` : ""}</span>
        <div class="tracked-offer-badges">
          <span class="verification-badge needs-verification">Needs verification</span>
          ${discoverySignalBadges(offer)}
        </div>
        <span class="discovery-accuracy-note">${escapeHtml(discoveryAccuracyText(offer))}</span>
      </div>
      <div class="market-observed">
        <span>Observed</span>
        <strong>${escapeHtml(formatDateTime(offer.observedAt || offer.queuedAt))}</strong>
      </div>
      <div class="market-price">
        <strong>${money(offer.observedPrice, offer.currency)}</strong>
        <span>Observed price · not yet exact-verified</span>
      </div>
      ${offer.outboundEligible
        ? `<a class="market-action" href="/go/${offer.offerId}" target="_blank" rel="sponsored nofollow noopener">Check</a>`
        : `<span class="market-action market-action-disabled" title="OfferGrid is waiting for enough local identity evidence or exact eBay verification before enabling this seller link.">Pending</span>`}
    </div>
  `).join("");

  const verifiedCount = Number(competition.listingCount || 0);
  const pendingCount = Number(competition.pendingListingCount || 0);
  const heading = verifiedCount >= 2
    ? `${verifiedCount} verified eBay listings compared`
    : pendingCount > 0
      ? `${verifiedCount} verified · ${pendingCount} awaiting verification`
      : verifiedCount === 1
        ? "1 verified eBay listing tracked"
        : "eBay seller candidates found";

  return `
    <section class="market-check-section ebay-competition-section">
      <div class="section-head market-check-head">
        <div>
          <div class="eyebrow">EBAY SELLER COMPETITION</div>
          <h2>${heading}</h2>
          <p class="muted">Browse discovery can show additional seller candidates immediately. Rows marked “Needs verification” are observed marketplace listings, not verified same-product price claims, and do not affect Deal Heat or verified price comparisons.</p>
        </div>
        <div class="scan-status">
          <strong>${escapeHtml(scanAge)}</strong>
          <span>${escapeHtml(method)}</span>
        </div>
      </div>

      <div class="discovery-signal-legend" aria-label="Competitor discovery signal legend">
        <span><i class="legend-dot signal-high"></i>High signal: GTIN, eBay product ID, or Brand + MPN</span>
        <span><i class="legend-dot signal-medium"></i>Moderate signal: MPN search</span>
        <span><i class="legend-dot signal-exploratory"></i>Exploratory: title match</span>
        <small>Discovery strength describes how OfferGrid found the listing; only “Exact verified” certifies same-product identity.</small>
      </div>

      <div class="market-summary-grid">
        <div><span>Lowest verified tracked eBay price</span><strong>${competition.lowPrice == null ? "—" : money(competition.lowPrice, competition.currency)}</strong></div>
        <div><span>Median verified eBay price</span><strong>${competition.medianPrice == null ? "—" : money(competition.medianPrice, competition.currency)}</strong></div>
        <div><span>Verified sellers</span><strong>${competition.sellerCount || 0}</strong></div>
        <div><span>Verification queue</span><strong>${pendingCount}</strong></div>
      </div>

      ${!competition.identityProofAvailable ? `
        <div class="market-verdict neutral">
          <div class="market-verdict-icon">✓</div>
          <div>
            <strong>Exact verification is still building</strong>
            <p>${escapeHtml(competition.identityMessage || "OfferGrid can still show observed seller candidates, but exact same-product certification requires stronger identity evidence.")}</p>
          </div>
        </div>
      ` : verifiedCount <= 1 ? `
        <div class="market-verdict neutral">
          <div class="market-verdict-icon">↻</div>
          <div>
            <strong>${pendingCount ? "More seller candidates are already queued" : "No second exact competitor is verified yet"}</strong>
            <p>${escapeHtml(competition.identityMessage || "The dedicated scanner has not yet verified another exact same-product eBay seller.")}</p>
          </div>
        </div>
      ` : `
        <div class="ebay-spread-line">
          <span>Verified eBay price spread</span>
          <strong>${money(competition.spread, competition.currency)}</strong>
        </div>
      `}

      ${competition.scanError ? `<div class="market-scan-warning">Last scan note: ${escapeHtml(competition.scanError)}</div>` : ""}

      ${pendingCount > 0 ? `
        <div class="market-pending-note">◷ ${pendingCount} additional eBay seller candidate${pendingCount === 1 ? "" : "s"} ${pendingCount === 1 ? "is" : "are"} waiting for exact item verification. These observed prices are visible for seller context but are excluded from Deal Heat, history, and verified market statistics.</div>
      ` : ""}

      ${competition.withheldListingCount > 0 ? `
        <div class="market-scan-warning">${competition.withheldListingCount} eBay listing${competition.withheldListingCount === 1 ? " was" : "s were"} withheld because same-product identity was not safe enough even for the pending queue.</div>
      ` : ""}

      <div class="market-table">${rows}${pendingRows}</div>

      <div class="market-caveat">
        <strong>Comparison basis: ${escapeHtml(competition.priceBasis || "Verified item price only")}</strong>
        <span>${escapeHtml(competition.caveat || "")}</span>
        <a href="/methodology.html#ebay-competition">How eBay competitor matching works →</a>
      </div>
    </section>
  `;
}

function marketVerdict(comparison) {
  const amount = comparison.differenceVsCompetitor;
  const currency = comparison.currency || "USD";

  if (comparison.identityProofAvailable === false) {
    return {
      cls: "neutral",
      icon: "✓",
      title: "Cross-store comparison withheld",
      text:
        comparison.identityMessage ||
        "OfferGrid does not have enough product identity data to safely claim that other merchant listings are the same SKU.",
    };
  }

  if (!comparison.available) {
    return {
      cls: "neutral",
      icon: "↻",
      title: "Cross-store comparison is still building",
      text:
        "OfferGrid has an eBay listing for this product, but no matched non-eBay offer is currently tracked.",
    };
  }

  if (comparison.verdict === "ebay-lower") {
    return {
      cls: "good",
      icon: "✓",
      title: "eBay is the lowest tracked cross-store price",
      text: `The lowest tracked eBay listing is ${money(Math.abs(amount), currency)} lower than the next-lowest tracked non-eBay offer.`,
    };
  }

  if (comparison.verdict === "tied") {
    return {
      cls: "good",
      icon: "✓",
      title: "eBay is tied for the lowest tracked price",
      text: "The lowest tracked eBay listing matches the lowest tracked competing price currently available to OfferGrid.",
    };
  }

  if (comparison.verdict === "competitive") {
    return {
      cls: "neutral",
      icon: "≈",
      title: "eBay is competitively priced",
      text: `The lowest tracked eBay listing is within ${Math.abs(comparison.differencePct || 0).toFixed(1)}% of the lowest tracked competing offer.`,
    };
  }

  return {
    cls: "warn",
    icon: "↓",
    title: "OfferGrid found a lower tracked price elsewhere",
    text: `The lowest tracked matched non-eBay offer is ${money(Math.abs(amount), currency)} cheaper than the lowest tracked eBay listing.`,
  };
}

function marketComparisonSection(product) {
  const comparison = product.marketComparison;
  if (!comparison) return "";

  const verdict = marketVerdict(comparison);
  const match = comparison.match || {};
  const confidenceClass = Number(match.score || 0) >= 95 ? "high" : "review";

  const crossStoreOffers = (comparison.offers || []).filter(
    offer => !offer.isEbay || offer.offerId === comparison.ebayOfferId
  );

  const rows = crossStoreOffers.map(offer => `
    <div class="market-row ${offer.offerId === comparison.marketLowOfferId ? "market-low" : ""}">
      <div class="market-rank">#${offer.rankByPrice}</div>
      <div class="market-merchant">
        <strong>${escapeHtml(offer.merchant)}</strong>
        <span>${escapeHtml(providerName(offer.provider))}${offer.isEbay ? " · eBay listing" : ""}</span>
      </div>
      <div class="market-observed">
        <span>Observed</span>
        <strong>${escapeHtml(formatDateTime(offer.priceVerifiedAt || offer.lastSeen))}</strong>
      </div>
      <div class="market-price">
        <strong>${money(offer.price, offer.currency)}</strong>
        ${offer.offerId === comparison.marketLowOfferId ? `<span title="Lowest among offers currently tracked by OfferGrid; a lower price may exist elsewhere.">Lowest tracked</span>` : ""}
      </div>
      <a
        class="market-action"
        href="/go/${offer.offerId}"
        target="_blank"
        rel="sponsored nofollow noopener"
      >View</a>
    </div>
  `).join("");

  return `
    <section class="market-check-section">
      <div class="section-head market-check-head">
        <div>
          <div class="eyebrow">EBAY MARKET CHECK</div>
          <h2>How this eBay listing compares</h2>
          <p class="muted">
            OfferGrid compares the lowest tracked eBay listing with other current tracked offers
            grouped as the same product.
          </p>
        </div>
        ${comparison.marketValueScore != null ? `
          <div class="market-score">
            ${comparison.marketValueScore}
            <small>/100 Market Value</small>
          </div>
        ` : ""}
      </div>

      <div class="market-verdict ${verdict.cls}">
        <div class="market-verdict-icon">${verdict.icon}</div>
        <div>
          <strong>${escapeHtml(verdict.title)}</strong>
          <p>${escapeHtml(verdict.text)}</p>
        </div>
      </div>

      <div class="market-summary-grid">
        <div>
          <span title="Based on offers currently tracked by OfferGrid. A lower price may exist elsewhere.">Lowest tracked eBay price ⓘ</span>
          <strong>${money(comparison.ebayPrice, comparison.currency)}</strong>
        </div>
        <div>
          <span title="Based on offers currently tracked by OfferGrid. A lower price may exist elsewhere.">Lowest tracked competing price ⓘ</span>
          <strong>${comparison.competitorPrice == null ? "Not tracked yet" : money(comparison.competitorPrice, comparison.currency)}</strong>
        </div>
        <div>
          <span>Market position</span>
          <strong>#${comparison.ebayRank} of ${comparison.activeOfferCount}</strong>
        </div>
        <div>
          <span>Tracked merchants</span>
          <strong>${comparison.merchantCount}</strong>
        </div>
      </div>

      <div class="match-confidence">
        <div class="match-confidence-top">
          <strong>Product match confidence</strong>
          <span class="${confidenceClass}">${Number(match.score || 0)}% · ${escapeHtml(match.method || "Match")}</span>
        </div>
        <p>${escapeHtml(match.explanation || "")}</p>
      </div>

      ${rows ? `<div class="market-table">${rows}</div>` : ""}

      <div class="market-caveat">
        <strong>Comparison basis: ${escapeHtml(comparison.priceBasis || "Item price")}</strong>
        <span>${escapeHtml(comparison.caveat || "")}</span>
        <a href="/methodology.html#market-comparison">See comparison methodology →</a>
      </div>
    </section>
  `;
}

function metric(label, value, extraClass = "") {
  return `
    <div class="intel-card">
      <span>${escapeHtml(label)}</span>
      <strong class="${extraClass}">${value}</strong>
    </div>
  `;
}

function purchaseTimingSignal(stats = {}) {
  const count = Number(stats.historyCount || 0);
  const heat = Number(stats.dealHeat || 0);
  const belowAverage = Number(stats.savingsVsAveragePct || 0);

  if (count < 2) {
    return {
      label: "History building",
      detail: "OfferGrid needs more verified observations before making a strong timing call.",
      cls: "neutral",
    };
  }

  if (stats.newLow && heat >= 70) {
    return {
      label: "Strong price",
      detail: "The current verified price is a new recorded low with a strong Deal Heat signal.",
      cls: "good",
    };
  }

  if (heat >= 75 || belowAverage >= 10) {
    return {
      label: "Buy window",
      detail: "The current price is materially stronger than OfferGrid’s recent tracked baseline.",
      cls: "good",
    };
  }

  if (heat >= 60 || belowAverage >= 5) {
    return {
      label: "Worth considering",
      detail: "The price is better than recent context, but not at OfferGrid’s strongest signal level.",
      cls: "neutral",
    };
  }

  if (belowAverage <= -3) {
    return {
      label: "Wait / compare",
      detail: "The current price is above OfferGrid’s recent tracked average.",
      cls: "warn",
    };
  }

  return {
    label: "Typical price",
    detail: "The current price is close to OfferGrid’s recent tracked range.",
    cls: "neutral",
  };
}

function priceMomentum(stats = {}) {
  if (Number(stats.historyCount || 0) < 2) {
    return {
      label: "Building",
      detail: "More verified samples needed",
      cls: "neutral",
    };
  }

  const previous = Number(stats.changeVsPreviousPct || 0);
  const tracking = Number(stats.changeSinceTrackingPct || 0);

  if (previous <= -1 || tracking <= -5) {
    return {
      label: "Falling",
      detail: `${Math.abs(previous).toFixed(1)}% lower than the previous sample`,
      cls: "good",
    };
  }

  if (previous >= 1 || tracking >= 5) {
    return {
      label: "Rising",
      detail: `${Math.abs(previous).toFixed(1)}% higher than the previous sample`,
      cls: "warn",
    };
  }

  return {
    label: "Stable",
    detail: "Little movement versus the previous sample",
    cls: "neutral",
  };
}

function pricePosition(stats = {}) {
  const current = Number(stats.currentPrice);
  const low = Number(stats.low30d);
  const high = Number(stats.high30d);

  if (
    Number(stats.historyCount || 0) < 2 ||
    !Number.isFinite(current) ||
    !Number.isFinite(low) ||
    !Number.isFinite(high)
  ) {
    return {
      label: "Building",
      detail: "30-day range still developing",
      pct: null,
      cls: "neutral",
    };
  }

  if (high <= low) {
    return {
      label: "At tracked level",
      detail: "Recorded 30-day prices are effectively flat",
      pct: 0,
      cls: "neutral",
    };
  }

  const pct = Math.max(0, Math.min(100, ((current - low) / (high - low)) * 100));

  if (pct <= 20) {
    return {
      label: "Near 30-day low",
      detail: `${pct.toFixed(0)}% up from the bottom of the tracked range`,
      pct,
      cls: "good",
    };
  }

  if (pct <= 45) {
    return {
      label: "Lower half of range",
      detail: `${pct.toFixed(0)}% through the tracked 30-day range`,
      pct,
      cls: "good",
    };
  }

  if (pct <= 65) {
    return {
      label: "Middle of range",
      detail: `${pct.toFixed(0)}% through the tracked 30-day range`,
      pct,
      cls: "neutral",
    };
  }

  if (pct <= 85) {
    return {
      label: "Upper half of range",
      detail: `${pct.toFixed(0)}% through the tracked 30-day range`,
      pct,
      cls: "warn",
    };
  }

  return {
    label: "Near 30-day high",
    detail: `${pct.toFixed(0)}% through the tracked 30-day range`,
    pct,
    cls: "warn",
  };
}

function decisionConfidence(product = {}) {
  const stats = product.priceStats || {};
  const history = Number(stats.historyCount || 0);
  const match = Number(product.marketComparison?.match?.score || 0);
  const exact = product.priceAccuracy?.status === "verified";
  const sellers = Number(product.ebayCompetition?.listingCount || product.marketComparison?.activeOfferCount || 0);

  let score = 0;
  if (exact) score += 35;
  if (history >= 2) score += 20;
  if (history >= 5) score += 10;
  if (match >= 95) score += 20;
  else if (match >= 80) score += 10;
  if (sellers >= 2) score += 10;
  if (sellers >= 5) score += 5;

  if (score >= 80) return { label: "High", detail: "Strong verification and comparison context", cls: "good" };
  if (score >= 55) return { label: "Moderate", detail: "Useful context with some data still building", cls: "neutral" };
  return { label: "Developing", detail: "More verified history or market matches are needed", cls: "neutral" };
}

function purchasingIntelligencePanel(product) {
  if (product.verificationPending) {
    return `
      <section class="purchase-intelligence-panel pending-verification-panel">
        <div class="purchase-intelligence-head">
          <div>
            <div class="eyebrow">VERIFICATION PENDING</div>
            <h2>OfferGrid found this listing, but is withholding the deal verdict.</h2>
            <p>
              The listing passed local relevance and identity safety checks. eBay exact-item
              verification is temporarily unavailable, so this observed price is excluded from
              Deal Heat, price history, and cross-store same-product claims until verification succeeds.
            </p>
          </div>
          <div class="purchase-signal warn">
            <span>Current state</span>
            <strong>VERIFYING</strong>
            <small>No Buy / Wait signal is being claimed yet.</small>
          </div>
        </div>
      </section>
    `;
  }

  const stats = product.priceStats || {};
  const timing = purchaseTimingSignal(stats);
  const momentum = priceMomentum(stats);
  const position = pricePosition(stats);
  const confidence = decisionConfidence(product);
  const sellers = Number(
    product.ebayCompetition?.listingCount ||
    product.marketComparison?.activeOfferCount ||
    product.offers?.length ||
    0
  );

  const versusAverage =
    Number(stats.historyCount || 0) >= 2 && Number.isFinite(Number(stats.savingsVsAveragePct))
      ? Number(stats.savingsVsAveragePct) >= 0
        ? `${Number(stats.savingsVsAveragePct).toFixed(1)}% below 30d avg`
        : `${Math.abs(Number(stats.savingsVsAveragePct)).toFixed(1)}% above 30d avg`
      : "History building";

  return `
    <section class="purchase-intelligence-panel">
      <div class="purchase-intelligence-head">
        <div>
          <div class="eyebrow">PURCHASING INTELLIGENCE</div>
          <h2>What today’s price means</h2>
          <p>
            OfferGrid combines verified price history and current market context.
            This is a price signal, not a guarantee that a product is right for you.
          </p>
        </div>
        <div class="purchase-signal ${timing.cls}">
          <span>Current signal</span>
          <strong>${escapeHtml(timing.label)}</strong>
          <small>${escapeHtml(timing.detail)}</small>
        </div>
      </div>

      <div class="purchase-intelligence-grid">
        <div class="decision-card ${position.cls}">
          <span>30-day price position</span>
          <strong>${escapeHtml(position.label)}</strong>
          <small>${escapeHtml(position.detail)}</small>
        </div>
        <div class="decision-card ${momentum.cls}">
          <span>Price momentum</span>
          <strong>${escapeHtml(momentum.label)}</strong>
          <small>${escapeHtml(momentum.detail)}</small>
        </div>
        <div class="decision-card">
          <span>Versus recent average</span>
          <strong>${escapeHtml(versusAverage)}</strong>
          <small>${Number(stats.historyCount || 0)} verified tracked sample${Number(stats.historyCount || 0) === 1 ? "" : "s"}</small>
        </div>
        <div class="decision-card ${confidence.cls}">
          <span>Decision confidence</span>
          <strong>${escapeHtml(confidence.label)}</strong>
          <small>${escapeHtml(confidence.detail)}</small>
        </div>
        <div class="decision-card">
          <span>Seller context</span>
          <strong>${sellers || "Building"}</strong>
          <small>${sellers ? `tracked offer${sellers === 1 ? "" : "s"} in current comparison context` : "Seller comparison is still building"}</small>
        </div>
        <div class="decision-card">
          <span>Deal Heat</span>
          <strong>${Number(stats.dealHeat || 0)}/100</strong>
          <small>${escapeHtml(stats.heatLabel || "Watch")} · price-history signal</small>
        </div>
      </div>
    </section>
  `;
}

function renderConditionException(product, { displayTitle, displayImageUrl } = {}) {
  const best = product.bestOffer;
  const pendingVerification = Boolean(product.verificationPending);
  const title = displayTitle || product.displayTitle || product.title;
  const imageUrl = displayImageUrl || product.displayImageUrl || product.imageUrl;
  const image = imageUrl
    ? `<img class="detail-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}">`
    : `<div class="placeholder-art detail-placeholder"><span>${escapeHtml(product.category || "Listing")}</span></div>`;
  const backParams = new URLSearchParams();
  if (product.category) backParams.set("category", product.category);
  backParams.set("includeParts", "true");
  const backHref = `/?${backParams.toString()}`;

  view.innerHTML = `
    <section class="product-breadcrumbs">
      <a href="${backHref}">Price Intelligence</a><span>›</span>
      <span>Condition-specific inventory</span><span>›</span><span>${escapeHtml(title)}</span>
    </section>

    <section class="detail">
      <div>${image}</div>
      <div>
        <div class="card-badges">
          <span class="condition-exception-badge">FOR PARTS / BROKEN / NOT WORKING</span>
          ${pendingVerification ? `<span class="heat-badge">◷ eBay verification pending</span>` : ""}
        </div>
        <div class="meta">${escapeHtml(product.category || "Other")}${product.brand ? ` · ${escapeHtml(product.brand)}` : ""}</div>
        <h1>${escapeHtml(title)}</h1>
        <p class="lede">
          This listing is shown only because the excluded-condition filter was enabled.
          OfferGrid keeps condition-specific inventory outside normal-product Deal Heat,
          price history, market ranges, verified seller coverage, and competitor ranking.
        </p>

        <div class="product-trust-line pending">
          <span>✓ Condition exception identified</span>
          <span>✓ Excluded from normal price intelligence</span>
          <span>${pendingVerification ? "◷ Exact eBay item verification pending" : "✓ Source listing available"}</span>
        </div>

        ${best ? `
          <div class="accuracy-panel ${product.priceAccuracy?.status || "search"}">
            <div>
              <div class="eyebrow">CONDITION-SPECIFIC PRICE</div>
              <strong>${escapeHtml(product.priceAccuracy?.label || "Listing observed")}</strong>
              <span>${product.priceAccuracy?.verifiedAt
                ? escapeHtml(`Last checked ${formatDateTime(product.priceAccuracy.verifiedAt)}`)
                : "Verify the live listing details with the merchant."}</span>
            </div>
          </div>

          <div class="best-offer">
            <div>
              <div class="meta">CURRENT CONDITION-SPECIFIC LISTING</div>
              <div class="big-price">${displayOfferPrice(best)}</div>
              <div>${escapeHtml(best.merchant || "Merchant")}</div>
              ${priceBasisText(best) ? `<div class="best-price-basis">${escapeHtml(priceBasisText(best))}</div>` : ""}
              <div class="best-price-note">
                This price is intentionally not compared with working-condition inventory and does not influence Deal Heat or normal competitor rankings.
              </div>
            </div>
            <a class="primary-button inline" target="_blank" rel="sponsored nofollow noopener" href="/go/${best.id}">Check merchant listing</a>
          </div>
        ` : ""}
      </div>
    </section>

    <section class="price-history-panel condition-exception-panel">
      <div class="section-head">
        <div>
          <div class="eyebrow">INTELLIGENCE EXCLUDED</div>
          <h2>Condition-specific inventory is kept separate</h2>
          <p class="muted">
            No Deal Heat, 30-day market range, normal price history, verified seller count, or competitor ranking is calculated from these listings.
          </p>
        </div>
        <div class="heat-big">—<small>Deal Heat withheld</small></div>
      </div>
    </section>

    <section class="offers-section">
      <div class="section-head">
        <div>
          <div class="eyebrow">CONDITION-SPECIFIC OFFERS</div>
          <h2>Available excluded-condition listings</h2>
          <p class="muted">These offers are visible only in the explicit condition-exception mode and remain outside normal OfferGrid price intelligence.</p>
        </div>
      </div>
      <div class="offer-list">
        ${(Array.isArray(product.offers) ? product.offers : []).map(offer => conditionOfferRow(offer, best?.id)).join("")}
      </div>
    </section>
  `;
}

function render(product) {
  chartController?.destroy?.();
  chartController = null;

  const best = product.bestOffer;
  const stats = product.priceStats || {};
  const pendingVerification = Boolean(product.verificationPending);
  const conditionException = Boolean(product.conditionException || product.conditionExcludedFromIntelligence);
  const history = Array.isArray(product.priceHistory) ? product.priceHistory : [];
  const trackedPendingOffers = Array.isArray(product.ebayCompetition?.pendingOffers)
    ? product.ebayCompetition.pendingOffers
    : [];

  const displayTitle = product.displayTitle || product.title;
  const displayImageUrl = product.displayImageUrl || product.imageUrl;

  document.title = `${displayTitle} | OfferGrid`;
  const description =
    (product.editorNote || product.aiSummary || displayTitle).slice(0, 155);
  document.querySelector("#meta-description").content = description;

  let ogTitle = document.head.querySelector('meta[property="og:title"]');
  if (!ogTitle) {
    ogTitle = document.createElement("meta");
    ogTitle.setAttribute("property", "og:title");
    document.head.appendChild(ogTitle);
  }
  ogTitle.content = document.title;

  let ogDescription = document.head.querySelector('meta[property="og:description"]');
  if (!ogDescription) {
    ogDescription = document.createElement("meta");
    ogDescription.setAttribute("property", "og:description");
    document.head.appendChild(ogDescription);
  }
  ogDescription.content = description;

  if (displayImageUrl) {
    let ogImage = document.head.querySelector('meta[property="og:image"]');
    if (!ogImage) {
      ogImage = document.createElement("meta");
      ogImage.setAttribute("property", "og:image");
      document.head.appendChild(ogImage);
    }
    ogImage.content = displayImageUrl;
  }

  const image = displayImageUrl
    ? `<img class="detail-image" src="${escapeHtml(displayImageUrl)}" alt="${escapeHtml(displayTitle)}">`
    : `<div class="placeholder-art detail-placeholder"><span>${escapeHtml(product.category)}</span></div>`;

  if (conditionException) {
    renderConditionException(product, { displayTitle, displayImageUrl });
    return;
  }

  const explanation = product.editorNote
    ? `<section class="editorial">
         <h2>Product context</h2>
         <p>${escapeHtml(product.editorNote)}</p>
       </section>`
    : product.aiSummary
      ? `<p class="lede">${escapeHtml(product.aiSummary)}</p>`
      : `<p class="lede">
           OfferGrid is tracking this product across connected sources and recording
           verified price observations over time.
         </p>`;

  const heatClass =
    stats.dealHeat >= 75 ? "hot" :
    stats.dealHeat >= 60 ? "warm" :
    "";

  const previousDirection =
    stats.changeVsPreviousPct < -0.05 ? "down" :
    stats.changeVsPreviousPct > 0.05 ? "up" :
    "flat";

  const trackingDirection =
    stats.changeSinceTrackingPct < -0.05 ? "down" :
    stats.changeSinceTrackingPct > 0.05 ? "up" :
    "flat";

  const previousText =
    stats.historyCount >= 2
      ? `${stats.changeVsPreviousPct > 0 ? "+" : ""}${stats.changeVsPreviousPct.toFixed(1)}%`
      : "Building";

  const trackingText =
    stats.historyCount >= 2
      ? `${stats.changeSinceTrackingPct > 0 ? "+" : ""}${stats.changeSinceTrackingPct.toFixed(1)}%`
      : "Building";

  view.innerHTML = `
    <section class="product-breadcrumbs">
      <a href="/">Price Intelligence</a><span>›</span>
      <a href="/?category=${encodeURIComponent(product.category)}">${escapeHtml(product.category)}</a>
      <span>›</span><span>${escapeHtml(displayTitle)}</span>
    </section>

    <section class="detail">
      <div>${image}</div>
      <div>
        <div class="card-badges">
          ${pendingVerification
            ? `<span class="heat-badge">◷ eBay verification pending</span>`
            : `<span class="heat-badge ${heatClass}">🔥 ${stats.dealHeat || 0} · ${escapeHtml(stats.heatLabel || "Watch")}</span>`}
          ${!pendingVerification && stats.newLow ? `<span class="new-low">NEW RECORDED LOW</span>` : ""}
        </div>

        <div class="meta">
          ${escapeHtml(product.category)}
          ${product.brand ? ` · ${escapeHtml(product.brand)}` : ""}
        </div>

        <h1>${escapeHtml(displayTitle)}</h1>
        ${explanation}

        <div class="product-trust-line ${pendingVerification ? "pending" : ""}">
          <span>✓ Exact listing ID tracked</span>
          <span>✓ Variant conflicts blocked</span>
          <span>${pendingVerification ? "◷ Exact eBay item verification pending" : "✓ Verified eBay history only"}</span>
        </div>

        ${best ? `
          <div class="accuracy-panel ${product.priceAccuracy?.status || "search"}">
            <div>
              <div class="eyebrow">PRICE ACCURACY</div>
              <strong>${escapeHtml(product.priceAccuracy?.label || "Verification queued")}</strong>
              <span>
                ${product.priceAccuracy?.verifiedAt
                  ? escapeHtml(`Last checked ${formatDateTime(product.priceAccuracy.verifiedAt)}`)
                  : "Exact item verification is queued."}
              </span>
            </div>

            <div class="accuracy-facts">
              ${best.lotSize && Number(best.lotSize) > 1
                ? `<span><b>Lot size</b> ${Number(best.lotSize)}</span>`
                : ""}
              ${best.estimatedAvailableQuantity != null
                ? `<span><b>Stock estimate</b> ${Number(best.estimatedAvailableQuantity)}</span>`
                : ""}
              ${best.quantityLimitPerBuyer != null
                ? `<span><b>Buyer limit</b> ${Number(best.quantityLimitPerBuyer)}</span>`
                : ""}
              ${best.primaryItemGroupId
                ? `<span><b>Variation listing</b> exact variation tracked</span>`
                : ""}
            </div>
          </div>

          <div class="best-offer">
            <div>
              <div class="meta">${pendingVerification ? "CURRENT EBAY SEARCH OBSERVATION" : "TOP-RANKED TRACKED VERIFIED OFFER"}</div>
              <div class="big-price">${pendingVerification && Number.isFinite(Number(best.price)) ? `${money(Number(best.price), best.currency)} observed` : displayOfferPrice(best)}</div>
              <div>${escapeHtml(best.merchant)}</div>
              ${priceBasisText(best)
                ? `<div class="best-price-basis">${escapeHtml(priceBasisText(best))}</div>`
                : ""}
              <div class="best-price-note">
                ${pendingVerification
                  ? "This amount was observed in eBay search results and has not yet passed OfferGrid exact-item verification. Open the listing to confirm the live price and variant. It is not counted in Deal Heat or verified price history yet."
                  : "Base item price from the exact eBay item when verified. Stock quantity, lot size, per-buyer limits, shipping and unit price are tracked separately. Coupons, quantity discounts and tax can change the final checkout total."}
              </div>
            </div>
            <a
              class="primary-button inline"
              target="_blank"
              rel="sponsored nofollow noopener"
              href="/go/${best.id}"
            >${pendingVerification ? "Check listing on eBay" : "View merchant offer"}</a>
          </div>
        ` : ""}
      </div>
    </section>

    ${purchasingIntelligencePanel(product)}
    ${ebayCompetitionSection(product)}
    ${marketComparisonSection(product)}

    <section class="price-history-panel">
      <div class="section-head chart-heading">
        <div>
          <div class="eyebrow">${pendingVerification ? "PRICE HISTORY ON HOLD" : "RECORDED PRICE HISTORY"}</div>
          <h2>${pendingVerification ? "Waiting for exact eBay verification" : "How this price has moved"}</h2>
          <p class="muted">
            ${pendingVerification
              ? "This search observation is intentionally excluded from price history until OfferGrid verifies the exact eBay item."
              : "eBay history points are recorded only after OfferGrid verifies the exact listing through eBay item-detail data. We do not invent historical prices."}
          </p>
        </div>
        <div class="heat-big">
          ${pendingVerification ? "—" : (stats.dealHeat || 0)}
          <small>${pendingVerification ? "Deal Heat withheld" : "/100 Deal Heat"}</small>
        </div>
      </div>

      <div class="intel-grid product-intel-grid">
        ${metric("Current", money(stats.currentPrice, best?.currency || "USD"))}
        ${metric("30-day average", money(stats.average30d, best?.currency || "USD"))}
        ${metric("30-day low", money(stats.low30d, best?.currency || "USD"))}
        ${metric("30-day high", money(stats.high30d, best?.currency || "USD"))}
        ${metric("Vs previous sample", previousText, previousDirection)}
        ${metric("Since tracking began", trackingText, trackingDirection)}
      </div>

      <div class="chart-toolbar">
        <div class="chart-range-buttons" role="group" aria-label="Price history range">
          <button type="button" data-range="7">7D</button>
          <button type="button" data-range="30" class="active">30D</button>
          <button type="button" data-range="90">90D</button>
          <button type="button" data-range="all">ALL</button>
        </div>

        <div class="chart-context">
          <span>${stats.historyCount || 0} recorded sample${stats.historyCount === 1 ? "" : "s"}</span>
          ${stats.trackingStartedAt
            ? `<span>Tracking since ${escapeHtml(formatDate(stats.trackingStartedAt, true))}</span>`
            : ""}
        </div>
      </div>

      <div class="chart-shell">
        <canvas id="price-chart" aria-label="Recorded product price history chart"></canvas>
        <div id="price-chart-tooltip" class="chart-tooltip hidden"></div>
      </div>

      <div id="range-summary" class="range-summary"></div>

      ${history.length < 2 ? `
        <div class="history-building">
          <strong>History tracking has started.</strong>
          <span>
            This product currently has ${history.length} recorded price sample${history.length === 1 ? "" : "s"}.
            The graph will become more useful as automatic API refreshes collect additional observations.
          </span>
        </div>
      ` : ""}
    </section>

    <section class="offers-section">
      <div class="section-head">
        <div>
          <div class="eyebrow">CURRENT MARKET</div>
          <h2>Compare tracked offers</h2>
          <p class="muted">Verified offers and additional observed eBay seller candidates are shown together with their verification state. Only verified offers affect Deal Heat, price history, or verified price rankings.</p>
        </div>
      </div>
      <div class="offer-list">
        ${product.offers.map(offer => offerRow(offer, best?.id)).join("")}
        ${trackedPendingOffers.length ? `
          <div class="tracked-pending-divider">
            <strong>Additional observed eBay candidates</strong>
            <span>Not yet certified as the exact same product</span>
          </div>
          ${trackedPendingOffers.map(offer => pendingTrackedOfferRow(offer)).join("")}
        ` : ""}
      </div>
      <p class="meta">
        *Estimated commission values are internal planning estimates unless a network
        supplies an authoritative rate. Offer ranking also considers price competitiveness,
        discount depth, merchant quality, availability, and freshness.
        <a href="/methodology.html">Read the methodology.</a>
      </p>
    </section>
  `;

  const canvas = document.querySelector("#price-chart");
  const tooltip = document.querySelector("#price-chart-tooltip");
  const summary = document.querySelector("#range-summary");

  if (canvas && history.length) {
    chartController = new PriceHistoryChart(
      canvas,
      history,
      best?.currency || history[0]?.currency || "USD",
      tooltip,
      summary
    );

    document.querySelectorAll("[data-range]").forEach(button => {
      button.addEventListener("click", () => {
        document.querySelectorAll("[data-range]").forEach(b => b.classList.remove("active"));
        button.classList.add("active");
        chartController.setRange(button.dataset.range);
      });
    });
  }
}

let productLiveTimer = null;
let productLiveRefreshing = false;
let productLivePending = false;

function productEventTouchesCurrent(event) {
  if (!event || !["catalog", "price"].includes(event.type)) return false;
  const currentId = Number(id);
  return (event.productIds || []).map(Number).includes(currentId) || (event.deletedProductIds || []).map(Number).includes(currentId);
}

async function refreshCurrentProductFromLive() {
  if (productLiveRefreshing) {
    productLivePending = true;
    return;
  }
  productLiveRefreshing = true;
  productLivePending = false;
  try {
    const response = await fetch(`/api/products/${id}${productApiSuffix}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.product) {
      view.innerHTML = `<section class="empty"><h1>Product unavailable</h1><p>This product changed while you were viewing it.</p><a href="/">Back to price intelligence</a></section>`;
      return;
    }
    const viewport = captureScrollAnchor(".detail");
    render(data.product);
    restoreScrollAnchor(viewport, { retries: 1 });
    const detail = document.querySelector(".detail");
    detail?.classList.remove("live-updated");
    requestAnimationFrame(() => {
      detail?.classList.add("live-updated");
      setTimeout(() => detail?.classList.remove("live-updated"), 1800);
    });
  } finally {
    productLiveRefreshing = false;

    if (productLivePending) {
      productLivePending = false;
      if (productLiveTimer) clearTimeout(productLiveTimer);
      productLiveTimer = setTimeout(() => {
        productLiveTimer = null;
        refreshCurrentProductFromLive().catch(() => {});
      }, 120);
    }
  }
}

function handleProductLiveEvent(event) {
  if (!productEventTouchesCurrent(event)) return;
  if (productLiveTimer) clearTimeout(productLiveTimer);
  productLiveTimer = setTimeout(() => {
    productLiveTimer = null;
    refreshCurrentProductFromLive().catch(() => {});
  }, 250);
}

(async () => {
  try {
    const config = await getConfig();
    renderAd(document.querySelector("#ad-slot"), config);

    if (!id) throw new Error("No product ID was supplied.");

    const response = await fetch(`/api/products/${id}/live${productApiSuffix}`, { cache: "no-store" });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Product not found.");
    }

    render(data.product);
    if (restoredViewState?.viewport) {
      restoreScrollAnchor(restoredViewState.viewport, { retries: 6 });
    }

    connectOfferGridLive({
      onEvent: handleProductLiveEvent,
    });
  } catch (error) {
    view.innerHTML = `
      <section class="empty">
        <h1>Product unavailable</h1>
        <p>${escapeHtml(error.message)}</p>
        <a href="/">Back to store</a>
      </section>
    `;
  }
})();
