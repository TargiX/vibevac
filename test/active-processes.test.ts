import { describe, expect, it } from "vitest";

import {
  countProcessesWithin,
  parseLsofWorkingDirectories,
} from "../src/services/active-processes.js";

describe("active process inspection", () => {
  it("counts processes whose working directories are inside a workspace", () => {
    const workingDirectories = parseLsofWorkingDirectories(
      "p10\nfcwd\nn/work/app\np11\nfcwd\nn/work/app/packages/ui\np12\nfcwd\nn/elsewhere\n",
    );

    expect(
      countProcessesWithin(
        { available: true, workingDirectories, error: null },
        "/work/app",
      ),
    ).toBe(2);
  });

  it("returns unknown when lsof was unavailable", () => {
    expect(
      countProcessesWithin(
        { available: false, workingDirectories: new Map(), error: "missing" },
        "/work/app",
      ),
    ).toBeNull();
  });
});
