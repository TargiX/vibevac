import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ActiveProcessSnapshot } from "../src/services/active-processes.js";
import {
  executeWorktreeRemoval,
  planWorktreeRemoval,
} from "../src/services/worktree-removal.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const inactiveProcesses: ActiveProcessSnapshot = {
  available: true,
  workingDirectories: new Map(),
  error: null,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(path: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", path, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function fixtureWorktree(): Promise<{
  root: string;
  repository: string;
  worktree: string;
  auditPath: string;
  now: number;
}> {
  const root = await mkdtemp(resolve(tmpdir(), "vibevac-worktree-removal-"));
  temporaryDirectories.push(root);
  const repository = resolve(root, "repository");
  const remote = resolve(root, "remote.git");
  const worktree = resolve(root, "agent-worktree");
  const auditPath = resolve(root, "audit", "events.jsonl");

  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await git(repository, ["config", "user.email", "vibevac@example.test"]);
  await git(repository, ["config", "user.name", "VibeVac Test"]);
  await writeFile(
    resolve(repository, ".gitignore"),
    "node_modules\n.secret\nnext-env.d.ts\n*.tsbuildinfo\n",
  );
  await writeFile(resolve(repository, "pnpm-lock.yaml"), "lockfileVersion: '9'\n");
  await writeFile(resolve(repository, "source.ts"), "keep me\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "fixture"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["push", "-u", "origin", "main"]);
  await git(repository, ["worktree", "add", "-b", "agent/old", worktree]);
  await git(worktree, ["branch", "--set-upstream-to", "origin/main", "agent/old"]);
  await mkdir(resolve(worktree, "node_modules", "pkg"), { recursive: true });
  await writeFile(resolve(worktree, "node_modules", "pkg", "index.js"), "cache\n");
  await writeFile(resolve(worktree, "next-env.d.ts"), "generated\n");
  await writeFile(resolve(worktree, "tsconfig.tsbuildinfo"), "generated\n");

  return {
    root,
    repository,
    worktree,
    auditPath,
    now: Date.now() + 120 * 86_400_000,
  };
}

describe("worktree removal", () => {
  it("plans and removes only a fully proven linked worktree", async () => {
    const fixture = await fixtureWorktree();
    const request = {
      workspacePath: fixture.worktree,
      minimumInactiveDays: 90,
    };
    const plan = await planWorktreeRemoval(request, {
      processSnapshot: inactiveProcesses,
      now: fixture.now,
    });

    expect(plan.branch).toBe("agent/old");
    expect(plan.upstream).toBe("origin/main");
    expect(plan.inactiveDays).toBeGreaterThanOrEqual(90);
    expect(plan.reconstructionCommand).toContain("worktree add");

    const result = await executeWorktreeRemoval(
      { ...request, confirmation: plan.confirmation },
      {
        processSnapshot: inactiveProcesses,
        auditPath: fixture.auditPath,
        now: fixture.now,
      },
    );

    await expect(access(fixture.worktree)).rejects.toThrow();
    await expect(access(resolve(fixture.repository, "source.ts"))).resolves.toBeUndefined();
    expect(await git(fixture.repository, ["show-ref", "--verify", "refs/heads/agent/old"]))
      .toContain("refs/heads/agent/old");
    expect(result.preservedBranch).toBe("agent/old");
    expect(await readFile(fixture.auditPath, "utf8")).toContain(
      '"action":"worktree-removal"',
    );
  });

  it("blocks ignored data that is not a verified rebuildable cache", async () => {
    const fixture = await fixtureWorktree();
    await writeFile(resolve(fixture.worktree, ".secret"), "local-only\n");

    await expect(
      planWorktreeRemoval(
        { workspacePath: fixture.worktree, minimumInactiveDays: 90 },
        { processSnapshot: inactiveProcesses, now: fixture.now },
      ),
    ).rejects.toThrow("ignored data outside the rebuildable allowlist: .secret");

    await expect(access(fixture.worktree)).resolves.toBeUndefined();
  });

  it("refuses standalone repositories", async () => {
    const fixture = await fixtureWorktree();

    await expect(
      planWorktreeRemoval(
        { workspacePath: fixture.repository, minimumInactiveDays: 90 },
        { processSnapshot: inactiveProcesses, now: fixture.now },
      ),
    ).rejects.toThrow("Only registered linked Git worktrees can be removed");
  });
});
