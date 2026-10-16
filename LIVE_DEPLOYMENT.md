# V3.7.46 live deployment notes

V3.7.46 is an overlay for V3.7.45. Preserve the live `.env` and all runtime `data/`. The new first-paint limits use `LIVE_SEARCH_FIRST_PAINT_*` variables and therefore remain bounded even if the live `.env` still contains an older large `LIVE_SEARCH_MARKETPLACE_PAGE_SIZE`. Public search should render safe cards before the blue competitor cursor starts. Only stale or never-researched visible cards should receive foreground competitor work.

The anonymous visitor ledger `data/unique_visitors.ndjson` is runtime-created and must be retained with the rest of `data/` in backups. Admin visitor presence is intentionally lightweight: public browsers heartbeat every five minutes; Admin polls the current count every five minutes and receives new-historical-user updates through the existing live stream.

---

## V3.7.30 normalization trust

Apply V3.7.30 over V3.7.29 while preserving the live `.env`, `data/catalog.json`, `data/private-config.json`, `data/ebay-api-metrics.json`, and other runtime-generated data. No new npm dependency or credential migration is required.

On first eligible startup maintenance, catalogs below integrity version 310 receive a one-time normalization repair with a pre-repair catalog backup. The repair can sanitize invalid identity fields, split contaminated canonical owners, remap offer-attributed history/clicks, invalidate affected aggregate caches, and conservatively merge duplicate products. Do not replace a newer live `data/catalog.json` with the catalog bundled in a source archive.

Pending eBay competitor candidates may be rendered as **Needs verification** observations before exact proof completes. This is a presentation change, not a relaxation of trust: pending prices remain excluded from Deal Heat, verified price ranges, price history, verified seller counts, and best-offer ranking. Exact sanitizer proof still controls promotion.

New optional/default controls:

```env
EBAY_COMPETITOR_PENDING_TARGET_PER_PRODUCT=8
EBAY_COMPETITOR_PENDING_SELLER_TARGET=4
LOCAL_NORMALIZATION_ENABLED=true
LOCAL_NORMALIZATION_HEARTBEAT_MINUTES=10
LOCAL_NORMALIZATION_MINUTES=30
LOCAL_NORMALIZATION_CONSTRAINED_MINUTES=10
LOCAL_NORMALIZATION_PRODUCTS_PER_PASS=2500
LOCAL_NORMALIZATION_CONSTRAINED_BATCH=5000
LOCAL_NORMALIZATION_QUIET_MS=500
```

Local normalization is database-only maintenance; it does not consume eBay calls or mark stale/observed listings as freshly verified. The scheduler runs larger/more frequent passes when eBay quota state is constrained and still yields to foreground requests.

---

## V3.7.29 competitor coverage

Apply V3.7.29 over V3.7.28 while preserving `.env`, `data/catalog.json`, `data/private-config.json`, and `data/ebay-api-metrics.json`. No dependency or credential migration is required.

The default competitor discovery scheduler is now 10 minutes, independent of the 60-minute per-product rescan floor. Browse discovery is allowed a 0.55 background quota share and requests 100 result candidates per product by default. Existing `.env` values for older controls remain compatible; the new `EBAY_COMPETITOR_DISCOVERY_RESULTS_PER_PRODUCT` and `EBAY_COMPETITOR_DISCOVERY_QUOTA_SHARE` controls let this patch raise discovery yield without requiring old installations to delete prior settings.

Pending competitor candidates are durable catalog records but remain untrusted until the bulk sanitizer receives exact eBay item detail. They are therefore safe to accumulate while `getItems` is exhausted. Admin now exposes the resulting pending queue and verified multi-seller coverage directly.

## V3.7.28 live eBay telemetry

V3.7.28 requires no new dependency or secret. Apply it over V3.7.27 while preserving `.env`, `data/catalog.json`, `data/private-config.json`, and `data/ebay-api-metrics.json`. While Admin is open and visible, the eBay telemetry panel refreshes every two seconds from a lightweight endpoint. Real-call counters move only for requests that actually reach eBay; blocked attempts and deduplicated shadow demand have their own live counters.

## V3.7.27 eBay quota demand + call efficiency

V3.7.27 is additive over V3.7.26 and requires no new npm dependency or credential migration. Preserve the existing `.env`, `data/catalog.json`, `data/private-config.json`, and existing runtime state when applying the patch. `data/ebay-api-metrics.json` will migrate in place when present.

New telemetry records quota-suppressed work without sending extra requests to eBay. Admin → eBay API usage now shows actual calls, unique blocked calls, uncapped demand/day, 7-day average/peak demand, recommended daily request limits, `getItems` batch fill, listings/call, bulk calls saved, and the exact-verification backlog/minimum drain calls. Leave the server running under normal traffic for several days before using the 7-day evidence in a quota-increase request.

