import { describe, expect, it } from "vitest";

import type { WorkspaceReport } from "../src/domain/types.js";
import {
  CLEANUP_LEVELS,
  WORKTREE_CLEANUP_LEVELS,
  activityAgeDays,
  cleanupPresentationTone,
  cleanupLevels,
  selectVisibleWorktrees,
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
  it("explicit override admits protected linked worktrees while preserving structural limits", () => {
    const base = workspace(120);
    const protectedWorkspace = {
      ...base,
      git: { ...base.git!, kind: "linked-worktree" as const, upstream: null, dirtyEntries: 2, ahead: 3, mergedIntoDefault: false },
      activeProcessCount: 4,
      recommendation: "protect" as const,
      reasons: ["local changes"],
      sizeBytes: 1000,
    };
    expect(isWorkspaceInWorktreeLevel(protectedWorkspace, WORKTREE_CLEANUP_LEVELS[0]!, NOW)).toBe(false);
    expect(isWorkspaceInWorktreeLevel(protectedWorkspace, WORKTREE_CLEANUP_LEVELS[0]!, NOW, true)).toBe(true);
    expect(isWorkspaceInWorktreeLevel({ ...protectedWorkspace, git: base.git }, WORKTREE_CLEANUP_LEVELS[0]!, NOW, true)).toBe(false);
    expect(isWorkspaceInWorktreeLevel({ ...protectedWorkspace, git: { ...protectedWorkspace.git, branch: null } }, WORKTREE_CLEANUP_LEVELS[0]!, NOW, true)).toBe(false);
    expect(isWorkspaceInWorktreeLevel({ ...protectedWorkspace, sizeBytes: null }, WORKTREE_CLEANUP_LEVELS[0]!, NOW, true)).toBe(false);
  });
  it("keeps the selected inactivity filter when protections are overridden", () => {
    const levels = cleanupLevels("worktree", true);
    const reports = [120, 75, 45, 20, 7, 6, 0, null].map((days) => {
      const base = workspace(days);
      return {
        ...base,
        git: { ...base.git!, kind: "linked-worktree" as const, dirtyEntries: 2, mergedIntoDefault: false },
        activeProcessCount: 3,
        recommendation: "protect" as const,
        reasons: ["local changes"],
        sizeBytes: 1000,
      };
    });
    expect(levels.map((level) => level.minimumInactiveDays)).toEqual([90, 60, 30, 14, 7, 0]);
    expect(levels.map((level) => reports.filter((report) => isWorkspaceInWorktreeLevel(report, level, NOW, true)).length)).toEqual([1, 2, 3, 4, 5, 8]);
    expect(cleanupLevels("worktree").length).toBe(4);
    expect(cleanupLevels("cache", true).length).toBe(4);
    expect(worktreeRemovalBlocker(reports[4]!, levels[0]!, NOW, true)).toContain("90+ days required");
    expect(worktreeRemovalBlocker(reports[7]!, levels[0]!, NOW, true)).toBe("The last activity time is unknown.");
  });

  it("bulk selection adds only eligible rows in the current view", () => {
    const previous = new Set(["/already-selected-hidden", "/stale-ineligible"]);
    const eligible = new Set(["/shown", "/unselected-hidden", "/already-selected-hidden"]);
    const selected = selectVisibleWorktrees(previous, ["/shown", "/protected", "/shown"], eligible);
    expect([...selected]).toEqual(["/already-selected-hidden", "/shown"]);
    expect(selected.has("/unselected-hidden")).toBe(false);
    expect([...previous]).toEqual(["/already-selected-hidden", "/stale-ineligible"]);
    expect(selectVisibleWorktrees(new Set(), ["/protected"], eligible).size).toBe(0);
  });

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
