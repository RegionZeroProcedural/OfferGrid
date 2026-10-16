import {
  applyEbayOfferVerifications,
  getEbayOffersForVerification,
  getEbayDraftOffersForVerification,
  getEbayOffersByExternalIds,
  getOffer,
  getOffersByIds,
  getEbayCompetitorSanitizerStatus,
} from "../lib/db.js";
import {
  getEbayItemDetails,
  getEbayItemsDetails,
  getEbayBulkGetItemsCapabilityStatus,
  setEbayGetItemFallbackIdentityBacklog,
} from "../providers/ebay.js";
import { opLog, opWarn, timedOp } from "../lib/opsLog.js";
import { noteEbayDeferredDemand } from "../lib/ebayApiUsage.js";
import {
  buildEbayGetItemsBatches,
  ebayGetItemsDemandKey,
  summarizeEbayGetItemsBatches,
} from "../lib/ebayBatching.js";
import { backgroundCheckpoint } from "../lib/requestPriority.js";
import {
  getEbayRateGuardStatus,
  isEbayRateGuardError,
  recommendedEbayBackgroundCallBudget,
} from "../lib/ebayRateGuard.js";

function chunk(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

async function mapConcurrent(values, concurrency, fn) {
  const results = new Array(values.length);
  let cursor = 0;

  async function worker(workerIndex) {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index, workerIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(values.length, 1)) },
    (_, index) => worker(index)
  );

  await Promise.all(workers);
  return results;
}

