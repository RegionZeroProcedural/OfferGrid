import "dotenv/config";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsFiles = [];

function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === "node_modules") continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full);
    else if (item.name.endsWith(".js")) jsFiles.push(full);
  }
}

walk(root);

for (const file of jsFiles) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}


const { searchRelevance } = await import(pathToFileURL(path.join(root, "lib/searchRelevance.js")));
const { generatePrecisionSearchVariants } = await import(pathToFileURL(path.join(root, "services/searchExpansion.js")));
const {
  candidateCanonicalKey,
  canonicalStrongEpid,
  canonicalStrongGtin,
  canonicalStrongMpn,
  sanitizeIdentityForStorage,
  strongIdentityBaseKey,
  strongVariantOwnershipConflict,
  variantCompatibility,
  variantIdentityDiscriminator,
} = await import(pathToFileURL(path.join(root, "lib/productIdentity.js")));
const { exactCompetitorProof } = await import(pathToFileURL(path.join(root, "lib/productMatch.js")));
const {
  buildEbayGetItemsBatches,
  summarizeEbayGetItemsBatches,
} = await import(pathToFileURL(path.join(root, "lib/ebayBatching.js")));

const batchSingles = buildEbayGetItemsBatches(
  Array.from({ length: 41 }, (_, index) => `v1|${100000000000 + index}|0`)
);
if (batchSingles.length !== 3 || batchSingles[0].ids.length !== 20 || batchSingles[1].ids.length !== 20 || batchSingles[2].ids.length !== 1) {
  throw new Error("eBay batching regression: single-item getItems batches are not packed at 20 IDs/call.");
}
const batchVariations = buildEbayGetItemsBatches(
  Array.from({ length: 21 }, (_, index) => `v1|${200000000000 + index}|${index + 1}`)
);
if (batchVariations.length !== 3 || batchVariations[0].ids.length !== 10 || batchVariations[1].ids.length !== 10 || batchVariations[2].ids.length !== 1) {
  throw new Error("eBay batching regression: variation getItems batches are not packed at 10 IDs/call.");
}
const batchSummaryFixture = summarizeEbayGetItemsBatches([...batchSingles, ...batchVariations]);
if (batchSummaryFixture.calls !== 6 || batchSummaryFixture.units !== 62) {
  throw new Error("eBay batching regression: bulk-call demand summary is incorrect.");
}

const searchFixtures = [
  ["crowsfoot wrench set", "Metric Crowfoot Wrench Set 8pc", true],
  ["crowsfoot wrench set", "20V Impact Wrench Kit", false],
  ["crowsfoot wrench set", "3/8 Drive Ratchet Socket Set", false],
  ["timing light", "INNOVA 3568 Digital Timing Light", true],
  ["timing light", "Automotive Inductive Timing-Light Gun", true],
  ["timing light", "TimingLight Automotive Ignition Tester", true],
  ["timing light", "Timing Belt Kit With Work Light", false],
  ["timing light", "LED Work Light", false],
];

for (const [query, title, expected] of searchFixtures) {
  const actual = searchRelevance(query, { title, searchText: title }).relevant;
  if (actual !== expected) {
    throw new Error(`Search regression: ${query} => ${title}; expected ${expected}, got ${actual}`);
  }
}


const { __rakutenTest } = await import(pathToFileURL(path.join(root, "providers/rakuten.js")));
const rakutenFixture = `<?xml version="1.0" encoding="UTF-8"?>
<result><TotalMatches>1</TotalMatches><TotalPages>1</TotalPages><PageNumber>1</PageNumber>
<item><mid>123</mid><merchantname>Example &amp; Co</merchantname><linkid>456</linkid><sku>ABC-1</sku>
<productname>Example USB-C Charger</productname><category><primary>Electronics</primary><secondary>Chargers~~USB-C</secondary></category>
<price currency="USD">49.99</price><saleprice currency="USD">39.99</saleprice><upccode>012345678905</upccode>
<linkurl>https://example.test/click?a=1&amp;b=2</linkurl><imageurl>https://example.test/image.jpg</imageurl></item></result>`;
const rakutenParsed = __rakutenTest.parseProductSearchXml(rakutenFixture);
if (rakutenParsed.length !== 1) throw new Error("Rakuten parser regression: fixture item was not parsed.");
if (rakutenParsed[0].provider !== "rakuten" || rakutenParsed[0].externalId !== "123:ABC-1") {
  throw new Error("Rakuten parser regression: provider/external ID normalization failed.");
}
if (rakutenParsed[0].price !== 39.99 || rakutenParsed[0].originalPrice !== 49.99) {
  throw new Error("Rakuten parser regression: sale/retail pricing normalization failed.");
}
if (!rakutenParsed[0].affiliateUrl.includes("&b=2")) {
  throw new Error("Rakuten parser regression: XML affiliate-link decoding failed.");
}
if (__rakutenTest.normalizeQuery("USB-C & charger (100W)").includes("&")) {
  throw new Error("Rakuten query sanitizer regression: unsupported characters leaked into Product Search.");
}

const { __rakutenCatalogTest } = await import(pathToFileURL(path.join(root, "providers/rakutenCatalog.js")));
const catalogFile = __rakutenCatalogTest.parseFeedFileName("1888875_4744392_mp.txt.gz");
const catalogDelta = __rakutenCatalogTest.parseFeedFileName("1888875_4744392_mp_delta.txt.gz");
if (!catalogFile || catalogFile.mid !== "1888875" || catalogFile.sid !== "4744392" || catalogFile.delta) {
  throw new Error("Rakuten Product Catalog filename regression: full feed name was not recognized.");
}
if (!catalogDelta?.delta) {
  throw new Error("Rakuten Product Catalog filename regression: delta feed name was not recognized.");
}
if (__rakutenCatalogTest.parseFeedFileName("1888875_4744392_mp_template.txt.gz")) {
  throw new Error("Rakuten Product Catalog filename regression: template file should be ignored.");
}
const quotedPipe = __rakutenCatalogTest.parsePipeLine('1|"Product | With Pipe"|SKU-1');
if (quotedPipe[1] !== "Product | With Pipe") {
  throw new Error("Rakuten Product Catalog parser regression: quoted pipe field was split incorrectly.");
}
const catalogFields = Array(38).fill("");
catalogFields[0] = "101";
catalogFields[1] = "Waterdrop G3 Reverse Osmosis System";
catalogFields[2] = "WD-G3";
catalogFields[3] = "Water Filtration";
catalogFields[4] = "Under Sink~~Reverse Osmosis";
catalogFields[5] = "https://example.test/rakuten-click";
catalogFields[6] = "https://example.test/g3.jpg";
catalogFields[12] = "399.99";
catalogFields[13] = "499.99";
catalogFields[16] = "Waterdrop";
catalogFields[19] = "WD-G3";
catalogFields[22] = "in-stock";
catalogFields[23] = "012345678905";
catalogFields[25] = "USD";
const catalogCandidate = __rakutenCatalogTest.candidateFromFields(catalogFields, {
  mid: "1888875",
  merchantName: "Waterdrop Filter",
  observedAt: "2026-08-29T00:00:00.000Z",
});
if (
  !catalogCandidate ||
  catalogCandidate.externalId !== "1888875:WD-G3" ||
  catalogCandidate.price !== 399.99 ||
  catalogCandidate.originalPrice !== 499.99 ||
  catalogCandidate.priceSource !== "rakuten-product-catalog"
) {
  throw new Error("Rakuten Product Catalog candidate normalization regression.");
}



const knownValidGtin = "027242925816";
if (canonicalStrongGtin(knownValidGtin) !== "00027242925816") {
  throw new Error("Identity hardening regression: valid UPC was not normalized to canonical GTIN-14.");
}
for (const invalid of ["Does not apply", "N/A", "unknown", "0045242502776, 0826659227724", "027242925817"]) {
  if (canonicalStrongGtin(invalid)) {
    throw new Error(`Identity hardening regression: invalid/ambiguous GTIN was trusted (${invalid}).`);
  }
}
for (const invalidMpn of ["Does not apply", "N/A", "unknown", "PLA/PLA+/ABS/PETG/TPU/SILK", "Power circuit tester tool", "Aquarium_Filter"]) {
  if (canonicalStrongMpn(invalidMpn)) {
    throw new Error(`Identity hardening regression: placeholder/descriptive MPN was trusted (${invalidMpn}).`);
  }
}
if (strongIdentityBaseKey({ gtin: "Does not apply" })) {
  throw new Error("Identity hardening regression: placeholder GTIN became a strong canonical key.");
}
const placeholderKey = candidateCanonicalKey({ provider: "ebay", externalId: "v1|placeholder|0", gtin: "Does not apply", title: "Example item" });
if (!placeholderKey.startsWith("listing:ebay:")) {
  throw new Error("Identity hardening regression: placeholder GTIN did not fall back to listing-scoped ownership.");
}
const placeholderProof = exactCompetitorProof(
  { title: "Example Filter", gtin: "Does not apply" },
  { title: "Example Filter", gtin: "Does not apply" }
);
if (placeholderProof.ok || !placeholderProof.reasons.includes("no-provable-reference-identity")) {
  throw new Error("Identity hardening regression: placeholder identifiers were accepted as exact competitor proof.");
}

const oneYearCombo = {
  provider: "rakuten",
  externalId: "1888875:WD-G3-COMBO-1Y",
  brand: "Waterdrop",
  mpn: "WD-G3-FILTER",
  title: "Waterdrop G3 1-Year Combo Filter Set",
};
const twoYearCombo = {
  provider: "rakuten",
  externalId: "1888875:WD-G3-COMBO-2Y",
  brand: "Waterdrop",
  mpn: "WD-G3-FILTER",
  title: "Waterdrop G3 2-Year Combo Filter Set",
};
const oneYearKey = candidateCanonicalKey(oneYearCombo);
const twoYearKey = candidateCanonicalKey(twoYearCombo);
if (oneYearKey === twoYearKey) {
  throw new Error("Variant identity regression: 1-year and 2-year combo sets collapsed onto the same canonical key.");
}
if (!oneYearKey.startsWith("mpn:waterdrop:wdg3filter:variant:")) {
  throw new Error("Variant identity regression: strong MPN key did not retain a bundle discriminator.");
}
const comboCompatibility = variantCompatibility(oneYearCombo.title, twoYearCombo.title);
if (comboCompatibility.ok || !comboCompatibility.reasons.includes("duration")) {
  throw new Error("Variant identity regression: duration conflict was not detected for combo sets.");
}
if (variantIdentityDiscriminator("Waterdrop G3 with 2-Year Limited Warranty")) {
  throw new Error("Variant identity regression: warranty duration incorrectly became a package discriminator.");
}
const wrongDurationCompetitor = exactCompetitorProof(
  { title: oneYearCombo.title, brand: oneYearCombo.brand, mpn: oneYearCombo.mpn },
  { title: twoYearCombo.title, brand: twoYearCombo.brand, mpn: twoYearCombo.mpn }
);
if (wrongDurationCompetitor.ok || !wrongDurationCompetitor.reasons.includes("exact-duration-conflict")) {
  throw new Error("Competitor proof regression: shared MPN incorrectly proved two different duration bundles as identical.");
}
const sameDurationCompetitor = exactCompetitorProof(
  { title: twoYearCombo.title, brand: twoYearCombo.brand, mpn: twoYearCombo.mpn },
  { title: "Waterdrop G3 2 Year Combo Filter Set", brand: "Waterdrop", mpn: "WD-G3-FILTER" }
);
if (!sameDurationCompetitor.ok) {
  throw new Error(`Competitor proof regression: equivalent 2-year duration spelling was rejected (${sameDurationCompetitor.reasons.join(",")}).`);
}

if (!strongVariantOwnershipConflict(
  { title: "Waterdrop X12 RO System Replacement Filter Combo Set - 1200GPD", brand: "Waterdrop", mpn: "WD-X12-COMBO" },
  { title: "2 year Combo Set for Waterdrop X12/X14/X16 RO System Replacement Filter", brand: "Waterdrop", mpn: "WD-X12-COMBO" }
)) {
  throw new Error("Variant ownership regression: explicit 2-year bundle was allowed to remain attached to an unlabeled strong-ID owner.");
}
if (strongVariantOwnershipConflict(
  { title: "Waterdrop X12 2-Year Combo Set", brand: "Waterdrop", mpn: "WD-X12-COMBO" },
  { title: "Waterdrop X12 2 Year Combo Set", brand: "Waterdrop", mpn: "WD-X12-COMBO" }
)) {
  throw new Error("Variant ownership regression: equivalent explicit durations were incorrectly separated.");
}
if (strongVariantOwnershipConflict(
  { title: "Waterdrop X12 2-Year Combo Set", brand: "Waterdrop", mpn: "WD-X12-COMBO" },
  { title: "Waterdrop X12 Replacement Filter Combo Set", brand: "Waterdrop", mpn: "WD-X12-COMBO" }
)) {
  throw new Error("Variant ownership regression: an unlabeled candidate was allowed to destabilize an explicit variant owner.");
}

const { __ebayCompetitorScannerTest } = await import(pathToFileURL(path.join(root, "services/ebayCompetitorScanner.js")));
const multiSignalPlans = __ebayCompetitorScannerTest.competitorDiscoveryPlans({
  gtin: knownValidGtin,
  epid: "123456789",
  brand: "Waterdrop",
  mpn: "WD-G3-FILTER",
  title: "Waterdrop G3 2-Year Combo Filter Set",
});
const multiSignalMethods = multiSignalPlans.map(plan => plan.method);
for (const method of ["GTIN", "ePID", "Brand + MPN", "MPN-only", "Strict title"]) {
  if (!multiSignalMethods.includes(method)) {
    throw new Error(`eBay competitor multi-signal regression: ${method} discovery plan was not generated alongside the other available signals.`);
  }
}
if (multiSignalPlans.length !== new Set(multiSignalPlans.map(plan =>
  JSON.stringify([Boolean(plan.keywordOnly), plan.params?.gtin || "", plan.params?.epid || "", plan.params?.query || ""])
)).size) {
  throw new Error("eBay competitor multi-signal regression: duplicate discovery requests were not deduplicated.");
}

let provenanceFixture = __ebayCompetitorScannerTest.mergeCandidateDiscovery(
  null,
  { provider: "ebay", externalId: "v1|123|0", title: "Waterdrop G3" },
  "Strict title"
);
provenanceFixture = __ebayCompetitorScannerTest.mergeCandidateDiscovery(
  provenanceFixture,
  { provider: "ebay", externalId: "v1|123|0", title: "Waterdrop G3" },
  "GTIN"
);
if (!provenanceFixture.competitorDiscoveryMethods.includes("title") ||
    !provenanceFixture.competitorDiscoveryMethods.includes("gtin") ||
    provenanceFixture.competitorDiscoveryPrimaryMethod !== "gtin" ||
    Number(provenanceFixture.competitorDiscoveryConfidence || 0) < 95) {
  throw new Error("eBay competitor provenance regression: multi-signal discovery sources were not merged or strongest-source precedence was lost.");
}

const recallPlans = __ebayCompetitorScannerTest.competitorRecallPlans({
  brand: "Waterdrop",
  mpn: "WD-G3-FILTER",
  title: "Waterdrop G3 2-Year Combo Filter Set",
}, {
  method: "Brand + MPN",
  params: { query: "Waterdrop WD-G3-FILTER" },
  keywordOnly: true,
});
if (!recallPlans.length || recallPlans.some(plan => plan.method === "Brand + MPN")) {
  throw new Error("eBay competitor recall regression: compatible non-primary discovery plans were not generated.");
}

const timingVariants = generatePrecisionSearchVariants({ query: "timing light" });
if (!timingVariants.some(item => /automotive timing light/i.test(item.query))) {
  throw new Error("Search regression: timing-light recall plan lost automotive context probe.");
}
if (timingVariants.some(item => !searchRelevance("timing light", { title: item.query, searchText: item.query }).relevant)) {
  throw new Error("Search regression: a timing-light recall variant dropped original intent terms.");
}


const {
  computeIntelligenceSnapshot,
} = await import(pathToFileURL(path.join(root, "workers/dealHeatWorker.js")));
const { __intelligenceWorkerPoolTest } = await import(
  pathToFileURL(path.join(root, "services/intelligenceWorkerPool.js"))
);

const now = Date.now();
const historyFixture = [100, 100, 100, 100, 100, 1000, 95, 90].map((price, index) => ({
  at: new Date(now - (8 - index) * 3_600_000).toISOString(),
  price,
  aggregated: false,
}));
const intelligenceFixture = computeIntelligenceSnapshot({
  productId: 999,
  generation: 7,
  bestOffer: { price: 90, originalPrice: 120, score: 85 },
  history30d: historyFixture,
  sparklineHistory: historyFixture,
});
if (intelligenceFixture.productId !== 999 || intelligenceFixture.generation !== 7) {
  throw new Error("Async intelligence regression: worker identity/generation was not preserved.");
}
if (Number(intelligenceFixture.stats.dealHeatOutliersPruned || 0) < 1) {
  throw new Error("Async intelligence regression: Median/MAD worker did not prune the extreme history outlier.");
}
if (!Array.isArray(intelligenceFixture.sparkline) || intelligenceFixture.sparkline.length > 18) {
  throw new Error("Async intelligence regression: worker sparkline compaction exceeded the materialized-view cap.");
}
if (
  __intelligenceWorkerPoolTest.threads < 1 ||
  __intelligenceWorkerPoolTest.threads > Math.max(1, __intelligenceWorkerPoolTest.cpuCount - 2)
) {
  throw new Error("Async intelligence regression: worker-pool CPU reservation is unsafe.");
}

