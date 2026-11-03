use tauri::State;

use ampcore_core::data::amp_model::AmpModelCatalogEntry;
use ampcore_core::data::device_link::DeviceModelLink;
use ampcore_core::data::fingerprint::{self as fp, AmpFingerprint};
use crate::data::store;
use crate::data::store::ProjectDataState;
use ampcore_core::error::AppError;
use ampcore_core::live::state::LiveDeviceState;

/// Read-only: builds the fingerprint of one planned amp from the stored
/// project. No save, no event — see `data/fingerprint.rs` for what is hashed.
#[tauri::command]
#[specta::specta]
pub fn fingerprint_project_amp(
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
) -> Result<AmpFingerprint, AppError> {
    let inner = state.lock()?;
    let project = store::project(&inner.projects, &project_id)?;
    let assignment = store::assignment(project, &assignment_id)?;
    Ok(fp::fingerprint_project_amp(project, assignment, &inner.amp_models))
}

/// Every amp in a project, in assignment order.
#[tauri::command]
#[specta::specta]
pub fn fingerprint_project(state: State<ProjectDataState>, project_id: String) -> Result<Vec<AmpFingerprint>, AppError> {
    let inner = state.lock()?;
    let project = store::project(&inner.projects, &project_id)?;
    Ok(project
        .amp_assignments
        .iter()
        .map(|assignment| fp::fingerprint_project_amp(project, assignment, &inner.amp_models))
        .collect())
}

/// Read-only: fingerprint of a live device from its latest FC=27 snapshot,
/// FC=50 bridge state and the FIR filters the driver has read (FC=43). Fails
/// when no snapshot has arrived yet — the device must be polled first.
#[tauri::command]
#[specta::specta]
pub fn fingerprint_live_device(
    project_data: State<ProjectDataState>,
    live: State<LiveDeviceState>,
    device_id: String,
) -> Result<AmpFingerprint, AppError> {
    let (models, links) = catalog_snapshot(&project_data)?;
    let inner = live.lock()?;
    let fir = inner.fir_of(&device_id);
    let device = inner
        .devices
        .get(&device_id)
        .ok_or_else(|| AppError::from(format!("device {} not found", device_id)))?;
    let snapshot = inner
        .channel_config
        .get(&device_id)
        .ok_or_else(|| AppError::from(format!("no channel config received yet for {}", device_id)))?;
    Ok(fp::fingerprint_live_device(device, snapshot, inner.bridge.get(&device_id), &fir, &models, &links))
}

/// Every discovered device that has an FC=27 snapshot, ordered by device id.
/// Devices never polled are skipped rather than failing the whole call.
#[tauri::command]
#[specta::specta]
pub fn fingerprint_live_devices(
    project_data: State<ProjectDataState>,
    live: State<LiveDeviceState>,
) -> Result<Vec<AmpFingerprint>, AppError> {
    let (models, links) = catalog_snapshot(&project_data)?;
    let inner = live.lock()?;
    let mut devices: Vec<_> = inner.devices.values().collect();
    devices.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(devices
        .into_iter()
        .filter_map(|device| {
            let snapshot = inner.channel_config.get(&device.id)?;
            let fir = inner.fir_of(&device.id);
            Some(fp::fingerprint_live_device(device, snapshot, inner.bridge.get(&device.id), &fir, &models, &links))
        })
        .collect())
}

/// Clones what the live fingerprint needs from the project store and releases
/// that lock before the live lock is taken — the two are never held together.
fn catalog_snapshot(
    project_data: &State<ProjectDataState>,
) -> Result<(Vec<AmpModelCatalogEntry>, Vec<DeviceModelLink>), AppError> {
    let inner = project_data.lock()?;
    Ok((inner.amp_models.clone(), inner.device_model_links.clone()))
}
