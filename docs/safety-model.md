# Safety model

VibeVac treats cleanup eligibility as a proof obligation. Missing information is
never interpreted as permission to delete.

## Two independent questions

### 1. Is the data recoverable?

- `RECOVERABLE`: the workspace is a linked worktree, clean, and `HEAD` is
  available from an upstream or another remote-tracking ref with no unpushed
  commits.
- `LOCAL-ONLY`: modified/untracked data or commits exist only locally, or
  remote recovery cannot be proven.
- `UNKNOWN`: Git inspection was incomplete or the path is a standalone
  repository whose own Git database would be removed with the directory.

Recoverable does not mean unnecessary.

### 2. What should the user do?

#### `CANDIDATE`

Every condition must be true:

- data is recoverable;
- the path is a linked Git worktree;
- `HEAD` is attached to a branch;
- local remote-tracking refs prove `HEAD` is merged into the default branch;
- the latest worktree/index activity signal is at least 14 days old by default;
- `lsof` found no running process whose current working directory is inside
  the workspace.

This means “worth reviewing”, not “definitely unwanted”.

#### `KEEP`

The data is recoverable, but the workspace was used within the inactivity
threshold or a running process currently has a working directory inside it.
Recent activity takes precedence over detached or unmerged state.

#### `REVIEW`

The data is recoverable and stale, but VibeVac cannot prove one of the intent
signals: branch attachment, merge into the default branch, activity timestamp,
or active-process availability.

#### `PROTECT`

The workspace contains unique local data, is a standalone repository, or Git
inspection failed. A removal command must refuse to touch it.

## Evidence sources and limitations

- Git status and comparison commands run with `GIT_OPTIONAL_LOCKS=0` so the
  read-only scan does not refresh the index.
- Merge state comes from existing local remote-tracking refs. VibeVac does not
  contact GitHub or run `git fetch` during the default scan.
- Activity is the newest signal among the worktree directory, worktree Git
  index, and latest commit. It is evidence, not proof of human intent.
- Process detection uses `lsof` and can only observe processes visible to the
  current user. If it is unavailable, VibeVac produces no cleanup candidates.
- An IDE can keep a project conceptually open without using a process cwd inside
  it. This is why every candidate still requires a human decision.

## Desktop execution boundary

The installed app bundles the Vue interface and Rust engine in one Tauri
application. UI requests cross the application-local IPC boundary; the app does
not listen on an HTTP port and does not require Node.js at runtime.

Only narrow native commands are exposed to the UI: scan, preview and execute
selected cache cleanup, and preview and execute selected linked-worktree
removal. Arbitrary shell execution and arbitrary-path deletion are not IPC
capabilities. Cache cleanup accepts relative paths only by matching them against
a new verified inventory. Worktree removal accepts a canonical checkout path
only after Git proves that it is registered with a common repository elsewhere.

The optional development dashboard keeps its separate localhost session-token
and origin protections.

## Discovery scope

VibeVac never treats the home directory or whole disk as an implicit scan root.
It uses explicit Codex and Conductor roots, existing conventional project
folders under the home directory, and the OpenClaw workspace. Every other
source must be added by the user through the native directory picker or
supplied explicitly to the CLI.

Discovery is bounded by depth and stops when it finds a `.git` marker. The
marker determines whether the result is a linked worktree or standalone
repository. A custom source can therefore expose ordinary repositories for
cache review, but standalone repositories remain protected from future
whole-workspace removal.

When a standalone repository is found, VibeVac asks Git for its registered
worktrees. This is tool-independent and covers worktrees created by Cursor,
Claude, Hermes, Antigravity, or another client without reading that client's
conversation or state database. A nested worktree is a separate inventory
boundary: its disk size is excluded from the parent and traversal stops at its
own `.git` marker.

## Rebuildable cache proof

Cache cleanup is separate from whole-workspace recommendations. A workspace can
be `PROTECT` because it contains valuable source changes while still having
rebuildable generated directories.

A cache directory must:

1. match the built-in allowlist of dependency, framework-build, build-output,
   test-output, or tool-cache directory names;
2. be ignored by Git at its exact relative path;
3. be a real directory rather than a symlink;
4. resolve inside the workspace canonical path;
5. still be present in a fresh inventory immediately before removal.

`node_modules` also requires a recognized lockfile at the repository root.

The desktop cleanup slider can prepare four increasingly broad plans: caches
inactive for at least 90 days, 30 days, 14 days, or every verified cache. An
unknown activity timestamp is included only in the explicit `Full cache`
level. This UI selection is not deletion: the complete plan is previewed and
requires typed confirmation. Active-process, canonical-path, symlink, Git
inspection, and fresh-inventory checks cannot be relaxed by the slider.

Cache cleanup is blocked when the active-process check is unavailable or a
process has a current working directory inside the workspace.

Every completed or partial operation is appended to
`~/.vibevac/audit.jsonl`. Cache cleanup preserves the workspace, source,
branch, and Git history.

Batch cleanup is a sequence of independent workspace transactions. Each one is
revalidated immediately before removal and produces its own audit entry. If a
workspace changes after preview, that workspace is skipped and reported rather
than weakening the proof for the rest of the visible plan.

## Whole-workspace removal contract

Entire-worktree removal is a separate cleanup scope, not a fifth or hidden
cache-slider level. Its four levels admit linked worktrees inactive for at least
90, 60, 30, or 14 days. The slider filters eligibility only: no worktree is
preselected, and every target needs an explicit checkbox selection.

A removal plan must prove all of the following:

1. the canonical target is a registered linked Git worktree, never a standalone
   repository or ordinary project folder;
2. the checkout is clean, attached to a branch, synced to an upstream, and its
   `HEAD` is merged into the locally known default branch;
3. activity meets the selected threshold and no visible process has a current
   working directory inside the checkout;
4. every ignored, untracked entry is either contained by a freshly verified
   rebuildable-cache path or matches the narrow generated-file allowlist
   (`next-env.d.ts`, `*.tsbuildinfo`, `.eslintcache`, `.stylelintcache`); any
   other ignored data blocks the plan;
5. the common Git directory resolves outside the removal target, so branch,
   refs, objects, and history cannot be removed with the checkout;
6. the UI shows the exact worktrees, branches, ages, and bytes, then requires a
   separate typed batch confirmation.

Execution repeats the complete proof for each selected worktree. It invokes
`git worktree remove --force` through the common Git directory rather than
recursively deleting a path. `--force` is permitted only after the fresh clean
status and ignored-data allowlist proofs pass; it lets Git remove the verified
ignored caches inside the otherwise clean checkout. If any proof changes, that
worktree is skipped while the remaining explicit selections continue as
independent transactions.

The branch, upstream refs, and common repository remain available. Each success
or failure writes an audit entry to `~/.vibevac/audit.jsonl`; successful entries
include a reconstruction command for recreating the checkout.
