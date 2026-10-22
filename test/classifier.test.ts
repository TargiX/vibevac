import { describe, expect, it } from "vitest";

import type { GitInspection } from "../src/domain/types.js";
import { classifyWorkspace } from "../src/services/classifier.js";

function gitInspection(overrides: Partial<GitInspection> = {}): GitInspection {
  return {
    kind: "linked-worktree",
    branch: "feature",
    head: "abc123",
    upstream: "origin/feature",
    ahead: 0,
    behind: 0,
    dirtyEntries: 0,
    untrackedEntries: 0,
    remoteContainsHead: true,
    defaultBranch: "origin/main",
    mergedIntoDefault: true,
    lastCommitAt: "2026-07-13T00:00:00.000Z",
    lastActivityAt: "2026-06-01T00:00:00.000Z",
    remoteFetchedAt: "2026-07-12T00:00:00.000Z",
    remoteFetchAgeDays: 1,
    remoteVerification: "skipped",
    ...overrides,
  };
}

describe("classifyWorkspace", () => {
  const now = Date.parse("2026-07-13T00:00:00.000Z");

  it("suggests only stale, merged, synced worktrees as candidates", () => {
    const result = classifyWorkspace(gitInspection(), { activeProcessCount: 0, now });

    expect(result.dataSafety).toBe("recoverable");
    expect(result.recommendation).toBe("candidate");
  });

  it("protects a dirty worktree", () => {
    const result = classifyWorkspace(
      gitInspection({ dirtyEntries: 2, untrackedEntries: 1 }),
      { activeProcessCount: 0, now },
    );

    expect(result.dataSafety).toBe("local-only");
    expect(result.recommendation).toBe("protect");
    expect(result.reasons[0]).toContain("2 uncommitted");
  });

  it("protects an unpushed commit", () => {
    const result = classifyWorkspace(gitInspection({ ahead: 1 }), {
      activeProcessCount: 0,
      now,
    });

    expect(result.recommendation).toBe("protect");
    expect(result.reasons).toContain("1 commit ahead of upstream");
  });

  it("protects a commit when remote recovery cannot be proven", () => {
    const result = classifyWorkspace(
      gitInspection({ upstream: null, ahead: null, behind: null, remoteContainsHead: false }),
      { activeProcessCount: 0, now },
    );

    expect(result.recommendation).toBe("protect");
    expect(result.reasons[0]).toContain("not proven");
  });

  it("always protects a standalone repository", () => {
    const result = classifyWorkspace(gitInspection({ kind: "standalone-repository" }), {
      activeProcessCount: 0,
      now,
    });

    expect(result.recommendation).toBe("protect");
    expect(result.reasons[0]).toContain("standalone repository");
  });

  it("keeps a recently active merged worktree", () => {
    const result = classifyWorkspace(
      gitInspection({ lastActivityAt: "2026-07-12T00:00:00.000Z" }),
      { activeProcessCount: 0, now },
    );

    expect(result.recommendation).toBe("keep");
  });

  it("keeps a worktree with an active process", () => {
    const result = classifyWorkspace(gitInspection(), { activeProcessCount: 2, now });

    expect(result.recommendation).toBe("keep");
    expect(result.reasons[0]).toContain("2 running processes");
  });

  it("requires review when the branch is not merged", () => {
    const result = classifyWorkspace(
      gitInspection({
        mergedIntoDefault: false,
        lastActivityAt: "2026-06-01T00:00:00.000Z",
      }),
      {
        activeProcessCount: 0,
        now,
      },
    );

    expect(result.recommendation).toBe("review");
    expect(result.reasons[0]).toContain("not merged");
  });

  it("requires review when active processes cannot be checked", () => {
    const result = classifyWorkspace(gitInspection(), { activeProcessCount: null, now });

    expect(result.recommendation).toBe("review");
  });

  it("keeps recent activity even when HEAD is detached", () => {
    const result = classifyWorkspace(
      gitInspection({
        branch: null,
        lastActivityAt: "2026-07-13T00:00:00.000Z",
      }),
      { activeProcessCount: 0, now },
    );

    expect(result.recommendation).toBe("keep");
  });

  it("requires review instead of candidate when the remote was fetched over 7 days ago", () => {
    const result = classifyWorkspace(
      gitInspection({ remoteFetchedAt: "2026-06-20T00:00:00.000Z", remoteFetchAgeDays: 23 }),
      { activeProcessCount: 0, now },
    );

    expect(result.dataSafety).toBe("recoverable");
    expect(result.recommendation).toBe("review");
    expect(result.reasons).toEqual([
      "remote state last fetched 23d ago; run git fetch to refresh",
    ]);
  });

  it("accepts remote evidence that is exactly 7 days old", () => {
    const result = classifyWorkspace(gitInspection({ remoteFetchAgeDays: 7 }), {
      activeProcessCount: 0,
      now,
    });

    expect(result.recommendation).toBe("candidate");
  });

  it("requires review when the remote fetch time is unknown", () => {
    const result = classifyWorkspace(
      gitInspection({ remoteFetchedAt: null, remoteFetchAgeDays: null }),
      { activeProcessCount: 0, now },
    );

    expect(result.recommendation).toBe("review");
    expect(result.reasons).toEqual([
      "remote fetch time is unknown; run git fetch to refresh",
    ]);
  });

  it("lets a verified live check stand in for a stale fetch, but not a mismatch", () => {
    const stale = { remoteFetchedAt: null, remoteFetchAgeDays: null };

    expect(
      classifyWorkspace(gitInspection({ ...stale, remoteVerification: "verified" }), {
        activeProcessCount: 0,
        now,
      }).recommendation,
    ).toBe("candidate");
    for (const remoteVerification of ["mismatch", "unavailable"] as const) {
      expect(
        classifyWorkspace(gitInspection({ ...stale, remoteVerification }), {
          activeProcessCount: 0,
          now,
        }).recommendation,
      ).toBe("review");
    }
  });

  it("keeps earlier protect and keep reasons ahead of stale remote evidence", () => {
    const stale = { remoteFetchAgeDays: 90 };

    expect(
      classifyWorkspace(gitInspection({ ...stale, ahead: 1 }), { activeProcessCount: 0, now })
        .recommendation,
    ).toBe("protect");
    expect(
      classifyWorkspace(
        gitInspection({ ...stale, lastActivityAt: "2026-07-12T00:00:00.000Z" }),
        { activeProcessCount: 0, now },
      ).recommendation,
    ).toBe("keep");
    expect(
      classifyWorkspace(gitInspection({ ...stale, mergedIntoDefault: false }), {
        activeProcessCount: 0,
        now,
      }).reasons[0],
    ).toContain("not merged");
  });
});
