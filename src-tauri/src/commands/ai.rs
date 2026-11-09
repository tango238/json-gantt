use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_store::StoreExt;

use crate::ai::{self, AiExit, AiFileResult, RunOpts};
use crate::error::AppError;
use crate::state::{AiSession, AppState};

const STORE: &str = "settings.json";
const CLAUDE_PATH_KEY: &str = "aiClaudePath";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionInfo {
    pub claude_path: String,
    pub dir: String,
    pub gantt_path: String,
    pub schema_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunResult {
    pub run_id: String,
    pub exit: AiExit,
    pub stderr_tail: String,
    pub last_result_line: Option<String>,
    pub file: AiFileResult,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiEventPayload<'a> {
    run_id: &'a str,
    line: &'a str,
}

fn setting_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let store = app.store(STORE).ok()?;
    let v = store.get(CLAUDE_PATH_KEY)?;
    v.as_str().filter(|s| !s.is_empty()).map(PathBuf::from)
}

fn locate<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    let setting = setting_path(app);
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let home = home.map(PathBuf::from);
    let path_env = std::env::var_os("PATH");
    ai::resolve_claude(
        setting.as_deref(),
        home.as_deref(),
        path_env.as_deref(),
        ai::is_executable,
    )
    .map_err(|searched| AppError::AiNotFound {
        searched: searched
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    })
}

fn new_session() -> Result<AiSession, AppError> {
    let dir = tempfile::Builder::new()
        .prefix(ai::TEMP_PREFIX)
        .tempdir()
        .map_err(|e| AppError::io(e.to_string(), None))?;
    Ok(AiSession::new(dir))
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[tauri::command]
pub async fn ai_locate(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<AiSessionInfo, AppError> {
    let claude = locate(&app)?;
    let mut map = state.ai.lock().unwrap();
    if !map.contains_key(window.label()) {
        let s = new_session()?;
        ai::write_schema(s.dir.path())?;
        map.insert(window.label().to_string(), s);
    }
    let dir = map[window.label()].dir.path().to_path_buf();
    Ok(AiSessionInfo {
        claude_path: lossy(&claude),
        gantt_path: lossy(&dir.join("gantt.json")),
        schema_path: lossy(&dir.join("schema.json")),
        dir: lossy(&dir),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_run(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    run_id: String,
    document: Value,
    prompt: String,
    append_system_prompt: String,
    resume_session_id: Option<String>,
) -> Result<AiRunResult, AppError> {
    let label = window.label().to_string();
    let claude = locate(&app)?;
    let args = ai::build_args(&append_system_prompt, resume_session_id.as_deref(), &prompt)?;

    // Register the run and write the files under one lock. The session is
    // created by `ai_locate` only: a missing one means the conversation was
    // reset in the meantime, and silently making a new one would point the
    // system prompt at a directory that no longer exists.
    let (dir, written, cancel_rx, pgid) = {
        let mut map = state.ai.lock().unwrap();
        let session = map.get_mut(&label).ok_or_else(|| AppError::Ai {
            message: "no session (call ai_locate first)".into(),
        })?;
        let (rx, pgid) = session.register_run(&run_id)?;
        let dir = session.dir.path().to_path_buf();
        match ai::write_session_files(&dir, document) {
            Ok(written) => (dir, written, rx, pgid),
            Err(e) => {
                session.run = None;
                return Err(e);
            }
        }
    };

    let emit_app = app.clone();
    let emit_label = label.clone();
    let emit_id = run_id.clone();
    let outcome = ai::run_process(
        &claude,
        &args,
        &dir,
        cancel_rx,
        RunOpts {
            pgid_out: Some(pgid),
            ..RunOpts::default()
        },
        move |line| {
            let line = slim_line(line);
            let _ = emit_app.emit_to(
                emit_label.as_str(),
                "ai-event",
                AiEventPayload {
                    run_id: &emit_id,
                    line: &line,
                },
            );
        },
    )
    .await;

    // Clear the handle (the session may be gone already).
    if let Some(s) = state.ai.lock().unwrap().get_mut(&label)
        && s.run.as_ref().is_some_and(|r| r.run_id == run_id)
    {
        s.run = None;
    }
    let outcome = outcome?;
    let file = ai::read_back(&dir, &written);
    Ok(AiRunResult {
        run_id,
        exit: outcome.exit,
        stderr_tail: outcome.stderr_tail,
        last_result_line: outcome.last_result_line,
        file,
    })
}

/// Stops the run `run_id` (or, with `None`, whatever runs). A run that is not
/// registered yet is cancelled as soon as it registers.
#[tauri::command]
pub async fn ai_stop(
    window: tauri::Window,
    state: State<'_, AppState>,
    run_id: Option<String>,
) -> Result<(), AppError> {
    if let Some(s) = state.ai.lock().unwrap().get_mut(window.label()) {
        s.request_stop(run_id.as_deref());
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_reset(window: tauri::Window, state: State<'_, AppState>) -> Result<(), AppError> {
    state.remove_ai(window.label());
    Ok(())
}

#[tauri::command]
pub async fn ai_set_claude_path(app: AppHandle, path: String) -> Result<String, AppError> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || !ai::is_executable(&p) {
        return Err(AppError::AiNotFound {
            searched: vec![path],
        });
    }
    let store = app
        .store(STORE)
        .map_err(|e| AppError::io(e.to_string(), None))?;
    store.set(CLAUDE_PATH_KEY, serde_json::json!(path));
    store
        .save()
        .map_err(|e| AppError::io(e.to_string(), None))?;
    Ok(path)
}

/// Drops the bodies of `tool_result` blocks of `type:"user"` lines (a `Read`
/// result carries the whole file, twice). The front end only uses
/// `tool_use_id` and `is_error`. Other lines are returned unchanged.
pub fn slim_line(line: &str) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    if line.len() < 1024 || !line.contains("\"type\":\"user\"") {
        return Cow::Borrowed(line);
    }
    let Ok(mut v) = serde_json::from_str::<Value>(line) else {
        return Cow::Borrowed(line);
    };
    if let Some(o) = v.as_object_mut() {
        o.remove("tool_use_result");
    }
    if let Some(blocks) = v
        .pointer_mut("/message/content")
        .and_then(Value::as_array_mut)
    {
        for b in blocks {
            if b.get("type").and_then(Value::as_str) == Some("tool_result")
                && let Some(o) = b.as_object_mut()
            {
                o.insert("content".into(), Value::String(String::new()));
            }
        }
    }
    Cow::Owned(v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slim_line_drops_tool_result_bodies_only() {
        let big = "x".repeat(5000);
        let line = format!(
            r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"{big}"}}]}},"tool_use_result":{{"file":"{big}"}}}}"#
        );
        let out = slim_line(&line);
        assert!(out.len() < 300, "{}", out.len());
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["message"]["content"][0]["tool_use_id"], "t1");
        assert_eq!(v["message"]["content"][0]["is_error"], false);
        assert!(v.get("tool_use_result").is_none());
        // other lines and short user lines pass through untouched
        let a = r#"{"type":"assistant","message":{}}"#;
        assert!(matches!(slim_line(a), std::borrow::Cow::Borrowed(_)));
        let u = r#"{"type":"user","message":{"content":[]}}"#;
        assert!(matches!(slim_line(u), std::borrow::Cow::Borrowed(_)));
    }
}
