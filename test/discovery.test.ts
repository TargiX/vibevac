import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultDiscoveryRoots,
  discoverWorkspaces,
} from "../src/services/discovery.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("discoverWorkspaces", () => {
  it("finds Git markers and does not descend into the workspace", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "vibevac-discovery-"));
    temporaryDirectories.push(root);
    const workspace = resolve(root, "bucket", "project");
    await mkdir(resolve(workspace, "node_modules", "nested"), { recursive: true });
    await writeFile(resolve(workspace, ".git"), "gitdir: /tmp/example\n");
    await writeFile(resolve(workspace, "node_modules", "nested", ".git"), "ignored\n");

    const result = await discoverWorkspaces([
      { tool: "custom", path: root, maxDepth: 3 },
    ]);

    expect(result).toEqual([{ tool: "custom", path: workspace, sourcePath: root }]);
  });

  it("ignores missing roots", async () => {
    const result = await discoverWorkspaces([
      { tool: "custom", path: "/definitely/missing/vibevac-root", maxDepth: 3 },
    ]);

    expect(result).toEqual([]);
  });

  it("automatically includes existing common project folders and OpenClaw workspace", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "vibevac-home-"));
    temporaryDirectories.push(home);
    await Promise.all([
      mkdir(resolve(home, ".codex/worktrees"), { recursive: true }),
      mkdir(resolve(home, "Code"), { recursive: true }),
      mkdir(resolve(home, "repos"), { recursive: true }),
      mkdir(resolve(home, ".openclaw/workspace"), { recursive: true }),
    ]);

    const roots = defaultDiscoveryRoots(home);

    expect(roots.map((root) => [root.tool, root.path])).toEqual([
      ["codex", resolve(home, ".codex/worktrees")],
      ["projects", resolve(home, "Code")],
      ["projects", resolve(home, "repos")],
      ["openclaw", resolve(home, ".openclaw/workspace")],
    ]);
  });

  it("finds registered worktrees outside a project source and identifies Hermes branches", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "vibevac-registered-"));
    temporaryDirectories.push(root);
    const source = resolve(root, "Code");
    const repository = resolve(source, "project");
    const worktree = resolve(root, "agent-worktrees", "feature");
    await mkdir(repository, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main", repository], { encoding: "utf8" });
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "VibeVac Test"]);
    await writeFile(resolve(repository, "README.md"), "fixture\n");
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "fixture"]);
    await mkdir(resolve(root, "agent-worktrees"), { recursive: true });
    await execFileAsync("git", [
      "-C",
      repository,
      "worktree",
      "add",
      "-b",
      "hermes/feature",
      worktree,
    ]);

    const result = await discoverWorkspaces([
      { tool: "projects", path: source, maxDepth: 3 },
    ]);

    expect(result).toEqual([
      { tool: "hermes", path: await realpath(worktree), sourcePath: source },
      { tool: "projects", path: repository, sourcePath: source },
    ]);
  });
});
