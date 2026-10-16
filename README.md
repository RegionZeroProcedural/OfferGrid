# OfferGrid v3.7.56 SHOPPER-OWNED SEARCH STATE + 40-CARD COHERENCE

**Current patch: V3.7.56** — preserves V3.7.55's terminal underfilled-page behavior, V3.7.54's no-rescan sort changes, V3.7.51's 150 ms live competitor ranking, and all existing exact competitor trust rules while removing conflicting discovery/hydration progress ownership.

Foreground discovery and competitor hydration now carry a shopper interaction ID. Shared/background discovery is catalog growth only and cannot overwrite an active competitor progress card or stop the live sorter. Only a hydration `page-start` may establish a new competitor pass ID; late events from older/foreign passes are ignored. Discovery progress is shown as this page's fill out of 40, while competitor progress is shown as scan N of M products that actually require coverage. Original card position is contextual only.

The active shopper page contract is 40 everywhere (`store.js`, server, shared search core, worker pool, and live-search hydration), and current `.env` examples/deployment documentation now agree on `STORE_PAGE_SIZE=40`. Remaining `20` values in first-paint ingestion and eBay batching are intentional API/work budgets, not shopper pagination.

Listings explicitly marked **Not Tested** or **Untested** now join the existing For Parts / Broken / Not Working condition-exception inventory. They are excluded by default from normal search, Deal Heat, history, seller counts, and competitor ranking unless the excluded-condition checkbox is enabled. The one-time condition-aware seller-cache repair is versioned again so legacy cached competitor counts immediately adopt the new rule.

V3.7.56 does **not** replace live `.env`, `data/`, credentials, telemetry, logs, private configuration, or `node_modules`.

---

# OfferGrid v3.7.47 PROGRESSIVE FIRST PAINT + ENTERPRISE RESPONSIVENESS

**Current patch: V3.7.47** — preserves V3.7.46's render-first/selective-hydration behavior and V3.7.45's navigation-priority handoff while removing the remaining new-search stalls and catalog-size-dependent hot-path work identified during full-catalog profiling.

Brand-new searches now progressively adopt safe listings while marketplace discovery is still running. The original empty catalog response cannot overwrite the active Searching state, SSE progress has a lightweight fallback poll, and first-paint source proof grows the visible safe set in tiny touched-product bursts. Competitor research begins only after the first-paint discovery barrier, operates against the exact visible product IDs, and performs one full-query re-sort after the visible pass.

Listings explicitly classified as **For Parts / Broken / Not Working / Repair-only / Box-only / Empty-box** are excluded by default from shopper search, Deal Heat, price history intelligence, normal best-price selection, market comparisons, verified seller counts, competitor ranking, and competitor discovery. The storefront's **Show “For Parts/Broken” listings** control exposes that inventory only on explicit opt-in. Condition-specific cards and detail pages are marked as intelligence-excluded and do not render normal Deal Heat/history/competition claims.

Catalog search workers are double-buffered and warmed in the background. Shopper requests never await a stale worker rebuild; the previous searchable snapshot remains available while a replacement is prepared. Worker and fresh-fallback search share one cached relevance/sort core, and numerous runtime paths now build relationship/review state only for affected product IDs instead of allocating catalog-wide maps for bounded work.

V3.7.47 does **not** replace live `.env`, `data/`, credentials, API telemetry, logs, private configuration, or `node_modules`. Back up `.env` and the full `data/` directory before applying the patch.

---

# OfferGrid v3.7.46 RENDER-FIRST + SELECTIVE HYDRATION

**Current patch: V3.7.46** — preserves every V3.7.45 navigation-priority and exact-competitor trust rule while making brand-new searches render safe results before competitor indexing, reducing first-paint discovery work, rehydrating only stale or never-researched visible products, re-sorting the complete matching query after a competitor pass, and adding anonymous active/historical visitor counters to Admin.

First-paint marketplace work is bounded independently of legacy `.env` page-size values: eBay gets the foreground first-paint probe, Rakuten remains additive in the background continuation, at most 20 relevant candidates are normalized per first-paint slice by default, source exact proof runs in tiny bursts, and the duplicate pre-verification draft-review pass after eBay ingestion is removed. The browser receives safe products first; only after those cards are rendered can the blue sequential competitor cursor start.

Visible competitor hydration is now freshness-selective. A card is rehydrated only when its completed progressive coverage proof is stale (default 60 minutes), missing, or was completed for a weaker seller target. Fresh researched cards are skipped entirely. Stale cards that already have the target seller count still receive one real discovery refresh instead of being silently stamped fresh.

Admin's Outbound traffic area now includes **Currently connected users** and **Historically unique users**. Public pages use a random local browser ID plus a per-tab connection ID; the server stores only SHA-256 hashes in the unique-visitor ledger. Presence heartbeats run every five minutes, active connections expire after seven minutes by default, and the historical box updates live when a new anonymous browser is first observed. Admin sessions are not counted as shoppers.

V3.7.46 does **not** replace live `.env`, `data/catalog.json`, credentials, or `node_modules`. The runtime visitor ledger is created as `data/unique_visitors.ndjson` only after real public traffic arrives.

---

# OfferGrid v3.7.45 NAVIGATION PRIORITY HANDOFF

**Previous patch: V3.7.45** — preserves V3.7.44's fixed 20-card pages, page-scoped relationship hydration, full matching-result-set sorting before pagination, final re-sort after competitor discovery, and V3.7.42/43's detached sequential exact competitor indexing.

Shopper navigation is now an explicit priority boundary. Each tab/view owns the detached live indexing job it started. When the shopper moves to another result page, changes search/category/sort, or leaves the storefront, the old view relinquishes foreground ownership. If nobody else is still watching that same in-flight page job, it is marked superseded, stops cooperatively between atomic eBay operations, and hands its unfinished normalized products to a background-priority queue consumed by the normal scheduled competitor scanner. Marketplace discovery for an abandoned query remains represented by the normal scheduled discovery rule.

This means a 20-card page the shopper no longer sees cannot keep walking its blue cursor in the interactive lane while the shopper is waiting on the next page. Existing request-priority checkpoints still cause ordinary background work to yield to the new HTTP request. Shared jobs are protected: one shopper leaving does not demote a job another shopper is still actively viewing.

Exact product/variant proof, seller counting, RateGuard behavior, 20-card page size, full-query sorting, and post-index re-sort are unchanged. V3.7.45 does not replace live `.env`, `data/`, credentials, or `node_modules`.

---

# OfferGrid v3.7.44 PAGE-SCOPED SORT REFRESH

V3.7.44 fixes shopper pages at 20 cards, sorts the complete matching query/category dataset before pagination, hydrates only the returned page slice with page-scoped relationship lookup buckets, shares search-worker snapshots across workers, and re-runs the full matching-result sort after the visible competitor pass finishes. Detached blue-card competitor indexing and exact proof semantics remain unchanged.

---

# OfferGrid v3.7.43 DETACHED FAST COMPETITOR INDEXING

**Current patch: V3.7.43** — keeps V3.7.42's per-normalized-product exact competitor indexing, shopper-order blue cursor, progressive five-signal recall, exact trust boundary, and seller-count semantics, while removing the storefront stalls exposed by large searches such as `ipad`.

The visible database page is now returned immediately. Shopper indexing is launched as a detached job and never holds the catalog HTTP response open. If the database already has enough products for the requested page, OfferGrid skips the expensive current-query draft verification preflight and starts competitor indexing against the visible normalized products immediately. The blue cursor still moves in shopper display order.

Each discovery signal now performs a bounded exact-detail burst (default 6 candidates) and yields cooperatively. A noisy product that still has unprocessed plausible candidates is marked incomplete rather than monopolizing the page for minutes; quota deferral still pauses truthfully at the highlighted card. Interactive candidate persistence is deferred so indexing does not repeatedly serialize/write the full catalog on the request thread.

The storefront also handles non-JSON 5xx/proxy responses defensively. A temporary HTML error page can no longer become `Unexpected token '<'` and wipe a page that was already rendered; existing safe cards stay visible while detached work retries or reports status.

V3.7.43 does **not** loosen exact competitor proof, does not count pending candidates as verified sellers, and does not replace live `.env`, `data/`, credentials, or `node_modules`.

---

# OfferGrid v3.7.42 SEQUENTIAL NORMALIZED COMPETITOR INDEXING

**Current patch: V3.7.42** — preserves V3.7.41 progressive database-page hydration and changes the foreground competitor pass to operate on **each normalized product independently, in the exact order the shopper sees the cards**.

For every visible under-covered normalized product, OfferGrid now progressively widens competitor discovery through the available exact-product signal ladder (GTIN → ePID → Brand+MPN → MPN → strict title) until the configured verified-seller target is reached or the usable signals are exhausted. A generic historical `ebayCompetitorScanAt` timestamp no longer makes a one-seller card look hydrated; only an explicit completed progressive coverage pass does. Existing V3.7.40/41 shallow scans therefore become eligible for the deeper pass automatically.

The storefront receives a dedicated live `hydration` SSE stream. The card currently being inspected gets a pulsing blue box shadow and `CHECKING COMPETITORS X/Y` indicator. Cards are inspected in DOM order (top-to-bottom / left-to-right), MARKET seller counts update in place, and full-grid rerenders are held until the pass completes so competitor sorting cannot make the cursor jump around. If protected eBay quota prevents exact detail from finishing, the cursor stops at that card rather than implying later cards were already inspected.

V3.7.42 does **not** lower exact-match trust rules, does not count pending seller candidates as verified competitors, and does not replace live `.env`, `data/`, credentials, or `node_modules`.

---

# OfferGrid v3.7.40 FULL-PAGE COMPETITOR HYDRATION

**Current patch: V3.7.40** — builds on V3.7.39 evidence-weighted competitor proof and changes shopper-triggered eBay discovery from "hydrate a few newly approved products" to **prepare the entire visible result page**.

When a live marketplace expansion is needed, OfferGrid now continues discovery toward the requested page capacity instead of returning as soon as the first few safe products become public. Once the requested page is available (or the search source is exhausted), OfferGrid re-queries the exact shopper page and gives every visible product below the verified-seller target an interactive competitor scan + exact-detail verification attempt before the live request is considered complete. There is no fixed three-product live-hydration cap.

Because attaching verified competitor offers can change price/heat/competitor sorting, V3.7.40 re-queries the page after each hydration batch and picks up newly visible, not-yet-attempted products for a small number of stability rounds. The server exposes in-flight live-search state, and the storefront waits for that full-page preparation to finish instead of treating a temporarily populated page full of `1 verified seller` cards as the completed result.

V3.7.39's evidence-weighted identity rules, seller-diverse exact-candidate selection, draft-source verification lane during backlog catch-up, and **Competitors: most to least** sort remain intact. The eBay RateGuard also remains authoritative: if eBay quota is genuinely unavailable, individual page products can be reported as deferred rather than receiving invented seller coverage.

---

# OfferGrid v3.7.35 VERIFICATION THROUGHPUT + RUNTIME STABILITY

**Current patch: V3.7.35** — preserves V3.7.34 multi-signal competitor discovery, provenance, tracked pending offers, Deal Heat trust boundaries, and legal/Terms hardening while fixing three production issues: unknown `getItems` authoritative telemetry being misread as exhausted quota, synchronous whole-catalog background persistence causing multi-second event-loop stalls, and exact strong-evidence listing-scoped duplicate products remaining split.

## V3.7.35 getItems quota semantics

A persisted `0/0` remote quota with no authoritative sync/resource/reset provenance now means **not reported**, not **exhausted**. OfferGrid uses its existing conservative local rolling budget until eBay provides a real authoritative row or returns a genuine rate-limit response. A real authoritative zero with a positive limit and provenance still blocks exactly as before. Admin displays `Not reported · using safe local budget` instead of a misleading `0 / 0`.

## V3.7.35 background persistence

Runtime/background catalog persistence captures an immutable V8 snapshot on the main thread and moves JSON serialization plus the large file write to a worker thread. Deferred writes coalesce, stale worker snapshots cannot overwrite newer synchronous commits, and scheduled lifecycle/integrity/competitor maintenance uses the deferred lane. Manual Admin mutations retain their existing synchronous durability semantics.

## V3.7.35 exact strong-evidence duplicate repair

A narrow local repair reunifies listing-scoped products only when they have the same validated strong identity, same normalized brand, exact normalized title, and no conflicting GTIN/MPN/ePID/variant facts. Offers, offer-attributed history, compressed ownership, and clicks are remapped to the retained product. Fuzzy-title auto-merging remains prohibited.

---

# OfferGrid v3.7.30 NORMALIZATION TRUST

**Current patch: V3.7.30 NORMALIZATION TRUST** — hardens the canonical product-identity foundation, repairs contaminated/duplicate local ownership conservatively, makes quota-constrained time useful for local database maintenance, increases bounded eBay seller-candidate coverage, and clearly separates observed marketplace candidates from exact-verified price intelligence.

## V3.7.30 identity hierarchy

OfferGrid now uses one shared definition of strong identity across canonicalization and eBay competitor proof. A GTIN is strong only when it is a single valid GTIN-8/12/13/14 with a correct check digit; accepted GTINs are stored canonically as GTIN-14. Placeholder values such as `N/A`, `Does not apply`, ambiguous multi-code fields, and invalid checksums cannot own a canonical GTIN key. Brand+MPN identity also rejects placeholder/generic/descriptive values rather than treating any non-empty marketplace field as authoritative.

