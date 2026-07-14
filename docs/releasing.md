# Desktop release guide

VibeVac's end-user artifact is a signed and notarized macOS DMG. Users should
never need Node.js, Rust, pnpm, a terminal, or a locally running server.

## Local build

Prerequisites for maintainers:

- Node.js 20+ and pnpm;
- stable Rust;
- Xcode and the macOS Tauri prerequisites.

Build and validate:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm exec tauri build --target universal-apple-darwin
```

The universal Apple Silicon + Intel artifacts are written to:

```text
src-tauri/target/universal-apple-darwin/release/bundle/macos/VibeVac.app
src-tauri/target/universal-apple-darwin/release/bundle/dmg/VibeVac_<version>_universal.dmg
```

An unsigned local DMG is useful for development, but it is not a public
release: Gatekeeper will warn users about an unidentified developer.

## Public release gate

Before publishing a DMG:

1. set the same version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`;
2. run the full validation above on a clean checkout;
3. sign the app with an Apple Developer ID Application certificate;
4. notarize the signed bundle with Apple and staple the ticket;
5. verify with `codesign --verify --deep --strict`, `spctl --assess`, and
   `stapler validate`;
6. install the DMG on a clean macOS user account and complete a read-only scan;
7. attach the DMG to a GitHub Release and publish checksums.

Signing and notarization require Apple Developer credentials. Keep the
certificate, password, Apple API key, issuer ID, and team ID in GitHub Actions
secrets; never commit them.

## GitHub distribution

Use the official `tauri-apps/tauri-action` release workflow to build one
universal Apple Silicon + Intel artifact from a version tag and upload it to a
draft GitHub Release. Keep the release draft until both slices pass the public
release gate.

The first public release should contain:

- one signed/notarized universal Apple Silicon + Intel DMG;
- SHA-256 checksums;
- the exact macOS minimum version;
- a concise explanation that scans are local and cleanup is never automatic;
- known limitations (`git`, `du`, and `lsof` are system dependencies).

Do not advertise an unsigned DMG as the normal installation path. Source builds
remain available for contributors under the MIT license.

## Primary references

- [Tauri macOS code signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri DMG distribution](https://v2.tauri.app/distribute/dmg/)
- [Official Tauri GitHub Action](https://github.com/tauri-apps/tauri-action)
