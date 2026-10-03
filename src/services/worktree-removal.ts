import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, lstat, mkdir, readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  WorktreeRemovalPlan,
  WorktreeRemovalResult,
} from "../domain/types.js";
import {
  countProcessesWithin,
  inspectActiveProcesses,
  type ActiveProcessSnapshot,
} from "./active-processes.js";
import { inventoryRebuildableCaches } from "./cache-inventory.js";
import { classifyWorkspace } from "./classifier.js";
import { diskUsageBytes } from "./disk-usage.js";
import { inspectGit } from "./git-inspector.js";

const execFileAsync = promisify(execFile);
const DAY_IN_MS = 86_400_000;
const REBUILDABLE_IGNORED_FILES = new Set([
  ".eslintcache",
  ".stylelintcache",
  "next-env.d.ts",
]);

export interface WorktreeRemovalRequest {
  force?: boolean;
  reviewedHead?: string;
  reviewedWarnings?: string[];
  reviewedIgnoredFingerprint?: string;
  workspacePath: string;
  minimumInactiveDays: number;
  confirmation?: string;
}

interface WorktreeRemovalOptions {
  processSnapshot?: ActiveProcessSnapshot;
  auditPath?: string;
  now?: number;
}

async function runGit(workspacePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", workspacePath, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return args.includes("-z") ? stdout : stdout.trim();
}

