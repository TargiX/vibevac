#!/usr/bin/env node

import { Command, Option } from "commander";
import { resolve } from "node:path";

import { customDiscoveryRoots, defaultDiscoveryRoots } from "./services/discovery.js";
import { renderHumanReport, renderWorkspaceInspection } from "./render/report.js";
import { startUiServer } from "./server/ui-server.js";
import { scanWorkspaces } from "./services/scanner.js";

interface ScanCommandOptions {
  root: string[];
  json: boolean;
  size: boolean;
  staleAfter: number;
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
    const report = await scanWorkspaces(roots, {
      includeSize: options.size,
      staleAfterDays: options.staleAfter,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    process.stdout.write(`${renderHumanReport(report)}\n`);
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
      const workspacePath = resolve(path);
      const report = await scanWorkspaces(
        [{ tool: "custom", path: workspacePath, maxDepth: 0 }],
        {
          includeSize: options.size,
          staleAfterDays: options.staleAfter,
        },
      );
      const workspace = report.workspaces[0];

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
