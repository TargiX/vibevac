import { execFile } from "node:child_process";
import { appendFile, mkdir, realpath } from "node:fs/promises";
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
  return stdout.trim();
}

function confirmationFor(workspacePath: string): string {
  const segments = workspacePath.split(sep).filter(Boolean);
  return `REMOVE ${segments.slice(-2).join("/")}`;
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

async function unknownIgnoredEntries(
  workspacePath: string,
  rebuildablePaths: string[],
): Promise<string[]> {
  const output = await runGit(workspacePath, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
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
  if (
    !Number.isInteger(request.minimumInactiveDays) ||
    request.minimumInactiveDays < 1 ||
    request.minimumInactiveDays > 3650
  ) {
    throw new Error("Worktree inactivity threshold must be between 1 and 3650 days");
  }

  const workspacePath = await realpath(resolve(request.workspacePath));
  const git = await inspectGit(workspacePath);
  if (git.kind !== "linked-worktree") {
    throw new Error("Only registered linked Git worktrees can be removed");
  }

  const processes = options.processSnapshot ?? (await inspectActiveProcesses());
  const activeProcessCount = countProcessesWithin(processes, workspacePath);
  const now = options.now ?? Date.now();
  const classification = classifyWorkspace(git, {
    activeProcessCount,
    staleAfterDays: request.minimumInactiveDays,
    now,
  });
  if (classification.recommendation !== "candidate") {
    throw new Error(`Worktree removal blocked: ${classification.reasons.join("; ")}`);
  }

  const branch = git.branch;
  const upstream = git.upstream;
  const defaultBranch = git.defaultBranch;
  const lastActivityAt = git.lastActivityAt;
  if (!branch || !upstream || !defaultBranch || !lastActivityAt) {
    throw new Error("Worktree removal proof is incomplete");
  }

  const caches = await inventoryRebuildableCaches(workspacePath);
  const unknownIgnored = await unknownIgnoredEntries(
    workspacePath,
    caches.map((cache) => cache.relativePath),
  );
  if (unknownIgnored.length > 0) {
    const preview = unknownIgnored.slice(0, 3).join(", ");
    throw new Error(
      `Worktree contains ignored data outside the rebuildable allowlist: ${preview}${
        unknownIgnored.length > 3 ? ` and ${unknownIgnored.length - 3} more` : ""
      }`,
    );
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

  const inactiveDays = Math.max(
    0,
    Math.floor((now - Date.parse(lastActivityAt)) / DAY_IN_MS),
  );
  const reconstructionCommand = `git --git-dir=${shellQuote(
    commonGitDirectory,
  )} worktree add ${shellQuote(workspacePath)} ${shellQuote(branch)}`;

  return {
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
    confirmation: confirmationFor(workspacePath),
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
