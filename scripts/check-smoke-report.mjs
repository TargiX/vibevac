// Validates a scan report from the smoke fixture (scripts/create-smoke-fixture.sh)
// against docs/json-schema/scan-report.json and checks that the engine found
// the fixture's one repository and its node_modules cache.
// Usage: node scripts/check-smoke-report.mjs <report.json> <node|native>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const [reportPath, expectedEngine] = process.argv.slice(2);
if (!reportPath || !expectedEngine) {
  console.error("usage: check-smoke-report.mjs <report.json> <node|native>");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(resolve(root, "docs/json-schema/scan-report.json"), "utf8"));
const report = JSON.parse(readFileSync(reportPath, "utf8"));

const validate = new Ajv({ allErrors: true }).compile(schema);
const failures = validate(report)
  ? []
  : validate.errors.map((error) => `schema: ${error.instancePath || "/"} ${error.message}`);

if (report.engine !== expectedEngine) failures.push(`engine is ${report.engine}, expected ${expectedEngine}`);
const workspace = report.workspaces?.find((candidate) => candidate.path?.endsWith("/smoke-app"));
if (!workspace) failures.push("the smoke-app repository was not reported");
else if (!workspace.caches.some((cache) => cache.relativePath === "node_modules")) {
  failures.push("the ignored node_modules cache was not reported");
}

if (failures.length > 0) {
  console.error(`Smoke report ${reportPath} failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`Smoke report valid: ${report.engine} ${report.engineVersion}, ${report.workspaces.length} workspace(s)`);
