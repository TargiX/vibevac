import type {
  DiscoveryRoot,
  ScanReport,
  WorkspaceCandidate,
  WorkspaceReport,
} from "../domain/types.js";
import { isAbsolute, relative, sep } from "node:path";
import {
  countProcessesWithin,
  inspectActiveProcesses,
  type ActiveProcessSnapshot,
} from "./active-processes.js";
import { classifyWorkspace } from "./classifier.js";
import { inventoryRebuildableCaches } from "./cache-inventory.js";
import { discoverWorkspaces } from "./discovery.js";
import { diskUsageBytes } from "./disk-usage.js";
import { inspectGit } from "./git-inspector.js";

interface ScanOptions {
  includeSize?: boolean;
  concurrency?: number;
  staleAfterDays?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNestedWorkspace(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

export function excludeNestedWorkspaceSizes(
  workspaces: WorkspaceReport[],
): WorkspaceReport[] {
  const originalSizes = new Map(
    workspaces.map((workspace) => [workspace.path, workspace.sizeBytes] as const),
  );

  return workspaces.map((workspace) => {
    if (workspace.sizeBytes === null) return workspace;
    const descendants = workspaces.filter((candidate) =>
      isNestedWorkspace(workspace.path, candidate.path),
    );
    const directChildren = descendants.filter(
      (candidate) =>
        !descendants.some(
          (possibleParent) =>
            possibleParent.path !== candidate.path &&
            isNestedWorkspace(possibleParent.path, candidate.path),
        ),
    );
    const nestedBytes = directChildren.reduce(
      (total, child) => total + (originalSizes.get(child.path) ?? 0),
      0,
    );
    const sizeBytes = Math.max(0, workspace.sizeBytes - nestedBytes);
    return {
      ...workspace,
      sizeBytes,
      retainedSizeBytes: Math.max(0, sizeBytes - workspace.cacheBytes),
    };
  });
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await mapper(value);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

async function scanCandidate(
  candidate: WorkspaceCandidate,
  includeSize: boolean,
  processes: ActiveProcessSnapshot,
  staleAfterDays: number,
  now: number,
): Promise<WorkspaceReport> {
  const [gitResult, sizeResult, cacheResult] = await Promise.allSettled([
    inspectGit(candidate.path),
    includeSize ? diskUsageBytes(candidate.path) : Promise.resolve(null),
    includeSize ? inventoryRebuildableCaches(candidate.path) : Promise.resolve([]),
  ]);

  const git = gitResult.status === "fulfilled" ? gitResult.value : null;
  const activeProcessCount = countProcessesWithin(processes, candidate.path);
  const classification = classifyWorkspace(git, {
    activeProcessCount,
    staleAfterDays,
    now,
  });
  const caches = cacheResult.status === "fulfilled" ? cacheResult.value : [];
  const cacheBytes = caches.reduce(
    (total, cache) => total + (cache.sizeBytes ?? 0),
    0,
  );
  const sizeBytes = sizeResult.status === "fulfilled" ? sizeResult.value : null;
  const cacheCleanupReason =
    !includeSize
      ? "cache inventory skipped"
      : cacheResult.status === "rejected"
        ? "cache inventory failed"
        : caches.length === 0
          ? "no verified rebuildable caches found"
          : activeProcessCount === null
            ? "active-process check is unavailable"
            : activeProcessCount > 0
              ? "a running process is using this workspace"
              : git === null
                ? "Git inspection failed"
                : null;

  return {
    ...candidate,
    ...classification,
    sizeBytes,
    sizeError: sizeResult.status === "rejected" ? errorMessage(sizeResult.reason) : null,
    git,
    inspectionError:
      gitResult.status === "rejected" ? errorMessage(gitResult.reason) : null,
    activeProcessCount,
    caches,
    cacheBytes,
    retainedSizeBytes: sizeBytes === null ? null : Math.max(0, sizeBytes - cacheBytes),
    cacheCleanupAllowed: cacheCleanupReason === null,
    cacheCleanupReason,
    cacheInspectionError:
      cacheResult.status === "rejected" ? errorMessage(cacheResult.reason) : null,
  };
}

export async function scanWorkspaces(
  roots: DiscoveryRoot[],
  options: ScanOptions = {},
): Promise<ScanReport> {
  const now = Date.now();
  const staleAfterDays = options.staleAfterDays ?? 14;
  const [candidates, processes] = await Promise.all([
    discoverWorkspaces(roots),
    inspectActiveProcesses(),
  ]);
  const scannedWorkspaces = await mapConcurrent(
    candidates,
    options.concurrency ?? 4,
    (candidate) =>
      scanCandidate(
        candidate,
        options.includeSize ?? true,
        processes,
        staleAfterDays,
        now,
      ),
  );
  const workspaces = excludeNestedWorkspaceSizes(scannedWorkspaces);

  const recommendationPriority = {
    candidate: 0,
    protect: 1,
    review: 2,
    keep: 3,
  } as const;
  workspaces.sort((left, right) => {
    const recommendationDifference =
      recommendationPriority[left.recommendation] -
      recommendationPriority[right.recommendation];
    return recommendationDifference !== 0
      ? recommendationDifference
      : (right.sizeBytes ?? -1) - (left.sizeBytes ?? -1);
  });

  return {
    generatedAt: new Date().toISOString(),
    roots,
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
    staleAfterDays,
    processCheckAvailable: processes.available,
    processCheckError: processes.error,
  };
}
