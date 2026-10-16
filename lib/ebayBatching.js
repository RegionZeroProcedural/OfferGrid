export const EBAY_GETITEMS_SINGLE_BATCH_MAX = 20;
export const EBAY_GETITEMS_VARIATION_BATCH_MAX = 10;

export function isEbayVariationItemId(value) {
  const parts = String(value || "").split("|");
  const variationId = parts.length >= 3 ? parts[2] : "0";
  return Boolean(variationId && variationId !== "0");
}

function uniqueValues(values = [], idOf = value => value) {
  const seen = new Set();
  const out = [];
  let ordinal = 0;
  for (const value of values || []) {
    const id = String(idOf(value) || "").trim();
    if (!id || seen.has(id)) {
      ordinal++;
      continue;
    }
    seen.add(id);
    out.push({ value, id, ordinal });
    ordinal++;
  }
  return out;
}

function chunk(entries, size) {
  const out = [];
  for (let index = 0; index < entries.length; index += size) {
    out.push(entries.slice(index, index + size));
  }
  return out;
}

export function buildEbayGetItemsBatches(
  values = [],
  {
    idOf = value => value,
    singleBatchSize = EBAY_GETITEMS_SINGLE_BATCH_MAX,
    variationBatchSize = EBAY_GETITEMS_VARIATION_BATCH_MAX,
  } = {}
) {
  const singleSize = Math.min(
    Math.max(Math.trunc(Number(singleBatchSize) || EBAY_GETITEMS_SINGLE_BATCH_MAX), 1),
    EBAY_GETITEMS_SINGLE_BATCH_MAX
  );
  const variationSize = Math.min(
    Math.max(Math.trunc(Number(variationBatchSize) || EBAY_GETITEMS_VARIATION_BATCH_MAX), 1),
    EBAY_GETITEMS_VARIATION_BATCH_MAX
  );

  const unique = uniqueValues(values, idOf);
  const singles = unique.filter(entry => !isEbayVariationItemId(entry.id));
  const variations = unique.filter(entry => isEbayVariationItemId(entry.id));

  const packed = [
    ...chunk(singles, singleSize).map(entries => ({
      kind: "single",
      capacity: singleSize,
      ids: entries.map(entry => entry.id),
      values: entries.map(entry => entry.value),
      firstOrdinal: Number(entries[0]?.ordinal || 0),
    })),
    ...chunk(variations, variationSize).map(entries => ({
      kind: "variation",
      capacity: variationSize,
      ids: entries.map(entry => entry.id),
      values: entries.map(entry => entry.value),
      firstOrdinal: Number(entries[0]?.ordinal || 0),
    })),
  ].sort((a, b) => a.firstOrdinal - b.firstOrdinal);

  return packed.map(({ firstOrdinal, ...batch }) => batch);
}

export function summarizeEbayGetItemsBatches(batches = []) {
  const calls = (batches || []).length;
  const units = (batches || []).reduce((sum, batch) => sum + Number(batch?.ids?.length || 0), 0);
  const capacity = (batches || []).reduce((sum, batch) => sum + Number(batch?.capacity || 0), 0);
  return {
    calls,
    units,
    capacity,
    fillPct: capacity > 0 ? Math.round((units / capacity) * 1000) / 10 : 0,
  };
}

export function ebayGetItemsDemandKey(ids = [], { includeProductIdentity = false } = {}) {
  const normalized = [...new Set((ids || []).map(value => String(value || "").trim()).filter(Boolean))]
    .sort();
  return `getItems|${includeProductIdentity ? "product" : "market"}|${normalized.join(",")}`;
}
