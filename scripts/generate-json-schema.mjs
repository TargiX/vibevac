// Regenerates docs/json-schema/ from src/domain/types.ts. CI fails when the
// committed schema differs, so run `pnpm schema` after changing a contract.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGenerator } from "ts-json-schema-generator";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "docs/json-schema");
const contracts = {
  ScanReport: "scan-report.json",
  CacheCleanupPlan: "cache-cleanup-plan.json",
  WorktreeRemovalPlan: "worktree-removal-plan.json",
  AuditRecord: "audit-record.json",
};

const generator = createGenerator({
  path: resolve(root, "src/domain/types.ts"),
  tsconfig: resolve(root, "tsconfig.json"),
  skipTypeCheck: true,
  additionalProperties: false,
  sortProps: true,
});

mkdirSync(outputDirectory, { recursive: true });
for (const [type, fileName] of Object.entries(contracts)) {
  const schema = generator.createSchema(type);
  writeFileSync(resolve(outputDirectory, fileName), `${JSON.stringify(schema, null, 2)}\n`);
}
