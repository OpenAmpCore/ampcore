use tauri::{AppHandle, Emitter, State};

use ampcore_core::data::amp_model::AmpModelCatalogEntry;
use ampcore_core::data::common::now_millis;
use ampcore_core::data::device_link::{match_catalog_model, DeviceModelLink};
use crate::data::store::{save_device_model_links, ProjectDataState};
use crate::error::AppError;

/// Resolves which catalog model a live device (identified by `mac`) should
/// be configured as. An existing manual pick (`auto_matched: false`) always
/// wins and is returned as-is, never re-matched. Otherwise runs
/// `match_catalog_model`; on a confident match, upserts an `auto_matched:
/// true` link (safe to silently refresh on every reconnect) and returns it;
/// on no confident match, returns `None` rather than guessing.
#[tauri::command]
#[specta::specta]
pub fn device_model_link_auto_match(
    app: AppHandle,
    state: State<ProjectDataState>,
    mac: String,
    firmware_version: String,
    digital_input_channels: u32,
    output_channels: u32,
) -> Result<Option<AmpModelCatalogEntry>, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(existing) = inner.device_model_links.iter().find(|l| l.mac == mac) {
        if !existing.auto_matched {
            return Ok(inner.amp_models.iter().find(|m| m.id == existing.amp_model_id).cloned());
        }
    }

    let Some(matched) =
        match_catalog_model(&inner.amp_models, &firmware_version, digital_input_channels, output_channels).cloned()
    else {
        return Ok(None);
    };

    let now = now_millis();
    match inner.device_model_links.iter_mut().find(|l| l.mac == mac) {
        Some(link) => {
            link.amp_model_id = matched.id.clone();
            link.updated_at = now;
        }
        None => {
            inner.device_model_links.push(DeviceModelLink {
                mac: mac.clone(),
                amp_model_id: matched.id.clone(),
                auto_matched: true,
                updated_at: now,
            });
        }
    }
    save_device_model_links(&inner.data_dir, &inner.device_model_links).map_err(AppError::from)?;
    app.emit("device_model_link:updated", &inner.device_model_links).ok();
    Ok(Some(matched))
}

/// Explicit manual pick/clear — always `auto_matched: false`, so a later
/// `device_model_link_auto_match` call never silently overrides it.
/// `amp_model_id: None` clears any existing link for this `mac`.
#[tauri::command]
#[specta::specta]
pub fn device_model_link_set(
    app: AppHandle,
    state: State<ProjectDataState>,
    mac: String,
    amp_model_id: Option<String>,
) -> Result<Option<DeviceModelLink>, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;

    inner.device_model_links.retain(|l| l.mac != mac);
    let result = amp_model_id.map(|amp_model_id| DeviceModelLink {
        mac: mac.clone(),
        amp_model_id,
        auto_matched: false,
        updated_at: now_millis(),
    });
    if let Some(link) = &result {
        inner.device_model_links.push(link.clone());
    }
    save_device_model_links(&inner.data_dir, &inner.device_model_links).map_err(AppError::from)?;
    app.emit("device_model_link:updated", &inner.device_model_links).ok();
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn device_model_link_get_all(state: State<ProjectDataState>) -> Result<Vec<DeviceModelLink>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.device_model_links.clone())
}
