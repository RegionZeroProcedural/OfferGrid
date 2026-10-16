const STOP_WORDS = new Set([
  "the","a","an","and","or","for","with","to","of","in","on","at","by","from","new","sale",
]);

function collapseDoubleEnding(value) {
  return /(.)\1$/.test(value) ? value.slice(0, -1) : value;
}

function singularize(token) {
  let value = String(token || "");
  if (value.length <= 3) return value;
  if (value.endsWith("ies") && value.length > 4) value = `${value.slice(0, -3)}y`;
  else if (/(ches|shes|sses|xes|zes)$/.test(value)) value = value.slice(0, -2);
  else if (value.endsWith("s") && !value.endsWith("ss")) value = value.slice(0, -1);

  // Small morphology normalization keeps precision while treating obvious
  // product-language variants as the same concept: printer/printing,
  // charger/charging, dryer/drying, scanner/scanning, etc.
  if (value.endsWith("ing") && value.length > 6) {
    value = collapseDoubleEnding(value.slice(0, -3));
  } else if (value.endsWith("er") && value.length > 5) {
    value = collapseDoubleEnding(value.slice(0, -2));
  }

  return value;
}

export function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/crow[’']?s?\s*[- ]?foot/g, "crowfoot")
    .replace(/crowsfoot/g, "crowfoot")
    .replace(/\busb[\s-]*c\b/g, "usbc")
    .replace(/\btype[\s-]*c\b/g, "typec")
    .replace(/\bwi[\s-]*fi\b/g, "wifi")
    // Treat punctuation between ordinary words as a boundary. Keeping a raw
    // hyphen here caused exact product phrases such as "timing-light" to be
    // indexed as one token, creating false negatives for a shopper query like
    // "timing light". Known technical compounds above are normalized first.
    .replace(/([a-z])[-–—]+(?=[a-z])/g, "$1 ")
    .replace(/\bm\s*[.]?\s*2\b/g, "m2")
    .replace(/(\d)\s*\/\s*(\d)/g, "$1x$2")
    .replace(/[^a-z0-9.+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchTokens(value) {
  return normalizeSearchText(value)
    .split(" ")
    .filter(Boolean)
    .map(singularize)
    .filter(token => token.length >= 2)
    .filter(token => !STOP_WORDS.has(token));
}

function tokenSetFromTokens(tokens) {
  return new Set(tokens);
}

function smallestTokenDistance(tokens, a, b) {
  const left = [];
  const right = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === a) left.push(index);
    if (tokens[index] === b) right.push(index);
  }
  let best = Number.POSITIVE_INFINITY;
  for (const x of left) for (const y of right) best = Math.min(best, Math.abs(x - y));
  return best;
}

// V3.7.47: query parsing is independent of the catalog record. Keeping this
// prepared object lets worker/fallback searches normalize a shopper query once
// instead of repeating the same tokenization thousands of times.
export function prepareSearchQuery(query) {
  const raw = String(query || "");
  const tokens = [...new Set(searchTokens(raw))];
  return {
    raw,
    normalized: normalizeSearchText(raw),
    tokens,
    compact: tokens.join(""),
  };
}

// V3.7.47: product-side lexical preparation is also deterministic and can be
// cached for the lifetime of one catalog-index revision. This does not change
// relevance policy; it only avoids rebuilding the same Sets/token arrays for
// every shopper query.
export function prepareSearchRecord(record = {}) {
  const title = String(record.title || record.listingTitle || "");
  const brand = String(record.brand || "");
  const category = String(record.category || "");
  const searchText = String(record.searchText || `${title} ${brand} ${category}`);
  const identityText = `${title} ${brand}`;

  const identitySequence = searchTokens(identityText);
  const categorySequence = searchTokens(category);
  const broadSequence = searchTokens(searchText);

  return {
    title,
    brand,
    category,
    searchText,
    normalizedIdentity: normalizeSearchText(identityText),
    normalizedBroad: normalizeSearchText(searchText),
    identitySequence,
    identityTokens: tokenSetFromTokens(identitySequence),
    categoryTokens: tokenSetFromTokens(categorySequence),
    broadTokens: tokenSetFromTokens(broadSequence),
    compactIdentity: identitySequence.join(""),
    compactBroad: broadSequence.join(""),
  };
}

export function searchRelevancePrepared(preparedQuery, preparedRecord) {
  const q = preparedQuery || prepareSearchQuery("");
  const r = preparedRecord || prepareSearchRecord({});
  const qTokens = q.tokens || [];
  if (!qTokens.length) return { relevant: true, score: 0, matched: 0, required: 0 };

  let missing = qTokens.filter(token => !r.broadTokens.has(token));
  const compactQuery = q.compact || qTokens.join("");
  const compactPhraseMatch =
    qTokens.length > 1 &&
    compactQuery.length >= 6 &&
    (r.compactIdentity.includes(compactQuery) || r.compactBroad.includes(compactQuery));

  // Some marketplace titles join an ordinary product phrase into one token
  // (for example "TimingLight"). Accept the joined phrase only when the whole
  // original token sequence is contiguous; do not turn arbitrary substring
  // overlap into relevance.
  if (missing.length && compactPhraseMatch) missing = [];

  if (missing.length) {
    return {
      relevant: false,
      score: -1,
      matched: qTokens.length - missing.length,
      required: qTokens.length,
      missing,
    };
  }

  // Category-only matches are allowed only when the query itself names the
  // category. Otherwise at least one query term must occur in the product
  // identity (title/brand). This prevents adjacent-category filler such as an
  // impact driver appearing for "crowfoot wrench set" simply because both are
  // tools.
  const identityMatches = compactPhraseMatch
    ? qTokens.slice()
    : qTokens.filter(token => r.identityTokens.has(token));
  const categoryMatches = qTokens.filter(token => r.categoryTokens.has(token));
  const categoryOnlyIntent = categoryMatches.length === qTokens.length;

  if (!identityMatches.length && !categoryOnlyIntent) {
    return {
      relevant: false,
      score: -1,
      matched: qTokens.length,
      required: qTokens.length,
      missingIdentityAnchor: true,
    };
  }

  // Two-word product phrases are especially prone to accidental all-token
  // matches (for example "timing belt kit with work light" for "timing light").
  // Unless the exact/joined phrase is present, require the two concepts to stay
  // close in the product identity. This improves precision without penalizing
  // normal variants such as "timing advance strobe light".
  if (qTokens.length === 2 && identityMatches.length === 2 && !compactPhraseMatch) {
    const distance = smallestTokenDistance(r.identitySequence, qTokens[0], qTokens[1]);
    if (distance > 3) {
      return {
        relevant: false,
        score: -1,
        matched: qTokens.length,
        required: qTokens.length,
        phraseTooLoose: true,
      };
    }
  }

  let score = qTokens.length * 160;
  score += identityMatches.length * 110;
  score += categoryMatches.length * 20;
  if (r.normalizedIdentity.includes(q.normalized)) score += 1200;
  else if (r.normalizedBroad.includes(q.normalized)) score += 550;

  return {
    relevant: true,
    score,
    matched: qTokens.length,
    required: qTokens.length,
    identityMatches: identityMatches.length,
  };
}

export function searchRelevance(query, record = {}) {
  return searchRelevancePrepared(
    prepareSearchQuery(query),
    prepareSearchRecord(record)
  );
}

export function isSearchRelevant(query, record = {}) {
  return searchRelevance(query, record).relevant;
}
