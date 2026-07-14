import type {
  CacheCleanupResult,
  ScanReport,
  WorkspaceReport,
} from "../../src/domain/types.js";

export type ScanPhase = "initial" | "refreshing" | "stale" | "ready";

export interface ScanPresentation {
  phase: ScanPhase;
  reportCurrent: boolean;
  reportInteractive: boolean;
}

export function deriveScanPresentation(input: {
  loading: boolean;
  hasReport: boolean;
  refreshFailed: boolean;
}): ScanPresentation {
  if (input.loading && input.hasReport) {
    return { phase: "refreshing", reportCurrent: false, reportInteractive: false };
  }
  if (input.loading) {
    return { phase: "initial", reportCurrent: false, reportInteractive: false };
  }
  if (input.hasReport && input.refreshFailed) {
    return { phase: "stale", reportCurrent: false, reportInteractive: false };
  }
  if (input.hasReport) {
    return { phase: "ready", reportCurrent: true, reportInteractive: true };
  }
  return { phase: "initial", reportCurrent: false, reportInteractive: false };
}

function refreshReportTotals(report: ScanReport, workspaces: WorkspaceReport[]): ScanReport {
  return {
    ...report,
    workspaces,
    totalSizeBytes: workspaces.reduce(
      (total, workspace) => total + (workspace.sizeBytes ?? 0),
      0,
    ),
    totalCacheBytes: workspaces.reduce(
      (total, workspace) => total + workspace.cacheBytes,
      0,
    ),
    reclaimableCacheBytes: workspaces.reduce(
      (total, workspace) =>
        total + (workspace.cacheCleanupAllowed ? workspace.cacheBytes : 0),
      0,
    ),
    retainedSizeBytes: workspaces.reduce(
      (total, workspace) => total + (workspace.retainedSizeBytes ?? 0),
      0,
    ),
    candidateSizeBytes: workspaces.reduce(
      (total, workspace) =>
        total + (workspace.recommendation === "candidate" ? (workspace.sizeBytes ?? 0) : 0),
      0,
    ),
  };
}

export function applyCacheCleanupResults(
  report: ScanReport,
  results: CacheCleanupResult[],
  updatedAt = new Date().toISOString(),
): ScanReport {
  const resultsByWorkspace = new Map(
    results.map((result) => [result.workspacePath, result]),
  );
  const workspaces = report.workspaces.map((workspace) => {
    const result = resultsByWorkspace.get(workspace.path);
    if (!result) return workspace;

    const removedPaths = new Set(result.removed.map((removed) => removed.relativePath));
    const caches = workspace.caches.filter(
      (cache) => !removedPaths.has(cache.relativePath),
    );
    const cacheBytes = caches.reduce(
      (total, cache) => total + (cache.sizeBytes ?? 0),
      0,
    );
    const retainedFloor = workspace.retainedSizeBytes ?? 0;
    const sizeBytes =
      workspace.sizeBytes === null
        ? null
        : Math.max(retainedFloor, workspace.sizeBytes - result.reclaimedBytes);
    const cacheCleanupAllowed = workspace.cacheCleanupAllowed && caches.length > 0;

    return {
      ...workspace,
      caches,
      cacheBytes,
      sizeBytes,
      retainedSizeBytes: workspace.retainedSizeBytes,
      cacheCleanupAllowed,
      cacheCleanupReason: cacheCleanupAllowed
        ? workspace.cacheCleanupReason
        : "no verified rebuildable caches found",
    };
  });

  return refreshReportTotals({ ...report, generatedAt: updatedAt }, workspaces);
}
