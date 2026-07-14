# Show HN: VibeVac – safely reclaim rebuildable storage from AI coding workspaces

I built VibeVac after finding that AI coding tools had left more than 100 GB of
workspaces and worktrees on my Mac. The hard part was not finding large folders;
it was proving what could be rebuilt without touching source code or Git history.

VibeVac is a local, open-source macOS app. It discovers bounded workspace roots,
separates source and Git state from ignored generated directories, and shows the
evidence before anything can be selected. Cleanup is allowlisted, revalidated at
execution time, and requires explicit confirmation. Whole-worktree removal is a
separate opt-in scope and only applies to linked Git worktrees with stronger
safety evidence.

On my machine it found 115 workspaces using 113 GB, including 83 GB of verified
rebuildable caches. I have kept the first release deliberately narrow: macOS 12+,
local-only, no account, no telemetry, and no background service.

Repository and universal macOS download:
https://github.com/TargiX/vibevac

I would especially value feedback on the safety model, workspace discovery, and
which generated directories should or should not be eligible.

