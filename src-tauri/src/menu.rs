//! Native menu. Labels come from `menu.*` in src/i18n/ja.json (embedded at
//! build time, single source); missing keys fall back to the literals below.

use std::collections::HashMap;
use std::sync::OnceLock;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::window::target_label;

const JA_JSON: &str = include_str!("../../src/i18n/ja.json");

/// (key under `menu`, fallback label)
const DEFAULTS: [(&str, &str); 11] = [
    ("file", "ファイル"),
    ("new", "新規"),
    ("open", "開く…"),
    ("save", "保存"),
    ("saveAs", "名前を付けて保存…"),
    ("exportPdf", "PDF 出力…"),
    ("close", "ウィンドウを閉じる"),
    ("quit", "終了"),
    ("edit", "編集"),
    ("undo", "元に戻す"),
    ("redo", "やり直す"),
];

fn labels() -> &'static HashMap<String, String> {
    static LABELS: OnceLock<HashMap<String, String>> = OnceLock::new();
    LABELS.get_or_init(|| parse_labels(JA_JSON))
}

fn parse_labels(json: &str) -> HashMap<String, String> {
    let menu = serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("menu").cloned());
    DEFAULTS
        .iter()
        .map(|(k, d)| {
            let v = menu
                .as_ref()
                .and_then(|m| m.get(*k))
                .and_then(|s| s.as_str())
                .unwrap_or(d);
            (k.to_string(), v.to_string())
        })
        .collect()
}

fn l(key: &str) -> &'static str {
    labels().get(key).map(String::as_str).unwrap_or("")
}

/// (menu id, action sent to the frontend). Ids equal actions.
pub const ACTIONS: [&str; 7] = ["new", "open", "save", "saveAs", "exportPdf", "undo", "redo"];

pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: &str, accel: &str| {
        MenuItemBuilder::with_id(id, label)
            .accelerator(accel)
            .build(app)
    };

    // Custom quit: the predefined one sends `terminate:` and bypasses the
    // unsaved-changes confirmation. Instead we close every window.
    let quit = item("quit", l("quit"), "CmdOrCtrl+Q")?;

    let file = SubmenuBuilder::new(app, l("file"))
        .item(&item("new", l("new"), "CmdOrCtrl+N")?)
        .item(&item("open", l("open"), "CmdOrCtrl+O")?)
        .separator()
        .item(&item("save", l("save"), "CmdOrCtrl+S")?)
        .item(&item("saveAs", l("saveAs"), "CmdOrCtrl+Shift+S")?)
        .item(&item("exportPdf", l("exportPdf"), "CmdOrCtrl+Shift+E")?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, Some(l("close")))?);
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().item(&quit);
    let file = file.build()?;

    let edit = SubmenuBuilder::new(app, l("edit"))
        .item(&item("undo", l("undo"), "CmdOrCtrl+Z")?)
        .item(&item("redo", l("redo"), "CmdOrCtrl+Shift+Z")?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let builder = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let builder = {
        let name = app.package_info().name.clone();
        let app_menu = SubmenuBuilder::new(app, name)
            .about(None)
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&quit)
            .build()?;
        builder.item(&app_menu)
    };
    builder.item(&file).item(&edit).build()
}

/// Forwards a menu selection to the focused window as `menu-action`.
pub fn handle_event(app: &AppHandle, id: &str) {
    if id == "quit" {
        for (_, w) in app.webview_windows() {
            let _ = w.close();
        }
    } else if ACTIONS.contains(&id) {
        let label = target_label(app).unwrap_or_else(|| "main".to_string());
        let _ = app.emit_to(
            label.as_str(),
            "menu-action",
            serde_json::json!({ "action": id }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_ja_json_provides_menu_labels() {
        let m = parse_labels(JA_JSON);
        assert_eq!(m["new"], "新規");
        assert_eq!(m.len(), DEFAULTS.len());
        assert!(m.values().all(|v| !v.is_empty()));
    }

    #[test]
    fn missing_keys_fall_back() {
        let m = parse_labels(r#"{"menu":{"new":"New"}}"#);
        assert_eq!(m["new"], "New");
        assert_eq!(m["quit"], "終了");
        assert_eq!(parse_labels("not json")["save"], "保存");
    }
}
