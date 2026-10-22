import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const conformanceDirectory = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_COMMIT_DATE = "2026-01-01T00:00:00.000Z";

// Git must not read the developer's ~/.gitconfig or /etc/gitconfig: a global
// excludesFile or hook would change what both engines see. The runner applies
// the same isolation to the engines themselves.
export const ISOLATED_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
} as const;

/** One ordered fixture step. Paths are relative to the fixture root. */
export type FixtureStep =
  | { write: Record<string, string> }
  | { mkdir: string[] }
  | { symlink: { path: string; target: string } }
  /** `{root}` in an argument is replaced by the absolute fixture root. */
  | { git: string[]; cwd?: string; at?: string };

export interface ExpectedReport {
  recommendation: "candidate" | "keep" | "review" | "protect";
  dataSafety: "recoverable" | "local-only" | "unknown";
  reasons: string[];
  git: {
    kind: "linked-worktree" | "standalone-repository";
    dirtyEntries: number;
    mergedIntoDefault: boolean | null;
  } | null;
  cacheCleanupAllowed: boolean;
  cacheCleanupReason: string | null;
  /** Inventoried cache relativePaths, sorted. */
  caches: string[];
  cleanup?: { ok: true; relativePaths: string[] } | { ok: false; error: string };
}

/**
 * A documented, non-safety disagreement. The runner asserts that `engine`
 * still produces `actual` at `field`, so fixing the divergence fails the case
 * until this entry is removed.
 */
export interface KnownDivergence {
  engine: "typescript" | "rust";
  field: string;
  actual: unknown;
  reason: string;
}

export interface ConformanceCase {
  name: string;
  description: string;
  /** Name of a file in test/conformance/bases whose steps run first. */
  base?: string;
  commitDate?: string;
  steps: FixtureStep[];
  /** Scanned workspace, relative to the fixture root. */
  workspace: string;
  /** mtime applied to the workspace directory and its Git index. Defaults to commitDate. */
  activityAt?: string;
  /**
   * mtime applied to every FETCH_HEAD a `git fetch` step wrote (the remote
   * freshness evidence). Defaults to `now`, i.e. "fetched today".
   */
  fetchedAt?: string;
  /** Working directories of running processes, relative to the root. null = check unavailable. */
  processes: string[] | null;
  now: string;
  staleAfterDays: number;
  cleanupSelection?: string[];
  expected: ExpectedReport;
  knownDivergences?: KnownDivergence[];
}

export interface BuiltFixture {
  root: string;
  workspacePath: string;
  workingDirectories: string[] | null;
}

interface FixtureBase {
  description: string;
  steps: FixtureStep[];
}

export async function loadCases(): Promise<ConformanceCase[]> {
  const casesDirectory = resolve(conformanceDirectory, "cases");
  const files = (await readdir(casesDirectory)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (file) =>
      JSON.parse(await readFile(resolve(casesDirectory, file), "utf8")) as ConformanceCase,
    ),
  );
}

async function loadBase(name: string): Promise<FixtureBase> {
  return JSON.parse(
    await readFile(resolve(conformanceDirectory, "bases", `${name}.json`), "utf8"),
  ) as FixtureBase;
}

function inside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`Fixture paths must be relative: ${relativePath}`);
  }
  return resolve(root, relativePath);
}

async function git(root: string, step: Extract<FixtureStep, { git: string[] }>, commitDate: string): Promise<void> {
  const date = step.at ?? commitDate;
  const args = step.git.map((argument) => argument.replaceAll("{root}", root));
  try {
    await execFileAsync("git", args, {
      cwd: inside(root, step.cwd ?? "."),
      encoding: "utf8",
      env: {
        ...process.env,
        ...ISOLATED_GIT_ENV,
        // `git commit` otherwise detaches `git maintenance run --auto`, which
        // can repack refs after pinRemoteEvidence has pinned their mtimes.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "maintenance.auto",
        GIT_CONFIG_VALUE_0: "false",
        GIT_AUTHOR_NAME: "VibeVac Conformance",
        GIT_AUTHOR_EMAIL: "conformance@vibevac.test",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "VibeVac Conformance",
        GIT_COMMITTER_EMAIL: "conformance@vibevac.test",
        GIT_COMMITTER_DATE: date,
      },
    });
  } catch (error) {
    throw new Error(`Fixture step failed: git ${args.join(" ")}\n${String(error)}`);
  }
}

