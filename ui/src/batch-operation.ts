export type BatchItemState = "pending" | "active" | "completed" | "failed";

export type BatchItemStates = Record<string, BatchItemState>;

export function createBatchItemStates(paths: string[]): BatchItemStates {
  return Object.fromEntries(paths.map((path) => [path, "pending" as const]));
}

export function setBatchItemState(
  states: BatchItemStates,
  path: string,
  state: BatchItemState,
): BatchItemStates {
  if (!(path in states)) return states;
  return { ...states, [path]: state };
}

export function batchItemStatusLabel(state: BatchItemState): string {
  if (state === "active") return "Cleaning";
  if (state === "completed") return "Cleaned";
  if (state === "failed") return "Skipped";
  return "Waiting";
}