Canonical ownership now follows a conservative hierarchy:

```text
validated GTIN
  -> validated Brand + MPN
  -> listing-scoped ownership
```

Exact-title local duplicate merging is allowed only when neither product has strong identity and both have the same valid normalized brand plus the exact normalized title. Fuzzy title similarity is **not** an automatic merge authority.

## V3.7.30 catalog repair and local maintenance

The integrity migration (`catalogIntegrityVersion = 310`) sanitizes invalid stored identifiers, splits products whose canonical strong key was built from an invalid identifier, remaps offer-attributed history/click relationships, invalidates only contaminated aggregate caches, splits explicit incompatible variants, removes exact external-offer duplicates, and then performs conservative strong-identity/exact-brand-title merges.

A new rotating local-maintenance worker can run without marketplace network calls. It operates more frequently when eBay Browse/`getItems` capacity is constrained, yielding to interactive traffic and using deferred persistence. This lets quota-starved runtime improve existing catalog structure instead of repeatedly attempting unavailable API work. Local cleanup never invents fresh marketplace verification.

## V3.7.30 observed competitor representation

Browse-discovered competitor candidates may now be shown on the product page before exact `getItems` proof completes. They are visibly marked **Needs verification** with a yellow-orange badge and their amount is described as an **observed price**, not a verified same-product price.

Pending competitor observations remain excluded from:

- Deal Heat and historical-price observations
- verified lowest/median price calculations
- verified seller/listing counts
- best verified offer ranking
- exact same-product claims

An outbound candidate link is enabled only when the existing local-safety gate permits it. Exact sanitizer proof is still required before the candidate becomes verified price intelligence.

## V3.7.30 seller-coverage discovery

V3.7.29's Browse-first durable queue is preserved. V3.7.30 makes bounded recall more useful for seller-poor products: discovery can continue through the existing recall plans until it reaches a small observed coverage target (8 pending listings / 4 observed sellers by default) or RateGuard stops further searching. This increases candidate diversity without lowering the proof threshold for promotion.

Recommended new controls are documented in `.env.example` and `.env.live.example`, including `EBAY_COMPETITOR_PENDING_TARGET_PER_PRODUCT`, `EBAY_COMPETITOR_PENDING_SELLER_TARGET`, and the `LOCAL_NORMALIZATION_*` maintenance controls.

---

# OfferGrid v3.7.29 COMPETITOR COVERAGE

**Prior patch: V3.7.29 COMPETITOR COVERAGE** — moved scheduled eBay competitor discovery to a seller-coverage-first, Browse-first pipeline with durable pending candidate queues and packed cross-product sanitizer verification.

## V3.7.29 seller-coverage pipeline

Zero-seller and one-seller products outrank already well-covered products. One Browse search can collect up to 100 candidates by default, and locally plausible candidates enter a durable pending queue without affecting verified pricing. Once exact quota is available, the sanitizer deduplicates eBay IDs across products and verifies candidates in safe 20-single/10-variation `getItems` batches. The discovery scheduler defaults to 10 minutes while the same-product rescan floor remains 60 minutes.

---

# OfferGrid v3.7.28 LIVE EBAY TELEMETRY

**Prior patch: V3.7.28 LIVE EBAY TELEMETRY** — preserves V3.7.27 shadow quota-demand measurement and 20/10 `getItems` packing while making the Admin eBay panel actually move during rate-limited work. The panel polls a lightweight telemetry route every two seconds, shows real network calls separately from deferred attempts, and keeps unique blocked demand deduplicated so repeated retries do not inflate the quota recommendation.

## V3.7.28 live counter semantics

A rate-guard message such as `authoritative eBay quota reserve reached; request deferred` does **not** represent an eBay API network call, so `Calls used today` correctly stays unchanged. `Deferred attempts today` increments for every blocked attempt, while `Unique calls currently blocked` and `Unique blocked work units` represent deduplicated outstanding work used for the uncapped-demand estimate. The live poll uses `/api/admin/ebay/usage?light=1` and deliberately skips the catalog-wide verification-backlog scan; full Admin refreshes continue to populate those heavier estimates.

# OfferGrid v3.7.27 EBAY QUOTA DEMAND + EFFICIENCY

**Prior patch: V3.7.27 EBAY QUOTA DEMAND + EFFICIENCY** — preserves V3.7.26 pending-verification shopper fallback and Admin folds while making eBay quota demand measurable even when the rate guard blocks network calls. Exact-detail work is centrally packed to eBay-safe bulk limits (20 single-item IDs or 10 variation IDs), repeated blocked work is deduplicated into unique shadow demand, historical daily evidence is retained compactly, and Admin now reports actual pace, uncapped demand, backlog-drain calls, batch fill, items/call, bulk calls saved, 7-day averages/peaks, and a headroom-adjusted quota request target.

## V3.7.27 eBay quota evidence

OfferGrid now records both **actual network calls** and **shadow demand**: API work that was ready to run but was suppressed by local reserve, authoritative eBay quota exhaustion, cooldown, or a worker-specific call budget. A stable demand key prevents the same blocked exact-detail batch from inflating the unique backlog every time a scheduler wakes up. If that exact batch later executes successfully, it is marked fulfilled rather than counted as both blocked and outstanding. At UTC day rollover, unresolved unique shadow demand is compacted into a historical daily summary, so several days of runtime produce defensible quota evidence without retaining an unbounded request-key log.

Admin exposes the current unverified listing backlog, minimum provider-safe calls required to drain it, the minimum calls for one complete active-listing refresh sweep, actual calls/day, measured uncapped calls/day, 7-day average/peak demand, and a configurable quota recommendation (`peak × headroom`, rounded upward).

## V3.7.27 call-efficiency controls

All OfferGrid `getItems` callers now share one batch planner. Single-item listing IDs are packed up to 20 per call; variation IDs are isolated and packed up to 10 per call. Duplicate listing IDs are eliminated before packing, partial cache hits are removed before network I/O, and provider-level guards reject unsafe over-capacity requests before they can waste an eBay call. Query-local verification can now use the full 20-single-item capacity instead of reserving every call as if it contained variations. Scheduled verifier/sanitizer work records shadow batches when quota prevents execution, and one-item fallback verification is disabled by default so bulk `getItems` remains the normal path.

The Admin eBay quota cards additionally report batch fill, average listings per `getItems` network call, and the number of API calls saved versus one-listing-per-call behavior. Metrics persistence is write-behind (5 seconds by default) so telemetry does not reintroduce SSD write amplification.

---

# OfferGrid v3.7.26 PENDING VERIFICATION + ADMIN FOLDS

**Prior patch: V3.7.26 PENDING VERIFICATION + ADMIN FOLDS** — preserves V3.7.25 interactive draft promotion and all prior OfferGrid systems, but closes the remaining zero-result failure mode when eBay exact `getItems` verification is temporarily unavailable. A strictly relevant, locally safe eBay source draft may now appear immediately as **Verification pending** while its observed price remains excluded from Deal Heat, historical lows, verified-price claims, and cross-market same-product comparisons. Admin eBay quota telemetry is also reformatted into structured quota cards/table rows, and the Discovery Rules and Review Queue lists can be collapsed with their state remembered in the browser.

**Canonical site:** `https://www.offergrid.tech`  
**Default public page size:** 100 products  
**Catalog target:** 10,000 normalized products  
**Primary goals:** speed, price accuracy, precision page expansion, and observable automation.

V3.0 builds directly on the V2.9 precision/accuracy architecture.


## V3.7.26 shopper-safe pending eBay fallback

V3.7.25 still correctly refused to publish an eBay draft until exact item verification succeeded. That fail-closed publication rule remains unchanged. V3.7.26 adds a separate shopper projection for the case where exact verification cannot currently run because the eBay `getItems` interactive allowance is exhausted, the endpoint is cooling down after a rate-limit response, or the active live-discovery round has been deferred.

```text
shopper query
  -> approved local results
  -> query-local draft promotion / exact verification
  -> eBay exact verification unavailable?
       -> inspect only strictly query-matching drafts
       -> local pending-safety gate
       -> safe eBay source listing -> show as VERIFICATION PENDING
       -> weak / ambiguous / manual-locked -> keep hidden
```

A pending result is intentionally **not an approved product**. The public projection exposes the observed eBay listing and enough normalized product metadata to remain useful, but it withholds intelligence that requires exact proof:

```text
observed eBay price       visible and labeled "observed"
listing link              allowed through the existing /go/:offerId route
Deal Heat                 withheld / 0 placeholder
new-low claims            withheld
price-history contribution withheld
price sparkline           withheld
verified-price label      withheld
cross-store comparison    withheld
eBay competitor proof     withheld
```

The pending gate remains fail-closed. It requires an ACTIVE untouched draft, no manual Hide/Edit lock, a unique canonical owner, a trusted active eBay **source** offer, valid price and affiliate destination, sufficiently recent observation, and strong/isolated identity evidence without a conflicting strong-identity variant sibling. Defaults:

```env
PENDING_VERIFICATION_FALLBACK_ENABLED=true
PENDING_VERIFICATION_MIN_CONFIDENCE=70
PENDING_VERIFICATION_MAX_AGE_HOURS=72
```

When exact eBay verification later succeeds, the normal V3.7.24/V3.7.25 confidence path can approve the product and the standard cached intelligence/SSE pipeline replaces the pending projection. No pending observation is promoted into Deal Heat merely because the user was rate-limited.

The product-detail endpoint and affiliate redirect use the same pending-safety gate. A stale, manually locked, ambiguous, unavailable, restricted, or otherwise unsafe draft remains inaccessible to shoppers.

## V3.7.26 Admin quota layout + foldable long lists

The eBay API telemetry panel no longer renders the counter inventory as a dense wrapping pill cloud. Browse and `getItems` each have a dedicated responsive quota card showing configured allowance, percentage/interactive/background remaining, authoritative remote quota, reset/cooldown state, and remote 429 events. Supporting adaptive/Growth Check/failure/retry metrics use compact cards, and per-endpoint counters render in a horizontally safe structured table with Today, Hour, Peak/hr, Peak/day, Cache, Avoided, and 429 columns.

The broader automation/rate-guard counter area is also rendered as responsive cards so long values do not break the panel.

Admin now has persistent fold controls for the two longest operator lists:

```text
Discovery rules  -> Collapse rules / Show rules
Review queue     -> Collapse products / Show products
```

Only the list body folds; the rule-creation form remains available. Fold state is saved in `localStorage` and survives Admin live refreshes and page reloads. The toggle label includes the current list count once loaded.

---
## V3.7.25 query-local draft promotion

A shopper search no longer waits for the global draft-curator cursor to eventually reach matching products. When the public catalog cannot fill the requested result page, the live-search path first inspects recent untouched drafts that strictly match the current query/category. Strong Rakuten records can publish immediately. Matching unverified eBay drafts are sent through bounded foreground `getItems` verification, and the existing fail-closed confidence gate is rerun before the response completes.

```text
shopper query
  -> current public catalog
  -> query-local recent draft batch
       -> strong Rakuten confidence review
       -> bounded interactive eBay exact verification
       -> confidence review
  -> first safe products become public immediately
  -> browser renders them now
  -> additional marketplace expansion may continue
```

The foreground draft pass is bounded by:

```env
LIVE_SEARCH_DRAFT_REVIEW_LIMIT=400
LIVE_SEARCH_DRAFT_VERIFY_LIMIT=120
LIVE_SEARCH_DRAFT_VERIFY_MAX_API_CALLS=6
```

The six-call cap is applied conservatively against eBay's smaller variation batching so an ID marked attempted is actually eligible for the current foreground verification budget. eBay rate-guard rules and exact proof remain authoritative; no unverified eBay listing becomes public merely to avoid a zero-result screen.

The storefront now progressively renders newly approved products after each live-search round instead of keeping a zero-result shopper on the searching screen until all configured discovery rounds finish. Existing V3.7.22 position preservation keeps the visible grid stable as more results arrive.

The scheduled V3.7.24 curator also records a review timestamp for deferred drafts and sorts never/least-recently reviewed drafts first. This prevents a permanent first-200 backlog of exact-unverified eBay records from starving newer drafts indefinitely. Manual Hide/Edit locks remain authoritative.

---

## V3.7.24 confident automatic draft curation

V3.7.24 is additive to V3.7.23. Shopper-discovered drafts no longer have to remain stranded in Admin simply because the first live-search response arrived before publication. OfferGrid now performs a local confidence review over recent untouched drafts and publishes only products that pass a fail-closed normalization gate.

The curator considers only ACTIVE, recent drafts that have never been manually hidden or edited. A draft must have a trusted active offer, a unique canonical owner, usable price/link data, and enough source/identity evidence to cross the configured confidence threshold. Examples that can pass include a Rakuten Product Search record with a valid strong product identity, a Rakuten Product Catalog product with strong identity, or an exact-verified eBay source listing isolated by its immutable eBay listing ID. Weak title-only Rakuten search results remain drafts.

```env
DRAFT_AUTO_APPROVE_ENABLED=true
DRAFT_AUTO_APPROVE_MINUTES=1
DRAFT_AUTO_APPROVE_BATCH=200
DRAFT_AUTO_APPROVE_MIN_CONFIDENCE=80
DRAFT_AUTO_APPROVE_MAX_AGE_HOURS=168
DRAFT_AUTO_APPROVE_QUIET_MS=250
```

