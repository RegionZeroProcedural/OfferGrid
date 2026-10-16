import { parentPort } from "worker_threads";
import { discountPercent } from "../lib/scoring.js";

function median(values) {
  const sorted = (values || [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pruneDealHeatHistoryOutliers(history) {
  const clean = (history || []).filter(point =>
    point &&
    Number.isFinite(Number(point.price)) &&
    Number(point.price) > 0
  );

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
  const deviations = prices.map(price => Math.abs(price - center));
  const mad = median(deviations);

  if (!Number.isFinite(center) || center <= 0) {
    return { kept: clean, pruned: [], medianPrice: center, mad };
  }

  const kept = [];
  const pruned = [];

  for (const point of clean) {
    const price = Number(point.price);
    let isOutlier = false;

    if (Number.isFinite(mad) && mad > Math.max(0.01, center * 0.001)) {
      const modifiedZ = (0.6745 * Math.abs(price - center)) / mad;
      isOutlier = modifiedZ > 4.5;
    } else {
      const relativeDeviation = Math.abs(price - center) / center;
      isOutlier = relativeDeviation > 0.35 && Math.abs(price - center) > 5;
    }

    (isOutlier ? pruned : kept).push(point);
  }

  if (kept.length < 3) {
    return { kept: clean, pruned: [], medianPrice: center, mad };
  }

  return { kept, pruned, medianPrice: center, mad };
}

function currentPriceLooksLikeExtremeOutlier(current, priorHistory) {
  const prior = pruneDealHeatHistoryOutliers(priorHistory);
  const prices = prior.kept
    .map(point => Number(point.price))
    .filter(price => Number.isFinite(price) && price > 0);

  if (prices.length < 5) {
    return { suspicious: false, baseline: median(prices), ratio: null };
  }

  const baseline = median(prices);
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return { suspicious: false, baseline, ratio: null };
  }

  const ratio = Number(current) / baseline;
  return {
    suspicious: Number.isFinite(ratio) && (ratio < 0.20 || ratio > 5.0),
    baseline,
    ratio,
  };
}

function emptyStats() {
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

export function calculatePriceStatsFromPayload(best, rawHistory = []) {
  if (!best || !Number.isFinite(Number(best.price)) || Number(best.price) <= 0) {
    return emptyStats();
  }

  const historyInput = (rawHistory || [])
    .filter(point => point && Number.isFinite(Number(point.price)) && Number(point.price) > 0)
    .sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));

  const pruned = pruneDealHeatHistoryOutliers(historyInput);
  const history = pruned.kept;
  const prices = history.map(point => Number(point.price)).filter(Number.isFinite);
  const current = Number(best.price);
  const average = prices.length
    ? prices.reduce((a, b) => a + b, 0) / prices.length
    : current;
  const low = prices.length ? Math.min(...prices) : current;
  const high = prices.length ? Math.max(...prices) : current;
  const previousSample = history.length >= 2 ? history.at(-2) : null;
  const firstSample = history.length ? history[0] : null;

  const priorRawHistory =
    historyInput.length &&
    Math.abs(Number(historyInput.at(-1)?.price) - current) <= Math.max(0.01, Math.abs(current) * 0.005)
      ? historyInput.slice(0, -1)
      : historyInput;

  const priorPruned = pruneDealHeatHistoryOutliers(priorRawHistory);
  const priorPrices = priorPruned.kept
    .map(point => Number(point.price))
    .filter(Number.isFinite);
  const priorLow = priorPrices.length ? Math.min(...priorPrices) : null;
  const currentAnomaly = currentPriceLooksLikeExtremeOutlier(current, priorRawHistory);
  const newLow =
    !currentAnomaly.suspicious &&
    priorLow != null &&
    current < priorLow - 0.005;

  const savingsVsAveragePct = average > 0
    ? Math.max(0, ((average - current) / average) * 100)
    : 0;
  const changeVsPreviousPct =
    previousSample && Number(previousSample.price) > 0
      ? ((current - Number(previousSample.price)) / Number(previousSample.price)) * 100
      : 0;
  const changeSinceTrackingPct =
    firstSample && Number(firstSample.price) > 0
      ? ((current - Number(firstSample.price)) / Number(firstSample.price)) * 100
      : 0;

  let historyComponent = Math.min(50, (savingsVsAveragePct / 40) * 50);
  const markdownComponent = Math.min(
    20,
    (discountPercent(best.price, best.originalPrice) / 50) * 20
  );
  const qualityComponent = Math.min(20, (Number(best.score || 0) / 100) * 20);
  let newLowBonus = newLow
    ? 10
    : (!currentAnomaly.suspicious && priorLow != null && current <= priorLow + 0.005 ? 6 : 0);

  if (currentAnomaly.suspicious) {
    historyComponent = 0;
    newLowBonus = 0;
  }

  let dealHeat = Math.round(Math.min(
    100,
    historyComponent + markdownComponent + qualityComponent + newLowBonus
  ));

  const confidenceHistoryCount = Math.min(
    history.length,
    priorPruned.kept.length || history.length
  );

  let confidence = confidenceHistoryCount >= 5
    ? "good"
    : confidenceHistoryCount >= 2
      ? "limited"
      : "building";

  if (currentAnomaly.suspicious) {
    confidence = "anomaly";
    dealHeat = Math.min(dealHeat, 45);
  }

  if (confidenceHistoryCount < 2) {
    dealHeat = Math.min(dealHeat, 45);
  }

  let heatLabel = "Watch";
  if (confidence === "anomaly") heatLabel = "Verify anomaly";
  else if (confidence === "building") heatLabel = "Building history";
  else if (dealHeat >= 90) heatLabel = "Scorching";
  else if (dealHeat >= 75) heatLabel = "Hot";
  else if (dealHeat >= 60) heatLabel = "Warm";

  return {
    currentPrice: current,
    historyCount: historyInput.length,
    dealHeatHistoryCount: history.length,
    dealHeatOutliersPruned: Math.max(pruned.pruned.length, priorPruned.pruned.length),
    currentPriceAnomaly: Boolean(currentAnomaly.suspicious),
    average30d: Math.round(average * 100) / 100,
    low30d: Math.round(low * 100) / 100,
    high30d: Math.round(high * 100) / 100,
    priorLow30d: priorLow == null ? null : Math.round(priorLow * 100) / 100,
    previousPrice: previousSample ? Number(previousSample.price) : null,
    trackingStartedAt: firstSample ? firstSample.at : null,
    savingsVsAveragePct: Math.round(savingsVsAveragePct * 10) / 10,
    changeVsPreviousPct: Math.round(changeVsPreviousPct * 10) / 10,
    changeSinceTrackingPct: Math.round(changeSinceTrackingPct * 10) / 10,
    dealHeat,
    heatLabel,
    heatConfidence: confidence,
    newLow,
  };
}

export function compactSparklinePoints(points, maxPoints = 18) {
  const clean = (points || [])
    .filter(point =>
      point &&
      Number.isFinite(Number(point.price)) &&
      Number.isFinite(Date.parse(point.at || ""))
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  if (clean.length <= maxPoints) return clean;

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
    if (point && sampled.at(-1)?.at !== point.at) sampled.push(point);
  }

  const last = clean.at(-1);
  if (sampled.at(-1)?.at !== last.at) sampled.push(last);
  return sampled.slice(-maxPoints);
}

export function computeIntelligenceSnapshot(job = {}) {
  const stats = calculatePriceStatsFromPayload(job.bestOffer || null, job.history30d || []);
  const sparkline = compactSparklinePoints(job.sparklineHistory || [], 18);

  return {
    productId: Number(job.productId),
    generation: Number(job.generation || 0),
    stats,
    sparkline,
    computedAt: new Date().toISOString(),
  };
}

if (parentPort) {
  parentPort.on("message", message => {
    const { requestId, job } = message || {};
    try {
      parentPort.postMessage({
        requestId,
        ok: true,
        result: computeIntelligenceSnapshot(job),
      });
    } catch (error) {
      parentPort.postMessage({
        requestId,
        ok: false,
        error: error?.stack || error?.message || String(error),
        productId: Number(job?.productId),
        generation: Number(job?.generation || 0),
      });
    }
  });
}