const dbSource = fs.readFileSync(path.join(root, "lib/db.js"), "utf8");
const initStart = dbSource.indexOf("export function initDb");
const initEnd = dbSource.indexOf("function readDb", initStart);
const initSource = dbSource.slice(initStart, initEnd);
if (/rebuildAllProductCaches\s*\(/.test(initSource)) {
  throw new Error("Lazy-boot regression: initDb still performs a full product intelligence cache rebuild.");
}
const hydrateStart = dbSource.indexOf("function hydrate(");
const hydrateEnd = dbSource.indexOf("function rescoreProductInDb", hydrateStart);
const hydrateSource = dbSource.slice(hydrateStart, hydrateEnd);
if (/calculatePriceStats\s*\(/.test(hydrateSource)) {
  throw new Error("Read-through regression: shopper hydration still performs synchronous Deal Heat computation.");
}

const { __bestOfferSelectionTest } = await import(pathToFileURL(path.join(root, "lib/db.js")));
const rankedOfferFixture = __bestOfferSelectionTest.rankEligibleDisplayOffers([
  {
    id: 1,
    provider: "ebay",
    price: 419,
    score: 99,
    priceVerifiedAt: "2026-08-31T12:00:00.000Z",
    affiliateUrl: "https://example.test/high",
  },
  {
    id: 2,
    provider: "ebay",
    price: 303.99,
    score: 62,
    priceVerifiedAt: "2026-08-31T11:00:00.000Z",
    affiliateUrl: "https://example.test/low",
  },
  {
    id: 3,
    provider: "ebay",
    price: 199,
    score: 100,
    affiliateUrl: "https://example.test/unverified",
  },
  {
    id: 4,
    provider: "ebay",
    price: 99,
    score: 100,
    priceVerifiedAt: "2026-08-31T12:00:00.000Z",
    availability: "out_of_stock",
    affiliateUrl: "https://example.test/unavailable",
  },
  {
    id: 5,
    provider: "rakuten",
    price: 89,
    score: 100,
    priceDisplayRestricted: true,
    affiliateUrl: "https://example.test/restricted",
  },
]);
if (rankedOfferFixture[0]?.id !== 2 || rankedOfferFixture.at(-1)?.id !== 3) {
  throw new Error("V3.7.61 best-offer regression: a higher-scored expensive listing can outrank a cheaper eligible verified listing, or an unverified observation can cross the verification boundary.");
}

const { runCatalogSearch } = await import(pathToFileURL(path.join(root, "services/catalogSearchCore.js")));
const heatOrderFixture = runCatalogSearch([
  { id: "verified-cool", title: "Fixture A", heat: 20, verificationRank: 2, bestScore: 99 },
  { id: "hot", title: "Fixture B", heat: 91, verificationRank: 1, bestScore: 60 },
  { id: "warm", title: "Fixture C", heat: 55, verificationRank: 2, bestScore: 80 },
], { sort: "heat" });
if (heatOrderFixture.ids.join(",") !== "hot,warm,verified-cool") {
  throw new Error(`V3.7.61 Deal Heat regression: full catalog ordering is not heat-first (${heatOrderFixture.ids.join(",")}).`);
}

const v3759StoreSource = fs.readFileSync(path.join(root, "public/js/store.js"), "utf8");
const v3759CommonSource = fs.readFileSync(path.join(root, "public/js/common.js"), "utf8");
const v3759AdminSource = fs.readFileSync(path.join(root, "public/js/admin.js"), "utf8");
const v3759IndexSource = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const v3759StyleSource = fs.readFileSync(path.join(root, "public/css/style.css"), "utf8");
const v3761ServerSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
if (!dbSource.includes("BEST_OFFER_CACHE_SCHEMA_VERSION") ||
    !dbSource.includes("repairBestOfferCachesInDb") ||
    !dbSource.includes("PENDING_STARTUP_INTELLIGENCE_IDS") ||
    !v3759StoreSource.includes("let appliedQuery") ||
    !v3759StoreSource.includes("function applyCatalogCategories(data)") ||
    !v3759StoreSource.includes("function applyLocalCardSort") ||
    !v3759CommonSource.includes('["og_build", "og_recover", "og_t"]') ||
    !v3759AdminSource.includes("adminHasUnsavedEdits") ||
    !v3759AdminSource.includes("messageTimer") ||
    !v3759IndexSource.includes("lowest eligible verified seller price") ||
    !v3759StyleSource.includes("V3.7.61 PROFESSIONAL STOREFRONT + MOBILE CLEANUP") ||
    !v3759StyleSource.includes("V3.7.61 RESTRAINED GLASS + TEXTURED BACKDROP") ||
    !v3759StyleSource.includes("prefers-reduced-transparency") ||
    !v3759CommonSource.includes("const scheduleHeartbeat = () =>") ||
    v3759CommonSource.includes("visitorHeartbeatTimer = setInterval") ||
    v3759CommonSource.includes('style="display:block"') ||
    !v3759StyleSource.includes(".adsbygoogle{display:block}") ||
    !v3761ServerSource.includes("public, max-age=31536000, immutable") ||
    !v3759StoreSource.includes('fetchpriority="low"')) {
  throw new Error("V3.7.61 integration regression: cache repair, committed search state, stale-category guard, canonical cleanup, admin edit protection, or responsive storefront polish is missing.");
}

JSON.parse(fs.readFileSync(path.join(root, "data/catalog.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

console.log(`PASS: ${jsFiles.length} JavaScript files syntax-checked.`);
console.log("PASS: JSON files parsed.");
console.log("PASS: precision-search regression fixtures passed.");
console.log("PASS: API credential vault module included.");
console.log("PASS: Rakuten Product Search parser/query fixtures passed.");
console.log("PASS: Rakuten Product Catalog filename/pipe/candidate fixtures passed.");
console.log("PASS: package-duration identity separation + explicit-vs-unlabeled ownership fixtures passed.");
console.log("PASS: eBay competitor recall fallback fixtures passed.");
console.log("PASS: async Deal Heat worker, CPU reservation, and lazy-boot/read-through guards passed.");
console.log("PASS: V3.7.61 lowest-eligible verified offer, heat-first ordering, cache migration, storefront state, and visual-polish guards passed.");

const { __draftAutoApprovalTest } = await import(pathToFileURL(path.join(root, "lib/db.js")));
const draftNow = new Date().toISOString();
const baseDraft = {
  id: 9001,
  approved: false,
  approvalSource: "draft",
  autoApprovalBlocked: false,
  manualReviewTouchedAt: null,
  lifecycleState: "ACTIVE",
  createdAt: draftNow,
  updatedAt: draftNow,
  title: "Sony WF-1000XM5 Wireless Noise Canceling Earbuds",
  brand: "Sony",
  category: "Electronics > Headphones",
  imageUrl: "https://example.test/sony.jpg",
  gtin: "027242925816",
  mpn: "WF1000XM5/B",
  epid: "",
  canonicalKey: "gtin:027242925816",
  primaryEbayOfferId: null,
};
const rakutenStrongOffer = {
  id: 9101,
  productId: 9001,
  provider: "rakuten",
  externalId: "123:SONY-WF1000XM5",
  merchant: "Example Merchant",
  price: 249.99,
  affiliateUrl: "https://example.test/rakuten",
  imageUrl: "https://example.test/sony.jpg",
  availability: "in_stock",
  priceDisplayRestricted: false,
  priceSource: "rakuten-product-search",
  matchSource: "rakuten-product-search",
  score: 85,
};
let draftVerdict = __draftAutoApprovalTest.evaluateDraftAutoApprovalInDb(
  { products: [baseDraft], offers: [rakutenStrongOffer] },
  baseDraft
);
if (!draftVerdict.eligible || draftVerdict.confidence < __draftAutoApprovalTest.threshold()) {
  throw new Error(`Draft auto-review regression: strong normalized Rakuten search product was not publishable (${draftVerdict.reasons.join(",")}).`);
}

const weakRakutenDraft = {
  ...baseDraft,
  id: 9002,
  gtin: "",
  mpn: "",
  brand: "",
  canonicalKey: "title:sony-wf1000xm5-earbuds",
};
const weakRakutenOffer = {
  ...rakutenStrongOffer,
  id: 9102,
  productId: 9002,
};
draftVerdict = __draftAutoApprovalTest.evaluateDraftAutoApprovalInDb(
  { products: [weakRakutenDraft], offers: [weakRakutenOffer] },
  weakRakutenDraft
);
if (draftVerdict.eligible) {
  throw new Error("Draft auto-review regression: weak title-only Rakuten Product Search draft was auto-publishable.");
}

const exactEbayDraft = {
  ...baseDraft,
  id: 9003,
  gtin: "",
  mpn: "",
  brand: "",
  canonicalKey: "listing:ebay:v1|123456789012|0",
  primaryEbayOfferId: 9103,
};
const exactEbayOffer = {
  id: 9103,
  productId: 9003,
  provider: "ebay",
  externalId: "v1|123456789012|0",
  merchant: "seller",
  price: 199.99,
  affiliateUrl: "https://example.test/ebay",
  imageUrl: "https://example.test/sony.jpg",
  availability: "in_stock",
  priceDisplayRestricted: false,
  priceSource: "ebay-item-detail",
  priceVerifiedAt: draftNow,
  matchSource: "",
  competitorIdentityStatus: "",
  score: 80,
};
draftVerdict = __draftAutoApprovalTest.evaluateDraftAutoApprovalInDb(
  { products: [exactEbayDraft], offers: [exactEbayOffer] },
  exactEbayDraft
);
if (!draftVerdict.eligible || !draftVerdict.reasons.includes("isolated-ebay-listing")) {
  throw new Error(`Draft auto-review regression: exact isolated eBay listing did not pass safe publication (${draftVerdict.reasons.join(",")}).`);
}

const lockedDraft = { ...baseDraft, id: 9004, autoApprovalBlocked: true };
const lockedOffer = { ...rakutenStrongOffer, id: 9104, productId: 9004 };
draftVerdict = __draftAutoApprovalTest.evaluateDraftAutoApprovalInDb(
  { products: [lockedDraft], offers: [lockedOffer] },
  lockedDraft
);
if (draftVerdict.eligible || !draftVerdict.reasons.includes("manual-review-lock")) {
  throw new Error("Draft auto-review regression: manually locked draft could be republished automatically.");
}

console.log("PASS: confident draft auto-review fixtures passed.");

const gameConsoleDraft = {
  ...baseDraft,
  id: 9010,
  title: "Nintendo Switch OLED Game Console",
  brand: "Nintendo",
  category: "Video Games > Consoles",
  gtin: "",
  mpn: "",
  canonicalKey: "listing:ebay:v1|999999999999|0",
};
const gameConsoleOffer = {
  ...exactEbayOffer,
  id: 9110,
  productId: 9010,
  externalId: "v1|999999999999|0",
  priceSource: "ebay-search",
  priceVerifiedAt: null,
};
const unrelatedDraft = {
  ...gameConsoleDraft,
  id: 9011,
  title: "USB Game Controller",
  category: "Gaming Accessories",
  canonicalKey: "listing:ebay:v1|999999999998|0",
};
const unrelatedOffer = {
  ...gameConsoleOffer,
  id: 9111,
  productId: 9011,
  externalId: "v1|999999999998|0",
};
const lockedGameDraft = {
  ...gameConsoleDraft,
  id: 9012,
  autoApprovalBlocked: true,
  canonicalKey: "listing:ebay:v1|999999999997|0",
};
const lockedGameOffer = {
  ...gameConsoleOffer,
  id: 9112,
  productId: 9012,
  externalId: "v1|999999999997|0",
};
const draftMatches = __draftAutoApprovalTest.getDraftSearchCandidatesInDb(
  {
    products: [gameConsoleDraft, unrelatedDraft, lockedGameDraft],
    offers: [gameConsoleOffer, unrelatedOffer, lockedGameOffer],
  },
  { q: "game consoles", limit: 20 }
);
if (draftMatches.length !== 1 || draftMatches[0].productId !== 9010) {
  throw new Error(`Interactive draft promotion regression: expected only the strict current-query game-console draft, got ${JSON.stringify(draftMatches)}.`);
}
if (!draftMatches[0].ebayExternalIds.includes("v1|999999999999|0")) {
  throw new Error("Interactive draft promotion regression: unverified eBay external ID was not queued for exact foreground verification.");
}

const pendingVerdict = __draftAutoApprovalTest.evaluatePendingVerificationVisibilityInDb(
  {
    products: [gameConsoleDraft],
    offers: [gameConsoleOffer],
    clicks: [],
  },
  gameConsoleDraft
);
if (!pendingVerdict.eligible || pendingVerdict.confidence < __draftAutoApprovalTest.pendingThreshold()) {
  throw new Error(`Pending-verification fallback regression: safe isolated eBay draft was not shopper-visible (${pendingVerdict.reasons.join(",")}).`);
}
const pendingHydrated = __draftAutoApprovalTest.hydratePendingVerificationProductInDb(
  {
    products: [gameConsoleDraft],
    offers: [gameConsoleOffer],
    clicks: [],
  },
  gameConsoleDraft,
  pendingVerdict,
  { includeHistory: true }
);
if (!pendingHydrated?.verificationPending || pendingHydrated.priceStats?.dealHeat !== 0) {
  throw new Error("Pending-verification fallback regression: shopper projection did not withhold Deal Heat.");
}
if (pendingHydrated.ebayCompetition || pendingHydrated.marketComparison || pendingHydrated.priceHistory?.length) {
  throw new Error("Pending-verification fallback regression: unverified eBay draft leaked comparison/history intelligence.");
}
const lockedPendingVerdict = __draftAutoApprovalTest.evaluatePendingVerificationVisibilityInDb(
  {
    products: [lockedGameDraft],
    offers: [lockedGameOffer],
    clicks: [],
  },
  lockedGameDraft
);
if (lockedPendingVerdict.eligible) {
  throw new Error("Pending-verification fallback regression: manually locked draft became shopper-visible.");
}

const liveSearchSource = fs.readFileSync(path.join(root, "services/liveSearch.js"), "utf8");
if (!liveSearchSource.includes("interactive-search-preflight") ||
    !liveSearchSource.includes("getDraftSearchCandidates") ||
    (!liveSearchSource.includes("hydrates verified competitor coverage across the entire page") &&
     !liveSearchSource.includes("separates first-paint discovery from visible-card"))) {
  throw new Error("Interactive draft promotion regression: query-local draft recovery or the render-first page-hydration boundary is missing.");
}
const storeSource = fs.readFileSync(path.join(root, "public/js/store.js"), "utf8");
if (!storeSource.includes("launchDetachedSearchWork") ||
    !storeSource.includes('phase === "discovery-listings-arrived"') ||
    !storeSource.includes('phase === "discovery-safe-results-progress"') ||
    !storeSource.includes("discoveryRenderBarrierPending") ||
    !storeSource.includes("renderCatalogResponse(data)")) {
  throw new Error("V3.7.43 storefront regression: progressive safe-result rendering or the detached hydration barrier is missing.");
}
if (!storeSource.includes("verificationPending") || !storeSource.includes("eBay verification pending")) {
  throw new Error("Pending-verification fallback regression: storefront does not label pending eBay results distinctly.");
}
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
if (!serverSource.includes("mergePendingVerificationIntoCatalogPage") || !serverSource.includes("getPendingVerificationSearchProducts")) {
  throw new Error("Pending-verification fallback regression: server does not merge safe pending drafts into rate-limited shopper search.");
}
const adminSource = fs.readFileSync(path.join(root, "public/js/admin.js"), "utf8");
const adminHtmlSource = fs.readFileSync(path.join(root, "public/admin.html"), "utf8");
if (!adminSource.includes("ebay-quota-grid") || !adminSource.includes("ebay-endpoint-table")) {
  throw new Error("Admin layout regression: eBay counter telemetry lost its structured quota/table layout.");
}
if (!adminHtmlSource.includes("toggle-rules-list") || !adminHtmlSource.includes("toggle-products-list") || !adminSource.includes("ADMIN_FOLD_STORAGE_KEY")) {
  throw new Error("Admin fold regression: rule/product list collapse controls are missing or not persistent.");
}
const ebayUsageSource = fs.readFileSync(path.join(root, "lib/ebayApiUsage.js"), "utf8");
const ebayProviderSource = fs.readFileSync(path.join(root, "providers/ebay.js"), "utf8");
const priceVerifierSource = fs.readFileSync(path.join(root, "services/ebayPriceVerifier.js"), "utf8");
if (!ebayUsageSource.includes("noteEbayDeferredDemand") ||
    !ebayUsageSource.includes("estimatedUnconstrainedCallsPerDay") ||
    !ebayUsageSource.includes("recommendedRequestedDailyLimit") ||
    !ebayUsageSource.includes("deferredSummary") ||
    !ebayUsageSource.includes("bulkCallsSavedVsOneItem")) {
  throw new Error("eBay quota telemetry regression: shadow demand or recommended-limit projection is missing.");
}
if (!ebayProviderSource.includes("demandCapacity") ||
    !ebayProviderSource.includes("EBAY_GETITEMS_BATCH_TOO_LARGE") ||
    !priceVerifierSource.includes("plannedBatchFillPct") ||
    !priceVerifierSource.includes("EBAY_ALLOW_INDIVIDUAL_GETITEM_FALLBACK")) {
  throw new Error("eBay API efficiency regression: provider/verifier bulk-efficiency guards are missing.");
}
if (!adminSource.includes("Measured uncapped demand/day") ||
    !adminSource.includes("Recommended request") ||
    !adminSource.includes("Minimum calls to clear backlog") ||
    !adminSource.includes("7-day quota evidence") ||
    !adminSource.includes("Bulk calls saved")) {
  throw new Error("Admin quota-growth regression: uncapped demand/recommended quota/backlog evidence is not visible.");
}
if (!adminSource.includes("EBAY_TELEMETRY_REFRESH_MS = 2000") ||
    !adminSource.includes('/api/admin/ebay/usage?light=1') ||
    !adminSource.includes("Deferred attempts today") ||
    !adminSource.includes("Unique blocked work units") ||
    !serverSource.includes('const light = String(req.query?.light || "") === "1"') ||
    !serverSource.includes("verificationDemand: light ? null : getEbayVerificationDemandSnapshot()")) {
  throw new Error("Admin live eBay telemetry regression: lightweight two-second polling or visible deferred counters are missing.");
}

const dbSourceForDraftRotation = fs.readFileSync(path.join(root, "lib/db.js"), "utf8");
if (!dbSourceForDraftRotation.includes('product.lastAutoReviewDecision = "deferred"') ||
    !dbSourceForDraftRotation.includes('Date.parse(a.lastAutoReviewAt || "")')) {
  throw new Error("Draft curator regression: skipped batches can still starve newer drafts instead of rotating.");
}

const competitorPrefilterFixture = __ebayCompetitorScannerTest.prefilterCompetitorCandidates(
  {
    id: 99101,
    title: "Waterdrop G3 2-Year Combo Filter Set",
    brand: "Waterdrop",
    mpn: "WD-G3-FILTER",
    offers: [],
  },
  {
    listingTitle: "Waterdrop G3 2-Year Combo Filter Set",
    brand: "Waterdrop",
    conditionGroup: "new",
  },
  [
    {
      provider: "ebay",
      externalId: "v1|coverage-good|0",
      title: "Waterdrop G3 2 Year Combo Filter Set",
      listingTitle: "Waterdrop G3 2 Year Combo Filter Set",
      brand: "Waterdrop",
      conditionGroup: "new",
    },
    {
      provider: "ebay",
      externalId: "v1|coverage-bad-accessory|0",
      title: "Waterdrop G3 RO Faucet Replacement",
      listingTitle: "Waterdrop G3 RO Faucet Replacement",
      brand: "Waterdrop",
      conditionGroup: "new",
    },
    {
      provider: "ebay",
      externalId: "v1|coverage-bad-duration|0",
      title: "Waterdrop G3 1 Year Combo Filter Set",
      listingTitle: "Waterdrop G3 1 Year Combo Filter Set",
      brand: "Waterdrop",
      conditionGroup: "new",
    },
  ]
);
if (competitorPrefilterFixture.plausible.length !== 1 ||
    competitorPrefilterFixture.plausible[0].externalId !== "v1|coverage-good|0") {
  throw new Error(`eBay competitor coverage regression: Browse-first pending prefilter accepted the wrong candidates (${JSON.stringify(competitorPrefilterFixture.rejected)}).`);
}
const competitorScannerSource = fs.readFileSync(path.join(root, "services/ebayCompetitorScanner.js"), "utf8");
const dbSourceForCompetitorCoverage = fs.readFileSync(path.join(root, "lib/db.js"), "utf8");
const productSource = fs.readFileSync(path.join(root, "public/js/product.js"), "utf8");
const styleSource = fs.readFileSync(path.join(root, "public/css/style.css"), "utf8");
if (!competitorScannerSource.includes("queueEbayCompetitorCandidates") ||
    !competitorScannerSource.includes("cross-product sanitizer pack") ||
    !competitorScannerSource.includes("EBAY_COMPETITOR_DISCOVERY_RESULTS_PER_PRODUCT") ||
    !competitorScannerSource.includes("EBAY_COMPETITOR_DISCOVERY_SIGNAL_SEARCHES")) {
  throw new Error("eBay competitor coverage regression: multi-signal Browse-first pending queue or higher-yield discovery controls are missing.");
}
if (!dbSourceForCompetitorCoverage.includes("getEbayCompetitorCoverageStatus") ||
    !dbSourceForCompetitorCoverage.includes('String(offer.competitorIdentityStatus || "") !== "pending"') ||
    !dbSourceForCompetitorCoverage.includes("verifiedSellers === 1") ||
    !dbSourceForCompetitorCoverage.includes("seller-coverage deficit")) {
  throw new Error("eBay competitor coverage regression: pending isolation or one-seller scan priority is missing.");
}
if (!serverSource.includes("EBAY_COMPETITOR_SCHEDULER_MINUTES") ||
    !serverSource.includes("EBAY_COMPETITOR_DISCOVERY_QUOTA_SHARE") ||
    !(serverSource.includes("competitorCoverage: getEbayCompetitorCoverageStatus()") ||
      serverSource.includes("competitorCoverage: getAdminEbayCompetitorCoverageStatus()"))) {
  throw new Error("eBay competitor coverage regression: fast scheduler/quota share/Admin coverage telemetry is missing.");
}
if (!adminSource.includes("eBay competitor coverage") ||
    !adminSource.includes("products with exactly 1 verified eBay seller") ||
    !adminSource.includes("seller candidates awaiting exact verification") ||
    !styleSource.includes("V3.7.30 OBSERVED COMPETITOR VERIFICATION STATE")) {
  throw new Error("Admin competitor coverage regression: repaired grouped metrics or coverage counters are missing.");
}
if (!productSource.includes("Needs verification") ||
    !productSource.includes("offer.outboundEligible") ||
    !dbSourceForCompetitorCoverage.includes("outboundEligible: pendingEbayCompetitorLocallySafe")) {
  throw new Error("Pending competitor UI regression: pending seller rows are not clearly separated/safely link-gated.");
}

if (!dbSourceForCompetitorCoverage.includes("runLocalDatabaseCleanup") ||
    !dbSourceForCompetitorCoverage.includes("splitInvalidStrongCanonicalProducts") ||
    !serverSource.includes("startLocalDatabaseCleanupScheduler") ||
    !competitorScannerSource.includes("competitorDiscoveryPlans")) {
  throw new Error("V3.7.34 normalization/coverage regression: local quota-starved cleanup or additive multi-signal competitor discovery is missing.");
}

console.log("PASS: V3.7.30 identifier hardening + local normalization maintenance guards passed.");
console.log("PASS: current-query draft promotion + progressive storefront fixtures passed.");
console.log("PASS: rate-limit pending-verification fallback + Admin quota/fold controls passed.");
console.log("PASS: eBay 20/10 bulk packing + shadow quota-demand telemetry guards passed.");
console.log("PASS: Browse-first competitor coverage + one-seller priority + Admin layout repair guards passed.");

// V3.7.31-33 startup integrity ordering regression guards.
{
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const db = fs.readFileSync(path.join(root, "lib", "db.js"), "utf8");
  if (!server.includes("catalog integrity migration pending; local normalization deferred") ||
      !server.includes('Number(integrityBefore.integrityVersion || 0) < 313')) {
    throw new Error("V3.7.32 regression: local normalization can run before the authoritative v313 integrity migration.");
  }
  if (!db.includes("const requiredIntegrityVersion = 313") ||
      db.includes("data.meta.catalogIntegrityVersion = Math.max(313")) {
    throw new Error("V3.7.32 regression: bounded local cleanup can bypass or certify global integrity v313.");
  }
  if (!db.includes("data.meta.catalogIntegrityVersion = 313")) {
    throw new Error("V3.7.32 regression: full catalog integrity cycle does not certify v313.");
  }
  console.log("PASS: V3.7.33 authoritative startup-integrity ordering guards passed.");
}

// V3.7.32 boundary hardening regression guards.
{
  const sanitizedBad = sanitizeIdentityForStorage({
    brand: "N/A",
    gtin: "Does not apply",
    mpn: "Power circuit tester tool",
    epid: "not-an-epid",
  });
  if (sanitizedBad.brand || sanitizedBad.gtin || sanitizedBad.mpn || sanitizedBad.epid) {
    throw new Error("V3.7.32 regression: rejected marketplace identity leaked into trusted product fields.");
  }
  if (!sanitizedBad.rejected.gtin || !sanitizedBad.rejected.mpn || !sanitizedBad.rejected.epid) {
    throw new Error("V3.7.32 regression: rejected identity audit breadcrumbs were not retained.");
  }
  const sanitizedGood = sanitizeIdentityForStorage({
    brand: "Sony",
    gtin: "027242925816",
    mpn: "WF1000XM5/B",
    epid: "EPID: 123456789",
  });
  if (sanitizedGood.gtin !== "00027242925816" || sanitizedGood.mpn !== "WF1000XM5/B" || sanitizedGood.epid !== "123456789") {
    throw new Error("V3.7.32 regression: valid trusted identity no longer survives storage normalization.");
  }
  if (canonicalStrongEpid("EPID: 123456789") !== "123456789" || canonicalStrongEpid("javascript:1")) {
    throw new Error("V3.7.32 regression: ePID canonical validation is unsafe.");
  }

  const { __boundaryHardeningTest } = await import(pathToFileURL(path.join(root, "lib/db.js")));
  if (__boundaryHardeningTest.safeHttpUrl("javascript:alert(1)") ||
      __boundaryHardeningTest.safeHttpUrl("data:text/html,<script>alert(1)</script>")) {
    throw new Error("V3.7.32 regression: non-HTTP(S) outbound URLs are still eligible.");
  }
  if (__boundaryHardeningTest.safeHttpUrl("https://www.ebay.com/itm/123") !== "https://www.ebay.com/itm/123") {
    throw new Error("V3.7.32 regression: legitimate HTTPS marketplace URL was rejected.");
  }
  if (__boundaryHardeningTest.finiteNumberOrNull("NaN") !== null ||
      __boundaryHardeningTest.finiteNumberOrNull("19.99", { min: 0 }) !== 19.99) {
    throw new Error("V3.7.32 regression: numeric boundary sanitizer changed valid pricing or admitted invalid values.");
  }

  const db = fs.readFileSync(path.join(root, "lib/db.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  if (!db.includes('source: "ebay-exact-verification"') ||
      !db.includes('applyTrustedProductIdentity(product, {') ||
      db.includes('product.gtin = offer.gtin.slice') ||
      db.includes('product.mpn = offer.mpn.slice') ||
      db.includes('product.epid = offer.epid.slice')) {
    throw new Error("V3.7.33 regression: exact eBay verification can bypass trusted product identity storage.");
  }
  const exactSafeUrlWrites = (db.match(/affiliateUrl: safeHttpUrl\(detail\.affiliateUrl/g) || []).length;
  if (!db.includes("applyTrustedProductIdentity(product, candidate") ||
      !db.includes("applyTrustedProductIdentity(product, identity") ||
      !db.includes("DB_RECOVER_VALID_TEMP") ||
      !db.includes("const affiliateUrl = safeHttpUrl(offer.affiliateUrl") ||
      exactSafeUrlWrites < 2) {
    throw new Error("V3.7.32 regression: ingestion, verifier persistence recovery, or outbound URL hardening is missing.");
  }
  if (!server.includes("safeDecodeComponent") ||
      !server.includes("LOGIN_STATE_MAX_ENTRIES") ||
      !server.includes("raw.length > 4096") ||
      !server.includes("boundedInteger(req.query.page")) {
    throw new Error("V3.7.32 regression: request/session boundary hardening is missing.");
  }
  console.log("PASS: V3.7.33 exact-verifier identity boundary + V3.7.32 hardening guards passed.");
}



// V3.7.34 additive multi-signal competitor discovery + provenance guards.
{
  const scanner = fs.readFileSync(path.join(root, "services/ebayCompetitorScanner.js"), "utf8");
  const db = fs.readFileSync(path.join(root, "lib/db.js"), "utf8");
  const product = fs.readFileSync(path.join(root, "public/js/product.js"), "utf8");
  const store = fs.readFileSync(path.join(root, "public/js/store.js"), "utf8");
  const admin = fs.readFileSync(path.join(root, "public/js/admin.js"), "utf8");
  const style = fs.readFileSync(path.join(root, "public/css/style.css"), "utf8");

  for (const required of [
    'method: "GTIN"',
    'method: "ePID"',
    'method: "Brand + MPN"',
    'method: "MPN-only"',
    'method: "Strict title"',
    "multi-signal discovery complete",
    "dispatching exact competitor verification",
    "getItemsBatches",
    "pendingCandidates",
    "competitorExactDetailObservedAt",
  ]) {
    if (!scanner.includes(required)) {
      throw new Error(`V3.7.34 multi-signal regression: missing scanner behavior ${required}.`);
    }
  }

  if (!db.includes("competitorDiscoveryMethods") ||
      !db.includes("competitorDiscoveryPrimaryMethod") ||
      !db.includes("competitorDiscoveryConfidence") ||
      !db.includes("trackedOfferCount") ||
      !db.includes("identityBlockedPending") ||
      !db.includes("competitorIdentityNextAttemptAt") ||
      !db.includes("candidate.competitorIdentityLastAttemptAt") ||
      !db.includes("candidate.competitorExactDetailObservedAt")) {
    throw new Error("V3.7.34 competitor provenance regression: durable provenance, tracked-count, or exact-verification backoff fields are missing.");
  }

  if (!product.includes("discoverySignalBadges") ||
      !product.includes("Needs verification") ||
      !product.includes("Compare tracked offers") ||
      !product.includes("Additional observed eBay candidates") ||
      !store.includes("product.trackedOfferCount") ||
      !style.includes("MULTI-SIGNAL COMPETITOR PROVENANCE")) {
    throw new Error("V3.7.34 competitor presentation regression: pending/provenance rows or tracked-offer card counts are missing.");
  }

  if (!(admin.includes("pending eligible for getItems") ||
        admin.includes("pending eligible for exact-detail verification")) ||
      !admin.includes("pending waiting for stronger product identity")) {
    throw new Error("V3.7.34 Admin regression: getItems-eligible versus identity-blocked competitor backlog is not visible.");
  }

  console.log("PASS: V3.7.34 additive multi-signal competitor provenance + tracked-offer presentation guards passed.");
}

// V3.7.34 consumer-disclosure + tracked-coverage regression guards.
{
  const common = fs.readFileSync(path.join(root, "public/js/common.js"), "utf8");
  const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  const product = fs.readFileSync(path.join(root, "public/js/product.js"), "utf8");
  const store = fs.readFileSync(path.join(root, "public/js/store.js"), "utf8");
  const trending = fs.readFileSync(path.join(root, "public/js/trending.js"), "utf8");
  const terms = fs.readFileSync(path.join(root, "public/terms.html"), "utf8");
  const disclosure = fs.readFileSync(path.join(root, "public/disclosure.html"), "utf8");
  const methodology = fs.readFileSync(path.join(root, "public/methodology.html"), "utf8");

  if (!common.includes('<a href="/terms.html">Terms of Use</a>') ||
      !common.includes("a lower price may exist elsewhere")) {
    throw new Error("V3.7.34 disclosure regression: global Terms of Use link or tracked-coverage footer qualifier is missing.");
  }
  if (!terms.includes("<h1>Terms of Use</h1>") ||
      !terms.includes("Price, Offer, and Deal Information") ||
      !terms.includes("Third-Party Merchants and Transactions") ||
      !terms.includes("Price History") ||
      !terms.includes("Deal Heat, Rankings, and Value Indicators") ||
      !terms.includes("To the maximum extent permitted by applicable law") ||
      !terms.includes("does not guarantee a particular amount of savings")) {
    throw new Error("V3.7.34 disclosure regression: Terms of Use does not contain the required price/merchant/history/scoring/liability scope.");
  }
  if (!disclosure.includes("Coverage and lowest-price claims") ||
      !/Estimated commission\s+economics can affect the internal ranking/i.test(disclosure) ||
      !methodology.includes("What “lowest” and “best” mean on OfferGrid")) {
    throw new Error("V3.7.34 disclosure regression: Disclosure/Methodology coverage semantics are inconsistent or missing.");
  }
  if (index.includes('<option value="price">Lowest price</option>') ||
      !index.includes('<option value="price">Lowest tracked price</option>') ||
      store.includes("Verified market-low") || trending.includes("Verified market-low") ||
      product.includes("BEST CURRENT VERIFIED OFFER") ||
      !product.includes("TOP-RANKED TRACKED VERIFIED OFFER") ||
      !product.includes("Lowest tracked competing price ⓘ")) {
    throw new Error("V3.7.34 claim-audit regression: an unqualified prominent lowest/best label returned to shopper UI.");
  }
  const prohibitedAbsoluteClaims = [
    "lowest price anywhere",
    "cheapest on the internet",
    "cheapest anywhere",
    "best possible deal",
    "absolute best deal",
    "guaranteed savings",
    "save the most",
  ];
  const promotionalShopperSources = [index, product, store, trending, common].join("\n").toLowerCase();
  for (const phrase of prohibitedAbsoluteClaims) {
    if (promotionalShopperSources.includes(phrase)) {
      throw new Error(`V3.7.34 claim-audit regression: prohibited absolute shopper claim returned: ${phrase}`);
    }
  }
  if (!index.includes("Know when a deal is actually a deal.")) {
    throw new Error("V3.7.34 branding regression: approved OfferGrid tagline was removed during legal-copy hardening.");
  }
  console.log("PASS: V3.7.34 Terms, tracked-coverage terminology, affiliate-disclosure consistency, and absolute-claim guards passed.");
}

// V3.7.35 quota-state, runtime-persistence, and strong-identity duplicate guards.
{
  const rateGuardSource = fs.readFileSync(path.join(root, "lib/ebayRateGuard.js"), "utf8");
  const dbSource = fs.readFileSync(path.join(root, "lib/db.js"), "utf8");
  const scannerSource = fs.readFileSync(path.join(root, "services/ebayCompetitorScanner.js"), "utf8");
  const sanitizerSource = fs.readFileSync(path.join(root, "services/ebayCompetitorSanitizer.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const adminSource = fs.readFileSync(path.join(root, "public/js/admin.js"), "utf8");

  if (!rateGuardSource.includes("nullableFiniteNumber") ||
      !rateGuardSource.includes("hasAuthoritativeRemoteQuota") ||
      !rateGuardSource.includes("remoteKnown") ||
      rateGuardSource.includes("Number.isFinite(Number(value.remoteLimit))")) {
    throw new Error("V3.7.35 quota regression: unknown remote quota can collapse back to a false zero state.");
  }
  if (!adminSource.includes("Not reported · using safe local budget")) {
    throw new Error("V3.7.35 Admin regression: unknown authoritative getItems quota is not distinguished from exhaustion.");
  }

  // Exercise the exact persisted-state bug in an isolated copy so npm check
  // never mutates the live data/ebay-api-usage.json file.
  const runRateGuardFixture = fixture => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offergrid-rateguard-"));
    fs.mkdirSync(path.join(tmp, "lib"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
    fs.copyFileSync(path.join(root, "lib/ebayRateGuard.js"), path.join(tmp, "lib/ebayRateGuard.js"));
    fs.copyFileSync(path.join(root, "lib/opsLog.js"), path.join(tmp, "lib/opsLog.js"));
    fs.writeFileSync(path.join(tmp, "data/ebay-api-usage.json"), JSON.stringify(fixture));
    const probe = `
      import { getEbayRateGuardStatus, acquireEbayApiPermit } from './lib/ebayRateGuard.js';
      const before = getEbayRateGuardStatus().getItems;
      let permit = null; let error = null;
      try { permit = await acquireEbayApiPermit('getItems', { priority: 'background', label: 'v375-check' }); }
      catch (e) { error = { code: e.code, reason: e.details?.reason || e.reason }; }
      console.log(JSON.stringify({ before, permit: permit && { remoteKnown: permit.remoteKnown, usedLast24h: permit.usedLast24h }, error }));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, EBAY_RATE_MIN_INTERVAL_MS: "0", EBAY_RATE_GUARD_ENABLED: "true" },
    }).trim().split(/\r?\n/).at(-1);
    fs.rmSync(tmp, { recursive: true, force: true });
    return JSON.parse(output);
  };

  const baseBucket = {
    events: [], cooldownUntil: 0, lastCallAt: 0, lastRateLimitAt: "",
    remoteRateLimitHits: 0, cooldownReason: "", consecutiveRateLimitHits: 0,
  };
  const ghost = runRateGuardFixture({
    version: 1,
    buckets: {
      browse: { ...baseBucket },
      getItems: {
        ...baseBucket,
        remoteLimit: 0,
        remoteRemaining: 0,
        remoteResetAt: 0,
        remoteSyncedAt: 0,
        remoteResource: "",
      },
    },
  });
  if (ghost.before.remoteKnown !== false || ghost.before.backgroundRemaining <= 0 || ghost.error || !ghost.permit) {
    throw new Error("V3.7.35 quota regression: legacy getItems 0/0-without-provenance did not recover to the safe local budget.");
  }

  const realZero = runRateGuardFixture({
    version: 1,
    buckets: {
      browse: { ...baseBucket },
      getItems: {
        ...baseBucket,
        remoteLimit: 5000,
        remoteRemaining: 0,
        remoteResetAt: Date.now() + 60 * 60 * 1000,
        remoteSyncedAt: Date.now(),
        remoteResource: "getItems",
      },
    },
  });
  if (realZero.before.remoteKnown !== true || realZero.before.backgroundRemaining !== 0 || realZero.permit || realZero.error?.reason !== "remote-quota") {
    throw new Error("V3.7.35 quota regression: a real authoritative zero no longer blocks getItems.");
  }

  if (!dbSource.includes("catalogPersistenceWorker.js") ||
      !dbSource.includes("writeDbOffThread") ||
      !dbSource.includes("v8.serialize(request.data)") ||
      !dbSource.includes("deferPersistence = false") ||
      !(scannerSource.includes('deferPersistence: priority === "background"') || scannerSource.includes('deferPersistence = priority === "background"')) ||
      !sanitizerSource.includes('noteEbayCompetitorSanitizerRun(summary, { deferPersistence: priority === "background" })') ||
      (serverSource.match(/deferPersistence: reason !== "admin-manual"/g) || []).length < 3) {
    throw new Error("V3.7.35 persistence regression: background catalog writes can return to synchronous whole-catalog serialization.");
  }

  const { __normalizationRepairTest } = await import(pathToFileURL(path.join(root, "lib/db.js")));
  const fixture = {
    meta: {},
    products: [
      { id: 1, title: "Wavlink USB-C Dual HDMI Universal Docking Station with 100W Power Delivery", brand: "Wavlink", gtin: "", mpn: "WL-UG76PD2 Pro", epid: "", canonicalKey: "mpn:wavlink:wlug76pd2pro", approved: true, lifecycleState: "ACTIVE" },
      { id: 2, title: "Wavlink USB-C Dual HDMI Universal Docking Station with 100W Power Delivery", brand: "Wavlink", gtin: "", mpn: "WL-UG76PD2 Pro", epid: "", canonicalKey: "listing:ebay:two", approved: true, lifecycleState: "ACTIVE" },
      { id: 3, title: "VIPARSPECTRA Timer Control 165W LED Aquarium Light Full Spectrum Reef Coral Tank", brand: "ViparSpectra", gtin: "0640206933377", mpn: "T165", epid: "3030655119", canonicalKey: "listing:ebay:three", approved: true, lifecycleState: "ACTIVE" },
      { id: 4, title: "VIPARSPECTRA Timer Control 165W LED Aquarium Light Full Spectrum Reef Coral Tank", brand: "ViparSpectra", gtin: "0640206933377", mpn: "T165", epid: "3030655119", canonicalKey: "listing:ebay:four", approved: true, lifecycleState: "ACTIVE" },
      { id: 5, title: "VIPARSPECTRA Timer Control 165W LED Aquarium Light Full Spectrum Reef Coral Tank", brand: "ViparSpectra", gtin: "768788174787", mpn: "T165", epid: "18055726594", canonicalKey: "gtin:768788174787", approved: true, lifecycleState: "ACTIVE" },
    ],
    offers: [
      { id: 11, productId: 1 }, { id: 12, productId: 2 },
      { id: 13, productId: 3 }, { id: 14, productId: 4 }, { id: 15, productId: 5 },
    ],
    priceHistory: [{ id: 21, productId: 2, offerId: 12 }, { id: 22, productId: 4, offerId: 14 }],
    priceAggregates: [{ productId: 2 }, { productId: 4 }],
    clicks: [{ id: 31, productId: 2, offerId: 12 }, { id: 32, productId: 4, offerId: 14 }],
  };
  const merge = __normalizationRepairTest.mergeStrongEvidenceListingDuplicates(fixture);
  if (merge.merged !== 2 || fixture.products.length !== 3 || fixture.offers.length !== 5) {
    throw new Error("V3.7.35 duplicate regression: exact strong-evidence listing duplicates were not merged without deleting offers.");
  }
  const wavlinkOwnerIds = new Set(fixture.offers.filter(o => [11, 12].includes(o.id)).map(o => o.productId));
  const viparOwnerIds = new Set(fixture.offers.filter(o => [13, 14].includes(o.id)).map(o => o.productId));
  if (wavlinkOwnerIds.size !== 1 || viparOwnerIds.size !== 1 || !fixture.products.some(p => p.id === 5)) {
    throw new Error("V3.7.35 duplicate regression: relationship remap failed or conflicting VIPARSPECTRA identity was merged.");
  }
  const second = __normalizationRepairTest.mergeStrongEvidenceListingDuplicates(fixture);
  if (second.merged !== 0) {
    throw new Error("V3.7.35 duplicate regression: strong-evidence merge is not idempotent.");
  }

  console.log("PASS: V3.7.35 unknown-quota recovery, authoritative-zero safety, off-thread persistence, and strong-evidence duplicate guards passed.");
}


// V3.7.36 restricted bulk getItems capability + quota-aware getItem fallback guards.
{
  const providerSource = fs.readFileSync(path.join(root, "providers/ebay.js"), "utf8");
  const integrationSource = fs.readFileSync(path.join(root, "services/integrationTests.js"), "utf8");
  const sanitizerSource = fs.readFileSync(path.join(root, "services/ebayCompetitorSanitizer.js"), "utf8");
  const scannerSource = fs.readFileSync(path.join(root, "services/ebayCompetitorScanner.js"), "utf8");
  const adminSource = fs.readFileSync(path.join(root, "public/js/admin.js"), "utf8");

  if (providerSource.includes("buy.item.bulk") || integrationSource.includes("buy.item.bulk")) {
    throw new Error("V3.7.36 OAuth regression: restricted buy.item.bulk scope returned to the application-token request.");
  }
  for (const required of [
    "bulkGetItemsAccessDenied",
    "getItemsViaIndividualFallback",
    "EBAY_GETITEM_FALLBACK_BROWSE_SHARE",
    "bulk-getItems-403-1100",
    'transport: "getItem-fallback"',
    "getEbayBulkGetItemsCapabilityStatus",
  ]) {
    if (!providerSource.includes(required)) {
      throw new Error(`V3.7.36 fallback regression: missing provider behavior ${required}.`);
    }
  }
  if (!sanitizerSource.includes("response.deferredIds") ||
      !scannerSource.includes("exact-item-detail-deferred") ||
      !adminSource.includes("Exact-detail transport")) {
    throw new Error("V3.7.36 fallback regression: deferred-candidate or Admin capability presentation guard is missing.");
  }

  const runProviderFixture = mode => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offergrid-v376-ebay-"));
    fs.mkdirSync(path.join(tmp, "providers"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "lib"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
    fs.copyFileSync(path.join(root, "providers/ebay.js"), path.join(tmp, "providers/ebay.js"));
    for (const name of ["privateConfig.js", "opsLog.js", "ebayRateGuard.js", "ebayApiUsage.js", "ebayBatching.js", "ebayVerificationPressure.js", "listingCondition.js"]) {
      fs.copyFileSync(path.join(root, "lib", name), path.join(tmp, "lib", name));
    }

    const probe = `
      process.env.EBAY_CLIENT_ID = 'fixture-client';
      process.env.EBAY_CLIENT_SECRET = 'fixture-secret';
      process.env.EBAY_ENVIRONMENT = 'production';
      process.env.EBAY_RATE_MIN_INTERVAL_MS = '0';
      process.env.EBAY_GETITEM_FALLBACK_BROWSE_SHARE = '0.8';
      process.env.EBAY_GETITEM_FALLBACK_MAX_CALLS_PER_WINDOW = '40';
      process.env.TERM = 'dumb';
      const mode = ${JSON.stringify(mode)};
      let oauth = 0, bulk = 0, individual = 0;
      const item = id => ({
        itemId: id,
        title: 'Fixture ' + id,
        price: { value: '10.00', currency: 'USD' },
        seller: { username: 'fixture' },
        itemWebUrl: 'https://www.ebay.com/itm/' + id,
        estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }],
        product: { brand: 'Fixture', mpns: ['M1'], gtins: ['012345678905'] },
      });
      globalThis.fetch = async (input, options = {}) => {
        const url = new URL(String(input));
        if (url.pathname.includes('/identity/v1/oauth2/token')) {
          oauth++;
          const body = String(options.body || '');
          if (body.includes('buy.item.bulk')) throw new Error('restricted bulk scope was requested');
          return new Response(JSON.stringify({ access_token: 'fixture-token', expires_in: 7200 }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname === '/buy/browse/v1/item' && url.searchParams.has('item_ids')) {
          bulk++;
          if (mode === 'denied') {
            return new Response(JSON.stringify({ errors: [{
              errorId: 1100,
              domain: 'ACCESS',
              category: 'REQUEST',
              message: 'Access denied',
              longMessage: 'Insufficient permissions to fulfill the request.',
            }] }), { status: 403, headers: { 'content-type': 'application/json' } });
          }
          const ids = String(url.searchParams.get('item_ids') || '').split(',').filter(Boolean);
          return new Response(JSON.stringify({ items: ids.map(item), warnings: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname.startsWith('/buy/browse/v1/item/')) {
          individual++;
          const id = decodeURIComponent(url.pathname.slice('/buy/browse/v1/item/'.length));
          return new Response(JSON.stringify(item(id)), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error('unexpected fixture URL ' + url.toString());
      };
      const mod = await import('./providers/ebay.js');
      const first = await mod.getEbayItemsDetails(['111', '222'], {
        priority: 'background', includeProductIdentity: true, forceRefresh: true,
      });
      const second = await mod.getEbayItemsDetails(['333'], {
        priority: 'background', includeProductIdentity: true, forceRefresh: true,
      });
      console.log('V376_RESULT:' + JSON.stringify({
        oauth, bulk, individual,
        first: { transport: first.transport, items: first.items.length, capability: first.bulkCapability },
        second: { transport: second.transport, items: second.items.length, capability: second.bulkCapability },
        status: mod.getEbayBulkGetItemsCapabilityStatus(),
      }));
    `;

    const output = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, TERM: "dumb" },
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    const line = output.split(/\r?\n/).find(value => value.startsWith("V376_RESULT:"));
    if (!line) throw new Error(`V3.7.36 fixture ${mode} produced no result marker.`);
    return JSON.parse(line.slice("V376_RESULT:".length));
  };

  const denied = runProviderFixture("denied");
  if (denied.oauth !== 1 || denied.bulk !== 1 || denied.individual !== 3 ||
      denied.first.transport !== "getItem-fallback" || denied.first.items !== 2 ||
      denied.second.transport !== "getItem-fallback" || denied.second.items !== 1 ||
      denied.status?.state !== "denied" || denied.status?.fallbackActive !== true) {
    throw new Error("V3.7.36 fallback regression: one bulk 403 did not switch subsequent exact-detail work to bounded getItem fallback.");
  }

  const allowed = runProviderFixture("allowed");
  if (allowed.oauth !== 1 || allowed.bulk !== 2 || allowed.individual !== 0 ||
      allowed.first.transport !== "getItems" || allowed.first.items !== 2 ||
      allowed.second.transport !== "getItems" || allowed.second.items !== 1 ||
      allowed.status?.state !== "allowed" || allowed.status?.fallbackActive !== false) {
    throw new Error("V3.7.36 bulk regression: an entitled account no longer keeps the efficient getItems path.");
  }

  console.log("PASS: V3.7.36 base-scope OAuth, restricted-bulk detection, quota-aware getItem fallback, and entitled-bulk preservation guards passed.");
}

// V3.7.37 fallback fairness + hot-path responsiveness guards.
{
  const providerSource = fs.readFileSync(path.join(root, "providers/ebay.js"), "utf8");
  const priceSource = fs.readFileSync(path.join(root, "services/ebayPriceVerifier.js"), "utf8");
  const sanitizerSource = fs.readFileSync(path.join(root, "services/ebayCompetitorSanitizer.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const dbSource = fs.readFileSync(path.join(root, "lib/db.js"), "utf8");
  const adminSource = fs.readFileSync(path.join(root, "public/js/admin.js"), "utf8");
  const intelligenceSource = fs.readFileSync(path.join(root, "services/intelligenceWorkerPool.js"), "utf8");

  for (const required of [
    "EBAY_GETITEM_FALLBACK_IDENTITY_RESERVE_SHARE",
    "fallbackIdentityWindowRemaining",
    "fallbackPriceWindowRemaining",
    "beginBulkGetItemsCapabilityProbe",
    "waitForBulkGetItemsCapabilityProbe",
    "failedIds",
  ]) {
    if (!providerSource.includes(required)) {
      throw new Error(`V3.7.37 fallback regression: missing provider behavior ${required}.`);
    }
  }
  if (!priceSource.includes("background price refresh yielded to identity fallback reserve") ||
      !priceSource.includes("response.missingIds") ||
      !sanitizerSource.includes("fallbackIdentityWindowRemaining") ||
      !sanitizerSource.includes("response.missingIds")) {
    throw new Error("V3.7.37 verification regression: fallback fairness or missing-listing propagation is absent.");
  }
  if (!serverSource.includes("getAdminIntegritySummary()") ||
      !serverSource.includes("getAdminEbayCompetitorCoverageStatus()") ||
      !serverSource.includes("getEbayVerificationBacklogStatus()") ||
      !serverSource.includes("getCatalogIntegrityVersionStatus()") ||
      !serverSource.includes("runBackgroundDiscoveryMutation") ||
      !dbSource.includes("getAdminIntegritySummary") ||
      !dbSource.includes("getAdminEbayCompetitorCoverageStatus")) {
    throw new Error("V3.7.37 responsiveness regression: lightweight status reads or serialized discovery mutation lane is missing.");
  }
  if (!adminSource.includes("Fallback identity budget left") ||
      !adminSource.includes("Fallback price budget left") ||
      !adminSource.includes("}, 2000);") ||
      !intelligenceSource.includes("? 5")) {
    throw new Error("V3.7.37 runtime regression: Admin coalescing, fallback telemetry, or CPU headroom guard is missing.");
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offergrid-v377-ebay-"));
  fs.mkdirSync(path.join(tmp, "providers"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "lib"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
  fs.copyFileSync(path.join(root, "providers/ebay.js"), path.join(tmp, "providers/ebay.js"));
  for (const name of ["privateConfig.js", "opsLog.js", "ebayRateGuard.js", "ebayApiUsage.js", "ebayBatching.js", "ebayVerificationPressure.js", "listingCondition.js"]) {
    fs.copyFileSync(path.join(root, "lib", name), path.join(tmp, "lib", name));
  }

  const probe = `
    process.env.EBAY_CLIENT_ID = 'fixture-client';
    process.env.EBAY_CLIENT_SECRET = 'fixture-secret';
    process.env.EBAY_ENVIRONMENT = 'production';
    process.env.EBAY_RATE_MIN_INTERVAL_MS = '0';
    process.env.EBAY_GETITEM_FALLBACK_BROWSE_SHARE = '0.8';
    process.env.EBAY_GETITEM_FALLBACK_IDENTITY_RESERVE_SHARE = '0.8';
    process.env.EBAY_GETITEM_FALLBACK_MAX_CALLS_PER_WINDOW = '40';
    process.env.EBAY_BACKGROUND_GETITEM_FALLBACK_MAX_PER_BATCH = '8';
    process.env.TERM = 'dumb';
    let oauth = 0, bulk = 0, identityCalls = 0, priceCalls = 0;
    const item = id => ({
      itemId: id,
      title: 'Fixture ' + id,
      price: { value: '10.00', currency: 'USD' },
      seller: { username: 'fixture' },
      itemWebUrl: 'https://www.ebay.com/itm/' + id,
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }],
      product: { brand: 'Fixture', mpns: ['M1'], gtins: ['012345678905'] },
    });
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/identity/v1/oauth2/token')) {
        oauth++;
        return new Response(JSON.stringify({ access_token: 'fixture-token', expires_in: 7200 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/buy/browse/v1/item' && url.searchParams.has('item_ids')) {
        bulk++;
        await new Promise(resolve => setTimeout(resolve, 80));
        return new Response(JSON.stringify({ errors: [{
          errorId: 1100, domain: 'ACCESS', category: 'REQUEST', message: 'Access denied',
          longMessage: 'Insufficient permissions to fulfill the request.',
        }] }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.startsWith('/buy/browse/v1/item/')) {
        if (url.searchParams.get('fieldgroups') === 'PRODUCT') identityCalls++;
        else priceCalls++;
        const id = decodeURIComponent(url.pathname.slice('/buy/browse/v1/item/'.length));
        if (id === 'missing-id') return new Response('', { status: 404 });
        return new Response(JSON.stringify(item(id)), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('unexpected fixture URL ' + url.toString());
    };
    const mod = await import('./providers/ebay.js');
    const ids = prefix => Array.from({ length: 10 }, (_, i) => prefix + '-' + i);
    const [priceA, priceB, identity] = await Promise.all([
      mod.getEbayItemsDetails(ids('price-a'), { priority: 'background', includeProductIdentity: false, forceRefresh: true }),
      mod.getEbayItemsDetails(ids('price-b'), { priority: 'background', includeProductIdentity: false, forceRefresh: true }),
      mod.getEbayItemsDetails(ids('identity'), { priority: 'background', includeProductIdentity: true, forceRefresh: true }),
    ]);
    const missing = await mod.getEbayItemsDetails(['missing-id'], {
      priority: 'interactive', includeProductIdentity: true, forceRefresh: true,
    });
    console.log('V377_RESULT:' + JSON.stringify({
      oauth, bulk, identityCalls, priceCalls,
      priceItems: priceA.items.length + priceB.items.length,
      identityItems: identity.items.length,
      missingIds: missing.missingIds,
      status: mod.getEbayBulkGetItemsCapabilityStatus(),
    }));
  `;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: tmp,
    encoding: "utf8",
    env: { ...process.env, TERM: "dumb" },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  const line = output.split(/\r?\n/).find(value => value.startsWith("V377_RESULT:"));
  if (!line) throw new Error("V3.7.37 concurrent fallback fixture produced no result marker.");
  const result = JSON.parse(line.slice("V377_RESULT:".length));
  if (result.oauth !== 1 || result.bulk !== 1 || result.status?.state !== "denied") {
    throw new Error(`V3.7.37 probe regression: concurrent callers issued more than one restricted bulk probe (${JSON.stringify(result)}).`);
  }
  if (!(result.identityItems > 0) || result.identityCalls <= 0 ||
      result.priceItems > Number(result.status?.fallbackPriceWindowBudget || 0)) {
    throw new Error(`V3.7.37 fairness regression: price refresh consumed the protected identity reserve (${JSON.stringify(result)}).`);
  }
  if (!Array.isArray(result.missingIds) || !result.missingIds.includes("missing-id")) {
    throw new Error(`V3.7.37 missing-item regression: individual getItem 404 was not propagated (${JSON.stringify(result)}).`);
  }
  if (Number(result.status?.fallbackWindowUsed || 0) > Number(result.status?.fallbackWindowBudget || 0)) {
    throw new Error(`V3.7.37 fallback-cap regression: shared fallback usage exceeded its window budget (${JSON.stringify(result.status)}).`);
  }

  console.log("PASS: V3.7.37 fallback fairness, shared-cap enforcement, single bulk-capability probe, missing-item propagation, and hot-path responsiveness guards passed.");
}

// V3.7.38 adaptive exact-verification throughput guards.
{
  const providerSource = fs.readFileSync(path.join(root, "providers/ebay.js"), "utf8");
  const pressureSource = fs.readFileSync(path.join(root, "lib/ebayVerificationPressure.js"), "utf8");
  const priceSource = fs.readFileSync(path.join(root, "services/ebayPriceVerifier.js"), "utf8");
  const sanitizerSource = fs.readFileSync(path.join(root, "services/ebayCompetitorSanitizer.js"), "utf8");
  const scannerSource = fs.readFileSync(path.join(root, "services/ebayCompetitorScanner.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const dbSource = fs.readFileSync(path.join(root, "lib/db.js"), "utf8");
  const adminSource = fs.readFileSync(path.join(root, "public/js/admin.js"), "utf8");

  for (const required of [
    "setEbayGetItemFallbackIdentityBacklog",
    "fallbackAdaptiveMode",
    "fallbackIdentityBacklog",
    "recommendedGetItemFallbackWindowBudget",
    "Math.max(\n    getItemFallbackWindowBudget,\n    recommendedGetItemFallbackWindowBudget()",
  ]) {
    if (!providerSource.includes(required)) {
      throw new Error(`V3.7.38 adaptive fallback regression: missing provider behavior ${required}.`);
    }
  }

  if (!pressureSource.includes("EBAY_ADAPTIVE_VERIFY_CATCHUP_PENDING") ||
      !pressureSource.includes("EBAY_ADAPTIVE_VERIFY_CATCHUP_DISCOVERY_SCALE") ||
      !priceSource.includes("background price refresh suspended for adaptive identity catch-up") ||
      !sanitizerSource.includes("setEbayGetItemFallbackIdentityBacklog(before.pending)") ||
      !serverSource.includes("competitor discovery throttled for verification catch-up") ||
      !dbSource.includes("EBAY_COMPETITOR_PENDING_TARGET_PER_PRODUCT") ||
      !dbSource.includes("pendingCapSkipped") ||
      !scannerSource.includes("pendingCapSkipped") ||
      !adminSource.includes("Verification catch-up mode")) {
    throw new Error("V3.7.38 adaptive verification regression: catch-up scheduling, producer throttling, queue cap, or telemetry is missing.");
  }

  const probe = `
    process.env.EBAY_ADAPTIVE_VERIFICATION_ENABLED = 'true';
    const mod = await import('./lib/ebayVerificationPressure.js');
    const values = [0, 500, 1500, 3000].map(pending => mod.getEbayAdaptiveVerificationPolicy(pending));
    console.log('V378_RESULT:' + JSON.stringify(values));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TERM: "dumb" },
  });
  const line = output.split(/\r?\n/).find(value => value.startsWith("V378_RESULT:"));
  if (!line) throw new Error("V3.7.38 adaptive policy fixture produced no result marker.");
  const values = JSON.parse(line.slice("V378_RESULT:".length));
  const modes = values.map(value => value.mode);
  if (JSON.stringify(modes) !== JSON.stringify(["normal", "elevated", "high", "catchup"])) {
    throw new Error(`V3.7.38 adaptive thresholds regression: ${JSON.stringify(values)}`);
  }
  const catchup = values[3] || {};
  if (Number(catchup.fallbackBrowseShare || 0) < 0.99 ||
      Number(catchup.fallbackMaxCallsPerWindow || 0) < 30 ||
      Number(catchup.discoveryScale || 1) >= 0.5 ||
      catchup.suspendBackgroundPriceRefresh !== true) {
    throw new Error(`V3.7.38 catch-up policy regression: ${JSON.stringify(catchup)}`);
  }

  console.log("PASS: V3.7.38 adaptive fallback budgeting, discovery throttling, pending-queue cap, price-refresh suspension, and telemetry guards passed.");
}

// V3.7.39 evidence-weighted competitor coverage + live-search hydration guards.
{
  const sparseGtinProof = exactCompetitorProof(
    {
      title: "Sony WF1000XM5 Wireless Earbuds Black",
      brand: "Sony",
      gtin: "027242925816",
      mpn: "WF1000XM5/B",
    },
    {
      title: "Sony WF1000XM5 Wireless Earbuds",
      gtin: "027242925816",
      brand: "",
      mpn: "",
    }
  );
  if (!sparseGtinProof.ok || sparseGtinProof.proofType !== "gtin") {
    throw new Error(`V3.7.39 evidence-weighting regression: exact GTIN was rejected only because auxiliary seller metadata was omitted (${JSON.stringify(sparseGtinProof)}).`);
  }

  const brandMpnFallback = exactCompetitorProof(
    {
      title: "Sony WF1000XM5 Wireless Earbuds Black",
      brand: "Sony",
      gtin: "027242925816",
      mpn: "WF1000XM5/B",
    },
    {
      title: "Sony WF1000XM5 Wireless Earbuds",
      brand: "Sony",
      mpn: "WF1000XM5/B",
      gtin: "",
    }
  );
  if (!brandMpnFallback.ok || brandMpnFallback.proofType !== "brand-mpn") {
    throw new Error(`V3.7.39 proof-path regression: exact Brand+MPN could not prove a listing that omitted GTIN (${JSON.stringify(brandMpnFallback)}).`);
  }

  const explicitVariantConflict = exactCompetitorProof(
    {
      title: "Sony WF1000XM5 18V Wireless Earbuds",
      brand: "Sony",
      gtin: "027242925816",
      mpn: "WF1000XM5/B",
    },
    {
      title: "Sony WF1000XM5 40V Wireless Earbuds",
      gtin: "027242925816",
    }
  );
  if (explicitVariantConflict.ok || !explicitVariantConflict.reasons.some(reason => reason.includes("electrical"))) {
    throw new Error(`V3.7.39 safety regression: explicit variant contradiction was accepted (${JSON.stringify(explicitVariantConflict)}).`);
  }

  const explicitModelConflict = exactCompetitorProof(
    {
      title: "Sony WF1000XM5 Wireless Earbuds",
      brand: "Sony",
      gtin: "027242925816",
      mpn: "WF1000XM5/B",
    },
    {
      title: "Sony WH1000XM5 Wireless Headphones",
      gtin: "027242925816",
    }
  );
  if (explicitModelConflict.ok || !explicitModelConflict.reasons.includes("exact-model-conflict")) {
    throw new Error(`V3.7.39 safety regression: explicit model contradiction was accepted (${JSON.stringify(explicitModelConflict)}).`);
  }

  const omittedPowerPrefilter = __ebayCompetitorScannerTest.prefilterCompetitorCandidates(
    {
      id: 99339,
      title: "Fixture M100 100W Desktop Widget",
      brand: "Fixture",
      mpn: "M100",
      offers: [],
    },
    {
      listingTitle: "Fixture M100 100W Desktop Widget",
      brand: "Fixture",
      conditionGroup: "new",
    },
    [{
      provider: "ebay",
      externalId: "v1|v379-sparse-title|0",
      title: "Fixture M100 Desktop Widget",
      listingTitle: "Fixture M100 Desktop Widget",
      brand: "Fixture",
      conditionGroup: "new",
    }]
  );
  if (omittedPowerPrefilter.plausible.length !== 1) {
    throw new Error(`V3.7.39 recall regression: candidate omission was still treated as a power contradiction (${JSON.stringify(omittedPowerPrefilter.rejected)}).`);
  }

  const diverse = __ebayCompetitorScannerTest.selectExactProofCandidates([
    { externalId: "a1", merchant: "source-shop", competitorDiscoveryConfidence: 100, price: 10 },
    { externalId: "a2", merchant: "source-shop", competitorDiscoveryConfidence: 99, price: 11 },
    { externalId: "b1", merchant: "seller-b", competitorDiscoveryConfidence: 95, price: 12 },
    { externalId: "c1", merchant: "seller-c", competitorDiscoveryConfidence: 90, price: 13 },
  ], { limit: 2, sourceMerchant: "source-shop" });
  if (diverse.length !== 2 || new Set(diverse.map(item => item.merchant)).size !== 2 || diverse.some(item => item.merchant === "source-shop")) {
    throw new Error(`V3.7.39 seller-diversity regression: bounded exact verification did not prioritize distinct competitor sellers (${JSON.stringify(diverse)}).`);
  }

  const liveSearchSource = fs.readFileSync(path.join(root, "services/liveSearch.js"), "utf8");
  const priceSource = fs.readFileSync(path.join(root, "services/ebayPriceVerifier.js"), "utf8");
  const dbSource = fs.readFileSync(path.join(root, "lib/db.js"), "utf8");
  const workerSource = fs.readFileSync(path.join(root, "workers/catalogSearchWorker.js"), "utf8");
  const searchCoreSource = fs.readFileSync(path.join(root, "services/catalogSearchCore.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const storeSource = fs.readFileSync(path.join(root, "public/js/store.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

  if (!liveSearchSource.includes("hydrating fixed shopper-visible competitor page") ||
      !liveSearchSource.includes("scanEbayCompetitorsProgressivelyForProduct") ||
      !liveSearchSource.includes("LIVE_SEARCH_COMPETITOR_EXACT_CANDIDATES") ||
      !liveSearchSource.includes("preferredVisibleIds")) {
    throw new Error("V3.7.40 live-search coverage regression: the full visible shopper page no longer receives sequential competitor hydration.");
  }
  if (!priceSource.includes("adaptive catch-up reserved price slice for draft source verification") ||
      !dbSource.includes("getEbayDraftOffersForVerification") ||
      !dbSource.includes("!isEbaySecondarySource(offer)")) {
    throw new Error("V3.7.39 draft-throughput regression: catch-up mode can starve exact source verification again.");
  }
  if (!dbSource.includes("cachedVerifiedSellerCount") ||
      !searchCoreSource.includes('sort === "competitors"') ||
      !serverSource.includes('"competitors"') ||
      !indexSource.includes('value="competitors"') ||
      !storeSource.includes("verified seller")) {
    throw new Error("V3.7.39 storefront regression: verified-seller coverage sort/presentation is missing.");
  }

  console.log("PASS: V3.7.39 evidence-weighted exact proof, live-search competitor hydration, draft-source catch-up lane, seller diversity, and competitor sorting guards passed.");

  if (!liveSearchSource.includes("hydrating fixed shopper-visible competitor page") ||
      !liveSearchSource.includes("preferredVisibleIds") ||
      !liveSearchSource.includes("unattemptedVisibleAfterHydration") ||
      !liveSearchSource.includes('order: "fixed-browser-dom"') ||
      liveSearchSource.includes("LIVE_SEARCH_COMPETITOR_PRODUCTS || 3") ||
      liveSearchSource.includes(".slice(0, productCap)") ||
      liveSearchSource.includes("whole-page competitor hydration round started")) {
    throw new Error("V3.7.40 full-page hydration regression: fixed shopper-visible coverage or no-round stability semantics disappeared.");
  }
  if (!serverSource.includes("liveSearchActive") ||
      !serverSource.includes("liveSearchInflightKey") ||
      !serverSource.includes("pageSize")) {
    throw new Error("V3.7.40 request-state regression: catalog polling can no longer tell that page hydration is still in flight.");
  }
  if (!storeSource.includes("launchDetachedSearchWork") ||
      !serverSource.includes("detached shopper indexing job started") ||
      !serverSource.includes("res.status(202).json")) {
    throw new Error("V3.7.43 detached-indexing regression: full-page hydration is coupled to shopper HTTP completion again.");
  }

  console.log("PASS: V3.7.40 whole-page competitor hydration and page-stability semantics preserved under detached V3.7.43 request handling.");

  if (!serverSource.includes("pageCompetitorHydrationState") ||
      !serverSource.includes("needsHydration") ||
      !serverSource.includes("hydrationStaleUnderTarget") ||
      !serverSource.includes("LIVE_SEARCH_COMPETITOR_PAGE_FRESH_MINUTES")) {
    throw new Error("V3.7.41 database-page hydration regression: database-complete searches no longer expose stale competitor coverage as foreground work.");
  }
  if (!liveSearchSource.includes("function coverageState(product, now = Date.now())") ||
      !liveSearchSource.includes("LIVE_SEARCH_COMPETITOR_PAGE_FRESH_MINUTES") ||
      !liveSearchSource.includes("staleUnderTargetAfterHydration") ||
      !liveSearchSource.includes("const products = eligibleVisibleProducts.filter(product => coverageState(product).due)")) {
    throw new Error("V3.7.41 hydration freshness regression: recently researched products can be re-scanned on every query.");
  }
  if (!storeSource.includes("data.needsDiscovery || data.needsHydration || data.foregroundLiveSearchActive") ||
      !storeSource.includes("Database results are ready") ||
      !storeSource.includes("renderCatalogResponse(data)")) {
    throw new Error("V3.7.41 progressive-render regression: live page hydration can hide populated database results behind a blocking wait again.");
  }

  console.log("PASS: V3.7.41 database-backed page hydration, freshness gating, and progressive foreground rendering guards passed.");

  const scannerSourceV3742 = fs.readFileSync(path.join(root, "services/ebayCompetitorScanner.js"), "utf8");
  const commonSourceV3742 = fs.readFileSync(path.join(root, "public/js/common.js"), "utf8");
  const styleSourceV3742 = fs.readFileSync(path.join(root, "public/css/style.css"), "utf8");
  const packageV3742 = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  if (!scannerSourceV3742.includes("scanEbayCompetitorsProgressivelyForProduct") ||
      !scannerSourceV3742.includes("signalMethod: plannedMethod") ||
      !scannerSourceV3742.includes("maxExactCandidates: exactCandidateLimit") ||
      !scannerSourceV3742.includes("target-reached") ||
      !scannerSourceV3742.includes("signals-exhausted")) {
    throw new Error("V3.7.42 normalized-product recall regression: shopper hydration no longer widens exact competitor discovery signal-by-signal until target/exhaustion.");
  }
  if (!liveSearchSource.includes('order: "fixed-browser-dom"') ||
      !liveSearchSource.includes('publishLiveEvent("hydration"') ||
      !liveSearchSource.includes('for (let productIndex = 0; productIndex < products.length; productIndex++)') ||
      !liveSearchSource.includes('preferredVisibleIds.indexOf(productId)') ||
      liveSearchSource.includes('.sort((a, b) =>\n        Number(a.ebayCompetition?.sellerCount')) {
    throw new Error("V3.7.42 display-order regression: competitor hydration is no longer sequential in the shopper-visible normalized-product order.");
  }
  if (!serverSource.includes("competition.coverageCompleteAt") ||
      !serverSource.includes("visibleProductIds") ||
      !dbSource.includes("ebayCompetitorCoverageCompleteAt") ||
      !dbSource.includes("coverageTargetSellers")) {
    throw new Error("V3.7.42 completeness regression: old shallow scan timestamps can suppress the required normalized-product competitor pass again.");
  }
  if (!commonSourceV3742.includes('"hydration"') ||
      !storeSource.includes("competitorHydrationUi") ||
      !storeSource.includes("visibleProductIds: [...visibleProductIds()]") ||
      !storeSource.includes("data-market-sellers") ||
      !styleSourceV3742.includes(".product-card.competitor-inspecting") ||
      !styleSourceV3742.includes("offergrid-competitor-index-pulse")) {
    throw new Error("V3.7.42 storefront indexing regression: SSE progress, stable visible order, live seller counts, or blue active-card cursor is missing.");
  }
  const legacyStableGridCursor =
    storeSource.includes("competitorHydrationUi.active") &&
    storeSource.includes("Keep the visible card order stable") &&
    storeSource.includes("page-incomplete");
  const v3748FixedQueueDynamicResort =
    storeSource.includes("competitorHydrationUi.active") &&
    storeSource.includes("function applyLiveCompetitorSort()") &&
    storeSource.includes("fixed backend hydration queue") &&
    storeSource.includes("page-incomplete");
  const v3756OwnedPassDynamicResort =
    storeSource.includes("Only page-start may establish a pass") &&
    storeSource.includes("function applyLiveCompetitorSort()") &&
    !storeSource.includes("const passChanged =") &&
    liveSearchSource.includes('order: "fixed-browser-dom"') &&
    liveSearchSource.includes("for (let productIndex = 0; productIndex < products.length; productIndex++)");
  if (!legacyStableGridCursor && !v3748FixedQueueDynamicResort && !v3756OwnedPassDynamicResort) {
    throw new Error("V3.7.42/V3.7.48 cursor regression: visible resorting can alter or restart the authoritative sequential hydration queue.");
  }
  const sseConnectIndexV3742 = storeSource.indexOf("connectOfferGridLive({");
  const initialLoadIndexV3742 = storeSource.lastIndexOf("await Promise.all([");
  if (sseConnectIndexV3742 < 0 || initialLoadIndexV3742 < 0 || sseConnectIndexV3742 > initialLoadIndexV3742) {
    throw new Error("V3.7.42 live-cursor regression: SSE is connected after the initial searchable load, so the first hydration pass can run invisibly.");
  }
  if (packageV3742.version !== "3.7.61") {
    throw new Error(`V3.7.61 package metadata regression: expected 3.7.61, got ${packageV3742.version}.`);
  }

  console.log("PASS: V3.7.42 per-normalized-product progressive recall, shopper-order sequential indexing, blue live cursor, and anti-jump semantics preserved.");

  if (!serverSource.includes("detached shopper indexing job started") ||
      serverSource.includes("Promise.race([promise, timeout]") ||
      !serverSource.includes("res.status(202).json")) {
    throw new Error("V3.7.43 request-detachment regression: shopper HTTP responses can wait on eBay hydration again.");
  }
  if (!liveSearchSource.includes("database page already has capacity; skipping draft preflight before competitor indexing") ||
      !liveSearchSource.includes("maxExactCandidates: exactCandidateCap") ||
      !liveSearchSource.includes('publishHydration("product-incomplete"') ||
      !liveSearchSource.includes("await new Promise(resolve => setImmediate(resolve));")) {
    throw new Error("V3.7.43 throughput regression: database-complete pages can be delayed by draft preflight or one noisy competitor product again.");
  }
  if (!scannerSourceV3742.includes("exactCandidateLimit") ||
      !scannerSourceV3742.includes("bounded-candidates-pending") ||
      !scannerSourceV3742.includes("deferPersistence")) {
    throw new Error("V3.7.43 scanner regression: bounded exact bursts or deferred page-hydration persistence disappeared.");
  }
  if (!storeSource.includes("readJsonResponse") ||
      !storeSource.includes("NON_JSON_API_RESPONSE") ||
      !storeSource.includes("Keeping the current verified results on screen") ||
      storeSource.includes("recoverSearchCapacity(query, token)")) {
    throw new Error("V3.7.43 storefront resilience regression: HTML/5xx API responses can still erase a usable result grid or blocking recovery polling returned.");
  }

  if (!serverSource.includes("new Promise(resolve => setImmediate(resolve))") ||
      !serverSource.includes(".then(() => discoverForUserSearch({")) {
    throw new Error("V3.7.43 detachment regression: live-search work can execute synchronous pre-await setup before the HTTP 202 response again.");
  }
  if (scannerSourceV3742.includes("deferPersistence: false")) {
    throw new Error("V3.7.43 persistence regression: interactive competitor scanning contains a synchronous persistence override again.");
  }

console.log("PASS: V3.7.43 detached HTTP lane, immediate database-page indexing, bounded exact bursts, deferred persistence, cooperative yielding, and non-destructive API error handling guards passed.");

  const poolSourceV3744 = fs.readFileSync(path.join(root, "services/catalogSearchPool.js"), "utf8");
  const workerSourceV3744 = fs.readFileSync(path.join(root, "workers/catalogSearchWorker.js"), "utf8");
  const searchCoreSourceV3744 = fs.readFileSync(path.join(root, "services/catalogSearchCore.js"), "utf8");

  if (!storeSource.includes("const PAGE_SIZE = 40;") ||
      !(serverSource.includes("const SHOPPER_PAGE_SIZE = 40;") ||
        serverSource.includes("const SHOPPER_PAGE_SIZE = CATALOG_SHOPPER_PAGE_SIZE;")) ||
      !searchCoreSourceV3744.includes("CATALOG_SHOPPER_PAGE_SIZE = 40") ||
      !poolSourceV3744.includes("const SHOPPER_PAGE_SIZE = CATALOG_SHOPPER_PAGE_SIZE")) {
    throw new Error("V3.7.48 page-size regression: storefront, API, pool, and shared search core are no longer fixed to 40 visible cards.");
  }
  if (!dbSource.includes("function buildPageHydrationLookup") ||
      !dbSource.includes("scopeProductIds: wanted") ||
      !dbSource.includes("hydrate(data, product, { lookup })") ||
      !dbSource.includes("calculateEbayCompetition(data, product, lookup)") ||
      !dbSource.includes("calculateMarketComparison(data, product, lookup)")) {
    throw new Error("V3.7.44 hydration regression: shopper card construction can fall back to repeated whole-offer/click scans instead of page-scoped lookup buckets.");
  }
  const filterIndexV3744 = searchCoreSourceV3744.indexOf("for (const item of Array.isArray(records) ? records : [])");
  const sortIndexV3744 = searchCoreSourceV3744.indexOf("matches.sort((a, b) => compareRecords");
  const sliceIndexV3744 = searchCoreSourceV3744.indexOf("matches.slice(start, start + pageSize)");
  if (filterIndexV3744 < 0 || sortIndexV3744 < 0 || sliceIndexV3744 < 0 ||
      !(filterIndexV3744 < sortIndexV3744 && sortIndexV3744 < sliceIndexV3744)) {
    throw new Error("V3.7.44 sorting regression: pagination can occur before the complete query/category result set is sorted.");
  }
  const legacySharedWorkerSnapshot =
    poolSourceV3744.includes("cachedSnapshotRevision") &&
    poolSourceV3744.includes("snapshotShared: true") &&
    poolSourceV3744.includes("warmStaleWorkers") &&
    poolSourceV3744.includes("products: getPublicProductsByIds(meta.ids)");
  const v3747DoubleBufferedWorkerSnapshot =
    poolSourceV3744.includes("snapshotCacheRevision") &&
    poolSourceV3744.includes("buildReplacementWorker") &&
    poolSourceV3744.includes("background-swapped to catalog revision") &&
    (poolSourceV3744.includes("getPublicProductsByIds(meta.ids)") ||
     poolSourceV3744.includes("getPublicProductsByIds(meta.ids, { includeParts })"));
  if (!legacySharedWorkerSnapshot && !v3747DoubleBufferedWorkerSnapshot) {
    throw new Error("V3.7.44 worker regression: search workers can rebuild duplicate snapshots or hydrate outside the returned page slice again.");
  }
  if (!(storeSource.includes("refreshing the full search-result sort") ||
        storeSource.includes("Applying one final full-result sort")) ||
      !storeSource.includes("competitor-pass-complete-resort") ||
      !serverSource.includes('sortScope: q ? "full-search-result-set"')) {
    throw new Error("V3.7.44 post-index regression: competitor completion no longer forces a full matching-search re-sort before the new page slice is rendered.");
  }

  console.log("PASS: V3.7.44/V3.7.48 fixed 40-card pages, page-scoped relationship hydration, shared worker snapshots, full-search sorting before pagination, and post-competitor re-sort guards passed.");

  if (!serverSource.includes("supersedeShopperViewJobs") ||
      !serverSource.includes("demoteLiveSearchJob") ||
      !serverSource.includes("releaseShopperViewJobs") ||
      !serverSource.includes("jobControl: control") ||
      !serverSource.includes('app.post("/api/search/live/release"')) {
    throw new Error("V3.7.45 navigation-priority regression: shopper view changes no longer demote abandoned interactive indexing jobs.");
  }
  if (!liveSearchSource.includes("handOffSupersededWork") ||
      !liveSearchSource.includes("shouldStop: superseded") ||
      !liveSearchSource.includes('publishHydration("page-demoted"') ||
      !liveSearchSource.includes("enqueueEbayCompetitorBackgroundProducts")) {
    throw new Error("V3.7.45 handoff regression: superseded page work is not cooperatively stopped and transferred to background scheduling.");
  }
  if (!scannerSourceV3742.includes("backgroundPriorityProductIds") ||
      !scannerSourceV3742.includes("enqueueEbayCompetitorBackgroundProducts") ||
      !scannerSourceV3742.includes("shouldStop = null") ||
      !scannerSourceV3742.includes("superseded-to-background")) {
    throw new Error("V3.7.45 scanner regression: abandoned visible products can monopolize the interactive lane or lose their scheduled background handoff.");
  }
  if (!storeSource.includes("SHOPPER_VIEW_CLIENT_ID") ||
      !storeSource.includes('params.set("viewId"') ||
      !storeSource.includes("beginShopperView()") ||
      !storeSource.includes('window.addEventListener("pagehide", releaseActiveShopperView)') ||
      !storeSource.includes('"/api/search/live/release"')) {
    throw new Error("V3.7.45 storefront navigation regression: page changes are not announcing authoritative view ownership to the server.");
  }

  console.log("PASS: V3.7.45 shopper navigation hard-priority, cooperative foreground demotion, background competitor handoff, and page-release guards passed.");

  const verifierSourceV3746 = fs.readFileSync(path.join(root, "services/ebayPriceVerifier.js"), "utf8");

  if (!liveSearchSource.includes('workMode = "auto"') ||
      !liveSearchSource.includes('mode === "hydrate"') ||
      !liveSearchSource.includes('phase: "discovery-results-ready"') ||
      !liveSearchSource.includes('skippedReason: mode === "discover" ? "render-barrier"') ||
      !liveSearchSource.includes("LIVE_SEARCH_FIRST_PAINT_BUDGET_MS") ||
      !liveSearchSource.includes("LIVE_SEARCH_FIRST_PAINT_VERIFY_BURST") ||
      !liveSearchSource.includes("LIVE_SEARCH_FIRST_PAINT_INGEST_LIMIT") ||
      !liveSearchSource.includes('ingestCandidates(interactiveRelevant, { deferPersistence: true })') ||
      !liveSearchSource.includes('backgroundCheckpoint("live-search:first-paint-ingest"')) {
    throw new Error("V3.7.46 discovery regression: render-first separation, bounded first-paint source work, or cross-user cooperative yielding disappeared.");
  }

  const hydrationCallsV3746 = (liveSearchSource.match(/competitorCoverage = await hydrateInteractiveCompetitorCoverageForPage/g) || []).length;
  const hydrateModeIndexV3746 = liveSearchSource.indexOf('if (mode === "hydrate")');
  const firstPaintIndexV3746 = liveSearchSource.indexOf("const firstPaintStartedAt = Date.now()");
  const hydrationCallIndexV3746 = liveSearchSource.indexOf("competitorCoverage = await hydrateInteractiveCompetitorCoverageForPage");
  if (hydrationCallsV3746 !== 1 || hydrateModeIndexV3746 < 0 || firstPaintIndexV3746 < 0 ||
      hydrationCallIndexV3746 < hydrateModeIndexV3746 || hydrationCallIndexV3746 > firstPaintIndexV3746) {
    throw new Error("V3.7.46 render-barrier regression: first-paint discovery can invoke competitor page hydration before the browser renders results again.");
  }

  if (!serverSource.includes('workMode = "hydrate"') ||
      !serverSource.includes('workMode === "discover" ? "discover" : "hydrate"') ||
      !serverSource.includes('requestedWorkMode === "discover" || requestedWorkMode === "hydrate"') ||
      !serverSource.includes('visibleProductIds.length\n      ? "hydrate"\n      : "discover"') ||
      !serverSource.includes('First-paint marketplace discovery started in the live lane.')) {
    throw new Error("V3.7.46 routing regression: discovery and visible-card hydration no longer have distinct detached job identities.");
  }

  if (!storeSource.includes('phase === "discovery-results-ready"') ||
      !storeSource.includes("discoveryRenderBarrierPending") ||
      !storeSource.includes('fetchCatalogPage({ viewId: activeViewId, preferFresh: true })') ||
      !storeSource.includes('launchDetachedSearchWork(query, activeLoadToken, activeViewId, { workMode: "hydrate" })') ||
      !(storeSource.includes("refreshing the full search-result sort") ||
        storeSource.includes("Applying one final full-result sort")) ||
      !storeSource.includes("competitor-pass-complete-resort")) {
    throw new Error("V3.7.46 storefront regression: newly discovered cards may hydrate before render or final competitor sorting may fail to refresh the complete matching search set.");
  }

  if (!verifierSourceV3746.includes('deferPersistence = null') ||
      !verifierSourceV3746.includes('shouldDeferPersistence') ||
      !dbSource.includes("verificationReviewIndex") ||
      !dbSource.includes("lookup: verificationLookup") ||
      !dbSource.includes("reviewIndex: verificationReviewIndex") ||
      dbSource.includes("const postVerificationLookup = buildOfferLookupIndex(data);")) {
    throw new Error("V3.7.46 source-proof efficiency regression: exact verification can rebuild relationship indexes or lose deferred first-paint persistence again.");
  }

  if (!liveSearchSource.includes('skipRakuten: true') ||
      !liveSearchSource.includes('LIVE_SEARCH_FIRST_PAINT_MARKETPLACE_PAGE_SIZE || 30') ||
      !liveSearchSource.includes('LIVE_SEARCH_FIRST_PAINT_INGEST_LIMIT || 20') ||
      !liveSearchSource.includes('LIVE_SEARCH_FIRST_PAINT_VERIFY_LIMIT || 8') ||
      !liveSearchSource.includes('LIVE_SEARCH_FIRST_PAINT_VERIFY_BURST || 3') ||
      !liveSearchSource.includes('LIVE_SEARCH_FIRST_PAINT_BUDGET_MS || 6000') ||
      liveSearchSource.includes('reason: "interactive-first-paint-ingest"')) {
    throw new Error("V3.7.46 first-paint efficiency regression: additive Rakuten or oversized ingest/source-proof work can block first render again.");
  }

  if (!liveSearchSource.includes('function coverageState(product, now = Date.now())') ||
      !liveSearchSource.includes('unresearched: !researched') ||
      !liveSearchSource.includes('forceCoverageRefresh: true') ||
      !scannerSourceV3742.includes('forceCoverageRefresh = false') ||
      !scannerSourceV3742.includes('refreshProbePending')) {
    throw new Error("V3.7.46 selective-hydration regression: fresh researched cards can be re-scanned or stale/never-researched cards can be skipped.");
  }

  const visitorSourceV3746 = fs.readFileSync(path.join(root, "lib/visitorAnalytics.js"), "utf8");
  const adminSourceV3746 = fs.readFileSync(path.join(root, "public/js/admin.js"), "utf8");
  const privacySourceV3746 = fs.readFileSync(path.join(root, "public/privacy.html"), "utf8");
  if (!serverSource.includes('app.post("/api/presence"') ||
      !serverSource.includes('app.get("/api/admin/visitors"') ||
      !serverSource.includes('visitors: getVisitorAnalytics()') ||
      !visitorSourceV3746.includes('historicalVisitors') ||
      !visitorSourceV3746.includes('activeConnections') ||
      !visitorSourceV3746.includes('new-unique-visitor') ||
      !commonSourceV3742.includes('VISITOR_HEARTBEAT_MS = 5 * 60 * 1000') ||
      !adminSourceV3746.includes('VISITOR_ANALYTICS_REFRESH_MS = 5 * 60 * 1000') ||
      !adminSourceV3746.includes('currently-connected-users') ||
      !adminSourceV3746.includes('historically-unique-users') ||
      !privacySourceV3746.includes('Anonymous visitor counts')) {
    throw new Error("V3.7.46 visitor analytics regression: anonymous presence, five-minute Admin updates, historical uniqueness, or disclosure is missing.");
  }

  console.log("PASS: V3.7.46 render-first marketplace discovery, selective stale/unresearched hydration, bounded source-proof work, anonymous visitor telemetry, and post-competitor full-search re-sort guards passed.");

  // V3.7.47 progressive first paint + explicit condition-exception inventory.
  const { isBrokenOrPartsListing } = await import(pathToFileURL(path.join(root, "lib/listingCondition.js")));
  const { runCatalogSearch } = await import(pathToFileURL(path.join(root, "services/catalogSearchCore.js")));
  const productDetailSourceV3747 = fs.readFileSync(path.join(root, "public/js/product.js"), "utf8");
  const conditionSourceV3747 = fs.readFileSync(path.join(root, "lib/listingCondition.js"), "utf8");

  const excludedConditionFixtures = [
    "For parts or not working",
    "BROKEN - for repair only",
    "Does not power on",
    "Won't power on",
    "Non-working unit",
    "Defective item",
    "Microsoft HoloLens 2 - Not Tested",
    "Untested console unit",
    "NVIDIA GeForce RTX 5090 EMPTY BOX ONLY",
    "Nintendo Switch Console Retail Box Only Original Packaging",
    "Alienware laptop EMPTY BOX",
    "Original packaging only - no device",
  ];
  for (const title of excludedConditionFixtures) {
    if (!isBrokenOrPartsListing({ title })) {
      throw new Error(`V3.7.47 condition regression: explicit excluded listing was not classified (${title}).`);
    }
  }
  if (isBrokenOrPartsListing({ title: "Replacement parts kit for working aquarium filter" })) {
    throw new Error("V3.7.47 condition regression: ordinary replacement-parts wording was falsely classified as broken inventory.");
  }

  const conditionSearchFixture = [
    {
      id: 1, title: "Fixture Tablet", brand: "Fixture", category: "Electronics",
      searchText: "fixture tablet electronics", heat: 60, bestPrice: 299, bestScore: 80,
      verificationRank: 2, competitorSellerCount: 3, updatedAtMs: 20, conditionException: false,
    },
    {
      id: 2, title: "Fixture Tablet For Parts", brand: "Fixture", category: "Electronics",
      searchText: "fixture tablet for parts electronics", heat: 0, bestPrice: 79, bestScore: 0,
      verificationRank: 2, competitorSellerCount: 0, updatedAtMs: 30, conditionException: true,
    },
  ];
  const normalConditionSearch = runCatalogSearch(conditionSearchFixture, { q: "fixture tablet", sort: "competitors", page: 1 });
  const optInConditionSearch = runCatalogSearch(conditionSearchFixture, { q: "fixture tablet", sort: "competitors", page: 1, includeParts: true });
  if (normalConditionSearch.total !== 1 || normalConditionSearch.ids.includes(2)) {
    throw new Error("V3.7.47 condition regression: Parts/Broken inventory leaked into the default catalog search.");
  }
  if (optInConditionSearch.total !== 2 || !optInConditionSearch.ids.includes(2) || optInConditionSearch.ids[0] !== 1) {
    throw new Error("V3.7.47 condition regression: explicit Parts/Broken opt-in or competitor-sort isolation is incorrect.");
  }

  if (!conditionSourceV3747.includes("intelligenceEligibleListing") ||
      !dbSource.includes("hydrateConditionExceptionProduct") ||
      !dbSource.includes("bestConditionExceptionOfferFor") ||
      !dbSource.includes("conditionExcludedFromIntelligence: true") ||
      !searchCoreSource.includes("record.conditionException && !payload.includeParts") ||
      !poolSourceV3744.includes("getPublicProductsByIds(meta.ids, { includeParts })") ||
      !serverSource.includes("preferFresh,\n    includeParts")) {
    throw new Error("V3.7.47 condition-plumbing regression: condition exception state is not isolated end-to-end.");
  }
  const indexSourceV3747 = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  if (!indexSourceV3747.includes('id="include-parts-toggle"') ||
      !storeSource.includes('params.set("includeParts", "true")') ||
      !storeSource.includes('conditionException ? "&includeParts=true" : ""') ||
      !storeSource.includes('No Deal Heat, price history, or competitor ranking') ||
      !storeSource.includes('${conditionException ? "" : cardIntelligence(product)}') ||
      !productDetailSourceV3747.includes('productApiSuffix = includeParts ? "?includeParts=true" : ""') ||
      !productDetailSourceV3747.includes("INTELLIGENCE EXCLUDED") ||
      !productDetailSourceV3747.includes("renderConditionException")) {
    throw new Error("V3.7.47 condition UI regression: explicit opt-in state or condition-specific detail treatment is missing.");
  }

  if (!storeSource.includes("if (preserveDiscoveryState && !data.products.length) return;") ||
      !storeSource.includes("startDiscoveryFallbackPoll") ||
      !storeSource.includes('phase === "discovery-listings-arrived"') ||
      !liveSearchSource.includes('phase: "discovery-safe-results-progress"') ||
      !liveSearchSource.includes("reconcilePublicMatches(verification.touchedProductIds || [])") ||
      !liveSearchSource.includes("LIVE_SEARCH_FIRST_PAINT_BUDGET_MS || 6000")) {
    throw new Error("V3.7.47 progressive-first-paint regression: zero-result protection, recovery polling, or touched-ID safe-result growth is missing.");
  }

  if (!poolSourceV3744.includes("Do not await refresh") ||
      !poolSourceV3744.includes("buildReplacementWorker") ||
      !poolSourceV3744.includes("background-swapped to catalog revision") ||
      !poolSourceV3744.includes("fallbackLexicalCache = new Map()") ||
      !workerSource.includes("prepareCatalogSearchRecords") ||
      !serverSource.includes('scheduleCatalogSearchWarmup({ reason: "startup-http-ready" })')) {
    throw new Error("V3.7.47 worker regression: shopper search can pay worker-refresh/tokenization cost again.");
  }

  console.log("PASS: V3.7.47 progressive first paint, Parts/Broken opt-in isolation, condition-specific detail safety, and background worker-search guards passed.");

  // V3.7.48: one authoritative 40-card shopper page, per-card resort,
  // cache-key coherence, and valid eBay foreground/background pagination.
  const htmlEntrySourcesV3748 = [
    "index.html", "product.html", "trending.html", "admin.html",
    "privacy.html", "disclosure.html", "methodology.html", "terms.html", "404.html",
  ].map(name => fs.readFileSync(path.join(root, "public", name), "utf8"));
  const commonSourceV3748 = fs.readFileSync(path.join(root, "public/js/common.js"), "utf8");

  if (!liveSearchSource.includes("const LIVE_SEARCH_SHOPPER_PAGE_SIZE = CATALOG_SHOPPER_PAGE_SIZE") ||
      !liveSearchSource.includes("pageSize = LIVE_SEARCH_SHOPPER_PAGE_SIZE") ||
      !liveSearchSource.includes("targetCount = LIVE_SEARCH_SHOPPER_PAGE_SIZE") ||
      !liveSearchSource.includes("pageSize: LIVE_SEARCH_SHOPPER_PAGE_SIZE") ||
      !liveSearchSource.includes("slice(0, LIVE_SEARCH_SHOPPER_PAGE_SIZE)")) {
    throw new Error("V3.7.48 live-search page-size regression: visible hydration/discovery can fall back to a 20-card contract.");
  }

  if (!storeSource.includes("COMPETITOR_LIVE_SORT_INTERVAL_MS = 150") ||
      !storeSource.includes("function applyLiveCompetitorSort()") ||
      !storeSource.includes("competitorHydrationUi.currentProductId = null") ||
      !storeSource.includes("const PAGE_SIZE = 40;")) {
    throw new Error("V3.7.48/V3.7.54 live-resort regression: the fixed 40-card hydration pass can no longer rank verified competitor counts live.");
  }

  if (!liveSearchSource.includes("local.pageSize = Number(local.pageSize || marketplacePageSize)") ||
      !liveSearchSource.includes("local.pageSize || configuredBackgroundPageSize") ||
      !liveSearchSource.includes("Browse rejects offsets that are not a") ||
      !liveSearchSource.includes("marketplace.ebayError\n    ? requestOffset") ||
      !liveSearchSource.includes("background eBay continuation failed; additive providers returned no usable fallback candidates")) {
    throw new Error("V3.7.48 eBay continuation regression: foreground/background page-size changes can recreate invalid Browse offset/limit requests or hide fallback failure state.");
  }

  if (serverSource.includes('const APP_VERSION = "3.7.47-js"') ||
      commonSourceV3748.includes('CLIENT_BUILD_VERSION = "3.7.47-js"') ||
      storeSource.includes('./common.js?v=3.7.47') ||
      htmlEntrySourcesV3748.some(source => source.includes("v=3.7.47") || source.includes('BUILD = "3.7.47-js"'))) {
    throw new Error("V3.7.48 cache-coherence regression: stale 3.7.47 browser assets can coexist with the 40-card server contract.");
  }

  if (!dbSource.includes("repairConditionAwareSellerCountCachesInDb") ||
      !dbSource.includes("conditionAwareSellerCountCacheVersion") ||
      !dbSource.includes("if (!conditionSellerRepair.skipped)")) {
    throw new Error("V3.7.48 competitor-cache regression: legacy Parts/Broken seller counts can remain in competitor sorting or repeat the startup audit forever.");
  }

  console.log("PASS: V3.7.48 unified 40-card pagination, per-card competitor resort, valid/retry-safe eBay continuation pagination, additive-provider fallback visibility, condition-safe seller-cache repair, and browser/server cache coherence guards passed.");

  // V3.7.49: first-paint is not the final page-fill barrier. Underfilled new
  // searches stay in discovery until 40/exhaustion/defer, and competitor sort
  // is genuinely seller-count-primary inside the already-relevant result set.
  const competitorPrimaryFixture = [
    {
      id: 901, title: "Gaming Headset Wireless Pro", brand: "Fixture", category: "Electronics",
      searchText: "gaming headset wireless pro fixture electronics", heat: 80, bestPrice: 99, bestScore: 95,
      verificationRank: 2, competitorSellerCount: 1, updatedAtMs: 100, conditionException: false,
    },
    {
      id: 902, title: "Budget Gaming Audio Headset", brand: "Fixture", category: "Electronics",
      searchText: "budget gaming audio headset fixture electronics", heat: 55, bestPrice: 49, bestScore: 70,
      verificationRank: 2, competitorSellerCount: 8, updatedAtMs: 90, conditionException: false,
    },
  ];
  const competitorPrimaryResult = runCatalogSearch(competitorPrimaryFixture, {
    q: "gaming headset",
    sort: "competitors",
    page: 1,
    pageSize: 40,
  });
  if (competitorPrimaryResult.ids[0] !== 902) {
    throw new Error("V3.7.49 competitor-sort regression: verified seller count is no longer primary after relevance filtering.");
  }

  if (!liveSearchSource.includes("backgroundActive: backgroundDiscoveryContinuations.has(key)") ||
      !liveSearchSource.includes("LIVE_SEARCH_BACKGROUND_VERIFY_LIMIT || 8") ||
      !liveSearchSource.includes("user-search-background-continuation-postverify") ||
      !liveSearchSource.includes('reason: "partial-first-paint-page-fill"') ||
      !liveSearchSource.includes("first-paint-yielded-page-fill-continuing") ||
      !liveSearchSource.includes("background shopper page-fill session complete") ||
      !liveSearchSource.includes('phase: "discovery-results-ready"')) {
    throw new Error("V3.7.49 discovery-fill regression: background continuation can stop at drafts/one page or hydrate before the requested page-fill barrier.");
  }

  if (!serverSource.includes("const foregroundLiveSearchActive") ||
      !serverSource.includes("const backgroundDiscoveryActive = Boolean(discoveryState?.backgroundActive)") ||
      !storeSource.includes("if (data.backgroundDiscoveryActive)") ||
      !storeSource.includes("data.needsDiscovery && data.canDiscoverMore") ||
      !storeSource.includes('workMode: "discover"')) {
    throw new Error("V3.7.49 discovery-state regression: browser/server can mistake a quiet background fill interval for discovery completion or duplicate foreground work while shared continuation is active.");
  }

  if (!searchCoreSource.includes("verified comparable") ||
      !searchCoreSource.includes("competitorSellerCount") ||
      searchCoreSource.indexOf('if (sort === "competitors")') > searchCoreSource.indexOf('if (queryActive && a.relevance !== b.relevance)')) {
    throw new Error("V3.7.49 competitor-sort regression: query relevance can pin one-seller products above better verified competitor coverage.");
  }

  const commonSourceV3749 = fs.readFileSync(path.join(root, "public/js/common.js"), "utf8");
  if (!serverSource.includes('const APP_VERSION = "3.7.61-js"') ||
      !commonSourceV3749.includes('CLIENT_BUILD_VERSION = "3.7.61-js"') ||
      !storeSource.includes('./common.js?v=3.7.61') ||
      htmlEntrySourcesV3748.some(source => source.includes("v=3.7.48") || source.includes('BUILD = "3.7.48-js"'))) {
    throw new Error("V3.7.49 cache-coherence regression: stale 3.7.48 browser assets can preserve the underfilled-page discovery lifecycle.");
  }

  console.log("PASS: V3.7.49 40-card page-fill lifecycle, background exact source proof, discovery-state continuity, competitor-primary live resort, and cache-coherence guards passed.");

  // V3.7.50 invariant carried forward: active user-search competitor hydration
  // must remain visibly live between sparse product-complete events. V3.7.51
  // improves the implementation by ranking from in-flight seller counts locally
  // every 150ms instead of re-fetching a persisted snapshot that can lag behind.
  if (!storeSource.includes("COMPETITOR_LIVE_SORT_INTERVAL_MS = 150") ||
      !storeSource.includes("function startCompetitorLiveSortLoop()") ||
      !storeSource.includes("function stopCompetitorLiveSortLoop()") ||
      !storeSource.includes("applyLiveCompetitorSort();") ||
      !storeSource.includes("setLiveCompetitorSellerCount(") ||
      !storeSource.includes("if (String(sortSelect?.value || \"heat\") !== \"competitors\") return false;") ||
      !storeSource.includes("stopCompetitorLiveSortLoop();\n    competitorHydrationUi.active = false;") ||
      !storeSource.includes("includeParts: Boolean(event.includeParts)")) {
    throw new Error("V3.7.50 live-competitor-sort regression: active shopper hydration can stop visually re-ranking between sparse completion events.");
  }

  const commonSourceV3750 = fs.readFileSync(path.join(root, "public/js/common.js"), "utf8");
  if (!serverSource.includes('const APP_VERSION = "3.7.61-js"') ||
      !commonSourceV3750.includes('CLIENT_BUILD_VERSION = "3.7.61-js"') ||
      !storeSource.includes('./common.js?v=3.7.61') ||
      htmlEntrySourcesV3748.some(source => source.includes("v=3.7.50") || source.includes('BUILD = "3.7.50-js"'))) {
    throw new Error("V3.7.51 cache-coherence regression: a stale V3.7.50 browser module can preserve stale-snapshot live sorting or scroll anchoring.");
  }

  console.log("PASS: V3.7.50 150ms active-search competitor live-sort invariant, progress seller-count updates, fixed hydration queue, and cache-coherence guards passed.");

  // V3.7.51: live competitor sorting must use the newest in-flight verified
  // seller counts, preserve authoritative pass-completion refreshes, avoid live
  // scroll restoration, and expose structured shopper progress instead of
  // constantly replacing the stable results-summary sentence.
  const indexSourceV3751 = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  if (!storeSource.includes("const liveCompetitorSellerCounts = new Map()") ||
      !storeSource.includes("function applyLiveCompetitorSort()") ||
      !storeSource.includes("b.sellerCount - a.sellerCount") ||
      !storeSource.includes("authoritative: false,") ||
      !storeSource.includes("authoritative: true,") ||
      !storeSource.includes('"competitor-pass-complete-resort"') ||
      !storeSource.includes("applyLiveCompetitorCountsToCards();") ||
      storeSource.includes("captureScrollAnchor") ||
      storeSource.includes('restoreScrollAnchor(viewport, { retries: 1 })')) {
    throw new Error("V3.7.51 live-sort/scroll regression: in-flight seller counts can be overwritten by stale snapshots, pass-completion refresh disappeared, or live rerenders can auto-scroll again.");
  }

  if (!indexSourceV3751.includes('id="search-activity"') ||
      !indexSourceV3751.includes('id="search-activity-progress"') ||
      !indexSourceV3751.includes('id="search-activity-sellers"') ||
      !indexSourceV3751.includes('id="search-activity-sort"') ||
      !styleSource.includes("V3.7.51 INTENTIONAL LIVE SEARCH ACTIVITY + LIVE SORT") ||
      !styleSource.includes(".search-activity-metrics") ||
      !storeSource.includes("function updateSearchActivity(")) {
    throw new Error("V3.7.51 activity-UI regression: shopper search/competitor progress is no longer presented as a stable structured status panel.");
  }


  // V3.7.52: privacy-preserving rolling 30-day returning-visitor analytics.
  const visitorSourceV3752 = fs.readFileSync(path.join(root, "lib/visitorAnalytics.js"), "utf8");
  const adminHtmlV3752 = fs.readFileSync(path.join(root, "public/admin.html"), "utf8");
  const adminSourceV3752 = fs.readFileSync(path.join(root, "public/js/admin.js"), "utf8");
  const styleSourceV3752 = fs.readFileSync(path.join(root, "public/css/style.css"), "utf8");
  const privacySourceV3752 = fs.readFileSync(path.join(root, "public/privacy.html"), "utf8");
  const { summarizeVisitorRetention } = await import(pathToFileURL(path.join(root, "lib/visitorAnalytics.js")));
  const retentionNow = Date.UTC(2026, 8, 1, 12, 0, 0);
  const retentionFixture = summarizeVisitorRetention([
    { firstSeenAt: retentionNow - 2 * 86400000, lastSeenAt: retentionNow - 3600000, lastReturnAt: retentionNow - 3600000 },
    { firstSeenAt: retentionNow - 3 * 86400000, lastSeenAt: retentionNow - 2 * 86400000, lastReturnAt: 0 },
    { firstSeenAt: retentionNow - 90 * 86400000, lastSeenAt: retentionNow - 40 * 86400000, lastReturnAt: retentionNow - 40 * 86400000 },
  ], retentionNow);
  if (retentionFixture.returningVisitors30d !== 1 ||
      retentionFixture.uniqueVisitors30d !== 2 ||
      retentionFixture.firstTimeVisitors30d !== 2 ||
      retentionFixture.returnRate30d !== 50) {
    throw new Error(`V3.7.52 visitor-retention regression: rolling unique/return counts are incorrect (${JSON.stringify(retentionFixture)}).`);
  }
  if (!visitorSourceV3752.includes('VISITOR_ACTIVITY_PATH') ||
      !visitorSourceV3752.includes('RETURN_VISIT_GAP_MS') ||
      !visitorSourceV3752.includes('returning-visitor') ||
      !visitorSourceV3752.includes('returningVisitors30d') ||
      !adminHtmlV3752.includes('id="returning-visitors-30d"') ||
      !adminHtmlV3752.includes('id="visitor-return-rate-30d"') ||
      !adminSourceV3752.includes('event.type === "analytics" && event.visitors') ||
      !adminSourceV3752.includes('returnTrackingStartedAt') ||
      !styleSourceV3752.includes('V3.7.52 ADMIN 30-DAY VISITOR RETENTION') ||
      !privacySourceV3752.includes('coarse visit timestamps')) {
    throw new Error("V3.7.52 visitor-retention plumbing regression: timestamped anonymous return tracking, Admin live updates, UI, or privacy disclosure is missing.");
  }
  console.log("PASS: V3.7.52 rolling 30-day returning visitors, first-time/unique retention metrics, anonymous hash-only activity persistence, Admin live updates, and privacy disclosure guards passed.");

  console.log("PASS: V3.7.51 in-flight 150ms competitor ranking, authoritative pass-completion refresh, no live auto-scroll, intentional move animation, structured progress UI, and cache-coherence guards passed.");
  // V3.7.53: narrow queries that cannot produce 40 exact public products must
  // terminate their bounded background page-fill interaction. A max-length
  // chain may never exit with continueNeeded=true and invite the browser to
  // relaunch the same underfilled search forever. Repeated no-growth pages also
  // trip a conservative interaction circuit breaker.
  if (!liveSearchSource.includes("LIVE_SEARCH_BACKGROUND_NO_GROWTH_STEPS || 3") ||
      !liveSearchSource.includes('state.backgroundStopReason = "no-public-growth"') ||
      !liveSearchSource.includes('state.backgroundStopReason = "chain-step-cap"') ||
      !liveSearchSource.includes("if (stepsRun >= maxSteps && last?.continueNeeded)") ||
      !liveSearchSource.includes("background shopper page-fill stopped after repeated no-growth pages") ||
      !liveSearchSource.includes("background shopper page-fill reached its bounded chain cap") ||
      !liveSearchSource.includes('background-page-fill-no-growth-cap') ||
      !liveSearchSource.includes('background-page-fill-chain-cap')) {
    throw new Error("V3.7.53 narrow-query loop regression: background page-fill can relaunch forever after no growth or a max-length chain.");
  }

  console.log("PASS: V3.7.53 bounded narrow-query page-fill, no-growth circuit breaker, and max-chain discovery barrier guards passed.");

  // V3.7.54: sort changes are presentation-only and must never restart or
  // invalidate an active discovery/hydration job. During competitor hydration,
  // one local 150ms sorter owns visible ordering until one authoritative
  // pass-completion refresh reconciles the full query.
  const hydrationMatchStartV3754 = storeSource.indexOf("function hydrationViewMatches(event)");
  const hydrationMatchEndV3754 = storeSource.indexOf("function applyCompetitorHydrationUi", hydrationMatchStartV3754);
  const hydrationMatchSourceV3754 = storeSource.slice(hydrationMatchStartV3754, hydrationMatchEndV3754);
  const productCompleteStartV3754 = storeSource.indexOf('phase === "product-complete"');
  const productIncompleteStartV3754 = storeSource.indexOf('phase === "product-incomplete"', productCompleteStartV3754);
  const productCompleteSourceV3754 = storeSource.slice(productCompleteStartV3754, productIncompleteStartV3754);
  const inflightKeyStartV3754 = serverSource.indexOf("function liveSearchInflightKey(");
  const inflightKeyEndV3754 = serverSource.indexOf('app.get("/api/products"', inflightKeyStartV3754);
  const inflightKeySourceV3754 = serverSource.slice(inflightKeyStartV3754, inflightKeyEndV3754);

  if (!storeSource.includes("async function applySortOnly()") ||
      !storeSource.includes('sortSelect?.addEventListener("change", () => {\n  applySortOnly().catch(showError);') ||
      !storeSource.includes("Sort changes are presentation-only") ||
      !storeSource.includes("sortOnlyRefreshToken++") ||
      hydrationMatchSourceV3754.includes("event.sort") ||
      productCompleteSourceV3754.includes("scheduleCatalogLiveRefresh") ||
      !productCompleteSourceV3754.includes("applyLiveCompetitorSort();") ||
      storeSource.includes('reason: "competitor-product-complete-resort"') ||
      storeSource.includes('reason: "competitor-product-progress-resort"') ||
      !storeSource.includes('"competitor-pass-complete-resort"') ||
      !storeSource.includes("duration: 120")) {
    throw new Error("V3.7.54 live-sort authority regression: sort changes can restart scans, hydration events can be dropped after sort changes, or per-product server rerenders can fight the 150ms local sorter.");
  }

  if (!inflightKeySourceV3754.includes('String(sort || "heat")') ||
      !serverSource.includes("function shopperViewHasActiveLiveSearch(") ||
      !serverSource.includes("job.viewers?.get(client) !== view") ||
      !serverSource.includes("the dropdown sort is presentation-only for an already-owned") ||
      !serverSource.includes("shopperViewHasActiveLiveSearch({")) {
    throw new Error("V3.7.54 scan-identity regression: sort changes can hide the current shopper-view job or global dedupe can collide different-sort visible-ID queues.");
  }

  if (!serverSource.includes('const APP_VERSION = "3.7.61-js"') ||
      !commonSourceV3750.includes('CLIENT_BUILD_VERSION = "3.7.61-js"') ||
      !storeSource.includes('./common.js?v=3.7.61')) {
    throw new Error("V3.7.54 cache-coherence regression: stale browser assets can preserve sort-triggered rescans or dual-authority live ordering.");
  }

  console.log("PASS: V3.7.54 sort-only reranking, sort-independent scan identity, single 150ms live ordering authority, one pass-end reconciliation, and no-rescan guards passed.");

  // V3.7.55: a bounded incomplete competitor pass is terminal for the current
  // shopper interaction. Underfilled pages must not bounce from hydration back
  // into discovery and then re-arm the same foreground scanner. Unresolved
  // competitor coverage moves to the existing background lane instead.
  const hydrateModeStartV3755 = liveSearchSource.indexOf('if (mode === "hydrate")');
  const hydrateModeEndV3755 = liveSearchSource.indexOf('// Discovery lane:', hydrateModeStartV3755);
  const hydrateModeSourceV3755 = liveSearchSource.slice(hydrateModeStartV3755, hydrateModeEndV3755);
  const pageIncompleteStartV3755 = storeSource.indexOf('phase === "page-incomplete"');
  const pageIncompleteEndV3755 = storeSource.indexOf('phase === "page-demoted"', pageIncompleteStartV3755);
  const pageIncompleteSourceV3755 = storeSource.slice(pageIncompleteStartV3755, pageIncompleteEndV3755);

  if (!liveSearchSource.includes('reason: "foreground-hydration-terminal"') ||
      hydrateModeSourceV3755.includes('queueUserSearchBackgroundContinuation({') ||
      !liveSearchSource.includes('shopper-page-bounded-pass-incomplete') ||
      !liveSearchSource.includes('unresolvedBackgroundQueued') ||
      !storeSource.includes('let settledHydrationViewId = "";') ||
      !storeSource.includes('settledHydrationViewId = activeViewId;') ||
      !storeSource.includes('if (settledHydrationViewId === activeViewId)') ||
      !storeSource.includes('settledHydrationViewId !== expectedViewId') ||
      !storeSource.includes('settledHydrationViewId !== activeViewId') ||
      !(pageIncompleteSourceV3755.includes('title: "Competitor pass finished"') ||
        pageIncompleteSourceV3755.includes('"Competitor scan complete" : "Competitor pass finished"')) ||
      pageIncompleteSourceV3755.includes('title: "Competitor scan will continue"')) {
    throw new Error("V3.7.55 hydration-loop regression: an underfilled/incomplete page can immediately restart foreground discovery or competitor hydration for the same shopper interaction.");
  }

  if (!serverSource.includes('const APP_VERSION = "3.7.61-js"') ||
      !commonSourceV3750.includes('CLIENT_BUILD_VERSION = "3.7.61-js"') ||
      !storeSource.includes('./common.js?v=3.7.61')) {
    throw new Error("V3.7.55 cache-coherence regression: stale browser assets can preserve the underfilled-page hydration loop.");
  }

  console.log("PASS: V3.7.55 terminal bounded hydration, background unresolved coverage, settled-view restart suppression, and cache-coherence guards passed.");

  // V3.7.56: shopper progress is an owned state machine. Foreground discovery
  // and hydration events must be scoped to the interaction that launched them;
  // background discovery may refresh catalog data but cannot overwrite an
  // active competitor pass. Only page-start may establish a passId, progress
  // units stay stable, and the active shopper page contract is 40 everywhere.
  const envExampleV3756 = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const envLiveExampleV3756 = fs.readFileSync(path.join(root, ".env.live.example"), "utf8");
  const liveDeploymentV3756 = fs.readFileSync(path.join(root, "LIVE_DEPLOYMENT.md"), "utf8");
  const discoveryHandlerStartV3756 = storeSource.indexOf("function handleCompetitorHydrationEvent(event)");
  const discoveryHandlerEndV3756 = storeSource.indexOf("function scheduleCatalogLiveRefresh", discoveryHandlerStartV3756);
  const discoveryHandlerV3756 = storeSource.slice(discoveryHandlerStartV3756, discoveryHandlerEndV3756);

  if (!serverSource.includes("function liveSearchInteractionToken()") ||
      !serverSource.includes("interactionId: liveSearchInteractionToken()") ||
      !serverSource.includes('interactionId: String(job.interactionId || "")') ||
      !liveSearchSource.includes('interactionId = ""') ||
      !liveSearchSource.includes("interactionId: safeInteractionId") ||
      !storeSource.includes('let activeDiscoveryInteractionId = "";') ||
      !storeSource.includes('let activeHydrationInteractionId = "";') ||
      !storeSource.includes("function foregroundDiscoveryEventMatches(event)") ||
      !storeSource.includes("function hydrationInteractionMatches(event)") ||
      !storeSource.includes("if (discoveryPhase && event?.background)") ||
      !storeSource.includes("Shared/scheduled discovery is catalog growth, not lifecycle ownership")) {
    throw new Error("V3.7.56 event-ownership regression: shared/background discovery or another shopper interaction can overwrite the active progress state again.");
  }

  if (!discoveryHandlerV3756.includes("Only page-start may establish a pass") ||
      discoveryHandlerV3756.includes("const passChanged =") ||
      !discoveryHandlerV3756.includes('String(event.passId || "") !== competitorHydrationUi.passId') ||
      !liveSearchSource.includes("scanNumber: productIndex + 1") ||
      !liveSearchSource.includes("scanTotal: products.length") ||
      !storeSource.includes("function discoveryPageFill(event = {})") ||
      !storeSource.includes("progressTotal: PAGE_SIZE") ||
      !storeSource.includes("currentScanNumber") ||
      !storeSource.includes("scanTotal")) {
    throw new Error("V3.7.56 state-machine regression: stale passes can resurrect or discovery/hydration can reuse conflicting progress units.");
  }

  if (!isBrokenOrPartsListing({ title: "Microsoft HoloLens 2 - Not Tested" }) ||
      !isBrokenOrPartsListing({ title: "Untested handheld console" }) ||
      isBrokenOrPartsListing({ title: "Fully tested and working handheld console" }) ||
      !conditionSourceV3747.includes('reason: "not-tested"') ||
      !conditionSourceV3747.includes('reason: "box-only"') ||
      !conditionSourceV3747.includes('reason: "empty-box"') ||
      !dbSource.includes("const BEST_OFFER_CACHE_SCHEMA_VERSION = 2;") ||
      !dbSource.includes("const requiredVersion = 5;") ||
      !dbSource.includes("reconciling verified eBay seller caches with current trust and condition rules")) {
    throw new Error("V3.7.56 condition regression: Not Tested inventory can leak into normal intelligence or legacy seller caches can retain it.");
  }

  if (!envExampleV3756.includes("STORE_PAGE_SIZE=40") ||
      !envLiveExampleV3756.includes("STORE_PAGE_SIZE=40") ||
      !liveDeploymentV3756.includes("STORE_PAGE_SIZE=40") ||
      !fs.readFileSync(path.join(root, "README.md"), "utf8").includes("STORE_PAGE_SIZE=40") ||
      envExampleV3756.includes("STORE_PAGE_SIZE=20") ||
      envLiveExampleV3756.includes("STORE_PAGE_SIZE=20") ||
      !serverSource.includes("const SHOPPER_PAGE_SIZE = CATALOG_SHOPPER_PAGE_SIZE;") ||
      !searchCoreSource.includes("CATALOG_SHOPPER_PAGE_SIZE = 40")) {
    throw new Error("V3.7.56 page-contract regression: active configuration/documentation or runtime pagination can fall back to the legacy 20-card contract.");
  }

  if (!serverSource.includes('const APP_VERSION = "3.7.61-js"') ||
      !commonSourceV3750.includes('CLIENT_BUILD_VERSION = "3.7.61-js"') ||
      !storeSource.includes('./common.js?v=3.7.61') ||
      !fs.readFileSync(path.join(root, "public/js/product.js"), "utf8").includes('./common.js?v=3.7.61') ||
      !fs.readFileSync(path.join(root, "public/js/admin.js"), "utf8").includes('./common.js?v=3.7.61') ||
      !fs.readFileSync(path.join(root, "public/js/trending.js"), "utf8").includes('./common.js?v=3.7.61') ||
      packageV3742.version !== "3.7.61") {
    throw new Error("V3.7.56 cache-coherence regression: stale browser/server assets can preserve conflicting progress ownership or legacy condition behavior.");
  }

  console.log("PASS: V3.7.56 shopper-owned discovery/hydration state, monotonic pass ownership, stable progress units, 40-card configuration coherence, Not-Tested exclusion, and cache repair guards passed.");

  // V3.7.57: background page-fill remains shared catalog work, but the shopper
  // interaction that handed work off must receive a scoped completion barrier.
  // Shared background activity must never be treated as foreground progress or
  // cause the recovery poll to spawn a duplicate discovery job.
  if (!liveSearchSource.includes("const backgroundDiscoveryWaiters = new Map()") ||
      !liveSearchSource.includes("function registerBackgroundDiscoveryWaiter(") ||
      !liveSearchSource.includes("function publishBackgroundDiscoveryReadyToWaiters(") ||
      !liveSearchSource.includes("continuationHandoff: true") ||
      !liveSearchSource.includes("interactionId: safeInteractionId") ||
      !liveSearchSource.includes("registerBackgroundDiscoveryWaiter(key") ||
      !serverSource.includes("const foregroundLiveSearchActive") ||
      !serverSource.includes("foregroundLiveSearchActive,") ||
      !serverSource.includes("backgroundDiscoveryActive,") ||
      !storeSource.includes("const foregroundActive = data.foregroundLiveSearchActive") ||
      !storeSource.includes("if (data.backgroundDiscoveryActive)") ||
      !storeSource.includes("Verified exact matches are continuing in the background") ||
      !storeSource.includes("data.needsDiscovery || data.needsHydration || data.foregroundLiveSearchActive")) {
    throw new Error("V3.7.57 background-handoff regression: page fill can become visually stuck, background work can block the shopper barrier, or recovery can duplicate foreground discovery.");
  }

  if (!serverSource.includes('const APP_VERSION = "3.7.61-js"') ||
      !commonSourceV3750.includes('CLIENT_BUILD_VERSION = "3.7.61-js"') ||
      !storeSource.includes('./common.js?v=3.7.61') ||
      packageV3742.version !== "3.7.61") {
    throw new Error("V3.7.57 cache-coherence regression: browser/server generations can disagree about background discovery handoff semantics.");
  }

  console.log("PASS: V3.7.57 scoped background page-fill handoff, foreground/background activity separation, visible 40-card progress, duplicate-discovery suppression, and cache-coherence guards passed.");

  // V3.7.61: one ordinary product failure must never terminate the rest of the
  // visible-page competitor queue. Only a real protected eBay quota/provider
  // deferral or shopper supersession may halt the page. Seller and listing
  // counts also remain distinct so the grid cannot call nine verified listings
  // "two offers" merely because they came from two unique merchants.
  const { __liveSearchTest } = await import(pathToFileURL(path.join(root, "services/liveSearch.js")));
  const ordinaryFailurePolicyV3758 = __liveSearchTest.competitorPageFailurePolicy(new Error("fixture product failure"));
  const quotaFailurePolicyV3758 = __liveSearchTest.competitorPageFailurePolicy({
    code: "EBAY_RATE_REMOTE_EXHAUSTED",
    rateGuardDeferred: true,
  });
  if (!ordinaryFailurePolicyV3758.continuePage || ordinaryFailurePolicyV3758.haltPage ||
      quotaFailurePolicyV3758.continuePage || !quotaFailurePolicyV3758.haltPage) {
    throw new Error("V3.7.61 page-scan regression: ordinary product failures can halt the visible competitor queue or hard quota deferrals can be ignored.");
  }

  if (__ebayCompetitorScannerTest.verifiedSellerCount({ ebayCompetition: { sellerCount: 2, listingCount: 9 } }) !== 2 ||
      __ebayCompetitorScannerTest.verifiedListingCount({ ebayCompetition: { sellerCount: 2, listingCount: 9 } }) !== 9) {
    throw new Error("V3.7.61 competitor-count regression: unique sellers and verified listing counts are being conflated.");
  }

  const pageHydrationStartV3758 = liveSearchSource.indexOf("async function hydrateInteractiveCompetitorCoverageForPage(");
  const pageHydrationEndV3758 = liveSearchSource.indexOf("async function runUserSearchBackgroundContinuation", pageHydrationStartV3758);
  const pageHydrationSourceV3758 = liveSearchSource.slice(pageHydrationStartV3758, pageHydrationEndV3758);
  if (!pageHydrationSourceV3758.includes("competitorPageFailurePolicy(error)") ||
      !pageHydrationSourceV3758.includes("pageWillContinue: failurePolicy.continuePage") ||
      !pageHydrationSourceV3758.includes("if (failurePolicy.haltPage)") ||
      !pageHydrationSourceV3758.includes("await new Promise(resolve => setImmediate(resolve));\n      continue;") ||
      !pageHydrationSourceV3758.includes("attemptedAllSelected: attemptedIds.size >= products.length") ||
      !pageHydrationSourceV3758.includes("freshCoverageReused")) {
    throw new Error("V3.7.61 full-page competitor regression: the page can stop on one ordinary product, fail to prove all selected cards were attempted, or hide reused fresh coverage.");
  }

  if (!liveSearchSource.includes("listingCount: Number(result?.listingCountAfter ?? listingCountBefore)") ||
      !storeSource.includes("data-verified-listing-count") ||
      !storeSource.includes("verified eBay listing") ||
      storeSource.includes("${c.listingCount} verified eBay sellers") ||
      !storeSource.includes("listingCount: event.listingCount") ||
      !storeSource.includes("verified seller${count === 1 ? \"\" : \"s\"}${listings")) {
    throw new Error("V3.7.61 seller/listing UI regression: storefront verified counts can disagree semantically with product detail again.");
  }

  if (!dbSource.includes("const requiredVersion = 5;") ||
      !dbSource.includes("const ebayProductIds = new Set()") ||
      !dbSource.includes("const batchSize = 250;") ||
      !dbSource.includes("verifiedEbaySellerCountInDb(data, product, lookup)") ||
      dbSource.includes(".filter(product => Number(product.cachedVerifiedSellerCount || 0) > 0)")) {
    throw new Error("V3.7.61 seller-cache migration regression: zero-valued stale seller caches can remain excluded from coherence repair.");
  }

  if (!serverSource.includes('const APP_VERSION = "3.7.61-js"') ||
      !commonSourceV3750.includes('CLIENT_BUILD_VERSION = "3.7.61-js"') ||
      !storeSource.includes('./common.js?v=3.7.61') ||
      packageV3742.version !== "3.7.61") {
    throw new Error("V3.7.61 cache-coherence regression: browser/server generations can disagree about full-page competitor continuation or count semantics.");
  }

  console.log("PASS: V3.7.61 full visible-page competitor attempt policy, non-quota failure continuation, seller/listing count coherence, fresh-coverage transparency, and cache-coherence guards passed.");

}