The first backlog pass runs shortly after HTTP listen and later passes run at low priority. Existing eBay draft verification remains quota-governed; when exact `getItems` verification succeeds, V3.7.24 immediately re-runs the confidence gate for those touched products so safe eBay drafts can become visible during the same discovery lifecycle. The scheduled verifier still reserves draft capacity, so unverified eBay candidates can graduate later without manual approval.

Manual Admin decisions are authoritative. Hiding or editing a draft sets an automatic-publication lock. Rakuten bulk auto-publication and discovery-rule auto-approval respect that lock, so a product intentionally held back by an operator cannot be silently re-published by the next feed or rule run.

The Admin automation payload now reports recent eligible drafts, manually locked drafts, last-pass approvals, and process-total confident approvals. An authenticated `POST /api/admin/drafts/auto-review` endpoint is also available for an immediate manual pass without changing the automated schedule.

---

## V3.7.23 RAM-batched mutations + asynchronous intelligence + lazy boot

V3.7.23 is additive to V3.7.22. No HTTP route, existing `lib/db.js` export, marketplace integration, product identity rule, exact eBay competitor-proof rule, lifecycle path, affiliate redirect, or shopper-position behavior is removed.

### Runtime mutation write-ahead/coalescing buffer

JIT marketplace ingestion, Rakuten Product Catalog mutations, eBay verification updates, provider-feed reconciliation, missing-offer updates, and competitor-sanitizer mutations no longer force a Deal Heat/history rebuild inside the same write path. Runtime product IDs are coalesced in RAM. Repeated mutations to the same product occupy one pending entry and collapse to the newest state before persistence.

The default i7-8700K / 16 GB / NVMe tuning is:

```env
MUTATION_BUFFER_WINDOW_MS=120000
MUTATION_BUFFER_MAX_AGE_MS=300000
MUTATION_BUFFER_MAX_PRODUCTS=1024
MUTATION_BUFFER_QUIET_MS=75
```

A sliding two-minute window handles normal traffic. A five-minute hard age bound prevents indefinite deferral, and a 1,024-product threshold flushes large bursts early. A flush serializes through one Promise chain, records one newest raw best-price observation per touched product, refreshes only cheap best-offer/search materialization, and performs one atomic catalog write. If persistence fails, the captured batch is merged back into the RAM queue rather than being dropped. SIGINT/SIGTERM drains the mutation and intelligence pipelines before process exit.

### Deal Heat / Median-MAD worker pool

Deal Heat, 30-day statistics, Median/MAD outlier pruning, anomaly protection, and Price Signal sparkline compaction run in `worker_threads` rather than on the request-serving thread. The default 12-logical-CPU policy uses eight intelligence workers while retaining the existing two catalog-search workers and headroom for the Node request loop / OS.

```env
INTELLIGENCE_WORKERS=8
INTELLIGENCE_PREP_BATCH_SIZE=256
INTELLIGENCE_PREP_QUIET_MS=50
INTELLIGENCE_RESULT_COMMIT_MS=250
INTELLIGENCE_RESULT_COMMIT_BATCH=64
INTELLIGENCE_SNAPSHOT_PERSIST_MS=15000
```

Each product carries an `intelligenceGeneration`. A worker result is accepted only if its generation still matches the live product, preventing an older calculation from overwriting a newer mutation. Accepted snapshots are coalesced for durable persistence and then generate the existing live product mutation/SSE path.

### Lazy read-through startup

`initDb()` no longer calls the whole-catalog intelligence cache rebuild or rewrites the catalog merely to start serving traffic. Existing persisted `cachedPriceStats`, `cachedPriceSparkline`, best-offer/search materialization, and snapshot metadata are trusted immediately.

Products carry:

```text
intelligenceSnapshotVersion
intelligenceComputedAt
intelligenceDirty
intelligenceDirtyAt
intelligenceDirtyReason
intelligenceGeneration
intelligenceLastError
```

A shopper read never runs Median/MAD synchronously. Missing, malformed, schema-old, dirty, or stale snapshots are queued for isolated recalculation while the current durable snapshot (or a conservative Building History fallback) is returned immediately. A low-priority validator also queues small stale batches after the listener is live.

```env
INTELLIGENCE_STALE_MINUTES=180
INTELLIGENCE_LAZY_SCAN_MINUTES=2
INTELLIGENCE_LAZY_SCAN_BATCH=32
STARTUP_MAINTENANCE_DELAY_MS=30000
```

Catalog integrity / lifecycle / competitor-trust maintenance remains available, but required startup maintenance is deferred until after the HTTP listener is accepting requests.

---

## V3.7.22 market-priority competitor scanning + position-stable live updates

V3.7.22 is additive to V3.7.21. No endpoint, DB export, Product Catalog path, exact-proof rule, rate guard, price-history behavior, or public page is removed.

### Merchant-feed products can now discover eBay competitors

An ACTIVE approved product no longer needs to already own a trusted eBay offer before it can enter the scheduled competitor queue. If a Rakuten/Awin/other merchant-feed product has a provable identity (`GTIN`, `Brand + MPN`, or `ePID + Brand`), it can be selected for an eBay competitor discovery pass. Search results are still discovery-only: every candidate must pass the existing exact `getItems` identity and variant proof before attachment.

### Fair priority for hotter / recently-clicked / overdue products

The scheduled competitor queue now ranks due products using existing data rather than pure oldest-first ordering. Deal Heat, recent outbound clicks, a missing-eBay bootstrap bonus, and overdue age all contribute. The configured scan interval itself is unchanged, so this changes *which due product goes first* rather than blindly increasing API traffic. Overdue-age weighting prevents colder products from starving forever.

### Current users keep their place during updates

Store, Price Signals, and product-detail live SSE rerenders capture the current viewport before DOM replacement and restore the same visible product/scroll position afterward. Client-build migrations also save the store query, category, sort, page number, and viewport in session storage before the cache-busting reload, then restore them after the new build renders. This means a live price/catalog update or deployment should not throw a shopper back to the top of the page or erase the search/page they were viewing.

## V3.7.21 explicit-vs-unlabeled variant ownership

V3.7.21 is additive to V3.7.20. No Product Catalog, live-search, lifecycle, price-history, rate-guard, Admin, or shopper-priority path is removed.

### Explicit-vs-unlabeled package ownership

Strong merchant identifiers are no longer treated as sufficient to collapse explicit package-duration variants. Titles such as `1-Year Combo Filter Set` and `2-Year Combo Filter Set` retain the same underlying Brand+MPN identity but receive different hard variant discriminators. The same duration rule is enforced by exact eBay competitor proof, so a shared MPN cannot prove that two different duration bundles are the same sellable product. Warranty durations are explicitly ignored as package discriminators.

Existing non-eBay offers with an explicit hard package variant now self-heal even when the current owner has no duration label at all. Startup catalog integrity repairs already-stored cases when the offer itself carries the same strong identity evidence; later Rakuten Product Catalog or Product Search observations provide a second repair path. Offer-linked price history and click relationships follow the corrected offer.

### eBay competitor recall

The exact-proof requirement is unchanged. The first scan still uses GTIN, ePID, or Brand+MPN as before. If that discovery pass yields no exact competitor, OfferGrid may use up to two bounded keyword recall probes by default: MPN-only and strict title. Every returned listing still has to pass exact `getItems` identity + variant proof before it can attach.

```env
EBAY_COMPETITOR_RECALL_ENABLED=true
EBAY_COMPETITOR_RECALL_SEARCHES=2
EBAY_COMPETITOR_RECALL_RESULTS=40
```

This improves recall for sellers that omit the brand from an eBay title or index a descriptive product title better than Brand+MPN, while keeping false-positive competitor claims fail-closed.

---

## V3.7.19 Rakuten Product Catalog SFTP sync

V3.7.19 is additive to V3.7.18. The existing live discovery path is unchanged:

```text
shopper / discovery query
   ├── eBay Browse
   └── Rakuten Product Search
```

A second Rakuten path now runs independently in the background:

```text
Rakuten Product Catalog SFTP
   ↓
approved advertiser full .txt.gz feeds
   ↓
validate gzip + HDR/TRL record count
   ↓
strict content-safety gate
   ↓
provider-neutral OfferGrid ingestion
   ↓
auto-publish valid products (configurable)
   ↓
delta feeds apply inserts / updates / deletes
```

The SFTP password is never sent to the browser after it is saved. Enter the replacement credentials in **Admin → API connections → Rakuten Advertising** and OfferGrid stores them through the same encrypted `data/private-config.json` vault used for other provider secrets.

Recommended Product Catalog settings:

```env
RAKUTEN_CATALOG_SYNC_ENABLED=true
RAKUTEN_SFTP_HOST=aftp.linksynergy.com
RAKUTEN_SFTP_PORT=22
RAKUTEN_SFTP_USERNAME=
RAKUTEN_SFTP_PASSWORD=
RAKUTEN_SFTP_TIMEOUT_MS=20000
RAKUTEN_CATALOG_AUTO_APPROVE=true
RAKUTEN_CATALOG_SYNC_MINUTES=30
RAKUTEN_CATALOG_FULL_REFRESH_HOURS=24
RAKUTEN_CATALOG_BATCH_SIZE=250
RAKUTEN_CATALOG_MAX_PRODUCTS_PER_FILE=0
```

`RAKUTEN_CATALOG_MAX_PRODUCTS_PER_FILE=0` means the complete approved advertiser feed is processed. A non-zero value is a diagnostic cap and intentionally disables full-feed missing-item reconciliation for that partial run.

Important safety/accuracy behavior:

- one SFTP connection is used at a time, staying below Rakuten's five-connection ceiling;
- only pipe-delimited `.txt.gz` Product Catalog files are ingested in this release;
- the gzip stream and Rakuten trailer row count are validated **before** OfferGrid mutates the catalog;
- full feeds reconcile only offers previously created from `rakuten-product-catalog`, so live Product Search offers are not removed by feed reconciliation;
- delta `D` rows mark the corresponding catalog-feed offer unavailable rather than deleting price history;
- full imports are split into configurable batches and yield at foreground-priority checkpoints so shoppers can cut in between work units;
- valid feed products can be auto-approved because the advertiser relationship/feed has already been approved in Rakuten; this can be disabled in Admin;
- state is persisted in `data/rakuten-catalog-state.json` so OfferGrid knows when each advertiser last received a full or delta refresh;
- the Admin Rakuten card includes **Test Rakuten connections** and **Sync Product Catalog now** controls.

The scheduler checks for deltas at the configured cadence and performs a full refresh at least every `RAKUTEN_CATALOG_FULL_REFRESH_HOURS`. The first check runs after HTTP startup rather than delaying startup.

## V3.7.18 Rakuten discovery fanout

Broad catalog discovery now uses one orchestration path:

```text
OfferGrid discovery query
        ├── eBay Browse search
        └── Rakuten Product Search
                 ↓
       strict original-query relevance gate
                 ↓
       normalized OfferGrid candidates
                 ↓
          catalog + price history
```

The fanout applies to:

- shopper-triggered live marketplace expansion;
- scheduled/autonomous eBay discovery rules;
- Admin marketplace search/import;
- starter-catalog population.

If the eBay background quota reserve is exhausted, the scheduled rule is no longer discarded wholesale: the eBay side is skipped while the Rakuten mirror may still run. A temporary Rakuten failure never disables a healthy eBay search. A healthy Rakuten result can likewise keep discovery useful while eBay is rate-deferred.

Rakuten Product Search is normalized into the existing provider-neutral OfferGrid candidate model using the returned advertiser, product-link ID, product name, retail/sale price, UPC, category, tracked `linkurl`, and image URL. The same explicit-content ingestion guard and strict shopper-query relevance gate used by the eBay discovery path are applied before Rakuten candidates are stored or auto-approved.

Rakuten access tokens expire quickly, so V3.7.18 can refresh them automatically when the Admin vault also contains the refresh token, developer Client ID, Client Secret, and Publisher Account ID/SID. Newly refreshed access/refresh tokens are written back through OfferGrid's encrypted private-config vault.

Recommended settings:

```env
RAKUTEN_SEARCH_ENABLED=true
RAKUTEN_ACCESS_TOKEN=
RAKUTEN_REFRESH_TOKEN=
RAKUTEN_CLIENT_ID=
RAKUTEN_CLIENT_SECRET=
RAKUTEN_ACCOUNT_ID=
RAKUTEN_LANGUAGE=en_US
RAKUTEN_SEARCH_CACHE_SECONDS=120
RAKUTEN_RATE_MIN_INTERVAL_MS=650
RAKUTEN_SEARCH_TIMEOUT_MS=12000
RAKUTEN_DEFAULT_COMMISSION_RATE=0.05
```

`RAKUTEN_RATE_MIN_INTERVAL_MS=650` serializes Product Search starts to stay below Rakuten's documented 100-calls/minute endpoint ceiling while preserving eBay's independent rate guard. Identical Rakuten queries are cached briefly and in-flight duplicates join the same request.

The eBay **exact competitor proof** scanner intentionally does not consume Rakuten candidates. That scanner is an eBay-specific identity-verification path (`getItems` + exact GTIN / Brand+MPN / ePID+Brand proof), not broad catalog discovery. Keeping it isolated preserves V3.7.4+ fail-closed competitor semantics.

## V3.7.17 precision recall + feature-regression audit

