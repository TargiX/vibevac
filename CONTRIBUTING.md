# Contributing to VibeVac

Thanks for helping make local AI coding infrastructure easier to understand and safer to clean.

## Before opening a change

- Use an issue for behavior that expands discovery or cleanup scope.
- Keep cleanup permissions narrow and fail closed when evidence is missing.
- Never use a real irreplaceable workspace as a destructive test fixture.
- Do not add telemetry, accounts, cloud APIs, or automatic deletion without prior design discussion.

## Development setup

Requirements:

- Node.js 20 or newer;
- pnpm 9;
- stable Rust;
- Xcode and the Tauri macOS prerequisites.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm desktop:build
```

Tests that execute cleanup must use temporary fixtures. A pull request that changes a safety rule should include a focused regression test proving both the allowed case and the blocked case.

## Pull requests

Keep pull requests focused. Explain:

- the user-visible behavior;
- which safety invariant is affected;
- how the change was tested;
- whether discovery or cleanup scope becomes broader.

UI changes should include a screenshot. Never attach reports or screenshots containing private repository names or local usernames unless they are intentionally public.

By contributing, you agree that your contribution is licensed under the repository's MIT license.
