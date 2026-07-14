import { describe, expect, it } from "vitest";

import type { WorkspaceReport } from "../src/domain/types.js";
import {
  CLEANUP_LEVELS,
  WORKTREE_CLEANUP_LEVELS,
  activityAgeDays,
  cleanupPresentationTone,
  isWorkspaceInCleanupLevel,
  isWorkspaceInWorktreeLevel,
  worktreeRemovalBlocker,
} from "../ui/src/cleanup-policy.js";

const NOW = Date.parse("2026-07-14T00:00:00.000Z");

function workspace(
  daysAgo: number | null,
  options: { allowed?: boolean; cacheBytes?: number } = {},
): Pick<WorkspaceReport, "cacheBytes" | "cacheCleanupAllowed" | "git"> {
  return {
    cacheBytes: options.cacheBytes ?? 1_000,
    cacheCleanupAllowed: options.allowed ?? true,
    git: {
      kind: "standalone-repository",
      branch: "main",
      head: "abc123",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      dirtyEntries: 0,
      untrackedEntries: 0,
      remoteContainsHead: true,
      defaultBranch: "main",
      mergedIntoDefault: true,
      lastCommitAt: null,
      lastActivityAt:
        daysAgo === null ? null : new Date(NOW - daysAgo * 86_400_000).toISOString(),
    },
  };
}

describe("cleanup policy", () => {
  it("reserves destructive styling for entire-worktree removal", () => {
    expect(CLEANUP_LEVELS.map((level) => cleanupPresentationTone("cache", level))).toEqual([
      "careful",
      "balanced",
      "thorough",
      "rebuildable-full",
    ]);
    expect(
      WORKTREE_CLEANUP_LEVELS.map((level) => cleanupPresentationTone("worktree", level)),
    ).toEqual(["danger", "danger", "danger", "danger"]);
  });

  it("turns activity timestamps into whole inactive days", () => {
    expect(activityAgeDays("2026-07-13T00:00:00.000Z", NOW)).toBe(1);
    expect(activityAgeDays(null, NOW)).toBeNull();
    expect(activityAgeDays("not-a-date", NOW)).toBeNull();
  });

  it("expands the selected set as the cleanup level increases", () => {
    const oldWorkspace = workspace(120);
    const monthOldWorkspace = workspace(45);
    const recentWorkspace = workspace(2);
    const unknownWorkspace = workspace(null);

    expect(isWorkspaceInCleanupLevel(oldWorkspace, CLEANUP_LEVELS[0]!, NOW)).toBe(true);
    expect(isWorkspaceInCleanupLevel(monthOldWorkspace, CLEANUP_LEVELS[0]!, NOW)).toBe(false);
    expect(isWorkspaceInCleanupLevel(monthOldWorkspace, CLEANUP_LEVELS[1]!, NOW)).toBe(true);
    expect(isWorkspaceInCleanupLevel(recentWorkspace, CLEANUP_LEVELS[2]!, NOW)).toBe(false);
    expect(isWorkspaceInCleanupLevel(recentWorkspace, CLEANUP_LEVELS[3]!, NOW)).toBe(true);
    expect(isWorkspaceInCleanupLevel(unknownWorkspace, CLEANUP_LEVELS[2]!, NOW)).toBe(false);
    expect(isWorkspaceInCleanupLevel(unknownWorkspace, CLEANUP_LEVELS[3]!, NOW)).toBe(true);
  });

  it("never includes blocked or empty cache inventories", () => {
    expect(
      isWorkspaceInCleanupLevel(workspace(120, { allowed: false }), CLEANUP_LEVELS[3]!, NOW),
    ).toBe(false);
    expect(
      isWorkspaceInCleanupLevel(workspace(120, { cacheBytes: 0 }), CLEANUP_LEVELS[3]!, NOW),
    ).toBe(false);
  });

  it("keeps full-worktree removal old, linked, and candidate-only", () => {
    const base = workspace(45);
    const candidate = {
      ...base,
      git: base.git ? { ...base.git, kind: "linked-worktree" as const } : null,
      activeProcessCount: 0,
      reasons: [],
      recommendation: "candidate" as const,
      sizeBytes: 1_000,
    };

    expect(isWorkspaceInWorktreeLevel(candidate, WORKTREE_CLEANUP_LEVELS[2]!, NOW)).toBe(true);
    expect(worktreeRemovalBlocker(candidate, WORKTREE_CLEANUP_LEVELS[2]!, NOW)).toBeNull();
    expect(isWorkspaceInWorktreeLevel(candidate, WORKTREE_CLEANUP_LEVELS[1]!, NOW)).toBe(false);
    expect(
      isWorkspaceInWorktreeLevel(
        { ...candidate, recommendation: "keep" },
        WORKTREE_CLEANUP_LEVELS[3]!,
        NOW,
      ),
    ).toBe(false);
    expect(
      isWorkspaceInWorktreeLevel(
        {
          ...candidate,
          git: candidate.git ? { ...candidate.git, kind: "standalone-repository" } : null,
        },
        WORKTREE_CLEANUP_LEVELS[3]!,
        NOW,
      ),
    ).toBe(false);
    expect(
      isWorkspaceInWorktreeLevel(
        {
          ...candidate,
          git: candidate.git ? { ...candidate.git, upstream: null } : null,
        },
        WORKTREE_CLEANUP_LEVELS[3]!,
        NOW,
      ),
    ).toBe(false);
    expect(
      worktreeRemovalBlocker(
        {
          ...candidate,
          git: candidate.git ? { ...candidate.git, upstream: null } : null,
        },
        WORKTREE_CLEANUP_LEVELS[3]!,
        NOW,
      ),
    ).toBe("No upstream branch is configured for this worktree.");
    expect(
      worktreeRemovalBlocker(
        {
          ...candidate,
          git: candidate.git ? { ...candidate.git, kind: "standalone-repository" } : null,
        },
        WORKTREE_CLEANUP_LEVELS[3]!,
        NOW,
      ),
    ).toBe("Standalone repositories are protected from entire-worktree removal.");
  });
});
