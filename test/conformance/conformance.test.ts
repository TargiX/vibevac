// Cross-engine conformance suite (docs/roadmap.md 0.3.1). Every case in
// ./cases is materialised once and scanned by both the TypeScript engine
// (src/services) and the Rust engine (src-tauri/src/core.rs) with the same
// injected process snapshot and clock. Each engine must match the case's
// expected fields, and the two engines must match each other.
//
// VIBEVAC_CONFORMANCE_RUST=require  fail instead of skipping the Rust half (CI)
// VIBEVAC_CONFORMANCE_RUST=skip     run the TypeScript half only
// VIBEVAC_CONFORMANCE_KEEP=1        keep fixture directories for debugging

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { WorkspaceReport } from "../../src/domain/types.js";
import type { ActiveProcessSnapshot } from "../../src/services/active-processes.js";
import { planCacheCleanup } from "../../src/services/cache-cleanup.js";
import { scanWorkspacePath } from "../../src/services/scanner.js";
import {
  buildFixture,
  ISOLATED_GIT_ENV,
  loadCases,
  type BuiltFixture,
  type ConformanceCase,
} from "./build-fixture.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = resolve(repositoryRoot, "src-tauri/Cargo.toml");
const cases = await loadCases();
const rustMode = process.env.VIBEVAC_CONFORMANCE_RUST ?? "auto";

type Engine = "typescript" | "rust";
type CleanupOutcome = { ok: true; relativePaths: string[] } | { ok: false; error: string };
interface EngineOutput {
  report: WorkspaceReport;
  cleanup: CleanupOutcome | null;
}

function rustUnavailableReason(): string | null {
  if (rustMode === "skip") return "VIBEVAC_CONFORMANCE_RUST=skip";
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
  } catch {
    return "cargo is not on PATH";
  }
  // tauri::generate_context! embeds the built UI, so the crate does not
  // compile until `pnpm build:ui` has produced dist/ui.
  if (!existsSync(resolve(repositoryRoot, "dist/ui/index.html"))) {
    return "dist/ui is missing; run `pnpm build:ui` first";
  }
  return null;
}

const rustSkipReason = rustUnavailableReason();
if (rustSkipReason && rustMode === "require") {
  throw new Error(`Rust conformance is required but unavailable: ${rustSkipReason}`);
}
if (rustSkipReason) {
  console.warn(
    `[conformance] Skipping the Rust engine (${rustSkipReason}). Only the TypeScript engine is checked; CI runs both.`,
  );
}

