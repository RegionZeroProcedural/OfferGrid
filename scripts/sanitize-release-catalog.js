import fs from "node:fs";
import path from "node:path";

const catalogPath = path.resolve(process.cwd(), "data/catalog.json");
const temporaryPath = path.resolve(process.cwd(), "data/catalog.release-sanitize.tmp");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));

const clicksRemoved = Array.isArray(catalog.clicks) ? catalog.clicks.length : 0;
catalog.clicks = [];
catalog.meta ||= {};
catalog.meta.nextClickId = 1;
delete catalog.meta.analyticsClickResetAt;
delete catalog.meta.analyticsClickResetClickId;
delete catalog.meta.analyticsClickBaselineLifetime;
delete catalog.meta.analyticsClickBaselineByProduct;

const rules = Array.isArray(catalog.discoveryRules) ? catalog.discoveryRules : [];
const retainedRules = rules.filter(rule => !String(rule?.name || "").startsWith("User search ·"));
const userSearchRulesRemoved = rules.length - retainedRules.length;
catalog.discoveryRules = retainedRules;
catalog.meta.releaseSanitized = true;
catalog.meta.releaseSanitization = {
  clicksRemoved,
  userSearchRulesRemoved,
  note: "Historical traffic and visitor-generated search rules removed from deployment artifact.",
};

fs.writeFileSync(temporaryPath, JSON.stringify(catalog), { encoding: "utf8", mode: 0o600 });
fs.renameSync(temporaryPath, catalogPath);
console.log(`PASS: release catalog sanitized (${clicksRemoved} click rows and ${userSearchRulesRemoved} visitor search rules removed).`);
