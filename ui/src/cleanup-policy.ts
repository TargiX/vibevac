import type { WorkspaceReport } from "../../src/domain/types.js";

export type CleanupLevelIndex = 0 | 1 | 2 | 3;
export type CleanupTone = "careful" | "balanced" | "thorough" | "full";
export type CleanupScope = "cache" | "worktree";
export type CleanupPresentationTone =
  | "careful"
  | "balanced"
  | "thorough"
  | "rebuildable-full"
  | "danger";

export interface CleanupLevel {
  index: CleanupLevelIndex;
  label: string;
  shortLabel: string;
  minimumInactiveDays: number | null;
  tone: CleanupTone;
  description: string;
}

export const CLEANUP_LEVELS: readonly CleanupLevel[] = [
  {
    index: 0,
    label: "Careful",
    shortLabel: "90+ days",
    minimumInactiveDays: 90,
    tone: "careful",
    description: "Only workspaces untouched for at least 90 days.",
  },
  {
    index: 1,
    label: "Balanced",
    shortLabel: "30+ days",
    minimumInactiveDays: 30,
    tone: "balanced",
    description: "Workspaces untouched for at least 30 days.",
  },
  {
    index: 2,
    label: "Thorough",
    shortLabel: "14+ days",
    minimumInactiveDays: 14,
    tone: "thorough",
    description: "Workspaces untouched for at least two weeks.",
  },
  {
    index: 3,
    label: "Full cache",
    shortLabel: "All verified",
    minimumInactiveDays: null,
    tone: "full",
    description: "All verified caches, including recently used workspaces.",
  },
] as const;

export const WORKTREE_CLEANUP_LEVELS: readonly CleanupLevel[] = [
  {
    index: 0,
    label: "Careful",
    shortLabel: "90+ days",
    minimumInactiveDays: 90,
    tone: "careful",
    description: "Only proven worktrees untouched for at least 90 days.",
  },
  {
    index: 1,
    label: "Balanced",
    shortLabel: "60+ days",
    minimumInactiveDays: 60,
    tone: "balanced",
    description: "Only proven worktrees untouched for at least 60 days.",
  },
  {
    index: 2,
    label: "Thorough",
    shortLabel: "30+ days",
    minimumInactiveDays: 30,
    tone: "thorough",
    description: "Only proven worktrees untouched for at least 30 days.",
  },
  {
    index: 3,
    label: "Extreme",
    shortLabel: "14+ days",
    minimumInactiveDays: 14,
    tone: "full",
    description: "Proven worktrees untouched for at least two weeks.",
  },
] as const;

export function cleanupLevels(scope: CleanupScope): readonly CleanupLevel[] {
  return scope === "worktree" ? WORKTREE_CLEANUP_LEVELS : CLEANUP_LEVELS;
}

export function cleanupLevel(index: number, scope: CleanupScope = "cache"): CleanupLevel {
  const levels = cleanupLevels(scope);
  return levels[index] ?? levels[0]!;
}

export function cleanupPresentationTone(
  scope: CleanupScope,
  level: CleanupLevel,
): CleanupPresentationTone {
  if (scope === "worktree") return "danger";
  return level.tone === "full" ? "rebuildable-full" : level.tone;
}

export function isWorkspaceInWorktreeLevel(
  workspace: Pick<
    WorkspaceReport,
    "activeProcessCount" | "git" | "reasons" | "recommendation" | "sizeBytes"
  >,
  level: CleanupLevel,
  now = Date.now(),
): boolean {
  return worktreeRemovalBlocker(workspace, level, now) === null;
}

export function worktreeRemovalBlocker(
  workspace: Pick<
    WorkspaceReport,
    "activeProcessCount" | "git" | "reasons" | "recommendation" | "sizeBytes"
  >,
  level: CleanupLevel,
  now = Date.now(),
): string | null {
  const git = workspace.git;
  if (!git) return workspace.reasons[0] ?? "Git inspection is unavailable.";
  if (git.kind !== "linked-worktree") {
    return "Standalone repositories are protected from entire-worktree removal.";
  }
  if (workspace.activeProcessCount === null) {
    return "The active-process check is unavailable.";
  }
  if (workspace.activeProcessCount > 0) {
    return `${workspace.activeProcessCount} running ${
      workspace.activeProcessCount === 1 ? "process is" : "processes are"
    } using this worktree.`;
  }
  if (git.dirtyEntries > 0 || git.untrackedEntries > 0) {
    return `${git.dirtyEntries} modified and ${git.untrackedEntries} untracked entries must be resolved.`;
  }
  if (!git.branch) return "The worktree has a detached HEAD.";
  if (!git.upstream) return "No upstream branch is configured for this worktree.";
  if (git.ahead === null) return "Upstream synchronization could not be proven.";
  if (git.ahead > 0) return `${git.ahead} local commits have not been pushed.`;
  if (!git.remoteContainsHead) return "Remote recovery of the current commit is not proven.";
  if (!git.defaultBranch) return "The repository default branch is unknown.";
  if (git.mergedIntoDefault !== true) {
    return "The current commit is not proven merged into the default branch.";
  }
  if (workspace.sizeBytes === null) return "The worktree size could not be measured.";
  if (level.minimumInactiveDays === null) return "Entire-worktree removal requires an age limit.";

  const age = activityAgeDays(git.lastActivityAt, now);
  if (age === null) return "The last activity time is unknown.";
  if (age < level.minimumInactiveDays) {
    return `Used ${age} ${age === 1 ? "day" : "days"} ago; ${level.minimumInactiveDays}+ days required.`;
  }
  if (workspace.recommendation !== "candidate") {
    return workspace.reasons[0] ?? "The safety classification is incomplete.";
  }
  return null;
}

export function activityAgeDays(
  timestamp: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / 86_400_000));
}

export function isWorkspaceInCleanupLevel(
  workspace: Pick<WorkspaceReport, "cacheBytes" | "cacheCleanupAllowed" | "git">,
  level: CleanupLevel,
  now = Date.now(),
): boolean {
  if (!workspace.cacheCleanupAllowed || workspace.cacheBytes <= 0) return false;
  if (level.minimumInactiveDays === null) return true;

  const age = activityAgeDays(workspace.git?.lastActivityAt, now);
  return age !== null && age >= level.minimumInactiveDays;
}