- Strict relevance remains the final gate: discovery expansion can broaden the marketplace request but cannot broaden what qualifies as a result.
- Interactive discovery now rotates through a conservative query plan rather than treating one literal eBay keyword search as the whole universe. Every variant preserves all meaningful original query terms.
- Example: `timing light` may probe `automotive timing light`, `ignition timing light`, `inductive timing light`, etc.; any returned listing must still pass relevance against the ORIGINAL `timing light` query.
- Ordinary hyphenated words are tokenized correctly (`timing-light` now matches `timing light`) while known technical compounds such as USB-C remain normalized safely.
- Two-word product phrases get a proximity guard so recall fixes do not admit accidental all-token matches such as `timing belt kit with work light`.
- Exhausted interactive search sessions become eligible for a fresh probe after `LIVE_SEARCH_EXHAUSTED_RETRY_MINUTES` instead of being frozen for the full in-memory session TTL.
- Home hero padding increased for visual breathing room; no behavior or feature is removed.
- Feature audit from the originally uploaded V3.7.7 baseline found no removed public/admin routes and no removed exported database capabilities in V3.7.16. The old nearest/related-product fallback remains intentionally retired because it conflicts with precision/trust.

Recommended recall controls:

```env
LIVE_SEARCH_QUERY_VARIANTS=6
LIVE_SEARCH_EXHAUSTED_RETRY_MINUTES=15
```

## V3.7.16 precision discovery + unified shopper theme

- Search relevance is now **all-intent-term precision**, replacing the old ~60% token-overlap acceptance. A search such as `crowsfoot wrench set` cannot be filled by impact wrenches, impact drivers, ratchets, or other adjacent tool-category inventory.
- Relevance uses title/brand/category context with product-language normalization (plural forms, `crow foot`/`crowsfoot`, USB-C, M.2, common `printer/printing`-style morphology, drive fractions, etc.) while still requiring every meaningful search concept.
- `/api/products` reports whether the requested page has enough relevant tracked products. Discovery is based on **page capacity**, not only zero results.
- Page 1 targets one full page of relevant products; page 2 targets two pages, and so on. If capacity is short, user-triggered eBay discovery continues from deeper Browse offsets instead of repeatedly searching only the first result page.
- Existing exact matches render immediately while catalog expansion runs. Discovery is user-priority network work and does not remove the V3.7.15 event-loop/background-maintenance priority model.
- Up to `LIVE_SEARCH_MAX_PAGES_PER_QUERY` marketplace pages are examined per query session. Once the marketplace or configured search budget is exhausted, the final partial page ends with a clear **End of Results** card. Unrelated filler is never substituted.
- Relevant discoveries can be tracked before exact-detail verification, but unverified eBay products remain unpublished exactly as before. eBay rate-guard/reserve behavior is unchanged.
- Explicit search queries are rejected before any marketplace call. Explicit product candidates are also rejected inside `ingestCandidates()`, making the database ingestion boundary the final fail-closed guard for eBay, Awin, demo/manual/import paths. Admin edits and eBay discovery rules cannot convert/create explicit catalog content either.
- The Disclosure page now uses the visual direction selected for OfferGrid and fills its previous empty right-hand space with a compressed local price-intelligence image. The same glass/grid/blue-cyan design language, brand mark, typography, panels, and navigation treatment are shared across shopper pages.

Recommended precision-discovery defaults:

```env
LIVE_SEARCH_ENABLED=true
LIVE_SEARCH_MARKETPLACE_PAGE_SIZE=200
LIVE_SEARCH_PAGES_PER_INTERACTION=4
LIVE_SEARCH_MAX_PAGES_PER_QUERY=8
LIVE_SEARCH_VERIFY_LIMIT=100
LIVE_SEARCH_TIMEOUT_MS=20000
USER_SEARCH_RULE_LIMIT=120
```

The defaults allow OfferGrid to inspect up to 1,600 raw marketplace rows for a difficult query before declaring a clean end. Exact verification remains quota-aware; increasing search depth does not bypass eBay's existing rate guard.

## V3.7.15 interactive-priority responsiveness

- User-generated HTTP requests have hard priority over scheduled work. Long-lived SSE/health endpoints are excluded from the foreground counter.
- `/go/:offerId` no longer performs a live eBay request before returning HTTP 302. Stored trust, approval, availability, and affiliate URL checks still run synchronously; stale eBay refresh runs afterward in the background lane.
- `/api/products/:id/live` returns trusted cached product intelligence immediately and revalidates a stale best eBay offer after the response. Existing SSE price events update open pages when the refresh lands.
- Background verification/sanitizer apply work is partitioned with `setImmediate()`/interactive checkpoints, so pending client sockets can run between work units.
- Scheduled runtime writes use deferred quiet-window persistence instead of forcing a synchronous catalog snapshot immediately after every mutation. Manual foreground operations retain immediate durability unless explicitly deferred.
- Auto-sync ingestion and rule auto-approval use indexed product/offer/history lookup and deferred persistence on background cycles.
- Versioned JS/CSS receives reusable browser caching; dynamic API/pricing data remains `no-store`. Shopper pages preconnect/dns-prefetch eBay to reduce DNS/TCP/TLS latency before merchant navigation.
- Admin now shows active user-priority requests, yielded background time, slow-request counts, event-loop utilization/delay, and includes a click-counter reset that preserves historical lifecycle evidence.
- New tuning knobs: `INTERACTIVE_PRIORITY_*`, `INTERACTIVE_BACKGROUND_APPLY_CHUNK`, `INTERACTIVE_SLOW_REQUEST_MS`, `RUNTIME_PERSIST_DELAY_MS`, `DEFERRED_WRITE_QUIET_MS`.

## What changed

### 1. The JSON database is now memory-backed while the server is running

Older releases reparsed `data/catalog.json` from disk for almost every database operation.

At thousands of products, that becomes increasingly expensive.

V3.0 loads the database once into memory and keeps the atomic JSON file as durable storage.

Writes still use:

```text
catalog.json.tmp
→ atomic rename
→ catalog.json
```

but public reads no longer repeatedly read and parse the entire JSON file.

`DB_PRETTY_JSON=false` is the default to make disk snapshots smaller and faster.

### 2. Public catalog search uses worker threads

V3.0 uses Node.js `worker_threads` for the CPU-bound part of public catalog searching and
sorting.

Default:

```env
CATALOG_SEARCH_THREADS=2
```

The workers maintain a lightweight search index containing only:

```text
product id
category
search text
Deal Heat
best price
best score
verification rank
updated timestamp
```

They do not own or modify the database.

The main Node thread remains responsible for database integrity and API responses.

This avoids unsafe multi-process writes while still moving catalog filtering/ranking off the
main event loop.

### 3. 100 products per page

The storefront now requests:

```text
pageSize=100
```

and renders pagination controls.

The backend sorts/filter products using cached product summaries, slices the requested page,
and only performs full hydration on those 100 products.

It no longer hydrates an entire 10,000-item catalog just to display the first page.

### 4. Cached product summaries

Each product now keeps internal cached values for:

```text
current display offer
display price
offer score
verification rank
Deal Heat / price statistics
search text
```

These are refreshed when that product changes.

That allows public listing pages to sort raw products first and hydrate only the current page.

### 5. Faster ingestion lookups

Ingestion now builds in-memory indexes for:

```text
provider + external listing ID
product ID
canonical product ID
variant bucket
```

during an import.

This removes repeated full-array searches while processing a batch of marketplace results.

### 6. Faster exact eBay price verification

V2.9 verified one exact eBay listing per request.

V3.0 uses the Browse API `getItems` method to verify multiple item IDs per request.

Defaults:

```env
EBAY_PRICE_VERIFY_ENABLED=true
EBAY_PRICE_VERIFY_MINUTES=10
EBAY_PRICE_VERIFY_OFFERS_PER_RUN=320

EBAY_PRICE_VERIFY_BATCH_SIZE=20
EBAY_VARIATION_VERIFY_BATCH_SIZE=10
EBAY_PRICE_VERIFY_CONCURRENCY=4
```

Single-item listings are grouped into batches of up to 20.

Variation item IDs use conservative batches of up to 10.

Multiple getItems batches can be in flight concurrently.

This is I/O concurrency, not CPU threading: Node can efficiently wait for several eBay HTTP
requests at the same time without blocking the event loop.

### 7. One database write per price-verification pass

This is one of the largest performance changes.

Older precision verification did approximately:

```text
get one eBay item
update one offer
serialize entire database
write catalog.json

repeat
```

V3.0 does:

```text
select verification queue
        ↓
bulk getItems requests concurrently
        ↓
collect all exact item details
        ↓
apply all verified changes in memory
        ↓
rescore touched products
        ↓
record verified history
        ↓
ONE atomic database write
```

A 320-offer pass therefore does not serialize the full catalog 320 times.

### 8. Startup verification burst

V3.0 aggressively catches up after a restart without permanently increasing maintenance load.

Defaults:

```env
EBAY_STARTUP_VERIFY_BURST_RUNS=5
EBAY_STARTUP_VERIFY_BURST_DELAY_MS=8000
```

The server can perform up to five fast verification passes after startup and stops early when
all public eBay offers are already verified.

With the default 320 offers/pass, this can refresh up to roughly 1,600 queued offers shortly
after launch.

### 9. Exact verification still controls public price claims

All V2.9 safety rules remain.

Unverified eBay search-summary prices do not become public claims such as:

```text
lowest eBay price
verified market-low
seller price rank
verified eBay history
```

Public cards can say:

```text
Verifying price…
```

until exact item-detail data is available.

### 10. High quantity remains separate from pack quantity

V3.0 preserves the precision model:

```text
estimated stock quantity ≠ lot size
lot size ≠ buyer limit
buyer limit ≠ title pack count
pack count ≠ unit price
```

For example:

```text
500 available
8-pack
buyer limit 12
$4.06 / spool
$32.49 listing price
```

remain independent facts.

### 11. Zero-result searches automatically search eBay

When a user searches OfferGrid and the local catalog contains no matching products:

```text
local search
    ↓
0 products
    ↓
storefront enters LIVE MARKETPLACE SEARCH state
    ↓
eBay Browse search
    ↓
query-relevance filter
    ↓
new listings ingested
    ↓
exact eBay getItems verification
    ↓
verified products auto-published
    ↓
same search reloads
```

The user does not immediately hit a dead "No products found" screen.

The search UI explains that OfferGrid is actively looking for marketplace listings and
verifying them.

### 12. User searches grow the catalog

A zero-result user query can become a persistent eBay discovery rule.

Default cap:

```env
USER_SEARCH_RULE_LIMIT=120
```

Rules are deduplicated by normalized query.

This means searches from actual visitors can help expand the catalog toward the 10,000-item
goal.

### 13. Search relevance gate

Live eBay recovery does not blindly ingest every returned result.

OfferGrid requires meaningful query-token overlap.

Alphanumeric model tokens in the user's query must appear in the candidate title.

This prevents a specific model query from being populated by loosely related products.

### 14. In-flight query deduplication

If multiple visitors trigger the same missing search while it is already running, OfferGrid
reuses the existing in-flight promise instead of issuing duplicate marketplace requests.

### 15. Related fallback (intentionally retired)

Older builds could show the nearest catalog products when no exact result was ready. That behavior
was removed in V3.7.16 because category adjacency is not sufficient evidence of query relevance.
V3.7.17 restores recall on the **discovery side** instead: OfferGrid may try additional marketplace
queries that preserve the original intent, but it never pads shopper results with unrelated products.
The original query still remains stored as a discovery rule for future growth.

### 16. Discovery runs concurrently

The 20-minute autonomous catalog-growth cycle remains:

```env
AUTO_SYNC_ENABLED=true
AUTO_SYNC_MINUTES=20
DISCOVERY_RULES_PER_CYCLE=24
```

V3.0 adds:

```env
DISCOVERY_IO_CONCURRENCY=4
```

Instead of waiting for 24 marketplace HTTP searches sequentially, up to four discovery rules
can wait on external APIs concurrently.

The actual database mutation portions remain serialized by JavaScript's event loop.

### 17. Buffered low-value writes

Two high-frequency events no longer force an immediate full-catalog disk snapshot every time:

```text
outbound click logging
discovery-rule run telemetry
```

They update the in-memory database immediately and coalesce disk persistence over a short
window.

Price, product, approval, verification and integrity mutations still use explicit atomic
database persistence.

### 18. Verbose command-line activity

Default:

```env
VERBOSE_LOGGING=true
```

The console now reports active operations with UTC timestamps, including:

```text
catalog worker indexing
catalog page request timing
eBay searches
OAuth refresh
bulk getItems verification
verification batch lanes
price changes
live zero-result searches
candidate ingestion
discovery rule start/finish
20-minute discovery lanes
startup verification recovery
catalog integrity
competitor cleanup
```

Example:

```text
[2026-08-27 22:18:01 UTC] [PRICE-VERIFY] verifying 320 offers in 16 eBay getItems batch(es)
[2026-08-27 22:18:01 UTC] [EBAY-ITEMS] getItems batch — started {"requested":20}
[2026-08-27 22:18:02 UTC] [PRICE-CHANGE] offer 481 changed {"oldPrice":39.99,"newPrice":34.99,"delta":-5}
[2026-08-27 22:18:02 UTC] [HTTP-SEARCH] catalog page served {"page":1,"pageSize":100,"total":4832,"threaded":true,"ms":27}
```

Set:

```env
VERBOSE_LOGGING=false
```

if you later want a quiet server.

## Recommended live settings

