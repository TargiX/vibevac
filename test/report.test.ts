import { describe, expect, it } from "vitest";

import {
  formatAge,
  formatBytes,
  renderHumanReport,
  renderWorkspaceInspection,
} from "../src/render/report.js";
import type { WorkspaceReport } from "../src/domain/types.js";

describe("report formatting", () => {
  it("formats binary disk sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
    expect(formatBytes(12 * 1_073_741_824)).toBe("12 GB");
  });

  it("formats age in days", () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z");
    expect(formatAge("2026-07-13T01:00:00.000Z", now)).toBe("today");
    expect(formatAge("2026-07-10T12:00:00.000Z", now)).toBe("3d");
  });

  it("does not claim zero usage when size calculation was skipped", () => {
    const output = renderHumanReport({
      generatedAt: "2026-07-13T12:00:00.000Z",
      roots: [],
      workspaces: [
        {
          tool: "custom",
          path: "/tmp/example",
          sourcePath: "/tmp",
          dataSafety: "unknown",
          recommendation: "protect",
          reasons: ["test fixture"],
          sizeBytes: null,
          sizeError: null,
          git: null,
          inspectionError: null,
          activeProcessCount: null,
          caches: [],
          cacheBytes: 0,
          retainedSizeBytes: null,
          cacheCleanupAllowed: false,
          cacheCleanupReason: "not scanned",
          cacheInspectionError: null,
        },
      ],
      totalSizeBytes: 0,
      totalCacheBytes: 0,
      reclaimableCacheBytes: 0,
      retainedSizeBytes: 0,
      candidateSizeBytes: 0,
      staleAfterDays: 14,
      processCheckAvailable: false,
      processCheckError: "lsof unavailable",
    });

    expect(output).toContain("size skipped");
    expect(output).not.toContain("· 0 B");
  });

  it("states the trust boundary in a detailed workspace inspection", () => {
    const workspace: WorkspaceReport = {
      tool: "custom",
      path: "/tmp/example",
      sourcePath: "/tmp",
      dataSafety: "recoverable",
      recommendation: "candidate",
      reasons: ["clean and stale"],
      sizeBytes: 1024,
      sizeError: null,
      inspectionError: null,
      activeProcessCount: 0,
      caches: [],
      cacheBytes: 0,
      retainedSizeBytes: 1024,
      cacheCleanupAllowed: false,
      cacheCleanupReason: "no verified rebuildable caches found",
      cacheInspectionError: null,
      git: {
        kind: "linked-worktree",
        branch: "feature",
        head: "abc123",
        upstream: "origin/feature",
        ahead: 0,
        behind: 0,
        dirtyEntries: 0,
        untrackedEntries: 0,
        remoteContainsHead: true,
        defaultBranch: "origin/main",
        mergedIntoDefault: true,
        lastCommitAt: "2026-06-01T00:00:00.000Z",
        lastActivityAt: "2026-06-01T00:00:00.000Z",
      },
    };

    const output = renderWorkspaceInspection(workspace, 14);

    expect(output).toContain("CANDIDATE means");
    expect(output).toContain("cannot know whether the project still matters");
    expect(output).toContain("will not delete or modify");
  });
});
