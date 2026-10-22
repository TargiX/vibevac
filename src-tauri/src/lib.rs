mod core;

use core::{
    BatchPreview, CacheCleanupPlan, CacheCleanupResult, CleanupRequest, ScanReport,
    WorktreeRemovalPlan, WorktreeRemovalRequest, WorktreeRemovalResult,
};

#[tauri::command]
async fn scan_workspaces(
    stale_after_days: u64,
    custom_roots: Vec<String>,
) -> Result<ScanReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        core::scan_workspaces(stale_after_days, custom_roots)
    })
    .await
    .map_err(|error| format!("Native scan task failed: {error}"))?
}

#[tauri::command]
async fn preview_cache_cleanup(request: CleanupRequest) -> Result<CacheCleanupPlan, String> {
    tauri::async_runtime::spawn_blocking(move || core::plan_cache_cleanup(&request))
        .await
        .map_err(|error| format!("Native cleanup preview task failed: {error}"))?
}

#[tauri::command]
async fn preview_cache_cleanup_batch(
    requests: Vec<CleanupRequest>,
) -> Result<BatchPreview<CacheCleanupPlan>, String> {
    tauri::async_runtime::spawn_blocking(move || core::plan_cache_cleanup_batch(&requests))
        .await
        .map_err(|error| format!("Native batch cleanup preview task failed: {error}"))?
}

#[tauri::command]
async fn preview_worktree_removal_batch(
    requests: Vec<WorktreeRemovalRequest>,
) -> Result<BatchPreview<WorktreeRemovalPlan>, String> {
    tauri::async_runtime::spawn_blocking(move || core::plan_worktree_removal_batch(&requests))
        .await
        .map_err(|error| format!("Native worktree preview task failed: {error}"))?
}

#[tauri::command]
async fn execute_cache_cleanup(request: CleanupRequest) -> Result<CacheCleanupResult, String> {
    tauri::async_runtime::spawn_blocking(move || core::execute_cache_cleanup(&request))
        .await
        .map_err(|error| format!("Native cleanup task failed: {error}"))?
}

#[tauri::command]
async fn remove_worktree(request: WorktreeRemovalRequest) -> Result<WorktreeRemovalResult, String> {
    tauri::async_runtime::spawn_blocking(move || core::execute_worktree_removal(&request))
        .await
        .map_err(|error| format!("Native worktree removal task failed: {error}"))?
}

// Release smoke test: with VIBEVAC_SMOKE=1 the app scans VIBEVAC_SMOKE_ROOT,
// writes the report JSON to VIBEVAC_SMOKE_OUT and exits without a window.
fn run_smoke_test() -> Result<(), String> {
    let root = std::env::var("VIBEVAC_SMOKE_ROOT")
        .map_err(|_| "VIBEVAC_SMOKE_ROOT is not set".to_owned())?;
    let output = std::env::var_os("VIBEVAC_SMOKE_OUT")
        .ok_or_else(|| "VIBEVAC_SMOKE_OUT is not set".to_owned())?;
    let report = core::scan_single_root(14, &root)?;
    let json = serde_json::to_string_pretty(&report)
        .map_err(|error| format!("Could not serialize the scan report: {error}"))?;
    std::fs::write(&output, format!("{json}\n"))
        .map_err(|error| format!("Could not write the scan report: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::var_os("VIBEVAC_SMOKE").is_some_and(|value| value == "1") {
        std::process::exit(match run_smoke_test() {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("VibeVac smoke test failed: {error}");
                1
            }
        });
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_workspaces,
            preview_cache_cleanup,
            preview_cache_cleanup_batch,
            preview_worktree_removal_batch,
            execute_cache_cleanup,
            remove_worktree
        ])
        .run(tauri::generate_context!())
        .expect("error while running VibeVac");
}
