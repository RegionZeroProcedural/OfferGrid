# OfferGrid v3.7.61 — secure campaign deployment

This release adds a restrained glass treatment, a subtle CSS-only textured
backdrop, production-immutable versioned assets, and visibility-aware browser
heartbeats without changing OfferGrid's core layout or campaign attribution.

This is a sanitized deployment candidate for the Shot or Shock Dallas marketing run. It contains the catalog and application source, but no `.env`, credential vault, visitor history, historical click rows, visitor-generated search rules, click or commission ledgers, API metrics, logs, temporary files, backups, or `node_modules`.

## Critical action before using this build

The supplied v3.7.59 archive contained a live `.env`, an encrypted `data/private-config.json`, and the encryption key needed to open that vault. Treat every credential from that archive as exposed if the archive was ever shared or uploaded anywhere outside your control.

Rotate and replace:

- the OfferGrid admin password, session secret, and vault encryption key;
- eBay, Awin, Rakuten, Best Buy, Amazon, OpenAI, SFTP, and other credentials that were stored in Admin;
- the Squirrel publisher script identifier if that prior bundle left your control;
- Cloudflare Access/tunnel credentials if they were ever stored alongside the project.

Do not copy the old `.env` or old `private-config.json` into this release.

## Launch configuration

1. Extract the archive into a new release directory.
2. Run `npm ci --omit=dev` with Node 20 or newer.
3. Copy `.env.live.example` to `.env` on the server only.
4. Run `npm run secrets` and place the generated values into `.env`.
5. Fill in newly rotated partner/API credentials. For eBay, set `EBAY_ENVIRONMENT=production` and a real `EBAY_AFFILIATE_CAMPAIGN_ID`; without the campaign ID, eBay clicks are not commissionable.
6. Add the replacement Squirrel publisher URL only if Squirrel is part of this campaign.
7. Create a Cloudflare Access application for `/admin.html` and `/api/admin/*`, allow only the owner email(s), then keep `CLOUDFLARE_ACCESS_REQUIRED=true`.
8. Run `npm run check`, `npm run predeploy:audit`, and `npm run check:live`. Do not launch while any check fails.
9. Start with `CAMPAIGN_TRAFFIC_MODE=true`. This pauses scheduled catalog mutation and maintenance that caused multi-second event-loop stalls during the audit. Local catalog browsing and shopper-triggered marketplace search remain available.
10. In Cloudflare, enable **Rules → Settings → Managed Transforms → Add visitor location headers**. OfferGrid uses only the city/region/country and rounded latitude/longitude fields; it does not store `CF-Connecting-IP` in its analytics ledgers.
11. Confirm `/api/health` returns `ok: true`, log in through Cloudflare Access, and verify the Admin campaign-mode badge reads **PAID TRAFFIC PROTECTION ON**.

The application binds to `127.0.0.1`; publish it only through the configured Cloudflare Tunnel/reverse proxy. Do not expose port 3000 directly.

## Three Dallas tracking URLs

Use one distinct QR code/short link per paid area. Replace the generic area names with the exact placement names if Shot or Shock provides them.

```text
https://www.offergrid.tech/dallas/area-1

https://www.offergrid.tech/dallas/area-2

https://www.offergrid.tech/dallas/area-3
```

Each short path redirects to the storefront while setting the fixed `shot_or_shock`, `dallas_launch_2026`, and matching `dallas_area_1/2/3` tags. This avoids relying on a QR or placement vendor to preserve a long query string. Add `?test=1` during pre-launch checks (for example, `/dallas/area-1?test=1`) to keep test rows visibly separate from the production campaign.

`utm_source`, `utm_medium`, and `utm_campaign` support standard analytics reporting. `og_area` is the stable placement-area key. `utm_content` can instead distinguish creative variants within an area. Keep the spelling stable for the entire run. Dallas placement reporting is link-based; OfferGrid does not infer a Dallas area from an IP address.

## What is recorded

- The first landing creates signed, HttpOnly first-party attribution, visitor, and session cookies.
- Stored analytics contain hashed visitor/session identifiers, landing path, referring host, device class, campaign fields, outbound product/offer/provider, and—when enabled—approximate edge city/region/country plus coordinates rounded to two decimals. The application analytics ledgers do not store raw IP addresses.
- Admin → Returning visitors includes a live world map plus 24-hour, 7-day, and 30-day approximate location history. Location fields expire after 30 days by default; current connections expire after the presence TTL.
- Each outbound click receives a unique `ogc_…` reference. OfferGrid adds it as eBay `customid`, Awin `clickref`, or Rakuten `u1` when Rakuten Signature tracking is explicitly enabled.
- Visits, outbound clicks, and commissions use append-only NDJSON ledgers, so a click no longer causes a full 222 MB catalog rewrite.
- Admin → Marketing performance shows visits, unique visitors, outbound clicks, CTR, and breakdowns by campaign and Dallas area.

## Commission reconciliation

Download `public/downloads/commission_import_template.csv` from the Admin panel. Export transactions from each partner and map at least:

- `network`
- `transaction_id`
- `commission_amount`
- `status`
- the returned sub-ID as `click_reference` (`customid`, `clickref`, and `u1` are also accepted header names)

If a returned click reference matches an OfferGrid click, source, campaign, content, and Dallas area are filled automatically. Re-importing the same `network + transaction_id` updates the transaction rather than double-counting it. Partner reports can also provide those campaign columns directly.

Rakuten `u1` must remain off unless Signature tracking is enabled for the account. Squirrel commission matching depends on the sub-ID/reporting options supported by the publisher account; if Squirrel cannot return OfferGrid's click reference, import its report with campaign/area columns or reconcile at the network level.

## 24–48 hour preflight

- Open each of the three campaign URLs on a real phone and confirm its area appears in Admin after the presence heartbeat.
- Confirm the same phone appears on Admin’s live map with an approximate city/region. If it does not, verify Cloudflare’s Add visitor location headers transform is enabled and that the request reached the origin through the Cloudflare hostname.
- Click one eBay, one Awin, and one Rakuten offer that is actually enabled. Inspect only the redirect URL/query in a test environment and confirm the expected per-click field is present.
- Place a low-cost test order with each material affiliate partner, then confirm the partner report preserves the click reference. Cancel only if the partner's test-order rules allow it.
- Import a small report and confirm the approved/pending/reversed amounts and matched-click count.
- Test the homepage, search, a product detail page, disclosures, privacy page, 404 handling, Admin login/logout, and a commission import at phone and desktop widths.
- Run a short load test against cached catalog pages from the same host/network path that will serve the campaign. Watch event-loop warnings, memory, error rate, p95 response time, and Cloudflare origin health.
- Back up `data/catalog.json` and the three new ledgers. Test restore before launch.

## Remaining architectural limit

Campaign mode removes the audited hot-path catalog writes and scheduled heavy jobs, but this release still loads a roughly 222 MB JSON catalog into one Node process and is not designed for horizontal multi-instance writes. For a larger or always-on acquisition program, move catalog state and analytics to a transactional database and run background discovery/verification in a separate worker service. For this run, use one application writer, campaign mode, enough RAM, health monitoring, and a rollback copy of the prior release.
