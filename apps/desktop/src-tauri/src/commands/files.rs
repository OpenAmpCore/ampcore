use tauri::AppHandle;

use ampcore_core::error::AppError;
use crate::data::store::write_atomic;

/// Native "Save as" for anything the app exports as text — a FIR filter, a
/// project, the speaker library. A webview `<a download>` is a no-op inside
/// Tauri. `filter_name`/`extensions` set the dialog's file-type filter.
/// Returns `false` when the user cancels the dialog.
#[tauri::command]
#[specta::specta]
pub async fn save_text_file(
    app: AppHandle,
    default_name: String,
    contents: String,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<bool, AppError> {
    use tauri_plugin_dialog::DialogExt;
    let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let Some(path) = app.dialog().file().set_file_name(&default_name).add_filter(&filter_name, &extensions).blocking_save_file()
    else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| AppError::from(e.to_string()))?;
    write_atomic(&path, contents.as_bytes()).map_err(AppError::from)?;
    Ok(true)
}
