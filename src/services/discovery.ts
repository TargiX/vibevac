import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { existsSync } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type {
  DiscoveryRoot,
  WorkspaceCandidate,
  WorkspaceTool,
} from "../domain/types.js";

const execFileAsync = promisify(execFile);

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

export function defaultDiscoveryRoots(home = homedir()): DiscoveryRoot[] {
  const candidates: DiscoveryRoot[] = [
    { tool: "codex", path: resolve(home, ".codex/worktrees"), maxDepth: 3 },
    { tool: "conductor", path: resolve(home, "conductor/workspaces"), maxDepth: 3 },
    { tool: "projects", path: resolve(home, "Code"), maxDepth: 4 },
    { tool: "projects", path: resolve(home, "Developer"), maxDepth: 4 },
    { tool: "projects", path: resolve(home, "Projects"), maxDepth: 4 },
    { tool: "projects", path: resolve(home, "repos"), maxDepth: 4 },
    { tool: "projects", path: resolve(home, "src"), maxDepth: 4 },
    { tool: "projects", path: resolve(home, "workspace"), maxDepth: 4 },
    { tool: "projects", path: resolve(home, "workspaces"), maxDepth: 4 },
    { tool: "openclaw", path: resolve(home, ".openclaw/workspace"), maxDepth: 0 },
  ];

  return candidates.filter((root) => existsSync(root.path));
}

export function customDiscoveryRoots(paths: string[]): DiscoveryRoot[] {
  return paths.map((path) => ({
    tool: "custom",
    path: resolve(path),
    maxDepth: 4,
  }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function inferWorkspaceTool(
  path: string,
  branch: string | null,
  fallback: WorkspaceTool,
): WorkspaceTool {
  const normalizedPath = path.toLowerCase();
  const normalizedBranch = branch?.toLowerCase() ?? "";
  if (normalizedPath.includes("/.codex/worktrees/")) return "codex";
  if (normalizedPath.includes("/conductor/workspaces/")) return "conductor";
  if (normalizedPath.includes("/.claude/worktrees/") || normalizedBranch.includes("/claude/")) {
    return "claude";
  }
  if (normalizedPath.includes("/.cursor/") || normalizedBranch.includes("/cursor/")) {
    return "cursor";
  }
  if (normalizedPath.includes("/.hermes/") || normalizedBranch.includes("/hermes/")) {
    return "hermes";
  }
  if (
    normalizedPath.includes("/.gemini/") ||
    normalizedPath.includes("antigravity") ||
    normalizedBranch.includes("/antigravity/")
  ) {
    return "antigravity";
  }
  if (normalizedPath.includes("/.openclaw/")) return "openclaw";
  return fallback;
}

async function registeredWorktrees(
  repositoryPath: string,
  root: DiscoveryRoot,
): Promise<WorkspaceCandidate[]> {
  try {
    const repositoryRealPath = await realpath(repositoryPath).catch(() => resolve(repositoryPath));
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryPath, "worktree", "list", "--porcelain"],
      { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
    );
    const candidates: WorkspaceCandidate[] = [];
    let worktreePath: string | null = null;
    let branch: string | null = null;

    const append = async (): Promise<void> => {
      const resolvedWorktreePath = worktreePath
        ? await realpath(worktreePath).catch(() => resolve(worktreePath ?? ""))
        : null;
      if (
        resolvedWorktreePath &&
        resolvedWorktreePath !== repositoryRealPath &&
        (await exists(resolve(resolvedWorktreePath, ".git")))
      ) {
        candidates.push({
          tool: inferWorkspaceTool(resolvedWorktreePath, branch, root.tool),
          path: resolvedWorktreePath,
          sourcePath: root.path,
        });
      }
      worktreePath = null;
      branch = null;
    };

    for (const line of `${stdout}\n`.split("\n")) {
      if (line.length === 0) {
        await append();
      } else if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length);
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

async function discoverWithinRoot(root: DiscoveryRoot): Promise<WorkspaceCandidate[]> {
  if (!(await exists(root.path))) {
    return [];
  }

  const candidates: WorkspaceCandidate[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (await exists(resolve(directory, ".git"))) {
      const path = resolve(directory);
      candidates.push({ tool: root.tool, path, sourcePath: root.path });
      try {
        const gitMarker = await stat(resolve(path, ".git"));
        if (gitMarker.isDirectory()) {
          candidates.push(...(await registeredWorktrees(path, root)));
        }
      } catch {
        // The Git inspection phase will surface inaccessible markers.
      }
      return;
    }

    if (depth >= root.maxDepth) {
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            !SKIPPED_DIRECTORIES.has(entry.name),
        )
        .map((entry) => visit(resolve(directory, entry.name), depth + 1)),
    );
  }

  await visit(root.path, 0);
  return candidates;
}

export async function discoverWorkspaces(
  roots: DiscoveryRoot[],
): Promise<WorkspaceCandidate[]> {
  const discovered = (await Promise.all(roots.map(discoverWithinRoot))).flat();
  const unique = new Map<string, WorkspaceCandidate>();

  for (const candidate of discovered) {
    if (!unique.has(candidate.path)) unique.set(candidate.path, candidate);
  }

  return [...unique.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}
