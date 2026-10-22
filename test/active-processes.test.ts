import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  countProcessesWithin,
  inspectActiveProcesses,
  parseLsofWorkingDirectories,
  readProcWorkingDirectories,
} from "../src/services/active-processes.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "vibevac-processes-")));
  temporaryDirectories.push(path);
  return path;
}

describe("active process inspection", () => {
  it("counts processes whose working directories are inside a workspace", () => {
    const workingDirectories = parseLsofWorkingDirectories(
      "p10\nfcwd\nn/work/app\np11\nfcwd\nn/work/app/packages/ui\np12\nfcwd\nn/elsewhere\n",
    );

    expect(
      countProcessesWithin(
        { available: true, workingDirectories, error: null, method: "lsof", coverage: "current-user" },
        "/work/app",
      ),
    ).toBe(2);
  });

  it("returns unknown when lsof was unavailable", () => {
    expect(
      countProcessesWithin(
        {
          available: false,
          workingDirectories: new Map(),
          error: "missing",
          method: null,
          coverage: null,
        },
        "/work/app",
      ),
    ).toBeNull();
  });

  it("reads working directories from a /proc tree", async () => {
    const proc = await temporaryDirectory();
    for (const [pid, cwd] of [
      ["10", "/work/app"],
      ["11", "/work/app/packages/ui"],
      ["12", "/elsewhere"],
    ] as const) {
      await mkdir(join(proc, pid));
      await symlink(cwd, join(proc, pid, "cwd"));
    }
    await mkdir(join(proc, "13"));
    await mkdir(join(proc, "self"));

    const { workingDirectories, coverage } = await readProcWorkingDirectories(proc);

    expect(coverage).toBe("all-users");
    expect(
      countProcessesWithin(
        { available: true, workingDirectories, error: null, method: "procfs", coverage },
        "/work/app",
      ),
    ).toBe(2);
  });

  it("finds a real child process working inside a directory", async () => {
    const workspace = await temporaryDirectory();
    const nested = join(workspace, "nested");
    await mkdir(nested);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      cwd: nested,
      stdio: "ignore",
    });
    try {
      let snapshot = await inspectActiveProcesses();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((countProcessesWithin(snapshot, workspace) ?? 0) >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
        snapshot = await inspectActiveProcesses();
      }

      expect(snapshot.error).toBeNull();
      expect(snapshot.method).toBe(process.platform === "linux" ? "procfs" : "lsof");
      expect(snapshot.coverage).not.toBeNull();
      expect(countProcessesWithin(snapshot, workspace)).toBe(1);
      expect(countProcessesWithin(snapshot, `${workspace}-sibling`)).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
