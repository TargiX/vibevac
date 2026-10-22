import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createSSRApp, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { deriveScanPresentation } from "../ui/src/report-state.js";

let server: ViteDevServer;
let Dock: Component;

beforeAll(async () => {
  server = await createServer({
    configFile: resolve("ui/vite.config.ts"),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  Dock = (await server.ssrLoadModule("/src/components/WorktreeSelectionDock.vue")).default;
});

afterAll(async () => { await server?.close(); });

async function render(props: Record<string, unknown> = {}): Promise<string> {
  return renderToString(createSSRApp(Dock, {
    selectedCount: 2,
    estimatedTotal: "22 GB",
    reportInteractive: true,
    preparing: false,
    removing: false,
    ...props,
  }));
}

function buttons(html: string): string[] {
  return html.match(/<button\b[^>]*>/g) ?? [];
}

describe("selected worktree dock", () => {
  it.each([
    ["initial scan", { loading: true, hasReport: false, refreshFailed: false }],
    ["refresh in progress", { loading: true, hasReport: true, refreshFailed: false }],
    ["failed refresh", { loading: false, hasReport: true, refreshFailed: true }],
    ["missing report", { loading: false, hasReport: false, refreshFailed: false }],
  ] as const)("blocks both actions during %s", async (_name, scan) => {
    const html = await render({ reportInteractive: deriveScanPresentation(scan).reportInteractive });
    expect(buttons(html)).toHaveLength(2);
    for (const button of buttons(html)) expect(button).toMatch(/\bdisabled(?:\s|=|>)/);
  });

  it.each([{ preparing: true }, { removing: true }])("blocks both actions while busy: %j", async (busy) => {
    for (const button of buttons(await render(busy))) expect(button).toMatch(/\bdisabled(?:\s|=|>)/);
  });

  it("allows review and clear for a current, idle report", async () => {
    const html = await render();
    expect(buttons(html)).toHaveLength(2);
    for (const button of buttons(html)) expect(button).not.toMatch(/\bdisabled(?:\s|=|>)/);
    expect(html).toContain("Review 2 selected");
    expect(html).toContain("Clear selection");
  });

  it("shows the supplied total and count after selection changes", async () => {
    const before = await render({ selectedCount: 3, estimatedTotal: "72 GB" });
    const after = await render({ selectedCount: 2, estimatedTotal: "22 GB" });
    expect(before).toContain("72 GB");
    expect(before).toContain("Review 3 selected");
    expect(after).toContain("22 GB");
    expect(after).not.toContain("72 GB");
    expect(after).toContain("Review 2 selected");
  });
});
