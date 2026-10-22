import { execFile } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";
import { sep } from "node:path";
import { promisify } from "node:util";

import type { ProcessCheckCoverage, ProcessCheckMethod } from "../domain/types.js";

const execFileAsync = promisify(execFile);

const LSOF_TIMEOUT_MS = 5_000;
const LSOF_MAX_BUFFER = 10 * 1024 * 1024;

export interface ActiveProcessSnapshot {
  available: boolean;
  workingDirectories: Map<string, number>;
  error: string | null;
  method: ProcessCheckMethod | null;
  coverage: ProcessCheckCoverage | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function runningAsRoot(): boolean {
  return process.geteuid?.() === 0;
}

export function parseLsofWorkingDirectories(output: string): Map<string, number> {
  const directories = new Map<string, number>();

  for (const line of output.split("\n")) {
    if (!line.startsWith("n") || line.length < 2) {
      continue;
    }

    const path = line.slice(1);
    directories.set(path, (directories.get(path) ?? 0) + 1);
  }

  return directories;
}

/**
 * Reads every `/proc/<pid>/cwd` link. Links of other users' processes are
 * refused unless running as root, which is what `coverage` reports.
 */
export async function readProcWorkingDirectories(procRoot = "/proc"): Promise<{
  workingDirectories: Map<string, number>;
  coverage: ProcessCheckCoverage;
}> {
  const entries = await readdir(procRoot);
  const pids = entries.filter((entry) => /^\d+$/.test(entry));
  const workingDirectories = new Map<string, number>();
  let readable = 0;
  let permissionDenied = false;

  await Promise.all(
    pids.map(async (pid) => {
      try {
        const path = await readlink(`${procRoot}/${pid}/cwd`);
        readable += 1;
        workingDirectories.set(path, (workingDirectories.get(path) ?? 0) + 1);
      } catch (error) {
        const code = errorCode(error);
        if (code === "EACCES" || code === "EPERM") {
          permissionDenied = true;
        }
        // Anything else: the process exited between listing and reading.
      }
    }),
  );

  if (readable === 0) {
    throw new Error(`${procRoot} did not expose the working directory of any process`);
  }
  return {
    workingDirectories,
    coverage: permissionDenied ? "current-user" : "all-users",
  };
}

async function inspectWithLsof(): Promise<Map<string, number>> {
  const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-Fpn"], {
    encoding: "utf8",
    maxBuffer: LSOF_MAX_BUFFER,
    timeout: LSOF_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return parseLsofWorkingDirectories(stdout);
}

export async function inspectActiveProcesses(): Promise<ActiveProcessSnapshot> {
  let procError: string | null = null;
  if (process.platform === "linux") {
    try {
      const { workingDirectories, coverage } = await readProcWorkingDirectories();
      return { available: true, workingDirectories, error: null, method: "procfs", coverage };
    } catch (error) {
      procError = errorMessage(error);
    }
  }

  try {
    return {
      available: true,
      workingDirectories: await inspectWithLsof(),
      error: null,
      method: "lsof",
      coverage: runningAsRoot() ? "all-users" : "current-user",
    };
  } catch (error) {
    const lsofError =
      (error as { killed?: boolean } | undefined)?.killed === true
        ? `lsof did not finish within ${LSOF_TIMEOUT_MS / 1000} s`
        : errorMessage(error);
    return {
      available: false,
      workingDirectories: new Map(),
      error: procError ? `${procError}; ${lsofError}` : lsofError,
      method: null,
      coverage: null,
    };
  }
}

export function countProcessesWithin(
  snapshot: ActiveProcessSnapshot,
  workspacePath: string,
): number | null {
  if (!snapshot.available) {
    return null;
  }

  let count = 0;
  for (const [workingDirectory, processCount] of snapshot.workingDirectories) {
    if (
      workingDirectory === workspacePath ||
      workingDirectory.startsWith(`${workspacePath}${sep}`)
    ) {
      count += processCount;
    }
  }
  return count;
}
