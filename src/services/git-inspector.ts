import { execFile } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import type { GitInspection } from "../domain/types.js";

const execFileAsync = promisify(execFile);

async function runGit(workspacePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", workspacePath, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout.trim();
}

async function tryMtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function resolveDefaultBranch(
  workspacePath: string,
  upstream: string | null,
): Promise<string | null> {
  const remote = upstream?.split("/")[0] || "origin";
  const remoteHead = await tryGit(workspacePath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  ]);
  if (remoteHead) {
    return remoteHead;
  }

  for (const conventionalBranch of [`${remote}/main`, `${remote}/master`]) {
    const exists = await tryGit(workspacePath, [
      "show-ref",
      "--verify",
      `refs/remotes/${conventionalBranch}`,
    ]);
    if (exists) {
      return conventionalBranch;
    }
  }

  return null;
}

async function mergedInto(
  workspacePath: string,
  defaultBranch: string | null,
): Promise<boolean | null> {
  if (!defaultBranch) {
    return null;
  }

  try {
    await runGit(workspacePath, ["merge-base", "--is-ancestor", "HEAD", defaultBranch]);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 1
    ) {
      return false;
    }
    return null;
  }
}

async function lastActivityAt(
  workspacePath: string,
  lastCommitTimestamp: number | null,
): Promise<string | null> {
  const indexPath = await tryGit(workspacePath, ["rev-parse", "--git-path", "index"]);
  const resolvedIndexPath = indexPath
    ? isAbsolute(indexPath)
      ? indexPath
      : resolve(workspacePath, indexPath)
    : null;
  const timestamps = await Promise.all([
    tryMtime(workspacePath),
    resolvedIndexPath ? tryMtime(resolvedIndexPath) : Promise.resolve(null),
  ]);
  if (lastCommitTimestamp !== null) {
    timestamps.push(lastCommitTimestamp * 1000);
  }
  const validTimestamps = timestamps.filter((timestamp): timestamp is number => timestamp !== null);

  return validTimestamps.length > 0
    ? new Date(Math.max(...validTimestamps)).toISOString()
    : null;
}

async function tryGit(workspacePath: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(workspacePath, args);
  } catch {
    return null;
  }
}

function parseAheadBehind(output: string | null): {
  ahead: number | null;
  behind: number | null;
} {
  if (!output) {
    return { ahead: null, behind: null };
  }

  const [aheadValue, behindValue] = output.split(/\s+/);
  const ahead = Number.parseInt(aheadValue ?? "", 10);
  const behind = Number.parseInt(behindValue ?? "", 10);

  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return { ahead: null, behind: null };
  }

  return { ahead, behind };
}

export async function inspectGit(workspacePath: string): Promise<GitInspection> {
  await runGit(workspacePath, ["rev-parse", "--is-inside-work-tree"]);

  const gitMarker = await lstat(`${workspacePath}/.git`);
  const kind = gitMarker.isFile() ? "linked-worktree" : "standalone-repository";
  const rawStatus = await runGit(workspacePath, ["status", "--porcelain=v1", "-z"]);
  const statusEntries = rawStatus.length === 0 ? [] : rawStatus.split("\0").filter(Boolean);
  const branch = await tryGit(workspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = await runGit(workspacePath, ["rev-parse", "HEAD"]);
  const upstream = await tryGit(workspacePath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  const aheadBehind = upstream
    ? parseAheadBehind(
        await tryGit(workspacePath, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]),
      )
    : { ahead: null, behind: null };
  const remoteRefs = await tryGit(workspacePath, [
    "branch",
    "--remotes",
    "--contains",
    "HEAD",
    "--format=%(refname:short)",
  ]);
  const lastCommitTimestamp = await tryGit(workspacePath, ["log", "-1", "--format=%ct"]);
  const parsedTimestamp = Number.parseInt(lastCommitTimestamp ?? "", 10);
  const parsedCommitTimestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
  const defaultBranch = await resolveDefaultBranch(workspacePath, upstream);

  return {
    kind,
    branch,
    head,
    upstream,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    dirtyEntries: statusEntries.length,
    untrackedEntries: statusEntries.filter((entry) => entry.startsWith("??")).length,
    remoteContainsHead: Boolean(remoteRefs?.trim()),
    defaultBranch,
    mergedIntoDefault: await mergedInto(workspacePath, defaultBranch),
    lastCommitAt: parsedCommitTimestamp !== null
      ? new Date(parsedCommitTimestamp * 1000).toISOString()
      : null,
    lastActivityAt: await lastActivityAt(workspacePath, parsedCommitTimestamp),
  };
}
