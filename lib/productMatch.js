import {
  canonicalStrongBrand,
  canonicalStrongEpid,
  canonicalStrongGtin,
  canonicalStrongMpn,
  isPlaceholderIdentifier,
} from "./productIdentity.js";

const IGNORE = new Set([
  "the", "a", "an", "and", "or", "for", "with", "to", "of", "in", "on",
  "new", "brand", "genuine", "original", "fast", "free", "shipping", "sale",
  "black", "white", "blue", "red", "gray", "grey", "silver", "gold",
]);

const GENERIC_ALPHA_NUMERIC = new Set([
  "3d", "4k", "8k", "2k", "5g", "4g", "6e", "usb2", "usb3", "wifi6",
  "wifi7", "gen2", "gen3", "gen4", "gen5", "v2", "v3",
]);

const ACCESSORY_MARKERS = [
  "case for", "cover for", "replacement for", "compatible with",
  "screen protector", "protective case", "carrying case", "mount for",
  "stand for", "adapter for", "cable for", "charger for", "battery for",
  "parts only", "replacement part", "repair part",
];

const GENERIC_FAMILY_WORDS = new Set([
  "portable", "digital", "professional", "wireless", "cordless", "electric",
  "electronic", "smart", "heavy", "duty", "high", "speed", "premium", "mini",
  "large", "small", "compact", "universal", "replacement", "compatible",
  "printer", "printing", "tool", "tools", "device", "system", "unit",
  "bundle", "combo", "colors", "color", "pack", "set", "kit",
]);

// Product-type nouns that are useful as a semantic safety gate. This is not
// used to decide what a product is; it only prevents clearly unrelated items
// from being attached to one another.
const TYPE_TERMS = new Set([
  "filament", "transducer", "sensor", "holder", "badge", "lanyard", "bag",
  "lunchbox", "pants", "trousers", "charger", "cable", "adapter", "battery",
  "powerbank", "bank", "station", "generator", "panel", "inverter", "filter",
  "pump", "heater", "light", "lighting", "wavemaker", "regulator", "diffuser",
  "scanner", "tester", "multimeter", "wrench", "bleeder", "drill", "driver",
  "grinder", "saw", "nozzle", "hotend", "extruder", "enclosure", "plate",
  "dryer", "keyboard", "mouse", "dock", "microphone", "webcam", "hub",
  "switch", "router", "enclosure", "cooler", "cooling", "arm", "monitor",
  "ssd", "memory", "ram", "headset", "speaker", "camera", "printer",
  "cartridge", "media", "skimmer", "sterilizer", "thermometer", "controller",
]);

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[×]/g, "x")
    .replace(/[″”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function compact(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, "");
}

export function tokens(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9.]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => !IGNORE.has(token))
    .filter(token => token.length > 1);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function specLikeToken(token) {
  return /^\d+(?:\.\d+)?(?:mah|wh|ah|kw|w|v|a|tb|gb|mb|mm|cm|in|inch|g|kg|lb|oz|ml|l)$/.test(token);
}

function modelTokens(value) {
  return unique(
    tokens(value)
      .map(token => token.replace(/[^a-z0-9]/g, ""))
      .filter(token => token.length >= 3)
      .filter(token => /[a-z]/.test(token) && /\d/.test(token))
      .filter(token => !specLikeToken(token))
      .filter(token => !GENERIC_ALPHA_NUMERIC.has(token))
  );
}

function alphaFamilyTokens(value, brand = "") {
  const brandToken = compact(brand);
  return unique(
    tokens(value)
      .map(token => token.replace(/[^a-z]/g, ""))
      .filter(token => token.length >= 3)
      .filter(token => !GENERIC_FAMILY_WORDS.has(token))
      .filter(token => !brandToken || compact(token) !== brandToken)
  );
}

function typeTerms(value) {
  return unique(
    tokens(value)
      .map(token => token.replace(/[^a-z]/g, ""))
      .filter(token => TYPE_TERMS.has(token))
  );
}

function captureUnits(text, regex, unitNormalizer = unit => unit) {
  const out = [];
  for (const match of normalizeText(text).matchAll(regex)) {
    const amount = Number(match[1]);
    const unit = unitNormalizer(String(match[2] || "").toLowerCase());
    if (!Number.isFinite(amount) || !unit) continue;
    out.push(`${amount}:${unit}`);
  }
  return unique(out).sort();
}

