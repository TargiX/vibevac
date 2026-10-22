import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";

import type { CommandTimeout } from "../domain/types.js";

export const MAX_RECORDED_TIMEOUTS = 25;

export interface RunCommandOptions {
  timeoutMs: number;
  maxBuffer: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export class CommandTimeoutError extends Error {
  readonly command: string;
  readonly seconds: number;

  constructor(command: string, seconds: number) {
    super(`timed out after ${seconds}s: ${command}`);
    this.name = "CommandTimeoutError";
    this.command = command;
    this.seconds = seconds;
  }
}

export function isCommandTimeout(error: unknown): error is CommandTimeoutError {
  return error instanceof CommandTimeoutError;
}

interface TimeoutScope {
  workspacePath: string | null;
  sink: CommandTimeout[];
}

const timeoutScope = new AsyncLocalStorage<TimeoutScope>();

// Every command started inside `fn` reports its timeouts to `sink`, attributed
// to `workspacePath` (or to the `git -C` directory when no workspace is set).
export function collectTimeouts<T>(
  sink: CommandTimeout[],
  workspacePath: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return timeoutScope.run({ workspacePath, sink }, fn);
}

function describe(program: string, args: string[]): string {
  const visible = args[0] === "-C" ? args.slice(2) : args;
  return [program, ...visible].join(" ");
}

function recordTimeout(program: string, args: string[], seconds: number, cwd?: string): void {
  const scope = timeoutScope.getStore();
  if (!scope || scope.sink.length >= MAX_RECORDED_TIMEOUTS) return;
  scope.sink.push({
    workspacePath: scope.workspacePath ?? (args[0] === "-C" ? args[1] : cwd) ?? "",
    command: describe(program, args),
    seconds,
  });
}

// A hung volume can leave a child in uninterruptible sleep, where it never
// exits after a signal. The timer therefore settles the promise itself instead
// of waiting for the child to close.
export function runCommand(
  program: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(
      program,
      args,
      { encoding: "utf8", maxBuffer: options.maxBuffer, cwd: options.cwd, env: options.env },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      const seconds = options.timeoutMs / 1000;
      recordTimeout(program, args, seconds, options.cwd);
      reject(new CommandTimeoutError(describe(program, args), seconds));
    }, options.timeoutMs);
  });
}
