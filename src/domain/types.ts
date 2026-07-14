export type WorkspaceTool =
  | "codex"
  | "conductor"
  | "cursor"
  | "claude"
  | "hermes"
  | "antigravity"
  | "openclaw"
  | "projects"
  | "custom";

export type WorkspaceKind = "linked-worktree" | "standalone-repository";

export type DataSafety = "recoverable" | "local-only" | "unknown";

export type Recommendation = "candidate" | "keep" | "review" | "protect";

export type CacheKind =
  | "dependencies"
  | "framework-build"
  | "build-output"
  | "test-output"
  | "tool-cache";

export interface CacheEntry {
  id: string;
  path: string;
  relativePath: string;
  name: string;
  kind: CacheKind;
  sizeBytes: number | null;
  sizeError: string | null;
  ignoredByGit: true;
  rebuildHint: string;
}

export interface DiscoveryRoot {
  tool: WorkspaceTool;
  path: string;
  maxDepth: number;
}

export interface WorkspaceCandidate {
  tool: WorkspaceTool;
  path: string;
  sourcePath: string;
}

export interface GitInspection {
  kind: WorkspaceKind;
  branch: string | null;
  head: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirtyEntries: number;
  untrackedEntries: number;
  remoteContainsHead: boolean;
  defaultBranch: string | null;
  mergedIntoDefault: boolean | null;
  lastCommitAt: string | null;
  lastActivityAt: string | null;
}

export interface Classification {
  dataSafety: DataSafety;
  recommendation: Recommendation;
  reasons: string[];
}

export interface WorkspaceReport extends WorkspaceCandidate, Classification {
  sizeBytes: number | null;
  sizeError: string | null;
  git: GitInspection | null;
  inspectionError: string | null;
  activeProcessCount: number | null;
  caches: CacheEntry[];
  cacheBytes: number;
  retainedSizeBytes: number | null;
  cacheCleanupAllowed: boolean;
  cacheCleanupReason: string | null;
  cacheInspectionError: string | null;
}

export interface ScanReport {
  generatedAt: string;
  roots: DiscoveryRoot[];
  workspaces: WorkspaceReport[];
  totalSizeBytes: number;
  totalCacheBytes: number;
  reclaimableCacheBytes: number;
  retainedSizeBytes: number;
  candidateSizeBytes: number;
  staleAfterDays: number;
  processCheckAvailable: boolean;
  processCheckError: string | null;
}

export interface CacheCleanupPlan {
  workspacePath: string;
  caches: CacheEntry[];
  reclaimBytes: number;
  confirmation: string;
}

export interface CacheCleanupResult {
  workspacePath: string;
  removed: Array<{
    relativePath: string;
    sizeBytes: number | null;
  }>;
  reclaimedBytes: number;
  completedAt: string;
  auditPath: string;
}

export interface WorktreeRemovalPlan {
  workspacePath: string;
  sizeBytes: number;
  branch: string;
  head: string;
  upstream: string;
  defaultBranch: string;
  lastActivityAt: string;
  inactiveDays: number;
  commonGitDirectory: string;
  reconstructionCommand: string;
  confirmation: string;
}

export interface WorktreeRemovalResult {
  workspacePath: string;
  reclaimedBytes: number;
  preservedBranch: string;
  reconstructionCommand: string;
  completedAt: string;
  auditPath: string;
}
