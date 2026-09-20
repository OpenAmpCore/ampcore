use tauri::State;

use ampcore_core::data::amp_model::AmpModelCatalogEntry;
use ampcore_core::data::device_link::DeviceModelLink;
use ampcore_core::data::fingerprint::{self as fp, AmpFingerprint};
use crate::data::store::ProjectDataState;
use ampcore_core::error::AppError;
use ampcore_core::live::state::LiveDeviceState;

use super::live_control::live_control_fetch_channel_fir;

/// Read-only: builds the fingerprint of one planned amp from the stored
/// project. No save, no event — see `data/fingerprint.rs` for what is hashed.
#[tauri::command]
#[specta::specta]
pub fn fingerprint_project_amp(
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
) -> Result<AmpFingerprint, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    let project = inner
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    let assignment = project
        .amp_assignments
        .iter()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("amp assignment {} not found", assignment_id)))?;
    Ok(fp::fingerprint_project_amp(project, assignment, &inner.amp_models))
}

/// Every amp in a project, in assignment order.
#[tauri::command]
#[specta::specta]
pub fn fingerprint_project(state: State<ProjectDataState>, project_id: String) -> Result<Vec<AmpFingerprint>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    let project = inner
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    Ok(project
        .amp_assignments
        .iter()
        .map(|assignment| fp::fingerprint_project_amp(project, assignment, &inner.amp_models))
        .collect())
}

/// Read-only: fingerprint of a live device from its latest FC=27 snapshot
/// (plus FC=50 bridge state). Fails when no snapshot has arrived yet — the
/// device must be polled first.
#[tauri::command]
#[specta::specta]
pub fn fingerprint_live_device(
    project_data: State<ProjectDataState>,
    live: State<LiveDeviceState>,
    device_id: String,
) -> Result<AmpFingerprint, AppError> {
    let (models, links) = catalog_snapshot(&project_data)?;
    let inner = live.0.lock().map_err(|e| e.to_string())?;
    let device = inner
        .devices
        .get(&device_id)
        .ok_or_else(|| AppError::from(format!("device {} not found", device_id)))?;
    let snapshot = inner
        .channel_config
        .get(&device_id)
        .ok_or_else(|| AppError::from(format!("no channel config received yet for {}", device_id)))?;
    Ok(fp::fingerprint_live_device(device, snapshot, inner.bridge.get(&device_id), &models, &links))
}

/// `fingerprint_live_device` plus one FIR read (FC=43) per output channel.
///
/// A separate command rather than a flag on the synchronous one, because
/// `projects_amp_edit_lock` rebuilds a live fingerprint on every FC=27 poll
/// tick (see `useAmpEditLock`) — putting eight five-fragment FIR exchanges on
/// that path would saturate the line several times a second. This is the
/// opt-in variant, called only by the fingerprint inspector.
///
/// Reads are sequential, never concurrent: the per-IP reassembler cannot
/// interleave two fragmented exchanges. Per-channel failures are swallowed —
/// an unreadable (or pre-1.1.8, which `live_control_fetch_channel_fir` refuses
/// before any I/O) channel simply keeps `fir: None` rather than failing the
/// whole fingerprint, and nothing is added to `missing`, which would null
/// `amp_hash` and flip the editor to `Unreadable`.
#[tauri::command]
#[specta::specta]
pub async fn fingerprint_live_device_with_fir(
    project_data: State<'_, ProjectDataState>,
    live: State<'_, LiveDeviceState>,
    device_id: String,
) -> Result<AmpFingerprint, AppError> {
    let mut fingerprint = {
        let (models, links) = catalog_snapshot(&project_data)?;
        let inner = live.0.lock().map_err(|e| e.to_string())?;
        let device = inner
            .devices
            .get(&device_id)
            .ok_or_else(|| AppError::from(format!("device {} not found", device_id)))?;
        let snapshot = inner
            .channel_config
            .get(&device_id)
            .ok_or_else(|| AppError::from(format!("no channel config received yet for {}", device_id)))?;
        fp::fingerprint_live_device(device, snapshot, inner.bridge.get(&device_id), &models, &links)
    };

    let indices: Vec<u32> = fingerprint.channels.iter().map(|c| c.channel_index).collect();
    let mut snapshots = Vec::new();
    for index in indices {
        if let Ok(read) = live_control_fetch_channel_fir(live.clone(), device_id.clone(), index as u8).await {
            snapshots.push(read.fir);
        }
    }
    fp::attach_fir_stats(&mut fingerprint, &snapshots);
    Ok(fingerprint)
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
    let inner = live.0.lock().map_err(|e| e.to_string())?;
    let mut devices: Vec<_> = inner.devices.values().collect();
    devices.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(devices
        .into_iter()
        .filter_map(|device| {
            let snapshot = inner.channel_config.get(&device.id)?;
            Some(fp::fingerprint_live_device(device, snapshot, inner.bridge.get(&device.id), &models, &links))
        })
        .collect())
}

/// Clones what the live fingerprint needs from the project store and releases
/// that lock before the live lock is taken — the two are never held together.
fn catalog_snapshot(
    project_data: &State<ProjectDataState>,
) -> Result<(Vec<AmpModelCatalogEntry>, Vec<DeviceModelLink>), AppError> {
    let inner = project_data.0.lock().map_err(|e| e.to_string())?;
    Ok((inner.amp_models.clone(), inner.device_model_links.clone()))
}