function capacitySpecs(text) {
  return captureUnits(
    text,
    /\b(\d+(?:\.\d+)?)\s*(tb|gb|mb|mah|ah|wh|g|kg|lb|oz|ml|l)\b/gi,
    unit => unit
  );
}

function powerSpecs(text) {
  return captureUnits(
    text,
    /\b(\d+(?:\.\d+)?)\s*(kw|w|watt|watts)\b/gi,
    unit => unit === "kw" ? "kw" : "w"
  );
}

function electricalSpecs(text) {
  return captureUnits(
    text,
    /\b(\d+(?:\.\d+)?)\s*(v|volt|volts|a|amp|amps)\b/gi,
    unit => {
      if (unit.startsWith("v")) return "v";
      if (unit.startsWith("a")) return "a";
      return unit;
    }
  );
}

function sizeSpecs(text) {
  return captureUnits(
    text,
    /\b(\d+(?:\.\d+)?)\s*(mm|cm|inch|inches|in)\b/gi,
    unit => unit === "inches" || unit === "in" ? "inch" : unit
  );
}

function packCounts(text) {
  const normalized = normalizeText(text);
  const values = [];

  for (const match of normalized.matchAll(/\b(\d{1,4})\s*[- ]?(?:pack|pk|count|ct|piece|pc|pcs|spool|spools)\b/gi)) {
    values.push(Number(match[1]));
  }
  for (const match of normalized.matchAll(/\b(?:pack|set|lot|bundle|combo)\s+of\s+(\d{1,4})\b/gi)) {
    values.push(Number(match[1]));
  }
  for (const match of normalized.matchAll(/\b(\d{1,3})\s*x\b/gi)) {
    values.push(Number(match[1]));
  }

  return unique(values.map(String)).sort();
}

function durationSpecs(text) {
  const normalized = normalizeText(text);
  const values = [];
  const regex = /\b(\d+(?:\.\d+)?)\s*[- ]?(year|years|yr|yrs|month|months|mo|mos)\b/gi;

  for (const match of normalized.matchAll(regex)) {
    const index = Number(match.index || 0);
    const context = normalized.slice(Math.max(0, index - 28), index + match[0].length + 28);
    if (/\b(warranty|guarantee|coverage|limited warranty)\b/.test(context)) continue;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = String(match[2] || "").toLowerCase();
    const months = unit.startsWith("y") ? Math.round(amount * 12) : Math.round(amount);
    if (months > 0) values.push(`${months}:month`);
  }

  return unique(values).sort();
}

function kitState(text) {
  const normalized = normalizeText(text);
  const bare = /\b(bare tool|tool only|body only)\b/.test(normalized);
  const kit = /\b(kit|combo kit|starter kit)\b/.test(normalized);
  if (bare && !kit) return "bare";
  if (kit && !bare) return "kit";
  return "";
}

function accessoryState(text) {
  const normalized = normalizeText(text);
  return ACCESSORY_MARKERS.some(marker => normalized.includes(marker));
}

function setConflict(reference, candidate) {
  if (!reference.length || !candidate.length) return false;
  return !reference.some(value => candidate.includes(value));
}

function requiresSame(reference, candidate) {
  if (!reference.length) return true;
  if (!candidate.length) return false;
  return reference.every(value => candidate.includes(value));
}

function diceScore(referenceTitle, candidateTitle) {
  const a = new Set(tokens(referenceTitle));
  const b = new Set(tokens(candidateTitle));
  if (!a.size || !b.size) return 0;

  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap++;
  }
  return (2 * overlap) / (a.size + b.size);
}

