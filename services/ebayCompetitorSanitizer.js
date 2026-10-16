import {
  applyEbayCompetitorSanitizerResults,
  getEbayCompetitorSanitizerQueue,
  getEbayCompetitorSanitizerStatus,
  markEbayCompetitorSanitizerUnresolved,
  noteEbayCompetitorSanitizerRun,
} from "../lib/db.js";
import {
  getEbayItemsDetails,
  getEbayBulkGetItemsCapabilityStatus,
  setEbayGetItemFallbackIdentityBacklog,
} from "../providers/ebay.js";
import { noteEbayDeferredDemand } from "../lib/ebayApiUsage.js";
import {
  buildEbayGetItemsBatches,
  ebayGetItemsDemandKey,
} from "../lib/ebayBatching.js";
import {
  getEbayRateGuardStatus,
  isEbayRateGuardError,
  recommendedEbayBackgroundCallBudget,
} from "../lib/ebayRateGuard.js";
import { opLog, opWarn } from "../lib/opsLog.js";
import { backgroundCheckpoint } from "../lib/requestPriority.js";

function groupedByExternalId(offers = []) {
  const map = new Map();
  for (const offer of offers) {
    const externalId = String(offer.externalId || "").trim();
    if (!externalId) continue;
    if (!map.has(externalId)) {
      map.set(externalId, {
        externalId,
        offers: [],
      });
    }
    map.get(externalId).offers.push(offer);
  }
  return [...map.values()];
}

