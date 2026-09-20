use tauri::{AppHandle, Emitter, State};

use ampcore_core::data::amp_link::{normalize_mac, validate_amp_link, AmpLinkValidation};
use ampcore_core::data::amp_merge::{mirror_live_into_assignment, AmpMergeResult};
use ampcore_core::data::edit_lock::{resolve_edit_lock, AmpEditLock, LiveAmpReading};
use ampcore_core::data::fingerprint::{compare_fingerprints, fingerprint_live_device, fingerprint_project_amp};
use ampcore_core::data::project::Project;
use crate::data::store::{save_project_file, ProjectDataState};
use crate::error::AppError;
use ampcore_core::live::state::{DiscoveredDevice, LiveDeviceState};

/// Clones the device out of the live store and releases that lock before the
/// project lock is taken — the two are never held together (same rule as
/// `commands/fingerprint.rs::catalog_snapshot`).
fn live_device(live: &State<LiveDeviceState>, device_id: &str) -> Result<DiscoveredDevice, AppError> {
    let inner = live.0.lock().map_err(|e| e.to_string())?;
    let device = inner.devices.get(device_id).cloned();
    device.ok_or_else(|| AppError::from(format!("device {} not found", device_id)))
}

/// Read-only: can `device_id` be linked to this project amp? See
/// `data/amp_link.rs` for the checks.
#[tauri::command]
#[specta::specta]
pub fn projects_validate_amp_link(
    project_data: State<ProjectDataState>,
    live: State<LiveDeviceState>,
    project_id: String,
    assignment_id: String,
    device_id: String,
) -> Result<AmpLinkValidation, AppError> {
    let device = live_device(&live, &device_id)?;
    let inner = project_data.0.lock().map_err(|e| e.to_string())?;
    let project = inner
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    let assignment = project
        .amp_assignments
        .iter()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;
    Ok(validate_amp_link(project, assignment, &device, &inner.amp_models, &inner.device_model_links))
}

/// Links a live device to a project amp by writing its MAC. Re-validates
/// under the project lock and refuses on any failing check — the frontend's
/// earlier validation is never trusted. Config is not touched; matching
/// offline and online settings happens in the editor.
#[tauri::command]
#[specta::specta]
pub fn projects_link_amp(
    app: AppHandle,
    project_data: State<ProjectDataState>,
    live: State<LiveDeviceState>,
    project_id: String,
    assignment_id: String,
    device_id: String,
) -> Result<Project, AppError> {
    let device = live_device(&live, &device_id)?;
    let mut inner = project_data.0.lock().map_err(|e| e.to_string())?;

    let validation = {
        let project = inner
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
        let assignment = project
            .amp_assignments
            .iter()
            .find(|a| a.id == assignment_id)
            .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;
        validate_amp_link(project, assignment, &device, &inner.amp_models, &inner.device_model_links)
    };
    if let Some(failed) = validation.first_failure() {
        return Err(AppError::from(failed.detail.clone()));
    }

    let project = inner
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    let assignment = project
        .amp_assignments
        .iter_mut()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;

    assignment.mac = Some(device.mac);
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}

/// Read-only: whether this project amp is editable right now, with both
/// fingerprints and the field-by-field comparison when it's locked. See
/// `data/edit_lock.rs`.
#[tauri::command]
#[specta::specta]
pub fn projects_amp_edit_lock(
    project_data: State<ProjectDataState>,
    live: State<LiveDeviceState>,
    project_id: String,
    assignment_id: String,
) -> Result<AmpEditLock, AppError> {
    let (project, models, links) = {
        let inner = project_data.0.lock().map_err(|e| e.to_string())?;
        let project = inner
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
        (project, inner.amp_models.clone(), inner.device_model_links.clone())
    };
    let assignment = project
        .amp_assignments
        .iter()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;

    let reading = match assignment.mac.as_deref() {
        None => None,
        Some(mac) => read_linked_amp(&live, mac)?,
    };

    Ok(resolve_edit_lock(&project, assignment, &models, &links, reading.as_ref()))
}

/// Shared with `amp_push.rs` rather than duplicated: a pull and a push need
/// exactly the same reading, and a divergence between how the two see one
/// amp is the kind of difference nobody would think to look for.
/// Clones what the live store knows about the discovered amp with `mac`, then
/// releases the live lock. `None` when no discovered amp has that MAC.
pub(crate) fn read_linked_amp(
    live: &State<'_, LiveDeviceState>,
    mac: &str,
) -> Result<Option<LiveAmpReading>, AppError> {
    let mac = normalize_mac(mac);
    let inner = live.0.lock().map_err(|e| e.to_string())?;
    let reading = inner.devices.values().find(|d| normalize_mac(&d.mac) == mac).map(|device| LiveAmpReading {
        device: device.clone(),
        snapshot: inner.channel_config.get(&device.id).cloned(),
        bridge: inner.bridge.get(&device.id).cloned(),
    });
    Ok(reading)
}

