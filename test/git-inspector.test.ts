import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { classifyWorkspace } from "../src/services/classifier.js";
import { inspectGit } from "../src/services/git-inspector.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Git inspection", () => {
  it("proves merge state and protects a worktree when an untracked file appears", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "vibevac-git-"));
    temporaryDirectories.push(root);
    const repository = resolve(root, "repository");
    const remote = resolve(root, "remote.git");
    const worktree = resolve(root, "worktree");

    await mkdir(repository);
    await execFileAsync("git", ["init", "--bare", remote], { encoding: "utf8" });
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "user.email", "vibevac@example.test");
    await git(repository, "config", "user.name", "VibeVac Test");
    await writeFile(resolve(repository, "README.md"), "fixture\n");
    await git(repository, "add", "README.md");
    await git(repository, "commit", "-m", "Initial commit");
    await git(repository, "remote", "add", "origin", remote);
    await git(repository, "push", "-u", "origin", "main");
    await git(repository, "worktree", "add", "-b", "feature", worktree);
    await writeFile(resolve(worktree, "feature.txt"), "feature work\n");
    await git(worktree, "add", "feature.txt");
    await git(worktree, "commit", "-m", "Add feature");
    await git(worktree, "push", "-u", "origin", "feature");

    const cleanInspection = await inspectGit(worktree);
    expect(cleanInspection.kind).toBe("linked-worktree");
    expect(cleanInspection.defaultBranch).toBe("origin/main");
    expect(cleanInspection.mergedIntoDefault).toBe(false);
    expect(
      classifyWorkspace(cleanInspection, { activeProcessCount: 0 }).recommendation,
    ).toBe("keep");

    await git(repository, "merge", "--ff-only", "feature");
    await git(repository, "push", "origin", "main");
    const mergedInspection = await inspectGit(worktree);
    expect(mergedInspection.mergedIntoDefault).toBe(true);

    await writeFile(resolve(worktree, "local-only.txt"), "do not delete\n");

    const dirtyInspection = await inspectGit(worktree);
    expect(dirtyInspection.untrackedEntries).toBe(1);
    expect(
      classifyWorkspace(dirtyInspection, { activeProcessCount: 0 }).recommendation,
    ).toBe("protect");
  });

  async function mergedWorktreeFixture(): Promise<{
    root: string;
    repository: string;
    remote: string;
    worktree: string;
  }> {
    const root = await mkdtemp(resolve(tmpdir(), "vibevac-fetch-"));
    temporaryDirectories.push(root);
    const repository = resolve(root, "repository");
    const remote = resolve(root, "remote.git");
    const worktree = resolve(root, "worktree");

    await mkdir(repository);
    await execFileAsync("git", ["init", "--bare", remote], { encoding: "utf8" });
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "user.email", "vibevac@example.test");
    await git(repository, "config", "user.name", "VibeVac Test");
    await writeFile(resolve(repository, "README.md"), "fixture\n");
    await git(repository, "add", "README.md");
    await git(repository, "commit", "-m", "Initial commit");
    await git(repository, "remote", "add", "origin", remote);
    await git(repository, "push", "-u", "origin", "main");
    await git(repository, "worktree", "add", "-b", "feature", worktree);
    await git(worktree, "push", "-u", "origin", "feature");
    await git(repository, "fetch", "origin");
    return { root, repository, remote, worktree };
  }

  it("reads remote fetch age from FETCH_HEAD and downgrades stale evidence", async () => {
    const { repository, worktree } = await mergedWorktreeFixture();
    const now = Date.parse("2026-07-13T00:00:00.000Z");
    const day = 86_400_000;
    const fetchHead = resolve(repository, ".git", "FETCH_HEAD");

    await utimes(fetchHead, new Date(now - 2 * day), new Date(now - 2 * day));
    await utimes(worktree, new Date(now - 30 * day), new Date(now - 30 * day));
    const fresh = await inspectGit(worktree, { now });
    expect(fresh.remoteFetchedAt).toBe(new Date(now - 2 * day).toISOString());
    expect(fresh.remoteFetchAgeDays).toBe(2);
    expect(fresh.remoteVerification).toBe("skipped");

    await utimes(fetchHead, new Date(now - 23 * day), new Date(now - 23 * day));
    const stale = await inspectGit(worktree, { now });
    expect(stale.remoteFetchAgeDays).toBe(23);
    const classification = classifyWorkspace(
      { ...stale, lastActivityAt: new Date(now - 30 * day).toISOString() },
      { activeProcessCount: 0, now },
    );
    expect(classification.recommendation).toBe("review");
    expect(classification.reasons).toEqual([
      "remote state last fetched 23d ago; run git fetch to refresh",
    ]);
  });

  it("falls back to remote-tracking refs and reports no evidence without a remote", async () => {
    const { repository, worktree } = await mergedWorktreeFixture();
    const now = Date.now();
    await rm(resolve(repository, ".git", "FETCH_HEAD"));
    await rm(resolve(repository, ".git", "worktrees", "worktree", "FETCH_HEAD"), { force: true });

    const fallback = await inspectGit(worktree, { now });
    expect(fallback.remoteFetchAgeDays).toBe(0);

    await git(repository, "remote", "remove", "origin");
    const withoutRemote = await inspectGit(worktree, { now });
    expect(withoutRemote.remoteFetchedAt).toBeNull();
    expect(withoutRemote.remoteFetchAgeDays).toBeNull();
  });

  it("verifies the upstream branch with the remote only when asked", async () => {
    const { root, remote, worktree } = await mergedWorktreeFixture();

    expect((await inspectGit(worktree)).remoteVerification).toBe("skipped");
    expect((await inspectGit(worktree, { verifyRemote: true })).remoteVerification).toBe(
      "verified",
    );

    // Another clone deletes the branch on the server; the local ref still has it.
    const other = resolve(root, "other");
    await execFileAsync("git", ["clone", remote, other], { encoding: "utf8" });
    await git(other, "push", "origin", "--delete", "feature");
    expect((await inspectGit(worktree, { verifyRemote: true })).remoteVerification).toBe(
      "mismatch",
    );

    await git(worktree, "remote", "set-url", "origin", resolve(root, "missing.git"));
    expect((await inspectGit(worktree, { verifyRemote: true })).remoteVerification).toBe(
      "unavailable",
    );
  });
});
