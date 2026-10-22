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

export type RemoteVerification = "verified" | "mismatch" | "unavailable" | "skipped";

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
  remoteFetchedAt: string | null;
  remoteFetchAgeDays: number | null;
  remoteVerification: RemoteVerification;
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

export type Engine = "node" | "native";

// Every JSON surface VibeVac promises to keep stable carries this header, so a
// consumer can tell which engine wrote it and which shape to expect.
export interface ContractHeader {
  schemaVersion: 2;
  engine: Engine;
  engineVersion: string;
}

export interface CommandTimeout {
  workspacePath: string;
  command: string;
  seconds: number;
}

export interface ScanReport extends ContractHeader {
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
  // Subprocess calls that hit their time limit, at most 25. The native engine
  // does not bound its subprocesses yet and omits the field.
  timeouts?: CommandTimeout[];
}

export interface CacheCleanupPlan extends ContractHeader {
  workspacePath: string;
  caches: CacheEntry[];
  reclaimBytes: number;
  confirmation: string;
}

export interface CacheCleanupResult extends ContractHeader {
  workspacePath: string;
  removed: Array<{
    relativePath: string;
    sizeBytes: number | null;
  }>;
  reclaimedBytes: number;
  completedAt: string;
  auditPath: string;
}

export interface WorktreeRemovalPlan extends ContractHeader {
  force: boolean;
  warnings: string[];
  ignoredFingerprint: string;
  workspacePath: string;
  sizeBytes: number;
  branch: string;
  head: string;
  upstream: string | null;
  defaultBranch: string | null;
  lastActivityAt: string | null;
  inactiveDays: number | null;
  commonGitDirectory: string;
  reconstructionCommand: string;
  confirmation: string;
}

export interface WorktreeRemovalResult extends ContractHeader {
  workspacePath: string;
  reclaimedBytes: number;
  preservedBranch: string;
  reconstructionCommand: string;
  completedAt: string;
  auditPath: string;
}

interface AuditRecordBase {
  version: 2;
  engine: Engine;
  engineVersion: string;
  // First 16 hex characters of SHA-256 over the revalidated plan identity,
  // so a partial or failed record can be matched to the plan it executed.
  planId: string;
  completedAt: string;
  workspacePath: string;
}

export interface CacheCleanupAuditRecord extends AuditRecordBase {
  action: "cache-cleanup";
  removed: CacheCleanupResult["removed"];
  reclaimedBytes: number;
}

export interface CacheCleanupPartialAuditRecord extends AuditRecordBase {
  action: "cache-cleanup-partial";
  removed: CacheCleanupResult["removed"];
  error: string;
}

export interface WorktreeRemovalAuditRecord extends AuditRecordBase {
  action: "worktree-removal";
  reclaimedBytes: number;
  preservedBranch: string;
  force: boolean;
  warnings: string[];
  head: string;
  upstream: string | null;
  reconstructionCommand: string;
}

export interface WorktreeRemovalFailedAuditRecord extends AuditRecordBase {
  action: "worktree-removal-failed";
  preservedBranch: string;
  force: boolean;
  warnings: string[];
  error: string;
}

// One line of ~/.vibevac/audit.jsonl.
export type AuditRecord =
  | CacheCleanupAuditRecord
  | CacheCleanupPartialAuditRecord
  | WorktreeRemovalAuditRecord
  | WorktreeRemovalFailedAuditRecord;

export interface PreviewSkip {
  workspacePath: string;
  reason: string;
}

export interface BatchPreview<T> {
  plans: T[];
  skipped: PreviewSkip[];
}
