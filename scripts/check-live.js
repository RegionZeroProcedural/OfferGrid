import fs from "fs";
import path from "path";

function loadDotEnv() {
  const filename = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(filename)) return;

  const text = fs.readFileSync(filename, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const index = line.indexOf("=");
    if (index < 1) continue;

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Existing process environment wins, matching dotenv's default behavior.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const checks = [];
function add(name, ok, detail) {
  checks.push({ name, ok, detail });
}

const site = String(process.env.SITE_BASE_URL || "");
const host = String(process.env.HOST || "");
const adminPassword = String(process.env.ADMIN_PASSWORD || "");
const sessionSecret = String(process.env.SESSION_SECRET || "");
const vaultKey = String(process.env.CONFIG_ENCRYPTION_KEY || "");
const cookieSecure = String(process.env.COOKIE_SECURE || "").toLowerCase() === "true";
const nodeEnv = String(process.env.NODE_ENV || "");
const strictProduction = String(process.env.STRICT_PRODUCTION || "").toLowerCase() === "true";
const forceHttps = String(process.env.FORCE_HTTPS || "").toLowerCase() === "true";
const canonicalHost = String(process.env.CANONICAL_HOST || "").trim();
const enforceCanonical = String(process.env.ENFORCE_CANONICAL_HOST || "").toLowerCase() === "true";
const campaignMode = String(process.env.CAMPAIGN_TRAFFIC_MODE || "").toLowerCase() === "true";
const cloudflareAccess = String(process.env.CLOUDFLARE_ACCESS_REQUIRED || "").toLowerCase() === "true";
const ebayEnvironment = String(process.env.EBAY_ENVIRONMENT || "").toLowerCase();
const ebayAffiliateCampaignId = String(process.env.EBAY_AFFILIATE_CAMPAIGN_ID || "").trim();

add("NODE_ENV=production", nodeEnv === "production", nodeEnv || "(not set)");
add("HTTPS site URL", site.startsWith("https://"), site || "(not set)");
add("Loopback bind", ["127.0.0.1", "localhost", "::1"].includes(host), host || "(not set)");
add("Secure admin cookie", cookieSecure, String(cookieSecure));
add("Strict production guard", strictProduction, String(strictProduction));
add("HTTPS redirect", forceHttps, String(forceHttps));
add("Canonical host enforcement", enforceCanonical && Boolean(canonicalHost), canonicalHost || "(not set)");
add("Paid-traffic protection", campaignMode, String(campaignMode));
add("Cloudflare Access for Admin", cloudflareAccess, String(cloudflareAccess));
add("eBay production environment", ebayEnvironment === "production", ebayEnvironment || "(not set)");
add("eBay affiliate campaign ID", Boolean(ebayAffiliateCampaignId), ebayAffiliateCampaignId ? "configured" : "(not set)");
add(
  "Admin password changed",
  adminPassword.length >= 12 &&
    !["change-this-password", "CHANGE_ME_BEFORE_LIVE"].includes(adminPassword) &&
    !adminPassword.includes("CHANGE_ME"),
  adminPassword ? `${adminPassword.length} characters` : "(not set)"
);
add(
  "Strong session secret",
  sessionSecret.length >= 32 &&
    sessionSecret !== "dev-secret" &&
    !sessionSecret.includes("replace-this") &&
    !sessionSecret.includes("CHANGE_ME"),
  sessionSecret ? `${sessionSecret.length} characters` : "(not set)"
);
add(
  "Dedicated vault key",
  vaultKey.length >= 32 && !vaultKey.includes("CHANGE_ME"),
  vaultKey ? `${vaultKey.length} characters` : "(not set)"
);

const autoDiscovery = String(process.env.AUTO_SYNC_ENABLED || "true").toLowerCase() === "true";
const competitorScan = String(process.env.EBAY_COMPETITOR_SCAN_ENABLED || "true").toLowerCase() === "true";
console.log(
  `INFO  Autonomous discovery — ${autoDiscovery ? "enabled" : "disabled"}; ` +
  `eBay competitor scan — ${competitorScan ? "enabled" : "disabled"}`
);

console.log("\nOfferGrid live deployment check\n");
for (const item of checks) {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name} — ${item.detail}`);
}
console.log("");

if (checks.some(item => !item.ok)) process.exitCode = 1;


const competitorCleanup =
  String(process.env.EBAY_COMPETITOR_CLEANUP_ENABLED || "true").toLowerCase() === "true";
const competitorCleanupHours =
  Math.max(Number(process.env.EBAY_COMPETITOR_CLEANUP_HOURS || 24), 24);
console.log(
  `INFO  Competitor cleanup — ${competitorCleanup ? "enabled" : "disabled"}; ` +
  `interval ${competitorCleanupHours} hours`
);


const ebayPriceVerify =
  String(process.env.EBAY_PRICE_VERIFY_ENABLED || "true").toLowerCase() === "true";
const ebayPriceVerifyMinutes =
  Math.max(Number(process.env.EBAY_PRICE_VERIFY_MINUTES || 60), 30);

console.log(
  `INFO  Exact eBay price verifier — ${ebayPriceVerify ? "enabled" : "disabled"}; ` +
  `interval ${ebayPriceVerifyMinutes} minutes`
);

const integrityEnabled =
  String(process.env.CATALOG_INTEGRITY_ENABLED || "true").toLowerCase() === "true";

console.log(
  `INFO  Catalog integrity audit — ${integrityEnabled ? "enabled" : "disabled"}`
);
