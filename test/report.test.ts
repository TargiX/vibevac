import { describe, expect, it } from "vitest";

import {
  formatAge,
  formatBytes,
  renderHumanReport,
  renderScanSummary,
  renderWorkspaceInspection,
} from "../src/render/report.js";
import type { CacheEntry, ScanReport, WorkspaceReport } from "../src/domain/types.js";

const GB = 1024 ** 3;

function cache(relativePath: string, name: string, sizeBytes: number): CacheEntry {
  return {
    id: relativePath,
    path: `/work/${relativePath}`,
    relativePath,
    name,
    kind: "dependencies",
    sizeBytes,
    sizeError: null,
    ignoredByGit: true,
    rebuildHint: "rebuild",
  };
}

function workspace(path: string, caches: CacheEntry[], cleanupAllowed = true): WorkspaceReport {
  const cacheBytes = caches.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0);
  return {
    tool: "projects",
    path,
    sourcePath: "/work",
    dataSafety: "recoverable",
    recommendation: "keep",
    reasons: ["fixture"],
    sizeBytes: cacheBytes + GB,
    sizeError: null,
    git: null,
    inspectionError: null,
    activeProcessCount: cleanupAllowed ? 0 : 1,
    caches,
    cacheBytes,
    retainedSizeBytes: GB,
    cacheCleanupAllowed: cleanupAllowed,
    cacheCleanupReason: cleanupAllowed ? null : "a running process is using this workspace",
    cacheInspectionError: null,
  };
}

function scanReport(workspaces: WorkspaceReport[], processCheckAvailable = true): ScanReport {
  const sum = (pick: (item: WorkspaceReport) => number) =>
    workspaces.reduce((total, item) => total + pick(item), 0);
  return {
    generatedAt: "2026-07-13T12:00:00.000Z",
    roots: [],
    workspaces,
    totalSizeBytes: sum((item) => item.sizeBytes ?? 0),
    totalCacheBytes: sum((item) => item.cacheBytes),
    reclaimableCacheBytes: sum((item) => (item.cacheCleanupAllowed ? item.cacheBytes : 0)),
    retainedSizeBytes: sum((item) => item.retainedSizeBytes ?? 0),
    candidateSizeBytes: 0,
    staleAfterDays: 14,
    processCheckAvailable,
    processCheckError: processCheckAvailable ? null : "lsof unavailable",
  };
}

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

  it("summarizes reviewable storage by type and largest workspace", () => {
    const output = renderScanSummary(
      scanReport([
        workspace("/work/app", [
          cache("node_modules", "Installed dependencies", 3 * GB),
          cache(".next", "Next.js build cache", GB),
        ]),
        workspace("/work/engine", [cache("target", "Rust build output", 2 * GB)]),
        workspace("/work/busy", [cache("node_modules", "Installed dependencies", 5 * GB)], false),
      ]),
    );

    expect(output).toContain("read-only scan");
    expect(output).toContain("6.0 GB");
    expect(output).toContain("in 2 of 3 workspaces");
    expect(output).toMatch(/Installed dependencies\s+3\.0 GB/);
    expect(output).toMatch(/Rust build output\s+2\.0 GB/);
    expect(output.indexOf("app")).toBeLessThan(output.indexOf("engine"));
    expect(output).toContain("5.0 GB more in 1 workspace is held back");
    expect(output).toContain("vibevac clean /work/app --all");
  });

  it("explains why nothing is ready when the process check is unavailable", () => {
    const output = renderScanSummary(
      scanReport([workspace("/work/app", [cache("node_modules", "Installed dependencies", GB)], false)], false),
    );

    expect(output).toContain("Nothing is ready to clean right now.");
    expect(output).toContain("active-process check is unavailable");
  });

  it("suggests a root when no workspaces were found", () => {
    expect(renderScanSummary(scanReport([]))).toContain("vibevac --root");
  });
});
