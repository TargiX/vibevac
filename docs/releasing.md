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
certificate, password, App Store Connect Team API key, and issuer ID in GitHub
Actions secrets; never commit them. The release workflow expects
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`,
`APPLE_API_KEY`, `APPLE_API_KEY_P8`, and `APPLE_API_ISSUER`.

Use a Team API key with `Developer` access. Individual App Store Connect keys
cannot authenticate `notarytool`. The private `.p8` key is downloadable only
once, so store it as the `APPLE_API_KEY_P8` secret immediately and keep the
local copy outside the repository.

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

## npm and Homebrew

Publishing the GitHub Release (not creating the draft) runs
`.github/workflows/publish-packages.yml`. It publishes the CLI to npm and
updates the Homebrew cask, so both only ever point at reviewed, public
artifacts.

One-time setup:

1. **npm.** npm requires two-factor authentication to publish, and tokens that
   bypass 2FA are being retired (reduced in August 2026, unable to publish from
   January 2027). The workflow therefore uses trusted publishing (OIDC) and
   stores no npm token.
   - Enable 2FA on the npm account.
   - Publish the first version by hand, because trusted publishing cannot
     create a package: `npm login`, then `npm publish --access public` and
     enter the one-time code.
   - On npmjs.com open the `vibevac` package, Settings, Trusted Publisher,
     choose GitHub Actions, and enter owner `TargiX`, repository `vibevac`,
     workflow `publish-packages.yml`. The values must match exactly or npm
     answers with a misleading 404.
   - Optionally set the package to require 2FA and disallow tokens, so only
     you and this workflow can publish.

   The job skips a version that is already on npm, so publishing a release
   for a version you pushed by hand is safe. Trusted publishing also attaches
   provenance automatically.
2. **Homebrew.** The public `TargiX/homebrew-tap` repository holds
   `Casks/vibevac.rb`. Save a fine-grained token with `Contents: read and
   write` on that repository as the `HOMEBREW_TAP_TOKEN` secret. The workflow
   renders `packaging/homebrew/vibevac.rb` with the release version and the
   DMG checksum from `SHA256SUMS.txt` and pushes it to the tap. Without the
   secret the job skips with a warning and the cask has to be updated by
   hand. Users install with `brew install --cask targix/tap/vibevac`.

The release tag must equal `v` plus the `package.json` version, or the npm job
stops before publishing.

## Primary references

- [Tauri macOS code signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri DMG distribution](https://v2.tauri.app/distribute/dmg/)
- [Official Tauri GitHub Action](https://github.com/tauri-apps/tauri-action)
