# Engine conformance suite

VibeVac has two engines with the same safety rules: TypeScript in
`src/services` (CLI and `vibevac ui`) and Rust in `src-tauri/src/core.rs`
(desktop app). Each case here builds a synthetic repository and runs it
through both engines with the same fake process snapshot and fake clock. Each
engine must match the case's `expected` fields, and the two engines must
match each other on the full normalised report: Git facts, reasons, caches,
cleanup gating and the cleanup plan. Sizes and absolute paths are left out.

```bash
pnpm test:conformance                                  # both engines when cargo and dist/ui exist
VIBEVAC_CONFORMANCE_RUST=require pnpm test:conformance # fail instead of skipping Rust (CI)
VIBEVAC_CONFORMANCE_KEEP=1 pnpm test:conformance       # keep fixture directories
```

The Rust half needs `cargo` and a built UI (`pnpm build:ui`), because the
Tauri crate embeds `dist/ui` at compile time. Without them it is skipped with
a warning.

## Adding a case

Every bug fix in either engine adds a case here before the fix.

1. Add `cases/<name>.json`. `base` names a file in `bases/` whose steps run
   first; `merged-linked-worktree` gives a pushed `repository`, a bare
   `remote.git` and a clean `agent-worktree` that tracks `origin/main` and
   has fetched once from inside the worktree.
2. `steps` run in order: `write` (path to contents), `mkdir`, `symlink`, and
   `git` (arguments, optional `cwd`, optional `at` date). `{root}` in a Git
   argument is the fixture root. Commits use a fixed author and
   `commitDate` (default 2026-01-01), so commit hashes are stable.
3. `activityAt` pins the workspace directory and Git index mtimes (default
   `commitDate`). `now` is the fake clock. `processes` lists working
   directories of running processes relative to the root; `null` means the
   process check is unavailable.
   `fetchedAt` pins every `FETCH_HEAD` a fetch step wrote (default `now`,
   "fetched today"); remote-tracking refs are pinned to `commitDate`. Git
   writes both with the real clock, which would otherwise look like a fetch
   in the future of the fake clock and pass the 7-day freshness rule.
4. Write `expected` from the rules, not from running an engine.
5. If an engine disagrees and it is not a safety bug, add a
   `knownDivergences` entry with the engine's actual value and a reason. The
   runner checks that the divergence is still there, so fixing it fails the
   case until you remove the entry. A fail-open disagreement stays a failing
   test.

The Rust side is `src-tauri/src/bin/conformance.rs`, which reads
`{workspacePath, workingDirectories, nowIso, staleAfterDays, cleanupSelection}`
on stdin and prints `{report, cleanup}`.
