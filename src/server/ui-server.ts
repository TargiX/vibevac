import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { DiscoveryRoot } from "../domain/types.js";
import {
  executeCacheCleanup,
  planCacheCleanup,
} from "../services/cache-cleanup.js";
import {
  customDiscoveryRoots,
  defaultDiscoveryRoots,
} from "../services/discovery.js";
import { scanWorkspaces } from "../services/scanner.js";
import {
  executeWorktreeRemoval,
  planWorktreeRemoval,
} from "../services/worktree-removal.js";

interface UiServerOptions {
  port?: number;
  openBrowser?: boolean;
  staleAfterDays?: number;
  roots?: DiscoveryRoot[];
  staticDirectory?: string;
  auditPath?: string;
}

export interface UiServerHandle {
  url: string;
  token: string;
  openError: string | null;
  close: () => Promise<void>;
}

interface CleanupBody {
  workspacePath?: unknown;
  relativePaths?: unknown;
  confirmation?: unknown;
  minimumInactiveDays?: unknown;
}

function parseWorktreeRemoval(body: CleanupBody): {
  workspacePath: string;
  minimumInactiveDays: number;
} {
  if (
    typeof body.workspacePath !== "string" ||
    typeof body.minimumInactiveDays !== "number" ||
    !Number.isInteger(body.minimumInactiveDays)
  ) {
    throw new Error("Invalid worktree removal request");
  }
  return {
    workspacePath: body.workspacePath,
    minimumInactiveDays: body.minimumInactiveDays,
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function defaultStaticDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const bundledPath = resolve(moduleDirectory, "ui");
  const workspaceBuildPath = resolve(process.cwd(), "dist/ui");
  return bundledPath.endsWith(`${sep}dist${sep}ui`) ? bundledPath : workspaceBuildPath;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonBody(request: IncomingMessage): Promise<CleanupBody> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_000_000) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as CleanupBody) : {};
}

function parseCleanupSelection(body: CleanupBody): {
  workspacePath: string;
  relativePaths: string[];
} {
  if (
    typeof body.workspacePath !== "string" ||
    !Array.isArray(body.relativePaths) ||
    !body.relativePaths.every((path) => typeof path === "string")
  ) {
    throw new Error("Invalid cleanup selection");
  }
  return {
    workspacePath: body.workspacePath,
    relativePaths: body.relativePaths,
  };
}

async function serveStatic(
  requestPath: string,
  response: ServerResponse,
  staticDirectory: string,
  token: string,
): Promise<void> {
  const requestedPath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const resolvedPath = resolve(staticDirectory, requestedPath);
  if (
    resolvedPath !== staticDirectory &&
    !resolvedPath.startsWith(`${staticDirectory}${sep}`)
  ) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  let filePath = resolvedPath;
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = resolve(filePath, "index.html");
    }
  } catch {
    filePath = resolve(staticDirectory, "index.html");
  }

  try {
    let content = await readFile(filePath);
    if (filePath.endsWith("index.html")) {
      content = Buffer.from(
        content.toString("utf8").replaceAll("__VIBEVAC_TOKEN__", token),
        "utf8",
      );
    }
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": filePath.endsWith("index.html")
        ? "no-store"
        : "public, max-age=31536000, immutable",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "UI asset not found" });
  }
}

export async function startUiServer(
  options: UiServerOptions = {},
): Promise<UiServerHandle> {
  const staticDirectory = options.staticDirectory ?? defaultStaticDirectory();
  await access(resolve(staticDirectory, "index.html"));
  const token = randomBytes(24).toString("hex");
  const roots = options.roots ?? defaultDiscoveryRoots();
  let serverUrl = "";

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", serverUrl || "http://127.0.0.1");

    try {
      if (request.method === "GET" && requestUrl.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, localOnly: true });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/scan") {
        const requestedThreshold = Number.parseInt(
          requestUrl.searchParams.get("staleAfter") ?? "",
          10,
        );
        const staleAfterDays =
          Number.isInteger(requestedThreshold) && requestedThreshold > 0
            ? requestedThreshold
            : options.staleAfterDays ?? 14;
        sendJson(
          response,
          200,
          await scanWorkspaces(
            [
              ...roots,
              ...customDiscoveryRoots(requestUrl.searchParams.getAll("root")),
            ],
            { staleAfterDays },
          ),
        );
        return;
      }

      if (
        request.method === "POST" &&
        (requestUrl.pathname === "/api/cache/preview" ||
          requestUrl.pathname === "/api/cache/clean")
      ) {
        if (
          request.headers["x-vibevac-token"] !== token ||
          (request.headers.origin && request.headers.origin !== serverUrl)
        ) {
          sendJson(response, 403, { error: "Invalid local UI session" });
          return;
        }

        const body = await readJsonBody(request);
        const selection = parseCleanupSelection(body);
        const plan = await planCacheCleanup(
          selection.workspacePath,
          selection.relativePaths,
        );

        if (requestUrl.pathname === "/api/cache/preview") {
          sendJson(response, 200, plan);
          return;
        }

        if (body.confirmation !== plan.confirmation) {
          sendJson(response, 409, {
            error: "Confirmation text does not match the revalidated cleanup plan",
            confirmation: plan.confirmation,
          });
          return;
        }

        sendJson(
          response,
          200,
          await executeCacheCleanup(
            selection.workspacePath,
            selection.relativePaths,
            { auditPath: options.auditPath },
          ),
        );
        return;
      }

      if (
        request.method === "POST" &&
        (requestUrl.pathname === "/api/worktree/preview" ||
          requestUrl.pathname === "/api/worktree/remove")
      ) {
        if (
          request.headers["x-vibevac-token"] !== token ||
          (request.headers.origin && request.headers.origin !== serverUrl)
        ) {
          sendJson(response, 403, { error: "Invalid local UI session" });
          return;
        }

        const body = await readJsonBody(request);
        const selection = parseWorktreeRemoval(body);
        const plan = await planWorktreeRemoval(selection);

        if (requestUrl.pathname === "/api/worktree/preview") {
          sendJson(response, 200, plan);
          return;
        }

        if (body.confirmation !== plan.confirmation) {
          sendJson(response, 409, {
            error: "Confirmation text does not match the revalidated worktree plan",
            confirmation: plan.confirmation,
          });
          return;
        }

        sendJson(
          response,
          200,
          await executeWorktreeRemoval(
            { ...selection, confirmation: body.confirmation },
            { auditPath: options.auditPath },
          ),
        );
        return;
      }

      if (requestUrl.pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "API route not found" });
        return;
      }

      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      await serveStatic(requestUrl.pathname, response, staticDirectory, token);
    } catch (error) {
      sendJson(response, 400, { error: errorMessage(error) });
    }
  });

  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListening();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine local UI address");
  }
  serverUrl = `http://127.0.0.1:${address.port}`;

  let openError: string | null = null;
  if (options.openBrowser ?? true) {
    try {
      const { default: open } = await import("open");
      await open(serverUrl);
    } catch (error) {
      openError = errorMessage(error);
    }
  }

  return {
    url: serverUrl,
    token,
    openError,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolveClose();
        });
      }),
  };
}
