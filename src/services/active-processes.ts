import { execFile } from "node:child_process";
import { sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ActiveProcessSnapshot {
  available: boolean;
  workingDirectories: Map<string, number>;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export async function inspectActiveProcesses(): Promise<ActiveProcessSnapshot> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-Fpn"], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      available: true,
      workingDirectories: parseLsofWorkingDirectories(stdout),
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      workingDirectories: new Map(),
      error: errorMessage(error),
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
