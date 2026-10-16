import {
  getProductsForEbayCompetitorScan,
  getProduct,
  ingestCandidates,
  markEbayCompetitorScan,
  updateProductIdentity,
  markEbayExactSearchRejected,
  clearEbayExactSearchRejected,
  queueEbayCompetitorCandidates,
} from "../lib/db.js";
import {
  getEbayItemIdentity,
  getEbayItemsDetails,
  normalizeEbayEpid,
  normalizeEbayGtin,
  searchEbayAdvanced,
} from "../providers/ebay.js";
import { buildEbayGetItemsBatches } from "../lib/ebayBatching.js";
import {
  getEbayRateGuardStatus,
  isEbayRateGuardError,
} from "../lib/ebayRateGuard.js";
import { opLog, opWarn } from "../lib/opsLog.js";
import { backgroundCheckpoint } from "../lib/requestPriority.js";
import {
  familyCompatibility,
  exactCompetitorProof,
} from "../lib/productMatch.js";
import {
  canonicalStrongBrand,
  canonicalStrongMpn,
} from "../lib/productIdentity.js";
import { isBrokenOrPartsListing } from "../lib/listingCondition.js";


// V3.7.45: when a shopper leaves a result page, unfinished visible-card
// competitor work is demoted into this small in-memory priority queue instead
// of continuing to consume the interactive lane. The normal scheduled
// competitor cycle drains these IDs first, under background quota/priority.
const backgroundPriorityProductIds = [];
const backgroundPriorityProductSet = new Set();

export function enqueueEbayCompetitorBackgroundProducts(productIds = [], { reason = "shopper-page-superseded" } = {}) {
  let queued = 0;
  for (const rawId of Array.isArray(productIds) ? productIds : []) {
    const id = Number(rawId);
    if (!Number.isFinite(id) || backgroundPriorityProductSet.has(id)) continue;
    backgroundPriorityProductSet.add(id);
    backgroundPriorityProductIds.push(id);
    queued++;
  }
  if (queued) {
    opLog("ebay-competitors", "demoted shopper-page competitor work queued for background scheduling", {
      queued,
      pendingPriorityProducts: backgroundPriorityProductIds.length,
      reason,
    });
  }
  return { queued, pending: backgroundPriorityProductIds.length };
}

function backgroundPriorityProducts(limit) {
  const products = [];
  for (const id of [...backgroundPriorityProductIds]) {
    if (products.length >= limit) break;
    const product = getProduct(id, true, { includeHistory: false });
    if (!product || !product.approved) {
      acknowledgeBackgroundPriorityProduct(id);
      continue;
    }
    products.push(product);
  }
  return products;
}

function acknowledgeBackgroundPriorityProduct(productId) {
  const id = Number(productId);
  if (!backgroundPriorityProductSet.delete(id)) return;
  const index = backgroundPriorityProductIds.indexOf(id);
  if (index >= 0) backgroundPriorityProductIds.splice(index, 1);
}

export function getEbayCompetitorBackgroundPriorityStatus() {
  return { pending: backgroundPriorityProductIds.length };
}

function sourceEbayOffer(product, { includeInactive = false } = {}) {
  const all = (product.offers || [])
    .filter(offer =>
      String(offer.provider).toLowerCase() === "ebay"
    );

  const active = all.filter(
    offer => offer.availability !== "out_of_stock"
  );

  // Never let a previously attached competitor become the source of truth
  // when an original broad-discovery listing exists.
  const sourceCandidates = active
    .filter(offer => {
      const source = String(offer.matchSource || "");
      return !source.startsWith("ebay-competitor:") && !source.startsWith("ebay-secondary:");
    })
    .sort((a, b) => Number(a.id) - Number(b.id));

  const original =
    sourceCandidates.find(
      offer => Number(offer.id) === Number(product.primaryEbayOfferId)
    ) || sourceCandidates[0];

  if (original) return original;

  const activeFallback = active
    .sort((a, b) => Number(a.price) - Number(b.price))[0];

  if (activeFallback) return activeFallback;
  if (!includeInactive) return null;

  // Dormant/stale products may have no live offer. Use the newest old listing
  // only as matching/condition context; the search itself discovers the new
  // live listing and ingestion reactivates the canonical product.
  return all
    .slice()
    .sort(
      (a, b) =>
        Date.parse(b.lastSeen || 0) -
        Date.parse(a.lastSeen || 0)
    )[0] || null;
}

function sameCondition(source, candidate) {
  const a = String(source?.conditionGroup || "unknown");
  const b = String(candidate?.conditionGroup || "unknown");
  // Non-working / for-parts listings are never valid competitors for normal
  // OfferGrid intelligence. Rejecting them before exact-detail hydration also
  // saves Browse quota and avoids contaminating seller counts.
  if (isBrokenOrPartsListing(source) || isBrokenOrPartsListing(candidate)) return false;
  if (a === "unknown" || b === "unknown") return true;
  return a === b;
}

function exactSearchQuarantineDays() {
  const value = Number(
    process.env.EBAY_EXACT_SEARCH_QUARANTINE_DAYS || 30
  );

  return Math.min(
    Math.max(Number.isFinite(value) ? value : 30, 1),
    365
  );
}

function exactSearchIsQuarantined(product) {
  const rejectedAt = Date.parse(
    product?.ebayExactSearchRejectedAt || ""
  );

  if (!Number.isFinite(rejectedAt)) return false;

  const ageMs = Date.now() - rejectedAt;
  return (
    ageMs >= 0 &&
    ageMs <
      exactSearchQuarantineDays() *
        86_400_000
  );
}

function exactPlanValue(plan) {
  if (plan?.method === "GTIN") {
    return String(plan.params?.gtin || "");
  }

  if (plan?.method === "ePID") {
    return String(plan.params?.epid || "");
  }

  return "";
}


function fallbackScanPlan(product) {
  const brand = String(product.brand || "").trim();
  const mpn = String(product.mpn || "").trim();

  if (canonicalStrongBrand(brand) && canonicalStrongMpn(mpn)) {
    return {
      method: "Brand + MPN",
      confidence: 96,
      params: { query: `${brand} ${mpn}` },
      keywordOnly: true,
    };
  }

  const title = String(product.title || "").trim();
  return {
    method: "Strict title",
    confidence: 72,
    params: { query: title },
    keywordOnly: true,
  };
}

function normalizedPlanKey(plan) {
  const gtin = normalizeEbayGtin(plan?.params?.gtin);
  if (gtin && !plan?.keywordOnly) return `gtin:${gtin}`;

  const epid = normalizeEbayEpid(plan?.params?.epid);
  if (epid && !plan?.keywordOnly) return `epid:${epid}`;

  return `q:${normalizeRecallQuery(plan?.params?.query || "").toLowerCase()}`;
}

function discoveryMethodMeta(method) {
  const key = String(method || "").toLowerCase();
  if (key === "gtin") {
    return {
      method: "GTIN",
      code: "gtin",
      label: "GTIN search",
      tier: "high",
      confidence: 98,
    };
  }
  if (key === "epid") {
    return {
      method: "ePID",
      code: "epid",
      label: "eBay product ID",
      tier: "high",
      confidence: 97,
    };
  }
  if (key === "brand + mpn" || key === "brand-mpn") {
    return {
      method: "Brand + MPN",
      code: "brand-mpn",
      label: "Brand + MPN",
      tier: "high",
      confidence: 95,
    };
  }
  if (key.includes("mpn-only") || key === "mpn") {
    return {
      method: "MPN-only",
      code: "mpn",
      label: "MPN search",
      tier: "medium",
      confidence: 86,
    };
  }
  return {
    method: "Strict title",
    code: "title",
    label: "Title match",
    tier: "exploratory",
    confidence: 74,
  };
}

