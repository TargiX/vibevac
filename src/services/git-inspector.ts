import { execFile } from "node:child_process";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import type { GitInspection, RemoteVerification } from "../domain/types.js";

const execFileAsync = promisify(execFile);
const DAY_IN_MS = 86_400_000;
const REMOTE_VERIFY_TIMEOUT_MS = 15_000;

export interface InspectGitOptions {
  now?: number;
  verifyRemote?: boolean;
}

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

function remoteNameFor(upstream: string | null): string {
  return upstream?.split("/")[0] || "origin";
}

async function newestMtimeWithin(directory: string, depth = 0): Promise<number | null> {
  if (depth > 32) return null;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const timestamp = entry.isDirectory()
      ? await newestMtimeWithin(path, depth + 1)
      : entry.isFile()
        ? await tryMtime(path)
        : null;
    if (timestamp !== null && (newest === null || timestamp > newest)) newest = timestamp;
  }
  return newest;
}

// Remote freshness evidence: when this clone last heard from its remote.
// FETCH_HEAD is per worktree, so both the shared and the worktree copy count.
// Without one, the newest remote-tracking ref (loose or packed) stands in.
async function remoteFetchedAtMs(
  workspacePath: string,
  remote: string,
): Promise<number | null> {
  const remotes = await tryGit(workspacePath, ["remote"]);
  if (!remotes?.split("\n").some((name) => name.trim() === remote)) return null;
  const commonDirectory = await tryGit(workspacePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!commonDirectory) return null;
  const worktreeFetchHead = await tryGit(workspacePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "FETCH_HEAD",
  ]);
  const fetchHeads = (
    await Promise.all([
      tryMtime(resolve(commonDirectory, "FETCH_HEAD")),
      worktreeFetchHead ? tryMtime(worktreeFetchHead) : Promise.resolve(null),
    ])
  ).filter((timestamp): timestamp is number => timestamp !== null);
  if (fetchHeads.length > 0) return Math.max(...fetchHeads);

  const packedRefsPath = resolve(commonDirectory, "packed-refs");
  const packedRefs = await readFile(packedRefsPath, "utf8").catch(() => "");
  const fallbacks = (
    await Promise.all([
      newestMtimeWithin(resolve(commonDirectory, "refs", "remotes", remote)),
      packedRefs.includes(` refs/remotes/${remote}/`)
        ? tryMtime(packedRefsPath)
        : Promise.resolve(null),
    ])
  ).filter((timestamp): timestamp is number => timestamp !== null);
  return fallbacks.length > 0 ? Math.max(...fallbacks) : null;
}

// The only network call VibeVac makes, and only on explicit request: ask the
// remote for the upstream branch and compare it with the local tracking ref.
async function verifyUpstreamWithRemote(
  workspacePath: string,
  upstream: string | null,
): Promise<RemoteVerification> {
  const separator = upstream?.indexOf("/") ?? -1;
  if (!upstream || separator <= 0) return "skipped";
  const remote = upstream.slice(0, separator);
  const branchRef = `refs/heads/${upstream.slice(separator + 1)}`;
  const localHead = await tryGit(workspacePath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${upstream}`,
  ]);
  if (!localHead) return "skipped";

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "ls-remote", "--exit-code", "--heads", remote, branchRef],
      {
        encoding: "utf8",
        timeout: REMOTE_VERIFY_TIMEOUT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
    );
    const remoteHead = stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([, ref]) => ref === branchRef)?.[0];
    return remoteHead === localHead ? "verified" : "mismatch";
  } catch (error) {
    // Exit code 2: the remote answered and the branch no longer exists there.
    return typeof error === "object" && error !== null && "code" in error && error.code === 2
      ? "mismatch"
      : "unavailable";
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

export async function inspectGit(
  workspacePath: string,
  options: InspectGitOptions = {},
): Promise<GitInspection> {
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
  const fetchedAtMs = await remoteFetchedAtMs(workspacePath, remoteNameFor(upstream));
  const now = options.now ?? Date.now();

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
    remoteFetchedAt: fetchedAtMs !== null ? new Date(fetchedAtMs).toISOString() : null,
    remoteFetchAgeDays:
      fetchedAtMs !== null ? Math.max(0, Math.floor((now - fetchedAtMs) / DAY_IN_MS)) : null,
    remoteVerification: options.verifyRemote
      ? await verifyUpstreamWithRemote(workspacePath, upstream)
      : "skipped",
  };
}
