import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
