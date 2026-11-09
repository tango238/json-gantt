mod ai;
mod commands;
mod document;
mod error;
mod fileio;
mod menu;
mod migrate;
mod pdf;
mod schema;
mod state;
mod watcher;

use std::path::PathBuf;

use tauri::{Manager, RunEvent, WindowEvent};

use commands::recent::{WindowState, load_window_state, save_window_state};
use commands::window::{dispatch_open, is_json_file};
use state::AppState;

/// `.json` files that exist among process arguments (first element skipped).
/// Relative paths are resolved against `cwd` when given.
fn json_args(args: impl IntoIterator<Item = String>, cwd: Option<&str>) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .map(|p| match cwd {
            Some(c) if p.is_relative() => PathBuf::from(c).join(p),
            _ => p,
        })
        .filter(|p| is_json_file(p))
        .collect()
}

fn restore_window_state(app: &tauri::AppHandle) {
    let (Some(ws), Some(win)) = (load_window_state(app), app.get_webview_window("main")) else {
        return;
    };
    // Skip restoring when the saved rectangle is not on any current monitor.
    let on_screen = win
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .any(|m| {
            let (p, s) = (m.position(), m.size());
            let (cx, cy) = (ws.x + 50.0, ws.y + 50.0);
            cx >= p.x as f64
                && cx < (p.x + s.width as i32) as f64
                && cy >= p.y as f64
                && cy < (p.y + s.height as i32) as f64
        });
    if !on_screen || ws.width < 100.0 || ws.height < 100.0 {
        return;
    }
    let _ = win.set_size(tauri::PhysicalSize::new(ws.width as u32, ws.height as u32));
    let _ = win.set_position(tauri::PhysicalPosition::new(ws.x as i32, ws.y as i32));
    if ws.maximized {
        let _ = win.maximize();
    }
}

fn capture_window_state(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let maximized = win.is_maximized().unwrap_or(false);
    // Keep the previous restored rectangle while maximized.
    if maximized && let Some(mut prev) = load_window_state(app) {
        prev.maximized = true;
        save_window_state(app, &prev);
        return;
    }
    // Inner size: `set_size` on restore is also the inner size.
    if let (Ok(size), Ok(pos)) = (win.inner_size(), win.outer_position()) {
        save_window_state(
            app,
            &WindowState {
                width: size.width as f64,
                height: size.height as f64,
                x: pos.x as f64,
                y: pos.y as f64,
                maximized,
            },
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let paths = json_args(argv, Some(&cwd));
        if paths.is_empty() {
            // Plain second launch: just bring the app forward.
            if let Some(label) = commands::window::target_label(app)
                && let Some(w) = app.get_webview_window(&label)
            {
                let _ = w.set_focus();
            }
        }
        for p in paths {
            dispatch_open(app, p);
        }
    }));

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState::default())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::handle_event(app, event.id().as_ref()))
        .setup(|app| {
            let state = app.state::<AppState>();
            let paths = json_args(std::env::args(), None);
            if !paths.is_empty() {
                state
                    .routing
                    .lock()
                    .unwrap()
                    .pending
                    .insert("main".to_string(), paths);
            }
            // Leftovers of crashed runs.
            ai::cleanup_stale(
                &std::env::temp_dir(),
                std::time::Duration::from_secs(24 * 3600),
            );
            restore_window_state(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::file::open_file,
            commands::file::save_file,
            commands::file::validate,
            commands::recent::get_recent_files,
            commands::recent::add_recent_file,
            commands::pdf::export_pdf,
            commands::ai::ai_locate,
            commands::ai::ai_run,
            commands::ai::ai_stop,
            commands::ai::ai_reset,
            commands::ai::ai_set_claude_path,
            commands::watch::watch_file,
            commands::watch::unwatch_file,
            commands::window::new_window,
            commands::window::focus_window_with_file,
            commands::window::take_pending_open,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => {
            for p in urls.iter().filter_map(|u| u.to_file_path().ok()) {
                dispatch_open(app, p);
            }
        }
        RunEvent::WindowEvent { label, event, .. } => match event {
            WindowEvent::CloseRequested { .. } if label == "main" => capture_window_state(app),
            WindowEvent::Destroyed => app.state::<AppState>().remove_window(&label),
            _ => {}
        },
        RunEvent::Exit => app.state::<AppState>().remove_all_ai(),
        _ => {
            let _ = app;
        }
    });
}