async function fetchBatchDetails(
  offers,
  batchIndex,
  workerIndex,
  priority = "background"
) {
  if (priority === "background") {
    await backgroundCheckpoint(`price-verify:batch:${batchIndex + 1}`);
  }
  const ids = offers.map(offer => String(offer.externalId));
  const finish = timedOp(
    "price-verify",
    `batch ${batchIndex + 1} on I/O lane ${workerIndex + 1}`,
    {
      offers: offers.length,
      priority,
    }
  );

  try {
    const response = await getEbayItemsDetails(ids, {
      priority,
      includeProductIdentity: false,
    });
    const byId = new Map(
      response.items.map(detail => [String(detail.externalId), detail])
    );
    const providerMissingIds = new Set(
      (response.missingIds || []).map(value => String(value || "")).filter(Boolean)
    );
    const providerDeferredIds = new Set(
      (response.deferredIds || []).map(value => String(value || "")).filter(Boolean)
    );
    const providerFailedIds = new Set(
      (response.failedIds || []).map(value => String(value || "")).filter(Boolean)
    );

    // Preserve authoritative 404s all the way to the apply layer so dead eBay
    // listings become out_of_stock instead of remaining eternally unresolved.
    for (const externalId of providerMissingIds) {
      if (!byId.has(externalId)) {
        byId.set(externalId, {
          missing: true,
          externalId,
          priceVerifiedAt: new Date().toISOString(),
        });
      }
    }

    const missingOffers = offers.filter(
      offer => !byId.has(String(offer.externalId))
    );

    const allowIndividualFallback =
      String(process.env.EBAY_ALLOW_INDIVIDUAL_GETITEM_FALLBACK || "false").toLowerCase() === "true";
    const fallbackMax = !allowIndividualFallback
      ? 0
      : priority === "interactive"
        ? Math.min(
            Math.max(
              Number(process.env.EBAY_INTERACTIVE_MISSING_FALLBACK_MAX || 0),
              0
            ),
            4
          )
        : Math.min(
            Math.max(
              Number(process.env.EBAY_BACKGROUND_MISSING_FALLBACK_MAX || 0),
              0
            ),
            2
          );

    // An exact-detail request can still leave individual IDs unresolved. The
    // provider owns the V3.7.36 permission-aware getItem fallback budget; this
    // legacy diagnostic fallback remains opt-in so callers do not amplify it.
    if (missingOffers.length && fallbackMax > 0) {
      const fallbackOffers = missingOffers.slice(0, fallbackMax);

      opLog(
        "price-verify",
        `batch ${batchIndex + 1} has ${missingOffers.length} unresolved item(s); ` +
        `confirming at most ${fallbackOffers.length} individually`,
        { priority }
      );

      const fallbackDetails = await mapConcurrent(
        fallbackOffers,
        Math.min(2, fallbackOffers.length),
        async offer => {
          try {
            return await getEbayItemDetails(offer.externalId, { priority });
          } catch (error) {
            if (isEbayRateGuardError(error)) throw error;
            opWarn(
              "price-verify",
              `individual fallback failed for ${offer.externalId}`,
              error.message
            );
            return null;
          }
        }
      );

      for (const detail of fallbackDetails.filter(Boolean)) {
        byId.set(String(detail.externalId), detail);
      }
    }

    const entries = [];
    for (const offer of offers) {
      const detail = byId.get(String(offer.externalId));
      if (!detail) continue;
      entries.push({ offerId: offer.id, detail });
    }

    const unresolved = offers
      .filter(offer => !byId.has(String(offer.externalId)))
      .map(offer => {
        const externalId = String(offer.externalId || "");
        const failed = providerFailedIds.has(externalId);
        return {
          offerId: offer.id,
          externalId: offer.externalId,
          error: failed
            ? "eBay exact-detail request failed for this listing; left unchanged."
            : "Exact eBay detail was deferred; left unchanged for a later pass.",
          deferred: providerDeferredIds.has(externalId) || !failed,
        };
      });

    finish("complete", {
      verified: entries.length,
      unresolved: unresolved.length,
    });

    return {
      entries,
      failures: unresolved,
      deferred: unresolved.length,
    };
  } catch (error) {
    if (isEbayRateGuardError(error)) {
      finish("deferred-by-rate-guard", {
        error: error.message,
      });

      return {
        entries: [],
        failures: offers.map(offer => ({
          offerId: offer.id,
          externalId: offer.externalId,
          error: error.message,
          deferred: true,
        })),
        deferred: offers.length,
        rateGuard: true,
      };
    }

    // A malformed/expired ID can cause an entitled bulk request to reject an
    // entire batch. Salvage good IDs by splitting at this layer; the provider
    // separately owns any permission-aware bounded getItem fallback.
    if (Number(error?.status) === 400 && offers.length > 1) {
      const middle = Math.ceil(offers.length / 2);
      const left = offers.slice(0, middle);
      const right = offers.slice(middle);

      opWarn(
        "price-verify",
        `batch ${batchIndex + 1} rejected with HTTP 400; splitting ${offers.length} IDs into ${left.length}+${right.length}`,
        error.message
      );

      const [a, b] = await Promise.all([
        fetchBatchDetails(left, batchIndex, workerIndex, priority),
        fetchBatchDetails(right, batchIndex, workerIndex, priority),
      ]);

      return {
        entries: [...a.entries, ...b.entries],
        failures: [...a.failures, ...b.failures],
        deferred: Number(a.deferred || 0) + Number(b.deferred || 0),
        rateGuard: Boolean(a.rateGuard || b.rateGuard),
      };
    }

    finish("failed-without-amplification", {
      error: error.message,
    });

    return {
      entries: [],
      failures: offers.map(offer => ({
        offerId: offer.id,
        externalId: offer.externalId,
        error: String(error?.message || error).slice(0, 500),
        deferred: false,
      })),
      deferred: 0,
    };
  }
}

