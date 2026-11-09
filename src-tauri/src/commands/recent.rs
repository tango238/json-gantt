use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use crate::watcher::normalize;

const STORE: &str = "settings.json";
const RECENT_KEY: &str = "recentFiles";
const WINDOW_KEY: &str = "windowState";
const MAX_RECENT: usize = 10;

#[derive(Debug, Serialize, PartialEq)]
pub struct RecentFile {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    pub maximized: bool,
}

/// Puts `path` first, drops duplicates (canonicalized comparison), caps at 10.
pub fn push_recent(list: Vec<String>, path: &str) -> Vec<String> {
    let key = normalize(Path::new(path));
    let mut out = vec![path.to_string()];
    out.extend(list.into_iter().filter(|p| normalize(Path::new(p)) != key));
    out.truncate(MAX_RECENT);
    out
}

pub fn existing_only(list: Vec<String>) -> Vec<String> {
    list.into_iter()
        .filter(|p| Path::new(p).is_file())
        .collect()
}

fn to_recent(list: &[String]) -> Vec<RecentFile> {
    list.iter()
        .map(|p| RecentFile {
            path: p.clone(),
            name: PathBuf::from(p)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.clone()),
        })
        .collect()
}

fn read_list<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<String>, String> {
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    Ok(store
        .get(RECENT_KEY)
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default())
}

#[tauri::command]
pub fn get_recent_files(app: AppHandle) -> Vec<RecentFile> {
    let Ok(list) = read_list(&app) else {
        return vec![];
    };
    let kept = existing_only(list.clone());
    if kept != list
        && let Ok(store) = app.store(STORE)
    {
        store.set(RECENT_KEY, serde_json::json!(kept));
        let _ = store.save();
    }
    to_recent(&kept)
}

#[tauri::command]
pub fn add_recent_file(app: AppHandle, path: String) {
    let Ok(list) = read_list(&app) else { return };
    let updated = push_recent(list, &path);
    if let Ok(store) = app.store(STORE) {
        store.set(RECENT_KEY, serde_json::json!(updated));
        let _ = store.save();
    }
}

pub fn save_window_state<R: Runtime>(app: &AppHandle<R>, state: &WindowState) {
    if let Ok(store) = app.store(STORE)
        && let Ok(v) = serde_json::to_value(state)
    {
        store.set(WINDOW_KEY, v);
        let _ = store.save();
    }
}

pub fn load_window_state<R: Runtime>(app: &AppHandle<R>) -> Option<WindowState> {
    let store = app.store(STORE).ok()?;
    serde_json::from_value(store.get(WINDOW_KEY)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_moves_to_front_and_dedups() {
        let l = push_recent(vec!["/a".into(), "/b".into(), "/c".into()], "/b");
        assert_eq!(l, ["/b", "/a", "/c"]);
    }

    #[test]
    fn push_caps_at_ten() {
        let list: Vec<String> = (0..10).map(|i| format!("/f{i}")).collect();
        let l = push_recent(list, "/new");
        assert_eq!(l.len(), 10);
        assert_eq!(l[0], "/new");
        assert_eq!(l[9], "/f8");
    }

    #[test]
    fn missing_files_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.json");
        std::fs::write(&f, "{}").unwrap();
        let kept = existing_only(vec![
            f.to_string_lossy().into(),
            "/no/such/file.json".into(),
        ]);
        assert_eq!(kept.len(), 1);
        assert_eq!(to_recent(&kept)[0].name, "x.json");
    }
}
