<script setup lang="ts">
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  Clock3,
  Database,
  FolderGit2,
  FolderOpen,
  GitMerge,
  HardDrive,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "@lucide/vue";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";

import {
  chooseWorkspaceSource,
  cleanCaches,
  previewBatchCacheCleanup,
  previewCacheCleanup,
  previewWorktreeRemovals,
  removeWorktree,
  scanWorkspaces,
  usesNativeBackend,
} from "./backend";
import {
  batchItemStatusLabel,
  createBatchItemStates,
  setBatchItemState,
  type BatchItemState,
  type BatchItemStates,
} from "./batch-operation";
import {
  activityAgeDays,
  cleanupLevel,
  cleanupLevels,
  cleanupPresentationTone,
  isWorkspaceInCleanupLevel,
  isWorkspaceInWorktreeLevel,
  worktreeRemovalBlocker,
  type CleanupLevelIndex,
  type CleanupScope,
} from "./cleanup-policy";
import {
  applyCacheCleanupResults,
  deriveScanPresentation,
} from "./report-state";
import type {
  CacheCleanupResult,
  CacheCleanupPlan,
  DiscoveryRoot,
  Recommendation,
  ScanReport,
  WorkspaceReport,
  WorkspaceTool,
  WorktreeRemovalPlan,
} from "../../src/domain/types";

type Filter = "all" | "ready" | Recommendation;
type SortKey = "workspace" | "status" | "total" | "reclaimable" | "activity";
type SortDirection = "asc" | "desc";
type CleanupMode = "single" | "batch";

interface CleanupSummary {
  workspaceCount: number;
  removedDirectoryCount: number;
  reclaimedBytes: number;
}

interface WorktreeRemovalSummary {
  worktreeCount: number;
  reclaimedBytes: number;
  preservedBranches: string[];
}

const CUSTOM_ROOTS_KEY = "vibevac.custom-roots.v1";
const CLEANUP_LEVEL_KEY = "vibevac.cleanup-level.v1";
const SCAN_CLASSIFICATION_DAYS = 14;

function loadCustomRoots(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(CUSTOM_ROOTS_KEY) ?? "[]") as unknown;
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? [...new Set(value)]
      : [];
  } catch {
    return [];
  }
}

function loadCleanupLevel(): CleanupLevelIndex {
  const value = Number(localStorage.getItem(CLEANUP_LEVEL_KEY) ?? "1");
  return value >= 0 && value <= 3 ? (value as CleanupLevelIndex) : 1;
}

const report = ref<ScanReport | null>(null);
const loading = ref(true);
const refreshFailed = ref(false);
const scanElapsedSeconds = ref(0);
const error = ref<string | null>(null);
const search = ref("");
const filter = ref<Filter>("all");
const sortKey = ref<SortKey>("reclaimable");
const sortDirection = ref<SortDirection>("desc");
const cleanupScope = ref<CleanupScope>("cache");
const cleanupLevelIndex = ref<CleanupLevelIndex>(loadCleanupLevel());
const expandedPaths = ref(new Set<string>());
const selectedCaches = ref<Record<string, string[]>>({});
const selectedWorktrees = ref(new Set<string>());
const cleanupPlans = ref<CacheCleanupPlan[]>([]);
const cleanupMode = ref<CleanupMode>("single");
const confirmation = ref("");
const previewingCleanup = ref(false);
const cleaning = ref(false);
const cleanupProgress = ref({ completed: 0, total: 0 });
const cleanupItemStates = ref<BatchItemStates>({});
const batchWorkspaceList = ref<HTMLElement | null>(null);
const lastCleanup = ref<CleanupSummary | null>(null);
const worktreePlans = ref<WorktreeRemovalPlan[]>([]);
const worktreeConfirmation = ref("");
const previewingWorktrees = ref(false);
const removingWorktrees = ref(false);
const worktreeProgress = ref({ completed: 0, total: 0 });
const lastWorktreeRemoval = ref<WorktreeRemovalSummary | null>(null);
const sourcesOpen = ref(false);
const pickingSource = ref(false);
const customRoots = ref(loadCustomRoots());
const nativeBackend = usesNativeBackend();
let scanTimer: number | null = null;
let scanInFlight = false;

const recommendationOrder: Record<Recommendation, number> = {
  candidate: 0,
  protect: 1,
  review: 2,
  keep: 3,
};

const scanPresentation = computed(() =>
  deriveScanPresentation({
    loading: loading.value,
    hasReport: report.value !== null,
    refreshFailed: refreshFailed.value,
  }),
);

const currentCleanupLevels = computed(() => cleanupLevels(cleanupScope.value));
const currentCleanupLevel = computed(() =>
  cleanupLevel(cleanupLevelIndex.value, cleanupScope.value),
);
const currentCleanupPresentationTone = computed(() =>
  cleanupPresentationTone(cleanupScope.value, currentCleanupLevel.value),
);

const cacheReadyWorkspaces = computed(() =>
  [...(report.value?.workspaces ?? [])]
    .filter((workspace) => isWorkspaceInCleanupLevel(workspace, currentCleanupLevel.value))
    .sort(
      (left, right) =>
        cachePercent(right) - cachePercent(left) ||
        right.cacheBytes - left.cacheBytes ||
        left.path.localeCompare(right.path),
    ),
);

const worktreeReadyWorkspaces = computed(() =>
  [...(report.value?.workspaces ?? [])]
    .filter((workspace) => isWorkspaceInWorktreeLevel(workspace, currentCleanupLevel.value))
    .sort(
      (left, right) =>
        (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0) ||
        left.path.localeCompare(right.path),
    ),
);

const cleanupReadyWorkspaces = computed(() =>
  cleanupScope.value === "worktree"
    ? worktreeReadyWorkspaces.value
    : cacheReadyWorkspaces.value,
);

const cleanupReadyPaths = computed(
  () => new Set(cleanupReadyWorkspaces.value.map((workspace) => workspace.path)),
);

const worktreeProtectedCount = computed(() =>
  Math.max(0, (report.value?.workspaces.length ?? 0) - worktreeReadyWorkspaces.value.length),
);

const selectedWorktreeWorkspaces = computed(() =>
  worktreeReadyWorkspaces.value.filter((workspace) =>
    selectedWorktrees.value.has(workspace.path),
  ),
);

const cleanupReadyBytes = computed(() =>
  cleanupReadyWorkspaces.value.reduce(
    (total, workspace) =>
      total +
      (cleanupScope.value === "worktree" ? (workspace.sizeBytes ?? 0) : workspace.cacheBytes),
    0,
  ),
);

const selectedWorktreeBytes = computed(() =>
  selectedWorktreeWorkspaces.value.reduce(
    (total, workspace) => total + (workspace.sizeBytes ?? 0),
    0,
  ),
);

const cleanupPlanBytes = computed(() =>
  cleanupPlans.value.reduce((total, plan) => total + plan.reclaimBytes, 0),
);

const cleanupPlanCacheCount = computed(() =>
  cleanupPlans.value.reduce((total, plan) => total + plan.caches.length, 0),
);

const primaryCleanupPlan = computed(() => cleanupPlans.value[0] ?? null);

const cleanupAnnouncement = computed(() => {
  if (!cleaning.value || cleanupProgress.value.total === 0) return "";
  const activePlan = cleanupPlans.value.find(
    (plan) => cleanupItemStates.value[plan.workspacePath] === "active",
  );
  if (activePlan) {
    return `Cleaning ${workspaceName(activePlan.workspacePath)}, ${cleanupProgress.value.completed + 1} of ${cleanupProgress.value.total}`;
  }
  if (cleanupProgress.value.completed === cleanupProgress.value.total) {
    return `Finished processing ${cleanupProgress.value.total} workspaces`;
  }
  return "Preparing workspace cleanup";
});

const requiredConfirmation = computed(() => {
  if (cleanupPlans.value.length === 0) return "";
  if (cleanupMode.value === "single") return cleanupPlans.value[0]?.confirmation ?? "";
  return `CLEAN ${cleanupPlans.value.length} WORKSPACES`;
});