`getItems` requests are packed through the shared 20-single/10-variation planner; duplicate IDs and cache hits are removed before network I/O. `EBAY_ALLOW_INDIVIDUAL_GETITEM_FALLBACK=false` keeps one-item Browse fallbacks disabled even if an older `.env` still contains a nonzero fallback maximum. The existing rate guard, authoritative Developer Analytics sync, pending-verification shopper fallback, competitor proof, and exact-publication rules are unchanged.

New optional controls: `EBAY_USAGE_PERSIST_DEBOUNCE_MS=5000`, `EBAY_USAGE_DEFERRED_KEY_CAP=25000`, `EBAY_QUOTA_REQUEST_HEADROOM_MULTIPLIER=1.50`, `EBAY_QUOTA_REQUEST_ROUND_TO=500`, and `EBAY_SHADOW_DEMAND_MAX_ITEMS_PER_PASS=5000`.

---

## V3.7.26 pending verification + Admin folds

V3.7.26 is additive over V3.7.25 and requires no new npm dependency or credential migration. Preserve the existing `.env`, `data/catalog.json`, and `data/private-config.json` when applying the patch.

Recommended defaults:

```env
PENDING_VERIFICATION_FALLBACK_ENABLED=true
PENDING_VERIFICATION_MIN_CONFIDENCE=70
PENDING_VERIFICATION_MAX_AGE_HOURS=72
```

When eBay exact `getItems` verification is unavailable because the interactive allowance is exhausted, the endpoint is in cooldown, or the current live-discovery round is deferred, page-one shopper searches may include strictly relevant locally safe eBay source drafts as **Verification pending**. These projections show the observed listing/price but remain unapproved and contribute no Deal Heat, new-low claim, price history, sparkline, eBay competitor proof, or cross-store comparison. Manual Hide/Edit locks, canonical-owner uniqueness, variant ambiguity checks, offer trust, observation age, and the confidence threshold remain fail-closed.

The existing `/go/:offerId` path may route only the exact offer selected by the pending-safety verdict. Once exact verification succeeds, the normal approval/intelligence/SSE flow takes over.

Admin's eBay telemetry is reformatted into Browse/getItems quota cards plus a structured endpoint table. The Discovery Rules list and Review Queue product list can be collapsed independently; the state is remembered in browser `localStorage` and is not reset by Admin SSE refreshes.

---

## V3.7.25 interactive draft promotion

V3.7.25 is additive over V3.7.24 and requires no new npm dependency or credential migration. Existing `.env`, `data/catalog.json`, and `data/private-config.json` remain compatible.

Recommended defaults:

```env
LIVE_SEARCH_DRAFT_REVIEW_LIMIT=400
LIVE_SEARCH_DRAFT_VERIFY_LIMIT=120
LIVE_SEARCH_DRAFT_VERIFY_MAX_API_CALLS=6
```

When a shopper query has insufficient public results, OfferGrid first examines recent untouched drafts that strictly match that same query. Safe Rakuten drafts can publish immediately; matching eBay drafts receive bounded foreground exact verification and are published only after the existing confidence gate passes. If this produces any public result for a query that started at zero, the live-search request returns immediately so the browser can show those products before continuing later expansion rounds.

The scheduled draft curator now rotates through deferred drafts by `lastAutoReviewAt`, preventing the same unverified first batch from monopolizing every scheduled pass. Manual Admin locks, eBay rate guard, exact verification, variant safety, and all V3.7.24 confidence thresholds remain unchanged.

---

## V3.7.24 confident draft curator

V3.7.24 is additive over V3.7.23 and requires no new npm dependency or credential migration. Existing `.env`, `data/catalog.json`, and `data/private-config.json` remain compatible.

Recommended defaults:

```env
DRAFT_AUTO_APPROVE_ENABLED=true
DRAFT_AUTO_APPROVE_MINUTES=1
DRAFT_AUTO_APPROVE_BATCH=200
DRAFT_AUTO_APPROVE_MIN_CONFIDENCE=80
DRAFT_AUTO_APPROVE_MAX_AGE_HOURS=168
DRAFT_AUTO_APPROVE_QUIET_MS=250
```

On startup, OfferGrid begins accepting HTTP traffic before the first curator pass. About five seconds later, the low-priority backlog review examines recent untouched ACTIVE drafts. Strong Rakuten records can publish immediately; eBay drafts remain fail-closed until exact item verification succeeds, after which the touched product is reviewed immediately.