```env
VERBOSE_LOGGING=true
DB_PRETTY_JSON=false

STORE_PAGE_SIZE=40
CATALOG_SEARCH_THREADS=2

AUTO_SYNC_ENABLED=true
AUTO_SYNC_MINUTES=20
DISCOVERY_RULES_PER_CYCLE=24
DISCOVERY_IO_CONCURRENCY=4

EBAY_PRICE_VERIFY_ENABLED=true
EBAY_PRICE_VERIFY_MINUTES=10
EBAY_PRICE_VERIFY_OFFERS_PER_RUN=320
EBAY_PRICE_VERIFY_BATCH_SIZE=20
EBAY_VARIATION_VERIFY_BATCH_SIZE=10
EBAY_PRICE_VERIFY_CONCURRENCY=4
EBAY_LIVE_VERIFY_MAX_AGE_MINUTES=10

EBAY_STARTUP_VERIFY_BURST_RUNS=5
EBAY_STARTUP_VERIFY_BURST_DELAY_MS=8000

LIVE_SEARCH_ENABLED=true
LIVE_SEARCH_RESULTS=60
LIVE_SEARCH_VERIFY_LIMIT=60
LIVE_SEARCH_TIMEOUT_MS=15000
USER_SEARCH_RULE_LIMIT=120

CATALOG_INTEGRITY_ENABLED=true
CATALOG_INTEGRITY_HOURS=6
```

## Existing V2.9 precision protections remain

V3.0 retains:

- exact listing ownership by `provider + externalId`
- pack/weight/capacity/model-safe normalization
- old-data integrity repair
- duplicate listing cleanup
- verified-only eBay price history
- exact item verification on product views
- outbound stale-listing verification
- strict eBay competitor matching
- inferred-ePID protections
- 24-hour competitor cleanup
- deterministic 20-minute search expansion
- 10,000-product catalog target
- encrypted Admin credential vault
- eBay Marketplace Account Deletion compliance

## Upgrade from V2.9

Copy these persistent files:

```text
.env
data/catalog.json
data/private-config.json
```

Keep the exact same:

```text
CONFIG_ENCRYPTION_KEY
```

Then add the V3.0 performance settings shown above.

Run:

```bat
npm install
npm start
```

The existing catalog remains compatible. V3.0 rebuilds its internal search/cache summaries at
startup.

## Important architecture note

More threads are not automatically faster.

V3.0 uses:

```text
worker_threads
```

for CPU-bound catalog filtering/ranking.

It uses:

```text
bounded Promise concurrency
```

for eBay and discovery HTTP requests.

It intentionally does **not** start multiple Node processes that all mutate `catalog.json`,
because that would create data races in the current JSON-backed architecture.

If OfferGrid substantially exceeds the planned 10k catalog or reaches high concurrent traffic,
the next major storage upgrade should be moving the durable catalog to PostgreSQL/SQLite rather
than trying to add more writers to one JSON file.

---

# V3.1 RESPONSIVE

V3.1 is a **presentation-only refinement of V3.0 TURBO**. It was tuned from
Galaxy S25 Ultra screenshots and intentionally leaves the backend and browser
JavaScript behavior unchanged.

## Functional freeze

The following V3.0 code is byte-for-byte unchanged in V3.1:

- `server.js`
- `lib/*.js`
- `providers/*.js`
- `services/*.js`
- `workers/*.js`
- `scripts/*.js`
- `public/js/*.js`

That preserves:

- 100-product pagination
- worker-thread catalog search
- zero-result live eBay discovery
- automatic catalog growth
- deterministic search expansion
- bulk eBay `getItems` price verification
- startup verification bursts
- competitor scanning/cleanup
- duplicate protection
- price-history integrity
- Admin/API behavior

## Mobile fixes

The mobile navigation is now a compact 2×2 dropdown instead of a large panel
that can consume most of the viewport.

Public listing media is forced into a true square `1 / 1` box with
`object-fit: contain`. This applies to full store cards and Trending preview
cards, so the image no longer stretches vertically when the text column is
taller.

On phones, store and Trending cards use a compact horizontal layout:

```text
┌────────────┬─────────────────────┐
│            │ verified / heat     │
│  SQUARE    │ product title       │
│  IMAGE     │ price               │
│            │ verify & compare    │
└────────────┴─────────────────────┘
```

The product-detail page now forcefully switches to a one-column layout after
the V2.9 rules. This fixes the old cascade bug where a later desktop `.detail`
rule could override the earlier mobile breakpoint and squeeze the entire
product description into a very narrow right-hand column.

Additional changes include:

- smaller mobile titles
- tighter badge sizing
- denser card spacing
- two-column mobile category/sort controls
- full-width search and search button
- readable seller/offer rows
- more compact market-comparison panels
- smaller mobile hero typography
- better touch targets
- safe-area-aware mobile header/footer spacing
- no hover lift effects on touch devices

## Desktop refinements

Desktop cards now use consistent square product media while retaining the
four-column layout at large widths. Card spacing, typography, button sizing,
and product-detail proportions were tightened without altering the underlying
data or interactions.



---

# V3.2 INTELLIGENCE

V3.2 formalizes OfferGrid's public product category:

> **OfferGrid is a price-intelligence purchasing assistant.**

Affiliate links remain a transparent monetization mechanism, not the site's
primary product identity.

## Public positioning changes

- `Store` navigation → `Price Intelligence`
- `Trending Deals` → `Price Signals`
- product CTAs emphasize analysis (`View price intelligence`)
- homepage explains the purchasing-assistant workflow
- footer describes verified prices, market comparisons, and recorded history
- affiliate disclosure remains directly accessible
- methodology separates purchasing intelligence from monetization-aware offer ranking

## New product-page purchasing intelligence

V3.2 adds a decision-support panel derived entirely from data OfferGrid already
returns:

- current purchase signal
- 30-day price position
- price momentum
- current price versus 30-day average
- decision-confidence level
- current seller context
- Deal Heat

No new marketplace claim is invented. When history is insufficient, the panel
says the signal is still building.

## Functionality preservation

V3.2 does not modify:

- `server.js`
- `lib/*.js`
- `providers/*.js`
- `services/*.js`
- `workers/*.js`
- `scripts/*.js`

The V3.0/V3.1 backend remains byte-for-byte unchanged.

Public JavaScript changes are limited to wording and rendering of additional
decision-support information from fields already returned by the existing API.
All existing fetch endpoints, event-listener counts, `/go/:offerId` routes, and
product-page routes are contract-checked during the build.


---

# V3.3 RATEGUARD

V3.3 protects the eBay Browse API without removing the V3.0–V3.2
automation, exact-price verification, live-search recovery, mobile UI, or
price-intelligence purchasing-assistant experience.

## The eBay 12001 scan error

The response:

```text
errorId 12001
The call must have a valid 'q', 'category_ids', 'charity_ids', 'epid' or 'gtin'
```

is an invalid Browse search request, not a rate-limit response.

V3.3 prevents that class of request before it reaches eBay:

- keyword queries are normalized and must contain usable text
- GTIN values are format/checksum validated
- ISBN-10 is validated
- ePID values are normalized and validated
- an eBay search is not sent unless OfferGrid has a valid `q`, `gtin`, or `epid`
- malformed discovery rules are skipped locally
- invalid stored identifiers fall back to Brand + MPN or conservative title search
- if eBay still returns 12001 for a syntactically valid exact identifier, the
  competitor scanner retries through the conservative fallback path

The fallback is evaluated as Brand + MPN or strict-title matching; it is not
misrepresented as an exact GTIN/ePID match.

## Persistent rolling API budget

OfferGrid records guarded eBay call usage in:

```text
data/ebay-api-usage.json
```

The state survives normal server restarts.

It maintains separate rolling 24-hour budgets for:

```text
Browse methods other than getItems
getItems
```

Defaults:

```env
EBAY_RATE_GUARD_ENABLED=true
EBAY_BROWSE_DAILY_LIMIT=5000
EBAY_GETITEMS_DAILY_LIMIT=5000
EBAY_RATE_SAFETY_MARGIN=300
EBAY_INTERACTIVE_RESERVE=900
EBAY_RATE_MIN_INTERVAL_MS=180
EBAY_RATE_LIMIT_COOLDOWN_MINUTES=60
```

With those defaults OfferGrid uses 4,700 calls as its own safe hard cap for
each bucket.

Background automation stops at 3,800 guarded calls, preserving 900 calls of
safe capacity for real user interactions. The remaining 300-call safety
margin is not deliberately scheduled by OfferGrid.

## Priority classes

### Background

Background traffic stops before consuming the interactive reserve:

- autonomous catalog discovery
- scheduled exact-price verification
- startup verification bursts
- competitor scans
- background identity enrichment

### Interactive

Interactive work may use the reserved capacity:

- a visitor's zero-result live marketplace search
- exact refresh from a product view
- exact refresh before an outbound merchant click
- explicit Admin eBay imports / verification

This keeps automation from starving the purchasing-assistant experience.

## Request pacing

All guarded Browse/getItems calls pass through a serialized permit gate.

Default:

```env
EBAY_RATE_MIN_INTERVAL_MS=180
```

This limits short bursts while the rolling budget protects total usage.

## Remote rate-limit response

If eBay returns HTTP 429 or an explicit call-limit message, OfferGrid:

1. records the provider rate-limit event
2. honors `Retry-After` when supplied
3. otherwise starts the configured cooldown
4. blocks subsequent guarded requests during that cooldown
5. reports the deferral through verbose CLI output instead of retry-hammering eBay

## Short eBay search cache

Identical eBay searches are cached in process for a short period:

```env
EBAY_SEARCH_CACHE_SECONDS=120
```

This reduces duplicate calls from overlapping automation or repeated visitor
queries without turning marketplace results into a long-lived stale cache.

## Bulk-verification anti-amplification

V3.3 retains bulk `getItems` verification but changes failure recovery.

A rate-limited bulk batch is never expanded into one individual `getItem`
request per listing.

If eBay rejects a `getItems` batch with HTTP 400, OfferGrid recursively splits
that batch through `getItems` to isolate malformed/expired IDs. It does not
immediately explode a 20-item batch into 20 calls against the other Browse
quota.

Successful bulk responses that omit IDs use bounded single-item fallback:

```env
EBAY_BACKGROUND_MISSING_FALLBACK_MAX=0
EBAY_INTERACTIVE_MISSING_FALLBACK_MAX=2
```

So routine background verification simply leaves omitted IDs for a later pass.

## Quota-aware automation

Before a 20-minute discovery cycle dispatches eBay rules, OfferGrid checks
the remaining background Browse budget.

Before scheduled price verification selects listings, OfferGrid checks the
remaining `getItems` background budget.

Startup verification bursts stop when they would consume the interactive
reserve.

Competitor scanning stops the rest of its pass when the rate guard is reached
instead of generating repeated rejected calls.

## Admin telemetry

The Admin automation panel now shows:

```text
Browse calls / rolling 24h
Browse background calls remaining
Browse total safe calls remaining

getItems calls / rolling 24h
getItems background calls remaining
getItems total safe calls remaining
```

Verbose terminal output also reports `[EBAY-RATE]` permits, deferrals,
cooldowns, and remaining budget.

## Upgrade note

No new environment variables are required; the defaults above apply
automatically.

For an explicit Production configuration, copy the V3.3 block from
`.env.live.example`.

Because releases before V3.3 did not persist their eBay usage, the local
rolling counter necessarily starts at zero on the first V3.3 launch. If the
remote account is already exhausted from earlier activity, the first actual
eBay rate-limit response activates V3.3's cooldown and prevents repeated
requests after that response.


---

# V3.4 LIFECYCLE

V3.4 adds an automated product-pruning lifecycle so OfferGrid can keep
expanding without retaining every dead marketplace record forever.

The core lifecycle is:

```text
ACTIVE
  ↓
DORMANT
  ↓
STALE
  ↓
PRUNABLE
  ↓
ARCHIVED tombstone
  ↓
REACTIVATED if the market sees it again
```

The lifecycle is deliberately conservative. `365 days` is the point where an
unprotected product can become eligible for pruning; it is not an unconditional
hard delete.

## Lifecycle states

### ACTIVE

A product is ACTIVE while it has a currently active offer/listing.

It receives the normal OfferGrid refresh behavior.

A short absence does not instantly downgrade the record because marketplace
availability can flap.

### DORMANT

Default:

```env
PRODUCT_DORMANT_DAYS=120
```

This sits in the requested 90–180 day window.

A product with no active listing and no newer positive price/listing evidence
becomes DORMANT after roughly 120 days.

Dormant products are retained in the canonical catalog but receive sparse
revival probes rather than normal-frequency competitor scans.

Default:

```env
PRODUCT_DORMANT_REFRESH_DAYS=7
```

### STALE

Default:

```env
PRODUCT_STALE_DAYS=365
```

A product reaches STALE when there has been no active listing or positive
price observation for one year.

STALE is not automatically deletion-ready when the record has reasons to
preserve richer history.

### PRUNABLE

Default:

```env
PRODUCT_PRUNABLE_DAYS=365
PRODUCT_PRUNE_GRACE_DAYS=30
```

A weak/unprotected product can become PRUNABLE after one full year without
market activity.

PRUNABLE means *eligible for cleanup*, not deleted.

A 30-day grace period leaves it visible to lifecycle telemetry before OfferGrid
archives its expensive rows.

### ARCHIVED tombstone

After the grace period, an eligible PRUNABLE product becomes a lightweight
canonical tombstone.

OfferGrid keeps the product itself and its identity. It discards expensive,
dead runtime data.

The tombstone preserves:

