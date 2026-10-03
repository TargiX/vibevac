#!/usr/bin/env node

import { Command, Option } from "commander";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { customDiscoveryRoots, defaultDiscoveryRoots } from "./services/discovery.js";
import {
  renderHumanReport,
  renderScanSummary,
  renderWorkspaceInspection,
} from "./render/report.js";
import { startUiServer } from "./server/ui-server.js";
import { scanWorkspaces } from "./services/scanner.js";
import { inventoryRebuildableCaches } from "./services/cache-inventory.js";
import { executeCacheCleanup, planCacheCleanup } from "./services/cache-cleanup.js";

interface ScanCommandOptions {
  root: string[];
  json: boolean;
  details: boolean;
  size: boolean;
  staleAfter: number;
}

// Progress goes to stderr and only to a terminal, so piped or JSON output
// stays clean.
function scanProgressReporter(): {
  update: (progress: { completed: number; total: number }) => void;
  clear: () => void;
} {
  if (!process.stderr.isTTY) return { update: () => {}, clear: () => {} };
  const write = (text: string) => process.stderr.write(`\r\x1b[2K${text}`);
  write("  Finding workspaces…");
  return {
    update: ({ completed, total }) =>
      write(`  Measuring ${completed}/${total} workspaces and checking Git evidence…`),
    clear: () => write(""),
  };
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("stale-after must be a positive number of days");
  }
  return parsed;
}

function portNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("port must be between 0 and 65535");
  }
  return parsed;
}

const program = new Command();

program
  .name("vibevac")
  .description("Safely find disk space trapped in AI coding workspaces")
  .version("0.1.0");

program
  .command("scan", { isDefault: true })
  .description("scan known AI workspace roots without changing them")
  .addOption(
    new Option("-r, --root <path>", "scan only this custom root (repeatable)")
      .argParser((value, previous: string[]) => [...previous, value])
      .default([]),
  )
  .option("--json", "print machine-readable JSON", false)
  .option("--details", "print the full per-workspace evidence table", false)
  .option("--no-size", "skip disk-usage calculation")
  .option(
    "--stale-after <days>",
    "minimum inactivity before suggesting a cleanup candidate",
    positiveInteger,
    14,
  )
  .action(async (options: ScanCommandOptions) => {
    const roots =
      options.root.length > 0 ? customDiscoveryRoots(options.root) : defaultDiscoveryRoots();
    const progress = options.json
      ? { update: () => {}, clear: () => {} }
      : scanProgressReporter();
    const report = await scanWorkspaces(roots, {
      includeSize: options.size,
      staleAfterDays: options.staleAfter,
      onProgress: progress.update,
    }).finally(progress.clear);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    process.stdout.write(
      `${options.details ? renderHumanReport(report) : renderScanSummary(report)}\n`,
    );
  });

program
  .command("inspect")
  .description("show the evidence behind one workspace recommendation")
  .argument("<path>", "exact path to a Git workspace")
  .option("--json", "print machine-readable JSON", false)
  .option("--no-size", "skip disk-usage calculation")
  .option(
    "--stale-after <days>",
    "minimum inactivity before suggesting a cleanup candidate",
    positiveInteger,
    14,
  )
  .action(
    async (
      path: string,
      options: Pick<ScanCommandOptions, "json" | "size" | "staleAfter">,
    ) => {
      const workspacePath = await realpath(resolve(path));
      const report = await scanWorkspaces(
        [{ tool: "custom", path: workspacePath, maxDepth: 0 }],
        {
          includeSize: options.size,
          staleAfterDays: options.staleAfter,
        },
      );
      const workspace = report.workspaces.find((candidate) => candidate.path === workspacePath);

      if (!workspace) {
        throw new Error(`No Git workspace found at ${workspacePath}`);
      }

      if (options.json) {
        process.stdout.write(`${JSON.stringify(workspace, null, 2)}\n`);
        return;
      }

      process.stdout.write(
        `${renderWorkspaceInspection(workspace, report.staleAfterDays)}\n`,
      );
    },
  );

program
  .command("clean")
  .description("preview selected verified caches; deletion requires --execute and --confirm")
  .argument("<path>", "exact Git workspace to clean")
  .addOption(new Option("--cache <relative-path>", "select a cache (repeatable)")
    .argParser((value, previous: string[]) => [...previous, value]).default([]))
  .option("--all", "select every verified cache in this workspace", false)
  .option("--execute", "execute the previewed selection", false)
  .option("--confirm <text>", "exact confirmation text printed by the preview")
  .option("--json", "print machine-readable JSON", false)
  .action(async (path: string, options: {
    cache: string[]; all: boolean; execute: boolean; confirm?: string; json: boolean;
  }) => {
    if (options.all === (options.cache.length > 0)) {
      throw new Error("Select --all or one or more --cache paths, never both");
    }
    if (options.confirm && !options.execute) {
      throw new Error("--confirm requires --execute; omit both to preview");
    }
    const workspacePath = resolve(path);
    const paths = options.all
      ? (await inventoryRebuildableCaches(workspacePath)).map((cache) => cache.relativePath)
      : options.cache;
    const plan = await planCacheCleanup(workspacePath, paths);
    if (options.execute && options.confirm !== plan.confirmation) {
      throw new Error(`Confirmation does not match. Preview first, then use --confirm '${plan.confirmation}'`);
    }
    const result = options.execute
      ? await executeCacheCleanup(workspacePath, paths)
      : plan;
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if ("removed" in result) {
      process.stdout.write(`Cleaned ${result.removed.length} verified cache directories in ${result.workspacePath}\nAudit: ${result.auditPath}\n`);
    } else {
      process.stdout.write(`Cache cleanup preview: ${plan.workspacePath}\n`);
      for (const cache of plan.caches) {
        process.stdout.write(`  ${cache.relativePath} (${cache.sizeBytes === null ? "unknown size" : `${(cache.sizeBytes / 1e9).toFixed(2)} GB estimated`})\n`);
      }
      process.stdout.write(`No files removed. Confirmation: ${plan.confirmation}\nSizes are estimates; shared files may release less disk space.\n`);
    }
  });

program
  .command("ui")
  .description("open the local VibeVac control dashboard")
  .option("--port <port>", "local port (0 chooses an available port)", portNumber, 0)
  .option("--no-open", "start the dashboard without opening a browser")
  .option(
    "--stale-after <days>",
    "minimum inactivity before suggesting a cleanup candidate",
    positiveInteger,
    14,
  )
  .action(
    async (options: { port: number; open: boolean; staleAfter: number }) => {
      const handle = await startUiServer({
        port: options.port,
        openBrowser: options.open,
        staleAfterDays: options.staleAfter,
      });
      process.stdout.write(
        `VibeVac control center: ${handle.url}\nLocal-only server. Press Ctrl+C to stop.\n`,
      );
      if (handle.openError) {
        process.stderr.write(
          `Browser did not open automatically: ${handle.openError}\n`,
        );
      }
    },
  );

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`VibeVac failed: ${message}\n`);
  process.exitCode = 1;
});