const worktreePlanBytes = computed(() =>
  worktreePlans.value.reduce((total, plan) => total + plan.sizeBytes, 0),
);

const requiredWorktreeConfirmation = computed(() =>
  worktreePlans.value.length > 0
    ? `REMOVE ${worktreePlans.value.length} ${
        worktreePlans.value.length === 1 ? "WORKTREE" : "WORKTREES"
      }`
    : "",
);

function workspaceActivity(workspace: WorkspaceReport): number {
  const timestamp = workspace.git?.lastActivityAt;
  return timestamp ? Date.parse(timestamp) : 0;
}

function compareWorkspaces(left: WorkspaceReport, right: WorkspaceReport): number {
  let comparison = 0;

  if (sortKey.value === "workspace") {
    comparison = workspaceName(left.path).localeCompare(workspaceName(right.path));
  } else if (sortKey.value === "status") {
    comparison =
      recommendationOrder[left.recommendation] - recommendationOrder[right.recommendation];
  } else if (sortKey.value === "total") {
    comparison = cleanupScope.value === "worktree"
      ? left.cacheBytes - right.cacheBytes
      : (left.sizeBytes ?? 0) - (right.sizeBytes ?? 0);
  } else if (sortKey.value === "activity") {
    comparison = workspaceActivity(left) - workspaceActivity(right);
  } else {
    comparison = cleanupScope.value === "worktree"
      ? Number(cleanupReadyPaths.value.has(left.path)) -
          Number(cleanupReadyPaths.value.has(right.path)) ||
        (left.sizeBytes ?? 0) - (right.sizeBytes ?? 0)
      : Number(left.cacheCleanupAllowed) - Number(right.cacheCleanupAllowed) ||
        cachePercent(left) - cachePercent(right) ||
        left.cacheBytes - right.cacheBytes;
  }

  const directed = sortDirection.value === "asc" ? comparison : -comparison;
  return (
    directed ||
    right.cacheBytes - left.cacheBytes ||
    (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0) ||
    left.path.localeCompare(right.path)
  );
}

const filteredWorkspaces = computed(() => {
  const query = search.value.trim().toLowerCase();
  return [...(report.value?.workspaces ?? [])]
    .filter((workspace) => {
      if (filter.value === "all") return true;
      if (filter.value === "ready") {
        return cleanupReadyPaths.value.has(workspace.path);
      }
      return workspace.recommendation === filter.value;
    })
    .filter((workspace) => {
      if (!query) return true;
      return [workspace.path, workspace.git?.branch, workspace.tool]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    })
    .sort(compareWorkspaces);
});

const counts = computed<Record<Recommendation, number>>(() => {
  const result: Record<Recommendation, number> = {
    candidate: 0,
    keep: 0,
    review: 0,
    protect: 0,
  };
  for (const workspace of report.value?.workspaces ?? []) {
    result[workspace.recommendation] += 1;
  }
  return result;
});

const storageSegments = computed(() => {
  const total = Math.max(report.value?.totalSizeBytes ?? 0, 1);
  const cache = report.value?.totalCacheBytes ?? 0;
  return {
    cache: Math.max(0, Math.min(100, (cache / total) * 100)),
    retained: Math.max(0, Math.min(100, ((total - cache) / total) * 100)),
  };
});

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KB";
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function formatAge(timestamp: string | null | undefined): string {
  if (!timestamp) return "Unknown";
  const days = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(timestamp)) / 86_400_000),
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

