import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ActiveProcessSnapshot } from "../src/services/active-processes.js";
import {
  executeCacheCleanup,
  planCacheCleanup,
} from "../src/services/cache-cleanup.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const noActiveProcesses: ActiveProcessSnapshot = {
  available: true,
  workingDirectories: new Map(),
  error: null,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "vibevac-cleanup-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "-b", "main", root], { encoding: "utf8" });
  await execFileAsync("git", ["-C", root, "config", "user.email", "vibevac@example.test"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "VibeVac Test"]);
  await writeFile(resolve(root, ".gitignore"), "node_modules\n.nuxt\n");
  await writeFile(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(resolve(root, "source.ts"), "valuable source\n");
  await execFileAsync("git", ["-C", root, "add", ".gitignore", "pnpm-lock.yaml", "source.ts"]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "Initial fixture"]);
  await mkdir(resolve(root, "node_modules", "package"), { recursive: true });
  await writeFile(resolve(root, "node_modules", "package", "index.js"), "cache\n");
  return root;
}

describe("cache cleanup", () => {
  it("removes only a revalidated selected cache and writes an audit record", async () => {
    const root = await createRepository();
    const auditPath = resolve(root, "audit", "events.jsonl");

    const plan = await planCacheCleanup(root, ["node_modules"], {
      processSnapshot: noActiveProcesses,
    });
    expect(plan.caches.map((cache) => cache.relativePath)).toEqual(["node_modules"]);
    expect(plan.confirmation).toContain("CLEAN");

    const result = await executeCacheCleanup(root, ["node_modules"], {
      processSnapshot: noActiveProcesses,
      auditPath,
    });

    await expect(access(resolve(root, "node_modules"))).rejects.toThrow();
    await expect(readFile(resolve(root, "source.ts"), "utf8")).resolves.toBe(
      "valuable source\n",
    );
    expect(result.removed).toHaveLength(1);
    expect(await readFile(auditPath, "utf8")).toContain('"action":"cache-cleanup"');
  });

  it("refuses arbitrary paths that are not in the verified inventory", async () => {
    const root = await createRepository();

    await expect(
      planCacheCleanup(root, ["source.ts"], {
        processSnapshot: noActiveProcesses,
      }),
    ).rejects.toThrow("not in the verified rebuildable cache inventory");
  });

  it("refuses cleanup while a process is working inside the workspace", async () => {
    const root = await createRepository();
    const activeProcesses: ActiveProcessSnapshot = {
      available: true,
      workingDirectories: new Map([[root, 1]]),
      error: null,
    };

    await expect(
      planCacheCleanup(root, ["node_modules"], {
        processSnapshot: activeProcesses,
      }),
    ).rejects.toThrow("running process");
  });
});
