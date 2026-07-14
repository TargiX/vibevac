# VibeVac MVP brief

## One-line promise

VibeVac separates valuable work from rebuildable storage in AI coding
workspaces, then gives the user explicit local control over what is reclaimed.

## User

A developer who uses Codex, Conductor, Claude Code, Cursor, or manual Git
worktrees and has accumulated many duplicate checkouts, dependencies, build
artifacts, and browser profiles.

## Problem

Existing disk cleaners can identify large folders, but they do not understand
whether a development workspace contains uncommitted or unpushed work. Existing
worktree managers generally manage one workflow and do not provide a cross-tool
disk audit.

## MVP outcome

Opening the VibeVac desktop app produces one local report containing:

- detected Codex, Conductor, Cursor, Claude, Hermes, Antigravity, OpenClaw, and
  ordinary project workspaces through bounded roots and Git's worktree registry;
- size on disk;
- branch and upstream state;
- uncommitted and untracked change counts;
- local default-branch merge state;
- recent activity and active-process signals;
- separate data-safety and `candidate`, `keep`, `review`, or `protect`
  recommendations;
- a human-readable reason for every recommendation.

The desktop UI expands each workspace into its complete evidence and trust
boundary, size composition, per-cache selection, revalidated cleanup preview,
explicit confirmation, and local audit record. Cleanup has two independent
controls: scope (`Rebuildable caches` or `Entire worktrees`) and an
inactivity-based level. Changing either immediately updates the eligible bytes
and visible table rows. Entire-worktree scope never preselects a checkout; the
user must select every linked worktree explicitly. The installed app contains
its Rust engine and does not require a terminal, Node.js, or a listening server.
`vibevac scan`, `vibevac inspect <path>`, and `vibevac ui` remain optional
contributor and automation surfaces.

Scanning and inspection are read-only. Cache cleanup can remove only selected
directories from the verified rebuildable inventory. Entire-worktree removal
can remove only manually selected, registered linked worktrees after a stricter
proof and second confirmation. It preserves branches, remote refs, and common
Git history. Standalone repositories are never removal targets.

## Non-goals

- another coding-agent framework;
- generic system cleanup;
- automatic or preselected deletion;
- deleting standalone repositories;
- deciding whether product work is obsolete;
- Windows support in the first release.

## Success criteria

1. The scanner finds real Codex and Conductor roots, existing common project
   folders, OpenClaw workspace, and registered Git worktrees created by other
   tools on macOS and Linux.
2. A dirty, unpushed, standalone, or incompletely inspected workspace is always
   protected.
3. A cleanup candidate is clean, remotely recoverable, merged into the default
   branch, inactive beyond the configured threshold, and has no detected active
   process.
4. Recent activity overrides whole-workspace cleanup eligibility and active
   processes block cache cleanup.
5. A cache target is a known generated directory, ignored by Git, non-symlinked,
   contained by the workspace canonical path, and revalidated at execution.
6. The dashboard shows total, rebuildable, and retained sizes before selection.
7. JSON output is stable enough for issue reports and future integrations.
8. A first-time user can inspect why every recommendation was made.
9. The UI lists every scanned source and its workspace count, never implying a
   whole-disk scan.
10. A user can add or remove a custom parent folder through the native folder
    picker without editing configuration files.
11. Nested registered worktrees are inventoried separately and are not counted
    or cleaned as part of their parent repository.
12. Cleanup levels expand monotonically from 90-day inactive workspaces to all
    verified caches, while active-process and inventory blockers always remain
    enforced.
13. A multi-workspace cleanup shows the complete revalidated plan and requires
    a typed batch confirmation before executing each workspace transaction.
14. Entire-worktree removal is a separate scope with its own 90, 60, 30, and
    14-day levels; moving the level never selects a worktree automatically.
15. A whole-worktree plan accepts only registered linked worktrees that are
    clean, synced, merged, old enough, process-free, and free of ignored data
    outside the verified rebuildable directory and generated-file allowlist.
16. Whole-worktree removal uses Git's worktree operation, revalidates each
    selection at execution, preserves the branch and common repository, and
    records reconstruction instructions in the local audit log.
17. Worktree scope always states eligible versus protected counts, makes the
    complete inventory one action away, and gives every excluded workspace a
    concrete blocking reason.
18. Batch cache cleanup keeps the reviewed workspace list visible during execution and
    marks every row as waiting, cleaning, cleaned, or skipped while the aggregate
    progress remains visible in the primary action.
19. Successful cache cleanup updates the in-memory report immediately without a redundant
    full-disk rescan. During any explicit refresh, the previous report is visibly marked
    out of date and all report-derived cleanup controls stay disabled until a current scan
    succeeds.
20. Destructive red styling is reserved for the entire-worktree scope at every inactivity
    level. Rebuildable-cache cleanup keeps a non-destructive palette even at Full cache, so
    visual risk follows what can be removed rather than how broad the cache selection is.

## Release sequence

1. `0.1`: native macOS app, scanner, evidence inspection, cache inventory,
   selective cache cleanup, and explicit linked-worktree removal.
2. `0.2`: package-manager-aware restore commands and cleanup history UI.
3. `0.3`: optional archive-before-removal workflows and richer reconstruction
   history.
4. Later: signed Windows/Linux desktop packages and optional automatic updates.
