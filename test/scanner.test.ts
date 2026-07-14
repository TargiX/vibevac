import { describe, expect, it } from "vitest";

import type { WorkspaceReport } from "../src/domain/types.js";
import { excludeNestedWorkspaceSizes } from "../src/services/scanner.js";

function workspace(path: string, sizeBytes: number, cacheBytes: number): WorkspaceReport {
  return {
    tool: "projects",
    path,
    sourcePath: "/projects",
    dataSafety: "unknown",
    recommendation: "protect",
    reasons: [],
    sizeBytes,
    sizeError: null,
    git: null,
    inspectionError: null,
    activeProcessCount: 0,
    caches: [],
    cacheBytes,
    retainedSizeBytes: sizeBytes - cacheBytes,
    cacheCleanupAllowed: false,
    cacheCleanupReason: "fixture",
    cacheInspectionError: null,
  };
}

describe("workspace size accounting", () => {
  it("subtracts direct nested worktrees exactly once from their parent", () => {
    const result = excludeNestedWorkspaceSizes([
      workspace("/projects/app", 1_000, 100),
      workspace("/projects/app/.worktrees/agent", 400, 300),
      workspace("/projects/app/.worktrees/agent/nested", 100, 50),
    ]);

    expect(result.map(({ path, sizeBytes, retainedSizeBytes }) => ({
      path,
      sizeBytes,
      retainedSizeBytes,
    }))).toEqual([
      { path: "/projects/app", sizeBytes: 600, retainedSizeBytes: 500 },
      {
        path: "/projects/app/.worktrees/agent",
        sizeBytes: 300,
        retainedSizeBytes: 0,
      },
      {
        path: "/projects/app/.worktrees/agent/nested",
        sizeBytes: 100,
        retainedSizeBytes: 50,
      },
    ]);
  });
});
