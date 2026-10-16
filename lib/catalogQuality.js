function normalized(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Fail narrowly: only correct combinations with strong, contradictory title
// evidence. The marketplace category remains authoritative in all other cases.
export function correctedProductCategory(category, title) {
  const current = String(category || "Other").trim() || "Other";
  const categoryText = normalized(current);
  const titleText = normalized(title);
  if (
    categoryText === "aquarium" &&
    /\b(?:camping|backpacking|hiking)\b/.test(titleText) &&
    /\b(?:tent|shelter)\b/.test(titleText) &&
    !/\b(?:aquarium|fish|tank|filter)\b/.test(titleText)
  ) {
    return "Camping Tents";
  }
  return current;
}
