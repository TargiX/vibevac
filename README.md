# VibeVac

**Your coding agents left gigabytes of `node_modules`, `target` and `.venv`
behind. Get the space back without touching your code.**

[![CI](https://github.com/TargiX/vibevac/actions/workflows/ci.yml/badge.svg)](https://github.com/TargiX/vibevac/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/TargiX/vibevac?include_prereleases&label=release)](https://github.com/TargiX/vibevac/releases)
[![npm](https://img.shields.io/npm/v/vibevac?label=npm)](https://www.npmjs.com/package/vibevac)
[![License: MIT](https://img.shields.io/badge/license-MIT-7ee697.svg)](LICENSE)

![VibeVac control center showing reclaimable storage across AI coding workspaces](docs/assets/vibevac-control-center.png)

Claude Code, Cursor, Codex, Conductor and friends are excellent at spinning up
fresh worktrees. Each one gets its own dependencies, build output and caches.
Tidying up is apparently beneath their pay grade.

VibeVac finds that weight, proves which parts can be rebuilt, and lets you
reclaim them. Source files, Git history and anything it cannot prove stay
exactly where they are. It runs locally, needs no account, and sends nothing
anywhere.

## ⚡ Try it in ten seconds

```bash
npx vibevac
```

The scan is read-only and works on macOS and Linux with Node.js 20+. Example
output:

```text
  VibeVac  read-only scan · nothing was changed

  38 GB  rebuildable storage ready to review
         in 23 of 115 workspaces · 113 GB scanned

  By type
    Installed dependencies       21 GB  ━━━━━━━━━━━━━━━━━━━━━━━━
    Rust build output           9.1 GB  ━━━━━━━━━━
    Python virtual environment  4.0 GB  ━━━━━
    Next.js build cache         2.2 GB  ━━━

  Largest
     5.5 GB  checkout-redesign   node_modules, .next · 32d idle
     4.7 GB  image-pipeline      target · 21d idle
     3.1 GB  ml-notebooks        .venv · 45d idle
```

Nothing is deleted by a scan. When you want the space back, use the desktop
app or `vibevac clean`.

## 📦 Install the app

The desktop app adds batch review, a cleanup-level slider, per-directory
selection, and a separate scope for removing whole stale worktrees.

```bash
brew install --cask targix/tap/vibevac
```

Or **[download the latest release](https://github.com/TargiX/vibevac/releases)**:
a signed and notarized universal app for Apple Silicon and Intel Macs on macOS
12 or newer. It does not want an account, your email, a subscription,
telemetry permission, or a small background daemon "for your convenience."

## 🧪 The first patient

The first Mac scanned by VibeVac was the one used to build it:

```text
115 coding workspaces and repositories
113 GB total footprint
 83 GB verified rebuildable caches
 63 GB available at the Full cache level
 30 GB source + Git retained
```

No real caches were deleted to produce those numbers. Even vacuum cleaners
should dogfood dry-run mode first.

## ♻️ What it can reclaim

| Ecosystem | Directories | Proof required before it is offered |
| --- | --- | --- |
| JavaScript | `node_modules` | a lockfile at the repository root |
| Next.js, Nuxt, SvelteKit | `.next`, `.nuxt`, `.svelte-kit` | ignored by Git |
| Turborepo, Parcel | `.turbo`, `.parcel-cache` | ignored by Git |
| Rust | `target` | `Cargo.toml` beside it, Cargo's marker inside it |
| Python | `.venv`, `venv` | `pyvenv.cfg` inside it, a Python manifest beside it |
| Swift | `.build` | `Package.swift` beside it |
| CocoaPods | `Pods` | `Manifest.lock` inside it, `Podfile.lock` beside it |
| Gradle | `.gradle` | a Gradle settings or build file beside it |
| Dart, Flutter | `.dart_tool` | `pubspec.yaml` beside it |
| Xcode | `ModuleCache.noindex`, `Index.noindex`, `Intermediates.noindex` and friends | a DerivedData `info.plist` naming an Xcode project |
| Build and test output | `dist`, `build`, `out`, `coverage`, `playwright-report`, `test-results` | ignored by Git, no release artifacts or nested repositories inside |

On top of its own proof, every directory must be ignored by Git, contain no
tracked files, and be a real directory rather than a symlink. Release archives,
dSYMs, IPAs and Xcode `Products` are always retained. If an inspection cannot
finish, the directory is retained.

Missing an ecosystem? [Open an issue](https://github.com/TargiX/vibevac/issues/new/choose)
with the directory name and what proves it belongs to its tool.

## 🧭 Why it is careful

Most cleaners start from a list of folders they know how to delete. VibeVac
starts from a stricter question:

> Can this machine prove that the data is rebuildable?

Source is not dirt. An old checkout is not automatically abandoned. A familiar
directory name is not proof. VibeVac combines filesystem boundaries, Git state,
activity, running-process checks, ignore rules, and reconstruction evidence
before it offers anything. When the evidence is incomplete, it does the least
exciting and most useful thing a cleaner can do, which is nothing.

The hesitation is the feature.

Before removing anything, VibeVac:

1. repeats the Git and cache inventory checks;
2. rejects arbitrary, changed, or newly introduced paths;
3. checks for processes working inside the workspace;
4. resolves canonical paths and rejects symlinks or traversal;
5. shows the exact directories and bytes;
6. requires a typed, workspace-specific or batch-specific confirmation;
7. checks the complete plan again at execution time;
8. records the result in `~/.vibevac/audit.jsonl`.

The full reasoning is in the [safety model](docs/safety-model.md).

## 📍 Where it looks

VibeVac does not roam across the entire disk hoping to find something dramatic.
It scans explicit, bounded sources:

- `~/.codex/worktrees`;
- `~/conductor/workspaces`;
- common project folders such as `~/Code`, `~/Developer`, `~/Projects`,
  `~/repos`, `~/src`, `~/workspace`, and `~/workspaces`;
- `~/.openclaw/workspace`;
- any folder you add in the Sources panel or pass with `--root`.

Inside those roots, Git decides what a directory is. A `.git` file means a
linked worktree, a `.git` directory means a standalone repository. Registered
worktrees are found even when Claude Code, Cursor, Hermes, Codex or another
tool put them outside the original project folder.

VibeVac does not read agent conversations, credentials, memories, application
databases, or IDE `workspaceStorage`.

## 🧹 Cleaning up

### In the desktop app

Pick a cleanup level (90+, 30+, 14+ days idle, or every verified cache) and the
plan updates immediately. Review it, type the confirmation, and VibeVac
revalidates every workspace once more before removing anything. Busy or
unprovable workspaces are skipped with their reasons, and the rest proceed.

**Entire worktrees** is a separate scope with a much higher bar. A linked
worktree qualifies only when it is registered, clean, synced, merged, old
enough, free of running processes, and free of ignored data outside the
allowlist. It is never selected automatically. Removal uses
`git worktree remove`, keeps the branch and shared history, and records how to
recreate the checkout.

An explicit, session-only **Allow removal of protected worktrees** switch
bypasses the merge, remote, local-file, and process protections for people who
know what they are doing. The age filter still applies, each checkout still
needs explicit selection, a fresh risk preview, and its exact `FORCE REMOVE`
confirmation. Local and ignored files are permanently deleted in that mode;
shared Git history and branches remain.

### From the terminal

```bash
vibevac                                  # summary of what can be reclaimed
vibevac --details                        # full per-workspace evidence table
vibevac --root ~/worktrees               # scan a specific folder
vibevac inspect ~/Projects/my-app        # the evidence behind one workspace
vibevac --json > vibevac-report.json     # machine-readable report
```

`vibevac clean` previews by default. Run it once, then repeat with the
confirmation it prints:

```bash
vibevac clean ~/Projects/my-app --all
vibevac clean ~/Projects/my-app --all --execute --confirm 'CLEAN Projects/my-app'
vibevac clean ~/Projects/my-app --cache node_modules --cache .next
```

`--all` selects every verified cache in that one workspace and never removes
the workspace itself. Sizes are estimates: hardlinks, APFS clones, and
concurrent disk activity affect how much space is actually freed.

### Reading the recommendations

| Recommendation | Meaning |
| --- | --- |
| `CANDIDATE` | Clean, remotely recoverable, merged, stale, and no process was detected. Still requires a human decision. |
| `KEEP` | Recently used or currently held by a running process. |
| `REVIEW` | Recoverable, but one intent signal cannot be proven. |
| `PROTECT` | Contains local-only work, is a standalone repository, or inspection was incomplete. |

Cache cleanup is independent of the whole-workspace recommendation. A dirty
workspace can still contain verified, ignored build caches while its source
changes stay protected.

## 🔒 Local means local

The desktop app runs scanning and cleanup through application-local Tauri
commands. There is no account, telemetry, remote API, model, GitHub access, or
listening HTTP server. It invokes the system `git`, `du`, and `lsof` tools and
reads only the sources shown in the UI.

The optional `vibevac ui` command serves the same interface from a localhost
server bound to `127.0.0.1`. Mutating requests require a random in-memory
session token and a matching browser origin.

## 💻 Supported environments

- Desktop app: macOS 12+, universal Apple Silicon and Intel build.
- CLI: macOS and Linux with Node.js 20+.
- System tools: Git, `du` for disk sizing, and `lsof` for active-process
  protection. Without `lsof`, scans still work but cleanup stays blocked.

## 🛠️ Build and contribute

Contributions are welcome, especially reproducible edge cases, new ecosystem
proofs, fixtures, and changes that make destructive code more boring. Safety
changes need tests; `probably fine` is not a storage format.

```bash
pnpm install
pnpm check            # typecheck, tests, CLI and UI build
pnpm desktop:dev      # run the desktop app
pnpm dev scan         # run the CLI from source
```

Building the desktop app requires Node.js, pnpm, Rust, and the platform's Tauri
prerequisites. The TypeScript and Rust test suites use real temporary Git
repositories and only perform destructive cleanup inside disposable fixtures.

See [the release guide](docs/releasing.md) for signing, notarization, npm, and
Homebrew publishing.

## 🗺️ Roadmap

- **Next:** truthful scan progress in the app, cancellation, incremental
  rescans, Pin and Ignore, and a shareable cleanup summary.
- **Then:** cleanup history, package-manager-aware restore guidance, and a menu
  bar view that notices when agents start piling up storage again.
- **Later:** canonical repository grouping, orphan review, and cross-platform
  desktop packages once the macOS safety loop is proven.

VibeVac will not become another agent framework. Its job is to make the local
infrastructure around coding agents understandable, reclaimable, and, when
necessary, reconstructable.

## 📄 License

[MIT](LICENSE)
