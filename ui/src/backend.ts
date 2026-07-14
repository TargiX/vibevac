import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  CacheCleanupPlan,
  CacheCleanupResult,
  ScanReport,
  WorktreeRemovalPlan,
  WorktreeRemovalResult,
} from "../../src/domain/types";

export interface CleanupRequest {
  workspacePath: string;
  relativePaths: string[];
}

interface ExecuteCleanupRequest extends CleanupRequest {
  confirmation: string;
}

export interface WorktreeRemovalRequest {
  workspacePath: string;
  minimumInactiveDays: number;
  confirmation?: string;
}

const nativeApp = isTauri();

function browserToken(): string {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="vibevac-token"]')?.content ?? ""
  );
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with status ${response.status}`);
  }
  return payload;
}

export function usesNativeBackend(): boolean {
  return nativeApp;
}

export async function scanWorkspaces(
  staleAfterDays: number,
  customRoots: string[] = [],
): Promise<ScanReport> {
  if (nativeApp) {
    return invoke<ScanReport>("scan_workspaces", { staleAfterDays, customRoots });
  }

  const query = new URLSearchParams({ staleAfter: String(staleAfterDays) });
  for (const root of customRoots) query.append("root", root);
  return requestJson<ScanReport>(`/api/scan?${query.toString()}`);
}

export async function chooseWorkspaceSource(): Promise<string | null> {
  if (!nativeApp) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Add a workspace source",
  });
  return typeof selected === "string" ? selected : null;
}

export async function previewCacheCleanup(
  request: CleanupRequest,
): Promise<CacheCleanupPlan> {
  if (nativeApp) {
    return invoke<CacheCleanupPlan>("preview_cache_cleanup", { request });
  }

  return requestJson<CacheCleanupPlan>("/api/cache/preview", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VibeVac-Token": browserToken(),
    },
    body: JSON.stringify(request),
  });
}

export async function previewBatchCacheCleanup(
  requests: CleanupRequest[],
): Promise<CacheCleanupPlan[]> {
  if (nativeApp) {
    return invoke<CacheCleanupPlan[]>("preview_cache_cleanup_batch", { requests });
  }

  return Promise.all(requests.map((request) => previewCacheCleanup(request)));
}

export async function cleanCaches(
  request: ExecuteCleanupRequest,
): Promise<CacheCleanupResult> {
  if (nativeApp) {
    return invoke<CacheCleanupResult>("execute_cache_cleanup", { request });
  }

  return requestJson<CacheCleanupResult>("/api/cache/clean", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VibeVac-Token": browserToken(),
    },
    body: JSON.stringify(request),
  });
}

export async function previewWorktreeRemovals(
  requests: WorktreeRemovalRequest[],
): Promise<WorktreeRemovalPlan[]> {
  if (nativeApp) {
    return invoke<WorktreeRemovalPlan[]>("preview_worktree_removal_batch", { requests });
  }

  return Promise.all(
    requests.map((request) =>
      requestJson<WorktreeRemovalPlan>("/api/worktree/preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VibeVac-Token": browserToken(),
        },
        body: JSON.stringify(request),
      }),
    ),
  );
}

export async function removeWorktree(
  request: WorktreeRemovalRequest,
): Promise<WorktreeRemovalResult> {
  if (nativeApp) {
    return invoke<WorktreeRemovalResult>("remove_worktree", { request });
  }

  return requestJson<WorktreeRemovalResult>("/api/worktree/remove", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VibeVac-Token": browserToken(),
    },
    body: JSON.stringify(request),
  });
}