function chunk(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

export function buildCompetitorSanitizerBatches(offers = []) {
  return buildEbayGetItemsBatches(groupedByExternalId(offers), {
    idOf: group => group.externalId,
  }).map(batch => batch.values);
}

function noteDeferredSanitizerBatch(batch, priority, reason) {
  const ids = batch.map(group => group.externalId);
  const spec = buildEbayGetItemsBatches(batch, { idOf: group => group.externalId })[0];
  noteEbayDeferredDemand("browse.getItems", "getItems", {
    units: ids.length,
    capacity: spec?.capacity || (ids.length <= 10 ? 10 : 20),
    demandKey: ebayGetItemsDemandKey(ids, { includeProductIdentity: true }),
    priority,
    reason,
  });
}

export function computeCompetitorSanitizerCallBudget({
  intervalMinutes = Number(process.env.EBAY_COMPETITOR_SANITIZER_MINUTES || 5),
  share = Number(process.env.EBAY_COMPETITOR_SANITIZER_QUOTA_SHARE || 0.45),
  maxCalls = Number(process.env.EBAY_COMPETITOR_SANITIZER_MAX_CALLS_PER_RUN || 40),
} = {}) {
  return recommendedEbayBackgroundCallBudget("getItems", {
    intervalMinutes,
    share,
    maxCalls,
    minCalls: 1,
  });
}

async function fetchBatch(batch, tracker, callBudget, priority, hooks = {}) {
  if (!batch.length) {
    return { entries: [], unresolvedOfferIds: [], deferredOfferIds: [] };
  }

  if (tracker.invocations >= callBudget) {
    return {
      entries: [],
      unresolvedOfferIds: [],
      deferredOfferIds: batch.flatMap(group => group.offers.map(offer => offer.id)),
    };
  }

  tracker.invocations++;
  const ids = batch.map(group => group.externalId);

  try {
    const getItemsDetails = typeof hooks.getEbayItemsDetails === "function" ? hooks.getEbayItemsDetails : getEbayItemsDetails;
    const response = await getItemsDetails(ids, {
      priority,
      includeProductIdentity: true,
    });
    if (Number(response.networkIds || 0) > 0) {
      tracker.networkCalls += response.transport === "getItem-fallback"
        ? Number(response.networkIds || 0)
        : 1;
    }
    tracker.cacheHits += Number(response.cacheHits || 0);
    tracker.itemIdsRequested += ids.length;

    const details = new Map(
      (response.items || []).map(detail => [String(detail.externalId), detail])
    );
    const providerDeferredIds = new Set(
      (response.deferredIds || []).map(value => String(value || ""))
    );
    const providerMissingIds = new Set(
      (response.missingIds || []).map(value => String(value || ""))
    );
    const providerFailedIds = new Set(
      (response.failedIds || []).map(value => String(value || ""))
    );
    const entries = [];
    const unresolvedOfferIds = [];
    const deferredOfferIds = [];

    for (const group of batch) {
      const externalId = String(group.externalId || "");
      let detail = details.get(externalId);
      if (!detail && providerMissingIds.has(externalId)) {
        detail = {
          missing: true,
          externalId,
          priceVerifiedAt: new Date().toISOString(),
        };
      }
      if (!detail) {
        const target = providerDeferredIds.has(externalId)
          ? deferredOfferIds
          : unresolvedOfferIds;
        target.push(...group.offers.map(offer => offer.id));
        if (providerFailedIds.has(externalId)) {
          opWarn("competitor-sanitizer", "individual exact-detail fallback failed", {
            externalId,
          });
        }
        continue;
      }
      for (const offer of group.offers) {
        entries.push({ offerId: offer.id, detail });
      }
    }

    return { entries, unresolvedOfferIds, deferredOfferIds };
  } catch (error) {
    if (isEbayRateGuardError(error)) {
      tracker.rateGuard = true;
      tracker.retryAt = Number(error.retryAt || 0);
      return {
        entries: [],
        unresolvedOfferIds: [],
        deferredOfferIds: batch.flatMap(group => group.offers.map(offer => offer.id)),
      };
    }

    // A malformed/expired REST item ID can make an entitled bulk request fail.
    // Split only while this pass still has batch budget; the provider separately
    // controls any permission-aware individual getItem fallback.
    if (Number(error?.status) === 400 && batch.length > 1 && tracker.invocations < callBudget) {
      const middle = Math.ceil(batch.length / 2);
      const left = await fetchBatch(batch.slice(0, middle), tracker, callBudget, priority, hooks);
      const right = await fetchBatch(batch.slice(middle), tracker, callBudget, priority, hooks);
      return {
        entries: [...left.entries, ...right.entries],
        unresolvedOfferIds: [...left.unresolvedOfferIds, ...right.unresolvedOfferIds],
        deferredOfferIds: [...left.deferredOfferIds, ...right.deferredOfferIds],
      };
    }

    opWarn("competitor-sanitizer", "getItems batch could not be sanitized this pass", {
      status: Number(error?.status || 0),
      items: batch.length,
      message: String(error?.message || error).slice(0, 300),
    });

    return {
      entries: [],
      unresolvedOfferIds: batch.flatMap(group => group.offers.map(offer => offer.id)),
      deferredOfferIds: [],
    };
  }
}

export async function runEbayCompetitorSanitizer({
  priority = "background",
  maxCalls = null,
  testHooks = null,
} = {}) {
  const hooks = testHooks && typeof testHooks === "object" ? testHooks : {};
  const cycleStartedAt = Date.now();
  const before = getEbayCompetitorSanitizerStatus();
  // Feed the real pending queue into the provider before reading fallback
  // capacity. V3.7.38 can then top up the current window immediately instead
  // of waiting for the next quota-spread window to begin.
  setEbayGetItemFallbackIdentityBacklog(before.pending);
  if (!before.pending) {
    const summary = {
      selected: 0,
      verified: 0,
      rejected: 0,
      deferred: 0,
      apiCalls: 0,
      callBudget: 0,
      reason: "queue-empty",
    };
    noteEbayCompetitorSanitizerRun(summary, { deferPersistence: priority === "background" });
    return { ...summary, pendingBefore: 0, pendingAfter: 0, rateGuard: getEbayRateGuardStatus() };
  }

  const guard = getEbayRateGuardStatus();
  const capability = getEbayBulkGetItemsCapabilityStatus();
  const fallbackActive = capability.state === "denied";
  const fallbackPerBatch = Math.min(
    Math.max(Number(process.env.EBAY_BACKGROUND_GETITEM_FALLBACK_MAX_PER_BATCH || 8), 1),
    20
  );
  const fallbackIdentityRemaining = Math.max(
    0,
    Math.floor(Number(capability.fallbackIdentityWindowRemaining || 0))
  );

  const configuredBudget = maxCalls == null
    ? (priority === "interactive"
        ? Math.min(
            Math.max(
              Number(
                fallbackActive
                  ? guard.browse?.interactiveRemaining
                  : guard.getItems?.interactiveRemaining
              ) || 1,
              1
            ),
            250
          )
        : fallbackActive
          ? Math.min(
              Math.max(Math.ceil(fallbackIdentityRemaining / fallbackPerBatch), 0),
              Math.max(Number(process.env.EBAY_COMPETITOR_SANITIZER_MAX_CALLS_PER_RUN || 40), 1)
            )
          : computeCompetitorSanitizerCallBudget())
    : Math.min(Math.max(Number(maxCalls) || 0, 0), 250);
  const availableCalls = priority === "interactive"
    ? Number(
        fallbackActive
          ? guard.browse?.interactiveRemaining
          : guard.getItems?.interactiveRemaining
      || 0)
    : fallbackActive
      ? Math.ceil(fallbackIdentityRemaining / fallbackPerBatch)
      : Number(guard.getItems?.backgroundRemaining || 0);
  const callBudget = guard.enabled
    ? Math.min(configuredBudget, availableCalls)
    : configuredBudget;

  if (callBudget <= 0) {
    const shadowOfferCap = Math.min(
      Math.max(Number(process.env.EBAY_SHADOW_DEMAND_MAX_ITEMS_PER_PASS || 5000), 100),
      20_000
    );
    const shadowQueue = getEbayCompetitorSanitizerQueue(shadowOfferCap);
    const shadowBatches = buildCompetitorSanitizerBatches(shadowQueue);
    for (const batch of shadowBatches) {
      noteDeferredSanitizerBatch(batch, priority, "sanitizer-quota-unavailable");
    }

    const summary = {
      selected: 0,
      verified: 0,
      rejected: 0,
      deferred: before.pending,
      apiCalls: 0,
      callBudget: 0,
      shadowDemandBatches: shadowBatches.length,
      reason: fallbackActive
        ? "getItem-fallback-identity-budget-exhausted"
        : "getItems-quota-reserved-or-cooldown",
    };
    noteEbayCompetitorSanitizerRun(summary, { deferPersistence: priority === "background" });
    return { ...summary, pendingBefore: before.pending, pendingAfter: before.pending, rateGuard: guard };
  }

  // Select enough offers to saturate the efficient bulk batches. Duplicate
  // external IDs are deduplicated below, so damaged duplicate attachments do
  // not waste extra eBay calls.
  const queueLimit = fallbackActive
    ? Math.min(5000, Math.max(fallbackIdentityRemaining, 1) * 2)
    : Math.min(5000, callBudget * 20 * 2);
  const queue = getEbayCompetitorSanitizerQueue(queueLimit);
  const batches = buildCompetitorSanitizerBatches(queue);
  const tracker = {
    invocations: 0,
    networkCalls: 0,
    cacheHits: 0,
    itemIdsRequested: 0,
    rateGuard: false,
    retryAt: 0,
  };

  const entries = [];
  const unresolvedOfferIds = [];
  const deferredOfferIds = [];
  let batchesVisited = 0;

  for (const batch of batches) {
    if (priority === "background") {
      await backgroundCheckpoint(`competitor-sanitizer:batch:${batchesVisited + 1}`);
    }
    if (tracker.rateGuard || tracker.invocations >= callBudget) {
      noteDeferredSanitizerBatch(
        batch,
        priority,
        tracker.rateGuard ? "sanitizer-rate-guard" : "sanitizer-call-budget"
      );
      deferredOfferIds.push(...batch.flatMap(group => group.offers.map(offer => offer.id)));
      continue;
    }

    batchesVisited++;
    const result = await fetchBatch(batch, tracker, callBudget, priority, hooks);
    entries.push(...result.entries);
    unresolvedOfferIds.push(...result.unresolvedOfferIds);
    deferredOfferIds.push(...result.deferredOfferIds);
  }

  if (priority === "background") {
    await backgroundCheckpoint("competitor-sanitizer:apply");
  } else {
    await new Promise(resolve => setImmediate(resolve));
  }
  const applyStartedAt = Date.now();
  let applied;
  if (priority === "background" && entries.length > 0) {
    const localChunkSize = Math.min(
      Math.max(Number(process.env.INTERACTIVE_BACKGROUND_APPLY_CHUNK || 40), 10),
      100
    );
    const parts = [];
    let applyIndex = 0;
    for (const localEntries of chunk(entries, localChunkSize)) {
      await backgroundCheckpoint(`competitor-sanitizer:local-apply:${++applyIndex}`);
      parts.push(applyEbayCompetitorSanitizerResults(localEntries, { deferPersistence: true }));
    }
    const reasons = {};
    for (const part of parts) {
      for (const [reason, count] of Object.entries(part.reasons || {})) {
        reasons[reason] = Number(reasons[reason] || 0) + Number(count || 0);
      }
    }
    applied = {
      processed: parts.reduce((sum, part) => sum + Number(part.processed || 0), 0),
      verified: parts.reduce((sum, part) => sum + Number(part.verified || 0), 0),
      rejected: parts.reduce((sum, part) => sum + Number(part.rejected || 0), 0),
      removedOffers: parts.reduce((sum, part) => sum + Number(part.removedOffers || 0), 0),
      touchedProductIds: [...new Set(parts.flatMap(part => part.touchedProductIds || []).map(Number))],
      reasons,
      results: parts.flatMap(part => part.results || []),
    };
  } else {
    applied = applyEbayCompetitorSanitizerResults(entries, { deferPersistence: false });
  }
  const applyDurationMs = Date.now() - applyStartedAt;
  if (unresolvedOfferIds.length) {
    markEbayCompetitorSanitizerUnresolved(
      unresolvedOfferIds,
      "Exact eBay detail returned no item; queued for a later retry",
      { deferPersistence: priority === "background" }
    );
  }

  const after = getEbayCompetitorSanitizerStatus();
  const summary = {
    selected: queue.length,
    uniqueListings: groupedByExternalId(queue).length,
    batchesVisited,
    verified: applied.verified,
    rejected: applied.rejected,
    unresolved: unresolvedOfferIds.length,
    deferred: deferredOfferIds.length,
    apiCalls: tracker.networkCalls,
    apiInvocations: tracker.invocations,
    cacheHits: tracker.cacheHits,
    itemIdsRequested: tracker.itemIdsRequested,
    callBudget,
    adaptiveMode: capability.fallbackAdaptiveMode || "normal",
    adaptiveWindowBudget: Number(capability.fallbackWindowBudget || 0),
    adaptiveBrowseShare: Number(capability.fallbackAdaptiveBrowseShare || 0),
    applyDurationMs,
    durationMs: Date.now() - cycleStartedAt,
    pendingBefore: before.pending,
    pendingAfter: after.pending,
    rateGuardDeferred: tracker.rateGuard,
    retryAt: tracker.retryAt || null,
    reason: tracker.rateGuard
      ? "rate-guard-deferred"
      : (after.pending ? "backlog-continues" : "queue-clean"),
  };

  noteEbayCompetitorSanitizerRun(summary, { deferPersistence: priority === "background" });
  opLog("competitor-sanitizer", "exact competitor sanitizer pass complete", summary);

  return {
    ...summary,
    rejectionReasons: applied.reasons,
    rateGuard: getEbayRateGuardStatus(),
  };
}