function variantConflictReasons(referenceTitle, candidateTitle, {
  allowMissingCandidateSpecs = false,
} = {}) {
  const reasons = [];
  const refCapacity = capacitySpecs(referenceTitle);
  const candCapacity = capacitySpecs(candidateTitle);
  if (
    setConflict(refCapacity, candCapacity) ||
    (!allowMissingCandidateSpecs && !requiresSame(refCapacity, candCapacity))
  ) {
    reasons.push("capacity-or-weight-conflict");
  }

  const refPower = powerSpecs(referenceTitle);
  const candPower = powerSpecs(candidateTitle);
  if (
    setConflict(refPower, candPower) ||
    (!allowMissingCandidateSpecs && !requiresSame(refPower, candPower))
  ) {
    reasons.push("power-conflict");
  }

  const refElectrical = electricalSpecs(referenceTitle);
  const candElectrical = electricalSpecs(candidateTitle);
  if (setConflict(refElectrical, candElectrical)) {
    reasons.push("electrical-spec-conflict");
  }

  const refSize = sizeSpecs(referenceTitle);
  const candSize = sizeSpecs(candidateTitle);
  if (setConflict(refSize, candSize)) {
    reasons.push("size-conflict");
  }

  const refPack = packCounts(referenceTitle);
  const candPack = packCounts(candidateTitle);
  if (setConflict(refPack, candPack)) {
    reasons.push("pack-count-conflict");
  }

  const refDuration = durationSpecs(referenceTitle);
  const candDuration = durationSpecs(candidateTitle);
  if (setConflict(refDuration, candDuration)) {
    reasons.push("duration-conflict");
  }

  const refKit = kitState(referenceTitle);
  const candKit = kitState(candidateTitle);
  if (refKit && candKit && refKit !== candKit) {
    reasons.push("kit-vs-bare-conflict");
  }

  if (!accessoryState(referenceTitle) && accessoryState(candidateTitle)) {
    reasons.push("candidate-looks-like-accessory");
  }

  return reasons;
}

export function familyCompatibility(referenceTitle, candidateTitle, {
  brand = "",
  allowMissingCandidateSpecs = false,
} = {}) {
  const reasons = [];
  const refModels = modelTokens(referenceTitle);
  const candCompact = compact(candidateTitle);
  const matchedModels = refModels.filter(model => candCompact.includes(model));

  const refTypes = typeTerms(referenceTitle);
  const candTypes = typeTerms(candidateTitle);
  const sharedTypes = refTypes.filter(term => candTypes.includes(term));

  const refFamily = alphaFamilyTokens(referenceTitle, brand);
  const candFamily = alphaFamilyTokens(candidateTitle, brand);
  const sharedFamily = refFamily.filter(term => candFamily.includes(term));

  if (refTypes.length && !sharedTypes.length) {
    reasons.push("product-type-conflict");
  }

  if (refModels.length) {
    if (!matchedModels.length && !sharedTypes.length) {
      reasons.push("model-and-family-mismatch");
    }
  } else {
    // Generic products such as filament, cables, filters, etc. need explicit
    // semantic family overlap. This is what prevents a PETG filament search
    // from ever accepting pants, lunch bags, badge holders, or transducers.
    const overlapRatio = refFamily.length
      ? sharedFamily.length / refFamily.length
      : 0;

    if (!sharedTypes.length && sharedFamily.length < 2 && overlapRatio < 0.40) {
      reasons.push("insufficient-product-family-overlap");
    }
  }

  reasons.push(...variantConflictReasons(referenceTitle, candidateTitle, {
    allowMissingCandidateSpecs,
  }));

  return {
    ok: reasons.length === 0,
    reasons: unique(reasons),
    details: {
      referenceTypes: refTypes,
      candidateTypes: candTypes,
      sharedTypes,
      referenceFamily: refFamily,
      candidateFamily: candFamily,
      sharedFamily,
      referenceModels: refModels,
      matchedModels,
    },
  };
}

export function strictTitleMatch(referenceTitle, candidateTitle, {
  brand = "",
  minScore = 0.90,
} = {}) {
  const reasons = [];
  const reference = normalizeText(referenceTitle);
  const candidate = normalizeText(candidateTitle);

  if (!reference || !candidate) {
    return { ok: false, score: 0, reasons: ["missing-title"] };
  }

  const brandCompact = compact(brand);
  if (brandCompact && !compact(candidate).includes(brandCompact)) {
    reasons.push("brand-missing-or-conflicting");
  }

  const refModels = modelTokens(reference);
  const candidateCompact = compact(candidate);
  const matchedModels = refModels.filter(model => candidateCompact.includes(model));

  if (!refModels.length) {
    reasons.push("no-specific-model-token");
  } else if (!matchedModels.length) {
    reasons.push("model-conflict");
  }

  const family = familyCompatibility(reference, candidate, { brand });
  reasons.push(...family.reasons);

  const dice = diceScore(reference, candidate);
  const modelCoverage = refModels.length
    ? matchedModels.length / refModels.length
    : 0;
  const score = Math.min(1, dice * 0.72 + modelCoverage * 0.28);

  if (score < minScore) {
    reasons.push("low-title-confidence");
  }

  return {
    ok: unique(reasons).length === 0,
    score,
    reasons: unique(reasons),
    details: {
      ...family.details,
      referenceModels: refModels,
      matchedModels,
    },
  };
}

