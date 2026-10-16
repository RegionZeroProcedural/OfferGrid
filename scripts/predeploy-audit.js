import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbidden = [
  ".env",
  "data/private-config.json",
  "data/private-config.json.tmp",
  "data/visitor_activity.ndjson",
  "data/visitor_activity.ndjson.tmp",
  "data/unique_visitors.ndjson",
  "data/marketing_events.ndjson",
  "data/commission_events.ndjson",
  "data/outbound_clicks.ndjson",
  "data/ebay-api-metrics.json",
  "data/ebay-api-usage.json",
];
const forbiddenPatterns = [
  /^logs(?:\/|$)/,
  /^node_modules(?:\/|$)/,
  /^data\/\.rakuten-catalog-tmp(?:\/|$)/,
  /^data\/catalog\.json\.tmp$/,
  /^data\/.*(?:audit|cleanup|lifecycle).*\.(?:json|jsonl|ndjson)$/,
  /^data\/catalog\.pre-.*\.json$/,
];

function walk(directory, prefix = "") {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) found.push(`${relative} (symlink)`);
    else if (entry.isDirectory()) found.push(...walk(path.join(directory, entry.name), relative));
    else found.push(relative);
  }
  return found;
}

const files = walk(root);
const failures = [];
for (const target of forbidden) if (files.includes(target)) failures.push(`private runtime file included: ${target}`);
for (const file of files) {
  if (forbiddenPatterns.some(pattern => pattern.test(file))) failures.push(`runtime/dependency artifact included: ${file}`);
}
for (const required of ["data/catalog.json", ".env.example", ".env.live.example", "SECURE_DEPLOYMENT.md", "public/downloads/commission_import_template.csv"]) {
  if (!files.includes(required)) failures.push(`required deployment file missing: ${required}`);
}

const catalogDescriptor = fs.openSync(path.join(root, "data/catalog.json"), "r");
const catalogPrefixBuffer = Buffer.alloc(64 * 1024);
const catalogPrefixBytes = fs.readSync(catalogDescriptor, catalogPrefixBuffer, 0, catalogPrefixBuffer.length, 0);
fs.closeSync(catalogDescriptor);
const catalogPrefix = catalogPrefixBuffer.subarray(0, catalogPrefixBytes).toString("utf8");
if (!catalogPrefix.includes('"releaseSanitized":true')) {
  failures.push("catalog is not marked as stripped of historical traffic and visitor search rules");
}

const textFiles = files.filter(file => /\.(?:js|json|html|css|md|example|csv|bat)$/i.test(file) && file !== "data/catalog.json");
const exposedPublisherToken = ["f6653a29", "ab6f223c", "d20768ec", "855c2bef"].join("");
for (const file of textFiles) {
  const value = fs.readFileSync(path.join(root, file), "utf8");
  if (value.includes(exposedPublisherToken)) failures.push(`legacy publisher identifier remains in ${file}`);
  if (/^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m.test(value)) failures.push(`private key material found in ${file}`);
}

console.log("\nOfferGrid sanitized deployment audit\n");
if (failures.length) {
  for (const failure of [...new Set(failures)]) console.error(`FAIL  ${failure}`);
  process.exitCode = 1;
} else {
  console.log("PASS  No credentials, encrypted vault, visitor telemetry, commission data, runtime logs, temporary catalogs, dependencies, symlinks, or known publisher identifier are bundled.");
  console.log("PASS  Campaign tracking, commission template, live profile, catalog, and deployment guide are present.");
}
