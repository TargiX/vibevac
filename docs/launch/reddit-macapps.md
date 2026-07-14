# Title

I made an open-source Mac app to safely clean rebuildable AI coding workspaces

# Post

AI coding tools made it very easy for me to accumulate worktrees full of copied
`node_modules`, framework output, test reports, and caches. Disk analyzers could
show the size, but they could not tell me whether a folder was safe to remove.

So I built VibeVac. It is a native-feeling, local-only macOS app that:

- finds Codex, Conductor, Cursor/Claude-style Git worktrees, and normal project roots;
- separates source + Git state from verified ignored/generated directories;
- shows size, age, active-process, and Git evidence before cleanup;
- revalidates every target immediately before deletion;
- keeps full worktree removal behind a separate opt-in danger scope.

Nothing is selected or removed during scanning. There is no account, telemetry,
cloud service, or terminal requirement. The first prerelease is universal for
Apple Silicon and Intel Macs running macOS 12+.

It found 83 GB of rebuildable storage across 115 workspaces on my own Mac. The
code, safety model, screenshots, and download are here:

https://github.com/TargiX/vibevac

Feedback on false positives and missing workspace/cache types would be very useful.