async function runStep(root: string, step: FixtureStep, commitDate: string): Promise<void> {
  if ("write" in step) {
    for (const [path, contents] of Object.entries(step.write)) {
      const target = inside(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
  } else if ("mkdir" in step) {
    for (const path of step.mkdir) {
      await mkdir(inside(root, path), { recursive: true });
    }
  } else if ("symlink" in step) {
    const linkPath = inside(root, step.symlink.path);
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(step.symlink.target, linkPath);
  } else {
    await git(root, step, commitDate);
  }
}

// lastActivityAt is the newest of the workspace directory mtime, its Git index
// mtime and the last commit time. Pin the first two so the fake clock decides.
async function pinActivity(workspacePath: string, activityAt: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--git-path", "index"], {
    encoding: "utf8",
    env: { ...process.env, ...ISOLATED_GIT_ENV, GIT_OPTIONAL_LOCKS: "0" },
  });
  const indexPath = resolve(workspacePath, stdout.trim());
  const time = new Date(activityAt);
  await utimes(indexPath, time, time);
  await utimes(workspacePath, time, time);
}

// Missing files are fine: not every fixture fetched or has remote refs.
async function pinTime(path: string, time: Date): Promise<void> {
  await utimes(path, time, time).catch(() => undefined);
}

async function pinTreeTimes(directory: string, time: Date): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await pinTreeTimes(path, time);
    else await pinTime(path, time);
  }
}

// Remote freshness evidence is the newest FETCH_HEAD (shared or per worktree),
// or without one the newest remote-tracking ref. Git writes both with the real
// clock, which is months after the fake one, so a push alone would look like a
// fetch "in the future" and pass the 7-day rule by accident. Pin FETCH_HEAD to
// fetchedAt and the remote-tracking refs to the commit date.
async function pinRemoteEvidence(
  workspacePath: string,
  fetchedAt: string,
  refsAt: string,
): Promise<void> {
  const gitPath = async (args: string[]) =>
    (
      await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--path-format=absolute", ...args], {
        encoding: "utf8",
        env: { ...process.env, ...ISOLATED_GIT_ENV, GIT_OPTIONAL_LOCKS: "0" },
      })
    ).stdout.trim();
  const commonDirectory = await gitPath(["--git-common-dir"]);
  const fetchTime = new Date(fetchedAt);
  await pinTime(resolve(commonDirectory, "FETCH_HEAD"), fetchTime);
  await pinTime(await gitPath(["--git-path", "FETCH_HEAD"]), fetchTime);
  const refsTime = new Date(refsAt);
  await pinTreeTimes(resolve(commonDirectory, "refs", "remotes"), refsTime);
  await pinTime(resolve(commonDirectory, "packed-refs"), refsTime);
}

/** Materialises a case into a fresh temporary directory. */
export async function buildFixture(testCase: ConformanceCase): Promise<BuiltFixture> {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "vibevac-conformance-")));
  const commitDate = testCase.commitDate ?? DEFAULT_COMMIT_DATE;
  const steps = [
    ...(testCase.base ? (await loadBase(testCase.base)).steps : []),
    ...testCase.steps,
  ];
  for (const step of steps) {
    await runStep(root, step, commitDate);
  }

  const workspacePath = inside(root, testCase.workspace);
  await pinActivity(workspacePath, testCase.activityAt ?? commitDate);
  await pinRemoteEvidence(workspacePath, testCase.fetchedAt ?? testCase.now, commitDate);

  return {
    root,
    workspacePath,
    workingDirectories:
      testCase.processes === null
        ? null
        : testCase.processes.map((directory) => inside(root, directory)),
  };
}
