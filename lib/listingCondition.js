function conditionText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return [
    value.condition,
    value.conditionGroup,
    value.listingTitle,
    value.title,
  ]
    .filter(Boolean)
    .join(" ");
}

export function normalizeListingConditionText(value) {
  return String(conditionText(value) || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EXCLUDED_PATTERNS = [
  // Packaging-only marketplace listings are not the product being compared.
  // Keep them in the same opt-in exception lane as parts/broken inventory so
  // they cannot become a fake best price, Deal Heat input, or competitor.
  { reason: "box-only", re: /\b(?:empty\s+)?(?:original\s+|retail\s+)?box\s+only\b/i },
  { reason: "empty-box", re: /\bempty\s+(?:original\s+|retail\s+)?box\b/i },
  { reason: "packaging-only", re: /\b(?:original\s+|retail\s+)?packaging\s+only\b/i },
  { reason: "for-parts", re: /\bfor\s+parts(?:\s+or\s+(?:not\s+working|repair))?\b/i },
  { reason: "parts-only", re: /\bparts\s+only\b/i },
  { reason: "parts-repair", re: /\b(?:parts\s*(?:\/|or|&)\s*repair|spares\s*(?:\/|or|&)\s*repair)\b/i },
  { reason: "not-working", re: /\b(?:not\s+working|non[-\s]?working|does\s+not\s+work|doesn't\s+work)\b/i },
  { reason: "not-tested", re: /\b(?:not\s+tested|untested)\b/i },
  { reason: "no-power", re: /\b(?:does\s+not\s+power\s+on|doesn't\s+power\s+on|will\s+not\s+power\s+on|won't\s+power\s+on|no\s+power)\b/i },
  { reason: "broken", re: /\bbroken\b/i },
  { reason: "defective", re: /\b(?:defective|faulty|nonfunctional|non-functional)\b/i },
  { reason: "repair-only", re: /\b(?:repair\s+only|for\s+repair|needs?\s+repair)\b/i },
  { reason: "battery-fault", re: /\b(?:battery\s+(?:issue|fault|failure|dead)|bad\s+battery|battery\s+not\s+working)\b/i },
  { reason: "locked-device", re: /\b(?:icloud|activation|google|frp)\s+locked\b/i },
  { reason: "cracked-screen", re: /\b(?:cracked|shattered)\s+(?:lcd|oled|display|screen)\b/i },
];

export function listingConditionExclusionReason(value) {
  const group = String(value?.conditionGroup || "").trim().toLowerCase();
  if (group === "parts" || group === "broken" || group === "non-working") {
    return "condition-group-parts";
  }

  const text = normalizeListingConditionText(value);
  if (!text) return "";
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.re.test(text)) return pattern.reason;
  }
  return "";
}

export function isBrokenOrPartsListing(value) {
  return Boolean(listingConditionExclusionReason(value));
}

export function intelligenceEligibleListing(value) {
  return !isBrokenOrPartsListing(value);
}

export function normalizedConditionGroup(condition) {
  const value = normalizeListingConditionText(condition);
  if (!value) return "unknown";
  if (isBrokenOrPartsListing({ condition: value })) return "parts";
  if (value.includes("refurb")) return "refurbished";
  if (value.includes("used") || value.includes("pre-owned") || value.includes("preowned")) return "used";
  if (value.includes("new") || value.includes("open box")) return "new";
  return "unknown";
}

export const __listingConditionTest = {
  patterns: EXCLUDED_PATTERNS.map(item => item.reason),
};
