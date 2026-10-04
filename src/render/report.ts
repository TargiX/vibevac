import { homedir } from "node:os";

import pc from "picocolors";

import type {
  DataSafety,
  Recommendation,
  ScanReport,
  WorkspaceReport,
} from "../domain/types.js";

export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "—";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KB";

  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }

  const precision = value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${unit}`;
}

export function formatAge(timestamp: string | null, now = Date.now()): string {
  if (!timestamp) {
    return "—";
  }

  const days = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "1d";
  return `${days}d`;
}

function compactPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(1, length - 1))}…`;
}

function styleRecommendation(recommendation: Recommendation): string {
  if (recommendation === "candidate") return pc.green("CANDIDATE");
  if (recommendation === "keep") return pc.cyan("KEEP");
  if (recommendation === "review") return pc.yellow("REVIEW");
  return pc.red("PROTECT");
}

function dataSafetyLabel(dataSafety: DataSafety): string {
  if (dataSafety === "recoverable") return "SYNCED";
  if (dataSafety === "local-only") return "LOCAL";
  return "UNKNOWN";
}

function row(workspace: WorkspaceReport): string {
  const status = styleRecommendation(workspace.recommendation).padEnd(20);
  const data = dataSafetyLabel(workspace.dataSafety).padEnd(8);
  const tool = workspace.tool.padEnd(10);
  const size = formatBytes(workspace.sizeBytes).padStart(8);
  const cache = formatBytes(workspace.cacheBytes).padStart(8);
  const retained = formatBytes(workspace.retainedSizeBytes).padStart(8);
  const age = formatAge(workspace.git?.lastActivityAt ?? null).padStart(7);
  const merged = (
    workspace.git?.mergedIntoDefault === true
      ? "yes"
      : workspace.git?.mergedIntoDefault === false
        ? "no"
        : "?"
  ).padEnd(6);
  const branch = truncate(workspace.git?.branch ?? "detached", 18).padEnd(18);
  return `${status} ${data} ${tool} ${size} ${cache} ${retained} ${age}  ${merged} ${branch} ${compactPath(workspace.path)}`;
}

export function renderHumanReport(report: ScanReport): string {
  const counts = report.workspaces.reduce<Record<Recommendation, number>>(
    (result, workspace) => {
      result[workspace.recommendation] += 1;
      return result;
    },
    { candidate: 0, keep: 0, review: 0, protect: 0 },
  );
  const lines = [
    pc.bold(
      `VibeVac found ${report.workspaces.length} workspaces · ${
        report.workspaces.every((workspace) => workspace.sizeBytes === null)
          ? "size skipped"
          : formatBytes(report.totalSizeBytes)
      }`,
    ),
    `${pc.green(`${counts.candidate} candidate`)}  ${pc.cyan(`${counts.keep} keep`)}  ${pc.yellow(`${counts.review} review`)}  ${pc.red(`${counts.protect} protect`)}`,
    report.workspaces.every((workspace) => workspace.sizeBytes === null)
      ? "Candidate size skipped"
      : `${formatBytes(report.candidateSizeBytes)} in conservative cleanup candidates`,
    report.workspaces.every((workspace) => workspace.sizeBytes === null)
      ? "Cache inventory skipped"
      : `${formatBytes(report.reclaimableCacheBytes)} of rebuildable caches can be reviewed now`,
    "",
  ];

  if (report.workspaces.length === 0) {
    lines.push("No Git workspaces found in the selected roots.");
    return lines.join("\n");
  }

  lines.push("ACTION               DATA     TOOL          TOTAL    CACHE     KEEP  ACTIVE  MERGED BRANCH             PATH");
  for (const workspace of report.workspaces) {
    lines.push(row(workspace));
    lines.push(pc.dim(`  ↳ ${workspace.reasons.join("; ")}`));
    if (workspace.sizeError) {
      lines.push(pc.dim(`  ↳ size unavailable: ${workspace.sizeError}`));
    }
    if (workspace.inspectionError) {
      lines.push(pc.dim(`  ↳ Git error: ${workspace.inspectionError}`));
    }
  }

  lines.push(
    "",
    pc.dim(
      `CANDIDATE means clean + synced + merged + inactive for ${report.staleAfterDays}d with no detected process.`,
    ),
    pc.dim("It is a suggestion for human review, never automatic permission to delete."),
    pc.dim("Read-only scan. VibeVac did not modify any workspace."),
  );
  if (!report.processCheckAvailable && report.processCheckError) {
    lines.push(pc.yellow("Process check unavailable; VibeVac will not produce cleanup candidates."));
  }
  return lines.join("\n");
}

