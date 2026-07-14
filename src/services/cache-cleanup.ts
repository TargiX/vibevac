import { appendFile, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";

import type {
  CacheCleanupPlan,
  CacheCleanupResult,
  CacheEntry,
} from "../domain/types.js";
import {
  countProcessesWithin,
  inspectActiveProcesses,
  type ActiveProcessSnapshot,
} from "./active-processes.js";
import { inventoryRebuildableCaches } from "./cache-inventory.js";
import { inspectGit } from "./git-inspector.js";

interface CleanupOptions {
  processSnapshot?: ActiveProcessSnapshot;
  auditPath?: string;
}

function confirmationFor(workspacePath: string): string {
  const segments = workspacePath.split(sep).filter(Boolean);
  const context = segments.slice(-2).join("/");
  return `CLEAN ${context}`;
}

async function validateCacheTarget(
  workspacePath: string,
  cache: CacheEntry,
): Promise<void> {
  const [workspaceRealPath, cacheRealPath, cacheStat] = await Promise.all([
    realpath(workspacePath),
    realpath(cache.path),
    lstat(cache.path),
  ]);

  if (
    cacheStat.isSymbolicLink() ||
    !cacheStat.isDirectory() ||
    !cacheRealPath.startsWith(`${workspaceRealPath}${sep}`)
  ) {
    throw new Error(`Unsafe cache target: ${cache.relativePath}`);
  }
}

export async function planCacheCleanup(
  workspacePath: string,
  relativePaths: string[],
  options: CleanupOptions = {},
): Promise<CacheCleanupPlan> {
  const resolvedWorkspacePath = resolve(workspacePath);
  const selectedPaths = [...new Set(relativePaths)];
  if (selectedPaths.length === 0) {
    throw new Error("Select at least one cache directory");
  }

  await inspectGit(resolvedWorkspacePath);
  const processSnapshot = options.processSnapshot ?? (await inspectActiveProcesses());
  const activeProcessCount = countProcessesWithin(processSnapshot, resolvedWorkspacePath);
  if (activeProcessCount === null) {
    throw new Error("Active-process check is unavailable");
  }
  if (activeProcessCount > 0) {
    throw new Error(
      `Cleanup blocked: ${activeProcessCount} running process${activeProcessCount === 1 ? " is" : "es are"} using this workspace`,
    );
  }

  const inventory = await inventoryRebuildableCaches(resolvedWorkspacePath);
  const inventoryByPath = new Map(
    inventory.map((cache) => [cache.relativePath, cache]),
  );
  const caches = selectedPaths.map((relativePath) => {
    const cache = inventoryByPath.get(relativePath);
    if (!cache) {
      throw new Error(
        `Cleanup refused: ${relativePath} is not in the verified rebuildable cache inventory`,
      );
    }
    return cache;
  });

  await Promise.all(
    caches.map((cache) => validateCacheTarget(resolvedWorkspacePath, cache)),
  );

  return {
    workspacePath: resolvedWorkspacePath,
    caches,
    reclaimBytes: caches.reduce(
      (total, cache) => total + (cache.sizeBytes ?? 0),
      0,
    ),
    confirmation: confirmationFor(resolvedWorkspacePath),
  };
}

export async function executeCacheCleanup(
  workspacePath: string,
  relativePaths: string[],
  options: CleanupOptions = {},
): Promise<CacheCleanupResult> {
  const plan = await planCacheCleanup(workspacePath, relativePaths, options);
  const removed: CacheCleanupResult["removed"] = [];
  const completedAt = new Date().toISOString();
  const auditPath = options.auditPath ?? resolve(homedir(), ".vibevac/audit.jsonl");
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, "", "utf8");

  try {
    for (const cache of plan.caches) {
      await validateCacheTarget(plan.workspacePath, cache);
      await rm(cache.path, { recursive: true, force: false });
      removed.push({
        relativePath: cache.relativePath,
        sizeBytes: cache.sizeBytes,
      });
    }
  } catch (error) {
    await appendFile(
      auditPath,
      `${JSON.stringify({
        version: 1,
        action: "cache-cleanup-partial",
        completedAt: new Date().toISOString(),
        workspacePath: plan.workspacePath,
        removed,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
      "utf8",
    );
    throw error;
  }

  await appendFile(
    auditPath,
    `${JSON.stringify({
      version: 1,
      action: "cache-cleanup",
      completedAt,
      workspacePath: plan.workspacePath,
      removed,
      reclaimedBytes: plan.reclaimBytes,
    })}\n`,
    "utf8",
  );

  return {
    workspacePath: plan.workspacePath,
    removed,
    reclaimedBytes: plan.reclaimBytes,
    completedAt,
    auditPath,
  };
}
