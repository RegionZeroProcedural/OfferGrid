import {
  prepareSearchQuery,
  prepareSearchRecord,
  searchRelevancePrepared,
} from "../lib/searchRelevance.js";

export const CATALOG_SHOPPER_PAGE_SIZE = 40;

function lexicalFingerprint(record = {}) {
  return [
    String(record.title || ""),
    String(record.brand || ""),
    String(record.category || ""),
    String(record.searchText || ""),
  ].join("\u0000");
}

function preparedFor(recordOrPrepared, lexicalCache = null) {
  if (recordOrPrepared?.record && recordOrPrepared?.lexical) {
    return recordOrPrepared;
  }

  const record = recordOrPrepared || {};

  // A Map cache is ID/fingerprint based so unchanged products can reuse their
  // lexical preparation across catalog revisions. This is important for the
  // fresh main-thread repair path immediately after ingestion: one new product
  // should not force all unchanged catalog titles to be re-tokenized.
  if (lexicalCache instanceof Map) {
    const key = Number.isFinite(Number(record.id)) ? Number(record.id) : String(record.id || "");
    const fingerprint = lexicalFingerprint(record);
    const cached = lexicalCache.get(key);
    if (cached?.fingerprint === fingerprint) {
      return { record, lexical: cached.lexical };
    }
    const lexical = prepareSearchRecord(record);
    lexicalCache.set(key, { fingerprint, lexical });
    return { record, lexical };
  }

  if (lexicalCache?.has(record)) {
    return { record, lexical: lexicalCache.get(record) };
  }

  const lexical = prepareSearchRecord(record);
  lexicalCache?.set(record, lexical);
  return { record, lexical };
}

export function prepareCatalogSearchRecords(records = []) {
  return (Array.isArray(records) ? records : []).map(record => ({
    record,
    lexical: prepareSearchRecord(record),
  }));
}

function compareRecords(a, b, sort, queryActive) {
  const left = a.record;
  const right = b.record;

  // Parts/broken rows are opt-in inventory, not part of the normal competitive
  // market. When ranking by Deal Heat or competitor coverage, keep them after
  // normal-condition products even if they have a newer/verified source row.
  if ((sort === "heat" || sort === "competitors") && Boolean(left.conditionException) !== Boolean(right.conditionException)) {
    return left.conditionException ? 1 : -1;
  }

  if (sort === "competitors") {
    // Every record in this array has already passed strict query relevance.
    // When the shopper explicitly chooses Competitors, verified comparable
    // seller coverage is therefore the primary ranking signal. Relevance is a
    // tie-breaker, not a reason a one-seller row can stay above an eight-seller
    // row after live hydration.
    return (
      Number(right.competitorSellerCount || 0) - Number(left.competitorSellerCount || 0) ||
      (queryActive ? b.relevance - a.relevance : 0) ||
      Number(right.heat || 0) - Number(left.heat || 0) ||
      Number(right.bestScore || 0) - Number(left.bestScore || 0) ||
      Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0)
    );
  }

  if (queryActive && a.relevance !== b.relevance) {
    return b.relevance - a.relevance;
  }

  if (sort === "heat") {
    return (
      Number(right.heat || 0) - Number(left.heat || 0) ||
      Number(right.verificationRank || 0) - Number(left.verificationRank || 0) ||
      Number(right.bestScore || 0) - Number(left.bestScore || 0) ||
      Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0)
    );
  }

  if (left.verificationRank !== right.verificationRank) {
    return Number(right.verificationRank || 0) - Number(left.verificationRank || 0);
  }

  if (sort === "price") {
    return (
      Number(left.bestPrice ?? Number.POSITIVE_INFINITY) -
        Number(right.bestPrice ?? Number.POSITIVE_INFINITY) ||
      Number(right.heat || 0) - Number(left.heat || 0) ||
      Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0)
    );
  }

  if (sort === "new") {
    return (
      Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0) ||
      Number(right.heat || 0) - Number(left.heat || 0)
    );
  }

  return Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0);
}

export function runCatalogSearch(
  records = [],
  payload = {},
  { lexicalCache = null } = {}
) {
  const preparedQuery = prepareSearchQuery(payload.q || "");
  const queryActive = preparedQuery.tokens.length > 0;
  const category = String(payload.category || "");
  const sort = ["heat", "new", "price", "competitors"].includes(payload.sort)
    ? payload.sort
    : "heat";
  const pageSize = CATALOG_SHOPPER_PAGE_SIZE;
  const page = Math.max(Number(payload.page || 1), 1);
  const matches = [];

  for (const item of Array.isArray(records) ? records : []) {
    const prepared = preparedFor(item, lexicalCache);
    const record = prepared.record;
    if (category && record.category !== category) continue;
    if (record.conditionException && !payload.includeParts) continue;

    let relevance = 0;
    if (queryActive) {
      const result = searchRelevancePrepared(preparedQuery, prepared.lexical);
      if (!result.relevant) continue;
      relevance = Number(result.score || 0);
    }

    // Avoid spreading/copying each catalog record into a temporary object.
    // Search only needs the original record plus one numeric relevance score.
    matches.push({ record, relevance });
  }

  // Global ordering is an invariant: sort the COMPLETE matching result set,
  // then paginate. Both worker and fallback call this exact implementation.
  matches.sort((a, b) => compareRecords(a, b, sort, queryActive));

  const total = matches.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = queryActive ? page : Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;

  return {
    ids: matches.slice(start, start + pageSize).map(item => item.record.id),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}

export function runNearestCatalogSearch(
  records = [],
  payload = {},
  { lexicalCache = null } = {}
) {
  const query = prepareSearchQuery(payload.q || "");
  const category = String(payload.category || "");
  const limit = Math.min(Math.max(Number(payload.limit || 20), 1), 100);
  if (!query.tokens.length) return [];

  const ranked = [];
  for (const item of Array.isArray(records) ? records : []) {
    const prepared = preparedFor(item, lexicalCache);
    const record = prepared.record;
    if (category && record.category !== category) continue;

    let overlap = 0;
    for (const token of query.tokens) {
      if (prepared.lexical.broadTokens.has(token)) overlap++;
    }
    if (!overlap) continue;

    ranked.push({ record, overlap });
  }

  ranked.sort((a, b) =>
    b.overlap - a.overlap ||
    Number(b.record.verificationRank || 0) - Number(a.record.verificationRank || 0) ||
    Number(b.record.heat || 0) - Number(a.record.heat || 0)
  );

  return ranked.slice(0, limit).map(item => item.record.id);
}
