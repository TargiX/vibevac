import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { CommandTimeout } from "../src/domain/types.js";
import {
  collectTimeouts,
  isCommandTimeout,
  runCommand,
} from "../src/services/run-command.js";
import { customDiscoveryRoots } from "../src/services/discovery.js";
import { scanWorkspaces } from "../src/services/scanner.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("runCommand", () => {
  it("returns stdout of a command that finishes in time", async () => {
    const { stdout } = await runCommand("echo", ["ready"], { timeoutMs: 5_000, maxBuffer: 1024 });
    expect(stdout.trim()).toBe("ready");
  });

  it("rejects a slow command with a timed out error and records it", async () => {
    const sink: CommandTimeout[] = [];
    const startedAt = Date.now();
    const error = await collectTimeouts(sink, "/work/slow", () =>
      runCommand("sleep", ["30"], { timeoutMs: 200, maxBuffer: 1024 }),
    ).catch((reason: unknown) => reason);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(isCommandTimeout(error)).toBe(true);
    expect((error as Error).message).toBe("timed out after 0.2s: sleep 30");
    expect(sink).toEqual([{ workspacePath: "/work/slow", command: "sleep 30", seconds: 0.2 }]);
  });

  it("keeps ordinary failures distinct from timeouts", async () => {
    const error = await runCommand("false", [], { timeoutMs: 5_000, maxBuffer: 1024 }).catch(
      (reason: unknown) => reason,
    );
    expect(isCommandTimeout(error)).toBe(false);
    expect(error).toMatchObject({ code: 1 });
  });

  it("caps recorded timeouts at 25", async () => {
    const sink: CommandTimeout[] = [];
    await collectTimeouts(sink, null, () =>
      Promise.all(
        Array.from({ length: 30 }, () =>
          runCommand("sleep", ["30"], { timeoutMs: 50, maxBuffer: 1024 }).catch(() => null),
        ),
      ),
    );
    expect(sink).toHaveLength(25);
  });
});

describe("scan with a hung Git call", () => {
  it("protects the workspace, reports inspectionError and lists the timeout", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "vibevac-timeout-"));
    temporaryDirectories.push(root);
    const repository = resolve(root, "projects/repository");
    await mkdir(repository, { recursive: true });
    await execFileAsync("git", ["-C", repository, "init", "-q"]);
    await execFileAsync("git", [
      "-C", repository, "-c", "user.email=v@example.test", "-c", "user.name=V",
      "commit", "-q", "--allow-empty", "-m", "initial",
    ]);

    // A fake git that hangs only on an optional fact. Before the fix such a
    // call quietly read as null; it must now fail the whole inspection.
    const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
    const bin = resolve(root, "bin");
    await mkdir(bin);
    await writeFile(
      resolve(bin, "git"),
      `#!/bin/sh\ncase " $* " in *" --remotes "*) exec sleep 30;; esac\nexec ${realGit} "$@"\n`,
    );
    await chmod(resolve(bin, "git"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const report = await scanWorkspaces(customDiscoveryRoots([resolve(root, "projects")]), {
        includeSize: false,
      });
      const workspace = report.workspaces[0];
      expect(workspace?.git).toBeNull();
      expect(workspace?.recommendation).toBe("protect");
      expect(workspace?.inspectionError).toMatch(/^timed out after 5s: git branch --remotes/);
      expect(report.timeouts).toEqual([
        expect.objectContaining({ command: expect.stringMatching(/^git branch --remotes/), seconds: 5 }),
      ]);
      expect(report.timeouts?.[0]?.workspacePath).toContain("repository");
    } finally {
      process.env.PATH = originalPath;
    }
  }, 20_000);
});
