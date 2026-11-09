use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppError;
use crate::state::{AppState, Route};
use crate::watcher::normalize;

/// Creates a `doc-{n}` window; `path` is queued for its `take_pending_open`.
/// On failure nothing stays queued.
pub fn create_window(
    app: &AppHandle,
    path: Option<PathBuf>,
    blank: bool,
) -> Result<String, AppError> {
    let state = app.state::<AppState>();
    let n = state.window_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("doc-{n}");
    if let Some(p) = path {
        state
            .routing
            .lock()
            .unwrap()
            .pending
            .entry(label.clone())
            .or_default()
            .push(p);
    }
    let built = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(
            if blank {
                "index.html?new=1"
            } else {
                "index.html"
            }
            .into(),
        ),
    )
    .title("json-gantt")
    .inner_size(1400.0, 860.0)
    .min_inner_size(1024.0, 640.0)
    .build();
    if let Err(e) = built {
        state.routing.lock().unwrap().pending.remove(&label);
        return Err(AppError::internal(e));
    }
    Ok(label)
}

/// Destination for an OS open request: the focused window, else `main` if it
/// exists, else any remaining window. None when no window exists.
pub fn target_label(app: &AppHandle) -> Option<String> {
    let windows = app.webview_windows();
    if let Some((l, _)) = windows
        .iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
    {
        return Some(l.clone());
    }
    if windows.contains_key("main") {
        return Some("main".to_string());
    }
    let mut labels: Vec<&String> = windows.keys().collect();
    labels.sort();
    labels.first().map(|l| (*l).clone())
}

/// Routes an OS "open this file" request to a window: emit if the window is
/// ready, queue it for `take_pending_open` otherwise, or open a new window if
/// none exists.
pub fn dispatch_open(app: &AppHandle, path: PathBuf) {
    let Some(label) = target_label(app) else {
        let _ = create_window(app, Some(path), false);
        return;
    };
    let state = app.state::<AppState>();
    let route = state.routing.lock().unwrap().route(&label, path.clone());
    if route == Route::Emit {
        let _ = app.emit_to(
            label.as_str(),
            "open-file-requested",
            json!({ "path": path.to_string_lossy() }),
        );
    }
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn is_json_file(p: &Path) -> bool {
    p.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("json"))
        && p.is_file()
}

#[tauri::command]
pub async fn new_window(
    app: AppHandle,
    path: Option<String>,
    blank: Option<bool>,
) -> Result<String, AppError> {
    create_window(&app, path.map(PathBuf::from), blank == Some(true))
}

#[tauri::command]
pub async fn focus_window_with_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<bool, AppError> {
    let target = normalize(&PathBuf::from(path));
    let entries: Vec<(String, PathBuf)> = state
        .windows
        .lock()
        .unwrap()
        .iter()
        .map(|(l, w)| (l.clone(), w.path.clone()))
        .collect();
    let label = entries
        .into_iter()
        .find(|(_, p)| *p == target)
        .map(|(l, _)| l);
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(true);
    }
    Ok(false)
}

/// Marks the calling window ready and returns its first queued path. Any
/// further queued paths are opened in new windows; if a window cannot be
/// created the remaining paths stay queued for the next call.
#[tauri::command]
pub async fn take_pending_open(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Option<String>, AppError> {
    let label = window.label().to_string();
    let (first, rest) = state.routing.lock().unwrap().take(&label);
    let Some(first) = first else { return Ok(None) };
    for (i, p) in rest.iter().enumerate() {
        if create_window(&app, Some(p.clone()), false).is_err() {
            state
                .routing
                .lock()
                .unwrap()
                .pending
                .entry(label)
                .or_default()
                .extend(rest[i..].iter().cloned());
            break;
        }
    }
    Ok(Some(first.to_string_lossy().into_owned()))
}