/// Copies the linked network amp's settings into this project amp (offline ←
/// online). All or nothing: the mirrored candidate is re-fingerprinted and
/// only saved when its amp hash equals the online amp's; otherwise nothing is
/// written and the still-differing rows come back. See `data/amp_merge.rs`
/// for what is and isn't copied.
#[tauri::command]
#[specta::specta]
pub fn projects_merge_amp_from_live(
    app: AppHandle,
    project_data: State<ProjectDataState>,
    live: State<LiveDeviceState>,
    project_id: String,
    assignment_id: String,
) -> Result<AmpMergeResult, AppError> {
    // The MAC comes from the project store and the reading from the live
    // store — the two locks are never held together.
    let mac = {
        let inner = project_data.0.lock().map_err(|e| e.to_string())?;
        let assignment = inner
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?
            .amp_assignments
            .iter()
            .find(|a| a.id == assignment_id)
            .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;
        let mac =
            assignment.mac.clone().ok_or_else(|| AppError::from("This amp isn't linked to a network amp".to_string()))?;
        mac
    };
    let reading = read_linked_amp(&live, &mac)?
        .filter(|r| r.device.online)
        .ok_or_else(|| AppError::from("The linked amp is offline".to_string()))?;
    let snapshot = reading
        .snapshot
        .as_ref()
        .ok_or_else(|| AppError::from("The linked amp's settings haven't been read yet".to_string()))?;

    let mut inner = project_data.0.lock().map_err(|e| e.to_string())?;
    let (candidate, candidate_fp, live_fp) = {
        let project = inner
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
        let assignment = project
            .amp_assignments
            .iter()
            .find(|a| a.id == assignment_id)
            .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;
        // The link can change while the live store is being read.
        if assignment.mac.as_deref().map(normalize_mac) != Some(normalize_mac(&mac)) {
            return Err(AppError::from("The amp's link changed — try again".to_string()));
        }
        let model = assignment
            .amp_model_id
            .as_deref()
            .and_then(|id| inner.amp_models.iter().find(|m| m.id == id))
            .ok_or_else(|| AppError::from("The project amp has no model assigned".to_string()))?;

        let live_fp = fingerprint_live_device(
            &reading.device,
            snapshot,
            reading.bridge.as_ref(),
            &inner.amp_models,
            &inner.device_model_links,
        );
        if let Some(reason) = live_fp.missing.first() {
            return Err(AppError::from(format!("The online amp can't be read completely: {reason}")));
        }
        let eq_bands_differ = assignment.channels.iter().any(|channel| {
            snapshot.channels.iter().find(|c| c.channel_index == channel.channel_index).is_some_and(|config| {
                config.input_eq.bands.len() != channel.input_eq.bands.len()
                    || config.output_eq.bands.len() != channel.output_eq.bands.len()
            })
        });
        if eq_bands_differ {
            return Err(AppError::from("The offline and online amp have different EQ band counts".to_string()));
        }

        let candidate = mirror_live_into_assignment(assignment, &reading, model.topology.matrix_input_count);
        let candidate_fp = fingerprint_project_amp(project, &candidate, &inner.amp_models);
        if let Some(reason) = candidate_fp.missing.first() {
            return Err(AppError::from(format!("The offline amp can't be fingerprinted: {reason}")));
        }
        let (planned, online) = (&candidate_fp.identity, &live_fp.identity);
        if planned.model != online.model
            || planned.channel_count != online.channel_count
            || planned.firmware_family != online.firmware_family
        {
            return Err(AppError::from(
                "The offline and online amp differ in model, channel count or firmware — re-link the amp".to_string(),
            ));
        }
        (candidate, candidate_fp, live_fp)
    };

    if candidate_fp.amp_hash != live_fp.amp_hash {
        return Ok(AmpMergeResult {
            merged: false,
            project: None,
            amp_hash: None,
            remaining: compare_fingerprints(&candidate_fp, &live_fp),
        });
    }

    let project = inner
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    let assignment = project
        .amp_assignments
        .iter_mut()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;
    *assignment = candidate;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(AmpMergeResult { merged: true, project: Some(project), amp_hash: live_fp.amp_hash, remaining: Vec::new() })
}

/// Steps a project amp in or out of the live session with its linked amp by
/// hand. While disengaged the plan edits exactly as it does for an offline
/// amp and nothing reaches the hardware; see
/// `edit_lock::AmpEditLockState::Disengaged` for how the flag is applied, and
/// `AmpAssignment.live_disengaged` for why it is persisted rather than held
/// in the UI.
#[tauri::command]
#[specta::specta]
pub fn projects_set_amp_live_disengaged(
    app: AppHandle,
    project_data: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    disengaged: bool,
) -> Result<Project, AppError> {
    let mut inner = project_data.0.lock().map_err(|e| e.to_string())?;
    let project = inner
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    let assignment = project
        .amp_assignments
        .iter_mut()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;

    assignment.live_disengaged = disengaged;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}

/// Clears a project amp's linked MAC. Planned config is left untouched.
#[tauri::command]
#[specta::specta]
pub fn projects_unlink_amp(
    app: AppHandle,
    project_data: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
) -> Result<Project, AppError> {
    let mut inner = project_data.0.lock().map_err(|e| e.to_string())?;
    let project = inner
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    let assignment = project
        .amp_assignments
        .iter_mut()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;

    assignment.mac = None;
    // A disengagement from hardware this slot is no longer linked to means
    // nothing, and leaving it set would make a later re-link start silently
    // disengaged.
    assignment.live_disengaged = false;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}
