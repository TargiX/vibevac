mod core;

use core::{
    CacheCleanupPlan, CacheCleanupResult, CleanupRequest, ScanReport, WorktreeRemovalPlan,
    WorktreeRemovalRequest, WorktreeRemovalResult,
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
) -> Result<Vec<CacheCleanupPlan>, String> {
    tauri::async_runtime::spawn_blocking(move || core::plan_cache_cleanup_batch(&requests))
        .await
        .map_err(|error| format!("Native batch cleanup preview task failed: {error}"))?
}

#[tauri::command]
async fn preview_worktree_removal_batch(
    requests: Vec<WorktreeRemovalRequest>,
) -> Result<Vec<WorktreeRemovalPlan>, String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