export async function verifyEbayOffers(
  offerIds = [],
  { priority = "background", maxApiCalls = null, deferPersistence = null } = {}
) {
  const cycleStartedAt = Date.now();
  const wanted = new Set(
    (offerIds || []).map(Number).filter(Number.isFinite)
  );

  const offers = getOffersByIds([...wanted])
    .filter(offer => String(offer.provider).toLowerCase() === "ebay");

  if (!offers.length) {
    return {
      selected: 0,
      uniqueListings: 0,
      verified: 0,
      missing: 0,
      changed: 0,
      failures: [],
      apiBatches: 0,
      deferred: 0,
      rateGuard: getEbayRateGuardStatus(),
    };
  }

  const batchSize = Math.min(
    Math.max(Number(process.env.EBAY_PRICE_VERIFY_BATCH_SIZE || 20), 1),
    20
  );
  const variationBatchSize = Math.min(
    Math.max(Number(process.env.EBAY_VARIATION_VERIFY_BATCH_SIZE || 10), 1),
    10
  );
  const concurrency = Math.min(
    Math.max(Number(process.env.EBAY_PRICE_VERIFY_CONCURRENCY || 4), 1),
    8
  );

  // Damaged/legacy catalogs can contain the same eBay item attached to more
  // than one product. Fetch that item once and apply the exact response to all
  // local copies rather than burning one slot per duplicate attachment.
  const offersByExternalId = new Map();
  for (const offer of offers) {
    const key = String(offer.externalId || "");
    if (!offersByExternalId.has(key)) offersByExternalId.set(key, []);
    offersByExternalId.get(key).push(offer);
  }

  const representatives = [...offersByExternalId.values()].map(group => group[0]);
  const batchSpecs = buildEbayGetItemsBatches(representatives, {
    idOf: offer => offer.externalId,
    singleBatchSize: batchSize,
    variationBatchSize,
  });
  const batchSummary = summarizeEbayGetItemsBatches(batchSpecs);

  const callCap = maxApiCalls == null
    ? null
    : Math.max(0, Math.floor(Number(maxApiCalls) || 0));
  const runnableSpecs = callCap == null ? batchSpecs : batchSpecs.slice(0, callCap);
  const deferredSpecs = callCap == null ? [] : batchSpecs.slice(callCap);

  for (const batch of deferredSpecs) {
    noteEbayDeferredDemand("browse.getItems", "getItems", {
      units: batch.ids.length,
      capacity: batch.capacity,
      demandKey: ebayGetItemsDemandKey(batch.ids, { includeProductIdentity: false }),
      priority,
      reason: "verification-call-budget",
    });
  }

  let batches = runnableSpecs.map(batch => batch.values);

  const selectedExternalIds = new Set(
    batches.flat().map(offer => String(offer.externalId || ""))
  );
  const selectedOffers = offers.filter(offer => selectedExternalIds.has(String(offer.externalId || "")));

  if (!batches.length) {
    return {
      selected: 0,
      uniqueListings: 0,
      verified: 0,
      missing: 0,
      changed: 0,
      failures: [],
      apiBatches: 0,
      deferred: offers.length,
      touchedProducts: 0,
      rateGuard: getEbayRateGuardStatus(),
    };
  }

  opLog("price-verify", `verifying ${selectedOffers.length} offers / ${selectedExternalIds.size} unique listings in ${batches.length} exact-detail batch(es)`, {
    singleItemBatchSize: batchSize,
    variationBatchSize,
    concurrency,
    duplicateAttachmentsAvoided: Math.max(0, selectedOffers.length - selectedExternalIds.size),
    plannedBatchFillPct: batchSummary.fillPct,
    deferredBatchesByBudget: deferredSpecs.length,
  });

  const fetchStartedAt = Date.now();
  const fetched = await mapConcurrent(
    batches,
    concurrency,
    (batch, index, workerIndex) =>
      fetchBatchDetails(batch, index, workerIndex, priority)
  );
  const fetchDurationMs = Date.now() - fetchStartedAt;

  const representativeEntries = fetched.flatMap(result => result.entries);
  const representativeByOfferId = new Map(
    selectedOffers.map(offer => [Number(offer.id), offer])
  );
  const detailByExternalId = new Map();
  for (const entry of representativeEntries) {
    const representative = representativeByOfferId.get(Number(entry.offerId));
    if (representative) detailByExternalId.set(String(representative.externalId), entry.detail);
  }

  const entries = [];
  for (const offer of selectedOffers) {
    const detail = detailByExternalId.get(String(offer.externalId));
    if (detail) entries.push({ offerId: offer.id, detail });
  }

  const failedExternalIds = new Set(
    fetched.flatMap(result => result.failures || []).map(failure => String(failure.externalId || ""))
  );
  const failures = selectedOffers
    .filter(offer => failedExternalIds.has(String(offer.externalId)))
    .map(offer => ({
      offerId: offer.id,
      externalId: offer.externalId,
      error: "Exact eBay detail was deferred or unavailable for this unique listing.",
      deferred: true,
    }));
  const deferred = failures.length + Math.max(0, offers.length - selectedOffers.length);

  // User-generated requests always outrank scheduled catalog mutation work.
  // Interactive/manual verification is itself a foreground request, so it only
  // yields one event-loop turn instead of waiting on its own request counter.
  if (priority === "background") {
    await backgroundCheckpoint("price-verify:apply");
  } else {
    await new Promise(resolve => setImmediate(resolve));
  }
  const applyStartedAt = Date.now();
  const shouldDeferPersistence = deferPersistence == null
    ? priority === "background"
    : Boolean(deferPersistence);
  let applied;
  if (priority === "background" && entries.length > 0) {
    const localChunkSize = Math.min(
      Math.max(Number(process.env.INTERACTIVE_BACKGROUND_APPLY_CHUNK || 40), 10),
      100
    );
    const parts = [];
    let applyIndex = 0;
    for (const localEntries of chunk(entries, localChunkSize)) {
      await backgroundCheckpoint(`price-verify:local-apply:${++applyIndex}`);
      parts.push(applyEbayOfferVerifications(localEntries, { deferPersistence: shouldDeferPersistence }));
    }
    applied = {
      updated: parts.reduce((sum, part) => sum + Number(part.updated || 0), 0),
      missing: parts.reduce((sum, part) => sum + Number(part.missing || 0), 0),
      changed: parts.reduce((sum, part) => sum + Number(part.changed || 0), 0),
      touchedProductIds: [...new Set(parts.flatMap(part => part.touchedProductIds || []).map(Number))],
      results: parts.flatMap(part => part.results || []),
    };
  } else {
    applied = applyEbayOfferVerifications(entries, { deferPersistence: shouldDeferPersistence });
  }
  const applyDurationMs = Date.now() - applyStartedAt;

  for (const result of applied.results.filter(result => result.changed)) {
    opLog("price-change", `offer ${result.offerId} changed`, {
      oldPrice: result.oldPrice,
      newPrice: result.newPrice,
      delta: result.discrepancy,
    });
  }

  return {
    selected: selectedOffers.length,
    uniqueListings: selectedExternalIds.size,
    verified: applied.updated,
    missing: applied.missing,
    changed: applied.changed,
    failures,
    deferred,
    apiBatches: batches.length,
    plannedApiBatches: batchSpecs.length,
    deferredApiBatchesByBudget: deferredSpecs.length,
    plannedBatchFillPct: batchSummary.fillPct,
    duplicateAttachmentsAvoided: Math.max(0, selectedOffers.length - selectedExternalIds.size),
    touchedProducts: applied.touchedProductIds.length,
    touchedProductIds: [...new Set((applied.touchedProductIds || []).map(Number).filter(Number.isFinite))],
    fetchDurationMs,
    applyDurationMs,
    durationMs: Date.now() - cycleStartedAt,
    rateGuard: getEbayRateGuardStatus(),
  };
}