function mergeDiscoveryProvenance(candidate, method) {
  const meta = discoveryMethodMeta(method);
  const existingMethods = Array.isArray(candidate?.competitorDiscoveryMethods)
    ? candidate.competitorDiscoveryMethods
    : [];
  const existingLabels = Array.isArray(candidate?.competitorDiscoveryLabels)
    ? candidate.competitorDiscoveryLabels
    : [];

  const methods = [...new Set([...existingMethods, meta.code])].slice(0, 8);
  const labels = [...new Set([...existingLabels, meta.label])].slice(0, 8);
  const currentConfidence = Number(candidate?.competitorDiscoveryConfidence || 0);
  const confidence = Math.max(currentConfidence, meta.confidence);
  const primaryMeta = confidence > currentConfidence || !candidate?.competitorDiscoveryPrimaryMethod
    ? meta
    : discoveryMethodMeta(candidate.competitorDiscoveryPrimaryMethod);

  return {
    ...candidate,
    competitorDiscoveryMethods: methods,
    competitorDiscoveryLabels: labels,
    competitorDiscoveryPrimaryMethod: primaryMeta.code,
    competitorDiscoveryPrimaryLabel: primaryMeta.label,
    competitorDiscoveryTier:
      confidence >= 95 ? "high" : confidence >= 84 ? "medium" : "exploratory",
    competitorDiscoveryConfidence: confidence,
    matchConfidence: Math.max(
      Number(candidate?.matchConfidence || 0),
      Math.min(99, confidence)
    ),
  };
}

function mergeCandidateDiscovery(existing, incoming, method) {
  const base = existing
    ? {
        ...existing,
        ...incoming,
        competitorDiscoveryMethods: existing.competitorDiscoveryMethods || [],
        competitorDiscoveryLabels: existing.competitorDiscoveryLabels || [],
        competitorDiscoveryPrimaryMethod: existing.competitorDiscoveryPrimaryMethod || "",
        competitorDiscoveryPrimaryLabel: existing.competitorDiscoveryPrimaryLabel || "",
        competitorDiscoveryTier: existing.competitorDiscoveryTier || "",
        competitorDiscoveryConfidence: existing.competitorDiscoveryConfidence || 0,
      }
    : { ...incoming };
  return mergeDiscoveryProvenance(base, method);
}

function exactSearchPlanQuarantined(product, method, value) {
  if (!exactSearchIsQuarantined(product)) return false;
  const rejectedMethod = String(product?.ebayExactSearchRejectedMethod || "");
  const rejectedValue = String(product?.ebayExactSearchRejectedValue || "");
  return (
    rejectedMethod.toLowerCase() === String(method || "").toLowerCase() &&
    (!rejectedValue || rejectedValue === String(value || ""))
  );
}

function competitorDiscoveryPlans(product) {
  const maxPlans = Math.min(
    Math.max(Number(process.env.EBAY_COMPETITOR_DISCOVERY_SIGNAL_SEARCHES || 5), 1),
    5
  );
  const plans = [];
  const seen = new Set();

  const add = plan => {
    const key = normalizedPlanKey(plan);
    if (!key || key === "q:" || seen.has(key)) return;
    seen.add(key);
    plans.push(plan);
  };

  const gtin = normalizeEbayGtin(product?.gtin);
  if (gtin && !exactSearchPlanQuarantined(product, "GTIN", gtin)) {
    add({
      method: "GTIN",
      confidence: 100,
      params: { gtin, query: String(product?.title || "").trim() },
      keywordOnly: false,
    });
  }

  const epid = normalizeEbayEpid(product?.epid);
  if (epid && !exactSearchPlanQuarantined(product, "ePID", epid)) {
    add({
      method: "ePID",
      confidence: 99,
      params: { epid, query: String(product?.title || "").trim() },
      keywordOnly: false,
    });
  }

  const brand = String(product?.brand || "").trim();
  const mpn = String(product?.mpn || "").trim();
  if (canonicalStrongBrand(brand) && canonicalStrongMpn(mpn)) {
    add({
      method: "Brand + MPN",
      confidence: 96,
      params: { query: `${brand} ${mpn}` },
      keywordOnly: true,
    });
  }

  if (canonicalStrongMpn(mpn)) {
    add({
      method: "MPN-only",
      confidence: 86,
      params: { query: mpn },
      keywordOnly: true,
    });
  }

  const title = normalizeRecallQuery(product?.title || "");
  if (title) {
    add({
      method: "Strict title",
      confidence: 74,
      params: { query: title },
      keywordOnly: true,
    });
  }

  return plans.slice(0, maxPlans);
}

function scanPlan(product) {
  return competitorDiscoveryPlans(product)[0] || fallbackScanPlan(product);
}
async function maybeEnrichIdentity(
  product,
  priority = "background",
  hooks = {},
  deferPersistence = priority === "background"
) {
  if (product.lifecycleState && product.lifecycleState !== "ACTIVE") {
    return product;
  }

  if (
    normalizeEbayGtin(product.gtin) ||
    normalizeEbayEpid(product.epid) ||
    (canonicalStrongBrand(product.brand) && canonicalStrongMpn(product.mpn))
  ) {
    return product;
  }

  const checked = product.ebayIdentityCheckedAt
    ? Date.parse(product.ebayIdentityCheckedAt)
    : 0;
  const oneDay = 24 * 60 * 60 * 1000;

  if (checked && Date.now() - checked < oneDay) {
    return product;
  }

  const source = sourceEbayOffer(product);
  if (!source?.externalId) {
    return updateProductIdentity(product.id, { checkedAt: new Date().toISOString() }, { deferPersistence }) || product;
  }

  try {
    const getIdentity = typeof hooks.getEbayItemIdentity === "function" ? hooks.getEbayItemIdentity : getEbayItemIdentity;
    const identity = await getIdentity(source.externalId, { priority });
    return updateProductIdentity(product.id, {
      ...identity,
      checkedAt: new Date().toISOString(),
    }, { deferPersistence }) || product;
  } catch (error) {
    if (isEbayRateGuardError(error)) {
      throw error;
    }

    // Identity enrichment is optional. A conservative title fallback can still
    // refresh competitor prices if the item endpoint has no product metadata.
    updateProductIdentity(product.id, {
      checkedAt: new Date().toISOString(),
    }, { deferPersistence });
    return product;
  }
}

function referenceIdentity(product, source) {
  return {
    title:
      String(source?.listingTitle || source?.title || product?.title || "").trim(),
    brand: String(product?.brand || source?.brand || "").trim(),
    gtin: String(product?.gtin || source?.gtin || "").trim(),
    mpn: String(product?.mpn || source?.mpn || "").trim(),
    epid: String(product?.epid || source?.epid || "").trim(),
  };
}

function referenceProofMode(reference) {
  const gtin = normalizeEbayGtin(reference?.gtin);
  if (gtin) return { type: "gtin", value: gtin };

  const brand = String(reference?.brand || "").trim();
  const mpn = String(reference?.mpn || "").trim();
  if (canonicalStrongBrand(brand) && canonicalStrongMpn(mpn)) {
    return { type: "brand-mpn", value: `${brand} ${mpn}` };
  }

  const epid = normalizeEbayEpid(reference?.epid);
  if (epid && brand) return { type: "epid-brand", value: epid };

  return null;
}