function confirmationFor(workspacePath: string, force: boolean): string {
  const segments = workspacePath.split(sep).filter(Boolean);
  return `${force ? "FORCE " : ""}REMOVE ${segments.slice(-2).join("/")}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isNestedPath(parentPath: string, childPath: string): boolean {
  const nested = relative(parentPath, childPath);
  return (
    nested.length > 0 &&
    nested !== ".." &&
    !nested.startsWith(`..${sep}`) &&
    !resolve(childPath).startsWith(`${resolve(parentPath)}${sep}..${sep}`)
  );
}

async function checkNestedGit(root: string): Promise<void> {
  const pending = [{ path: root, depth: 0 }];
  let remaining = 200_000;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if (directory.depth > 64) throw new Error("Worktree inspection limit exceeded; removal is protected");
    const entries = await readdir(directory.path, { withFileTypes: true });
    for (const entry of entries) {
      if (--remaining < 0) throw new Error("Worktree inspection limit exceeded; removal is protected");
      if (entry.name === ".git") {
        if (directory.path !== root) throw new Error("The worktree contains a nested Git repository or checkout; handle it separately before removal");
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push({ path: resolve(directory.path, entry.name), depth: directory.depth + 1 });
      }
    }
  }
}

async function ignoredFingerprint(workspacePath: string, entries: string[]): Promise<string> {
  const fingerprint = createHash("sha256");
  for (const entry of entries.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const path = resolve(workspacePath, entry);
    const metadata = await lstat(path);
    const contents = createHash("sha256");
    if (metadata.isSymbolicLink()) contents.update(await readlink(path, { encoding: "buffer" }));
    else if (metadata.isFile()) {
      for await (const chunk of createReadStream(path)) contents.update(chunk);
    } else throw new Error("Ignored data could not be inspected; removal is protected");
    fingerprint.update(`${entry}\0${metadata.isSymbolicLink() ? "symlink" : "file"}\0${contents.digest("hex")}\0`);
  }
  return fingerprint.digest("hex");
}

async function unknownIgnoredEntries(
  workspacePath: string,
  rebuildablePaths: string[],
): Promise<string[]> {
  const output = await runGit(workspacePath, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  const ignored = output
    .split("\0")
    .map((entry) => entry.replace(/\/$/, ""))
    .filter(Boolean);

  return ignored.filter(
    (entry) => {
      const fileName = entry.split("/").at(-1) ?? entry;
      const isKnownGeneratedFile =
        REBUILDABLE_IGNORED_FILES.has(fileName) || fileName.endsWith(".tsbuildinfo");
      return (
        !isKnownGeneratedFile &&
        !rebuildablePaths.some(
        (cachePath) => entry === cachePath || entry.startsWith(`${cachePath}/`),
        )
      );
    },
  );
}

export async function planWorktreeRemoval(
  request: WorktreeRemovalRequest,
  options: WorktreeRemovalOptions = {},
): Promise<WorktreeRemovalPlan> {
  if (request.force !== undefined && typeof request.force !== "boolean") {
    throw new Error("Force removal must be explicitly true or false");
  }
  const force = request.force === true;
  if (
    !Number.isInteger(request.minimumInactiveDays) ||
    request.minimumInactiveDays < (force ? 0 : 1) ||
    request.minimumInactiveDays > 3650
  ) {
    throw new Error("Worktree inactivity threshold must be between 1 and 3650 days, or 0 with explicit override");
  }

  const workspacePath = await realpath(resolve(request.workspacePath));
  const git = await inspectGit(workspacePath);
  if (git.kind !== "linked-worktree") {
    throw new Error("Only registered linked Git worktrees can be removed");
  }
  const registeredPaths = (await runGit(workspacePath, ["worktree", "list", "--porcelain", "-z"]))
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice(9));
  const registered = await Promise.all(registeredPaths.map((path) => realpath(path).catch(() => null)));
  if (!registered.includes(workspacePath)) throw new Error("The target is not a registered Git worktree");
  if (registered.some((path) => path !== null && isNestedPath(workspacePath, path))) {
    throw new Error("A nested registered worktree must be handled separately before removing its parent");
  }
  await checkNestedGit(workspacePath);

  const processes = options.processSnapshot ?? (await inspectActiveProcesses());
  const activeProcessCount = countProcessesWithin(processes, workspacePath);
  const now = options.now ?? Date.now();
  const classification = classifyWorkspace(git, {
    activeProcessCount,
    staleAfterDays: request.minimumInactiveDays,
    now,
  });
  if (!force && classification.recommendation !== "candidate") {
    throw new Error(`Worktree removal blocked: ${classification.reasons.join("; ")}`);
  }

  const branch = git.branch;
  const upstream = git.upstream;
  const defaultBranch = git.defaultBranch;
  const lastActivityAt = git.lastActivityAt;
  if (!branch) {
    throw new Error("An attached worktree branch is required to preserve Git history");
  }
  if (!force && (!upstream || !defaultBranch || !lastActivityAt)) {
    throw new Error("Worktree removal proof is incomplete");
  }

  const inactiveDays = lastActivityAt
    ? Math.max(0, Math.floor((now - Date.parse(lastActivityAt)) / DAY_IN_MS))
    : null;
  const warnings: string[] = [];
  if (git.dirtyEntries > 0) warnings.push(`${git.dirtyEntries} uncommitted entries will be permanently deleted.`);
  if (!upstream) warnings.push("No upstream branch is configured.");
  if (git.ahead === null) warnings.push("Upstream synchronization is unproven.");
  else if (git.ahead > 0) warnings.push(`${git.ahead} unpublished commits remain only in the shared Git repository.`);
  if (!git.remoteContainsHead) warnings.push("Current commit recovery from a remote is unproven.");
  if (git.mergedIntoDefault !== true) warnings.push("Current commit is not proven merged into the default branch.");
  if (activeProcessCount === null) warnings.push("Active-process inspection is unavailable; running tasks may break.");
  else if (activeProcessCount > 0) warnings.push(`${activeProcessCount} running processes use this worktree and may break. They will not be stopped.`);
  if (request.minimumInactiveDays > 0 && (inactiveDays === null || inactiveDays < request.minimumInactiveDays)) warnings.push(`The worktree does not meet the ${request.minimumInactiveDays}-day inactivity limit.`);

  const caches = await inventoryRebuildableCaches(workspacePath);
  const unknownIgnored = await unknownIgnoredEntries(
    workspacePath,
    caches.map((cache) => cache.relativePath),
  );
  if (unknownIgnored.length > 0) {
    const preview = unknownIgnored.slice(0, 3).join(", ");
    const reason = `Worktree contains ignored data outside the rebuildable allowlist: ${preview}${
        unknownIgnored.length > 3 ? ` and ${unknownIgnored.length - 3} more` : ""
      }`;
    if (!force) throw new Error(reason);
    warnings.push(`${reason}. These files will be permanently deleted.`);
  }

  const rawCommonGitDirectory = await runGit(workspacePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const commonGitDirectory = await realpath(
    resolve(workspacePath, rawCommonGitDirectory),
  );
  if (
    commonGitDirectory === workspacePath ||
    isNestedPath(workspacePath, commonGitDirectory)
  ) {
    throw new Error("Worktree Git history is stored inside the removal target");
  }

  const reconstructionCommand = `git --git-dir=${shellQuote(
    commonGitDirectory,
  )} worktree add ${shellQuote(workspacePath)} ${shellQuote(branch)}`;

  return {
    force,
    warnings: force ? warnings : [],
    ignoredFingerprint: await ignoredFingerprint(workspacePath, unknownIgnored),
    workspacePath,
    sizeBytes: await diskUsageBytes(workspacePath),
    branch,
    head: git.head,
    upstream,
    defaultBranch,
    lastActivityAt,
    inactiveDays,
    commonGitDirectory,
    reconstructionCommand,
    confirmation: confirmationFor(workspacePath, force),
  };
}

export async function executeWorktreeRemoval(
  request: WorktreeRemovalRequest,
  options: WorktreeRemovalOptions = {},
): Promise<WorktreeRemovalResult> {
  const plan = await planWorktreeRemoval(request, options);
  if (request.confirmation !== plan.confirmation) {
    throw new Error("Confirmation text does not match the revalidated worktree plan");
  }
  if (plan.force && (request.reviewedHead !== plan.head ||
      JSON.stringify(request.reviewedWarnings) !== JSON.stringify(plan.warnings) ||
      request.reviewedIgnoredFingerprint !== plan.ignoredFingerprint)) {
    throw new Error("Force removal risks changed or were not reviewed; prepare a fresh preview");
  }

  const auditPath = options.auditPath ?? resolve(homedir(), ".vibevac/audit.jsonl");
  await mkdir(dirname(auditPath), { recursive: true });
  const completedAt = new Date().toISOString();

  try {
    await execFileAsync(
      "git",
      [
        `--git-dir=${plan.commonGitDirectory}`,
        "worktree",
        "remove",
        "--force",
        plan.workspacePath,
      ],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (error) {
    await appendFile(
      auditPath,
      `${JSON.stringify({
        version: 1,
        action: "worktree-removal-failed",
        completedAt: new Date().toISOString(),
        workspacePath: plan.workspacePath,
        preservedBranch: plan.branch,
        force: plan.force,
        warnings: plan.warnings,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
      "utf8",
    );
    throw error;
  }

  await appendFile(
    auditPath,
    `${JSON.stringify({
      version: 1,
      action: "worktree-removal",
      completedAt,
      workspacePath: plan.workspacePath,
      reclaimedBytes: plan.sizeBytes,
      preservedBranch: plan.branch,
      force: plan.force,
      warnings: plan.warnings,
      head: plan.head,
      upstream: plan.upstream,
      reconstructionCommand: plan.reconstructionCommand,
    })}\n`,
    "utf8",
  );

  return {
    workspacePath: plan.workspacePath,
    reclaimedBytes: plan.sizeBytes,
    preservedBranch: plan.branch,
    reconstructionCommand: plan.reconstructionCommand,
    completedAt,
    auditPath,
  };
}
