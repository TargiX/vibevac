import { describe, expect, it } from "vitest";

import {
  batchItemStatusLabel,
  createBatchItemStates,
  setBatchItemState,
} from "../ui/src/batch-operation.js";

describe("batch operation progress", () => {
  it("starts every workspace in the pending state", () => {
    expect(createBatchItemStates(["/one", "/two"])).toEqual({
      "/one": "pending",
      "/two": "pending",
    });
  });

  it("advances one workspace without changing the other rows", () => {
    const pending = createBatchItemStates(["/one", "/two"]);
    const active = setBatchItemState(pending, "/one", "active");
    const completed = setBatchItemState(active, "/one", "completed");
    const failed = setBatchItemState(completed, "/two", "failed");

    expect(pending).toEqual({ "/one": "pending", "/two": "pending" });
    expect(active).toEqual({ "/one": "active", "/two": "pending" });
    expect(completed).toEqual({ "/one": "completed", "/two": "pending" });
    expect(failed).toEqual({ "/one": "completed", "/two": "failed" });
  });

  it("does not add an item that was not part of the reviewed plan", () => {
    const pending = createBatchItemStates(["/one"]);
    expect(setBatchItemState(pending, "/unknown", "active")).toBe(pending);
  });

  it("provides concise user-facing labels for every state", () => {
    expect(batchItemStatusLabel("pending")).toBe("Waiting");
    expect(batchItemStatusLabel("active")).toBe("Cleaning");
    expect(batchItemStatusLabel("completed")).toBe("Cleaned");
    expect(batchItemStatusLabel("failed")).toBe("Skipped");
  });
});