```text
OfferGrid product ID
canonical key
GTIN / UPC / EAN when known
MPN / model number
ePID when known
normalized title
normalized brand
display title / brand
category
created date
last active date
last positive observation date
date it became prunable
archive date
previous public/approved status
offer-count/provider summary
lifetime click summary
long-term price summary
compressed historical price buckets
```

The archive therefore does not behave like:

```sql
DELETE FROM products WHERE last_seen < ...
```

The canonical identity remains available for future matching.

## Protected retention

Some products naturally disappear for long periods:

- rare replacement parts
- seasonal products
- older electronics
- discontinued OEM hardware
- collectibles
- products with meaningful historical traffic

V3.4 therefore scores preservation signals before allowing a one-year-old
record to become PRUNABLE.

Signals include:

```text
known GTIN / UPC / EAN
known Brand + MPN
meaningful price-history depth
historical outbound traffic
recent user traffic
previous publication
previous reactivation
manual lifecycle pin
```

A strong GTIN or Brand+MPN is enough to receive longer retention by default.

Protected records use:

```env
PRODUCT_PROTECTED_RETENTION_DAYS=730
```

so richer records normally remain STALE for up to two years before becoming
PRUNABLE.

This value is configurable.

A manual pin prevents automatic archival entirely:

```text
Admin product card
→ Pin lifecycle
```

or:

```http
POST /api/admin/products/:id/lifecycle/pin
{"pinned": true}
```

## Reactivation instead of duplication

Archived records remain part of OfferGrid's identity-matching index.

When a marketplace scan or visitor search finds the product again:

```text
new listing discovered
        ↓
canonical / identifier / safe variant match
        ↓
existing archived product ID found
        ↓
ARCHIVED → ACTIVE
        ↓
new offer attached to old product
        ↓
exact verification / auto-approval rules run normally
```

A new OfferGrid product ID is not created when the tombstone can be matched
safely.

Archived products intentionally reactivate as drafts. The existing exact-price
verification and auto-publication rules decide when they are safe to show
publicly again.

This prevents an old tombstone from immediately publishing an unverified eBay
search-summary price.

## Long-term price-history compaction

V3.4 no longer simply throws away old price observations when the raw-history
window gets large.

Defaults:

```env
PRICE_HISTORY_RAW_DAYS=90
PRICE_HISTORY_WEEKLY_DAYS=365
PRICE_AGGREGATE_RETENTION_DAYS=3650
PRICE_COMPRESSION_HOURS=12
```

The default retention shape is:

```text
0–90 days
    raw verified observations

90–365 days
    weekly aggregates

365 days–10 years
    monthly aggregates
```

Each aggregate stores:

```text
sample count
low
high
weighted average
first price
last price
start/end time
currency
verified-sample count
granularity / bucket
```

The existing product-page `ALL` history view receives the compressed buckets
as normal history points, so long-term price intelligence remains usable
without preserving every six-hour sample forever.

Integrity repair also understands compressed buckets. If two strong canonical
records merge, aggregate history is remapped and deduplicated.

If integrity repair discovers that one historical product record contained
incompatible variants, ambiguous compressed history on that source record is
discarded rather than pretending it can be assigned safely to one variant.

## Lifecycle-aware refresh frequency

The existing eBay competitor scanner now also acts as a conservative revival
probe.

Default cadence:

```text
ACTIVE      existing normal competitor cadence
DORMANT     one eligible probe about every 7 days
STALE       one eligible probe about every 30 days
PRUNABLE    no background marketplace probing
ARCHIVED    no background marketplace probing
```

Dormant/stale revival probes use the product's durable identifiers or strict
title fallback.

They deliberately skip old-listing identity enrichment calls when the product
is already inactive, avoiding an unnecessary `getItem` call against a listing
known to be old.

All of these eBay probes still pass through V3.3 RATEGUARD, so lifecycle
maintenance does not bypass API-budget protection.

## Live catalog target behavior

Archived tombstones do not count against:

```env
CATALOG_TARGET_PRODUCTS=10000
```

For example:

```text
8,500 live/non-archived products
2,000 archived canonical tombstones
```

counts as:

```text
8,500 / 10,000 live catalog target
10,500 total canonical records
```

This lets autonomous discovery continue replacing dead inventory while the
identity/history layer can remain larger than the current live catalog.

## Archived traffic preservation

When a product is archived, raw click rows for that product can be removed
while a lightweight lifetime click summary is retained.

OfferGrid's lifetime analytics include that archived summary, so cleanup does
not make historical traffic disappear from the business-level totals.

## Automation

Lifecycle maintenance runs automatically at startup and then periodically.

Default:

```env
PRODUCT_LIFECYCLE_ENABLED=true
PRODUCT_LIFECYCLE_HOURS=24
```

The startup lifecycle pass runs after the existing catalog-integrity and
competitor-cleanup passes.

A one-time backup is created before V3.4 lifecycle cleanup:

```text
data/catalog.pre-v340-lifecycle.json
```

Audit reports are appended to:

```text
data/product-lifecycle.jsonl
```

Both are excluded from Git.

## Admin controls

V3.4 adds:

```text
Run lifecycle cleanup
Pin lifecycle / Unpin lifecycle
```

and Admin telemetry for:

```text
ACTIVE products
DORMANT products
STALE products
PRUNABLE products
ARCHIVED tombstones
raw price observations
compressed price buckets
```

Manual endpoints:

```http
POST /api/admin/catalog/lifecycle
POST /api/admin/catalog/history/compress
POST /api/admin/products/:id/lifecycle/pin
```

## Safety philosophy

V3.4 prefers:

```text
compress > discard
archive identity > hard delete
reactivate > duplicate
protect meaningful history > blindly apply a date threshold
```

The existing manual Delete button remains a true hard delete for an
administrator who explicitly wants to remove a product and all retained
history.


---

# V3.5 MICROCHARTS

V3.5 turns the unused lower-left space in OfferGrid's horizontal mobile
product cards into a second square price-intelligence surface.

The mobile card now reads visually as:

```text
┌──────────────┬────────────────────────────┐
│              │ verification / heat        │
│   PRODUCT    │ product title              │
│    IMAGE     │ current price              │
│     1:1      │ seller / checked time      │
├──────────────┤                            │
│ PRICE        │ View price intelligence    │
│ HISTORY      │                            │
│ MICROCHART   │                            │
│     1:1      │                            │
└──────────────┴────────────────────────────┘
```

The price-history panel is **exactly the same width and 1:1 aspect ratio as the
product image**.

## Real OfferGrid history only

The card graph does not fabricate a line from average/low/high summary values.

It is generated from OfferGrid's real existing price-history system:

- recent raw verified observations
- V3.4 weekly aggregates
- V3.4 monthly aggregates

If fewer than two usable observations exist, the square remains in place and
says:

```text
PRICE HISTORY
Building
More verified observations needed
```

## No per-card API requests

The storefront can render up to 100 products per page. V3.5 does **not** make
one additional HTTP request per card.

Each product receives a cached `priceSparkline` of at most 18 points.

On full cache rebuilds, OfferGrid builds one shared history index and then
refreshes every product from that index. This avoids repeatedly scanning the
entire history dataset for every one of thousands of products.

The product list response only carries the tiny cached line.

## Sparkline payload

A point contains only lightweight chart information:

```text
timestamp
price
optional aggregate low/high
aggregate sample count
raw/aggregated flag
weekly/monthly granularity when applicable
```

At most 18 points are exposed on a storefront card.

## Card graph

The microchart displays:

- tracked price line
- subtle area fill
- three horizontal reference guides
- current endpoint
- tracked low
- recent direction versus previous observation
- approximate visible span (`30D`, `90D`, or `1Y`)

Clicking the graph opens the same OfferGrid product-intelligence page as the
product image.

The graph is intentionally mobile-only because V3.1's horizontal mobile card
is where the unused square-sized space exists. Desktop keeps the established
four-column visual density.

## Functional preservation

V3.5 does not change:

- eBay API behavior
- V3.3 rate guard
- discovery
- exact price verification
- user zero-result marketplace search
- competitor matching
- product lifecycle/pruning
- tombstone reactivation
- auto approval
- affiliate routing
- product-page purchasing intelligence
- Admin backend behavior


---

# V3.6 SIGNATURE GRID

V3.6 makes the price-history visualization a defining OfferGrid result-card
characteristic on both desktop and mobile.

## Large desktop

The storefront intentionally changes from four compact products per row to
two larger intelligence cards per row.

Each result begins with two equal square surfaces:

```text
┌───────────────────────────────────────────────────────────┐
│ ┌──────────────────────┐ ┌──────────────────────┐         │
│ │                      │ │ PRICE HISTORY        │         │
│ │    PRODUCT IMAGE     │ │                      │         │
│ │         1:1          │ │       ╲__╱╲__        │         │
│ │                      │ │                      │         │
│ └──────────────────────┘ └──────────────────────┘         │
│                                                           │
│ VERIFIED · DEAL HEAT                                      │
│ Product title                                             │
│ Current verified price                                    │
│                                                           │
│ PRICE SIGNAL                         BUY WINDOW            │
│ 30D AVG      30D LOW      MOMENTUM      MARKET            │
│                                                           │
│                  View price intelligence                  │
└───────────────────────────────────────────────────────────┘
```

This trades raw listing density for substantially more decision context.

## New card-level intelligence

Using data already returned by OfferGrid, cards now surface:

- price signal: new tracked low / buy window / worth considering / typical /
  wait & compare / history building
- 30-day average
- current price versus recent average
- 30-day low
- current position in the recent range
- momentum versus the previous tracked observation
- tracked sample count
- current marketplace/seller context

The existing Deal Heat, exact-price verification, merchant, last-checked time,
and data-accuracy links remain.

## Responsive strategy

### >= 1121px

Two signature cards per row with equal square product-image and price-history
surfaces.

### 851–1120px

One generous card per row. The image/chart pair stays side-by-side rather than
shrinking into decorative thumbnails.

### <= 650px

The established V3.5 phone composition remains:

```text
IMAGE        PRODUCT / PRICE INTELLIGENCE
CHART        PRODUCT / PRICE INTELLIGENCE
```

The new metrics collapse into a compact 2×2 intelligence grid.

### <= 380px

Secondary descriptions are reduced before labels are allowed to collide.

## No new data/API cost

V3.6 reuses fields already present in V3.5:

- `priceStats`
- `priceSparkline`
- `ebayCompetition`
- `marketComparison`
- current offers

Therefore the richer interface adds:

```text
0 new eBay calls
0 new per-card HTTP requests
0 new background jobs
0 new database schema requirements
```

## Functional freeze

V3.6 does not modify the backend or marketplace engine. V3.3 RATEGUARD,
V3.4 lifecycle/pruning/reactivation, V3.5 cached microcharts, live marketplace
search, exact verification, autonomous discovery, worker-thread search,
100-item pagination, integrity repair, and affiliate routing remain intact.


---

# V3.7 LIVE SYNC

V3.7 adds automatic stale-client recovery and Server-Sent Event live synchronization. A known older client also sends its executing build version to `/api/config`; when it differs from the server, OfferGrid replies with `Clear-Site-Data: "cache"` so browser-managed HTTP cache is purged before the guarded one-time reload. HTML/JS/CSS now revalidate, top-level assets use `?v=3.7.0`, and `common.js` compares its loaded build against uncached `/api/config`. OfferGrid-owned Cache Storage and old catalog/data cache keys are cleared on version changes; same-origin service workers are asked to update; a mismatched open tab reloads once onto the current build. Version checks repeat on focus, visibility changes, and every two minutes.

Public live updates use `GET /api/live/stream`; Admin uses authenticated `GET /api/admin/live/stream`. Marketplace workers update the database once, then OfferGrid emits tiny local SSE events. Connected shoppers refresh OfferGrid's own catalog/product APIs only, so live browsing does not multiply eBay calls.

Visible price changes refresh and briefly highlight affected cards. New/repriced products at Deal Heat 75+ can rerank page 1 when the current view is heat-sorted and matches the active query/category; Scorching (90+) events are called out explicitly. Homepage Trending and the full Price Signals page live-rerank too.

Admin receives catalog, price, lifecycle, rule, and outbound-click updates and debounces `loadAdmin()`. Live Admin refresh pauses while an input/textarea/select is focused so background automation does not erase unsaved edits.


---

# V3.7.1 BOOTFIX

V3.7.1 fixes the stale-module regression discovered immediately after V3.7
deployment while keeping V3.7 LIVE SYNC intact.

## Root cause

V3.7 versioned the top-level browser modules:

```text
/js/store.js?v=3.7.0
/js/admin.js?v=3.7.0
/js/product.js?v=3.7.0
```

but those ES modules still imported:

```text
./common.js
```

without the same build key.

A browser could therefore load a current Store/Admin/Product module while
reusing an older cached `common.js`. Because V3.7 added new named exports such
as `connectOfferGridLive`, that split module graph could fail during module
linking before the application booted.

Symptoms included:

```text
navbar not rendered
catalog listings not rendered
Admin login UI not functioning
```

A hard refresh fixed the browser because it forced a coherent module graph.

## Product-page regression

V3.7's `product.js` also called `connectOfferGridLive()` without importing it
from `common.js`.

That caused the product page to fall into its error handler with:

```text
Product unavailable
connectOfferGridLive is not defined
```

V3.7.1 adds the missing import.

## Version-locked ES module graph

All V3.7.1 browser modules now import:

```text
./common.js?v=3.7.1
```