export function brandMpnMatch(product, candidateTitle) {
  const title = compact(candidateTitle);
  const brand = compact(product?.brand);
  const mpn = compact(product?.mpn);

  if (!mpn || !title.includes(mpn)) return false;
  if (brand && !title.includes(brand)) return false;
  return true;
}

export function verifiedIdentifierMatch(product, candidateTitle) {
  const family = familyCompatibility(product?.title, candidateTitle, {
    brand: product?.brand || "",
  });

  if (!family.ok) {
    return {
      ok: false,
      score: 0,
      reasons: family.reasons,
      details: family.details,
    };
  }

  const similarity = diceScore(product?.title, candidateTitle);
  return {
    ok: true,
    score: Math.max(0.70, Math.min(1, similarity)),
    reasons: [],
    details: family.details,
  };
}


function canonicalGtin(value) {
  return canonicalStrongGtin(value);
}

function exactIdentifier(value) {
  if (isPlaceholderIdentifier(value)) return "";
  return compact(value);
}

function exactSetEqual(a, b) {
  const aa = unique((a || []).map(String)).sort();
  const bb = unique((b || []).map(String)).sort();
  return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
}

function exactVariantProof(referenceTitle, candidateTitle) {
  const reasons = [];
  const reference = normalizeText(referenceTitle);
  const candidate = normalizeText(candidateTitle);

  if (!reference || !candidate) {
    return { ok: false, reasons: ["missing-exact-title"] };
  }

  // V3.7.39 evidence-weighted rule: omission is not contradiction. eBay seller
  // titles often leave out voltage, wattage, pack size, or a secondary model
  // alias even when the listing's strong product identifier is exact. We still
  // reject explicit contradictions, accessories, wrong bundles, and wrong
  // variants; we simply stop treating a missing title token as a conflict.
  if (!accessoryState(reference) && accessoryState(candidate)) {
    reasons.push("accessory-state-conflict");
  }

  const refModels = modelTokens(reference);
  const candModels = modelTokens(candidate);
  if (
    refModels.length &&
    candModels.length &&
    !refModels.some(model => candModels.includes(model))
  ) {
    reasons.push("exact-model-conflict");
  }

  for (const [label, getValues] of [
    ["capacity-or-weight", capacitySpecs],
    ["power", powerSpecs],
    ["electrical", electricalSpecs],
    ["size", sizeSpecs],
    ["pack-count", packCounts],
    ["duration", durationSpecs],
  ]) {
    const a = getValues(reference);
    const b = getValues(candidate);
    if (setConflict(a, b)) {
      reasons.push(`exact-${label}-conflict`);
    }
  }

  const refKit = kitState(reference);
  const candKit = kitState(candidate);
  if (refKit && candKit && refKit !== candKit) {
    reasons.push("exact-kit-state-conflict");
  }

  const family = familyCompatibility(reference, candidate, {
    allowMissingCandidateSpecs: true,
  });
  for (const reason of family.reasons) {
    if (reason === "model-and-family-mismatch" || reason === "insufficient-product-family-overlap") {
      continue;
    }
    if (reason === "product-type-conflict" && !family.details.candidateTypes.length) {
      continue;
    }
    reasons.push(reason);
  }

  return {
    ok: unique(reasons).length === 0,
    reasons: unique(reasons),
    details: {
      referenceModels: refModels,
      candidateModels: candModels,
      family: family.details,
    },
  };
}