function sourceIdentityConflict(product, source) {
  const reasons = [];
  const productGtin = normalizeEbayGtin(product?.gtin);
  const sourceGtin = normalizeEbayGtin(source?.gtin);
  if (productGtin && sourceGtin && productGtin !== sourceGtin) reasons.push("source-gtin-conflict");

  const aBrand = canonicalStrongBrand(product?.brand);
  const bBrand = canonicalStrongBrand(source?.brand);
  if (aBrand && bBrand && aBrand !== bBrand) reasons.push("source-brand-conflict");

  const aMpn = canonicalStrongMpn(product?.mpn);
  const bMpn = canonicalStrongMpn(source?.mpn);
  if (aMpn && bMpn && aMpn !== bMpn) reasons.push("source-mpn-conflict");

  const aEpid = normalizeEbayEpid(product?.epid);
  const bEpid = normalizeEbayEpid(source?.epid);
  if (aEpid && bEpid && aEpid !== bEpid) reasons.push("source-epid-conflict");

  return reasons;
}

function obviousCandidatePrefilter(reference, candidate) {
  const family = familyCompatibility(reference.title, candidate.title, {
    brand: reference.brand || "",
    // V3.7.39: a marketplace title omitting a spec is not the same thing as
    // explicitly contradicting it. Exact detail + strong identity still owns
    // final acceptance; this prefilter now rejects only actual conflicts.
    allowMissingCandidateSpecs: true,
  });

  // Missing capacity/power tokens are tolerated here; semantic family,
  // accessory, and explicit variant conflicts still protect the discovery
  // queue from obvious false positives. Exact item detail owns final trust.
  if (!family.ok) return { ok: false, reasons: family.reasons };
  return { ok: true, reasons: [] };
}

function chunk(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function mergeRejectedCounts(target, source) {
  for (const key of ["existingListing", "condition", "prefilter", "exactDetailMissing", "exactIdentity"]) {
    target[key] = Number(target[key] || 0) + Number(source?.[key] || 0);
  }
  target.reasons ||= {};
  for (const [reason, count] of Object.entries(source?.reasons || {})) {
    target.reasons[reason] = Number(target.reasons[reason] || 0) + Number(count || 0);
  }
  return target;
}

function selectExactProofCandidates(candidates = [], {
  limit = 0,
  sourceMerchant = "",
} = {}) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (!cap || candidates.length <= cap) return [...candidates];

  const sourceSeller = String(sourceMerchant || "").trim().toLowerCase();
  const sorted = [...candidates].sort((a, b) =>
    Number(b.competitorDiscoveryConfidence || b.matchConfidence || 0) -
      Number(a.competitorDiscoveryConfidence || a.matchConfidence || 0) ||
    Number(a.price || Number.POSITIVE_INFINITY) - Number(b.price || Number.POSITIVE_INFINITY)
  );

  // First pass maximizes distinct sellers and prefers sellers other than the
  // canonical source seller. This makes a bounded interactive scan much more
  // likely to improve the verified-seller count instead of spending all of its
  // exact-detail calls on duplicate listings from one merchant.
  const selected = [];
  const selectedIds = new Set();
  const sellers = new Set();
  for (const candidate of sorted) {
    const id = String(candidate.externalId || "");
    const seller = String(candidate.merchant || candidate.seller || "").trim().toLowerCase();
    if (!id || selectedIds.has(id)) continue;
    if (seller && seller === sourceSeller) continue;
    if (seller && sellers.has(seller)) continue;
    selected.push(candidate);
    selectedIds.add(id);
    if (seller) sellers.add(seller);
    if (selected.length >= cap) return selected;
  }

  // Second pass fills remaining slots with the strongest remaining evidence,
  // including same-seller duplicates only after seller-diverse candidates.
  for (const candidate of sorted) {
    const id = String(candidate.externalId || "");
    if (!id || selectedIds.has(id)) continue;
    selected.push(candidate);
    selectedIds.add(id);
    if (selected.length >= cap) break;
  }
  return selected;
}

function normalizeRecallQuery(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}


function competitorRecallPlans(product, primaryPlan) {
  if (String(process.env.EBAY_COMPETITOR_RECALL_ENABLED || "true").toLowerCase() === "false") {
    return [];
  }

  const maxExtra = Math.min(
    Math.max(Number(process.env.EBAY_COMPETITOR_RECALL_SEARCHES || 2), 0),
    4
  );
  if (!maxExtra) return [];

  const primaryKey = normalizedPlanKey(primaryPlan);
  return competitorDiscoveryPlans(product)
    .filter(plan => normalizedPlanKey(plan) !== primaryKey)
    .slice(0, maxExtra);
}

async function fetchExactCandidateDetails(candidates, priority = "background", hooks = {}) {
  const size = Math.min(
    Math.max(Number(process.env.EBAY_COMPETITOR_EXACT_BATCH_SIZE || 20), 1),
    20
  );

  const details = new Map();
  const unresolved = new Set();
  const deferred = new Set();

  async function fetchGroup(group) {
    if (!group.length) return;

    const ids = group.map(candidate => String(candidate.externalId));
    try {
      if (priority === "background") {
        await backgroundCheckpoint("ebay-competitors:exact-detail-batch");
      }
      const getItemsDetails = typeof hooks.getEbayItemsDetails === "function" ? hooks.getEbayItemsDetails : getEbayItemsDetails;
      const response = await getItemsDetails(ids, {
        priority,
        includeProductIdentity: true,
      });

      for (const detail of response.items || []) {
        details.set(String(detail.externalId), detail);
      }
      for (const id of response.missingIds || []) {
        unresolved.add(String(id));
      }
      for (const id of response.deferredIds || []) {
        deferred.add(String(id));
      }
    } catch (error) {
      if (isEbayRateGuardError(error)) throw error;

      // One malformed item ID must not prevent proof for the rest of a batch.
      // Split at this layer only; the provider owns the bounded permission-aware
      // getItem fallback when bulk access is unavailable.
      if (Number(error?.status) === 400 && group.length > 1) {
        const middle = Math.ceil(group.length / 2);
        await fetchGroup(group.slice(0, middle));
        await fetchGroup(group.slice(middle));
        return;
      }

      for (const candidate of group) {
        unresolved.add(String(candidate.externalId));
      }
    }
  }

  const exactBatches = buildEbayGetItemsBatches(candidates, {
    idOf: candidate => candidate.externalId,
    singleBatchSize: size,
    variationBatchSize: Math.min(size, 10),
  });

  for (const batch of exactBatches) {
    await fetchGroup(batch.values);
  }

  return { details, unresolved, deferred };
}


function prefilterCompetitorCandidates(product, source, candidates = []) {
  const reference = referenceIdentity(product, source);
  const existingIds = new Set(
    (product.offers || [])
      .filter(offer => String(offer.provider || "").toLowerCase() === "ebay")
      .map(offer => String(offer.externalId || ""))
      .filter(Boolean)
  );
  const rejected = {
    existingListing: 0,
    condition: 0,
    prefilter: 0,
    exactDetailMissing: 0,
    exactIdentity: 0,
    reasons: {},
  };

  function reject(bucket, reasons = []) {
    rejected[bucket] = Number(rejected[bucket] || 0) + 1;
    for (const reason of reasons) {
      rejected.reasons[reason] = Number(rejected.reasons[reason] || 0) + 1;
    }
  }

  const plausible = [];
  for (const candidate of candidates || []) {
    if (existingIds.has(String(candidate?.externalId || ""))) {
      reject("existingListing", ["already-attached-ebay-listing"]);
      continue;
    }
    if (!sameCondition(source, candidate)) {
      reject("condition", ["condition-conflict"]);
      continue;
    }
    const prefilter = obviousCandidatePrefilter(reference, candidate);
    if (!prefilter.ok) {
      reject("prefilter", prefilter.reasons);
      continue;
    }
    plausible.push(candidate);
  }

  return { reference, plausible, rejected };
}