and all HTML entry assets use:

```text
/css/style.css?v=3.7.1
/js/<entry>.js?v=3.7.1
```

A browser therefore cannot legitimately combine a new entry module with an old
`common.js` cache entry from a previous OfferGrid deployment.

## Static navigation fallback

Every HTML page now contains usable OfferGrid navigation markup before
JavaScript runs.

Normally `common.js` replaces/enhances that header exactly as before. If a
future JavaScript boot failure occurs, however, the visitor still has a usable:

```text
Price Intelligence
Price Signals
Methodology
Disclosure
Admin (on Admin)
```

navbar instead of a blank header.

A tiny inline fallback also keeps the mobile menu button functional even if
the ES-module application fails to boot.

## Automatic failed-boot recovery

The inline boot guard waits for the normal `common.js` chrome boot marker.

If the page has still not booted after six seconds it:

1. checks `/api/config` using `cache: no-store`
2. determines the current server build
3. performs one cache-busting recovery reload for that build
4. records the attempt in sessionStorage so a genuine server error cannot
   create an infinite reload loop

This complements V3.7's normal persistent version/cache guardian.

## Price Signals micrographs

The Price Signals page now uses the same real cached price-history micrograph
as the main Price Intelligence catalog.

Each signal card uses the existing:

```text
product image | tracked price graph
```

signature visual on desktop, and the existing image/chart rail on mobile.

The graph uses V3.5's cached real `priceSparkline` data. It does not add eBay
calls, product-history requests, or a new backend data path.

## Preserved systems

V3.7.1 keeps:

- V3.7 SSE live price/catalog/Admin synchronization
- Hot/Scorching live insertion and reranking
- automatic client version/cache migration
- V3.6 signature intelligence grid
- V3.5 cached micrographs
- V3.4 lifecycle, pruning, tombstones, and reactivation
- V3.3 eBay RATEGUARD
- exact price verification
- autonomous discovery
- live zero-result marketplace search
- worker-thread catalog search
- 100-item pagination
- Admin APIs and credential vault

## Deal Heat outlier pruning

V3.7.1 also makes Deal Heat more resistant to bad marketplace observations.

Raw price history is **not deleted**. OfferGrid still preserves the observation
for auditing/history purposes.

Before calculating the 30-day statistical baseline used by Deal Heat, OfferGrid
now applies a conservative robust filter:

```text
< 5 usable samples
    no statistical pruning

>= 5 usable samples
    median + MAD outlier detection

near-zero MAD / mostly identical prices
    conservative relative-deviation fallback
```

The normal robust cutoff is a modified Z-score above `4.5`, which is deliberately
looser than a typical statistical outlier detector.

If filtering would leave fewer than three useful samples, OfferGrid falls back
to the original history rather than pretending it has a reliable clean
baseline.

The filtered baseline drives:

```text
30-day average used by Deal Heat
30-day low/high context
prior tracked low
new-low bonus
historical savings component
Deal Heat confidence
```

The raw observations remain stored and available to the long-term history
system.

### Extreme current-price anomaly protection

Historical pruning alone is not enough if the *current* scraped/listing price
is the bad observation.

When there are at least five stable prior observations, a single current price
below 20% or above 500% of the robust prior median is treated as an extreme
anomaly for Deal Heat.

OfferGrid does **not** delete or hide the listing. Instead it:

```text
keeps the current offer
keeps the raw observation
withholds the history component
withholds the new-low bonus
caps Deal Heat below Hot
labels the signal "Verify anomaly"
```

This is aimed at unit-price mistakes, wrong variants, malformed marketplace
prices, and scrape anomalies.

The threshold is intentionally extreme so ordinary 20%, 30%, 50%, or even
large legitimate sale movements are not automatically discarded merely for
being good deals.

Additional observations can naturally establish a new price regime and stop
the price from looking like an isolated anomaly.



---

# V3.7.2 EBAY SEARCH RECOVERY

V3.7.2 hardens the remaining eBay Browse error-12001 edge case.

eBay documents `q`, `category_ids`, `charity_ids`, `epid`, and `gtin` as valid
Browse search criteria. Some stored identifiers can nevertheless be rejected
by eBay Production with:

```text
errorId 12001
The call must have a valid 'q', 'category_ids', 'charity_ids',
'epid' or 'gtin' query parameter.
```

OfferGrid already syntactically validates GTIN/ePID before transmission. V3.7.2
therefore treats a 12001 response to a locally-valid exact identifier as a
**remote-search rejection**, not as evidence that the canonical product
identity should be deleted.

## Exact-search quarantine

When a GTIN/ePID search receives remote error 12001:

1. the exact criterion is recorded on the product
2. the scanner immediately retries using Brand+MPN or strict title
3. that retry is explicitly keyword-only (`q`)
4. the rejected exact search method is quarantined for 30 days by default
5. future background competitor passes skip the known-failing exact request
   during the quarantine period

Default:

```env
EBAY_EXACT_SEARCH_QUARANTINE_DAYS=30
```

The product's GTIN/ePID remains intact for canonical identity, reactivation,
deduplication, and other data-quality logic.

This avoids turning an eBay-specific search rejection into loss of OfferGrid
identity.

## Rate-limit effect

The quarantine is also an API-budget improvement.

Before:

```text
each future scan
→ known-bad GTIN/ePID call → 400
→ title fallback call
```

After the first 12001:

```text
future scans for 30 days
→ title/Brand+MPN fallback directly
```

so the same known-bad exact criterion does not repeatedly consume a Browse
call.

The retry and all later scans still pass through V3.3 RATEGUARD.

## Diagnostics

Remote 12001 errors now attach sanitized criteria telemetry such as:

```text
search mode
whether a locally-valid GTIN/ePID existed
keyword length
whether the request was forced keyword-only
```

No OAuth token, credential, affiliate URL, or request header is recorded.


---

# V3.7.3 REMOTE QUOTA

V3.7.3 addresses genuine eBay `429 / ACCESS / errorId 2001` resource
exhaustion.

A local counter alone cannot know about every call made against the same eBay
application keyset. Calls from an older OfferGrid build, another process,
manual API testing, or another deployment can consume the remote application
quota without appearing in OfferGrid's local usage file.

V3.7.3 therefore adds an authoritative quota layer using eBay's Developer
Analytics API.

## Authoritative quota synchronization

OfferGrid calls:

```text
GET /developer/analytics/v1_beta/rate_limit/
    ?api_name=browse
    &api_context=buy
```

with the same eBay Application access token it already manages.

The returned application-level rate data can include:

```text
limit
remaining
reset
timeWindow
count
resource
```

OfferGrid synchronizes that data into RATEGUARD.

Defaults:

```env
EBAY_ANALYTICS_SYNC_ENABLED=true
EBAY_ANALYTICS_SYNC_MINUTES=30
EBAY_ANALYTICS_CACHE_MINUTES=15
```

A startup sync runs before starter-population / normal automated marketplace
work begins.

## Effective budget

RATEGUARD now has two views of API usage:

```text
local rolling counter
authoritative eBay remaining quota
```

The usable budget is the more conservative of the two.

For normal Browse calls, background automation stops while enough authoritative
capacity is preserved for both the configured safety margin and interactive
reserve.

Interactive traffic is also stopped before consuming the final safety margin.

The remote remaining value is decremented locally after each permitted API call
until the next Analytics synchronization.

## Hard 429 handling

eBay's response:

```text
HTTP 429
errorId 2001
Too many requests.
The request limit has been reached for the resource.
```

is treated as a hard resource-exhaustion signal rather than an ordinary short
throttle.

When it occurs:

1. RATEGUARD immediately blocks additional requests.
2. OfferGrid asks Developer Analytics for authoritative quota/reset data.
3. If a reset timestamp is available, the cooldown is aligned to that reset.
4. If Analytics cannot provide usable data, OfferGrid uses a conservative
   fallback instead of retrying every hour.

Fallback default:

```env
EBAY_RESOURCE_LIMIT_COOLDOWN_HOURS=24
```

A normal `Retry-After` header still takes precedence when eBay supplies one.

## Graceful degradation

Running out of eBay quota does not take OfferGrid offline.

Local functionality continues:

```text
existing catalog
price history
compressed historical intelligence
product pages
search over already-known products
Deal Heat from stored verified data
micrographs
Price Signals based on stored data
Admin
live browser synchronization of local changes
lifecycle / tombstone maintenance
```

Only work requiring a new eBay API response is deferred until allowance becomes
available again.

## Admin telemetry

Admin now distinguishes local usage from authoritative quota:

```text
Browse local calls / rolling 24h
Browse effective background calls left
Browse effective interactive calls left
Browse authoritative eBay quota
Browse quota reset
Browse cooldown reason

getItems local calls / rolling 24h
getItems effective background calls left
getItems effective interactive calls left
getItems authoritative eBay quota
```

This makes a true remote exhaustion visible instead of presenting an
incorrectly healthy local counter.

## Safety behavior

Developer Analytics is used to make OfferGrid **more conservative**, not to
bypass eBay limits.

V3.3 pacing, local rolling limits, safety margin, interactive reserve, bulk
getItems behavior, and anti-amplification protections remain in place.


---

# V3.7.4 EXACT COMPETITOR PROOF

V3.7.4 changes eBay competitor matching from "high-confidence semantic match"
to **fail-closed exact proof**.

The governing rule is now:

```text
search text can discover a candidate
search text can never prove a competitor
```

Before an eBay listing can attach to an existing OfferGrid product as a
competitor, OfferGrid must fetch that listing through the exact Browse
`getItems` item-detail path and prove the same machine identity.

Accepted proof modes are deliberately narrow:

```text
1. exact GTIN
2. exact Brand + exact MPN
3. exact ePID + exact Brand
```

Every proof mode also passes a strict variant-conflict gate covering model,
capacity/weight, power, electrical specification, size, pack count, kit/bare
state, product family, and accessory-vs-product state.

If OfferGrid cannot prove the identity, the listing is rejected. There is no
"probably the same product" fallback.

## Search fallback is discovery-only

If eBay rejects a GTIN/ePID search with error 12001, V3.7.2's quarantine and
keyword fallback still work. However, the keyword result is only a candidate.
It still must return an exact item-detail record whose strong identity matches
the target before V3.7.4 will attach it.

## No-title-only products

If the target product has no valid GTIN, no Brand+MPN, and no ePID+Brand proof,
the competitor scan is skipped. This intentionally prefers a false negative to
a false competitive comparison.

## Exact-detail batching

Search candidates are fetched through eBay `getItems` in batches of up to 20
using the separately governed getItems quota. HTTP-400 batches are recursively
split to isolate malformed IDs, but V3.7.4 never amplifies a failed batch into
one individual Browse `getItem` call per candidate.

Default:

```env
EBAY_COMPETITOR_EXACT_BATCH_SIZE=20
```

## Existing competitor cleanup

All eBay competitor offers created under verificationVersion 3 or earlier are
re-evaluated under the V4 exact-proof rules during synchronous startup cleanup.
Legacy offers that already have exact item-detail metadata and can now prove the
same identity are upgraded to V4. Everything else is removed, together with
its competitor-generated price-history points.

A new safety backup is created before the first startup cleanup at:

```text
data/catalog.pre-v374-exact-competitor-proof.json
```

Only newly exact-proven V4 competitor offers can survive cleanup.

## Continuous integrity

Scheduled exact price verification re-checks the stored competitor proof after
eBay returns fresh item-detail metadata. If the identity no longer proves the
same product, that competitor is immediately made inactive with
`identity_mismatch` status and cannot affect live market comparison or price
history. The scheduled cleanup later removes it completely.

## Important limitation

No external marketplace can provide a mathematical 100% guarantee that a
seller has not entered false GTIN/MPN/ePID metadata. V3.7.4 therefore provides
the strongest practical guarantee available to OfferGrid: it never accepts
semantic similarity alone and only treats an eBay listing as a competitor when
strong item-detail identity evidence proves the same product and no variant
conflict is visible.

---

# V3.7.5 BULK SANITIZER + GROWTH CHECK READY

V3.7.5 keeps V3.7.4's fail-closed exact competitor proof and adds a quota-efficient
cleanup/refresh layer designed for eBay's Application Growth Check path.

## eBay is a data source, not the page-view database

The preferred flow is now enforced throughout the public search path:

```text
User search
  -> OfferGrid normalized catalog / price-history database
  -> determine whether local data is sufficient
  -> only use eBay when additional/current marketplace data is actually needed
  -> normalize and persist returned products/offers
  -> record real observations when exact verification permits
  -> future users reuse the stored OfferGrid result
```

A public catalog result is never hidden merely because the eBay budget is low.
Live eBay discovery remains the zero-local-result recovery path.

## Bulk competitor sanitizer

Unproven legacy competitors remain quarantined from public intelligence while a
persistent local queue re-verifies them through efficient `getItems` batches.
Single-item REST IDs are grouped up to 20 per call and multi-variation IDs up to
10 per call. Duplicate stored item IDs are fetched once and applied to all local
attachments.

## Persistent endpoint usage metrics

OfferGrid writes Growth Check telemetry to:

```text
data/ebay-api-metrics.json
```

The counters survive server restarts and retain daily/hourly endpoint history.
Tracked metrics include:

- daily and hourly network calls
- cache hits and misses
- calls avoided by caching/deduplication
- failed calls
- infrastructure retries
- 429/rate-limit responses
- peak hourly calls per endpoint
- peak daily calls per endpoint

