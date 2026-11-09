use std::path::PathBuf;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;
use crate::pdf::{PdfOptions, svg_to_pdf};

/// Converts `svg` to PDF and asks where to save it. `Ok(None)` when the dialog is cancelled.
#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    svg: String,
    options: PdfOptions,
) -> Result<Option<String>, AppError> {
    let bytes = svg_to_pdf(&svg, &options)?;
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(&options.default_file_name)
        .blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let mut path: PathBuf = picked
        .into_path()
        .map_err(|e| AppError::io(e.to_string(), None))?;
    if path.extension().is_none() {
        path.set_extension("pdf");
    }
    std::fs::write(&path, bytes).map_err(|e| AppError::io(e.to_string(), Some(&path)))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
