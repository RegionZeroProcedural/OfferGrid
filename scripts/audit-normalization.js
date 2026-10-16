import { initDb, getDataIntegrityStats } from "../lib/db.js";

initDb();
const stats = getDataIntegrityStats();

const rows = [
  ["Duplicate external offers", stats.duplicateExternalOffers],
  ["Duplicate strong canonical groups", stats.duplicateCanonicalProducts],
  ["Invalid strong canonical owners", stats.invalidCanonicalProducts],
  ["Invalid stored GTINs", stats.invalidStoredGtins],
  ["Invalid stored MPNs", stats.invalidStoredMpns],
  ["Invalid stored ePIDs", stats.invalidStoredEpids],
  ["Placeholder brands", stats.placeholderBrands],
  ["Rejected unsafe affiliate URLs", stats.rejectedAffiliateUrls],
  ["Public eBay offers", stats.publicEbayOffers],
  ["Untrusted public eBay offers", stats.untrustedPublicEbayOffers],
  ["Public products with weak identity", stats.weakIdentityPublicProducts],
  ["Unverified public eBay offers", stats.unverifiedPublicEbayOffers],
  ["Stale verified public eBay offers", stats.staleVerifiedPublicEbayOffers],
];

console.log("OfferGrid normalization audit (read-only)");
console.log(`Catalog integrity version: ${stats.integrityVersion || 0}`);
for (const [label, value] of rows) {
  console.log(`${label}: ${Number(value || 0).toLocaleString()}`);
}

const structuralProblems =
  Number(stats.duplicateExternalOffers || 0) +
  Number(stats.duplicateCanonicalProducts || 0) +
  Number(stats.invalidCanonicalProducts || 0) +
  Number(stats.invalidStoredGtins || 0) +
  Number(stats.invalidStoredMpns || 0) +
  Number(stats.invalidStoredEpids || 0) +
  Number(stats.placeholderBrands || 0);

if (structuralProblems > 0) {
  console.log("\nStructural normalization work remains. V3.7.32 local/integrity maintenance can address these classes without treating the cleanup as marketplace verification.");
  process.exit(process.argv.includes("--strict") ? 2 : 0);
}

console.log("\nNo tracked structural normalization violations were found by the V3.7.32 audit.");
process.exit(0);
