import { execFile } from "node:child_process";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
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
const MAX_DEPTH = 8;
const XCODE_CACHE_NAMES = new Set([
  "Intermediates.noindex", "ModuleCache.noindex", "Index.noindex",
  "CompilationCache.noindex", "SDKStatCaches.noindex",
]);
for (const name of XCODE_CACHE_NAMES) {
  CACHE_DEFINITIONS.set(name, {
    kind: "tool-cache",
    name: `Xcode ${name.replace(".noindex", "")} cache`,
    rebuildHint: "Xcode recreates this compiler cache on the next build. Release archives and Products are retained.",
  });
}

function isProtectedArtifact(name: string): boolean {
  return name === ".git" || name === "Products" ||
    [".xcarchive", ".xcresult", ".dSYM", ".ipa"].some((suffix) => name.endsWith(suffix));
}

async function isXcodeRoot(path: string): Promise<boolean> {
  try {
    const marker = resolve(path, "info.plist");
    const stat = await lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) return false;
    const info = await readFile(marker, "utf8");
    return info.includes("<key>WorkspacePath</key>") &&
      (info.includes(".xcworkspace</string>") || info.includes(".xcodeproj</string>"));
  } catch { return false; }
}

async function isXcodeCache(path: string): Promise<boolean> {
  const parent = dirname(path);
  if (basename(path) === "Intermediates.noindex" && basename(parent) !== "Build") return false;
  const root = basename(path) === "Intermediates.noindex" && basename(parent) === "Build"
    ? dirname(parent) : parent;
  return isXcodeRoot(root);
}

// Broad build directories may mix throwaway caches with irreplaceable release
// symbols or nested repositories. Unknown/oversized inspection fails closed.
async function containsProtectedContent(path: string): Promise<boolean> {
  let remaining = 2_000;
  async function visit(directory: string, depth: number): Promise<boolean> {
    if (depth > MAX_DEPTH || --remaining < 0 || await isXcodeRoot(directory)) return true;
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (--remaining < 0 || isProtectedArtifact(entry.name)) return true;
        if (entry.isDirectory() && !entry.isSymbolicLink() && await visit(resolve(directory, entry.name), depth + 1)) return true;
      }
      return false;
    } catch { return true; }
  }
  return visit(path, 0);
}

async function containsTrackedFiles(workspacePath: string, relativePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspacePath, "ls-files", "--", relativePath], {
      encoding: "utf8", maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout.length > 0;
  } catch { return true; }
}

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
        if (isProtectedArtifact(entry.name) || await exists(resolve(absolutePath, ".git"))) return;
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
          if (XCODE_CACHE_NAMES.has(entry.name) && !(await isXcodeCache(absolutePath))) return;
          if (await containsTrackedFiles(workspacePath, relativePath) ||
              (definition.kind === "build-output" && await containsProtectedContent(absolutePath))) {
            if (depth < MAX_DEPTH) await visit(absolutePath, depth + 1);
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
