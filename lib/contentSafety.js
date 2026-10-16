const EXPLICIT_PATTERNS = [
  /\b(?:dildo|dildos|vibrator|vibrators|masturbator|masturbators|fleshlight|fleshlights)\b/i,
  /\bsex\s*(?:toy|toys|doll|dolls|swing|swings|machine|machines)\b/i,
  /\b(?:adult|erotic)\s*(?:toy|toys|novelty|novelties)\b/i,
  /\b(?:anal|butt)\s*(?:plug|plugs|bead|beads|toy|toys)\b/i,
  /\b(?:cock\s*ring|cock\s*rings|penis\s*(?:pump|pumps|sleeve|sleeves))\b/i,
  /\b(?:bondage|bdsm)\s*(?:gear|kit|kits|toy|toys|set|sets)?\b/i,
  /\b(?:porn|porno|pornography|hentai|xxx)\b/i,
];

const EXPLICIT_CATEGORY_PATTERNS = [
  /\badult\s*only\b/i,
  /\bsexual\s*wellness\b/i,
  /\berotic\b/i,
  /\bsex\s*toys?\b/i,
];

function combinedProductText(item = {}) {
  return [
    item.title,
    item.listingTitle,
    item.category,
    item.brand,
    item.editorNote,
    item.aiSummary,
  ].filter(Boolean).join(" ");
}

export function explicitContentReason(item = {}) {
  const text = combinedProductText(item);
  const category = String(item.category || "");

  for (const pattern of EXPLICIT_CATEGORY_PATTERNS) {
    if (pattern.test(category)) return "explicit-category";
  }
  for (const pattern of EXPLICIT_PATTERNS) {
    if (pattern.test(text)) return "explicit-product";
  }
  return "";
}

export function isExplicitProduct(item = {}) {
  return Boolean(explicitContentReason(item));
}

export function isExplicitSearchQuery(query = "") {
  const text = String(query || "");
  return EXPLICIT_PATTERNS.some(pattern => pattern.test(text)) ||
    EXPLICIT_CATEGORY_PATTERNS.some(pattern => pattern.test(text));
}

export function assertNonExplicitProduct(item = {}) {
  const reason = explicitContentReason(item);
  if (!reason) return;
  const error = new Error("Explicit products are not permitted in the OfferGrid catalog.");
  error.code = "EXPLICIT_PRODUCT_BLOCKED";
  error.status = 400;
  error.reason = reason;
  throw error;
}
