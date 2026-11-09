use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::fileio;
use crate::state::{AppState, WatchShared, WindowFile};
use crate::watcher::{self, normalize};

#[tauri::command]
pub async fn watch_file(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), AppError> {
    let path = PathBuf::from(path);
    let label = window.label().to_string();
    // Saving re-invokes this with the same path: keep the live watcher.
    if state.is_watching(&label, &path) {
        return Ok(());
    }
    // Filesystem work happens outside the state lock.
    let key = normalize(&path);
    let fresh_hash = fileio::hash_file(&path);

    // Keep the hash recorded by open_file/save_file for the same path.
    let shared = match state.windows.lock().unwrap().remove(&label) {
        Some(old) if old.path == key => old.shared,
        _ => {
            let s = Arc::new(WatchShared::default());
            *s.known_hash.lock().unwrap() = fresh_hash;
            s
        }
    };

    let emit_path = path.to_string_lossy().into_owned();
    let emit_label = label.clone();
    let debouncer = watcher::start(&path, shared.clone(), move |kind| {
        let _ = app.emit_to(
            emit_label.as_str(),
            "file-changed-externally",
            json!({ "path": emit_path, "kind": kind.as_str() }),
        );
    })
    .map_err(|e| AppError::io(e.to_string(), Some(&path)))?;

    state.windows.lock().unwrap().insert(
        label,
        WindowFile {
            path: key,
            shared,
            debouncer: Some(debouncer),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn unwatch_file(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.windows.lock().unwrap().remove(window.label());
    Ok(())
}
