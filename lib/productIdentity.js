import crypto from "crypto";

const STOP = new Set([
  "the","a","an","for","with","and","or","new","brand","genuine","original",
  "free","shipping","fast","sale","premium","quality","official","authentic",
]);

const TYPE_TERMS = new Set([
  "filament","filter","pump","heater","light","lighting","wavemaker","regulator",
  "diffuser","scanner","tester","multimeter","wrench","bleeder","drill","driver",
  "grinder","saw","nozzle","hotend","extruder","enclosure","plate","dryer",
  "keyboard","mouse","dock","microphone","webcam","hub","router","adapter",
  "charger","cable","battery","powerbank","station","generator","panel","inverter",
  "ssd","memory","ram","headset","speaker","camera","printer","cartridge",
  "sensor","transducer","holder","badge","lanyard","bag","lunchbox","pants",
  "trousers","monitor","arm","controller","thermometer","skimmer","sterilizer",
]);


const PLACEHOLDER_IDENTIFIERS = new Set([
  "na", "n/a", "none", "null", "unknown", "unspecified", "not specified",
  "does not apply", "doesnotapply", "not applicable", "notapplicable",
  "not apply", "notapply", "no mpn", "nompn", "no upc", "noupc",
  "no gtin", "nogtin", "unavailable", "pending", "tbd", "-", "--",
]);

