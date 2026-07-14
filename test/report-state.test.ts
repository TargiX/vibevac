import { describe, expect, it } from "vitest";

import type {
  CacheCleanupResult,
  CacheEntry,
  ScanReport,
  WorkspaceReport,
} from "../src/domain/types.js";
import {
  applyCacheCleanupResults,
  deriveScanPresentation,
} from "../ui/src/report-state.js";

function cache(relativePath: string, sizeBytes: number): CacheEntry {
  return {
    id: relativePath,
    path: `/workspace/${relativePath}`,
    relativePath,
    name: relativePath,
    kind: "dependencies",
    sizeBytes,
    sizeError: null,
    ignoredByGit: true,
    rebuildHint: "Rebuild it",
  };
}

function workspace(
  path: string,
  caches: CacheEntry[],
  options: { recommendation?: WorkspaceReport["recommendation"]; retainedBytes: number },
): WorkspaceReport {
  const cacheBytes = caches.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0);
  return {
    tool: "projects",
    path,
    sourcePath: "/workspace",
    dataSafety: "recoverable",
    recommendation: options.recommendation ?? "keep",
    reasons: ["safe"],
    sizeBytes: options.retainedBytes + cacheBytes,
    sizeError: null,
    git: null,
    inspectionError: null,
    activeProcessCount: 0,
    caches,
    cacheBytes,
    retainedSizeBytes: options.retainedBytes,
    cacheCleanupAllowed: caches.length > 0,
    cacheCleanupReason: caches.length > 0 ? null : "no verified rebuildable caches found",
    cacheInspectionError: null,
  };
}

function report(workspaces: WorkspaceReport[]): ScanReport {
  return {
    generatedAt: "2026-07-14T00:00:00.000Z",
    roots: [{ tool: "projects", path: "/workspace", maxDepth: 4 }],
    workspaces,
    totalSizeBytes: workspaces.reduce((total, item) => total + (item.sizeBytes ?? 0), 0),
    totalCacheBytes: workspaces.reduce((total, item) => total + item.cacheBytes, 0),
    reclaimableCacheBytes: workspaces.reduce(
      (total, item) => total + (item.cacheCleanupAllowed ? item.cacheBytes : 0),
      0,
    ),
    retainedSizeBytes: workspaces.reduce(
      (total, item) => total + (item.retainedSizeBytes ?? 0),
      0,
    ),
    candidateSizeBytes: workspaces.reduce(
      (total, item) => total + (item.recommendation === "candidate" ? (item.sizeBytes ?? 0) : 0),
      0,
    ),
    staleAfterDays: 14,
    processCheckAvailable: true,
    processCheckError: null,
  };
}

describe("post-cleanup report state", () => {
  it("updates every dashboard total immediately from successful cleanup results", () => {
    const cleaned = workspace(
      "/workspace/cleaned",
      [cache("node_modules", 1_000), cache(".nuxt", 200)],
      { recommendation: "candidate", retainedBytes: 300 },
    );
    const untouched = workspace("/workspace/untouched", [cache("dist", 100)], {
      retainedBytes: 400,
    });
    const cleanup: CacheCleanupResult = {
      workspacePath: cleaned.path,
      removed: [
        { relativePath: "node_modules", sizeBytes: 1_000 },
        { relativePath: ".nuxt", sizeBytes: 200 },
      ],
      reclaimedBytes: 1_200,
      completedAt: "2026-07-14T00:01:00.000Z",
      auditPath: "/audit.jsonl",
    };

    const updated = applyCacheCleanupResults(
      report([cleaned, untouched]),
      [cleanup],
      "2026-07-14T00:01:00.000Z",
    );

    expect(updated.generatedAt).toBe("2026-07-14T00:01:00.000Z");
    expect(updated.totalSizeBytes).toBe(800);
    expect(updated.totalCacheBytes).toBe(100);
    expect(updated.reclaimableCacheBytes).toBe(100);
    expect(updated.retainedSizeBytes).toBe(700);
    expect(updated.candidateSizeBytes).toBe(300);
    expect(updated.workspaces[0]).toMatchObject({
      sizeBytes: 300,
      cacheBytes: 0,
      retainedSizeBytes: 300,
      caches: [],
      cacheCleanupAllowed: false,
      cacheCleanupReason: "no verified rebuildable caches found",
    });
  });
});

describe("scan presentation", () => {
  it("makes an existing report visibly stale and non-interactive during refresh", () => {
    expect(
      deriveScanPresentation({ loading: true, hasReport: true, refreshFailed: false }),
    ).toEqual({ phase: "refreshing", reportCurrent: false, reportInteractive: false });
  });

  it("keeps a failed refresh non-interactive until a successful scan replaces it", () => {
    expect(
      deriveScanPresentation({ loading: false, hasReport: true, refreshFailed: true }),
    ).toEqual({ phase: "stale", reportCurrent: false, reportInteractive: false });
  });

  it("allows interaction only with a current completed report", () => {
    expect(
      deriveScanPresentation({ loading: false, hasReport: true, refreshFailed: false }),
    ).toEqual({ phase: "ready", reportCurrent: true, reportInteractive: true });
  });
});