const fixtures: BuiltFixture[] = [];
const savedEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  // The TypeScript engine runs in this process and spawns git with
  // process.env, so isolate it from the developer's Git config here.
  for (const [key, value] of Object.entries(ISOLATED_GIT_ENV)) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  if (!rustSkipReason) {
    await execFileAsync(
      "cargo",
      ["build", "--quiet", "--manifest-path", manifestPath, "--bin", "conformance"],
      { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 },
    );
  }
}, 20 * 60_000);

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (process.env.VIBEVAC_CONFORMANCE_KEEP === "1") {
    console.warn(`[conformance] Kept fixtures:\n${fixtures.map((fixture) => fixture.root).join("\n")}`);
    return;
  }
  await Promise.all(fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

function processSnapshot(workingDirectories: string[] | null): ActiveProcessSnapshot {
  if (workingDirectories === null) {
    return {
      available: false,
      workingDirectories: new Map(),
      error: "process check disabled by fixture",
    };
  }
  const counts = new Map<string, number>();
  for (const directory of workingDirectories) {
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return { available: true, workingDirectories: counts, error: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runTypeScript(testCase: ConformanceCase, fixture: BuiltFixture): Promise<EngineOutput> {
  const snapshot = processSnapshot(fixture.workingDirectories);
  const report = await scanWorkspacePath(fixture.workspacePath, {
    processSnapshot: snapshot,
    now: Date.parse(testCase.now),
    staleAfterDays: testCase.staleAfterDays,
  });
  let cleanup: CleanupOutcome | null = null;
  if (testCase.cleanupSelection) {
    try {
      const plan = await planCacheCleanup(fixture.workspacePath, testCase.cleanupSelection, {
        processSnapshot: snapshot,
      });
      cleanup = { ok: true, relativePaths: plan.caches.map((cache) => cache.relativePath) };
    } catch (error) {
      cleanup = { ok: false, error: errorMessage(error) };
    }
  }
  return { report, cleanup };
}

async function runRust(testCase: ConformanceCase, fixture: BuiltFixture): Promise<EngineOutput> {
  const input = JSON.stringify({
    workspacePath: fixture.workspacePath,
    workingDirectories: fixture.workingDirectories,
    nowIso: testCase.now,
    staleAfterDays: testCase.staleAfterDays,
    cleanupSelection: testCase.cleanupSelection ?? null,
  });
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = execFile(
      "cargo",
      ["run", "--quiet", "--manifest-path", manifestPath, "--bin", "conformance"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...ISOLATED_GIT_ENV },
      },
      (error, output, stderr) => {
        if (error) reject(new Error(`Rust conformance binary failed: ${stderr || error.message}`));
        else resolvePromise(output);
      },
    );
    child.stdin?.end(input);
  });
  return JSON.parse(stdout) as EngineOutput;
}

// Everything the engines must agree on, with sizes and absolute paths removed.
function normalise(output: EngineOutput, fixture: BuiltFixture) {
  const { report } = output;
  const relativeToRoot = (value: string) => value.replaceAll(fixture.root, "<root>");
  return {
    tool: report.tool,
    path: relativeToRoot(report.path),
    recommendation: report.recommendation,
    dataSafety: report.dataSafety,
    reasons: report.reasons,
    git: report.git && {
      kind: report.git.kind,
      branch: report.git.branch,
      head: report.git.head,
      upstream: report.git.upstream,
      ahead: report.git.ahead,
      behind: report.git.behind,
      dirtyEntries: report.git.dirtyEntries,
      untrackedEntries: report.git.untrackedEntries,
      remoteContainsHead: report.git.remoteContainsHead,
      defaultBranch: report.git.defaultBranch,
      mergedIntoDefault: report.git.mergedIntoDefault,
      lastCommitAt: report.git.lastCommitAt,
      lastActivityAt: report.git.lastActivityAt,
    },
    inspectionFailed: report.inspectionError !== null,
    activeProcessCount: report.activeProcessCount,
    caches: report.caches
      .map((cache) => ({
        relativePath: cache.relativePath,
        path: relativeToRoot(cache.path),
        kind: cache.kind,
        name: cache.name,
        rebuildHint: cache.rebuildHint,
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    cacheCleanupAllowed: report.cacheCleanupAllowed,
    cacheCleanupReason: report.cacheCleanupReason,
    cacheInventoryFailed: report.cacheInspectionError !== null,
    cleanup: output.cleanup,
  };
}

type Normalised = ReturnType<typeof normalise>;

// Asserts each documented divergence is still present for this engine, then
// replaces it with the expected value so the remaining checks cover the rest.
function applyKnownDivergences(
  engine: Engine,
  normalised: Normalised,
  testCase: ConformanceCase,
): Normalised {
  const patched = structuredClone(normalised) as Record<string, unknown>;
  for (const divergence of testCase.knownDivergences ?? []) {
    if (divergence.engine !== engine) continue;
    const path = divergence.field.split(".");
    let container = patched;
    for (const key of path.slice(0, -1)) container = container[key] as Record<string, unknown>;
    const leaf = path.at(-1) as string;
    expect(
      container[leaf],
      `${engine}: known divergence "${divergence.field}" is resolved; remove it from the case`,
    ).toEqual(divergence.actual);
    let expectedContainer = testCase.expected as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) {
      expectedContainer = expectedContainer[key] as Record<string, unknown>;
    }
    if (!(leaf in expectedContainer)) {
      throw new Error(`Known divergence field "${divergence.field}" must also be in expected`);
    }
    container[leaf] = expectedContainer[leaf];
  }
  return patched as Normalised;
}

function assertExpected(engine: Engine, normalised: Normalised, testCase: ConformanceCase): void {
  const { expected } = testCase;
  expect(
    {
      recommendation: normalised.recommendation,
      dataSafety: normalised.dataSafety,
      reasons: normalised.reasons,
      git: normalised.git && {
        kind: normalised.git.kind,
        dirtyEntries: normalised.git.dirtyEntries,
        mergedIntoDefault: normalised.git.mergedIntoDefault,
      },
      cacheCleanupAllowed: normalised.cacheCleanupAllowed,
      cacheCleanupReason: normalised.cacheCleanupReason,
      caches: normalised.caches.map((cache) => cache.relativePath),
      ...(expected.cleanup ? { cleanup: normalised.cleanup } : {}),
    },
    `${engine} engine disagrees with the expected report`,
  ).toEqual(expected);
}

describe("engine conformance", () => {
  it("has at least one case", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const fixture = await buildFixture(testCase);
      fixtures.push(fixture);

      const typescript = applyKnownDivergences(
        "typescript",
        normalise(await runTypeScript(testCase, fixture), fixture),
        testCase,
      );
      assertExpected("typescript", typescript, testCase);

      if (rustSkipReason) return;
      const rust = applyKnownDivergences(
        "rust",
        normalise(await runRust(testCase, fixture), fixture),
        testCase,
      );
      assertExpected("rust", rust, testCase);
      expect(rust, "TypeScript and Rust engines disagree").toEqual(typescript);
    }, 120_000);
  }
});