function identifierWords(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function identifierCompact(value) {
  return identifierWords(value).replace(/[^a-z0-9]/g, "");
}

export function isPlaceholderIdentifier(value) {
  const words = identifierWords(value);
  const compact = identifierCompact(value);
  if (!words) return true;
  if (PLACEHOLDER_IDENTIFIERS.has(words) || PLACEHOLDER_IDENTIFIERS.has(compact)) return true;
  return /^(?:n\/?a|none|null|unknown|unspecified|not(?:applicable|specified|apply)|doesnotapply|unavailable|pending|tbd)$/.test(compact);
}

function validGtinChecksum(value) {
  if (!/^\d+$/.test(value) || ![8, 12, 13, 14].includes(value.length)) return false;
  const body = value.slice(0, -1);
  const expected = Number(value.at(-1));
  let sum = 0;
  let weight = 3;
  for (let index = body.length - 1; index >= 0; index--) {
    sum += Number(body[index]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === expected;
}

export function canonicalStrongGtin(value) {
  const raw = String(value || "").normalize("NFKC").trim();
  if (!raw || isPlaceholderIdentifier(raw)) return "";

  // First accept one normally formatted identifier (spaces/hyphens are common
  // display formatting). Do not collapse comma/slash separated identifier lists
  // into one fake GTIN.
  const compactSingle = raw.replace(/[\s-]+/g, "");
  if (/^\d+$/.test(compactSingle) && validGtinChecksum(compactSingle)) {
    return compactSingle.padStart(14, "0");
  }

  const candidates = raw
    .split(/[;,|/]+/)
    .map(part => part.replace(/[\s-]+/g, ""))
    .filter(part => /^\d+$/.test(part) && validGtinChecksum(part))
    .map(part => part.padStart(14, "0"));
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : "";
}

export function canonicalStrongBrand(value) {
  if (isPlaceholderIdentifier(value)) return "";
  const brand = identifierCompact(value);
  if (!brand || brand.length < 2) return "";
  if (["generic", "unbranded", "brandless", "branded", "other"].includes(brand)) return "";
  return brand;
}

export function canonicalStrongMpn(value) {
  if (isPlaceholderIdentifier(value)) return "";
  const raw = String(value || "").normalize("NFKC").trim();
  const mpn = identifierCompact(raw);
  if (!mpn || mpn.length < 2 || mpn.length > 64 || /^0+$/.test(mpn)) return "";
  if (["generic", "unbranded", "notset", "notlisted"].includes(mpn)) return "";

  // Marketplace item-specific fields are sometimes populated with category
  // descriptions or option lists instead of a manufacturer part number. Keep
  // those strings as raw observations, but do not let them own products.
  if (/[,;|]/.test(raw)) return "";
  if ((raw.match(/\//g) || []).length > 2) return "";
  const words = identifierWords(raw).split(" ").filter(Boolean);
  if (words.length > 4) return "";

  // A strong MPN should look like a manufacturer code, not natural-language
  // product metadata. Multi-token values with no digits are much more likely
  // to be category/model-family descriptions (for example "Power circuit
  // tester tool" or "Aquarium_Filter") than durable part numbers. Prefer
  // a false negative here: listing-scoped ownership is safe, while a false
  // positive can collapse unrelated products into one canonical record.
  if (!/\d/.test(mpn)) {
    if (words.length >= 2) return "";
    if (words.length === 1 && (TYPE_TERMS.has(words[0]) || FAMILY_TERMS.has(words[0]) || STOP.has(words[0]))) {
      return "";
    }
  }

  return mpn;
}

export function canonicalStrongEpid(value) {
  if (isPlaceholderIdentifier(value)) return "";
  const cleaned = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^EPID[\s:-]*/i, "")
    .replace(/\s+/g, "");
  return /^\d{5,20}$/.test(cleaned) ? cleaned : "";
}

function storageText(value, maxLength) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

// Product-level identity fields are trusted metadata, not a dumping ground for
// raw marketplace item specifics. Keep human-friendly formatting for brand/MPN
// when the value is trustworthy, canonicalize GTIN/ePID, and return rejected
// raw values separately so callers can retain an audit breadcrumb without
// allowing the rejected value to influence ownership or exact-match proof.
export function sanitizeIdentityForStorage(identity = {}) {
  const rawBrand = storageText(identity.brand, 200);
  const rawGtin = storageText(identity.gtin, 200);
  const rawMpn = storageText(identity.mpn, 240);
  const rawEpid = storageText(identity.epid, 120);

  const brand = rawBrand && !isPlaceholderIdentifier(rawBrand) ? rawBrand : "";
  const gtin = canonicalStrongGtin(rawGtin);
  const mpn = canonicalStrongMpn(rawMpn) ? rawMpn.slice(0, 160) : "";
  const epid = canonicalStrongEpid(rawEpid);

  return {
    brand,
    gtin,
    mpn,
    epid,
    rejected: {
      brand: rawBrand && !brand ? rawBrand : "",
      gtin: rawGtin && !gtin ? rawGtin : "",
      mpn: rawMpn && !mpn ? rawMpn : "",
      epid: rawEpid && !epid ? rawEpid : "",
    },
  };
}

const FAMILY_TERMS = new Set([
  "petg","pla","abs","tpu","asa","resin","pei","nvme","ssd","m2","obd2","tpms",
  "lifepo4","gan","usb","usbc","thunderbolt","wifi","ethernet","mechanical",
  "brushless","cordless","solar","aquarium","planted","co2","rgb","pd","pps",
]);

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[×]/g, "x")
    .replace(/[″”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9.+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

export function identityTokens(value) {
  return normalize(value)
    .split(" ")
    .filter(Boolean)
    .filter(token => !STOP.has(token));
}

function modelTokens(value) {
  return uniq(
    identityTokens(value)
      .map(token => token.replace(/[^a-z0-9]/g, ""))
      .filter(token => token.length >= 3)
      .filter(token => /[a-z]/.test(token) && /\d/.test(token))
      .filter(token =>
        !/^\d+(?:\.\d+)?(?:mah|wh|ah|kw|w|v|a|tb|gb|mb|mm|cm|in|inch|g|kg|lb|oz|ml|l)$/.test(token)
      )
      .filter(token => !["3d","4k","8k","2k","5g","4g","6e","v2","v3","gen2","gen3","gen4","gen5"].includes(token))
  ).sort();
}

function capture(text, regex, normalizeUnit = unit => unit) {
  const out = [];
  for (const match of normalize(text).matchAll(regex)) {
    const amount = Number(match[1]);
    const unit = normalizeUnit(String(match[2] || "").toLowerCase());
    if (!Number.isFinite(amount) || !unit) continue;
    out.push(`${amount}:${unit}`);
  }
  return uniq(out).sort();
}

function packCounts(text) {
  const normalized = normalize(text);
  const values = [];
  for (const match of normalized.matchAll(/\b(\d{1,4})\s*[- ]?(?:pack|pk|count|ct|piece|pc|pcs|spool|spools)\b/gi)) {
    values.push(String(Number(match[1])));
  }
  for (const match of normalized.matchAll(/\b(?:pack|set|lot|bundle|combo)\s+of\s+(\d{1,4})\b/gi)) {
    values.push(String(Number(match[1])));
  }
  return uniq(values).sort();
}

function durationSpecs(text) {
  const normalized = normalize(text);
  const values = [];
  const regex = /\b(\d+(?:\.\d+)?)\s*[- ]?(year|years|yr|yrs|month|months|mo|mos)\b/gi;

  for (const match of normalized.matchAll(regex)) {
    const index = Number(match.index || 0);
    const context = normalized.slice(Math.max(0, index - 28), index + match[0].length + 28);

    // Warranty language is not a package/consumable variant. Avoid splitting
    // an otherwise identical product merely because one seller advertises the warranty.
    if (/\b(warranty|guarantee|coverage|limited warranty)\b/.test(context)) continue;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = String(match[2] || "").toLowerCase();
    const months = unit.startsWith("y") ? Math.round(amount * 12) : Math.round(amount);
    if (months > 0) values.push(`${months}:month`);
  }

  return uniq(values).sort();
}

function kitState(text) {
  const n = normalize(text);
  const bare = /\b(bare tool|tool only|body only)\b/.test(n);
  const kit = /\b(kit|combo kit|starter kit|combo set|bundle set|filter set)\b/.test(n);
  if (bare && !kit) return "bare";
  if (kit && !bare) return "kit";
  return "";
}

export function extractVariantFacts(title) {
  const tokens = identityTokens(title);
  return {
    models: modelTokens(title),
    types: uniq(tokens.filter(token => TYPE_TERMS.has(token))).sort(),
    family: uniq(tokens.filter(token => FAMILY_TERMS.has(token))).sort(),
    capacities: capture(
      title,
      /\b(\d+(?:\.\d+)?)\s*(tb|gb|mb|mah|ah|wh|g|kg|lb|oz|ml|l)\b/gi
    ),
    power: capture(
      title,
      /\b(\d+(?:\.\d+)?)\s*(kw|w|watt|watts)\b/gi,
      unit => unit === "kw" ? "kw" : "w"
    ),
    electrical: capture(
      title,
      /\b(\d+(?:\.\d+)?)\s*(v|volt|volts|a|amp|amps)\b/gi,
      unit => unit.startsWith("v") ? "v" : "a"
    ),
    sizes: capture(
      title,
      /\b(\d+(?:\.\d+)?)\s*(mm|cm|inch|inches|in)\b/gi,
      unit => ["in","inches"].includes(unit) ? "inch" : unit
    ),
    packs: packCounts(title),
    durations: durationSpecs(title),
    kit: kitState(title),
  };
}

function arraysConflict(a, b) {
  if (!a.length || !b.length) return false;
  return a.join("|") !== b.join("|");
}

function jaccard(a, b) {
  const aa = new Set(a);
  const bb = new Set(b);
  if (!aa.size || !bb.size) return 0;
  let overlap = 0;
  for (const item of aa) if (bb.has(item)) overlap++;
  return overlap / (aa.size + bb.size - overlap);
}

function stableHash(value, length = 24) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

export function variantIdentityDiscriminator(title) {
  const facts = extractVariantFacts(title);

  // Only package/bundle facts are allowed to change a strong GTIN/MPN
  // canonical key. This deliberately avoids title wording, color, marketing
  // adjectives, or generic semantic tokens fragmenting a real product.
  const hard = {
    packs: facts.packs,
    durations: facts.durations,
    kit: facts.kit,
  };

  if (!hard.packs.length && !hard.durations.length && !hard.kit) return "";
  return stableHash(JSON.stringify(hard), 16);
}

export function strongIdentityBaseKey(candidate = {}) {
  const gtin = canonicalStrongGtin(candidate.gtin);
  if (gtin) return `gtin:${gtin}`;

  const brand = canonicalStrongBrand(candidate.brand);
  const mpn = canonicalStrongMpn(candidate.mpn);
  if (brand && mpn) return `mpn:${brand}:${mpn}`;

  return "";
}

export function strongVariantOwnershipConflict(owner = {}, candidate = {}) {
  const ownerStrong = strongIdentityBaseKey(owner);
  const candidateStrong = strongIdentityBaseKey(candidate);
  if (!ownerStrong || ownerStrong !== candidateStrong) return false;

  const ownerFacts = extractVariantFacts(owner.title || owner.listingTitle || "");
  const candidateFacts = extractVariantFacts(candidate.title || candidate.listingTitle || "");

  // V3.7.21: explicit quantitative package facts are authoritative in the
  // incoming direction. A 2-year or 6-pack candidate must not be absorbed by
  // a same-MPN owner whose title omits that fact. The rule is intentionally
  // asymmetric: an unlabeled candidate cannot destabilize an already-explicit
  // owner just because both happen to say "combo" or "kit".
  if (candidateFacts.durations.length) {
    if (candidateFacts.durations.join("|") !== ownerFacts.durations.join("|")) return true;
  }
  if (candidateFacts.packs.length) {
    if (candidateFacts.packs.join("|") !== ownerFacts.packs.join("|")) return true;
  }

  // Bare-vs-kit is also an explicit sellable-state conflict when both sides
  // actually state a side, or when the candidate explicitly says bare/tool-only.
  if (candidateFacts.kit && ownerFacts.kit && candidateFacts.kit !== ownerFacts.kit) return true;
  if (candidateFacts.kit === "bare" && !ownerFacts.kit) return true;

  return false;
}

export function variantCompatibility(aTitle, bTitle) {
  const a = extractVariantFacts(aTitle);
  const b = extractVariantFacts(bTitle);
  const reasons = [];

  if (a.models.length || b.models.length) {
    if (!a.models.length || !b.models.length || arraysConflict(a.models, b.models)) {
      reasons.push("model");
    }
  }

  for (const [key, label] of [
    ["capacities", "capacity-or-weight"],
    ["power", "power"],
    ["electrical", "electrical"],
    ["sizes", "size"],
    ["packs", "pack-count"],
    ["durations", "duration"],
  ]) {
    if (arraysConflict(a[key], b[key])) reasons.push(label);
  }

  if (a.kit && b.kit && a.kit !== b.kit) reasons.push("kit-vs-bare");

  if (a.types.length && b.types.length && !a.types.some(type => b.types.includes(type))) {
    reasons.push("product-type");
  }
  if (a.family.length && b.family.length && !a.family.some(term => b.family.includes(term))) {
    reasons.push("product-family");
  }

  return { ok: reasons.length === 0, reasons, a, b };
}

export function safeSameVariant(aTitle, bTitle, { brandA = "", brandB = "" } = {}) {
  const a = normalize(aTitle);
  const b = normalize(bTitle);
  if (!a || !b) return false;

  const ba = normalize(brandA);
  const bb = normalize(brandB);
  if (ba && bb && ba !== bb) return false;

  const compatibility = variantCompatibility(a, b);
  if (!compatibility.ok) return false;

  const facts = compatibility.a;
  const evidence =
    facts.models.length +
    facts.capacities.length +
    facts.power.length +
    facts.sizes.length +
    facts.packs.length +
    facts.durations.length +
    facts.types.length +
    facts.family.length;

  if (evidence < 2) return false;

  const score = jaccard(identityTokens(a), identityTokens(b));
  if (facts.models.length) return score >= 0.55;
  return score >= 0.72;
}

export function candidateCanonicalKey(candidate = {}) {
  const strong = strongIdentityBaseKey(candidate);
  if (strong) {
    const variant = variantIdentityDiscriminator(candidate.title || candidate.listingTitle || "");
    return variant ? `${strong}:variant:${variant}` : strong;
  }

  const provider = normalize(candidate.provider || "unknown");
  const externalId = String(
    candidate.externalId ||
    candidate.sourceUrl ||
    candidate.affiliateUrl ||
    candidate.title ||
    ""
  );
  return `listing:${provider}:${stableHash(externalId)}`;
}

export function coarseVariantBucket(title, brand = "") {
  const facts = extractVariantFacts(title);
  const key = JSON.stringify({
    brand: normalize(brand),
    types: facts.types,
    family: facts.family,
    models: facts.models,
    capacities: facts.capacities,
    power: facts.power,
    sizes: facts.sizes,
    packs: facts.packs,
    durations: facts.durations,
    kit: facts.kit,
  });
  return stableHash(key, 20);
}
