import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function diskUsageBytes(path: string): Promise<number> {
  const { stdout } = await execFileAsync("du", ["-sk", path], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const kilobytes = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);

  if (!Number.isFinite(kilobytes)) {
    throw new Error(`Could not parse disk usage for ${path}`);
  }

  return kilobytes * 1024;
}