Manual **Hide** and draft edits lock the product out of automatic publication. Existing Rakuten catalog auto-publication and discovery-rule auto-approval also respect this lock. To run an immediate authenticated pass without waiting for the scheduler, call `POST /api/admin/drafts/auto-review`.

Admin automation status exposes the current draft-review settings and last-pass counts.

---

## V3.7.23 async intelligence buffer + lazy boot

V3.7.23 is tuned by default for the current i7-8700K (6C/12T), 16 GB RAM, and NVMe host. No new npm dependency is required. Existing credentials and `data/catalog.json` remain compatible.

Recommended production values:

```env
CATALOG_SEARCH_THREADS=2
INTELLIGENCE_WORKERS=8
INTELLIGENCE_PREP_BATCH_SIZE=256
INTELLIGENCE_PREP_QUIET_MS=50
INTELLIGENCE_RESULT_COMMIT_MS=250
INTELLIGENCE_RESULT_COMMIT_BATCH=64
INTELLIGENCE_SNAPSHOT_PERSIST_MS=15000
INTELLIGENCE_STALE_MINUTES=180
INTELLIGENCE_LAZY_SCAN_MINUTES=2
INTELLIGENCE_LAZY_SCAN_BATCH=32
MUTATION_BUFFER_WINDOW_MS=120000
MUTATION_BUFFER_MAX_AGE_MS=300000
MUTATION_BUFFER_MAX_PRODUCTS=1024
MUTATION_BUFFER_QUIET_MS=75
STARTUP_MAINTENANCE_DELAY_MS=30000
```

After deployment, startup should report that persistent intelligence snapshots are trusted and the startup product-cache rebuild was skipped. The HTTP listener comes online before heavy catalog-integrity / competitor-trust / lifecycle startup maintenance. Normal stale intelligence is rebuilt in small low-priority batches, and shopper reads can promote a specific stale product to interactive intelligence priority without calculating Deal Heat on the request thread.

Runtime marketplace/feed mutations are visible in memory immediately but their durable raw-history/catalog write is coalesced. A graceful SIGINT/SIGTERM drains the pending mutation buffer and worker results before exit. Avoid hard power-off / forced process kill if recent in-memory mutations must be preserved.

---

## V3.7.22 market-priority competitor scanning + stable shopper position

After applying V3.7.22, restart OfferGrid normally. No new configuration is required. ACTIVE Rakuten/Awin/merchant-feed products with strong identity become eligible for scheduled eBay competitor discovery even before an eBay offer exists. Due work is ranked by Deal Heat, recent clicks, missing-eBay bootstrap value, and overdue age; exact competitor attachment remains fail-closed.

Connected shoppers no longer need to lose their place when SSE pushes a live price/catalog change. Store and Price Signals rerenders restore the visible product anchor, and product-detail rerenders restore scroll position. When a deployment advances the client build, OfferGrid stores the current store query/category/sort/page/viewport in session storage before the cache-busting reload and restores it after the new build renders.

---

## V3.7.21 explicit-vs-unlabeled variant ownership

After applying V3.7.21, restart OfferGrid. Startup catalog integrity automatically repairs already-stored non-eBay offers when the offer itself proves the same strong identity and states an explicit conflicting package fact such as `2-Year Combo`. Offer-linked price history and clicks follow the corrected offer. Running **Sync Product Catalog now** afterward is still recommended so current Rakuten feed records are re-observed under the new rule.

V3.7.21 also enables bounded exact-safe eBay competitor recall by default:

```env
EBAY_COMPETITOR_RECALL_ENABLED=true
EBAY_COMPETITOR_RECALL_SEARCHES=2
EBAY_COMPETITOR_RECALL_RESULTS=40
```

These are discovery probes only. V4 exact `getItems` identity and variant proof remains mandatory before an eBay listing can become a competitor.

---

# OfferGrid live deployment checklist

## V3.7.19 Rakuten Product Catalog SFTP

V3.7.19 preserves the V3.7.18 Product Search fanout and adds bulk Product Catalog ingestion. In Rakuten, Product Catalog technical access and each advertiser feed approval must already be active. Select `.txt` as the preferred feed format.

In OfferGrid Admin → API connections → Rakuten Advertising, save the **replacement** SFTP username and password. Do not reuse credentials that have been exposed. The values are stored in the encrypted private-config vault.

Production defaults:

```env
RAKUTEN_CATALOG_SYNC_ENABLED=true
RAKUTEN_SFTP_HOST=aftp.linksynergy.com
RAKUTEN_SFTP_PORT=22
RAKUTEN_CATALOG_AUTO_APPROVE=true
RAKUTEN_CATALOG_SYNC_MINUTES=30
RAKUTEN_CATALOG_FULL_REFRESH_HOURS=24
RAKUTEN_CATALOG_BATCH_SIZE=250
RAKUTEN_CATALOG_MAX_PRODUCTS_PER_FILE=0
```