const RELEASES_URL = "https://github.com/TargiX/vibevac/releases";

function workspaceName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function bar(value: number, max: number, width: number): string {
  const length = max > 0 ? Math.max(1, Math.round((value / max) * width)) : 0;
  return pc.green("━".repeat(length));
}

// The default scan output: one figure worth sharing, where it comes from, and
// what to do next. `renderHumanReport` keeps the full evidence table.
export function renderScanSummary(report: ScanReport, now = Date.now()): string {
  const sizeSkipped =
    report.workspaces.length > 0 &&
    report.workspaces.every((workspace) => workspace.sizeBytes === null);
  const lines = ["", `  ${pc.bold("VibeVac")}  ${pc.dim("read-only scan · nothing was changed")}`, ""];

  if (report.workspaces.length === 0) {
    lines.push(
      "  No Git workspaces found in the default sources.",
      pc.dim("  Point VibeVac at a folder of projects:  vibevac --root ~/code"),
      "",
    );
    return lines.join("\n");
  }

  if (sizeSkipped) {
    lines.push(
      `  ${report.workspaces.length} workspaces found. Sizes and caches were skipped.`,
      pc.dim("  Run without --no-size to measure rebuildable storage."),
      "",
    );
    return lines.join("\n");
  }

  const ready = report.workspaces.filter(
    (workspace) => workspace.cacheCleanupAllowed && workspace.cacheBytes > 0,
  );
  const heldBack = report.workspaces.filter(
    (workspace) => !workspace.cacheCleanupAllowed && workspace.cacheBytes > 0,
  );
  const heldBackBytes = heldBack.reduce((total, workspace) => total + workspace.cacheBytes, 0);
  const figure = formatBytes(report.reclaimableCacheBytes);

  lines.push(
    `  ${pc.bold(pc.green(figure))}  rebuildable storage ready to review`,
    `  ${" ".repeat(figure.length)}  ${pc.dim(
      `in ${ready.length} of ${report.workspaces.length} workspaces · ${formatBytes(report.totalSizeBytes)} scanned`,
    )}`,
    "",
  );

  if (ready.length > 0) {
    const byType = new Map<string, number>();
    for (const workspace of ready) {
      for (const cache of workspace.caches) {
        byType.set(cache.name, (byType.get(cache.name) ?? 0) + (cache.sizeBytes ?? 0));
      }
    }
    const types = [...byType].sort((left, right) => right[1] - left[1]);
    const shownTypes = types.slice(0, 6);
    const largestType = shownTypes[0]?.[1] ?? 0;
    const typeWidth = Math.max(...shownTypes.map(([name]) => name.length));
    lines.push(`  ${pc.bold("By type")}`);
    for (const [name, bytes] of shownTypes) {
      lines.push(
        `    ${name.padEnd(typeWidth)}  ${formatBytes(bytes).padStart(7)}  ${bar(bytes, largestType, 24)}`,
      );
    }
    const otherTypes = types.slice(shownTypes.length);
    if (otherTypes.length > 0) {
      const otherBytes = otherTypes.reduce((total, [, bytes]) => total + bytes, 0);
      lines.push(pc.dim(`    + ${otherTypes.length} more types, ${formatBytes(otherBytes)}`));
    }

    const largest = [...ready].sort((left, right) => right.cacheBytes - left.cacheBytes).slice(0, 5);
    const nameWidth = Math.min(28, Math.max(...largest.map((workspace) => workspaceName(workspace.path).length)));
    lines.push("", `  ${pc.bold("Largest")}`);
    for (const workspace of largest) {
      const kinds = [...new Set(workspace.caches.map((cache) => workspaceName(cache.relativePath)))]
        .slice(0, 3)
        .join(", ");
      const idle = formatAge(workspace.git?.lastActivityAt ?? null, now);
      lines.push(
        `    ${formatBytes(workspace.cacheBytes).padStart(7)}  ${truncate(workspaceName(workspace.path), nameWidth).padEnd(nameWidth)}  ${pc.dim(
          `${kinds} · ${idle === "today" ? "used today" : `${idle} idle`}`,
        )}`,
      );
    }
    lines.push("");
  } else {
    lines.push("  Nothing is ready to clean right now.", "");
  }

  if (heldBack.length > 0) {
    lines.push(
      pc.dim(
        `  ${formatBytes(heldBackBytes)} more in ${heldBack.length} ${heldBack.length === 1 ? "workspace is" : "workspaces are"} held back by a running process or a failed check.`,
      ),
    );
  }
  if (!report.processCheckAvailable) {
    lines.push(
      pc.yellow("  The active-process check is unavailable (lsof), so cleanup stays blocked."),
    );
  }
  if (heldBack.length > 0 || !report.processCheckAvailable) lines.push("");

  const example = ready[0] ? compactPath(ready[0].path) : "<workspace>";
  lines.push(
    `  ${pc.bold("Next")}`,
    pc.dim("    Preview one workspace. This removes nothing."),
    `      vibevac clean ${example} --all`,
    pc.dim("    See the evidence for every workspace."),
    "      vibevac --details",
    pc.dim("    Review and clean in batches in the desktop app."),
    `      ${RELEASES_URL}`,
    "",
  );
  return lines.join("\n");
}

