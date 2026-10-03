import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { previewBatchCacheCleanup, previewWorktreeRemovals, removeWorktree } from "../ui/src/backend.js";

afterEach(() => vi.unstubAllGlobals());

function previewResponses() {
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const blocked = request.workspacePath === "/active";
    return {
      ok: !blocked,
      json: async () => blocked
        ? { error: "Cleanup blocked: 4 running processes are using this workspace" }
        : { workspacePath: request.workspacePath, confirmation: "CLEAN idle" },
    };
  }));
}

describe("batch preview isolation", () => {
  it("sends explicit force opt-in and reviewed risks through the browser backend", async () => {
    previewResponses();
    const request = { workspacePath: "/idle", minimumInactiveDays: 14, force: true };
    await previewWorktreeRemovals([request]);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual(request);
    const execution = { ...request, confirmation: "FORCE REMOVE idle", reviewedHead: "abc", reviewedWarnings: ["Local work will be lost."] };
    await removeWorktree(execution);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))).toEqual(execution);
  });
  it("keeps idle cache plans when another workspace becomes active after scanning", async () => {
    previewResponses();
    const result = await previewBatchCacheCleanup([
      { workspacePath: "/idle", relativePaths: ["node_modules"] },
      { workspacePath: "/active", relativePaths: ["node_modules"] },
      { workspacePath: "/also-idle", relativePaths: [".next"] },
    ]);
    expect(result).toMatchObject({
      plans: [{ workspacePath: "/idle" }, { workspacePath: "/also-idle" }],
      skipped: [{ workspacePath: "/active", reason: expect.stringContaining("4 running processes") }],
    });
  });

  it("reports all blocked selections without creating a removal plan", async () => {
    previewResponses();
    const result = await previewWorktreeRemovals([
      { workspacePath: "/active", minimumInactiveDays: 14 },
    ]);
    expect(result.plans).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it("keeps removable worktrees when one selected worktree becomes active", async () => {
    previewResponses();
    const result = await previewWorktreeRemovals([
      { workspacePath: "/active", minimumInactiveDays: 14 },
      { workspacePath: "/idle", minimumInactiveDays: 14 },
    ]);
    expect(result).toMatchObject({
      plans: [{ workspacePath: "/idle" }],
      skipped: [{ workspacePath: "/active", reason: expect.stringContaining("4 running processes") }],
    });
  });
});