After saving credentials:

1. click **Test Rakuten connections**;
2. confirm the SFTP test reports visible Product Catalog feed files;
3. click **Sync Product Catalog now** for the initial full import;
4. watch the terminal for `[rakuten-catalog]` progress;
5. leave the scheduler enabled so later deltas and periodic full refreshes are automatic.

The sync uses a single SFTP connection, downloads binary `.txt.gz` files, validates the gzip/trailer before catalog mutation, and yields between ingest batches to preserve V3.7.15+ interactive request priority.

## V3.7.18 Rakuten fanout

When Rakuten is configured, every broad discovery request that would search eBay also searches Rakuten Product Search. Keep the access token in the encrypted Admin integration vault. For unattended production operation, also save the refresh token, Client ID, Client Secret, and Publisher Account ID/SID so OfferGrid can replace the 60-minute access token automatically.

Recommended production settings:

```env
RAKUTEN_SEARCH_ENABLED=true
RAKUTEN_LANGUAGE=en_US
RAKUTEN_SEARCH_CACHE_SECONDS=120
RAKUTEN_RATE_MIN_INTERVAL_MS=650
RAKUTEN_SEARCH_TIMEOUT_MS=12000
```

Do not disable the existing eBay rate guard. Rakuten has its own serialized pacing and short search cache; the two providers run independently. If eBay background capacity is reserved for shoppers, scheduled discovery can still run the Rakuten half of the rule.

## V3.7.17 precision recall + feature audit

Recommended search settings:

```env
LIVE_SEARCH_ENABLED=true
LIVE_SEARCH_MARKETPLACE_PAGE_SIZE=200
LIVE_SEARCH_PAGES_PER_INTERACTION=4
LIVE_SEARCH_MAX_PAGES_PER_QUERY=8
LIVE_SEARCH_QUERY_VARIANTS=6
LIVE_SEARCH_EXHAUSTED_RETRY_MINUTES=15
LIVE_SEARCH_VERIFY_LIMIT=100
LIVE_SEARCH_TIMEOUT_MS=20000
USER_SEARCH_RULE_LIMIT=120
```

V3.7.17 keeps V3.7.15's interactive-priority behavior and V3.7.16's strict original-query admission gate. A shopper search first serves existing strictly relevant catalog matches, then expands the catalog if the requested page lacks capacity. Marketplace discovery can rotate through conservative query variants that retain every meaningful original term; candidates still have to pass the original shopper query before ingestion/publication. Exhausted query sessions become eligible for a fresh marketplace probe after the configured retry interval. When the source/search budget is genuinely exhausted, OfferGrid renders the final partial page with **End of Results** and never pads it with adjacent-category inventory.

Explicit product queries are blocked before marketplace I/O and explicit product candidates are blocked again at the database ingestion boundary.

## V3.7.15 responsiveness settings

Recommended defaults:

```env
INTERACTIVE_PRIORITY_ENABLED=true
INTERACTIVE_PRIORITY_GRACE_MS=175
INTERACTIVE_PRIORITY_POLL_MS=12
INTERACTIVE_BACKGROUND_APPLY_CHUNK=40
INTERACTIVE_SLOW_REQUEST_MS=500
HEAVY_BACKGROUND_QUIET_MS=2000
RUNTIME_PERSIST_DELAY_MS=1000
DEFERRED_WRITE_QUIET_MS=60000
EBAY_OUTBOUND_REVALIDATE_MINUTES=5
CAMPAIGN_TRAFFIC_MODE=true
```

These settings make normal shopper/admin requests outrank scheduled work. In campaign mode, scheduled catalog mutations are paused and outbound clicks are written to the append-only ledger instead of serializing the full catalog. Cached trusted product/offer state is served first; interactive shopper searches remain available.


## Cloudflare

- `www.offergrid.tech` is a Published Application route to `http://127.0.0.1:3000`
- optional bare `offergrid.tech` route points to the same origin
- Cloudflare Tunnel shows Healthy
- no router port-forward is required

## OfferGrid `.env`

Required live settings:

```env
NODE_ENV=production
HOST=127.0.0.1
SITE_BASE_URL=https://www.offergrid.tech
CANONICAL_HOST=www.offergrid.tech
ENFORCE_CANONICAL_HOST=true
FORCE_HTTPS=true
TRUST_PROXY=1
COOKIE_SECURE=true
STRICT_PRODUCTION=true
SHOW_ADMIN_NAV=false
```