export function exactCompetitorProof(reference = {}, candidate = {}) {
  const reasons = [];
  const refTitle = String(reference.title || reference.listingTitle || "");
  const candTitle = String(candidate.title || candidate.listingTitle || "");

  const refGtin = canonicalGtin(reference.gtin);
  const candGtin = canonicalGtin(candidate.gtin);
  const refBrand = canonicalStrongBrand(reference.brand);
  const candBrand = canonicalStrongBrand(candidate.brand);
  const refMpn = canonicalStrongMpn(reference.mpn);
  const candMpn = canonicalStrongMpn(candidate.mpn);
  const refEpid = canonicalStrongEpid(reference.epid);
  const candEpid = canonicalStrongEpid(candidate.epid);

  // Explicit contradictions are always fatal. V3.7.39 relaxes missing
  // corroborating metadata, never conflicting metadata.
  if (refGtin && candGtin && refGtin !== candGtin) reasons.push("gtin-conflict");
  if (refBrand && candBrand && refBrand !== candBrand) reasons.push("brand-conflict");
  if (refMpn && candMpn && refMpn !== candMpn) reasons.push("mpn-conflict");
  if (refEpid && candEpid && refEpid !== candEpid) reasons.push("epid-conflict");

  let proofType = "";
  if (!reasons.length && refGtin && candGtin === refGtin) {
    proofType = "gtin";
  } else if (
    !reasons.length &&
    refBrand && refMpn &&
    candBrand === refBrand && candMpn === refMpn
  ) {
    // If the listing omitted GTIN but supplied the exact Brand+MPN pair, use
    // that independent proof path instead of rejecting it merely because the
    // canonical product happens to know a GTIN too.
    proofType = "brand-mpn";
  } else if (
    !reasons.length &&
    refEpid && refBrand &&
    candEpid === refEpid && candBrand === refBrand
  ) {
    proofType = "epid-brand";
  }

  if (!proofType) {
    if (refGtin && !candGtin) reasons.push("candidate-gtin-missing");
    if (refBrand && refMpn) {
      if (!candBrand) reasons.push("candidate-brand-missing");
      if (!candMpn) reasons.push("candidate-mpn-missing");
    } else if (refEpid && refBrand) {
      if (!candEpid) reasons.push("candidate-epid-missing");
      if (!candBrand) reasons.push("candidate-brand-missing");
    }
    if (!refGtin && !(refBrand && refMpn) && !(refEpid && refBrand)) {
      reasons.push("no-provable-reference-identity");
    }
  }

  const variant = exactVariantProof(refTitle, candTitle);
  reasons.push(...variant.reasons);
  const finalReasons = unique(reasons);

  return {
    ok: Boolean(proofType) && finalReasons.length === 0,
    proofType,
    confidence: Boolean(proofType) && finalReasons.length === 0 ? 100 : 0,
    reasons: finalReasons,
    details: {
      reference: {
        gtin: refGtin,
        brand: refBrand,
        mpn: refMpn,
        epid: refEpid,
      },
      candidate: {
        gtin: candGtin,
        brand: candBrand,
        mpn: candMpn,
        epid: candEpid,
      },
      variant: variant.details,
    },
  };
}

export function classifyStoredCompetitorOffer(product, offer, {
  minScore = 0.90,
} = {}) {
  const source = String(offer?.matchSource || "");
  if (!source.startsWith("ebay-competitor:")) {
    return { keep: true, reason: "not-competitor-generated" };
  }

  if (!offer.listingTitle) {
    return { keep: false, reason: "missing-exact-item-title" };
  }

  if (String(offer.priceSource || "") !== "ebay-item-detail" || !offer.priceVerifiedAt) {
    return { keep: false, reason: "competitor-not-exact-item-verified" };
  }

  const proof = exactCompetitorProof(
    {
      title: product?.title || offer.matchReferenceTitle || "",
      brand: product?.brand || offer.matchReferenceBrand || "",
      gtin: product?.gtin || offer.matchReferenceGtin || "",
      mpn: product?.mpn || offer.matchReferenceMpn || "",
      epid: product?.epid || offer.matchReferenceEpid || "",
    },
    offer
  );

  if (!proof.ok) {
    return {
      keep: false,
      reason: proof.reasons.join(",") || "v4-exact-proof-failed",
    };
  }

  const verificationVersion = Number(offer?.verificationVersion || 0);
  if (verificationVersion < 4) {
    return {
      keep: true,
      reason: `legacy-revalidated-v4-exact-${proof.proofType}`,
      upgrade: {
        verificationVersion: 4,
        matchProofVersion: 4,
        matchProofType: proof.proofType,
        matchSource: `ebay-competitor:v4-exact-${proof.proofType}`,
      },
    };
  }

  return {
    keep: true,
    reason: `v4-exact-${proof.proofType}`,
  };
}
