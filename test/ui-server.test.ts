import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CacheCleanupPlan,
  CacheCleanupResult,
  ScanReport,
} from "../src/domain/types.js";
import { startUiServer, type UiServerHandle } from "../src/server/ui-server.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const servers: UiServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<{
  root: string;
  staticDirectory: string;
  auditPath: string;
}> {
  const root = await mkdtemp(resolve(tmpdir(), "vibevac-ui-server-"));
  temporaryDirectories.push(root);
  const repository = resolve(root, "repository");
  const staticDirectory = resolve(root, "ui");
  const auditPath = resolve(root, "audit", "events.jsonl");

  await mkdir(repository);
  await mkdir(staticDirectory);
  await writeFile(
    resolve(staticDirectory, "index.html"),
    '<meta name="vibevac-token" content="__VIBEVAC_TOKEN__"><div id="app"></div>',
  );
  await execFileAsync("git", ["init", "-b", "main", repository], { encoding: "utf8" });
  await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "VibeVac Test"]);
  await writeFile(resolve(repository, ".gitignore"), "node_modules\n");
  await writeFile(resolve(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(resolve(repository, "source.ts"), "keep me\n");
  await execFileAsync("git", [
    "-C",
    repository,
    "add",
    ".gitignore",
    "pnpm-lock.yaml",
    "source.ts",
  ]);
  await execFileAsync("git", ["-C", repository, "commit", "-m", "Initial fixture"]);
  await mkdir(resolve(repository, "node_modules", "package"), { recursive: true });
  await writeFile(resolve(repository, "node_modules", "package", "index.js"), "cache\n");

  return { root: repository, staticDirectory, auditPath };
}

describe("local UI server", () => {
  it("requires a session token and cleans only a revalidated fixture cache", async () => {
    const fixture = await createFixture();
    const server = await startUiServer({
      openBrowser: false,
      roots: [{ tool: "custom", path: fixture.root, maxDepth: 0 }],
      staticDirectory: fixture.staticDirectory,
      auditPath: fixture.auditPath,
    });
    servers.push(server);

    const denied = await fetch(`${server.url}/api/cache/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspacePath: fixture.root,
        relativePaths: ["node_modules"],
      }),
    });
    expect(denied.status).toBe(403);

    const scanResponse = await fetch(`${server.url}/api/scan`);
    const scan = (await scanResponse.json()) as ScanReport;
    expect(scan.workspaces).toHaveLength(1);
    expect(scan.workspaces[0]?.cacheBytes).toBeGreaterThan(0);

    const headers = {
      "Content-Type": "application/json",
      "X-VibeVac-Token": server.token,
      Origin: server.url,
    };
    const previewResponse = await fetch(`${server.url}/api/cache/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspacePath: fixture.root,
        relativePaths: ["node_modules"],
      }),
    });
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as CacheCleanupPlan;

    const cleanupResponse = await fetch(`${server.url}/api/cache/clean`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspacePath: fixture.root,
        relativePaths: ["node_modules"],
        confirmation: preview.confirmation,
      }),
    });
    expect(cleanupResponse.status).toBe(200);
    const cleanup = (await cleanupResponse.json()) as CacheCleanupResult;

    expect(cleanup.removed.map((entry) => entry.relativePath)).toEqual([
      "node_modules",
    ]);
    await expect(access(resolve(fixture.root, "node_modules"))).rejects.toThrow();
    await expect(readFile(resolve(fixture.root, "source.ts"), "utf8")).resolves.toBe(
      "keep me\n",
    );
    expect(await readFile(fixture.auditPath, "utf8")).toContain(
      '"action":"cache-cleanup"',
    );
  });
});