Then configure unique values for:

```env
ADMIN_PASSWORD=
SESSION_SECRET=
CONFIG_ENCRYPTION_KEY=
```

Generate the last two with:

```bat
npm run secrets
```

## Start

```text
start_offergrid_live.bat
```

## Verify

Open:

```text
https://www.offergrid.tech
https://www.offergrid.tech/trending.html
https://www.offergrid.tech/privacy.html
https://www.offergrid.tech/robots.txt
https://www.offergrid.tech/sitemap.xml
```

Admin:

```text
https://www.offergrid.tech/admin.html
```

## Backups

Back up:

- `.env`
- `data/catalog.json`
- `data/private-config.json`

Do not commit `.env` or `data/private-config.json` to Git.


## eBay account deletion callback

Configure in OfferGrid Admin first:

```text
Endpoint:
https://www.offergrid.tech/api/ebay/account-deletion
```

Store the eBay verification token in the encrypted Admin vault.

Use **Test deletion callback** before submitting the URL/token to eBay.

Then enter the same endpoint and token in:

```text
eBay Developer Portal
→ Alerts & Notifications
→ Marketplace Account Deletion
```


Public trust page:

```text
https://www.offergrid.tech/methodology.html
```


## V2.7 automation

```env
AUTO_SYNC_ENABLED=true
AUTO_SYNC_MINUTES=360
EBAY_COMPETITOR_SCAN_ENABLED=true
EBAY_COMPETITOR_SCAN_MINUTES=60
EBAY_COMPETITOR_PRODUCTS_PER_RUN=40
EBAY_COMPETITOR_RESULTS_PER_PRODUCT=25
EBAY_COMPETITOR_TITLE_MATCH_MIN=0.78
```

If upgrading by copying an older `.env`, change an old `AUTO_SYNC_ENABLED=false` value to `true`.


## V2.7.1 competitor integrity cleanup

Copy the existing `data/catalog.json`; do not discard it.

V2.7.1 runs cleanup before automated scans start and creates:

```text
data/catalog.pre-v271-competitor-cleanup.json
```

on the first cleanup.

Recommended configuration:

```env
EBAY_COMPETITOR_SCAN_ENABLED=true
EBAY_COMPETITOR_SCAN_MINUTES=60
EBAY_COMPETITOR_TITLE_MATCH_MIN=0.90

EBAY_COMPETITOR_CLEANUP_ENABLED=true
EBAY_COMPETITOR_CLEANUP_HOURS=24
```


## V2.8 catalog growth

Recommended live settings:

```env
AUTO_SYNC_ENABLED=true
AUTO_SYNC_MINUTES=20
CATALOG_TARGET_PRODUCTS=10000
DISCOVERY_RULES_PER_CYCLE=24
DISCOVERY_RESULTS_PER_RULE=50
DISCOVERY_MAX_RULES=300
DISCOVERY_EXPANSIONS_PER_STALLED_RULE=2
DISCOVERY_MAX_GENERATION_DEPTH=5

EBAY_COMPETITOR_SCAN_ENABLED=true
EBAY_COMPETITOR_TITLE_MATCH_MIN=0.90
EBAY_COMPETITOR_CLEANUP_ENABLED=true
EBAY_COMPETITOR_CLEANUP_HOURS=24
```

V2.8 creates `data/catalog.pre-v280-competitor-reset.json` before its first
new competitor-integrity reset.


## V2.9 precision

Recommended:

```env
EBAY_PRICE_VERIFY_ENABLED=true
EBAY_PRICE_VERIFY_MINUTES=60
EBAY_PRICE_VERIFY_OFFERS_PER_RUN=40
EBAY_LIVE_VERIFY_MAX_AGE_MINUTES=15

EBAY_BUYER_COUNTRY=US
EBAY_BUYER_POSTAL_CODE=

CATALOG_INTEGRITY_ENABLED=true
CATALOG_INTEGRITY_HOURS=6
```

V2.9 creates a one-time safety backup:

```text
data/catalog.pre-v290-integrity-rebuild.json
```

The first precision migration intentionally resets legacy eBay history that cannot be proven
to have come from exact item-detail verification.


## V3.0 TURBO

Recommended performance settings:

```env
VERBOSE_LOGGING=true
DB_PRETTY_JSON=false
STORE_PAGE_SIZE=40
CATALOG_SEARCH_THREADS=2

DISCOVERY_IO_CONCURRENCY=4

EBAY_PRICE_VERIFY_MINUTES=10
EBAY_PRICE_VERIFY_OFFERS_PER_RUN=320
EBAY_PRICE_VERIFY_BATCH_SIZE=20
EBAY_VARIATION_VERIFY_BATCH_SIZE=10
EBAY_PRICE_VERIFY_CONCURRENCY=4
EBAY_STARTUP_VERIFY_BURST_RUNS=5
EBAY_STARTUP_VERIFY_BURST_DELAY_MS=8000

LIVE_SEARCH_ENABLED=true
LIVE_SEARCH_RESULTS=60
LIVE_SEARCH_VERIFY_LIMIT=60
LIVE_SEARCH_TIMEOUT_MS=15000
USER_SEARCH_RULE_LIMIT=120
```

Public catalog pages are capped at 100 items per page.

Catalog search/ranking uses worker threads. eBay network work uses bounded asynchronous
concurrency and bulk `getItems` verification rather than one OS thread per HTTP request.


## V3.2 INTELLIGENCE

V3.2 is compatible with the V3.1/V3.0 runtime configuration and database.

No new environment variables are required.

The update changes public positioning and renders a purchasing-intelligence
summary from existing API data. Backend services, price verification, search
workers, discovery, catalog growth, database integrity, and marketplace
connectors are unchanged.


## V3.3 RATEGUARD

Recommended Production rate protection:

```env
EBAY_RATE_GUARD_ENABLED=true
EBAY_BROWSE_DAILY_LIMIT=5000
EBAY_GETITEMS_DAILY_LIMIT=5000
EBAY_RATE_SAFETY_MARGIN=300
EBAY_INTERACTIVE_RESERVE=900
EBAY_RATE_MIN_INTERVAL_MS=180
EBAY_RATE_LIMIT_COOLDOWN_MINUTES=60
EBAY_SEARCH_CACHE_SECONDS=120
EBAY_BACKGROUND_MISSING_FALLBACK_MAX=0
EBAY_INTERACTIVE_MISSING_FALLBACK_MAX=2
```

Runtime usage is persisted to `data/ebay-api-usage.json` and survives normal
server restarts. The file is ignored by Git.

V3.3 also prevents malformed Browse search calls that can produce eBay error
12001 by validating keyword/GTIN/ISBN/ePID inputs before the HTTP request and
using conservative product-title/Brand+MPN fallback where appropriate.

All V3.2 price-intelligence UI, V3.1 responsive behavior, and V3.0 search,
discovery, verification, and catalog features remain present.


## V3.4 LIFECYCLE

Recommended lifecycle settings:

```env
PRODUCT_LIFECYCLE_ENABLED=true
PRODUCT_LIFECYCLE_HOURS=24
PRODUCT_DORMANT_DAYS=120
PRODUCT_STALE_DAYS=365
PRODUCT_PRUNABLE_DAYS=365
PRODUCT_PRUNE_GRACE_DAYS=30
PRODUCT_PROTECTED_RETENTION_DAYS=730
PRODUCT_LIFECYCLE_CLICK_PROTECTION_THRESHOLD=5
PRODUCT_LIFECYCLE_HISTORY_PROTECTION_SAMPLES=12
PRODUCT_DORMANT_REFRESH_DAYS=7
PRODUCT_STALE_REFRESH_DAYS=30

PRICE_HISTORY_RAW_DAYS=90
PRICE_HISTORY_WEEKLY_DAYS=365
PRICE_AGGREGATE_RETENTION_DAYS=3650
PRICE_COMPRESSION_HOURS=12
```

The lifecycle creates a one-time safety backup at:

```text
data/catalog.pre-v340-lifecycle.json
```

and appends lifecycle audit events to:

```text
data/product-lifecycle.jsonl
```

Archived products remain canonical tombstones inside `data/catalog.json`.
They keep the OfferGrid product ID and durable identity/history summaries but
do not count against the 10,000-product live catalog target.

No database reset is required when upgrading from V3.3. Existing products are
migrated in place.

The first lifecycle run is conservative: an old weak product can become
PRUNABLE immediately, but it does not archive until the configured
`PRODUCT_PRUNE_GRACE_DAYS` has elapsed in PRUNABLE state.

Products with GTIN/UPC/EAN, Brand+MPN, meaningful historical price data, or
user traffic receive longer protected retention by default.

V3.3 eBay RATEGUARD remains active for all dormant/stale revival probes.


## V3.5 MICROCHARTS

No new environment variables are required.

V3.5 adds a cached, lightweight price-history line to product-list responses
and renders it as a square mobile microchart beneath the square product image.

There are no additional marketplace calls and no per-card browser API calls.

Existing V3.4 lifecycle/compression settings automatically supply long-term
weekly/monthly history to the chart when raw observations have already been
compacted.


## V3.6 SIGNATURE GRID