async function exactProofMatches(product, source, candidates, priority = "background", hooks = {}) {
  const reference = referenceIdentity(product, source);
  const existingIds = new Set(
    (product.offers || [])
      .filter(offer => String(offer.provider || "").toLowerCase() === "ebay")
      .map(offer => String(offer.externalId || ""))
      .filter(Boolean)
  );

  const rejected = {
    existingListing: 0,
    condition: 0,
    prefilter: 0,
    exactDetailMissing: 0,
    exactIdentity: 0,
    reasons: {},
  };

  function reject(bucket, reasons = []) {
    rejected[bucket] = Number(rejected[bucket] || 0) + 1;
    for (const reason of reasons) {
      rejected.reasons[reason] = Number(rejected.reasons[reason] || 0) + 1;
    }
  }

  const plausible = [];
  for (const candidate of candidates) {
    if (existingIds.has(String(candidate.externalId || ""))) {
      reject("existingListing", ["already-attached-ebay-listing"]);
      continue;
    }

    if (!sameCondition(source, candidate)) {
      reject("condition", ["condition-conflict"]);
      continue;
    }

    const prefilter = obviousCandidatePrefilter(reference, candidate);
    if (!prefilter.ok) {
      reject("prefilter", prefilter.reasons);
      continue;
    }

    plausible.push(candidate);
  }

  const exact = await fetchExactCandidateDetails(plausible, priority, hooks);
  const accepted = [];
  const pendingIds = new Set();
  const pendingCandidates = [];

  const incompleteIdentityOnly = reasons => {
    const list = Array.isArray(reasons) ? reasons : [];
    return (
      list.length > 0 &&
      list.every(reason =>
        String(reason).startsWith("candidate-") && String(reason).endsWith("-missing") ||
        String(reason) === "no-provable-reference-identity"
      )
    );
  };

  for (const candidate of plausible) {
    const externalId = String(candidate.externalId || "");
    const detail = exact.details.get(externalId);
    if (!detail || detail.missing) {
      const wasDeferred = exact.deferred?.has(externalId);
      reject(
        "exactDetailMissing",
        [wasDeferred ? "exact-item-detail-deferred" : "exact-item-detail-unavailable"]
      );
      pendingIds.add(externalId);
      pendingCandidates.push({
        ...candidate,
        ...(wasDeferred
          ? {}
          : { competitorIdentityLastAttemptAt: new Date().toISOString() }),
        competitorExactDetailObservedAt: null,
      });
      continue;
    }

    if (detail.availability === "out_of_stock") {
      reject("exactDetailMissing", ["exact-item-not-active"]);
      continue;
    }

    if (!sameCondition(source, detail)) {
      reject("condition", ["exact-condition-conflict"]);
      continue;
    }

    const proof = exactCompetitorProof(reference, detail);
    if (!proof.ok) {
      reject("exactIdentity", proof.reasons);
      if (incompleteIdentityOnly(proof.reasons)) {
        pendingIds.add(externalId);
        pendingCandidates.push({
          ...candidate,
          ...detail,
          // Keep this as observed/pending even though getItems returned exact
          // listing detail: same-product identity is still not proven.
          price: Number.isFinite(Number(detail.price)) && Number(detail.price) > 0
            ? Number(detail.price)
            : Number(candidate.price),
          competitorIdentityLastAttemptAt: new Date().toISOString(),
          competitorExactDetailObservedAt:
            detail.priceVerifiedAt || detail.lastSeen || new Date().toISOString(),
        });
      }
      continue;
    }

    accepted.push({
      ...candidate,
      ...detail,
      category: candidate.category || product.category || "Other",
      listingTitle: detail.listingTitle || detail.title || candidate.title || "",
      brand: detail.brand || "",
      gtin: detail.gtin || "",
      mpn: detail.mpn || "",
      epid: detail.epid || "",
      verificationVersion: 4,
      priceSource: "ebay-item-detail",
      priceVerifiedAt: detail.priceVerifiedAt || new Date().toISOString(),
      priceVerificationStatus: "verified",
      matchConfidence: 100,
      matchSource: `ebay-competitor:v4-exact-${proof.proofType}`,
      matchProofType: proof.proofType,
      matchProofVersion: 4,
      matchReferenceTitle: reference.title,
      matchReferenceBrand: reference.brand,
      matchReferenceGtin: reference.gtin,
      matchReferenceMpn: reference.mpn,
      matchReferenceEpid: reference.epid,
    });
  }

  return {
    reference,
    accepted,
    pendingIds,
    pendingCandidates,
    rejected,
    plausible: plausible.length,
    exactDetailsReturned: exact.details.size,
    exactDeferredCount: exact.deferred.size,
    exactUnresolvedCount: exact.unresolved.size,
  };
}


