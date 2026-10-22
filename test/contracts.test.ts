import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CONTRACT_HEADER, ENGINE_VERSION, cachePlanId, worktreePlanId } from "../src/engine.js";

describe("versioned contracts", () => {
  it("stamps node output with schema version 2 and the package version", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(ENGINE_VERSION).toBe(version);
    expect(CONTRACT_HEADER).toEqual({ schemaVersion: 2, engine: "node", engineVersion: version });
  });

  // The same vectors are asserted in src-tauri/src/core.rs, so both engines
  // write the same planId for the same revalidated plan.
  it("derives planId from the plan identity, independent of selection order", () => {
    expect(cachePlanId("/work/app", ["node_modules", "dist"])).toBe("2b652a38f84fb410");
    expect(cachePlanId("/work/app", ["dist", "node_modules"])).toBe("2b652a38f84fb410");
    expect(worktreePlanId("/work/app", "0123456789abcdef0123456789abcdef01234567")).toBe(
      "d1c2e4bb11feb12b",
    );
  });
});