No new environment variables, marketplace permissions, database reset, or API
configuration are required.

V3.6 is a storefront presentation update. It reuses the cached V3.5
`priceSparkline` and the price/market statistics already returned with catalog
results.

Large desktop changes from four compact product cards per row to two richer
price-intelligence cards per row. Mobile remains optimized for narrow displays.


## V3.7 LIVE SYNC

No new npm dependency or marketplace credential is required. `/api/live/stream` and `/api/admin/live/stream` are long-lived `text/event-stream` connections with 25-second heartbeats and work through the existing Cloudflare Tunnel origin. Public browser refreshes hit OfferGrid's local APIs only; V3.3 RATEGUARD continues to govern all marketplace traffic. Static HTML/JS/CSS/manifest responses now use `Cache-Control: no-cache, must-revalidate`, and top-level CSS/JS references carry `?v=3.7.0`.


## V3.7.1 BOOTFIX

Deploy V3.7.1 as a normal replacement for V3.7.

No environment-variable or database migration is required.

The important browser-cache change is that the complete ES-module graph is now
build-keyed to `3.7.1`, including `common.js`.

Users who already hard-refreshed V3.7 should transition normally. Users still
holding mixed/stale browser assets receive the new versioned entry assets and,
after V3.7.1 has booted once, remain protected by the existing automatic
client-version guardian.

The static header/boot-recovery fallback is intentionally independent of the
ES-module graph so a future module-cache failure cannot leave the navbar blank.


### Deal Heat outlier pruning

No environment changes are required.

V3.7.1 keeps raw price history intact but uses a conservative median/MAD filter
for the 30-day Deal Heat baseline when at least five usable observations exist.

An isolated current price below 20% or above 500% of a stable prior median is
classified as `Verify anomaly` for Deal Heat and cannot become Hot/Scorching
from the historical/new-low components alone.


## V3.7.2 EBAY SEARCH RECOVERY

No database reset is required.

Recommended default:

```env
EBAY_EXACT_SEARCH_QUARANTINE_DAYS=30
```

If eBay Production returns Browse error 12001 for an otherwise locally-valid
GTIN/ePID, OfferGrid preserves that identifier as canonical product identity,
uses a keyword fallback for the current scan, and avoids retrying the rejected
exact search on every background pass for the quarantine period.


## V3.7.3 REMOTE QUOTA

Recommended settings:

```env
EBAY_ANALYTICS_SYNC_ENABLED=true
EBAY_ANALYTICS_SYNC_MINUTES=30
EBAY_ANALYTICS_CACHE_MINUTES=15
EBAY_RESOURCE_LIMIT_COOLDOWN_HOURS=24
```

No new credential is required. The Developer Analytics application-rate
resource uses the existing eBay application OAuth credentials.

If eBay has already exhausted the current Browse quota, deploying V3.7.3 will
not create new allowance. It will synchronize the remote state, keep eBay work
deferred, continue serving stored OfferGrid intelligence, and resume when the
available quota/reset state permits it.

The 24-hour setting is only the fallback for a hard `errorId 2001` response when
a usable authoritative reset time is unavailable.


## V3.7.4 EXACT COMPETITOR PROOF

No database migration command is required. On startup, the normal competitor
integrity cleanup revalidates every pre-V4 competitor attachment under the exact-proof rules,
creates `data/catalog.pre-v374-exact-competitor-proof.json` if needed, upgrades
legacy offers that can prove exact identity, removes the rest and their
competitor-generated history, then allows only exact-proven competitor listings
to remain or repopulate.

Optional/default setting:

```env
EBAY_COMPETITOR_EXACT_BATCH_SIZE=20
```

This release intentionally sacrifices competitor coverage when exact identity
cannot be established. Do not weaken this behavior to improve match counts;
false negatives are preferred over false competitive comparisons.

## V3.7.5 BULK SANITIZER + GROWTH CHECK READY

No manual database migration is required.

New runtime files are created automatically:

```text
data/ebay-api-metrics.json
```

This file contains persistent eBay endpoint call/cache/error counters used for
Admin telemetry and future Application Growth Check planning. Keep it with the
normal OfferGrid data directory when moving servers.

Recommended defaults are already present in `.env.live.example`. In particular,
keep all allowance and soft-limit values in environment configuration rather
than editing code:

```env
EBAY_BROWSE_DAILY_LIMIT=5000
EBAY_GETITEMS_DAILY_LIMIT=5000
EBAY_SOFT_LIMIT_START_PCT=70
EBAY_SOFT_LIMIT_STRICT_PCT=85
EBAY_SOFT_LIMIT_CRITICAL_PCT=95
EBAY_DISCOVERY_QUOTA_SHARE=0.30
EBAY_COMPETITOR_SCAN_QUOTA_SHARE=0.25
EBAY_COMPETITOR_SANITIZER_QUOTA_SHARE=0.45
EBAY_PRICE_VERIFY_QUOTA_SHARE=0.45
EBAY_ITEM_DETAIL_CACHE_SECONDS=300
EBAY_ITEM_IDENTITY_CACHE_SECONDS=86400
EBAY_USAGE_DAY_RETENTION_DAYS=45
EBAY_USAGE_HOUR_RETENTION_HOURS=1080
```

If eBay later approves a higher production allowance through Application Growth
Check, update the daily-limit environment values and restart OfferGrid. No code
change is required.

The public site remains catalog-first during quota pressure. Existing OfferGrid
products, history, micrographs and price intelligence continue to load even when
fresh eBay work is being deferred.

Equivalent concurrent keyword searches are deduplicated after Unicode/whitespace
normalization and case folding. Exact PRODUCT item-detail requests can also
satisfy simultaneous lean market-data callers, avoiding duplicate eBay calls
when the sanitizer/scanner overlaps the price verifier.

## V3.7.6 UNIVERSAL TRUST FILTER

V3.7.6 runs the universal eBay relationship cleanup at startup through the existing
competitor-cleanup startup cycle. On first launch it creates:

`data/catalog.pre-v376-universal-trust-filter.json`

Expected startup logging includes the number of legacy broad eBay relationships isolated
and the number of secondary listings retained after exact proof.

No new eBay credentials or quota settings are required. All V3.7.5 Growth Check-ready
API efficiency and quota controls remain active.

A temporary reduction in seller counts after deployment is expected and desirable: weak
or legacy same-product relationships disappear immediately from public intelligence and
only exact-proven relationships remain.


## V3.7.7 CLEANUP PROGRESS CONSOLE

V3.7.7 preserves the V3.7.6 trust migration and API behavior. During startup,
`[competitor-cleanup]` now emits visible phase progress before `app.listen()`, so
a large local cleanup no longer looks like a hung/offline process. Output covers
catalog load, safety backup, legacy relationship scanning, isolated relationship
rebuild, dedicated competitor proof audit, history sanitation, affected-product
intelligence rebuild, durable catalog commit, and a final elapsed-time summary.

The progress reporting is local only and does not consume eBay quota.


## V3.7.9 EARLY STARTUP PROGRESS

V3.7.9 adds visibility before the V3.7.7 cleanup console begins. The launcher prints `[startup-bootstrap]` before the application dependency graph loads. The synchronous `initDb()` path then reports `[startup-db]` progress for catalog loading, parsing/migration, Price Signal indexing, product intelligence cache rebuilding, serialization, and atomic persistence. After database initialization completes, the existing catalog-integrity, universal competitor-trust cleanup, and product-lifecycle startup phases run exactly as before.

Optional tuning:

```env
DB_STARTUP_PROGRESS_ITEMS=100
```

This telemetry is local process output only and consumes no marketplace quota.


## V3.7.10 SIGNAL INDEX PROGRESS

Price Signal index construction now exposes live counted progress for offer trust scanning, raw history indexing, aggregate-history indexing, and per-product sparkline compaction. These phases are local startup work and do not depend on eBay API quota availability.


## V3.7.11 CACHE ACCELERATION

No deployment dependency changes are required. The optimization is entirely in-process and dependency-free. During startup, expect two additional local progress phases before the final cache rebuild: `startup product/offer lookup index` and `Deal Heat 30-day history index`. These phases make OfferGrid's existing calculations faster by pre-indexing the data they already use; they do not make eBay API calls.


## V3.7.12 INTEGRITY ACCELERATION

Phase 1 catalog integrity now uses bulk/indexed rescoring and cache reconstruction instead of the legacy per-product whole-catalog path. The startup console displays counted tqdm-style bars for integrity relationship scanning, identity normalization, rescoring, and the Price Signal / Deal Heat / cache rebuild subphases. No eBay API calls are introduced by this optimization.

## V3.7.13 FULL STARTUP ACCELERATION

This patch changes local startup execution strategy only; it does not relax marketplace trust, identity, price-accuracy, Deal Heat, Price Signal, lifecycle, or archive rules.

After deploying, restart OfferGrid normally. During startup you should see progress through database initialization, catalog integrity, competitor trust cleanup, and lifecycle maintenance. Long lifecycle sections now render counted tqdm-style progress instead of appearing idle.

No new npm dependency or environment variable is required. Existing `STARTUP_TQDM*` settings continue to control the live startup bars.