export async function scanEbayCompetitorsForProduct(product, {
  priority = "background",
  testHooks = null,
  maxSignals = null,
  maxExactCandidates = null,
  signalStartIndex = 0,
  signalMethod = "",
  deferPersistence = priority === "background",
} = {}) {
  const hooks = testHooks && typeof testHooks === "object" ? testHooks : {};
  if (priority === "background") {
    await backgroundCheckpoint(`ebay-competitors:product:${product.id}`);
  }

  const refreshedProduct = await maybeEnrichIdentity(product, priority, hooks, deferPersistence);
  const source =
    sourceEbayOffer(refreshedProduct, { includeInactive: true }) ||
    sourceEbayOffer(product, { includeInactive: true }) ||
    {
      conditionGroup: "unknown",
      condition: "",
      externalId: "",
      listingTitle: refreshedProduct.title || product.title || "",
    };

  const reference = referenceIdentity(refreshedProduct, source);
  const proofMode = referenceProofMode(reference);
  const sourceConflicts = sourceIdentityConflict(refreshedProduct, source);

  if (sourceConflicts.length) {
    const reason = `Reference/source identity conflict: ${sourceConflicts.join(",")}`;
    markEbayCompetitorScan(refreshedProduct.id, {
      method: proofMode ? `Exact ${proofMode.type}` : "Discovery withheld",
      confidence: 0,
      matched: 0,
      error: reason,
    });

    return {
      productId: refreshedProduct.id,
      title: refreshedProduct.title,
      lifecycleState: refreshedProduct.lifecycleState || "ACTIVE",
      skipped: true,
      skipReason: reason,
      method: "Discovery withheld",
      confidence: 0,
      received: 0,
      matched: 0,
      offersCreated: 0,
      offersUpdated: 0,
      rejected: {
        existingListing: 0,
        condition: 0,
        prefilter: 0,
        exactDetailMissing: 0,
        exactIdentity: 0,
        reasons: Object.fromEntries(sourceConflicts.map(item => [item, 1])),
      },
    };
  }

  const discoveryReference = {
    ...refreshedProduct,
    title: reference.title || refreshedProduct.title || "",
    brand: reference.brand || refreshedProduct.brand || "",
    gtin: reference.gtin || refreshedProduct.gtin || "",
    mpn: reference.mpn || refreshedProduct.mpn || "",
    epid: reference.epid || refreshedProduct.epid || "",
  };
  const allPlans = competitorDiscoveryPlans(discoveryReference);
  const requestedSignalMethod = String(signalMethod || "").trim().toLowerCase();
  const safeSignalStart = Math.min(
    Math.max(Math.floor(Number(signalStartIndex || 0)), 0),
    allPlans.length
  );
  const remainingPlans = requestedSignalMethod
    ? allPlans.filter(plan => String(plan.method || "").toLowerCase() === requestedSignalMethod)
    : allPlans.slice(safeSignalStart);
  const signalCap = maxSignals == null
    ? remainingPlans.length
    : Math.min(Math.max(Number(maxSignals || 1), 1), remainingPlans.length || 1);
  const plans = remainingPlans.slice(0, signalCap);
  if (!plans.length) {
    markEbayCompetitorScan(refreshedProduct.id, {
      method: "No usable discovery signal",
      confidence: 0,
      matched: 0,
      error: "",
    });
    return {
      productId: refreshedProduct.id,
      title: refreshedProduct.title,
      lifecycleState: refreshedProduct.lifecycleState || "ACTIVE",
      skipped: true,
      skipReason: "No GTIN, ePID, Brand+MPN, MPN, or usable title is available for competitor discovery.",
      method: "No usable discovery signal",
      confidence: 0,
      received: 0,
      matched: 0,
      offersCreated: 0,
      offersUpdated: 0,
    };
  }

  const legacyResultLimit = Math.max(
    Number(process.env.EBAY_COMPETITOR_RESULTS_PER_PRODUCT || 50),
    5
  );
  const limit = Math.min(
    Math.max(
      Number(
        process.env.EBAY_COMPETITOR_DISCOVERY_RESULTS_PER_PRODUCT ||
        Math.max(legacyResultLimit, 100)
      ),
      5
    ),
    200
  );
  const keywordLimit = Math.min(
    limit,
    Math.max(Number(process.env.EBAY_COMPETITOR_RECALL_RESULTS || 40), 5)
  );

  const attempts = [];
  const candidateMap = new Map();
  let received = 0;

  try {
    for (let index = 0; index < plans.length; index++) {
      const plan = plans[index];
      if (priority === "background") {
        await backgroundCheckpoint(`ebay-competitors:signal:${refreshedProduct.id}:${index + 1}`);
      }

      const planLimit = plan.keywordOnly ? keywordLimit : limit;
      let results = [];

      try {
        const searchAdvanced = typeof hooks.searchEbayAdvanced === "function" ? hooks.searchEbayAdvanced : searchEbayAdvanced;
        results = await searchAdvanced({
          ...plan.params,
          limit: planLimit,
          fixedPriceOnly: true,
          priority,
          keywordOnly: Boolean(plan.keywordOnly),
        });
      } catch (error) {
        if (
          error?.code === "EBAY_INVALID_REMOTE_SEARCH" &&
          (plan.method === "GTIN" || plan.method === "ePID")
        ) {
          markEbayExactSearchRejected(
            refreshedProduct.id,
            {
              method: plan.method,
              value: exactPlanValue(plan),
              errorId: error.ebayErrorId || 12001,
            },
            { deferPersistence }
          );
          opWarn(
            "ebay-competitors",
            `eBay rejected ${plan.method} discovery for product ${refreshedProduct.id}; continuing with remaining discovery signals`,
            {
              productId: refreshedProduct.id,
              ebayErrorId: error.ebayErrorId || 12001,
              remainingSignals: plans.slice(index + 1).map(item => item.method),
            }
          );
          attempts.push({
            method: plan.method,
            confidence: plan.confidence,
            received: 0,
            unique: 0,
            error: `eBay ${error.ebayErrorId || 12001}`,
          });
          continue;
        }
        throw error;
      }

      if (
        (plan.method === "GTIN" || plan.method === "ePID") &&
        exactSearchIsQuarantined(refreshedProduct) &&
        String(refreshedProduct.ebayExactSearchRejectedMethod || "").toLowerCase() ===
          plan.method.toLowerCase()
      ) {
        clearEbayExactSearchRejected(refreshedProduct.id, { deferPersistence });
      }

      received += Number(results?.length || 0);
      let uniqueAdded = 0;
      for (const candidate of results || []) {
        const externalId = String(candidate?.externalId || "").trim();
        if (!externalId) continue;
        const existing = candidateMap.get(externalId) || null;
        const merged = mergeCandidateDiscovery(existing, candidate, plan.method);
        if (!existing) uniqueAdded++;
        candidateMap.set(externalId, merged);
      }

      attempts.push({
        method: plan.method,
        confidence: plan.confidence,
        received: Number(results?.length || 0),
        unique: uniqueAdded,
      });

      opLog("ebay-competitors", `discovery signal complete for product ${refreshedProduct.id}`, {
        productId: refreshedProduct.id,
        method: plan.method,
        returned: Number(results?.length || 0),
        uniqueCandidates: candidateMap.size,
        priority,
      });
    }

    const discoveredCandidates = [...candidateMap.values()];
    const filtered = prefilterCompetitorCandidates(
      refreshedProduct,
      source,
      discoveredCandidates
    );

    const plausible = filtered.plausible.map(candidate => ({
      ...candidate,
      matchConfidence: Math.max(
        0,
        Math.min(99, Number(candidate.competitorDiscoveryConfidence || candidate.matchConfidence || 74))
      ),
    }));

    const exactCandidateCap = maxExactCandidates == null
      ? plausible.length
      : Math.min(Math.max(Number(maxExactCandidates || 1), 1), plausible.length || 1);
    const exactCandidates = selectExactProofCandidates(plausible, {
      limit: exactCandidateCap,
      sourceMerchant: source?.merchant || "",
    });
    const exactCandidateIds = new Set(exactCandidates.map(item => String(item.externalId || "")));
    const overflowCandidates = plausible.filter(
      item => !exactCandidateIds.has(String(item.externalId || ""))
    );

    opLog("ebay-competitors", `multi-signal discovery complete for product ${refreshedProduct.id}`, {
      productId: refreshedProduct.id,
      signalsRun: attempts.map(item => item.method),
      returnedAcrossSignals: received,
      uniqueCandidates: discoveredCandidates.length,
      plausibleCandidates: plausible.length,
      exactCandidatesSelected: exactCandidates.length,
      exactCandidatesDeferred: overflowCandidates.length,
      exactProofAvailable: Boolean(proofMode),
      priority,
    });

    // Scheduled work remains Browse-first. Persist all locally plausible
    // candidates with provenance, then let the cross-product sanitizer pack
    // exact item IDs into efficient getItems calls. Products without strong
    // identity can still expose clearly-labeled observed candidates, but the
    // sanitizer will defer exact same-product certification until a provable
    // reference identity exists.
    if (priority === "background") {
      const queued = queueEbayCompetitorCandidates(
        refreshedProduct.id,
        plausible,
        {
          reason: `multi-signal:${attempts.map(item => item.method).join(" + ")}`,
          deferPersistence: true,
        }
      );

      markEbayCompetitorScan(refreshedProduct.id, {
        method: proofMode
          ? `Multi-signal pending · ${proofMode.type}`
          : "Multi-signal observed · identity incomplete",
        confidence: plausible.length
          ? Math.max(...plausible.map(item => Number(item.competitorDiscoveryConfidence || 0)))
          : 100,
        matched: 0,
        error: "",
      });

      return {
        productId: refreshedProduct.id,
        title: refreshedProduct.title,
        lifecycleState: refreshedProduct.lifecycleState || "ACTIVE",
        exactSearchQuarantined: exactSearchIsQuarantined(refreshedProduct),
        method: proofMode
          ? `Multi-signal pending ${proofMode.type}`
          : "Multi-signal observed",
        searchMethod: attempts.map(item => item.method).join(" + "),
        searchAttempts: attempts,
        confidence: plausible.length
          ? Math.max(...plausible.map(item => Number(item.competitorDiscoveryConfidence || 0)))
          : 100,
        received,
        uniqueCandidates: discoveredCandidates.length,
        plausible: plausible.length,
        exactDetailsReturned: 0,
        matched: 0,
        pendingQueued: Number(queued.queued || 0),
        pendingCreated: Number(queued.created || 0),
        pendingUpdated: Number(queued.updated || 0),
        pendingCapSkipped: Number(queued.pendingCapSkipped || 0),
        offersCreated: 0,
        offersUpdated: 0,
        rejected: filtered.rejected,
      };
    }

    // Manual/interactive competitor discovery performs exact verification
    // immediately, but still preserves plausible listings that lack enough
    // item-specific identity as pending observations. This makes the manual
    // action visibly consume getItems only when there are candidate IDs to
    // prove, and avoids throwing away useful seller coverage when an eBay
    // lister omitted GTIN/MPN/ePID specifics.
    if (!plausible.length) {
      markEbayCompetitorScan(refreshedProduct.id, {
        method: proofMode ? `Multi-signal exact ${proofMode.type}` : "Multi-signal observed",
        confidence: 100,
        matched: 0,
        error: "",
      });

      return {
        productId: refreshedProduct.id,
        title: refreshedProduct.title,
        lifecycleState: refreshedProduct.lifecycleState || "ACTIVE",
        method: proofMode ? `Multi-signal exact ${proofMode.type}` : "Multi-signal observed",
        searchMethod: attempts.map(item => item.method).join(" + "),
        searchAttempts: attempts,
        confidence: 100,
        received,
        uniqueCandidates: discoveredCandidates.length,
        plausible: 0,
        exactDetailsReturned: 0,
        matched: 0,
        pendingQueued: 0,
        pendingCreated: 0,
        pendingUpdated: 0,
        offersCreated: 0,
        offersUpdated: 0,
        rejected: filtered.rejected,
      };
    }

    if (!proofMode) {
      const queued = queueEbayCompetitorCandidates(
        refreshedProduct.id,
        plausible,
        {
          reason: `multi-signal:identity-incomplete:${attempts.map(item => item.method).join(" + ")}`,
          deferPersistence,
        }
      );
      markEbayCompetitorScan(refreshedProduct.id, {
        method: "Multi-signal observed · identity incomplete",
        confidence: Math.max(...plausible.map(item => Number(item.competitorDiscoveryConfidence || 0))),
        matched: 0,
        error: "",
      });
      return {
        productId: refreshedProduct.id,
        title: refreshedProduct.title,
        lifecycleState: refreshedProduct.lifecycleState || "ACTIVE",
        method: "Multi-signal observed",
        searchMethod: attempts.map(item => item.method).join(" + "),
        searchAttempts: attempts,
        confidence: Math.max(...plausible.map(item => Number(item.competitorDiscoveryConfidence || 0))),
        received,
        uniqueCandidates: discoveredCandidates.length,
        plausible: plausible.length,
        exactDetailsReturned: 0,
        matched: 0,
        pendingQueued: Number(queued.queued || 0),
        pendingCreated: Number(queued.created || 0),
        pendingUpdated: Number(queued.updated || 0),
        pendingCapSkipped: Number(queued.pendingCapSkipped || 0),
        offersCreated: 0,
        offersUpdated: 0,
        rejected: filtered.rejected,
      };
    }

    const estimatedBatches = buildEbayGetItemsBatches(exactCandidates, {
      idOf: candidate => candidate.externalId,
    });
    opLog("ebay-competitors", `dispatching exact competitor verification for product ${refreshedProduct.id}`, {
      productId: refreshedProduct.id,
      candidateIds: exactCandidates.length,
      deferredCandidateIds: overflowCandidates.length,
      getItemsBatches: estimatedBatches.length,
      priority,
    });

    const exact = await exactProofMatches(
      refreshedProduct,
      source,
      exactCandidates,
      priority,
      hooks
    );

    const result = ingestCandidates(exact.accepted || [], {
      targetProductId: refreshedProduct.id,
      deferPersistence,
    });

    // Exact detail can be present while the seller omitted one or more product
    // identifiers needed for same-product proof. Preserve those candidates as
    // observed/pending rather than silently discarding them.
    const unresolved = [
      ...(Array.isArray(exact.pendingCandidates) ? exact.pendingCandidates : []),
      ...overflowCandidates,
    ];

    const queued = unresolved.length
      ? queueEbayCompetitorCandidates(
          refreshedProduct.id,
          unresolved,
          {
            reason: `multi-signal:exact-proof-incomplete:${attempts.map(item => item.method).join(" + ")}`,
            deferPersistence,
          }
        )
      : { queued: 0, created: 0, updated: 0 };

    markEbayCompetitorScan(refreshedProduct.id, {
      method: `Multi-signal exact ${proofMode.type}`,
      confidence: exact.accepted?.length ? 100 : Math.max(...plausible.map(item => Number(item.competitorDiscoveryConfidence || 0))),
      matched: Number(exact.accepted?.length || 0),
      error: "",
    });

    return {
      productId: refreshedProduct.id,
      title: refreshedProduct.title,
      lifecycleState: refreshedProduct.lifecycleState || "ACTIVE",
      method: `Multi-signal exact ${proofMode.type}`,
      searchMethod: attempts.map(item => item.method).join(" + "),
      searchAttempts: attempts,
      confidence: exact.accepted?.length ? 100 : Math.max(...plausible.map(item => Number(item.competitorDiscoveryConfidence || 0))),
      received,
      uniqueCandidates: discoveredCandidates.length,
      plausible: plausible.length,
      exactDetailsReturned: Number(exact.exactDetailsReturned || 0),
      exactDetailDeferred: Number(exact.exactDeferredCount || 0),
      exactDetailUnresolved: Number(exact.exactUnresolvedCount || 0),
      exactCandidatesSelected: exactCandidates.length,
      exactCandidatesDeferred: overflowCandidates.length,
      matched: Number(exact.accepted?.length || 0),
      pendingQueued: Number(queued.queued || 0),
      pendingCreated: Number(queued.created || 0),
      pendingUpdated: Number(queued.updated || 0),
      pendingCapSkipped: Number(queued.pendingCapSkipped || 0),
      offersCreated: result.offersCreated,
      offersUpdated: result.offersUpdated,
      rejected: mergeRejectedCounts(filtered.rejected, exact.rejected),
    };
  } catch (error) {
    if (isEbayRateGuardError(error)) {
      throw error;
    }

    markEbayCompetitorScan(refreshedProduct.id, {
      method: proofMode ? `Multi-signal exact ${proofMode.type}` : "Multi-signal observed",
      confidence: 0,
      matched: 0,
      error: error?.message || String(error),
    });
    throw error;
  }
}


