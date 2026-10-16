import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  __marketingAnalyticsTest,
  attachAffiliateClickReference,
  attributionFromRequest,
  normalizeAttribution,
} from "../lib/marketingAnalytics.js";
import {
  intelligenceEligibleListing,
  listingConditionExclusionReason,
} from "../lib/listingCondition.js";
import { correctedProductCategory } from "../lib/catalogQuality.js";
import {
  normalizeVisitorLocation,
  visitorLocationFromHeaders,
} from "../lib/visitorAnalytics.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parseCsvRows, token, deviceClass } = __marketingAnalyticsTest;

assert.equal(token("Shot or Shock / Dallas North"), "shot_or_shock_dallas_north");
assert.equal(deviceClass("Mozilla/5.0 (iPhone; Mobile)"), "mobile");
assert.equal(deviceClass("Googlebot/2.1"), "bot");
assert.deepEqual(
  normalizeAttribution({ utm_source: "Shot or Shock", utm_campaign: "Dallas Launch", og_area: "Area 1" }),
  { source: "shot_or_shock", medium: "", campaign: "dallas_launch", content: "", term: "", area: "area_1", partner: "" }
);
assert.equal(attributionFromRequest({}, "https://example.com/story").medium, "referral");

assert.deepEqual(
  visitorLocationFromHeaders({
    "cf-iplatitude": "32.7766642",
    "cf-iplongitude": "-96.7969879",
    "cf-ipcity": "Dallas",
    "cf-region": "Texas",
    "cf-region-code": "TX",
    "cf-ipcountry": "US",
    "cf-connecting-ip": "203.0.113.42",
  }),
  { latitude: 32.78, longitude: -96.8, city: "Dallas", region: "Texas", regionCode: "TX", country: "US" }
);
assert.equal(normalizeVisitorLocation({ latitude: 999, longitude: -96.8 }), null);

const csv = 'network,transaction_id,commission_amount,merchant\nawin,"order,42",12.50,"Example Store"\n';
const rows = parseCsvRows(csv);
assert.equal(rows.length, 2);
assert.equal(rows[1][1], "order,42");

const reference = "ogc_test_123";
assert.equal(new URL(attachAffiliateClickReference("https://www.ebay.com/itm/1?campid=2", "ebay", reference)).searchParams.get("customid"), reference);
assert.equal(new URL(attachAffiliateClickReference("https://www.awin1.com/cread.php?awinmid=1", "awin", reference)).searchParams.get("clickref"), reference);
delete process.env.RAKUTEN_SIGNATURE_TRACKING_ENABLED;
assert.equal(new URL(attachAffiliateClickReference("https://click.linksynergy.com/deeplink?id=1", "rakuten", reference)).searchParams.has("u1"), false);
process.env.RAKUTEN_SIGNATURE_TRACKING_ENABLED = "true";
assert.equal(new URL(attachAffiliateClickReference("https://click.linksynergy.com/deeplink?id=1", "rakuten", reference)).searchParams.get("u1"), reference);
delete process.env.RAKUTEN_SIGNATURE_TRACKING_ENABLED;

for (const title of [
  "Apple iPad - Battery Issue",
  "Phone activation locked",
  "Tablet with cracked screen",
  "Console for parts or repair",
]) {
  assert.ok(listingConditionExclusionReason({ title }), `Expected exclusion: ${title}`);
  assert.equal(intelligenceEligibleListing({ title }), false);
}
assert.equal(intelligenceEligibleListing({ title: "Camera with new spare battery included" }), true);
assert.equal(correctedProductCategory("Aquarium", "1 Person Camping Pop Up Tent Outdoor Hiking"), "Camping Tents");
assert.equal(correctedProductCategory("Aquarium", "Aquarium fish tank shelter cave"), "Aquarium");

const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const database = fs.readFileSync(path.join(root, "lib", "db.js"), "utf8");
const publicHtml = fs.readdirSync(path.join(root, "public"))
  .filter(name => name.endsWith(".html"))
  .map(name => fs.readFileSync(path.join(root, "public", name), "utf8"));
assert.ok(server.includes("CAMPAIGN_TRAFFIC_MODE"));
assert.ok(server.includes('"/dallas/area-1": "1"'));
assert.ok(server.includes('utm_source: "shot_or_shock"'));
assert.ok(server.includes("Record the landing at the server edge"));
assert.ok(server.includes("recordMarketingVisit({"));
assert.ok(server.includes("attachAffiliateClickReference"));
assert.ok(!server.includes("script-src 'self' 'unsafe-inline'"));
assert.ok(publicHtml.every(html => !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)));
assert.ok(database.includes("OUTBOUND_CLICK_LEDGER_FILE"));
const analytics = fs.readFileSync(path.join(root, "lib", "marketingAnalytics.js"), "utf8");
assert.ok(analytics.includes("attributedVisits"));
assert.ok(analytics.includes("areaTaggedVisits"));
assert.ok(analytics.includes('events.filter(event => Boolean(text(event.area, 120)))'));
const adminHtml = fs.readFileSync(path.join(root, "public", "admin.html"), "utf8");
const adminJs = fs.readFileSync(path.join(root, "public", "js", "admin.js"), "utf8");
assert.ok(adminHtml.includes("Traffic by Dallas placement link"));
assert.ok(adminHtml.includes("Connected visitors + location history"));
assert.ok(adminJs.includes("not IP geolocation"));
assert.ok(adminJs.includes('button.dataset.geoWindow || "live"'));
assert.ok(adminJs.includes("visitorWorldMap"));
const privacyHtml = fs.readFileSync(path.join(root, "public", "privacy.html"), "utf8");
assert.ok(privacyHtml.includes("rounds coordinates to two decimal places"));
const recordStart = database.indexOf("export function recordOutboundClick");
const recordEnd = database.indexOf("\nexport function", recordStart + 10);
assert.ok(recordStart >= 0);
assert.ok(!database.slice(recordStart, recordEnd > recordStart ? recordEnd : undefined).includes("scheduleDeferredWrite"));

console.log("PASS: campaign attribution, affiliate sub-ID, CSV parsing, defect filtering, and click-ledger guards passed.");