function formatScanTime(timestamp: string | undefined): string {
  if (!timestamp) return "Not scanned yet";
  return `Scanned ${new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function workspaceName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function workspaceParent(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-2) ?? "Workspace";
}

function compactPath(path: string): string {
  const parts = path.split("/");
  if (path.startsWith("/Users/") && parts.length > 3) {
    return `~/${parts.slice(3).join("/")}`;
  }
  return path;
}

function sourceLabel(root: DiscoveryRoot): string {
  if (root.tool === "codex") return "Codex worktrees";
  if (root.tool === "conductor") return "Conductor workspaces";
  if (root.tool === "openclaw") return "OpenClaw workspace";
  if (root.tool === "projects") return `${workspaceName(root.path)} projects`;
  return workspaceName(root.path);
}

function sourceWorkspaceCount(root: DiscoveryRoot): number {
  return (report.value?.workspaces ?? []).filter(
    (workspace) => workspace.sourcePath === root.path,
  ).length;
}

function workspaceToolLabel(tool: WorkspaceTool): string {
  return {
    codex: "Codex",
    conductor: "Conductor",
    cursor: "Cursor",
    claude: "Claude",
    hermes: "Hermes",
    antigravity: "Antigravity",
    openclaw: "OpenClaw",
    projects: "Project folder",
    custom: "Added folder",
  }[tool];
}

function recommendationLabel(recommendation: Recommendation): string {
  return {
    candidate: "Candidate",
    keep: "Keep",
    review: "Review",
    protect: "Source kept",
  }[recommendation];
}

function cachePercent(workspace: WorkspaceReport): number {
  if (!workspace.sizeBytes || workspace.sizeBytes <= 0) return 0;
  return Math.min(100, (workspace.cacheBytes / workspace.sizeBytes) * 100);
}

function workspaceMeetsWorktreeAge(workspace: WorkspaceReport): boolean {
  const minimumInactiveDays = currentCleanupLevel.value.minimumInactiveDays;
  const age = activityAgeDays(workspace.git?.lastActivityAt);
  return minimumInactiveDays !== null && age !== null && age >= minimumInactiveDays;
}

function setSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === "desc" ? "asc" : "desc";
    return;
  }
  sortKey.value = key;
  sortDirection.value = key === "workspace" || key === "status" ? "asc" : "desc";
}

function sortAriaLabel(key: SortKey, label: string): string {
  if (sortKey.value !== key) return `Sort by ${label}`;
  return `Sorted by ${label}, ${sortDirection.value === "desc" ? "descending" : "ascending"}`;
}

function showCleanupReady(): void {
  filter.value = "ready";
  search.value = "";
  sortKey.value = "reclaimable";
  sortDirection.value = "desc";
}

function showAllWorkspaces(): void {
  filter.value = "all";
  search.value = "";
  sortKey.value = "reclaimable";
  sortDirection.value = "desc";
}

function toggleWorktreeVisibility(): void {
  if (filter.value === "ready") showAllWorkspaces();
  else showCleanupReady();
}

function setCleanupLevel(value: number): void {
  const next = Math.max(
    0,
    Math.min(currentCleanupLevels.value.length - 1, Math.round(value)),
  );
  cleanupLevelIndex.value = next as CleanupLevelIndex;
  localStorage.setItem(CLEANUP_LEVEL_KEY, String(next));
  filter.value = "ready";
  sortKey.value = "reclaimable";
  sortDirection.value = "desc";
  selectedWorktrees.value = new Set();
  worktreePlans.value = [];
  worktreeConfirmation.value = "";
}

function setCleanupScope(scope: CleanupScope): void {
  if (cleanupScope.value === scope) return;
  cleanupScope.value = scope;
  filter.value = "ready";
  search.value = "";
  sortKey.value = "reclaimable";
  sortDirection.value = "desc";
  selectedWorktrees.value = new Set();
  worktreePlans.value = [];
  worktreeConfirmation.value = "";
}

function isWorktreeSelected(path: string): boolean {
  return selectedWorktrees.value.has(path);
}

function toggleWorktreeSelection(path: string): void {
  if (!cleanupReadyPaths.value.has(path)) return;
  const next = new Set(selectedWorktrees.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  selectedWorktrees.value = next;
}

function toggleExpanded(path: string): void {
  const next = new Set(expandedPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expandedPaths.value = next;
}

function selectedFor(workspacePath: string): string[] {
  return selectedCaches.value[workspacePath] ?? [];
}

function toggleCache(workspacePath: string, relativePath: string): void {
  const current = new Set(selectedFor(workspacePath));
  if (current.has(relativePath)) current.delete(relativePath);
  else current.add(relativePath);
  selectedCaches.value = {
    ...selectedCaches.value,
    [workspacePath]: [...current],
  };
}

function selectionBytes(workspace: WorkspaceReport): number {
  const selected = new Set(selectedFor(workspace.path));
  return workspace.caches.reduce(
    (total, cache) =>
      total + (selected.has(cache.relativePath) ? (cache.sizeBytes ?? 0) : 0),
    0,
  );
}

function persistCustomRoots(): void {
  localStorage.setItem(CUSTOM_ROOTS_KEY, JSON.stringify(customRoots.value));
}

async function addSource(): Promise<void> {
  if (!nativeBackend || pickingSource.value) return;
  pickingSource.value = true;
  error.value = null;
  try {
    const path = await chooseWorkspaceSource();
    if (!path || customRoots.value.includes(path)) return;
    customRoots.value = [...customRoots.value, path];
    persistCustomRoots();
    await refresh();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    pickingSource.value = false;
  }
}

async function removeSource(path: string): Promise<void> {
  customRoots.value = customRoots.value.filter((root) => root !== path);
  persistCustomRoots();
  await refresh();
}

function stopScanTimer(): void {
  if (scanTimer !== null) window.clearInterval(scanTimer);
  scanTimer = null;
}

function startScanTimer(): void {
  stopScanTimer();
  scanElapsedSeconds.value = 0;
  scanTimer = window.setInterval(() => {
    scanElapsedSeconds.value += 1;
  }, 1_000);
}

async function refresh(): Promise<void> {
  if (scanInFlight) return;
  scanInFlight = true;
  loading.value = true;
  refreshFailed.value = false;
  error.value = null;
  sourcesOpen.value = false;
  startScanTimer();
  try {
    report.value = await scanWorkspaces(SCAN_CLASSIFICATION_DAYS, customRoots.value);
    refreshFailed.value = false;
  } catch (caught) {
    refreshFailed.value = report.value !== null;
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
    scanInFlight = false;
    stopScanTimer();
  }
}

async function openCleanupReview(
  workspace: WorkspaceReport,
  relativePaths: string[],
): Promise<void> {
  if (relativePaths.length === 0) return;
  error.value = null;
  try {
    const plan = await previewCacheCleanup({
      workspacePath: workspace.path,
      relativePaths,
    });
    cleanupPlans.value = [plan];
    cleanupMode.value = "single";
    confirmation.value = "";
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

async function reviewCleanupLevel(): Promise<void> {
  const workspaces = [...cacheReadyWorkspaces.value];
  if (workspaces.length === 0 || previewingCleanup.value) return;

  previewingCleanup.value = true;
  cleanupProgress.value = { completed: 0, total: workspaces.length };
  error.value = null;

  try {
    const plans = await previewBatchCacheCleanup(
      workspaces.map((workspace) => ({
        workspacePath: workspace.path,
        relativePaths: workspace.caches.map((cache) => cache.relativePath),
      })),
    );
    if (plans.length !== workspaces.length) {
      throw new Error("The preview returned an incomplete workspace plan");
    }

    cleanupProgress.value = { completed: plans.length, total: workspaces.length };
    cleanupPlans.value = plans;
    cleanupMode.value = "batch";
    confirmation.value = "";
  } catch (caught) {
    cleanupPlans.value = [];
    error.value = `Could not prepare the cleanup plan: ${
      caught instanceof Error ? caught.message : String(caught)
    }`;
  } finally {
    previewingCleanup.value = false;
  }
}

async function reviewWorktreeSelection(): Promise<void> {
  const workspaces = [...selectedWorktreeWorkspaces.value];
  const minimumInactiveDays = currentCleanupLevel.value.minimumInactiveDays;
  if (
    workspaces.length === 0 ||
    minimumInactiveDays === null ||
    previewingWorktrees.value
  ) {
    return;
  }

  previewingWorktrees.value = true;
  worktreeProgress.value = { completed: 0, total: workspaces.length };
  error.value = null;

  try {
    const plans = await previewWorktreeRemovals(
      workspaces.map((workspace) => ({
        workspacePath: workspace.path,
        minimumInactiveDays,
      })),
    );
    if (plans.length !== workspaces.length) {
      throw new Error("The preview returned an incomplete worktree plan");
    }

    worktreeProgress.value = { completed: plans.length, total: workspaces.length };
    worktreePlans.value = plans;
    worktreeConfirmation.value = "";
  } catch (caught) {
    worktreePlans.value = [];
    error.value = `Could not prove that every selected worktree is safe to remove: ${
      caught instanceof Error ? caught.message : String(caught)
    }`;
  } finally {
    previewingWorktrees.value = false;
  }
}

async function reviewCurrentScope(): Promise<void> {
  if (cleanupScope.value === "worktree") {
    await reviewWorktreeSelection();
    return;
  }
  await reviewCleanupLevel();
}

async function reviewCleanup(workspace: WorkspaceReport): Promise<void> {
  await openCleanupReview(workspace, selectedFor(workspace.path));
}

async function reviewWorkspaceCleanup(workspace: WorkspaceReport): Promise<void> {
  if (!workspace.cacheCleanupAllowed || workspace.caches.length === 0) {
    toggleExpanded(workspace.path);
    return;
  }
  await openCleanupReview(
    workspace,
    workspace.caches.map((cache) => cache.relativePath),
  );
}

function closeCleanup(): void {
  if (cleaning.value) return;
  cleanupPlans.value = [];
  confirmation.value = "";
  cleanupProgress.value = { completed: 0, total: 0 };
  cleanupItemStates.value = {};
}

function cleanupItemState(path: string): BatchItemState {
  return cleanupItemStates.value[path] ?? "pending";
}

async function revealActiveCleanupItem(): Promise<void> {
  await nextTick();
  batchWorkspaceList.value
    ?.querySelector<HTMLElement>('[data-cleanup-active="true"]')
    ?.scrollIntoView({ block: "nearest" });
}

function closeWorktreeRemoval(): void {
  if (removingWorktrees.value) return;
  worktreePlans.value = [];
  worktreeConfirmation.value = "";
  worktreeProgress.value = { completed: 0, total: 0 };
}

async function executeCleanup(): Promise<void> {
  if (cleanupPlans.value.length === 0 || confirmation.value !== requiredConfirmation.value) {
    return;
  }

  const plans = [...cleanupPlans.value];
  cleaning.value = true;
  error.value = null;
  cleanupProgress.value = { completed: 0, total: plans.length };
  cleanupItemStates.value = createBatchItemStates(
    plans.map((plan) => plan.workspacePath),
  );
  let workspaceCount = 0;
  let removedDirectoryCount = 0;
  let reclaimedBytes = 0;
  const cleanupResults: CacheCleanupResult[] = [];
  const failures: string[] = [];

  try {
    for (const plan of plans) {
      cleanupItemStates.value = setBatchItemState(
        cleanupItemStates.value,
        plan.workspacePath,
        "active",
      );
      await revealActiveCleanupItem();
      try {
        const result = await cleanCaches({
          workspacePath: plan.workspacePath,
          relativePaths: plan.caches.map((cache) => cache.relativePath),
          confirmation: plan.confirmation,
        });
        workspaceCount += 1;
        removedDirectoryCount += result.removed.length;
        reclaimedBytes += result.reclaimedBytes;
        cleanupResults.push(result);
        selectedCaches.value = {
          ...selectedCaches.value,
          [plan.workspacePath]: [],
        };
        cleanupItemStates.value = setBatchItemState(
          cleanupItemStates.value,
          plan.workspacePath,
          "completed",
        );
      } catch (caught) {
        cleanupItemStates.value = setBatchItemState(
          cleanupItemStates.value,
          plan.workspacePath,
          "failed",
        );
        failures.push(
          `${workspaceName(plan.workspacePath)}: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        );
      }
      cleanupProgress.value = {
        completed: cleanupProgress.value.completed + 1,
        total: plans.length,
      };
    }

    lastCleanup.value =
      workspaceCount > 0
        ? { workspaceCount, removedDirectoryCount, reclaimedBytes }
        : null;
    if (report.value && cleanupResults.length > 0) {
      report.value = applyCacheCleanupResults(report.value, cleanupResults);
      refreshFailed.value = false;
    }
    confirmation.value = "";
    cleanupPlans.value = [];
    if (failures.length > 0) {
      error.value = `${failures.length} ${failures.length === 1 ? "workspace was" : "workspaces were"} skipped after revalidation. ${failures.join(" · ")}`;
    }
  } finally {
    cleaning.value = false;
    cleanupProgress.value = { completed: 0, total: 0 };
    cleanupItemStates.value = {};
  }
}

