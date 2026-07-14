# VibeVac launch checklist

## Release gate

- [ ] CI passes on `main`.
- [ ] Universal binary contains `arm64` and `x86_64` slices.
- [ ] Developer ID signature verifies with `codesign --verify --deep --strict`.
- [ ] Gatekeeper accepts the installed app with `spctl --assess`.
- [ ] Apple notarization ticket is stapled and validates.
- [ ] DMG passes `hdiutil verify` and matches `SHA256SUMS.txt`.
- [ ] A clean macOS user can install the DMG and complete a read-only scan.
- [ ] GitHub release is marked prerelease while `0.1.0` feedback is collected.

## Repository surface

- [ ] Description, topics, social preview, README screenshot, and About links are live.
- [ ] Issue forms, security policy, contribution guide, license, and changelog render.
- [ ] Discussions are enabled with a pinned feedback prompt.

## Launch sequence

1. Publish the signed GitHub prerelease and test the public download.
2. Send the link to 5–10 developers who use AI coding tools on macOS.
3. Fix installation or false-positive reports before wider distribution.
4. Publish the prepared r/macapps post.
5. Publish the prepared Show HN post when the maintainer can answer questions live.
6. Add the repo to curated macOS/open-source utility lists after the first feedback pass.

Do not submit posts automatically. Publishing to a community is a separate
representational action and should happen only when the maintainer is ready to
respond.
