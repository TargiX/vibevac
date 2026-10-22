//! Fixture-mode entry point for the cross-engine conformance suite
//! (test/conformance). The process snapshot and clock are injected so a scan
//! of a synthetic repository is reproducible and comparable with the
//! TypeScript engine in src/services.

use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConformanceInput {
    workspace_path: String,
    /// `None` means the active-process check is unavailable.
    working_directories: Option<Vec<String>>,
    now_iso: String,
    stale_after_days: u64,
    #[serde(default)]
    cleanup_selection: Option<Vec<String>>,
}

fn fixture_snapshot(working_directories: Option<&[String]>) -> ActiveProcessSnapshot {
    let Some(directories) = working_directories else {
        return ActiveProcessSnapshot {
            available: false,
            working_directories: BTreeMap::new(),
            error: Some("process check disabled by fixture".to_owned()),
            method: None,
            coverage: None,
        };
    };
    let mut counts = BTreeMap::new();
    for directory in directories {
        *counts.entry(PathBuf::from(directory)).or_insert(0) += 1;
    }
    ActiveProcessSnapshot {
        available: true,
        working_directories: counts,
        error: None,
        // Injected by the fixture rather than read by any method; the fixture
        // lists every process it means to exist, so coverage is all users.
        method: None,
        coverage: Some(ProcessCheckCoverage::AllUsers),
    }
}

pub(super) fn scan_candidate_for_conformance(
    path: &Path,
    snapshot: &ActiveProcessSnapshot,
    now_seconds: i64,
    stale_after_days: u64,
) -> WorkspaceReport {
    let candidate = WorkspaceCandidate {
        tool: WorkspaceTool::Custom,
        path: path.to_path_buf(),
        source_path: path.to_path_buf(),
    };
    scan_candidate(&candidate, snapshot, stale_after_days, now_seconds, false)
}

/// Reads `{workspacePath, workingDirectories, nowIso, staleAfterDays,
/// cleanupSelection?}` and returns `{report, cleanup}` as JSON.
pub fn run_conformance_json(input: &str) -> Result<String, String> {
    let input: ConformanceInput =
        serde_json::from_str(input).map_err(|error| format!("Invalid fixture input: {error}"))?;
    let now_seconds = DateTime::parse_from_rfc3339(&input.now_iso)
        .map_err(|error| format!("Invalid nowIso: {error}"))?
        .timestamp();
    let snapshot = fixture_snapshot(input.working_directories.as_deref());
    let workspace_path = PathBuf::from(&input.workspace_path);
    let report = scan_candidate_for_conformance(
        &workspace_path,
        &snapshot,
        now_seconds,
        input.stale_after_days,
    );
    let cleanup = input.cleanup_selection.map(|relative_paths| {
        let request = CleanupRequest {
            workspace_path: input.workspace_path.clone(),
            relative_paths,
            confirmation: None,
        };
        match plan_cache_cleanup_with_snapshot(&request, &snapshot) {
            Ok(plan) => json!({
                "ok": true,
                "relativePaths": plan
                    .caches
                    .iter()
                    .map(|cache| cache.relative_path.clone())
                    .collect::<Vec<_>>(),
            }),
            Err(error) => json!({ "ok": false, "error": error }),
        }
    });
    serde_json::to_string_pretty(&json!({ "report": report, "cleanup": cleanup }))
        .map_err(|error| format!("Could not serialise report: {error}"))
}
