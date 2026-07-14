# Changelog

All notable changes to VibeVac are documented here.

## [0.1.0] - 2026-07-14

### Added

- Native macOS desktop app backed by a local Rust scanning engine.
- Bounded discovery for Codex, Conductor, OpenClaw, common project folders, custom sources, and registered Git worktrees.
- Workspace size, Git state, activity, active-process, and recoverability evidence.
- Verified rebuildable-cache inventory with per-directory selection.
- Four inactivity-based cache cleanup levels and immediate reclaimed-space previews.
- Revalidated single and batch cache cleanup with typed confirmation and local audit records.
- Separate entire-worktree scope with explicit selection, stricter proof, branch preservation, and reconstruction instructions.
- Stale-report locking and per-workspace batch progress during cleanup.
- Optional CLI and token-protected localhost contributor UI.

### Known limitations

- The first release targets macOS. A full scan of many large workspaces may take around a minute because VibeVac measures storage and rechecks Git evidence locally.
- VibeVac does not fetch remotes; merge and recovery evidence use the locally available remote-tracking refs.
- Process detection depends on `lsof` visibility for the current user.

[0.1.0]: https://github.com/TargiX/vibevac/releases/tag/v0.1.0