function verifiedSellerCount(product) {
  return Math.max(0, Number(product?.ebayCompetition?.sellerCount || 0));
}

function verifiedListingCount(product) {
  return Math.max(0, Number(product?.ebayCompetition?.listingCount || 0));
}

/**
 * V3.7.42 shopper-page scanner.
 *
 * The broad shopper query chooses normalized products. Competitor discovery is
 * then performed independently for one normalized product at a time. Signals
 * are widened in evidence order (GTIN -> ePID -> Brand+MPN -> MPN -> strict
 * title) only while verified seller coverage is still below the target.
 *
 * Each signal is exact-checked before the next signal is attempted. This means
 * a common product can stop early as soon as enough distinct exact-verified
 * sellers are attached, while a one-seller product continues through every
 * usable discovery signal instead of being declared "fresh" after a shallow
 * two-signal pass.
 */
export async function scanEbayCompetitorsProgressivelyForProduct(product, {
  priority = "interactive",
  targetSellers = 3,
  maxSignals = null,
  maxExactCandidates = null,
  deferPersistence = true,
  testHooks = null,
  onProgress = null,
  shouldStop = null,
  forceCoverageRefresh = false,
} = {}) {
  const safeTarget = Math.min(Math.max(Number(targetSellers || 3), 2), 8);
  const configuredSignals = Math.min(
    Math.max(Number(process.env.EBAY_COMPETITOR_DISCOVERY_SIGNAL_SEARCHES || 5), 1),
    5
  );
  const signalLimit = maxSignals == null
    ? configuredSignals
    : Math.min(Math.max(Number(maxSignals || 1), 1), configuredSignals);

  const aggregate = {
    productId: Number(product?.id),
    title: String(product?.title || ""),
    progressive: true,
    targetSellers: safeTarget,
    signalsRun: [],
    searchAttempts: [],
    received: 0,
    uniqueCandidates: 0,
    plausible: 0,
    exactDetailsReturned: 0,
    exactDetailDeferred: 0,
    exactDetailUnresolved: 0,
    exactCandidatesDeferred: 0,
    matched: 0,
    pendingQueued: 0,
    pendingCreated: 0,
    pendingUpdated: 0,
    pendingCapSkipped: 0,
    offersCreated: 0,
    offersUpdated: 0,
    rejected: {
      existingListing: 0,
      condition: 0,
      prefilter: 0,
      exactDetailMissing: 0,
      exactIdentity: 0,
      reasons: {},
    },
    sellerCountBefore: 0,
    sellerCountAfter: 0,
    listingCountBefore: 0,
    listingCountAfter: 0,
    targetReached: false,
    signalsExhausted: false,
    coverageComplete: false,
    coverageStatus: "",
    deferred: false,
    cancelled: false,
  };

  const hooks = testHooks && typeof testHooks === "object" ? testHooks : {};
  const stopRequested = () => {
    try { return typeof shouldStop === "function" && Boolean(shouldStop()); }
    catch { return false; }
  };
  // Freeze the progressive ladder after one optional identity-enrichment step.
  // A rejected/quarantined exact-search signal can then disappear locally
  // without shifting indexes and accidentally skipping the next signal.
  let refreshed = await maybeEnrichIdentity(
    getProduct(product?.id, true, { includeHistory: false }) || product,
    priority,
    hooks,
    deferPersistence
  );
  refreshed = getProduct(product?.id, true, { includeHistory: false }) || refreshed || product;
  if (stopRequested()) {
    aggregate.cancelled = true;
    aggregate.coverageStatus = "superseded-to-background";
    return aggregate;
  }
  const plannedMethods = competitorDiscoveryPlans(refreshed)
    .slice(0, signalLimit)
    .map(plan => String(plan.method || ""))
    .filter(Boolean);

  aggregate.sellerCountBefore = verifiedSellerCount(refreshed);
  aggregate.sellerCountAfter = aggregate.sellerCountBefore;
  aggregate.listingCountBefore = verifiedListingCount(refreshed);
  aggregate.listingCountAfter = aggregate.listingCountBefore;

  if (aggregate.sellerCountBefore >= safeTarget && !forceCoverageRefresh) {
    aggregate.targetReached = true;
    aggregate.coverageComplete = true;
    aggregate.coverageStatus = "target-reached";
    markEbayCompetitorScan(product.id, {
      method: "Progressive exact · target already reached",
      confidence: 100,
      matched: 0,
      error: "",
      coverageComplete: true,
      coverageTargetSellers: safeTarget,
      coverageSignalsExhausted: false,
      coverageSignalsRun: 0,
      coverageSellerCount: aggregate.sellerCountAfter,
      coverageStatus: aggregate.coverageStatus,
    });
    return aggregate;
  }

  // A stale or never-researched visible card gets one real discovery probe even
  // if its stored seller count already meets the target. Fresh completed cards
  // never reach this function from page hydration, so this does not create
  // repeated work on every search.
  let refreshProbePending = Boolean(forceCoverageRefresh);

  const exactCandidateLimit = Math.min(
    Math.max(Number(
      maxExactCandidates ?? process.env.LIVE_SEARCH_COMPETITOR_EXACT_CANDIDATES ?? 6
    ), 1),
    20
  );
  let noUsableSignal = plannedMethods.length === 0;
  let signalsVisited = 0;

  for (let signalIndex = 0; signalIndex < plannedMethods.length; signalIndex++) {
    if (aggregate.sellerCountAfter >= safeTarget && !refreshProbePending) break;
    if (stopRequested()) {
      aggregate.cancelled = true;
      break;
    }
    const plannedMethod = plannedMethods[signalIndex];
    signalsVisited++;

    onProgress?.({
      phase: "signal-start",
      productId: Number(product.id),
      signalIndex,
      signalNumber: signalIndex + 1,
      maxSignals: plannedMethods.length,
      signal: plannedMethod,
      sellerCount: aggregate.sellerCountAfter,
      listingCount: aggregate.listingCountAfter,
      targetSellers: safeTarget,
    });

    const result = await scanEbayCompetitorsForProduct(
      getProduct(product.id, true, { includeHistory: false }) || refreshed,
      {
        priority,
        testHooks,
        signalMethod: plannedMethod,
        maxSignals: 1,
        // V3.7.43 bounds each signal's exact-detail burst so a single noisy
        // normalized product cannot monopolize the shopper lane. Seller-diverse
        // candidates are chosen first; overflow remains pending and therefore
        // cannot be mistaken for verified competitor coverage.
        maxExactCandidates: exactCandidateLimit,
        deferPersistence,
      }
    );

    if (result?.skipped && String(result?.skipReason || "").startsWith("No GTIN")) {
      // This specific planned method may have been quarantined by eBay between
      // passes. Move to the next frozen method instead of index-shifting over it.
      continue;
    }

    const attempts = Array.isArray(result?.searchAttempts) ? result.searchAttempts : [];
    if (!attempts.length) continue;

    const attempt = attempts[0];
    aggregate.signalsRun.push(String(attempt.method || result?.searchMethod || `signal-${signalIndex + 1}`));
    aggregate.searchAttempts.push(...attempts);
    aggregate.received += Number(result?.received || 0);
    aggregate.uniqueCandidates += Number(result?.uniqueCandidates || 0);
    aggregate.plausible += Number(result?.plausible || 0);
    aggregate.exactDetailsReturned += Number(result?.exactDetailsReturned || 0);
    aggregate.exactDetailDeferred += Number(result?.exactDetailDeferred || 0);
    aggregate.exactDetailUnresolved += Number(result?.exactDetailUnresolved || 0);
    aggregate.exactCandidatesDeferred += Number(result?.exactCandidatesDeferred || 0);
    aggregate.matched += Number(result?.matched || 0);
    aggregate.pendingQueued += Number(result?.pendingQueued || 0);
    aggregate.pendingCreated += Number(result?.pendingCreated || 0);
    aggregate.pendingUpdated += Number(result?.pendingUpdated || 0);
    aggregate.pendingCapSkipped += Number(result?.pendingCapSkipped || 0);
    aggregate.offersCreated += Number(result?.offersCreated || 0);
    aggregate.offersUpdated += Number(result?.offersUpdated || 0);
    mergeRejectedCounts(aggregate.rejected, result?.rejected || {});

    refreshed = getProduct(product.id, true, { includeHistory: false }) || refreshed;
    aggregate.sellerCountAfter = verifiedSellerCount(refreshed);
    aggregate.listingCountAfter = verifiedListingCount(refreshed);
    aggregate.targetReached = aggregate.sellerCountAfter >= safeTarget;
    refreshProbePending = false;

    onProgress?.({
      phase: "signal-complete",
      productId: Number(product.id),
      signalIndex,
      signalNumber: signalIndex + 1,
      signal: String(attempt.method || ""),
      sellerCount: aggregate.sellerCountAfter,
      listingCount: aggregate.listingCountAfter,
      targetSellers: safeTarget,
      matched: Number(result?.matched || 0),
      exactDeferred: Number(result?.exactDetailDeferred || 0),
    });

    // Navigation may supersede this page while one atomic eBay signal is in
    // flight. Finish that signal safely, then stop widening and hand the
    // remaining normalized-product work to the background scheduler.
    if (!aggregate.targetReached && stopRequested()) {
      aggregate.cancelled = true;
      break;
    }

    // When exact item detail was quota-deferred, do not widen to weaker recall
    // signals and pretend the product was completely inspected. Resume this
    // normalized product on a later foreground pass instead.
    if (Number(result?.exactDetailDeferred || 0) > 0) {
      aggregate.deferred = true;
      break;
    }

    if (aggregate.targetReached) break;

    // Let HTTP/SSE traffic cut between discovery signals. A difficult product
    // can use all five recall paths, but it must never monopolize Node's turn.
    await new Promise(resolve => setImmediate(resolve));
  }

  // Probe the now-enriched product identity locally to determine whether every
  // usable signal was visited. This makes under-target one-seller products
  // truly stale until the progressive recall ladder has been exhausted.
  refreshed = getProduct(product.id, true, { includeHistory: false }) || refreshed;
  if (aggregate.cancelled) {
    aggregate.sellerCountAfter = verifiedSellerCount(refreshed);
    aggregate.listingCountAfter = verifiedListingCount(refreshed);
    aggregate.targetReached = aggregate.sellerCountAfter >= safeTarget;
    aggregate.coverageComplete = aggregate.targetReached;
    aggregate.coverageStatus = aggregate.targetReached
      ? "target-reached"
      : "superseded-to-background";
    if (!aggregate.targetReached) return aggregate;
  }
  aggregate.signalsExhausted = aggregate.signalsExhausted ||
    (!aggregate.deferred && signalsVisited >= plannedMethods.length);
  aggregate.sellerCountAfter = verifiedSellerCount(refreshed);
  aggregate.listingCountAfter = verifiedListingCount(refreshed);
  aggregate.targetReached = aggregate.sellerCountAfter >= safeTarget;
  aggregate.coverageComplete = Boolean(
    aggregate.targetReached ||
    (
      aggregate.signalsExhausted &&
      !aggregate.deferred &&
      aggregate.exactCandidatesDeferred === 0
    )
  );
  aggregate.coverageStatus = aggregate.targetReached
    ? "target-reached"
    : aggregate.deferred
      ? "quota-deferred"
      : aggregate.exactCandidatesDeferred > 0
        ? "bounded-candidates-pending"
        : noUsableSignal
          ? "identity-incomplete"
          : aggregate.signalsExhausted
            ? "signals-exhausted"
            : "incomplete";

  markEbayCompetitorScan(product.id, {
    method: aggregate.targetReached
      ? `Progressive exact · ${aggregate.signalsRun.join(" + ") || "target"}`
      : `Progressive exact exhausted · ${aggregate.signalsRun.join(" + ") || "none"}`,
    confidence: aggregate.coverageComplete ? 100 : 0,
    matched: aggregate.matched,
    error: aggregate.deferred ? "Exact competitor detail was deferred by the protected eBay quota budget." : "",
    coverageComplete: aggregate.coverageComplete,
    coverageTargetSellers: safeTarget,
    coverageSignalsExhausted: aggregate.signalsExhausted,
    coverageSignalsRun: aggregate.signalsRun.length,
    coverageSellerCount: aggregate.sellerCountAfter,
    coverageStatus: aggregate.coverageStatus,
  });

  return aggregate;
}

