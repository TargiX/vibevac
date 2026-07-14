import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { inventoryRebuildableCaches } from "../src/services/cache-inventory.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createRepository(withLockfile = true): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "vibevac-cache-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "-b", "main", root], { encoding: "utf8" });
  await writeFile(resolve(root, ".gitignore"), "node_modules\n.nuxt\n");
  if (withLockfile) {
    await writeFile(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  }
  return root;
}

describe("rebuildable cache inventory", () => {
  it("includes only known, Git-ignored, reproducible directories", async () => {
    const root = await createRepository();
    await mkdir(resolve(root, "node_modules", "package"), { recursive: true });
    await mkdir(resolve(root, ".nuxt", "dist"), { recursive: true });
    await mkdir(resolve(root, "dist"), { recursive: true });
    await writeFile(resolve(root, "node_modules", "package", "index.js"), "fixture\n");
    await writeFile(resolve(root, ".nuxt", "dist", "app.js"), "fixture\n");
    await writeFile(resolve(root, "dist", "release.js"), "do not classify\n");

    const result = await inventoryRebuildableCaches(root);

    expect(result.map((cache) => cache.relativePath).sort()).toEqual([
      ".nuxt",
      "node_modules",
    ]);
    expect(result.every((cache) => cache.ignoredByGit)).toBe(true);
    expect(result.every((cache) => (cache.sizeBytes ?? 0) > 0)).toBe(true);
  });

  it("does not call node_modules reproducible without a lockfile", async () => {
    const root = await createRepository(false);
    await mkdir(resolve(root, "node_modules", "package"), { recursive: true });

    const result = await inventoryRebuildableCaches(root);

    expect(result).toEqual([]);
  });

  it("does not attribute a nested worktree cache to its parent repository", async () => {
    const root = await createRepository();
    await writeFile(resolve(root, ".gitignore"), "node_modules\n.worktrees\n");
    await mkdir(resolve(root, "node_modules", "parent-package"), { recursive: true });
    await mkdir(resolve(root, ".worktrees", "agent", "node_modules", "child-package"), {
      recursive: true,
    });
    await writeFile(resolve(root, ".worktrees", "agent", ".git"), "gitdir: /tmp/agent\n");

    const result = await inventoryRebuildableCaches(root);

    expect(result.map((cache) => cache.relativePath)).toEqual(["node_modules"]);
  });
});