export function renderWorkspaceInspection(
  workspace: WorkspaceReport,
  staleAfterDays: number,
): string {
  const git = workspace.git;
  const lines = [
    pc.bold("VibeVac workspace inspection"),
    "",
    `Path:           ${compactPath(workspace.path)}`,
    `Recommendation: ${styleRecommendation(workspace.recommendation)}`,
    `Data recovery:  ${dataSafetyLabel(workspace.dataSafety)}`,
    `Disk size:      ${formatBytes(workspace.sizeBytes)}`,
    `Rebuildable:    ${formatBytes(workspace.cacheBytes)} across ${workspace.caches.length} cache${workspace.caches.length === 1 ? "" : "s"}`,
    `After cleanup:  ${formatBytes(workspace.retainedSizeBytes)}`,
    `Cache cleanup:  ${workspace.cacheCleanupAllowed ? "ready for review" : workspace.cacheCleanupReason ?? "unavailable"}`,
    `Why:            ${workspace.reasons.join("; ")}`,
    "",
    pc.bold("Evidence"),
  ];

  if (!git) {
    lines.push("  ✗ Git state could not be inspected");
  } else {
    lines.push(
      `  ${git.kind === "linked-worktree" ? "✓" : "!"} Workspace type: ${git.kind}`,
      `  ${git.dirtyEntries === 0 ? "✓" : "✗"} Uncommitted entries: ${git.dirtyEntries} (${git.untrackedEntries} untracked)`,
      `  ${git.branch ? "✓" : "!"} Branch: ${git.branch ?? "detached HEAD"}`,
      `  ${git.upstream || git.remoteContainsHead ? "✓" : "✗"} Remote recovery: ${
        git.upstream
          ? `${git.upstream}, ${git.ahead ?? "?"} commits ahead`
          : git.remoteContainsHead
            ? "HEAD exists on a remote ref"
            : "not proven"
      }`,
      `  ${git.mergedIntoDefault === true ? "✓" : git.mergedIntoDefault === false ? "!" : "?"} Merged into ${git.defaultBranch ?? "default branch"}: ${
        git.mergedIntoDefault === true
          ? "yes"
          : git.mergedIntoDefault === false
            ? "no"
            : "unknown"
      }`,
      `  ${workspace.activeProcessCount === 0 ? "✓" : workspace.activeProcessCount === null ? "?" : "!"} Active processes here: ${workspace.activeProcessCount ?? "unknown"}`,
      `  • Last activity signal: ${formatAge(git.lastActivityAt)}`,
      `  • Candidate threshold: ${staleAfterDays}d`,
    );
  }

  if (workspace.caches.length > 0) {
    lines.push("", pc.bold("Rebuildable cache inventory"));
    for (const cache of workspace.caches) {
      lines.push(
        `  • ${cache.relativePath} — ${formatBytes(cache.sizeBytes)} — ${cache.rebuildHint}`,
      );
    }
  }

  lines.push(
    "",
    pc.bold("Trust boundary"),
    "VibeVac can prove whether this checkout is recoverable and detect signs of activity.",
    "It cannot know whether the project still matters to you.",
    "CANDIDATE means “worth reviewing”, not “definitely unwanted”.",
    "This command is read-only and will not delete or modify the workspace.",
  );

  return lines.join("\n");
}
