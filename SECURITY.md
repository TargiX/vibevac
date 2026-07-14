# Security policy

VibeVac is a local cleanup utility, so safety bugs are treated as security issues when they could remove data outside the reviewed plan, bypass a protection check, expose local information, or allow an untrusted process to invoke cleanup.

## Supported versions

Only the latest published `0.x` release receives security fixes during the pre-1.0 period.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/TargiX/vibevac/security/advisories/new). Do not open a public issue for a possible arbitrary-path deletion, symlink escape, command injection, local data disclosure, or cleanup-proof bypass.

Include the affected version, macOS version, a minimal reproduction using disposable data, and the safety invariant you believe was violated. Never send credentials, private repositories, or irreplaceable source files.

You should receive an acknowledgement within 72 hours. A fix will be developed privately when disclosure could put users at risk, then published with a security advisory and a new release.

## Scope

The strongest areas of interest are:

- canonical-path and symlink containment;
- cache allowlist and Git-ignore validation;
- active-process and Git-state revalidation;
- entire-worktree proof and branch preservation;
- Tauri command boundaries;
- localhost session-token enforcement in the optional contributor UI.

The complete intended boundary is documented in [docs/safety-model.md](docs/safety-model.md).
