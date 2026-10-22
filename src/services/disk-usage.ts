import { runCommand } from "./run-command.js";

export async function diskUsageBytes(path: string): Promise<number> {
  const { stdout } = await runCommand("du", ["-sk", path], {
    timeoutMs: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const kilobytes = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);

  if (!Number.isFinite(kilobytes)) {
    throw new Error(`Could not parse disk usage for ${path}`);
  }

  return kilobytes * 1024;
}
