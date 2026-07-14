import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { CacheEntry, CacheKind } from "../domain/types.js";
import { diskUsageBytes } from "./disk-usage.js";

const execFileAsync = promisify(execFile);

interface CacheDefinition {
  kind: CacheKind;
  name: string;
  rebuildHint: string;
  requiresNodeLockfile?: boolean;
}

const CACHE_DEFINITIONS = new Map<string, CacheDefinition>([
  [
    "node_modules",
    {
      kind: "dependencies",
      name: "Installed dependencies",
      rebuildHint: "Restore with the repository package-manager install command.",
      requiresNodeLockfile: true,
    },
  ],
  [
    ".nuxt",
    {
      kind: "framework-build",
      name: "Nuxt build cache",
      rebuildHint: "Nuxt recreates this directory on the next dev or build run.",
    },
  ],
  [
    ".next",
    {
      kind: "framework-build",
      name: "Next.js build cache",
      rebuildHint: "Next.js recreates this directory on the next dev or build run.",
    },
  ],
  [
    ".svelte-kit",
    {
      kind: "framework-build",
      name: "SvelteKit build cache",
      rebuildHint: "SvelteKit recreates this directory on the next dev or build run.",
    },
  ],
  [
    ".turbo",
    {
      kind: "tool-cache",
      name: "Turborepo cache",
      rebuildHint: "Turborepo recreates this cache as tasks run.",
    },
  ],
  [
    ".parcel-cache",
    {
      kind: "tool-cache",
      name: "Parcel cache",
      rebuildHint: "Parcel recreates this cache on the next build.",
    },
  ],
  [
    "dist",
    {
      kind: "build-output",
      name: "Build output",
      rebuildHint: "Recreate it with the repository build command.",
    },
  ],
  [
    "build",
    {
      kind: "build-output",
      name: "Build output",
      rebuildHint: "Recreate it with the repository build command.",
    },
  ],
  [
    "out",
    {
      kind: "build-output",
      name: "Export output",
      rebuildHint: "Recreate it with the repository export or build command.",
    },
  ],
  [
    "coverage",
    {
      kind: "test-output",
      name: "Coverage output",
      rebuildHint: "Recreate it by running the test coverage command.",
    },
  ],
  [
    "playwright-report",
    {
      kind: "test-output",
      name: "Playwright report",
      rebuildHint: "Recreate it by running the Playwright test suite.",
    },
  ],
  [
    "test-results",
    {
      kind: "test-output",
      name: "Test results",
      rebuildHint: "Recreate it by running the test suite.",
    },
  ],
]);

const NODE_LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

const SKIP_TRAVERSAL = new Set([".git", ".idea", ".vscode"]);
const MAX_DEPTH = 4;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasNodeLockfile(workspacePath: string): Promise<boolean> {
  const checks = await Promise.all(
    NODE_LOCKFILES.map((lockfile) => exists(resolve(workspacePath, lockfile))),
  );
  return checks.some(Boolean);
}

async function isIgnoredByGit(
  workspacePath: string,
  relativePath: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["-C", workspacePath, "check-ignore", "--quiet", "--", relativePath],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function inventoryRebuildableCaches(
  workspacePath: string,
): Promise<CacheEntry[]> {
  const candidates: Array<{ path: string; definition: CacheDefinition }> = [];
  const nodeLockfilePresent = await hasNodeLockfile(workspacePath);

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 0 && (await exists(resolve(directory, ".git")))) {
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          return;
        }

        const absolutePath = resolve(directory, entry.name);
        const definition = CACHE_DEFINITIONS.get(entry.name);
        if (definition) {
          if (definition.requiresNodeLockfile && !nodeLockfilePresent) {
            return;
          }
          const relativePath = relative(workspacePath, absolutePath);
          if (
            relativePath.startsWith(`..${sep}`) ||
            !(await isIgnoredByGit(workspacePath, relativePath))
          ) {
            return;
          }
          candidates.push({ path: absolutePath, definition });
          return;
        }

        if (depth < MAX_DEPTH && !SKIP_TRAVERSAL.has(entry.name)) {
          await visit(absolutePath, depth + 1);
        }
      }),
    );
  }

  await visit(workspacePath, 0);

  const caches = await Promise.all(
    candidates.map(async ({ path, definition }) => {
      const relativePath = relative(workspacePath, path);
      try {
        return {
          id: relativePath,
          path,
          relativePath,
          name: definition.name,
          kind: definition.kind,
          sizeBytes: await diskUsageBytes(path),
          sizeError: null,
          ignoredByGit: true as const,
          rebuildHint: definition.rebuildHint,
        };
      } catch (error) {
        return {
          id: relativePath,
          path,
          relativePath,
          name: definition.name,
          kind: definition.kind,
          sizeBytes: null,
          sizeError: errorMessage(error),
          ignoredByGit: true as const,
          rebuildHint: definition.rebuildHint,
        };
      }
    }),
  );

  return caches.sort((left, right) => (right.sizeBytes ?? -1) - (left.sizeBytes ?? -1));
}
