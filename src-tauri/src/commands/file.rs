use std::path::PathBuf;

use serde_json::Value;
use tauri::State;

use crate::error::{AppError, Issue};
use crate::fileio::{self, OpenResult};
use crate::schema;
use crate::state::AppState;

#[tauri::command]
pub async fn open_file(
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<OpenResult, AppError> {
    let path = PathBuf::from(path);
    let (result, hash) = fileio::read_document(&path)?;
    state.set_file(window.label(), &path, hash);
    Ok(result)
}

#[tauri::command]
pub async fn save_file(
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
    document: Value,
) -> Result<(), AppError> {
    let path = PathBuf::from(path);
    let bytes = fileio::prepare_save(document)?;
    // Registers our hash before the write (and rolls back on failure) so the
    // watcher never reports our own save.
    state.save(window.label(), &path, &bytes)
}

#[tauri::command]
pub fn validate(document: Value) -> Vec<Issue> {
    schema::validate(&document)
}
