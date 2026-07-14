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