export async function verifyEbayExternalIds(externalIds = [], options = {}) {
  const offers = getEbayOffersByExternalIds(externalIds);
  return verifyEbayOffers(
    offers.map(offer => offer.id),
    {
      priority: options?.priority || "interactive",
      maxApiCalls: options?.maxApiCalls ?? null,
      deferPersistence: options?.deferPersistence ?? null,
    }
  );
}

export async function verifyEbayOffer(offerId, options = {}) {
  const result = await verifyEbayOffers(
    [offerId],
    { priority: options?.priority || "interactive" }
  );
  return {
    ok: result.verified > 0,
    summary: result,
    offer: getOffer(offerId),
  };
}

export async function verifyEbayOfferIfStale(
  offerId,
  maxAgeMinutes = Number(process.env.EBAY_LIVE_VERIFY_MAX_AGE_MINUTES || 10),
  { priority = "interactive" } = {}
) {
  const offer = getOffer(offerId);
  if (!offer) throw new Error(`Offer ${offerId} does not exist.`);

  if (String(offer.provider).toLowerCase() !== "ebay") {
    return { skipped: true, reason: "not-ebay", offer };
  }

  const verifiedAt = offer.priceVerifiedAt
    ? Date.parse(offer.priceVerifiedAt)
    : 0;
  const maxAgeMs = Math.max(1, Number(maxAgeMinutes || 10)) * 60_000;

  if (verifiedAt && Date.now() - verifiedAt <= maxAgeMs) {
    return { skipped: true, reason: "fresh-cache", offer };
  }

  const result = await verifyEbayOffers(
    [offerId],
    { priority }
  );
  return {
    skipped: false,
    reason: "refreshed",
    ...result,
    offer: getOffer(offerId),
  };
}