Admin also exposes a rough current-traffic calls/day projection and a signal when
that projection approaches the configured production allowance.

The authenticated API endpoint is:

```text
GET /api/admin/ebay/usage
```

## Configurable quota growth

No application logic assumes that the current eBay allowance will always be
5,000 calls/day. `EBAY_BROWSE_DAILY_LIMIT` and `EBAY_GETITEMS_DAILY_LIMIT`
remain the configured limits. If eBay approves higher production limits later,
raise the environment values; the rate guard, projections and Admin display use
the new values automatically.

## Progressive soft limits

Background work tapers before the hard reserve is reached:

```env
EBAY_SOFT_LIMIT_START_PCT=70
EBAY_SOFT_LIMIT_STRICT_PCT=85
EBAY_SOFT_LIMIT_CRITICAL_PCT=95
EBAY_SOFT_LIMIT_CONSERVE_MULTIPLIER=0.60
EBAY_SOFT_LIMIT_STRICT_MULTIPLIER=0.25
EBAY_SOFT_LIMIT_CRITICAL_MULTIPLIER=0.05
```

At higher pressure OfferGrid spreads discovery, competitor scans, sanitization
and price refreshes over the remaining quota window and reuses cached search
results for longer. User-facing catalog results continue to come from OfferGrid
itself.

## Request reuse and payload efficiency

Identical in-flight Browse requests join one promise instead of creating a
request storm. Equivalent keyword requests are canonicalized for request reuse
(case/spacing differences do not create duplicate calls). Recently fetched
search responses and exact item details are reused. When an exact PRODUCT item
request is already in flight, a simultaneous price-only caller can share that
richer response. Price-only `getItems` verification otherwise omits the
`PRODUCT` fieldgroup, while exact identity/competitor proof requests add
`PRODUCT` only when required.

Product identity has a longer cache than current market state:

```env
EBAY_ITEM_DETAIL_CACHE_SECONDS=300
EBAY_ITEM_IDENTITY_CACHE_SECONDS=86400
```

## Retry behavior

Transient infrastructure failures use at most two retries with exponential
backoff and jitter. 429 handling obeys `Retry-After` when supplied. Without it,
OfferGrid uses exponential backoff with jitter; hard resource-exhaustion error
2001 still uses the authoritative Developer Analytics reset when available or
the conservative configured fallback.

## Growth Check evidence

eBay's Application Growth Check asks applicants to estimate peak hourly and
daily call volume for each API call. V3.7.5 retains those endpoint-level peaks
so OfferGrid can later answer that question from actual production telemetry
instead of guessing.

The barcode roadmap remains compatible: GTIN scan checks OfferGrid first; known
products return immediately, while unknown GTINs can be identified through
connected sources, normalized into the catalog, given their first real price
observation, and then reused/tracked normally.

# V3.7.6 UNIVERSAL EBAY TRUST FILTER

V3.7.6 extends V3.7.5 without removing the bulk sanitizer, Growth Check telemetry,
quota-aware request reuse, remote quota guard, 12001 recovery, or V4 exact competitor
proof.

The trust rule is now universal: eBay title similarity may discover a candidate, but it
cannot make that listing part of another product's competitive intelligence.

## Fail-closed same-product policy

An eBay product keeps its canonical/source listing. Any additional eBay listing must
pass exact item-detail verification and one of the V4 proof modes:

- exact GTIN / UPC / EAN, with Brand/MPN corroboration when the canonical product knows them;
- exact Brand + MPN;
- exact ePID + Brand;
- plus exact variant conflict checks for model, size, capacity/weight, power,
  voltage/current, pack count, kit/bare state, product family, and accessory state.

If the product has no strong identifier, OfferGrid withholds competitor comparison.
It does not fall back to title similarity as proof.

## Legacy broad-discovery cleanup

The startup/24-hour competitor cleanup now also audits old eBay listings that entered a
product through broad discovery rather than the dedicated competitor scanner.

- the canonical/source eBay listing is retained;
- exact-proven secondary eBay listings remain attached;
- unprovable secondary listings are isolated into their own listing-scoped draft product;
- their raw offer-linked history/click ownership follows the isolated listing;
- contaminated compressed aggregates on the old relationship are discarded;
- isolated listings are not automatically published merely because the parent product was public.

A pre-cleanup backup is created at:

`data/catalog.pre-v376-universal-trust-filter.json`

## Intelligence filtering

Untrusted secondary eBay listings are excluded immediately from:

- best-offer selection;
- eBay seller competition;
- Market Check eBay inputs;
- Deal Heat current-price selection;
- raw history used by Deal Heat and micrographs;
- future price-history compression;
- public product offer lists.

Weak-identity products may still show their own real source listing and its own real
price history. The UI explicitly says that exact competitor comparison is unavailable
until product identity can be proved.

## Future ingestion

Broad eBay discovery no longer merges weak-identity listings into an existing product
through `safeSameVariant()` / title-family similarity. Weak eBay listings remain
listing-specific until a strong identity is established. Existing listing ownership is
still stable, and GTIN/Brand+MPN catalog-first reuse remains compatible with the future
barcode flow.


# V3.7.7 CLEANUP PROGRESS CONSOLE

V3.7.7 retains the V3.7.6 universal eBay trust filter, exact competitor proof,
bulk sanitizer, Growth Check telemetry, request reuse, quota protection, and
all existing public/admin behavior. The release adds observability to the
synchronous competitor cleanup that runs before the HTTP listener comes online.

The console first reports the three pre-listen maintenance phases (catalog integrity, universal competitor trust cleanup, and product lifecycle), then reports cleanup phase starts/completions plus throttled progress
for large loops. Progress lines include percentage, processed/total records,
throughput, estimated time remaining when enough work has been observed, and
phase-specific trust counters such as isolated, trusted, quarantined, and removed
relationships. The progress callback is observability-only and cannot abort the
cleanup if console reporting itself throws.

Default controls:

```env
EBAY_COMPETITOR_CLEANUP_PROGRESS_ENABLED=true
EBAY_COMPETITOR_CLEANUP_PROGRESS_SECONDS=2
EBAY_COMPETITOR_CLEANUP_PROGRESS_ITEMS=250
```

Set `EBAY_COMPETITOR_CLEANUP_PROGRESS_ENABLED=false` to return to summary-only
logging. No eBay API calls are added by this feature.


# V3.7.9 EARLY STARTUP PROGRESS

V3.7.9 closes the remaining silent startup window in V3.7.7. `npm start` now enters `bootstrap.js`, which prints `[startup-bootstrap]` immediately before dynamically importing the application. Once `server.js` is loaded, database initialization reports `[startup-db]` phases for catalog load, parse/migration, Price Signal indexing, product intelligence cache rebuild, catalog serialization, and persistence. The existing V3.7.7 three-phase startup maintenance and competitor-cleanup rate/ETA telemetry then continue unchanged.

`DB_STARTUP_PROGRESS_ITEMS=100` controls how often the synchronous product-cache rebuild emits an item-count callback. Terminal output is throttled so very large catalogs stay visibly alive without flooding the console. No eBay API calls are consumed by this telemetry.


# V3.7.10 SIGNAL INDEX PROGRESS

The Price Signal sparkline-index build is no longer an opaque start/done interval. During startup it now emits counted tqdm-style subphase bars for offer-trust filtering, raw price-history indexing, compressed aggregate indexing, and per-product sparkline sorting/compaction. This is observability-only; matching, eBay trust semantics, historical filtering, and sparkline output are unchanged.


# V3.7.11 CACHE ACCELERATION

V3.7.11 fixes the pathological startup cache rebuild discovered on large catalogs. The previous implementation could recompute the blocked eBay history set for every product; that scan itself could repeatedly scan the complete offer table while resolving primary eBay listings. On thousands of products this created superlinear startup work.

The rebuild now creates ephemeral in-memory indexes once per startup: product lookup, exact/numeric offer grouping, memoized primary eBay source resolution, one eBay trust/history exclusion pass, and one 30-day Deal Heat history index. Product cache calculations then consume only the relevant product slice. Persisted data semantics are unchanged. No API calls are added and the optimization does not remove Deal Heat, Price Signal, competitor trust, product matching, lifecycle behavior, or affiliate behavior.

Startup telemetry adds bars for `startup product/offer lookup index` and `Deal Heat 30-day history index` before the normal product intelligence cache bar.


# V3.7.12 INTEGRITY ACCELERATION

V3.7.12 fixes the next startup bottleneck discovered after the V3.7.11 database/cache acceleration. Phase 1 catalog integrity still used the legacy per-product `rescoreProductInDb()` + `refreshProductCacheInDb()` path, reintroducing repeated whole-catalog offer/history scans after the fast database initialization had already completed.

The integrity cycle now preserves the same repair/scoring/cache semantics while using bulk rescoring plus the V3.7.11 indexed cache rebuild. It also reuses an offer lookup for eBay trust/history filtering and defers redundant per-split cache work until the final complete integrity rebuild. Startup Phase 1 now emits tqdm-style counted progress for the expensive subphases.

# V3.7.13 FULL STARTUP ACCELERATION

V3.7.13 extends the V3.7.11/V3.7.12 indexing work through the complete pre-listen startup pipeline.

## What changed

- **Phase 1 catalog integrity**
  - Duplicate canonical-product relationship remaps are collected and applied in one pass instead of rescanning offers/history/aggregates/clicks once per duplicate.
  - Existing V3.7.12 bulk rescoring and indexed Price Signal / Deal Heat cache rebuilds remain intact.
- **Phase 2 universal competitor trust cleanup**
  - Broad eBay relationship splits collect history/click remaps and apply them once.
  - The intermediate legacy cache rebuild is deferred; exact field-level rescoring semantics are preserved with a fast grouped rescore.
  - Products affected by trust cleanup are rebuilt through reusable offer/trust/history indexes rather than the old per-product whole-catalog path.
- **Phase 3 lifecycle maintenance**
  - Offer activity, latest observations, history sample counts, clicks, recent traffic, and archive summaries are indexed once.
  - Lifecycle thresholds, protection scores, STALE → PRUNABLE sequencing, grace periods, archive tombstones, and history retention rules are unchanged.
  - Archived offers/history/click rows are removed in one batch instead of filtering the full database once per archived product.
  - The final cache refresh still runs for every product, but uses the accelerated bulk cache path.
- **Progress visibility**
  - Startup lifecycle work now exposes tqdm-style progress for history compression, trust scanning, lifecycle evidence indexing, classification, archive cleanup, Price Signal indexing, Deal Heat indexing, and cache rebuild.

## Validation

On a 240-product adversarial fixture, the complete local startup pipeline dropped from roughly **9.49 s to 0.38 s** while producing the same normalized final catalog after runtime timestamps/revisions were excluded.

On a synthetic 6,917-product fixture with 14,755 offers, 42,423 raw history points, 6,917 aggregates, and 1,229 clicks, the full local pipeline (database init + all three maintenance phases) completed in roughly **7.1–7.5 s** in the test container.

Phase-specific equivalence tests also matched V3.7.12 for competitor cleanup, lifecycle state transitions/protection decisions, and archive/tombstone behavior.

No remote eBay calls are added to startup by this patch.

## V3.7.54 — Stable live competitor ordering + sort-only reranking

V3.7.54 removes two sources of shopper-visible competitor-sort instability without changing marketplace discovery or competitor verification semantics. The `Sort by` dropdown is now presentation-only and reuses the current shopper view; changing it does not start discovery or hydration again. Hydration events remain valid after a sort change because scan identity is based on query/category/page/condition mode, not presentation sort.

While an active competitor pass is running with `Most competitors` selected, one local 150 ms verified-seller-count sorter owns the visible 40-card order for the entire pass. Per-product completion no longer rebuilds the grid from a persisted server snapshot, eliminating the previous local-sort/server-sort ping-pong. A single authoritative full-query refresh remains at the end of the pass to reconcile global ordering and pagination. Global server job dedupe stays sort-specific so unrelated tabs with different sorted visible-ID queues cannot accidentally share the wrong hydration job.

## V3.7.55 — Underfilled-page competitor loop guard

V3.7.55 preserves V3.7.54 behavior while making a bounded foreground competitor pass terminal for the current shopper interaction. Narrow searches with fewer than 40 publishable products can no longer bounce from an incomplete competitor pass back into discovery and immediately restart the same foreground scanner.

Key invariants:
- one foreground competitor pass per shopper view/interation;
- unresolved competitor coverage is handed to the existing background coverage lane;
- post-hydration marketplace discovery is not immediately re-queued merely because the page contains fewer than 40 verified products;
- late discovery-ready events may refresh newly publishable cards but cannot restart a settled foreground competitor pass;
- new query/page/navigation creates a fresh shopper view and may scan normally;
- sort-only changes remain presentation-only and do not rescan;
- V3.7.54 live 150 ms ranking, strict competitor proof, Parts/Broken exclusion, 40-card target, eBay fallback, and retention analytics remain unchanged.

## V3.7.58 — Recoverable background page-fill handoff

V3.7.58 fixes a shopper-progress stall where the UI could remain on **Filling this page** after foreground discovery handed an underfilled 40-card page to shared background continuation. Foreground shopper activity and background catalog growth are now separate signals. Shared continuation stays deduplicated, but the initiating shopper interaction registers a scoped completion waiter so it receives the true discovery→hydration barrier when page fill reaches capacity or a bounded terminal condition. Background progress can advance the visible page-fill count without taking lifecycle ownership or interrupting an active competitor pass.