export async function runEbayCompetitorScan({ limit, priority = "background" } = {}) {
  const cap = Math.min(
    Math.max(Number(limit || process.env.EBAY_COMPETITOR_PRODUCTS_PER_RUN || 40), 1),
    250
  );
  const priorityProducts = backgroundPriorityProducts(cap);
  const priorityIds = new Set(priorityProducts.map(product => Number(product.id)));
  const products = [
    ...priorityProducts,
    ...getProductsForEbayCompetitorScan(cap)
      .filter(product => !priorityIds.has(Number(product.id)))
      .slice(0, Math.max(0, cap - priorityProducts.length)),
  ];

  const summary = {
    requested: cap,
    productsSelected: products.length,
    priorityProductsSelected: priorityProducts.length,
    scanned: 0,
    skipped: 0,
    deferred: 0,
    offersMatched: 0,
    pendingQueued: 0,
    pendingCreated: 0,
    pendingUpdated: 0,
    pendingCapSkipped: 0,
    offersCreated: 0,
    offersUpdated: 0,
    rejected: {
      existingListing: 0,
      condition: 0,
      prefilter: 0,
      exactDetailMissing: 0,
      exactIdentity: 0,
      reasons: {},
    },
    failures: [],
  };

  for (let index = 0; index < products.length; index++) {
    const product = products[index];

    try {
      const result = await scanEbayCompetitorsForProduct(product, { priority });
      if (result.skipped) {
        summary.skipped++;
        acknowledgeBackgroundPriorityProduct(product.id);
        continue;
      }

      summary.scanned++;
      acknowledgeBackgroundPriorityProduct(product.id);
      summary.offersMatched += Number(result.matched || 0);
      summary.pendingQueued += Number(result.pendingQueued || 0);
      summary.pendingCreated += Number(result.pendingCreated || 0);
      summary.pendingUpdated += Number(result.pendingUpdated || 0);
      summary.pendingCapSkipped += Number(result.pendingCapSkipped || 0);
      summary.offersCreated += Number(result.offersCreated || 0);
      summary.offersUpdated += Number(result.offersUpdated || 0);

      if (result.rejected) {
        summary.rejected.existingListing += Number(result.rejected.existingListing || 0);
        summary.rejected.condition += Number(result.rejected.condition || 0);
        summary.rejected.prefilter += Number(result.rejected.prefilter || 0);
        summary.rejected.exactDetailMissing += Number(result.rejected.exactDetailMissing || 0);
        summary.rejected.exactIdentity += Number(result.rejected.exactIdentity || 0);
        for (const [reason, count] of Object.entries(result.rejected.reasons || {})) {
          summary.rejected.reasons[reason] =
            Number(summary.rejected.reasons[reason] || 0) + Number(count || 0);
        }
      }
    } catch (error) {
      if (isEbayRateGuardError(error)) {
        summary.deferred += products.length - index;
        summary.rateGuard = getEbayRateGuardStatus();

        opLog(
          "ebay-competitors",
          `rate guard deferred ${products.length - index} remaining competitor scan(s)`,
          {
            scanned: summary.scanned,
            browseRemaining:
              summary.rateGuard?.browse?.backgroundRemaining ?? null,
          }
        );
        break;
      }

      acknowledgeBackgroundPriorityProduct(product.id);
      summary.failures.push({
        productId: product.id,
        title: product.title,
        error: String(error?.message || error).slice(0, 500),
      });
    }
  }

  summary.backgroundPriorityPending = backgroundPriorityProductIds.length;
  return summary;
}

export const __ebayCompetitorScannerTest = {
  competitorDiscoveryPlans,
  competitorRecallPlans,
  discoveryMethodMeta,
  mergeCandidateDiscovery,
  normalizeRecallQuery,
  prefilterCompetitorCandidates,
  selectExactProofCandidates,
  fetchExactCandidateDetails,
  exactProofMatches,
  verifiedSellerCount,
  verifiedListingCount,
};