export async function runEbayPriceVerification({
  limit,
  priority = "background",
} = {}) {
  const requestedCap = Math.min(
    Math.max(
      Number(limit || process.env.EBAY_PRICE_VERIFY_OFFERS_PER_RUN || 320),
      1
    ),
    1000
  );

  const guard = getEbayRateGuardStatus();
  const competitorBacklog = getEbayCompetitorSanitizerStatus();
  setEbayGetItemFallbackIdentityBacklog(competitorBacklog.pending);
  const capability = getEbayBulkGetItemsCapabilityStatus();

  // When bulk getItems is unavailable, ordinary getItem shares the Browse
  // quota with discovery. Price refresh receives only its explicit unreserved
  // fallback slice; identity verification keeps first claim on the protected
  // share so pending competitors can actually become trusted.
  if (priority === "background" && capability.state === "denied") {
    const fallbackPriceRemaining = Math.max(
      0,
      Math.floor(Number(capability.fallbackPriceWindowRemaining || 0))
    );

    if (capability.fallbackSuspendBackgroundPriceRefresh) {
      // V3.7.39 keeps routine public-price refresh paused while a large exact-
      // competitor backlog is draining, but no longer starves new draft source
      // listings. The unreserved price slice is spent only on primary eBay
      // draft sources so they can satisfy the exact-listing auto-publish gate.
      const draftCap = Math.min(requestedCap, fallbackPriceRemaining);
      const draftOffers = draftCap > 0
        ? getEbayDraftOffersForVerification(draftCap)
        : [];

      if (draftOffers.length) {
        opLog("price-verify", "adaptive catch-up reserved price slice for draft source verification", {
          adaptiveMode: capability.fallbackAdaptiveMode || "catchup",
          competitorPending: Number(capability.fallbackIdentityBacklog || competitorBacklog.pending || 0),
          draftSourcesSelected: draftOffers.length,
          fallbackPriceRemaining,
          fallbackIdentityRemaining: Number(capability.fallbackIdentityWindowRemaining || 0),
          browseRemaining: Number(guard.browse?.backgroundRemaining || 0),
        });
        const result = await verifyEbayOffers(draftOffers.map(offer => offer.id), {
          priority,
          maxApiCalls: 1,
        });
        return {
          ...result,
          transport: "getItem-fallback",
          reason: "adaptive-catchup-draft-source-only",
        };
      }

      // Compatibility note: background price refresh suspended for adaptive identity catch-up
      // still describes the public-refresh lane; V3.7.39 exempts draft sources.
      opLog("price-verify", "routine public price refresh suspended for adaptive identity catch-up", {
        adaptiveMode: capability.fallbackAdaptiveMode || "catchup",
        competitorPending: Number(capability.fallbackIdentityBacklog || competitorBacklog.pending || 0),
        fallbackPriceRemaining,
        fallbackIdentityRemaining: Number(capability.fallbackIdentityWindowRemaining || 0),
        browseRemaining: Number(guard.browse?.backgroundRemaining || 0),
      });
      return {
        selected: 0,
        uniqueListings: 0,
        verified: 0,
        missing: 0,
        changed: 0,
        failures: [],
        deferred: requestedCap,
        apiBatches: 0,
        plannedApiBatches: 0,
        touchedProducts: 0,
        transport: "getItem-fallback",
        reason: "adaptive-identity-catchup",
        rateGuard: guard,
      };
    }

    if (fallbackPriceRemaining <= 0) {
      opLog("price-verify", "background price refresh yielded to identity fallback reserve", {
        fallbackPriceRemaining,
        fallbackIdentityRemaining: Number(capability.fallbackIdentityWindowRemaining || 0),
        browseRemaining: Number(guard.browse?.backgroundRemaining || 0),
      });
      return {
        selected: 0,
        uniqueListings: 0,
        verified: 0,
        missing: 0,
        changed: 0,
        failures: [],
        deferred: requestedCap,
        apiBatches: 0,
        plannedApiBatches: 0,
        touchedProducts: 0,
        transport: "getItem-fallback",
        reason: "identity-fallback-reserve",
        rateGuard: guard,
      };
    }

    const fallbackOfferCap = Math.min(requestedCap, fallbackPriceRemaining);
    const offers = getEbayOffersForVerification(fallbackOfferCap);
    opLog("price-verify", `fallback price verifier selected ${offers.length}/${requestedCap} offers`, {
      fallbackPriceRemaining,
      fallbackIdentityRemaining: Number(capability.fallbackIdentityWindowRemaining || 0),
      browseRemaining: Number(guard.browse?.backgroundRemaining || 0),
      priority,
    });
    return verifyEbayOffers(offers.map(offer => offer.id), {
      priority,
      maxApiCalls: offers.length ? 1 : 0,
    });
  }

  const bucket = guard.getItems;
  const remainingCalls =
    priority === "interactive"
      ? Number(bucket.interactiveRemaining || 0)
      : Number(bucket.backgroundRemaining || 0);

  if (guard.enabled && remainingCalls <= 0) {
    const plannedOffers = getEbayOffersForVerification(requestedCap);
    const plannedBatches = buildEbayGetItemsBatches(plannedOffers, {
      idOf: offer => offer.externalId,
      singleBatchSize: Number(process.env.EBAY_PRICE_VERIFY_BATCH_SIZE || 20),
      variationBatchSize: Number(process.env.EBAY_VARIATION_VERIFY_BATCH_SIZE || 10),
    });
    for (const batch of plannedBatches) {
      noteEbayDeferredDemand("browse.getItems", "getItems", {
        units: batch.ids.length,
        capacity: batch.capacity,
        demandKey: ebayGetItemsDemandKey(batch.ids, { includeProductIdentity: false }),
        priority,
        reason: "preflight-quota-unavailable",
      });
    }

    opLog("price-verify", "verification pass deferred before network I/O; shadow demand recorded", {
      priority,
      usedLast24h: bucket.usedLast24h,
      backgroundRemaining: bucket.backgroundRemaining,
      interactiveRemaining: bucket.interactiveRemaining,
      plannedOffers: plannedOffers.length,
      plannedBatches: plannedBatches.length,
    });

    return {
      selected: 0,
      uniqueListings: 0,
      verified: 0,
      missing: 0,
      changed: 0,
      failures: [],
      deferred: plannedOffers.length || requestedCap,
      apiBatches: 0,
      plannedApiBatches: plannedBatches.length,
      touchedProducts: 0,
      rateGuard: guard,
    };
  }

  const scheduledCallBudget = priority === "background"
    ? recommendedEbayBackgroundCallBudget("getItems", {
        intervalMinutes: Math.max(Number(process.env.EBAY_PRICE_VERIFY_MINUTES || 10), 5),
        share: Math.min(Math.max(Number(process.env.EBAY_PRICE_VERIFY_QUOTA_SHARE || 0.45), 0.05), 0.90),
        maxCalls: Math.min(Math.max(Number(process.env.EBAY_PRICE_VERIFY_MAX_CALLS_PER_RUN || 30), 1), 100),
        minCalls: 1,
      })
    : remainingCalls;

  const callBudget = guard.enabled
    ? Math.min(remainingCalls, scheduledCallBudget)
    : Math.max(1, scheduledCallBudget || 30);

  if (callBudget <= 0) {
    const plannedOffers = getEbayOffersForVerification(requestedCap);
    const plannedBatches = buildEbayGetItemsBatches(plannedOffers, {
      idOf: offer => offer.externalId,
      singleBatchSize: Number(process.env.EBAY_PRICE_VERIFY_BATCH_SIZE || 20),
      variationBatchSize: Number(process.env.EBAY_VARIATION_VERIFY_BATCH_SIZE || 10),
    });
    for (const batch of plannedBatches) {
      noteEbayDeferredDemand("browse.getItems", "getItems", {
        units: batch.ids.length,
        capacity: batch.capacity,
        demandKey: ebayGetItemsDemandKey(batch.ids, { includeProductIdentity: false }),
        priority,
        reason: "scheduled-budget-zero",
      });
    }
    return {
      selected: 0,
      uniqueListings: 0,
      verified: 0,
      missing: 0,
      changed: 0,
      failures: [],
      deferred: plannedOffers.length || requestedCap,
      apiBatches: 0,
      plannedApiBatches: plannedBatches.length,
      touchedProducts: 0,
      rateGuard: guard,
    };
  }

  // Select the normal work cap, then let exact 20-item/10-variation batching
  // fill the available call budget. This is more efficient than the old
  // worst-case assumption of 10 offers per call for every pass.
  const offers = getEbayOffersForVerification(requestedCap);

  opLog("price-verify", `scheduled verifier selected ${offers.length}/${requestedCap} offers`, {
    callBudget,
    remainingGetItemsCalls: remainingCalls,
    priority,
  });

  return verifyEbayOffers(
    offers.map(offer => offer.id),
    { priority, maxApiCalls: callBudget }
  );
}

