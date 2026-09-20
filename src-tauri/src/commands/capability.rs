use tauri::State;

use ampcore_core::data::capability::{resolve, AmpCapability};
use crate::data::store::ProjectDataState;
use ampcore_core::error::AppError;

/// Resolves what can be configured, and within what ranges, for a given amp
/// model + firmware version — purely offline, no live device involved.
/// Nothing here is persisted independently: it's always recomputed from the
/// catalog entry's topology and the (free-text) firmware version string.
#[tauri::command]
#[specta::specta]
pub fn amp_capability_resolve(
    state: State<ProjectDataState>,
    amp_model_id: String,
    firmware_version: Option<String>,
) -> Result<AmpCapability, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    let model = inner
        .amp_models
        .iter()
        .find(|m| m.id == amp_model_id)
        .ok_or_else(|| AppError::from(format!("amp model {} not found", amp_model_id)))?;
    Ok(resolve(model, firmware_version.as_deref()))
}
