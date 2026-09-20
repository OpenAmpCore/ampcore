use tauri::{AppHandle, Emitter, State};

use ampcore_core::data::amp_model::{AmpModelCatalogEntry, AmpProtocol};
use ampcore_core::data::common::now_millis;
use crate::data::store::{save_amp_models, ProjectDataState};
use ampcore_core::error::AppError;

#[tauri::command]
#[specta::specta]
pub fn amp_models_list(state: State<ProjectDataState>) -> Result<Vec<AmpModelCatalogEntry>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.amp_models.clone())
}

#[tauri::command]
#[specta::specta]
pub fn amp_models_create(
    app: AppHandle,
    state: State<ProjectDataState>,
    brand: String,
    model: String,
    channel_count: u32,
    is_dante: bool,
    protocol: AmpProtocol,
) -> Result<AmpModelCatalogEntry, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let entry = AmpModelCatalogEntry::new(brand, model, channel_count, is_dante, protocol);
    inner.amp_models.push(entry.clone());
    save_amp_models(&inner.data_dir, &inner.amp_models).map_err(AppError::from)?;
    app.emit("amp_model:updated", &inner.amp_models).ok();
    Ok(entry)
}

/// Full-entry replace, mirroring `projects_update`'s pattern. Changing
/// `channel_count` here does NOT retroactively touch any Project's
/// assignments — reconciliation only happens explicitly via
/// `projects_set_amp_model`.
#[tauri::command]
#[specta::specta]
pub fn amp_models_update(
    app: AppHandle,
    state: State<ProjectDataState>,
    mut entry: AmpModelCatalogEntry,
) -> Result<AmpModelCatalogEntry, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let existing = inner
        .amp_models
        .iter_mut()
        .find(|e| e.id == entry.id)
        .ok_or_else(|| AppError::from(format!("amp model {} not found", entry.id)))?;
    entry.updated_at = now_millis();
    *existing = entry.clone();
    save_amp_models(&inner.data_dir, &inner.amp_models).map_err(AppError::from)?;
    app.emit("amp_model:updated", &inner.amp_models).ok();
    Ok(entry)
}

/// Soft-delete — see `AmpModelCatalogEntry.archived` for rationale.
#[tauri::command]
#[specta::specta]
pub fn amp_models_archive(app: AppHandle, state: State<ProjectDataState>, id: String) -> Result<(), AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let entry = inner
        .amp_models
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::from(format!("amp model {} not found", id)))?;
    entry.archived = true;
    entry.updated_at = now_millis();
    save_amp_models(&inner.data_dir, &inner.amp_models).map_err(AppError::from)?;
    app.emit("amp_model:updated", &inner.amp_models).ok();
    Ok(())
}
