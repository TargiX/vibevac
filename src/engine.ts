import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import type { ContractHeader } from "./domain/types.js";

// Read at runtime so the version cannot drift from package.json. This module
// sits at the top of src/ so the path is the same from src/ under tsx and from
// the bundled dist/cli.js in the published package.
export const { version: ENGINE_VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export const CONTRACT_HEADER: ContractHeader = {
  schemaVersion: 2,
  engine: "node",
  engineVersion: ENGINE_VERSION,
};

export const AUDIT_HEADER = {
  version: 2,
  engine: "node",
  engineVersion: ENGINE_VERSION,
} as const;

function shortHash(identity: unknown): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
}

// Both engines hash the same JSON: keys in this order, paths sorted bytewise.
export function cachePlanId(workspacePath: string, relativePaths: string[]): string {
  const sorted = [...relativePaths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return shortHash({ workspacePath, relativePaths: sorted });
}

export function worktreePlanId(workspacePath: string, head: string): string {
  return shortHash({ workspacePath, head });
}