async function executeWorktreeRemoval(): Promise<void> {
  if (
    worktreePlans.value.length === 0 ||
    worktreeConfirmation.value !== requiredWorktreeConfirmation.value
  ) {
    return;
  }

  const plans = [...worktreePlans.value];
  const minimumInactiveDays = currentCleanupLevel.value.minimumInactiveDays;
  if (minimumInactiveDays === null) return;

  removingWorktrees.value = true;
  error.value = null;
  worktreeProgress.value = { completed: 0, total: plans.length };
  let worktreeCount = 0;
  let reclaimedBytes = 0;
  const preservedBranches: string[] = [];
  const failures: string[] = [];

  try {
    for (const plan of plans) {
      try {
        const result = await removeWorktree({
          workspacePath: plan.workspacePath,
          minimumInactiveDays,
          confirmation: plan.confirmation,
        });
        worktreeCount += 1;
        reclaimedBytes += result.reclaimedBytes;
        preservedBranches.push(result.preservedBranch);
      } catch (caught) {
        failures.push(
          `${workspaceName(plan.workspacePath)}: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        );
      }
      worktreeProgress.value = {
        completed: worktreeProgress.value.completed + 1,
        total: plans.length,
      };
    }

    lastWorktreeRemoval.value =
      worktreeCount > 0
        ? { worktreeCount, reclaimedBytes, preservedBranches }
        : null;
    selectedWorktrees.value = new Set();
    worktreePlans.value = [];
    worktreeConfirmation.value = "";
    await refresh();
    if (failures.length > 0) {
      error.value = `${failures.length} ${
        failures.length === 1 ? "worktree was" : "worktrees were"
      } blocked during final revalidation. ${failures.join(" · ")}`;
    }
  } finally {
    removingWorktrees.value = false;
    worktreeProgress.value = { completed: 0, total: 0 };
  }
}

onMounted(refresh);
onUnmounted(stopScanTimer);
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark"><HardDrive :size="17" /></div>
        <div>
          <div class="brand-name">VibeVac</div>
          <div class="brand-subtitle">Workspace storage</div>
        </div>
      </div>

      <div class="topbar-actions">
        <div class="local-pill"><ShieldCheck :size="14" /> On this Mac</div>
        <button class="toolbar-button" :disabled="loading" @click="sourcesOpen = !sourcesOpen">
          <FolderOpen :size="15" />
          Sources
          <span>{{ report?.roots.length ?? "…" }}</span>
        </button>
        <button class="scan-button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spinning: loading }" />
          {{ loading ? "Scanning" : "Scan" }}
        </button>
      </div>
    </header>

    <div v-if="sourcesOpen" class="sources-popover-layer" @click.self="sourcesOpen = false">
      <section class="sources-drawer">
        <div class="sources-heading">
          <div>
            <h2>Workspace sources</h2>
            <p>Only these folders are searched. VibeVac does not scan your whole disk.</p>
          </div>
          <button class="icon-button" aria-label="Close sources" @click="sourcesOpen = false">
            <X :size="16" />
          </button>
        </div>

        <div class="source-list">
          <div v-for="root in report?.roots ?? []" :key="`${root.tool}:${root.path}`" class="source-row">
            <div class="source-icon"><FolderOpen :size="16" /></div>
            <div class="source-copy">
              <strong>{{ sourceLabel(root) }}</strong>
              <span>{{ compactPath(root.path) }}</span>
            </div>
            <div class="source-count">
              {{ sourceWorkspaceCount(root) }}
              {{ sourceWorkspaceCount(root) === 1 ? "workspace" : "workspaces" }}
            </div>
            <span class="source-kind">{{ root.tool === "custom" ? "Added" : "Automatic" }}</span>
            <button
              v-if="root.tool === 'custom'"
              class="remove-source"
              :aria-label="`Remove ${root.path}`"
              @click="removeSource(root.path)"
            >
              <X :size="15" />
            </button>
          </div>
        </div>

        <button v-if="nativeBackend" class="add-source-button" :disabled="pickingSource" @click="addSource">
          <LoaderCircle v-if="pickingSource" :size="15" class="spinning" />
          <Plus v-else :size="15" />
          Add folder
        </button>
        <p class="source-note">
          Project folders are searched for Git repositories. Their registered worktrees are included
          even when an agent created them somewhere else.
        </p>
      </section>
    </div>

    <main>
      <section class="page-heading">
        <div>
          <h1>Workspaces</h1>
          <p v-if="report">
            <template v-if="scanPresentation.phase === 'refreshing'">
              Updating {{ report.workspaces.length }} workspaces · {{ scanElapsedSeconds }}s
            </template>
            <template v-else-if="scanPresentation.phase === 'stale'">
              Previous scan is no longer current
            </template>
            <template v-else>
              {{ report.workspaces.length }} found across {{ report.roots.length }} sources ·
              {{ formatScanTime(report.generatedAt) }}
            </template>
          </p>
          <p v-else>Review local work and rebuildable storage.</p>
        </div>
      </section>

      <div v-if="error" class="notice notice-error">
        <AlertTriangle :size="17" />
        <span>{{ error }}</span>
        <button aria-label="Dismiss error" @click="error = null"><X :size="15" /></button>
      </div>

      <div v-if="lastCleanup" class="notice notice-success">
        <Check :size="17" />
        <span>
          Reclaimed {{ formatBytes(lastCleanup.reclaimedBytes) }} from
          {{ lastCleanup.workspaceCount }}
          {{ lastCleanup.workspaceCount === 1 ? "workspace" : "workspaces" }} by removing
          {{ lastCleanup.removedDirectoryCount }} verified cache
          {{ lastCleanup.removedDirectoryCount === 1 ? "directory" : "directories" }}.
          Source and Git data were preserved.
        </span>
        <button aria-label="Dismiss result" @click="lastCleanup = null"><X :size="15" /></button>
      </div>

      <div v-if="lastWorktreeRemoval" class="notice notice-success">
        <Check :size="17" />
        <span>
          Removed {{ lastWorktreeRemoval.worktreeCount }} linked
          {{ lastWorktreeRemoval.worktreeCount === 1 ? "worktree" : "worktrees" }} and reclaimed
          {{ formatBytes(lastWorktreeRemoval.reclaimedBytes) }}. Preserved
          {{ lastWorktreeRemoval.preservedBranches.length === 1 ? "branch" : "branches" }}:
          {{ lastWorktreeRemoval.preservedBranches.join(", ") }}.
        </span>
        <button aria-label="Dismiss result" @click="lastWorktreeRemoval = null">
          <X :size="15" />
        </button>
      </div>

      <div
        v-if="report && scanPresentation.phase !== 'ready'"
        class="scan-status-card"
        :class="{ failed: scanPresentation.phase === 'stale' }"
      >
        <LoaderCircle
          v-if="scanPresentation.phase === 'refreshing'"
          :size="19"
          class="spinning"
        />
        <AlertTriangle v-else :size="19" />
        <div>
          <strong>
            {{ scanPresentation.phase === "refreshing" ? "Updating results" : "Results are out of date" }}
          </strong>
          <span v-if="scanPresentation.phase === 'refreshing'">
            Rechecking Git state and measuring storage across {{ report.workspaces.length }}
            workspaces · {{ scanElapsedSeconds }}s. Previous totals and cleanup actions are disabled.
          </span>
          <span v-else>
            The last scan did not finish. Run Scan again before reviewing or removing anything.
          </span>
        </div>
        <span class="scan-status-badge">
          {{ scanPresentation.phase === "refreshing" ? "Not current" : "Needs scan" }}
        </span>
      </div>
      <p
        v-if="report && scanPresentation.phase !== 'ready'"
        class="visually-hidden"
        role="status"
        aria-live="polite"
      >
        {{
          scanPresentation.phase === "refreshing"
            ? "Updating results. Previous totals and cleanup actions are disabled."
            : "Results are out of date. Run Scan again before reviewing cleanup."
        }}
      </p>

      <div
        class="report-surface"
        :class="{ 'is-outdated': report && !scanPresentation.reportCurrent }"
        :inert="report && !scanPresentation.reportInteractive ? true : undefined"
      >

      <section
        v-if="report"
        class="cleanup-callout"
        :class="[
          `tone-${currentCleanupPresentationTone}`,
          { 'all-clear': cleanupReadyWorkspaces.length === 0 },
        ]"
      >
        <div class="cleanup-scope-bar">
          <div>
            <strong>Cleanup scope</strong>
            <span>Choose what may enter the review plan.</span>
          </div>
          <div class="scope-segmented" role="radiogroup" aria-label="Cleanup scope">
            <button
              class="cache-scope"
              type="button"
              role="radio"
              :aria-checked="cleanupScope === 'cache'"
              :class="{ active: cleanupScope === 'cache' }"
              @click="setCleanupScope('cache')"
            >
              <Database :size="13" />
              Rebuildable caches
            </button>
            <button
              class="worktree-scope"
              type="button"
              role="radio"
              :aria-checked="cleanupScope === 'worktree'"
              :class="{ active: cleanupScope === 'worktree' }"
              @click="setCleanupScope('worktree')"
            >
              <AlertTriangle :size="13" />
              Entire worktrees
            </button>
          </div>
        </div>

        <div class="cleanup-callout-icon">
          <AlertTriangle v-if="cleanupScope === 'worktree'" :size="22" />
          <ShieldCheck v-else-if="cleanupReadyWorkspaces.length" :size="22" />
          <Check v-else :size="22" />
        </div>
        <div class="cleanup-callout-copy">
          <span>
            {{ cleanupScope === "worktree" ? "Worktree removal" : "Cleanup level" }} ·
            {{ currentCleanupLevel.label }}
          </span>
          <template v-if="cleanupScope === 'cache'">
            <h2 v-if="cleanupReadyWorkspaces.length">
              {{ formatBytes(cleanupReadyBytes) }} across {{ cleanupReadyWorkspaces.length }}
              {{ cleanupReadyWorkspaces.length === 1 ? "workspace" : "workspaces" }}
            </h2>
            <h2 v-else>Nothing matches this cleanup level</h2>
            <p v-if="cleanupReadyWorkspaces.length">
              {{ currentCleanupLevel.description }} Only verified rebuildable storage is included;
              source files and Git history stay untouched.
            </p>
            <p v-else>
              Move the slider right to include more verified caches. Active workspaces remain
              blocked.
            </p>
          </template>
          <template v-else>
            <h2 v-if="selectedWorktreeWorkspaces.length">
              {{ formatBytes(selectedWorktreeBytes) }} selected across
              {{ selectedWorktreeWorkspaces.length }}
              {{ selectedWorktreeWorkspaces.length === 1 ? "worktree" : "worktrees" }}
            </h2>
            <h2 v-else>
              {{ cleanupReadyWorkspaces.length }} of {{ report.workspaces.length }} workspaces are
              eligible
            </h2>
            <p>
              {{ currentCleanupLevel.label }} changes only the age gate to
              {{ currentCleanupLevel.shortLabel }}. Clean, synced, merged, linked-worktree, and
              process checks stay enforced; {{ worktreeProtectedCount }} remain protected.
            </p>
            <button class="worktree-visibility-button" @click="toggleWorktreeVisibility">
              {{
                filter === "ready"
                  ? `Show all ${report.workspaces.length} with reasons`
                  : `Show ${cleanupReadyWorkspaces.length} eligible only`
              }}
              <ArrowRight :size="13" />
            </button>
          </template>
        </div>
        <button
          v-if="cleanupReadyWorkspaces.length"
          class="cleanup-cta-button"
          :disabled="
            cleanupScope === 'worktree'
              ? selectedWorktreeWorkspaces.length === 0 || previewingWorktrees
              : previewingCleanup
          "
          @click="reviewCurrentScope"
        >
          <LoaderCircle
            v-if="previewingCleanup || previewingWorktrees"
            :size="16"
            class="spinning"
          />
          <template v-if="cleanupScope === 'worktree' && previewingWorktrees">
            Proving {{ worktreeProgress.total }}
            {{ worktreeProgress.total === 1 ? "worktree" : "worktrees" }}
          </template>
          <template v-else-if="cleanupScope === 'worktree'">
            {{ selectedWorktreeWorkspaces.length ? `Review ${selectedWorktreeWorkspaces.length} selected` : "Select worktrees" }}
            <ArrowRight :size="16" />
          </template>
          <template v-else-if="previewingCleanup">
            Checking {{ cleanupProgress.total }}
            {{ cleanupProgress.total === 1 ? "workspace" : "workspaces" }}
          </template>
          <template v-else>
            Review cleanup
            <ArrowRight :size="16" />
          </template>
        </button>

        <div
          class="cleanup-level-control"
          :style="{
            '--cleanup-progress': `${(cleanupLevelIndex / (currentCleanupLevels.length - 1)) * 100}%`,
          }"
        >
          <input
            class="cleanup-slider"
            type="range"
            min="0"
            :max="currentCleanupLevels.length - 1"
            step="1"
            :value="cleanupLevelIndex"
            aria-label="Cleanup level"
            :aria-valuetext="`${currentCleanupLevel.label}: ${currentCleanupLevel.shortLabel}`"
            @input="setCleanupLevel(Number(($event.target as HTMLInputElement).value))"
          />
          <div class="cleanup-level-labels">
            <button
              v-for="level in currentCleanupLevels"
              :key="level.index"
              type="button"
              :class="{ active: level.index === cleanupLevelIndex }"
              :aria-label="`Use ${level.label} cleanup: ${level.shortLabel}`"
              @click="setCleanupLevel(level.index)"
            >
              <strong>{{ level.label }}</strong>
              <span>{{ level.shortLabel }}</span>
            </button>
          </div>
        </div>
      </section>

      <section v-if="report" class="summary-grid">
        <article class="metric-card">
          <span>Total workspace storage</span>
          <strong>{{ formatBytes(report.totalSizeBytes) }}</strong>
          <small>{{ report.workspaces.length }} workspaces</small>
        </article>
        <article class="metric-card">
          <span>Rebuildable</span>
          <strong>{{ formatBytes(report.totalCacheBytes) }}</strong>
          <small>Dependencies and generated output</small>
        </article>
        <article class="metric-card">
          <span>Source + Git retained</span>
          <strong>{{ formatBytes(report.retainedSizeBytes) }}</strong>
          <small>Never included in cache cleanup</small>
        </article>
        <article class="storage-card">
          <div>
            <span>Storage composition</span>
            <small>{{ Math.round(storageSegments.cache) }}% rebuildable</small>
          </div>
          <div class="storage-bar" aria-label="Workspace storage composition">
            <div class="storage-segment cache" :style="{ width: `${storageSegments.cache}%` }"></div>
            <div class="storage-segment retained" :style="{ width: `${storageSegments.retained}%` }"></div>
          </div>
        </article>
      </section>

      <div class="content-layout">
        <aside class="sidebar">
          <div class="sidebar-label">Views</div>
          <nav class="filters" aria-label="Workspace recommendations">
            <button
              class="ready-filter"
              :class="{ active: filter === 'ready' }"
              @click="showCleanupReady"
            >
              <Database :size="14" />
              {{ cleanupScope === "worktree" ? "Eligible worktrees" : "Ready to clean" }}
              <strong>{{ cleanupReadyWorkspaces.length }}</strong>
            </button>
            <button :class="{ active: filter === 'all' }" @click="filter = 'all'">
              <span class="status-dot all"></span>
              All workspaces
              <strong>{{ report?.workspaces.length ?? 0 }}</strong>
            </button>
            <button :class="{ active: filter === 'candidate' }" @click="filter = 'candidate'">
              <span class="status-dot candidate"></span>
              Candidates
              <strong>{{ counts.candidate }}</strong>
            </button>
            <button :class="{ active: filter === 'keep' }" @click="filter = 'keep'">
              <span class="status-dot keep"></span>
              Keep
              <strong>{{ counts.keep }}</strong>
            </button>
            <button :class="{ active: filter === 'review' }" @click="filter = 'review'">
              <span class="status-dot review"></span>
              Review
              <strong>{{ counts.review }}</strong>
            </button>
            <button :class="{ active: filter === 'protect' }" @click="filter = 'protect'">
              <span class="status-dot protect"></span>
              Source protected
              <strong>{{ counts.protect }}</strong>
            </button>
          </nav>

          <div class="sidebar-section">
            <div class="sidebar-section-heading">
              <span>Sources</span>
              <button @click="sourcesOpen = true">Manage</button>
            </div>
            <div v-for="root in report?.roots ?? []" :key="root.path" class="sidebar-source">
              <FolderOpen :size="13" />
              <span>{{ sourceLabel(root) }}</span>
              <strong>{{ sourceWorkspaceCount(root) }}</strong>
            </div>
          </div>

          <div class="trust-note">
            <ShieldCheck :size="16" />
            <div>
              <strong>Nothing is removed automatically.</strong>
              <span>Every cleanup is rechecked and confirmed.</span>
            </div>
          </div>
        </aside>

        <section class="workspace-section">
          <div class="list-toolbar">
            <label class="search-field">
              <Search :size="15" />
              <input v-model="search" type="search" placeholder="Search workspace or branch" />
            </label>
            <div class="list-toolbar-status">
              <span v-if="filter === 'ready'">
                <template v-if="cleanupScope === 'worktree'">
                  {{ filteredWorkspaces.length }} eligible · {{ selectedWorktreeWorkspaces.length }}
                  selected · {{ worktreeProtectedCount }} protected
                </template>
                <template v-else>
                  {{ filteredWorkspaces.length }} selected by {{ currentCleanupLevel.label }}
                </template>
              </span>
              <span v-else>{{ filteredWorkspaces.length }} shown</span>
              <button
                v-if="cleanupScope === 'worktree'"
                type="button"
                @click="toggleWorktreeVisibility"
              >
                {{
                  filter === "ready"
                    ? `Show all ${report?.workspaces.length ?? 0}`
                    : `Show ${cleanupReadyWorkspaces.length} eligible`
                }}
              </button>
            </div>
          </div>

          <div class="table-heading">
            <button :aria-label="sortAriaLabel('workspace', 'workspace')" @click="setSort('workspace')">
              Workspace
              <ArrowDown v-if="sortKey === 'workspace' && sortDirection === 'desc'" :size="12" />
              <ArrowUp v-else-if="sortKey === 'workspace'" :size="12" />
              <ArrowUpDown v-else :size="12" />
            </button>
            <button :aria-label="sortAriaLabel('status', 'source status')" @click="setSort('status')">
              Source
              <ArrowDown v-if="sortKey === 'status' && sortDirection === 'desc'" :size="12" />
              <ArrowUp v-else-if="sortKey === 'status'" :size="12" />
              <ArrowUpDown v-else :size="12" />
            </button>
            <button
              :aria-label="
                sortAriaLabel(
                  'total',
                  cleanupScope === 'worktree' ? 'cache inside' : 'total size',
                )
              "
              @click="setSort('total')"
            >
              {{ cleanupScope === "worktree" ? "Cache inside" : "Total" }}
              <ArrowDown v-if="sortKey === 'total' && sortDirection === 'desc'" :size="12" />
              <ArrowUp v-else-if="sortKey === 'total'" :size="12" />
              <ArrowUpDown v-else :size="12" />
            </button>
            <button
              :aria-label="
                sortAriaLabel(
                  'reclaimable',
                  cleanupScope === 'worktree' ? 'removal size' : 'reclaimable percentage',
                )
              "
              @click="setSort('reclaimable')"
            >
              {{ cleanupScope === "worktree" ? "Will remove" : "Reclaimable" }}
              <ArrowDown v-if="sortKey === 'reclaimable' && sortDirection === 'desc'" :size="12" />
              <ArrowUp v-else-if="sortKey === 'reclaimable'" :size="12" />
              <ArrowUpDown v-else :size="12" />
            </button>
            <button :aria-label="sortAriaLabel('activity', 'last used')" @click="setSort('activity')">
              Last used
              <ArrowDown v-if="sortKey === 'activity' && sortDirection === 'desc'" :size="12" />
              <ArrowUp v-else-if="sortKey === 'activity'" :size="12" />
              <ArrowUpDown v-else :size="12" />
            </button>
            <span>Action</span>
            <span></span>
          </div>

          <div v-if="loading && !report" class="loading-panel">
            <LoaderCircle :size="22" class="spinning" />
            <div>
              <strong>Scanning workspace sources</strong>
              <span>Checking Git state, activity, processes, and ignored caches…</span>
            </div>
          </div>

          <div v-else class="workspace-list">
            <article
              v-for="workspace in filteredWorkspaces"
              :key="workspace.path"
              class="workspace-card"
              :class="{
                expanded: expandedPaths.has(workspace.path),
                'cleanup-target':
                  filter === 'ready' &&
                  (cleanupScope === 'cache'
                    ? cleanupReadyPaths.has(workspace.path)
                    : isWorktreeSelected(workspace.path)),
                'worktree-target':
                  cleanupScope === 'worktree' && isWorktreeSelected(workspace.path),
              }"
            >
              <div class="workspace-main">
                <button class="workspace-identity" @click="toggleExpanded(workspace.path)">
                  <div class="workspace-icon"><FolderGit2 :size="16" /></div>
                  <div>
                    <h3>{{ workspaceName(workspace.path) }}</h3>
                    <p>
                      {{ workspaceToolLabel(workspace.tool) }} · {{ workspaceParent(workspace.path) }} ·
                      {{ compactPath(workspace.path) }}
                    </p>
                  </div>
                </button>
                <div class="recommendation" :class="workspace.recommendation">
                  {{ recommendationLabel(workspace.recommendation) }}
                </div>
                <div class="workspace-stat">
                  <strong>
                    {{
                      formatBytes(
                        cleanupScope === "worktree" ? workspace.cacheBytes : workspace.sizeBytes,
                      )
                    }}
                  </strong>
                </div>
                <div class="workspace-stat cache-stat">
                  <strong>
                    {{
                      formatBytes(
                        cleanupScope === "worktree" ? workspace.sizeBytes : workspace.cacheBytes,
                      )
                    }}
                  </strong>
                  <small>
                    {{
                      cleanupScope === "worktree"
                        ? "Entire checkout"
                        : `${Math.round(cachePercent(workspace))}%`
                    }}
                  </small>
                </div>
                <div class="workspace-stat activity-stat">
                  <strong><Clock3 :size="13" /> {{ formatAge(workspace.git?.lastActivityAt) }}</strong>
                </div>
                <label
                  v-if="
                    cleanupScope === 'worktree' && cleanupReadyPaths.has(workspace.path)
                  "
                  class="worktree-row-select"
                  :class="{ selected: isWorktreeSelected(workspace.path) }"
                >
                  <input
                    type="checkbox"
                    :checked="isWorktreeSelected(workspace.path)"
                    @change="toggleWorktreeSelection(workspace.path)"
                  />
                  <span class="checkbox-visual"><Check :size="12" /></span>
                  <span>{{ isWorktreeSelected(workspace.path) ? "Selected" : "Select" }}</span>
                </label>
                <button
                  v-else-if="cleanupScope === 'worktree'"
                  class="row-action blocked"
                  :aria-label="`Show why removal is blocked for ${workspaceName(workspace.path)}`"
                  @click="toggleExpanded(workspace.path)"
                >
                  Why blocked
                </button>
                <button
                  v-else-if="workspace.cacheCleanupAllowed && workspace.cacheBytes > 0"
                  class="row-action ready"
                  :aria-label="`Review ${formatBytes(workspace.cacheBytes)} cleanup in ${workspaceName(workspace.path)}`"
                  @click="reviewWorkspaceCleanup(workspace)"
                >
                  Review
                </button>
                <button
                  v-else-if="cleanupScope === 'cache' && workspace.cacheBytes > 0"
                  class="row-action blocked"
                  :aria-label="`Show why cleanup is blocked for ${workspaceName(workspace.path)}`"
                  @click="toggleExpanded(workspace.path)"
                >
                  Why blocked
                </button>
                <button
                  v-else
                  class="row-action details"
                  :aria-label="`Show details for ${workspaceName(workspace.path)}`"
                  @click="toggleExpanded(workspace.path)"
                >
                  Details
                </button>
                <button
                  class="disclosure-button"
                  :aria-label="`${expandedPaths.has(workspace.path) ? 'Collapse' : 'Expand'} ${workspaceName(workspace.path)}`"
                  :aria-expanded="expandedPaths.has(workspace.path)"
                  @click="toggleExpanded(workspace.path)"
                >
                  <ChevronDown :size="17" class="chevron" />
                </button>
              </div>

              <div v-if="cleanupScope === 'cache'" class="cache-ratio">
                <div :style="{ width: `${cachePercent(workspace)}%` }"></div>
              </div>

              <div v-if="expandedPaths.has(workspace.path)" class="workspace-details">
                <div class="evidence-panel">
                  <h4>Safety evidence</h4>
                  <div class="evidence-row">
                    <GitMerge :size="15" />
                    <span>Branch</span>
                    <strong>{{ workspace.git?.branch ?? "Detached HEAD" }}</strong>
                  </div>
                  <div class="evidence-row">
                    <Check :size="15" />
                    <span>Merged</span>
                    <strong>
                      {{
                        workspace.git?.mergedIntoDefault === true
                          ? `Yes, into ${workspace.git.defaultBranch}`
                          : workspace.git?.mergedIntoDefault === false
                            ? "Not proven"
                            : "Unknown"
                      }}
                    </strong>
                  </div>
                  <div class="evidence-row">
                    <ShieldCheck :size="15" />
                    <span>Local work</span>
                    <strong>
                      {{
                        workspace.git
                          ? `${workspace.git.dirtyEntries} entries · ${workspace.git.ahead ?? "?"} ahead`
                          : "Unknown"
                      }}
                    </strong>
                  </div>
                  <p class="recommendation-reason">{{ workspace.reasons.join("; ") }}</p>
                </div>

                <div v-if="cleanupScope === 'cache'" class="cache-panel">
                  <div class="cache-panel-heading">
                    <div>
                      <h4>Rebuildable cache</h4>
                      <p>Known generated directories that are ignored by Git.</p>
                    </div>
                    <span>{{ workspace.caches.length }} found</span>
                  </div>

                  <div v-if="workspace.caches.length" class="cache-list">
                    <label
                      v-for="cache in workspace.caches"
                      :key="cache.id"
                      class="cache-item"
                      :class="{ disabled: !workspace.cacheCleanupAllowed }"
                    >
                      <input
                        type="checkbox"
                        :checked="selectedFor(workspace.path).includes(cache.relativePath)"
                        :disabled="!workspace.cacheCleanupAllowed"
                        @change="toggleCache(workspace.path, cache.relativePath)"
                      />
                      <span class="checkbox-visual"><Check :size="12" /></span>
                      <span class="cache-copy">
                        <strong>{{ cache.name }}</strong>
                        <small>{{ cache.relativePath }} · {{ cache.rebuildHint }}</small>
                      </span>
                      <strong class="cache-size">{{ formatBytes(cache.sizeBytes) }}</strong>
                    </label>
                  </div>
                  <div v-else class="empty-cache">
                    No verified rebuildable directories were found.
                  </div>

                  <div class="cache-actions">
                    <div>
                      <span>Selected</span>
                      <strong>{{ formatBytes(selectionBytes(workspace)) }}</strong>
                    </div>
                    <button
                      class="primary-button"
                      :disabled="
                        !workspace.cacheCleanupAllowed || selectedFor(workspace.path).length === 0
                      "
                      @click="reviewCleanup(workspace)"
                    >
                      Review cleanup
                    </button>
                  </div>
                  <p v-if="!workspace.cacheCleanupAllowed" class="cleanup-blocker">
                    <AlertTriangle :size="14" /> {{ workspace.cacheCleanupReason }}
                  </p>
                </div>

                <div v-else class="worktree-safety-panel">
                  <div class="cache-panel-heading">
                    <div>
                      <h4>Entire worktree</h4>
                      <p>The checkout can only enter a plan after every proof passes.</p>
                    </div>
                    <span>
                      {{ cleanupReadyPaths.has(workspace.path) ? "Eligible" : "Blocked" }}
                    </span>
                  </div>
                  <div
                    v-if="worktreeRemovalBlocker(workspace, currentCleanupLevel)"
                    class="worktree-blocker-summary"
                  >
                    <AlertTriangle :size="15" />
                    <div>
                      <strong>Blocked because</strong>
                      <span>{{ worktreeRemovalBlocker(workspace, currentCleanupLevel) }}</span>
                    </div>
                  </div>
                  <div class="worktree-proof-list">
                    <div :class="{ failed: workspace.git?.kind !== 'linked-worktree' }">
                      <Check v-if="workspace.git?.kind === 'linked-worktree'" :size="14" />
                      <AlertTriangle v-else :size="14" />
                      <span>Registered linked worktree</span>
                      <strong>{{ workspace.git?.kind === "linked-worktree" ? "Yes" : "No" }}</strong>
                    </div>
                    <div :class="{ failed: !workspace.git?.upstream }">
                      <Check v-if="workspace.git?.upstream" :size="14" />
                      <AlertTriangle v-else :size="14" />
                      <span>Upstream configured</span>
                      <strong>{{ workspace.git?.upstream ?? "No" }}</strong>
                    </div>
                    <div :class="{ failed: workspace.activeProcessCount !== 0 }">
                      <Check v-if="workspace.activeProcessCount === 0" :size="14" />
                      <AlertTriangle v-else :size="14" />
                      <span>No active process</span>
                      <strong>{{ workspace.activeProcessCount === 0 ? "Yes" : "Not proven" }}</strong>
                    </div>
                    <div :class="{ failed: !workspaceMeetsWorktreeAge(workspace) }">
                      <Check v-if="workspaceMeetsWorktreeAge(workspace)" :size="14" />
                      <AlertTriangle v-else :size="14" />
                      <span>Old enough for {{ currentCleanupLevel.label }}</span>
                      <strong>{{ formatAge(workspace.git?.lastActivityAt) }}</strong>
                    </div>
                  </div>
                  <div class="preserved-inline-note">
                    <ShieldCheck :size="15" />
                    <span>Branch, remote refs, and common Git history remain outside the checkout.</span>
                  </div>
                  <p class="cleanup-blocker">
                    <AlertTriangle :size="14" /> A fresh preview also blocks unknown ignored files
                    before removal can be confirmed.
                  </p>
                </div>
              </div>
            </article>

            <div v-if="filteredWorkspaces.length === 0" class="empty-state">
              No workspaces match this view.
            </div>
          </div>
        </section>
      </div>
      </div>
    </main>

    <div v-if="cleanupPlans.length" class="modal-backdrop" @click.self="closeCleanup">
      <section
        class="cleanup-modal"
        :class="{ 'batch-cleanup-modal': cleanupMode === 'batch' }"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cleanup-title"
      >
        <div class="modal-header">
          <div>
            <p>{{ cleanupMode === "batch" ? "Cleanup plan" : "Cleanup review" }}</p>
            <h2 id="cleanup-title">Reclaim {{ formatBytes(cleanupPlanBytes) }}</h2>
          </div>
          <button class="modal-close" aria-label="Close cleanup review" @click="closeCleanup">
            <X :size="17" />
          </button>
        </div>
        <p class="modal-intro">
          VibeVac checked {{ cleanupPlans.length }}
          {{ cleanupPlans.length === 1 ? "workspace" : "workspaces" }} again. Only the verified
          cache directories below are in this plan.
        </p>

        <template v-if="cleanupMode === 'single' && primaryCleanupPlan">
          <div class="modal-workspace">
            <FolderGit2 :size="17" />
            <div>
              <strong>{{ workspaceName(primaryCleanupPlan.workspacePath) }}</strong>
              <span>{{ compactPath(primaryCleanupPlan.workspacePath) }}</span>
            </div>
          </div>

          <div class="modal-cache-list">
            <div v-for="cache in primaryCleanupPlan.caches" :key="cache.id">
              <div>
                <strong>{{ cache.relativePath }}</strong>
                <span>{{ cache.name }}</span>
              </div>
              <strong>{{ formatBytes(cache.sizeBytes) }}</strong>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="batch-summary">
            <div>
              <span>Workspaces</span>
              <strong>{{ cleanupPlans.length }}</strong>
            </div>
            <div>
              <span>Cache directories</span>
              <strong>{{ cleanupPlanCacheCount }}</strong>
            </div>
            <div>
              <span>Selected storage</span>
              <strong>{{ formatBytes(cleanupPlanBytes) }}</strong>
            </div>
          </div>

          <div
            ref="batchWorkspaceList"
            class="batch-workspace-list"
          >
            <div
              v-for="plan in cleanupPlans"
              :key="plan.workspacePath"
              class="batch-workspace-item"
              :class="cleaning ? `state-${cleanupItemState(plan.workspacePath)}` : undefined"
              :data-cleanup-active="
                cleaning && cleanupItemState(plan.workspacePath) === 'active' ? 'true' : undefined
              "
              :aria-label="
                cleaning
                  ? `${workspaceName(plan.workspacePath)}: ${batchItemStatusLabel(cleanupItemState(plan.workspacePath))}`
                  : undefined
              "
            >
              <template v-if="cleaning">
                <LoaderCircle
                  v-if="cleanupItemState(plan.workspacePath) === 'active'"
                  :size="16"
                  class="batch-status-icon spinning"
                />
                <Check
                  v-else-if="cleanupItemState(plan.workspacePath) === 'completed'"
                  :size="16"
                  class="batch-status-icon"
                />
                <AlertTriangle
                  v-else-if="cleanupItemState(plan.workspacePath) === 'failed'"
                  :size="16"
                  class="batch-status-icon"
                />
                <Clock3 v-else :size="16" class="batch-status-icon" />
              </template>
              <FolderGit2 v-else :size="16" />
              <div>
                <strong>{{ workspaceName(plan.workspacePath) }}</strong>
                <span>
                  {{ compactPath(plan.workspacePath) }} · {{ plan.caches.length }}
                  {{ plan.caches.length === 1 ? "cache" : "caches" }}
                </span>
              </div>
              <div class="batch-workspace-trailing">
                <strong>{{ formatBytes(plan.reclaimBytes) }}</strong>
                <span v-if="cleaning" class="batch-item-status">
                  {{ batchItemStatusLabel(cleanupItemState(plan.workspacePath)) }}
                </span>
              </div>
            </div>
          </div>
          <p class="visually-hidden" role="status" aria-live="polite">
            {{ cleanupAnnouncement }}
          </p>
        </template>

        <div class="preservation-note">
          <ShieldCheck :size="17" />
          <div>
            <strong>Source files and Git history stay untouched.</strong>
            <span>Every workspace is revalidated once more immediately before removal.</span>
          </div>
        </div>

        <label class="confirmation-field">
          Type <code>{{ requiredConfirmation }}</code> to confirm
          <input
            v-model="confirmation"
            autocomplete="off"
            spellcheck="false"
            :placeholder="requiredConfirmation"
          />
        </label>

        <div class="modal-actions">
          <button class="secondary-button" :disabled="cleaning" @click="closeCleanup">
            Cancel
          </button>
          <button
            class="danger-button"
            :disabled="confirmation !== requiredConfirmation || cleaning"
            @click="executeCleanup"
          >
            <LoaderCircle v-if="cleaning" :size="15" class="spinning" />
            <Trash2 v-else :size="15" />
            <template v-if="cleaning">
              {{ cleanupProgress.completed === cleanupProgress.total ? "Finishing" : "Cleaning" }}
              {{ cleanupProgress.completed }}/{{ cleanupProgress.total }}
            </template>
            <template v-else>Remove verified caches</template>
          </button>
        </div>
      </section>
    </div>

    <div
      v-if="worktreePlans.length"
      class="modal-backdrop"
      @click.self="closeWorktreeRemoval"
    >
      <section
        class="cleanup-modal batch-cleanup-modal worktree-removal-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="worktree-removal-title"
      >
        <div class="modal-header">
          <div>
            <p>Entire worktree review</p>
            <h2 id="worktree-removal-title">
              Remove {{ worktreePlans.length }} linked
              {{ worktreePlans.length === 1 ? "worktree" : "worktrees" }}
            </h2>
          </div>
          <button
            class="modal-close"
            aria-label="Close worktree removal review"
            @click="closeWorktreeRemoval"
          >
            <X :size="17" />
          </button>
        </div>
        <p class="modal-intro">
          VibeVac independently rechecked every selection. This plan removes each entire checkout,
          including its verified rebuildable storage, while retaining the shared repository.
        </p>

        <div class="batch-summary worktree-summary">
          <div>
            <span>Worktrees</span>
            <strong>{{ worktreePlans.length }}</strong>
          </div>
          <div>
            <span>Selected storage</span>
            <strong>{{ formatBytes(worktreePlanBytes) }}</strong>
          </div>
          <div>
            <span>Branches preserved</span>
            <strong>{{ worktreePlans.length }}</strong>
          </div>
        </div>

        <div class="batch-workspace-list worktree-plan-list">
          <div v-for="plan in worktreePlans" :key="plan.workspacePath">
            <FolderGit2 :size="16" />
            <div>
              <strong>{{ workspaceName(plan.workspacePath) }}</strong>
              <span>
                {{ plan.branch }} · {{ plan.inactiveDays }} days inactive ·
                {{ compactPath(plan.workspacePath) }}
              </span>
            </div>
            <strong>{{ formatBytes(plan.sizeBytes) }}</strong>
          </div>
        </div>

        <div class="worktree-removal-warning">
          <AlertTriangle :size="18" />
          <div>
            <strong>The full checkout directories will disappear.</strong>
            <span>
              This includes tracked source copies and verified ignored caches inside them. Files
              with unproven safety would have blocked this preview.
            </span>
          </div>
        </div>

        <div class="preservation-note">
          <ShieldCheck :size="17" />
          <div>
            <strong>Branches, remotes, and common Git history stay.</strong>
            <span>
              Removal uses Git’s worktree command. Every selection is revalidated once more before
              anything changes.
            </span>
          </div>
        </div>

        <label class="confirmation-field">
          Type <code>{{ requiredWorktreeConfirmation }}</code> to confirm
          <input
            v-model="worktreeConfirmation"
            autocomplete="off"
            spellcheck="false"
            :placeholder="requiredWorktreeConfirmation"
          />
        </label>

        <div class="modal-actions">
          <button
            class="secondary-button"
            :disabled="removingWorktrees"
            @click="closeWorktreeRemoval"
          >
            Cancel
          </button>
          <button
            class="danger-button worktree-danger-button"
            :disabled="
              worktreeConfirmation !== requiredWorktreeConfirmation || removingWorktrees
            "
            @click="executeWorktreeRemoval"
          >
            <LoaderCircle v-if="removingWorktrees" :size="15" class="spinning" />
            <Trash2 v-else :size="15" />
            <template v-if="removingWorktrees">
              Removing {{ worktreeProgress.completed }}/{{ worktreeProgress.total }}
            </template>
            <template v-else>Remove entire worktrees</template>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
