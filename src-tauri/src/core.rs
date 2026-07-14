use chrono::{DateTime, SecondsFormat, Utc};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

const DAY_IN_SECONDS: i64 = 86_400;
const CACHE_MAX_DEPTH: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum WorkspaceTool {
    Codex,
    Conductor,
    Cursor,
    Claude,
    Hermes,
    Antigravity,
    Openclaw,
    Projects,
    Custom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum WorkspaceKind {
    LinkedWorktree,
    StandaloneRepository,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum DataSafety {
    Recoverable,
    LocalOnly,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Recommendation {
    Candidate,
    Keep,
    Review,
    Protect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum CacheKind {
    Dependencies,
    FrameworkBuild,
    BuildOutput,
    TestOutput,
    ToolCache,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheEntry {
    id: String,
    path: String,
    relative_path: String,
    name: String,
    kind: CacheKind,
    size_bytes: Option<u64>,
    size_error: Option<String>,
    ignored_by_git: bool,
    rebuild_hint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryRoot {
    tool: WorkspaceTool,
    path: String,
    max_depth: u8,
}

#[derive(Clone, Debug)]
struct WorkspaceCandidate {
    tool: WorkspaceTool,
    path: PathBuf,
    source_path: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitInspection {
    kind: WorkspaceKind,
    branch: Option<String>,
    head: String,
    upstream: Option<String>,
    ahead: Option<u64>,
    behind: Option<u64>,
    dirty_entries: u64,
    untracked_entries: u64,
    remote_contains_head: bool,
    default_branch: Option<String>,
    merged_into_default: Option<bool>,
    last_commit_at: Option<String>,
    last_activity_at: Option<String>,
}

#[derive(Clone, Debug)]
struct Classification {
    data_safety: DataSafety,
    recommendation: Recommendation,
    reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceReport {
    tool: WorkspaceTool,
    path: String,
    source_path: String,
    data_safety: DataSafety,
    recommendation: Recommendation,
    reasons: Vec<String>,
    size_bytes: Option<u64>,
    size_error: Option<String>,
    git: Option<GitInspection>,
    inspection_error: Option<String>,
    active_process_count: Option<u64>,
    caches: Vec<CacheEntry>,
    cache_bytes: u64,
    retained_size_bytes: Option<u64>,
    cache_cleanup_allowed: bool,
    cache_cleanup_reason: Option<String>,
    cache_inspection_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanReport {
    generated_at: String,
    roots: Vec<DiscoveryRoot>,
    workspaces: Vec<WorkspaceReport>,
    total_size_bytes: u64,
    total_cache_bytes: u64,
    reclaimable_cache_bytes: u64,
    retained_size_bytes: u64,
    candidate_size_bytes: u64,
    stale_after_days: u64,
    process_check_available: bool,
    process_check_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupRequest {
    workspace_path: String,
    relative_paths: Vec<String>,
    #[serde(default)]
    confirmation: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheCleanupPlan {
    workspace_path: String,
    caches: Vec<CacheEntry>,
    reclaim_bytes: u64,
    confirmation: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemovedCache {
    relative_path: String,
    size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheCleanupResult {
    workspace_path: String,
    removed: Vec<RemovedCache>,
    reclaimed_bytes: u64,
    completed_at: String,
    audit_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeRemovalRequest {
    workspace_path: String,
    minimum_inactive_days: u64,
    #[serde(default)]
    confirmation: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeRemovalPlan {
    workspace_path: String,
    size_bytes: u64,
    branch: String,
    head: String,
    upstream: String,
    default_branch: String,
    last_activity_at: String,
    inactive_days: u64,
    common_git_directory: String,
    reconstruction_command: String,
    confirmation: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeRemovalResult {
    workspace_path: String,
    reclaimed_bytes: u64,
    preserved_branch: String,
    reconstruction_command: String,
    completed_at: String,
    audit_path: String,
}

#[derive(Clone, Debug)]
struct ActiveProcessSnapshot {
    available: bool,
    working_directories: BTreeMap<PathBuf, u64>,
    error: Option<String>,
}

#[derive(Clone, Copy)]
struct CacheDefinition {
    kind: CacheKind,
    name: &'static str,
    rebuild_hint: &'static str,
    requires_node_lockfile: bool,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn timestamp_iso(seconds: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn command_error(program: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if stderr.is_empty() {
        format!("{program} exited with status {}", output.status)
    } else {
        stderr
    }
}

fn run_git_output(workspace_path: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(workspace_path)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|error| format!("Could not run Git: {error}"))
}

fn run_git(workspace_path: &Path, args: &[&str]) -> Result<String, String> {
    let output = run_git_output(workspace_path, args)?;
    if !output.status.success() {
        return Err(command_error("git", &output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn try_git(workspace_path: &Path, args: &[&str]) -> Option<String> {
    run_git(workspace_path, args).ok()
}

fn git_succeeds(workspace_path: &Path, args: &[&str]) -> bool {
    run_git_output(workspace_path, args)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn modified_seconds(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
}

fn resolve_default_branch(workspace_path: &Path, upstream: Option<&str>) -> Option<String> {
    let remote = upstream
        .and_then(|value| value.split('/').next())
        .filter(|value| !value.is_empty())
        .unwrap_or("origin");
    let remote_head_ref = format!("refs/remotes/{remote}/HEAD");
    if let Some(remote_head) = try_git(
        workspace_path,
        &["symbolic-ref", "--quiet", "--short", &remote_head_ref],
    ) {
        if !remote_head.is_empty() {
            return Some(remote_head);
        }
    }

    for branch in [format!("{remote}/main"), format!("{remote}/master")] {
        let branch_ref = format!("refs/remotes/{branch}");
        if git_succeeds(workspace_path, &["show-ref", "--verify", &branch_ref]) {
            return Some(branch);
        }
    }
    None
}

fn parse_ahead_behind(output: Option<String>) -> (Option<u64>, Option<u64>) {
    let Some(output) = output else {
        return (None, None);
    };
    let mut values = output.split_whitespace();
    let ahead = values.next().and_then(|value| value.parse::<u64>().ok());
    let behind = values.next().and_then(|value| value.parse::<u64>().ok());
    if ahead.is_some() && behind.is_some() {
        (ahead, behind)
    } else {
        (None, None)
    }
}

fn inspect_git(workspace_path: &Path) -> Result<GitInspection, String> {
    run_git(workspace_path, &["rev-parse", "--is-inside-work-tree"])?;

    let git_metadata = fs::symlink_metadata(workspace_path.join(".git"))
        .map_err(|error| format!("Could not inspect .git: {error}"))?;
    let kind = if git_metadata.file_type().is_file() {
        WorkspaceKind::LinkedWorktree
    } else {
        WorkspaceKind::StandaloneRepository
    };
    let raw_status = run_git_output(workspace_path, &["status", "--porcelain=v1", "-z"])?;
    if !raw_status.status.success() {
        return Err(command_error("git", &raw_status));
    }
    let status_entries: Vec<&[u8]> = raw_status
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .collect();
    let branch = try_git(
        workspace_path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .filter(|value| !value.is_empty());
    let head = run_git(workspace_path, &["rev-parse", "HEAD"])?;
    let upstream = try_git(
        workspace_path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .filter(|value| !value.is_empty());
    let (ahead, behind) = upstream
        .as_deref()
        .map(|upstream_name| {
            let comparison = format!("HEAD...{upstream_name}");
            parse_ahead_behind(try_git(
                workspace_path,
                &["rev-list", "--left-right", "--count", &comparison],
            ))
        })
        .unwrap_or((None, None));
    let remote_refs = try_git(
        workspace_path,
        &[
            "branch",
            "--remotes",
            "--contains",
            "HEAD",
            "--format=%(refname:short)",
        ],
    );
    let commit_seconds = try_git(workspace_path, &["log", "-1", "--format=%ct"])
        .and_then(|value| value.parse::<i64>().ok());
    let default_branch = resolve_default_branch(workspace_path, upstream.as_deref());
    let merged_into_default = default_branch.as_deref().map(|branch_name| {
        git_succeeds(
            workspace_path,
            &["merge-base", "--is-ancestor", "HEAD", branch_name],
        )
    });
    let index_path = try_git(workspace_path, &["rev-parse", "--git-path", "index"])
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                workspace_path.join(path)
            }
        });
    let last_activity_seconds = [
        modified_seconds(workspace_path),
        index_path.as_deref().and_then(modified_seconds),
        commit_seconds,
    ]
    .into_iter()
    .flatten()
    .max();

    Ok(GitInspection {
        kind,
        branch,
        head,
        upstream,
        ahead,
        behind,
        dirty_entries: status_entries.len() as u64,
        untracked_entries: status_entries
            .iter()
            .filter(|entry| entry.starts_with(b"??"))
            .count() as u64,
        remote_contains_head: remote_refs
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty()),
        default_branch,
        merged_into_default,
        last_commit_at: commit_seconds.and_then(timestamp_iso),
        last_activity_at: last_activity_seconds.and_then(timestamp_iso),
    })
}

fn inspect_active_processes() -> ActiveProcessSnapshot {
    match Command::new("lsof")
        .args(["-a", "-d", "cwd", "-Fpn"])
        .output()
    {
        Ok(output) if output.status.success() => {
            let mut working_directories = BTreeMap::new();
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if let Some(path) = line.strip_prefix('n').filter(|value| !value.is_empty()) {
                    *working_directories.entry(PathBuf::from(path)).or_insert(0) += 1;
                }
            }
            ActiveProcessSnapshot {
                available: true,
                working_directories,
                error: None,
            }
        }
        Ok(output) => ActiveProcessSnapshot {
            available: false,
            working_directories: BTreeMap::new(),
            error: Some(command_error("lsof", &output)),
        },
        Err(error) => ActiveProcessSnapshot {
            available: false,
            working_directories: BTreeMap::new(),
            error: Some(format!("Could not run lsof: {error}")),
        },
    }
}

fn count_processes_within(snapshot: &ActiveProcessSnapshot, workspace_path: &Path) -> Option<u64> {
    snapshot.available.then(|| {
        snapshot
            .working_directories
            .iter()
            .filter(|(working_directory, _)| working_directory.starts_with(workspace_path))
            .map(|(_, count)| count)
            .sum()
    })
}

fn default_discovery_roots() -> Result<Vec<DiscoveryRoot>, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Could not determine the home directory".to_owned())?;
    let candidates = [
        (WorkspaceTool::Codex, ".codex/worktrees", 3),
        (WorkspaceTool::Conductor, "conductor/workspaces", 3),
        (WorkspaceTool::Projects, "Code", 4),
        (WorkspaceTool::Projects, "Developer", 4),
        (WorkspaceTool::Projects, "Projects", 4),
        (WorkspaceTool::Projects, "repos", 4),
        (WorkspaceTool::Projects, "src", 4),
        (WorkspaceTool::Projects, "workspace", 4),
        (WorkspaceTool::Projects, "workspaces", 4),
        (WorkspaceTool::Openclaw, ".openclaw/workspace", 0),
    ];
    Ok(candidates
        .into_iter()
        .filter_map(|(tool, relative_path, max_depth)| {
            let path = home.join(relative_path);
            path.exists().then(|| DiscoveryRoot {
                tool,
                path: path.to_string_lossy().into_owned(),
                max_depth,
            })
        })
        .collect())
}

fn discovery_roots(custom_roots: Vec<String>) -> Result<Vec<DiscoveryRoot>, String> {
    let mut roots = default_discovery_roots()?;
    let mut seen: BTreeSet<PathBuf> = roots.iter().map(|root| PathBuf::from(&root.path)).collect();

    for custom_root in custom_roots {
        let requested_path = PathBuf::from(custom_root);
        if !requested_path.is_absolute() {
            continue;
        }
        let path = fs::canonicalize(&requested_path).unwrap_or(requested_path);
        if seen.insert(path.clone()) {
            roots.push(DiscoveryRoot {
                tool: WorkspaceTool::Custom,
                path: path.to_string_lossy().into_owned(),
                max_depth: 4,
            });
        }
    }

    Ok(roots)
}

fn infer_workspace_tool(
    path: &Path,
    branch: Option<&str>,
    fallback: WorkspaceTool,
) -> WorkspaceTool {
    let normalized_path = path.to_string_lossy().to_lowercase();
    let normalized_branch = branch.unwrap_or_default().to_lowercase();
    if normalized_path.contains("/.codex/worktrees/") {
        WorkspaceTool::Codex
    } else if normalized_path.contains("/conductor/workspaces/") {
        WorkspaceTool::Conductor
    } else if normalized_path.contains("/.claude/worktrees/")
        || normalized_branch.contains("/claude/")
    {
        WorkspaceTool::Claude
    } else if normalized_path.contains("/.cursor/") || normalized_branch.contains("/cursor/") {
        WorkspaceTool::Cursor
    } else if normalized_path.contains("/.hermes/") || normalized_branch.contains("/hermes/") {
        WorkspaceTool::Hermes
    } else if normalized_path.contains("/.gemini/")
        || normalized_path.contains("antigravity")
        || normalized_branch.contains("/antigravity/")
    {
        WorkspaceTool::Antigravity
    } else if normalized_path.contains("/.openclaw/") {
        WorkspaceTool::Openclaw
    } else {
        fallback
    }
}

fn registered_worktrees(repository_path: &Path, root: &DiscoveryRoot) -> Vec<WorkspaceCandidate> {
    let Ok(output) = Command::new("git")
        .arg("-C")
        .arg(repository_path)
        .args(["worktree", "list", "--porcelain"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let repository_real =
        fs::canonicalize(repository_path).unwrap_or_else(|_| repository_path.to_path_buf());
    String::from_utf8_lossy(&output.stdout)
        .split("\n\n")
        .filter_map(|block| {
            let worktree_path = block
                .lines()
                .find_map(|line| line.strip_prefix("worktree "))
                .map(PathBuf::from)?;
            let branch = block.lines().find_map(|line| line.strip_prefix("branch "));
            let worktree_real = fs::canonicalize(&worktree_path).unwrap_or(worktree_path);
            if worktree_real == repository_real
                || fs::symlink_metadata(worktree_real.join(".git")).is_err()
            {
                return None;
            }
            Some(WorkspaceCandidate {
                tool: infer_workspace_tool(&worktree_real, branch, root.tool),
                path: worktree_real,
                source_path: PathBuf::from(&root.path),
            })
        })
        .collect()
}

fn discover_within_root(root: &DiscoveryRoot) -> Vec<WorkspaceCandidate> {
    let root_path = PathBuf::from(&root.path);
    if !root_path.exists() {
        return Vec::new();
    }
    let mut candidates = Vec::new();

    fn visit(
        directory: &Path,
        depth: u8,
        root: &DiscoveryRoot,
        candidates: &mut Vec<WorkspaceCandidate>,
    ) {
        if let Ok(git_metadata) = fs::symlink_metadata(directory.join(".git")) {
            candidates.push(WorkspaceCandidate {
                tool: root.tool,
                path: directory.to_path_buf(),
                source_path: PathBuf::from(&root.path),
            });
            if git_metadata.is_dir() {
                candidates.extend(registered_worktrees(directory, root));
            }
            return;
        }
        if depth >= root.max_depth {
            return;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            if [
                ".git",
                ".next",
                ".nuxt",
                "build",
                "coverage",
                "dist",
                "node_modules",
            ]
            .iter()
            .any(|skipped| name == OsStr::new(skipped))
            {
                continue;
            }
            visit(&entry.path(), depth + 1, root, candidates);
        }
    }

    visit(&root_path, 0, root, &mut candidates);
    candidates
}

fn discover_workspaces(roots: &[DiscoveryRoot]) -> Vec<WorkspaceCandidate> {
    let mut unique = BTreeMap::<PathBuf, WorkspaceCandidate>::new();
    for candidate in roots.iter().flat_map(discover_within_root) {
        unique.entry(candidate.path.clone()).or_insert(candidate);
    }
    unique.into_values().collect()
}

fn disk_usage_bytes(path: &Path) -> Result<u64, String> {
    let output = Command::new("du")
        .arg("-sk")
        .arg(path)
        .output()
        .map_err(|error| format!("Could not run du for {}: {error}", path.display()))?;
    if !output.status.success() {
        return Err(command_error("du", &output));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let kilobytes = stdout
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| format!("Could not parse disk usage for {}", path.display()))?;
    Ok(kilobytes.saturating_mul(1024))
}

fn cache_definition(name: &OsStr) -> Option<CacheDefinition> {
    let definition = match name.to_str()? {
        "node_modules" => CacheDefinition {
            kind: CacheKind::Dependencies,
            name: "Installed dependencies",
            rebuild_hint: "Restore with the repository package-manager install command.",
            requires_node_lockfile: true,
        },
        ".nuxt" => CacheDefinition {
            kind: CacheKind::FrameworkBuild,
            name: "Nuxt build cache",
            rebuild_hint: "Nuxt recreates this directory on the next dev or build run.",
            requires_node_lockfile: false,
        },
        ".next" => CacheDefinition {
            kind: CacheKind::FrameworkBuild,
            name: "Next.js build cache",
            rebuild_hint: "Next.js recreates this directory on the next dev or build run.",
            requires_node_lockfile: false,
        },
        ".svelte-kit" => CacheDefinition {
            kind: CacheKind::FrameworkBuild,
            name: "SvelteKit build cache",
            rebuild_hint: "SvelteKit recreates this directory on the next dev or build run.",
            requires_node_lockfile: false,
        },
        ".turbo" => CacheDefinition {
            kind: CacheKind::ToolCache,
            name: "Turborepo cache",
            rebuild_hint: "Turborepo recreates this cache as tasks run.",
            requires_node_lockfile: false,
        },
        ".parcel-cache" => CacheDefinition {
            kind: CacheKind::ToolCache,
            name: "Parcel cache",
            rebuild_hint: "Parcel recreates this cache on the next build.",
            requires_node_lockfile: false,
        },
        "dist" | "build" => CacheDefinition {
            kind: CacheKind::BuildOutput,
            name: "Build output",
            rebuild_hint: "Recreate it with the repository build command.",
            requires_node_lockfile: false,
        },
        "out" => CacheDefinition {
            kind: CacheKind::BuildOutput,
            name: "Export output",
            rebuild_hint: "Recreate it with the repository export or build command.",
            requires_node_lockfile: false,
        },
        "coverage" => CacheDefinition {
            kind: CacheKind::TestOutput,
            name: "Coverage output",
            rebuild_hint: "Recreate it by running the test coverage command.",
            requires_node_lockfile: false,
        },
        "playwright-report" => CacheDefinition {
            kind: CacheKind::TestOutput,
            name: "Playwright report",
            rebuild_hint: "Recreate it by running the Playwright test suite.",
            requires_node_lockfile: false,
        },
        "test-results" => CacheDefinition {
            kind: CacheKind::TestOutput,
            name: "Test results",
            rebuild_hint: "Recreate it by running the test suite.",
            requires_node_lockfile: false,
        },
        _ => return None,
    };
    Some(definition)
}

fn has_node_lockfile(workspace_path: &Path) -> bool {
    [
        "pnpm-lock.yaml",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
    ]
    .iter()
    .any(|name| workspace_path.join(name).exists())
}

fn is_ignored_by_git(workspace_path: &Path, relative_path: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(workspace_path)
        .args(["check-ignore", "--quiet", "--"])
        .arg(relative_path)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn inventory_rebuildable_caches(workspace_path: &Path) -> Result<Vec<CacheEntry>, String> {
    if !workspace_path.is_dir() {
        return Err(format!(
            "Workspace does not exist: {}",
            workspace_path.display()
        ));
    }
    let node_lockfile_present = has_node_lockfile(workspace_path);
    let mut candidates = Vec::<(PathBuf, CacheDefinition)>::new();

    fn visit(
        workspace_path: &Path,
        directory: &Path,
        depth: u8,
        node_lockfile_present: bool,
        candidates: &mut Vec<(PathBuf, CacheDefinition)>,
    ) {
        if depth > 0 && fs::symlink_metadata(directory.join(".git")).is_ok() {
            return;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if let Some(definition) = cache_definition(&entry.file_name()) {
                if definition.requires_node_lockfile && !node_lockfile_present {
                    continue;
                }
                let Ok(relative_path) = path.strip_prefix(workspace_path) else {
                    continue;
                };
                if is_ignored_by_git(workspace_path, relative_path) {
                    candidates.push((path, definition));
                }
                continue;
            }
            if depth < CACHE_MAX_DEPTH
                && ![".git", ".idea", ".vscode"]
                    .iter()
                    .any(|skipped| entry.file_name() == OsStr::new(skipped))
            {
                visit(
                    workspace_path,
                    &path,
                    depth + 1,
                    node_lockfile_present,
                    candidates,
                );
            }
        }
    }

    visit(
        workspace_path,
        workspace_path,
        0,
        node_lockfile_present,
        &mut candidates,
    );

    let mut caches: Vec<CacheEntry> = candidates
        .into_iter()
        .map(|(path, definition)| {
            let relative_path = path
                .strip_prefix(workspace_path)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            let (size_bytes, size_error) = match disk_usage_bytes(&path) {
                Ok(size) => (Some(size), None),
                Err(error) => (None, Some(error)),
            };
            CacheEntry {
                id: relative_path.clone(),
                path: path.to_string_lossy().into_owned(),
                relative_path,
                name: definition.name.to_owned(),
                kind: definition.kind,
                size_bytes,
                size_error,
                ignored_by_git: true,
                rebuild_hint: definition.rebuild_hint.to_owned(),
            }
        })
        .collect();
    caches.sort_by(|left, right| {
        right
            .size_bytes
            .unwrap_or(0)
            .cmp(&left.size_bytes.unwrap_or(0))
    });
    Ok(caches)
}

fn classify_workspace(
    git: Option<&GitInspection>,
    active_process_count: Option<u64>,
    stale_after_days: u64,
    now_seconds: i64,
) -> Classification {
    let Some(git) = git else {
        return Classification {
            data_safety: DataSafety::Unknown,
            recommendation: Recommendation::Protect,
            reasons: vec!["Git inspection failed".to_owned()],
        };
    };
    if git.dirty_entries > 0 {
        let untracked = if git.untracked_entries > 0 {
            format!(", including {} untracked", git.untracked_entries)
        } else {
            String::new()
        };
        return Classification {
            data_safety: DataSafety::LocalOnly,
            recommendation: Recommendation::Protect,
            reasons: vec![format!(
                "{} uncommitted entries{untracked}",
                git.dirty_entries
            )],
        };
    }
    if git.kind == WorkspaceKind::StandaloneRepository {
        return Classification {
            data_safety: DataSafety::Unknown,
            recommendation: Recommendation::Protect,
            reasons: vec![
                "standalone repository; removal would delete its Git database".to_owned(),
            ],
        };
    }
    if git.upstream.is_some() && git.ahead.is_none() {
        return Classification {
            data_safety: DataSafety::Unknown,
            recommendation: Recommendation::Protect,
            reasons: vec!["could not compare HEAD with its upstream".to_owned()],
        };
    }
    if git.ahead.is_some_and(|ahead| ahead > 0) {
        let ahead = git.ahead.unwrap_or(0);
        return Classification {
            data_safety: DataSafety::LocalOnly,
            recommendation: Recommendation::Protect,
            reasons: vec![format!(
                "{ahead} commit{} ahead of upstream",
                if ahead == 1 { "" } else { "s" }
            )],
        };
    }
    if git.upstream.is_none() && !git.remote_contains_head {
        return Classification {
            data_safety: DataSafety::LocalOnly,
            recommendation: Recommendation::Protect,
            reasons: vec!["current commit is not proven to exist on a remote".to_owned()],
        };
    }
    if active_process_count.is_some_and(|count| count > 0) {
        let count = active_process_count.unwrap_or(0);
        return Classification {
            data_safety: DataSafety::Recoverable,
            recommendation: Recommendation::Keep,
            reasons: vec![format!(
                "{count} running process{} working inside this workspace",
                if count == 1 { " is" } else { "es are" }
            )],
        };
    }

    let activity_age_days = git.last_activity_at.as_deref().and_then(|value| {
        DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|timestamp| (now_seconds - timestamp.timestamp()).max(0) / DAY_IN_SECONDS)
    });
    if activity_age_days.is_some_and(|days| days < stale_after_days as i64) {
        let days = activity_age_days.unwrap_or(0);
        return Classification {
            data_safety: DataSafety::Recoverable,
            recommendation: Recommendation::Keep,
            reasons: vec![format!(
                "merged workspace was active {}",
                if days == 0 {
                    "today".to_owned()
                } else {
                    format!("{days}d ago")
                }
            )],
        };
    }
    if git.branch.is_none() {
        return Classification {
            data_safety: DataSafety::Recoverable,
            recommendation: Recommendation::Review,
            reasons: vec!["HEAD is recoverable but detached from a branch".to_owned()],
        };
    }
    if git.merged_into_default != Some(true) {
        return Classification {
            data_safety: DataSafety::Recoverable,
            recommendation: Recommendation::Review,
            reasons: vec![if git.merged_into_default == Some(false) {
                format!(
                    "HEAD is not merged into {}",
                    git.default_branch
                        .as_deref()
                        .unwrap_or("the default branch")
                )
            } else {
                "could not prove that HEAD is merged into the default branch".to_owned()
            }],
        };
    }
    if active_process_count.is_none() {
        return Classification {
            data_safety: DataSafety::Recoverable,
            recommendation: Recommendation::Review,
            reasons: vec!["active-process check was unavailable".to_owned()],
        };
    }
    let Some(activity_age_days) = activity_age_days else {
        return Classification {
            data_safety: DataSafety::Recoverable,
            recommendation: Recommendation::Review,
            reasons: vec!["last workspace activity is unknown".to_owned()],
        };
    };
    Classification {
        data_safety: DataSafety::Recoverable,
        recommendation: Recommendation::Candidate,
        reasons: vec![format!(
            "clean, synced, merged into {}, and inactive for {activity_age_days}d",
            git.default_branch
                .as_deref()
                .unwrap_or("the default branch")
        )],
    }
}

fn scan_candidate(
    candidate: &WorkspaceCandidate,
    processes: &ActiveProcessSnapshot,
    stale_after_days: u64,
    now_seconds: i64,
) -> WorkspaceReport {
    let (git, inspection_error) = match inspect_git(&candidate.path) {
        Ok(git) => (Some(git), None),
        Err(error) => (None, Some(error)),
    };
    let active_process_count = count_processes_within(processes, &candidate.path);
    let classification = classify_workspace(
        git.as_ref(),
        active_process_count,
        stale_after_days,
        now_seconds,
    );
    let (size_bytes, size_error) = match disk_usage_bytes(&candidate.path) {
        Ok(size) => (Some(size), None),
        Err(error) => (None, Some(error)),
    };
    let (caches, cache_inspection_error) = match inventory_rebuildable_caches(&candidate.path) {
        Ok(caches) => (caches, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    let cache_bytes = caches.iter().filter_map(|cache| cache.size_bytes).sum();
    let cache_cleanup_reason = if cache_inspection_error.is_some() {
        Some("cache inventory failed".to_owned())
    } else if caches.is_empty() {
        Some("no verified rebuildable caches found".to_owned())
    } else if active_process_count.is_none() {
        Some("active-process check is unavailable".to_owned())
    } else if active_process_count.is_some_and(|count| count > 0) {
        Some("a running process is using this workspace".to_owned())
    } else if git.is_none() {
        Some("Git inspection failed".to_owned())
    } else {
        None
    };

    WorkspaceReport {
        tool: candidate.tool,
        path: candidate.path.to_string_lossy().into_owned(),
        source_path: candidate.source_path.to_string_lossy().into_owned(),
        data_safety: classification.data_safety,
        recommendation: classification.recommendation,
        reasons: classification.reasons,
        size_bytes,
        size_error,
        git,
        inspection_error,
        active_process_count,
        caches,
        cache_bytes,
        retained_size_bytes: size_bytes.map(|size| size.saturating_sub(cache_bytes)),
        cache_cleanup_allowed: cache_cleanup_reason.is_none(),
        cache_cleanup_reason,
        cache_inspection_error,
    }
}

fn recommendation_priority(recommendation: Recommendation) -> u8 {
    match recommendation {
        Recommendation::Candidate => 0,
        Recommendation::Protect => 1,
        Recommendation::Review => 2,
        Recommendation::Keep => 3,
    }
}

fn nested_workspace_excluded_bytes(paths: &[PathBuf], sizes: &[Option<u64>]) -> Vec<u64> {
    paths
        .iter()
        .enumerate()
        .map(|(parent_index, parent_path)| {
            paths
                .iter()
                .enumerate()
                .filter(|(child_index, child_path)| {
                    *child_index != parent_index && child_path.starts_with(parent_path)
                })
                .filter(|(child_index, child_path)| {
                    !paths.iter().enumerate().any(|(middle_index, middle_path)| {
                        middle_index != parent_index
                            && middle_index != *child_index
                            && middle_path.starts_with(parent_path)
                            && child_path.starts_with(middle_path)
                    })
                })
                .filter_map(|(child_index, _)| sizes.get(child_index).copied().flatten())
                .sum()
        })
        .collect()
}

fn exclude_nested_workspace_sizes(workspaces: &mut [WorkspaceReport]) {
    let paths: Vec<PathBuf> = workspaces
        .iter()
        .map(|workspace| PathBuf::from(&workspace.path))
        .collect();
    let sizes: Vec<Option<u64>> = workspaces
        .iter()
        .map(|workspace| workspace.size_bytes)
        .collect();
    let excluded_bytes = nested_workspace_excluded_bytes(&paths, &sizes);

    for (workspace, excluded) in workspaces.iter_mut().zip(excluded_bytes) {
        if let Some(size_bytes) = workspace.size_bytes {
            let adjusted_size = size_bytes.saturating_sub(excluded);
            workspace.size_bytes = Some(adjusted_size);
            workspace.retained_size_bytes =
                Some(adjusted_size.saturating_sub(workspace.cache_bytes));
        }
    }
}

pub(crate) fn scan_workspaces(
    stale_after_days: u64,
    custom_roots: Vec<String>,
) -> Result<ScanReport, String> {
    let stale_after_days = stale_after_days.clamp(1, 365);
    let roots = discovery_roots(custom_roots)?;
    let candidates = discover_workspaces(&roots);
    let processes = inspect_active_processes();
    let now_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is before Unix epoch: {error}"))?
        .as_secs() as i64;
    let mut workspaces: Vec<WorkspaceReport> = candidates
        .par_iter()
        .map(|candidate| scan_candidate(candidate, &processes, stale_after_days, now_seconds))
        .collect();
    exclude_nested_workspace_sizes(&mut workspaces);
    workspaces.sort_by(|left, right| {
        recommendation_priority(left.recommendation)
            .cmp(&recommendation_priority(right.recommendation))
            .then_with(|| {
                right
                    .size_bytes
                    .unwrap_or(0)
                    .cmp(&left.size_bytes.unwrap_or(0))
            })
    });

    Ok(ScanReport {
        generated_at: now_iso(),
        total_size_bytes: workspaces
            .iter()
            .filter_map(|workspace| workspace.size_bytes)
            .sum(),
        total_cache_bytes: workspaces
            .iter()
            .map(|workspace| workspace.cache_bytes)
            .sum(),
        reclaimable_cache_bytes: workspaces
            .iter()
            .filter(|workspace| workspace.cache_cleanup_allowed)
            .map(|workspace| workspace.cache_bytes)
            .sum(),
        retained_size_bytes: workspaces
            .iter()
            .filter_map(|workspace| workspace.retained_size_bytes)
            .sum(),
        candidate_size_bytes: workspaces
            .iter()
            .filter(|workspace| workspace.recommendation == Recommendation::Candidate)
            .filter_map(|workspace| workspace.size_bytes)
            .sum(),
        roots,
        workspaces,
        stale_after_days,
        process_check_available: processes.available,
        process_check_error: processes.error,
    })
}

fn confirmation_for(workspace_path: &Path) -> String {
    let context = workspace_path
        .components()
        .rev()
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    format!("CLEAN {context}")
}

fn validate_cache_target(workspace_path: &Path, cache: &CacheEntry) -> Result<(), String> {
    let workspace_real = fs::canonicalize(workspace_path)
        .map_err(|error| format!("Could not resolve workspace path: {error}"))?;
    let cache_path = PathBuf::from(&cache.path);
    let cache_metadata = fs::symlink_metadata(&cache_path)
        .map_err(|error| format!("Could not inspect {}: {error}", cache.relative_path))?;
    let cache_real = fs::canonicalize(&cache_path)
        .map_err(|error| format!("Could not resolve {}: {error}", cache.relative_path))?;
    if cache_metadata.file_type().is_symlink()
        || !cache_metadata.is_dir()
        || cache_real == workspace_real
        || !cache_real.starts_with(&workspace_real)
    {
        return Err(format!("Unsafe cache target: {}", cache.relative_path));
    }
    Ok(())
}

fn plan_cache_cleanup_with_snapshot(
    request: &CleanupRequest,
    processes: &ActiveProcessSnapshot,
) -> Result<CacheCleanupPlan, String> {
    let workspace_path = fs::canonicalize(&request.workspace_path)
        .map_err(|error| format!("Could not resolve workspace path: {error}"))?;
    let selected_paths: BTreeSet<&str> =
        request.relative_paths.iter().map(String::as_str).collect();
    if selected_paths.is_empty() {
        return Err("Select at least one cache directory".to_owned());
    }

    inspect_git(&workspace_path)?;
    let active_process_count = count_processes_within(processes, &workspace_path)
        .ok_or_else(|| "Active-process check is unavailable".to_owned())?;
    if active_process_count > 0 {
        return Err(format!(
            "Cleanup blocked: {active_process_count} running process{} using this workspace",
            if active_process_count == 1 {
                " is"
            } else {
                "es are"
            }
        ));
    }

    let inventory = inventory_rebuildable_caches(&workspace_path)?;
    let inventory_by_path: BTreeMap<&str, &CacheEntry> = inventory
        .iter()
        .map(|cache| (cache.relative_path.as_str(), cache))
        .collect();
    let mut caches = Vec::new();
    for relative_path in selected_paths {
        let cache = inventory_by_path.get(relative_path).ok_or_else(|| {
            format!(
                "Cleanup refused: {relative_path} is not in the verified rebuildable cache inventory"
            )
        })?;
        validate_cache_target(&workspace_path, cache)?;
        caches.push((*cache).clone());
    }
    caches.sort_by(|left, right| {
        right
            .size_bytes
            .unwrap_or(0)
            .cmp(&left.size_bytes.unwrap_or(0))
    });
    let reclaim_bytes = caches.iter().filter_map(|cache| cache.size_bytes).sum();

    Ok(CacheCleanupPlan {
        workspace_path: workspace_path.to_string_lossy().into_owned(),
        caches,
        reclaim_bytes,
        confirmation: confirmation_for(&workspace_path),
    })
}

pub(crate) fn plan_cache_cleanup(request: &CleanupRequest) -> Result<CacheCleanupPlan, String> {
    let processes = inspect_active_processes();
    plan_cache_cleanup_with_snapshot(request, &processes)
}

pub(crate) fn plan_cache_cleanup_batch(
    requests: &[CleanupRequest],
) -> Result<Vec<CacheCleanupPlan>, String> {
    if requests.is_empty() {
        return Err("Select at least one workspace".to_owned());
    }

    let processes = inspect_active_processes();
    let results: Vec<Result<CacheCleanupPlan, String>> = requests
        .par_iter()
        .map(|request| plan_cache_cleanup_with_snapshot(request, &processes))
        .collect();

    results
        .into_iter()
        .enumerate()
        .map(|(index, result)| {
            result.map_err(|error| format!("{}: {error}", requests[index].workspace_path))
        })
        .collect()
}

fn worktree_confirmation_for(workspace_path: &Path) -> String {
    let context = workspace_path
        .components()
        .rev()
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    format!("REMOVE {context}")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn is_known_rebuildable_ignored_file(entry: &str) -> bool {
    let file_name = Path::new(entry)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(entry);
    matches!(
        file_name,
        ".eslintcache" | ".stylelintcache" | "next-env.d.ts"
    ) || file_name.ends_with(".tsbuildinfo")
}

fn unknown_ignored_entries(
    workspace_path: &Path,
    rebuildable_paths: &BTreeSet<String>,
) -> Result<Vec<String>, String> {
    let output = run_git_output(
        workspace_path,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
    )?;
    if !output.status.success() {
        return Err(command_error("git", &output));
    }

    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            String::from_utf8_lossy(entry)
                .trim_end_matches('/')
                .to_owned()
        })
        .filter(|entry| {
            !is_known_rebuildable_ignored_file(entry)
                && !rebuildable_paths.iter().any(|cache_path| {
                    entry == cache_path || entry.starts_with(&format!("{cache_path}/"))
                })
        })
        .collect())
}

fn plan_worktree_removal_with_snapshot(
    request: &WorktreeRemovalRequest,
    processes: &ActiveProcessSnapshot,
    now_seconds: i64,
) -> Result<WorktreeRemovalPlan, String> {
    if request.minimum_inactive_days == 0 || request.minimum_inactive_days > 3650 {
        return Err("Worktree inactivity threshold must be between 1 and 3650 days".to_owned());
    }

    let workspace_path = fs::canonicalize(&request.workspace_path)
        .map_err(|error| format!("Could not resolve workspace path: {error}"))?;
    let git = inspect_git(&workspace_path)?;
    if git.kind != WorkspaceKind::LinkedWorktree {
        return Err("Only registered linked Git worktrees can be removed".to_owned());
    }

    let active_process_count = count_processes_within(processes, &workspace_path);
    let classification = classify_workspace(
        Some(&git),
        active_process_count,
        request.minimum_inactive_days,
        now_seconds,
    );
    if classification.recommendation != Recommendation::Candidate {
        return Err(format!(
            "Worktree removal blocked: {}",
            classification.reasons.join("; ")
        ));
    }

    let branch = git
        .branch
        .clone()
        .ok_or_else(|| "Worktree branch proof is incomplete".to_owned())?;
    let upstream = git
        .upstream
        .clone()
        .ok_or_else(|| "Worktree upstream proof is incomplete".to_owned())?;
    let default_branch = git
        .default_branch
        .clone()
        .ok_or_else(|| "Worktree default-branch proof is incomplete".to_owned())?;
    let last_activity_at = git
        .last_activity_at
        .clone()
        .ok_or_else(|| "Worktree activity proof is incomplete".to_owned())?;

    let caches = inventory_rebuildable_caches(&workspace_path)?;
    let rebuildable_paths: BTreeSet<String> = caches
        .iter()
        .map(|cache| cache.relative_path.clone())
        .collect();
    let unknown_ignored = unknown_ignored_entries(&workspace_path, &rebuildable_paths)?;
    if !unknown_ignored.is_empty() {
        let preview = unknown_ignored
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let remainder = unknown_ignored.len().saturating_sub(3);
        return Err(format!(
            "Worktree contains ignored data outside the rebuildable allowlist: {preview}{}",
            if remainder > 0 {
                format!(" and {remainder} more")
            } else {
                String::new()
            }
        ));
    }

    let raw_common_git_directory = run_git(
        &workspace_path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let raw_common_path = PathBuf::from(raw_common_git_directory);
    let common_git_directory = fs::canonicalize(if raw_common_path.is_absolute() {
        raw_common_path
    } else {
        workspace_path.join(raw_common_path)
    })
    .map_err(|error| format!("Could not resolve common Git directory: {error}"))?;
    if common_git_directory == workspace_path || common_git_directory.starts_with(&workspace_path) {
        return Err("Worktree Git history is stored inside the removal target".to_owned());
    }

    let activity_seconds = DateTime::parse_from_rfc3339(&last_activity_at)
        .map_err(|error| format!("Could not parse worktree activity: {error}"))?
        .timestamp();
    let inactive_days = (now_seconds - activity_seconds).max(0) as u64 / DAY_IN_SECONDS as u64;
    let workspace_text = workspace_path.to_string_lossy().into_owned();
    let common_git_text = common_git_directory.to_string_lossy().into_owned();
    let reconstruction_command = format!(
        "git --git-dir={} worktree add {} {}",
        shell_quote(&common_git_text),
        shell_quote(&workspace_text),
        shell_quote(&branch)
    );

    Ok(WorktreeRemovalPlan {
        workspace_path: workspace_text,
        size_bytes: disk_usage_bytes(&workspace_path)?,
        branch,
        head: git.head,
        upstream,
        default_branch,
        last_activity_at,
        inactive_days,
        common_git_directory: common_git_text,
        reconstruction_command,
        confirmation: worktree_confirmation_for(&workspace_path),
    })
}

pub(crate) fn plan_worktree_removal_batch(
    requests: &[WorktreeRemovalRequest],
) -> Result<Vec<WorktreeRemovalPlan>, String> {
    if requests.is_empty() {
        return Err("Select at least one worktree".to_owned());
    }
    let processes = inspect_active_processes();
    let now_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is before Unix epoch: {error}"))?
        .as_secs() as i64;
    let results: Vec<Result<WorktreeRemovalPlan, String>> = requests
        .par_iter()
        .map(|request| plan_worktree_removal_with_snapshot(request, &processes, now_seconds))
        .collect();

    results
        .into_iter()
        .enumerate()
        .map(|(index, result)| {
            result.map_err(|error| format!("{}: {error}", requests[index].workspace_path))
        })
        .collect()
}

fn open_audit_file(path: &Path) -> Result<File, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Audit path has no parent directory".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create audit directory: {error}"))?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open audit log: {error}"))
}

fn append_audit(file: &mut File, event: &serde_json::Value) -> Result<(), String> {
    serde_json::to_writer(&mut *file, event)
        .map_err(|error| format!("Could not serialize audit event: {error}"))?;
    file.write_all(b"\n")
        .and_then(|_| file.flush())
        .map_err(|error| format!("Could not write audit log: {error}"))
}

fn execute_cache_cleanup_with_options(
    request: &CleanupRequest,
    processes: &ActiveProcessSnapshot,
    audit_path: &Path,
) -> Result<CacheCleanupResult, String> {
    let plan = plan_cache_cleanup_with_snapshot(request, processes)?;
    if request.confirmation.as_deref() != Some(plan.confirmation.as_str()) {
        return Err("Confirmation text does not match the revalidated cleanup plan".to_owned());
    }

    let mut audit_file = open_audit_file(audit_path)?;
    let mut removed = Vec::<RemovedCache>::new();
    let completed_at = now_iso();
    for cache in &plan.caches {
        let removal_result = validate_cache_target(Path::new(&plan.workspace_path), cache)
            .and_then(|_| {
                fs::remove_dir_all(&cache.path)
                    .map_err(|error| format!("Could not remove {}: {error}", cache.relative_path))
            });
        if let Err(error) = removal_result {
            let audit_result = append_audit(
                &mut audit_file,
                &json!({
                    "version": 1,
                    "action": "cache-cleanup-partial",
                    "completedAt": now_iso(),
                    "workspacePath": plan.workspace_path,
                    "removed": removed,
                    "error": error,
                }),
            );
            return Err(match audit_result {
                Ok(()) => error,
                Err(audit_error) => format!("{error}; {audit_error}"),
            });
        }
        removed.push(RemovedCache {
            relative_path: cache.relative_path.clone(),
            size_bytes: cache.size_bytes,
        });
    }

    append_audit(
        &mut audit_file,
        &json!({
            "version": 1,
            "action": "cache-cleanup",
            "completedAt": completed_at,
            "workspacePath": plan.workspace_path,
            "removed": removed,
            "reclaimedBytes": plan.reclaim_bytes,
        }),
    )?;

    Ok(CacheCleanupResult {
        workspace_path: plan.workspace_path,
        removed,
        reclaimed_bytes: plan.reclaim_bytes,
        completed_at,
        audit_path: audit_path.to_string_lossy().into_owned(),
    })
}

pub(crate) fn execute_cache_cleanup(
    request: &CleanupRequest,
) -> Result<CacheCleanupResult, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Could not determine the home directory".to_owned())?;
    let processes = inspect_active_processes();
    execute_cache_cleanup_with_options(request, &processes, &home.join(".vibevac/audit.jsonl"))
}

fn execute_worktree_removal_with_options(
    request: &WorktreeRemovalRequest,
    processes: &ActiveProcessSnapshot,
    audit_path: &Path,
    now_seconds: i64,
) -> Result<WorktreeRemovalResult, String> {
    let plan = plan_worktree_removal_with_snapshot(request, processes, now_seconds)?;
    if request.confirmation.as_deref() != Some(plan.confirmation.as_str()) {
        return Err("Confirmation text does not match the revalidated worktree plan".to_owned());
    }

    let mut audit_file = open_audit_file(audit_path)?;
    let completed_at = now_iso();
    let output = Command::new("git")
        .arg(format!("--git-dir={}", plan.common_git_directory))
        .args([
            "worktree",
            "remove",
            "--force",
            plan.workspace_path.as_str(),
        ])
        .output()
        .map_err(|error| format!("Could not run Git worktree removal: {error}"))?;

    if !output.status.success() {
        let error = command_error("git", &output);
        let audit_result = append_audit(
            &mut audit_file,
            &json!({
                "version": 1,
                "action": "worktree-removal-failed",
                "completedAt": now_iso(),
                "workspacePath": plan.workspace_path,
                "preservedBranch": plan.branch,
                "error": error,
            }),
        );
        return Err(match audit_result {
            Ok(()) => error,
            Err(audit_error) => format!("{error}; {audit_error}"),
        });
    }

    append_audit(
        &mut audit_file,
        &json!({
            "version": 1,
            "action": "worktree-removal",
            "completedAt": completed_at,
            "workspacePath": plan.workspace_path,
            "reclaimedBytes": plan.size_bytes,
            "preservedBranch": plan.branch,
            "head": plan.head,
            "upstream": plan.upstream,
            "reconstructionCommand": plan.reconstruction_command,
        }),
    )?;

    Ok(WorktreeRemovalResult {
        workspace_path: plan.workspace_path,
        reclaimed_bytes: plan.size_bytes,
        preserved_branch: plan.branch,
        reconstruction_command: plan.reconstruction_command,
        completed_at,
        audit_path: audit_path.to_string_lossy().into_owned(),
    })
}

pub(crate) fn execute_worktree_removal(
    request: &WorktreeRemovalRequest,
) -> Result<WorktreeRemovalResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_owned())?;
    let processes = inspect_active_processes();
    let now_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is before Unix epoch: {error}"))?
        .as_secs() as i64;
    execute_worktree_removal_with_options(
        request,
        &processes,
        &home.join(".vibevac/audit.jsonl"),
        now_seconds,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn run(path: &Path, program: &str, args: &[&str]) {
        let status = Command::new(program)
            .current_dir(path)
            .args(args)
            .status()
            .expect("test command should run");
        assert!(status.success(), "{program} {args:?} should succeed");
    }

    fn fixture_repository() -> TempDir {
        let directory = TempDir::new().expect("temporary repository");
        run(directory.path(), "git", &["init", "-q"]);
        run(
            directory.path(),
            "git",
            &["config", "user.email", "vibevac@example.test"],
        );
        run(
            directory.path(),
            "git",
            &["config", "user.name", "VibeVac Test"],
        );
        fs::write(directory.path().join(".gitignore"), "node_modules\n").expect("write gitignore");
        fs::write(
            directory.path().join("pnpm-lock.yaml"),
            "lockfileVersion: '9'\n",
        )
        .expect("write lockfile");
        fs::write(directory.path().join("README.md"), "fixture\n").expect("write readme");
        run(directory.path(), "git", &["add", "."]);
        run(directory.path(), "git", &["commit", "-qm", "fixture"]);
        directory
    }

    fn fixture_linked_worktree() -> (TempDir, PathBuf, PathBuf) {
        let root = TempDir::new().expect("temporary worktree root");
        let repository = root.path().join("repository");
        let remote = root.path().join("remote.git");
        let worktree = root.path().join("agent-worktree");
        let repository_text = repository.to_string_lossy().into_owned();
        let remote_text = remote.to_string_lossy().into_owned();
        let worktree_text = worktree.to_string_lossy().into_owned();

        run(root.path(), "git", &["init", "--bare", &remote_text]);
        run(
            root.path(),
            "git",
            &["init", "-b", "main", &repository_text],
        );
        run(
            &repository,
            "git",
            &["config", "user.email", "vibevac@example.test"],
        );
        run(&repository, "git", &["config", "user.name", "VibeVac Test"]);
        fs::write(
            repository.join(".gitignore"),
            "node_modules\n.secret\nnext-env.d.ts\n*.tsbuildinfo\n",
        )
        .expect("write gitignore");
        fs::write(repository.join("pnpm-lock.yaml"), "lockfileVersion: '9'\n")
            .expect("write lockfile");
        fs::write(repository.join("source.ts"), "keep me\n").expect("write source");
        run(&repository, "git", &["add", "."]);
        run(&repository, "git", &["commit", "-m", "fixture"]);
        run(
            &repository,
            "git",
            &["remote", "add", "origin", &remote_text],
        );
        run(&repository, "git", &["push", "-u", "origin", "main"]);
        run(
            &repository,
            "git",
            &["worktree", "add", "-b", "agent/old", &worktree_text],
        );
        run(
            &worktree,
            "git",
            &["branch", "--set-upstream-to", "origin/main", "agent/old"],
        );
        fs::create_dir_all(worktree.join("node_modules/pkg")).expect("create cache");
        fs::write(worktree.join("node_modules/pkg/index.js"), "cache\n").expect("write cache");
        fs::write(worktree.join("next-env.d.ts"), "generated\n")
            .expect("write generated type file");
        fs::write(worktree.join("tsconfig.tsbuildinfo"), "generated\n")
            .expect("write generated build info");

        (root, repository, worktree)
    }

    fn inactive_processes() -> ActiveProcessSnapshot {
        ActiveProcessSnapshot {
            available: true,
            working_directories: BTreeMap::new(),
            error: None,
        }
    }

    #[test]
    fn custom_discovery_sources_are_explicit_and_deduplicated() {
        let source = TempDir::new().expect("custom source");
        let source_path = source.path().to_string_lossy().into_owned();

        let roots = discovery_roots(vec![
            source_path.clone(),
            source_path,
            "relative/path-is-not-a-source".to_owned(),
        ])
        .expect("discovery roots");

        let custom_roots: Vec<&DiscoveryRoot> = roots
            .iter()
            .filter(|root| root.tool == WorkspaceTool::Custom)
            .collect();
        assert_eq!(custom_roots.len(), 1);
        assert_eq!(custom_roots[0].max_depth, 4);
        assert_eq!(
            custom_roots[0].path,
            fs::canonicalize(source.path())
                .expect("canonical source")
                .to_string_lossy()
        );
    }

    #[test]
    fn registered_hermes_worktree_is_discovered_outside_its_project_source() {
        let repository = fixture_repository();
        let worktree_parent = TempDir::new().expect("worktree parent");
        let worktree_path = worktree_parent.path().join("feature");
        let worktree_path_text = worktree_path.to_string_lossy().into_owned();
        run(
            repository.path(),
            "git",
            &[
                "worktree",
                "add",
                "-b",
                "hermes/native-test",
                &worktree_path_text,
            ],
        );
        let source_path = repository.path().to_string_lossy().into_owned();
        let root = DiscoveryRoot {
            tool: WorkspaceTool::Projects,
            path: source_path.clone(),
            max_depth: 0,
        };

        let candidates = discover_within_root(&root);
        let worktree_real = fs::canonicalize(&worktree_path).expect("canonical worktree");
        let worktree = candidates
            .iter()
            .find(|candidate| candidate.path == worktree_real)
            .expect("registered worktree");

        assert_eq!(worktree.tool, WorkspaceTool::Hermes);
        assert_eq!(worktree.source_path, PathBuf::from(source_path));
    }

    #[test]
    fn nested_worktree_sizes_are_excluded_from_their_direct_parent_once() {
        let paths = vec![
            PathBuf::from("/projects/app"),
            PathBuf::from("/projects/app/.worktrees/agent"),
            PathBuf::from("/projects/app/.worktrees/agent/nested"),
        ];

        let excluded =
            nested_workspace_excluded_bytes(&paths, &[Some(1_000), Some(400), Some(100)]);

        assert_eq!(excluded, vec![400, 100, 0]);
    }

    #[test]
    fn inventory_only_includes_ignored_rebuildable_directories() {
        let repository = fixture_repository();
        fs::create_dir_all(repository.path().join("node_modules/pkg"))
            .expect("create node_modules");
        fs::write(
            repository.path().join("node_modules/pkg/index.js"),
            "export {};\n",
        )
        .expect("write generated file");
        fs::create_dir_all(repository.path().join("src")).expect("create source");
        fs::create_dir_all(
            repository
                .path()
                .join(".worktrees/agent/node_modules/child-package"),
        )
        .expect("create nested worktree cache");
        fs::write(
            repository.path().join(".worktrees/agent/.git"),
            "gitdir: /tmp/agent\n",
        )
        .expect("write nested worktree marker");

        let caches = inventory_rebuildable_caches(repository.path()).expect("inventory");

        assert_eq!(caches.len(), 1);
        assert_eq!(caches[0].relative_path, "node_modules");
        assert_eq!(caches[0].kind, CacheKind::Dependencies);
    }

    #[test]
    fn cleanup_revalidates_and_only_removes_selected_cache() {
        let repository = fixture_repository();
        fs::create_dir_all(repository.path().join("node_modules/pkg"))
            .expect("create node_modules");
        fs::write(
            repository.path().join("node_modules/pkg/index.js"),
            "export {};\n",
        )
        .expect("write generated file");
        let audit_path = repository.path().join("audit.jsonl");
        let workspace_path = repository.path().to_string_lossy().into_owned();
        let preview_request = CleanupRequest {
            workspace_path: workspace_path.clone(),
            relative_paths: vec!["node_modules".to_owned()],
            confirmation: None,
        };
        let plan = plan_cache_cleanup_with_snapshot(&preview_request, &inactive_processes())
            .expect("cleanup plan");
        let execute_request = CleanupRequest {
            workspace_path,
            relative_paths: vec!["node_modules".to_owned()],
            confirmation: Some(plan.confirmation),
        };

        let result = execute_cache_cleanup_with_options(
            &execute_request,
            &inactive_processes(),
            &audit_path,
        )
        .expect("cleanup result");

        assert!(!repository.path().join("node_modules").exists());
        assert!(repository.path().join("README.md").exists());
        assert!(repository.path().join(".git").exists());
        assert_eq!(result.removed.len(), 1);
        assert!(fs::read_to_string(audit_path)
            .expect("audit contents")
            .contains("cache-cleanup"));
    }

    #[test]
    fn batch_cleanup_preview_reuses_safety_checks_and_preserves_order() {
        let first = fixture_repository();
        let second = fixture_repository();
        for repository in [&first, &second] {
            fs::create_dir_all(repository.path().join("node_modules/pkg"))
                .expect("create node_modules");
            fs::write(
                repository.path().join("node_modules/pkg/index.js"),
                "export {};\n",
            )
            .expect("write generated file");
        }

        let requests = vec![
            CleanupRequest {
                workspace_path: first.path().to_string_lossy().into_owned(),
                relative_paths: vec!["node_modules".to_owned()],
                confirmation: None,
            },
            CleanupRequest {
                workspace_path: second.path().to_string_lossy().into_owned(),
                relative_paths: vec!["node_modules".to_owned()],
                confirmation: None,
            },
        ];

        let plans = plan_cache_cleanup_batch(&requests).expect("batch cleanup plan");

        assert_eq!(plans.len(), 2);
        assert_eq!(
            plans[0].workspace_path,
            fs::canonicalize(first.path())
                .expect("first canonical path")
                .to_string_lossy()
        );
        assert_eq!(
            plans[1].workspace_path,
            fs::canonicalize(second.path())
                .expect("second canonical path")
                .to_string_lossy()
        );
        assert!(plans
            .iter()
            .all(|plan| plan.caches.len() == 1 && plan.caches[0].relative_path == "node_modules"));
    }

    #[test]
    fn worktree_removal_preserves_branch_and_only_removes_linked_checkout() {
        let (_root, repository, worktree) = fixture_linked_worktree();
        let now_seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_secs() as i64
            + 120 * DAY_IN_SECONDS;
        let preview_request = WorktreeRemovalRequest {
            workspace_path: worktree.to_string_lossy().into_owned(),
            minimum_inactive_days: 90,
            confirmation: None,
        };
        let plan = plan_worktree_removal_with_snapshot(
            &preview_request,
            &inactive_processes(),
            now_seconds,
        )
        .expect("worktree removal plan");
        let audit_path = repository.join("worktree-audit.jsonl");
        let execute_request = WorktreeRemovalRequest {
            confirmation: Some(plan.confirmation),
            ..preview_request
        };

        let result = execute_worktree_removal_with_options(
            &execute_request,
            &inactive_processes(),
            &audit_path,
            now_seconds,
        )
        .expect("worktree removal result");

        assert!(!worktree.exists());
        assert!(repository.join("source.ts").exists());
        assert!(git_succeeds(
            &repository,
            &["show-ref", "--verify", "refs/heads/agent/old"]
        ));
        assert_eq!(result.preserved_branch, "agent/old");
        assert!(fs::read_to_string(audit_path)
            .expect("worktree audit")
            .contains("worktree-removal"));
    }

    #[test]
    fn worktree_removal_blocks_unknown_ignored_data() {
        let (_root, _repository, worktree) = fixture_linked_worktree();
        fs::write(worktree.join(".secret"), "local-only\n").expect("write ignored secret");
        let now_seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_secs() as i64
            + 120 * DAY_IN_SECONDS;
        let request = WorktreeRemovalRequest {
            workspace_path: worktree.to_string_lossy().into_owned(),
            minimum_inactive_days: 90,
            confirmation: None,
        };

        let error =
            plan_worktree_removal_with_snapshot(&request, &inactive_processes(), now_seconds)
                .expect_err("ignored local data must block removal");

        assert!(error.contains("ignored data outside the rebuildable allowlist: .secret"));
        assert!(worktree.exists());
    }

    #[test]
    fn cleanup_rejects_a_path_outside_verified_inventory() {
        let repository = fixture_repository();
        let request = CleanupRequest {
            workspace_path: repository.path().to_string_lossy().into_owned(),
            relative_paths: vec!["src".to_owned()],
            confirmation: None,
        };

        let error = plan_cache_cleanup_with_snapshot(&request, &inactive_processes())
            .expect_err("source path must be rejected");

        assert!(error.contains("not in the verified rebuildable cache inventory"));
    }

    #[test]
    fn dirty_workspace_classification_is_protected() {
        let git = GitInspection {
            kind: WorkspaceKind::LinkedWorktree,
            branch: Some("feature/native".to_owned()),
            head: "abc".to_owned(),
            upstream: Some("origin/feature/native".to_owned()),
            ahead: Some(0),
            behind: Some(0),
            dirty_entries: 2,
            untracked_entries: 1,
            remote_contains_head: true,
            default_branch: Some("origin/main".to_owned()),
            merged_into_default: Some(false),
            last_commit_at: None,
            last_activity_at: None,
        };

        let classification = classify_workspace(Some(&git), Some(0), 14, 0);

        assert_eq!(classification.data_safety, DataSafety::LocalOnly);
        assert_eq!(classification.recommendation, Recommendation::Protect);
    }
}
