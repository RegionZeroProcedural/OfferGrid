import { searchEbay } from "../providers/ebay.js";
import {
  isRakutenSearchConfigured,
  searchRakutenProducts,
} from "../providers/rakuten.js";
import { opWarn } from "../lib/opsLog.js";

function cleanFailure(provider, error) {
  return {
    provider,
    code: error?.code || "",
    status: Number(error?.status || 0) || null,
    error: String(error?.message || error || "Unknown provider error").slice(0, 500),
  };
}

function dedupe(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates || []) {
    const key = `${String(candidate?.provider || "").toLowerCase()}:${String(candidate?.externalId || "")}`;
    if (!candidate?.externalId || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

export async function searchEbayAndRakuten(query, limit = 30, options = {}) {
  const safeLimit = Math.min(Math.max(Number(limit || 30), 1), 200);
  const ebayOffset = Math.max(0, Number(options?.offset || 0));
  const logicalPage = Math.floor(ebayOffset / Math.max(safeLimit, 1)) + 1;
  const skipEbay = Boolean(options?.skipEbay);
  const skipRakuten = Boolean(options?.skipRakuten);
  const rakutenConfigured = isRakutenSearchConfigured();

  const ebayPromise = skipEbay
    ? Promise.resolve([])
    : searchEbay(query, safeLimit, options);

  // V3.7.46: Rakuten remains an additive discovery source, but a slow mirror
  // must never hold the first shopper paint hostage after eBay has already
  // returned usable candidates. Interactive first-paint discovery can skip it;
  // the query's deferred/background continuation still searches both sources.
  const rakutenPromise = rakutenConfigured && !skipRakuten
    ? searchRakutenProducts(query, Math.min(safeLimit, 100), {
        pageNumber: logicalPage,
        priority: options?.priority || "background",
      })
    : Promise.resolve([]);

  const [ebayResult, rakutenResult] = await Promise.allSettled([
    ebayPromise,
    rakutenPromise,
  ]);

  const ebayCandidates = ebayResult.status === "fulfilled" ? ebayResult.value : [];
  const rakutenCandidates = rakutenResult.status === "fulfilled" ? rakutenResult.value : [];
  const failures = [];

  if (ebayResult.status === "rejected") {
    failures.push(cleanFailure("ebay", ebayResult.reason));
  }

  if (rakutenResult.status === "rejected") {
    const failure = cleanFailure("rakuten", rakutenResult.reason);
    failures.push(failure);
    // Rakuten is additive. A temporary Rakuten outage/token problem must not
    // take down an otherwise-valid eBay discovery path.
    opWarn("marketplace-search", "Rakuten mirror failed; continuing with eBay results", failure);
  }

  // Provider failures are returned as metadata so a successful peer provider can
  // still satisfy the discovery. Callers decide whether a zero-result partial
  // failure should be deferred or surfaced as an error.

  return {
    candidates: dedupe([...ebayCandidates, ...rakutenCandidates]),
    ebayCandidates,
    rakutenCandidates,
    failures,
    ebayError: ebayResult.status === "rejected" ? ebayResult.reason : null,
    rakutenError: rakutenResult.status === "rejected" ? rakutenResult.reason : null,
    skippedEbay: skipEbay,
    skippedRakuten: skipRakuten,
    rakutenConfigured,
  };
}
