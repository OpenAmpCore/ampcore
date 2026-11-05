use tauri::{AppHandle, State};

use ampcore_core::data::amp_link::{normalize_mac, validate_amp_link, AmpLinkValidation};
use ampcore_core::data::amp_merge::{mirror_live_into_assignment, AmpMergeResult};
use ampcore_core::data::edit_lock::{resolve_edit_lock, AmpEditLock, AmpEditLockState, LiveAmpReading};
use ampcore_core::data::fingerprint::{compare_fingerprints, fingerprint_live_device, fingerprint_project_amp};
use ampcore_core::data::device_link::resolve_device_model;
use ampcore_core::data::project::{AmpAssignment, Project};
use crate::data::store;
use crate::data::store::ProjectDataState;
use ampcore_core::error::AppError;
use ampcore_core::live::state::{DiscoveredDevice, LiveDeviceState};
use ampcore_core::live::cvr::write_v118::DEVICE_NAME_FIELD_LEN;
use ampcore_core::live::write_helpers::validate_name;
use super::amp_write::save_or_push;

/// Clones the device out of the live store and releases that lock before the
/// project lock is taken — the two are never held together (same rule as
/// `commands/fingerprint.rs::catalog_snapshot`).
fn live_device(live: &State<LiveDeviceState>, device_id: &str) -> Result<DiscoveredDevice, AppError> {
    let inner = live.lock()?;
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
    let inner = project_data.lock()?;
    let project = store::project(&inner.projects, &project_id)?;
    let assignment = store::assignment(&project, &assignment_id)?;
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
    let mut guard = project_data.lock()?;
    let inner = &mut *guard;

    let validation = {
        let project = store::project(&inner.projects, &project_id)?;
        let assignment = store::assignment(&project, &assignment_id)?;
        validate_amp_link(project, assignment, &device, &inner.amp_models, &inner.device_model_links)
    };
    if let Some(failed) = validation.first_failure() {
        return Err(AppError::from(failed.detail.clone()));
    }

    let project = store::project_mut(&mut inner.projects, &project_id)?;
    let assignment = store::assignment_mut(project, &assignment_id)?;

    assignment.mac = Some(device.mac);
    store::commit(&app, &inner.data_dir, project)
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
    amp_lock(&project_data, &live, &project_id, &assignment_id)
}

/// Ends every live session of the project's amps, for opening it: a session
/// left from before (the project was closed, the amp stayed online) would
/// make `useLinkedSync` adopt whatever the amp got meanwhile — a preset
/// recall, other software — as the project's totals. An amp that still
/// matches starts following again on its first lock read; one that changed
/// stays Mismatch, for the user's Read or Send (`AmpDesyncModal`).
#[tauri::command]
#[specta::specta]
pub fn projects_end_live_sessions(project_data: State<ProjectDataState>, project_id: String) -> Result<(), AppError> {
    let mut guard = project_data.lock()?;
    let inner = &mut *guard;
    let project = store::project(&inner.projects, &project_id)?;
    inner.following.retain(|id| !project.amp_assignments.iter().any(|a| &a.id == id));
    Ok(())
}

/// The edit lock, and the live session it implies: a session starts when the
/// two fingerprints match and ends when the amp goes away or is disengaged —
/// a passing difference keeps it (see `AmpEditLock.following`). Resolved on
/// every lock read, so any caller sees the same session.
pub(crate) fn amp_lock(
    project_data: &State<'_, ProjectDataState>,
    live: &State<'_, LiveDeviceState>,
    project_id: &str,
    assignment_id: &str,
) -> Result<AmpEditLock, AppError> {
    let (project, models, links) = {
        let inner = project_data.lock()?;
        let project = store::project(&inner.projects, &project_id)?.clone();
        (project, inner.amp_models.clone(), inner.device_model_links.clone())
    };
    let assignment = store::assignment(&project, &assignment_id)?;

    let reading = match assignment.mac.as_deref() {
        None => None,
        Some(mac) => read_linked_amp(live, mac)?,
    };

    let mut lock = resolve_edit_lock(&project, assignment, &models, &links, reading.as_ref());
    let mut guard = project_data.lock()?;
    let inner = &mut *guard;
    match lock.state {
        AmpEditLockState::Matches => {
            inner.following.insert(assignment_id.to_string());
        }
        AmpEditLockState::Unlinked | AmpEditLockState::Offline | AmpEditLockState::Disengaged => {
            inner.following.remove(assignment_id);
        }
        AmpEditLockState::Checking | AmpEditLockState::Mismatch | AmpEditLockState::Unreadable => {}
    }
    lock.following = inner.following.contains(assignment_id);
    Ok(lock)
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
    let inner = live.lock()?;
    let reading = inner.devices.values().find(|d| normalize_mac(&d.mac) == mac).map(|device| LiveAmpReading {
        device: device.clone(),
        snapshot: inner.channel_config.get(&device.id).cloned(),
        bridge: inner.bridge.get(&device.id).cloned(),
        fir: inner.fir_of(&device.id),
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
    pull_from_live(&app, &project_data, &live, &project_id, &assignment_id)
}

/// `merge_from_live`, ending the amp's live session when it doesn't merge: a
/// followed amp the project can't mirror is no longer followed.
pub(crate) fn pull_from_live(
    app: &AppHandle,
    project_data: &State<'_, ProjectDataState>,
    live: &State<'_, LiveDeviceState>,
    project_id: &str,
    assignment_id: &str,
) -> Result<AmpMergeResult, AppError> {
    let result = merge_from_live(app, project_data, live, project_id, assignment_id);
    if !matches!(&result, Ok(r) if r.merged) {
        project_data.lock()?.following.remove(assignment_id);
    }
    result
}

fn merge_from_live(
    app: &AppHandle,
    project_data: &State<'_, ProjectDataState>,
    live: &State<'_, LiveDeviceState>,
    project_id: &str,
    assignment_id: &str,
) -> Result<AmpMergeResult, AppError> {
    // The MAC comes from the project store and the reading from the live
    // store — the two locks are never held together.
    let mac = {
        let inner = project_data.lock()?;
        let assignment = store::assignment(store::project(&inner.projects, &project_id)?, &assignment_id)?;
        let mac =
            assignment.mac.clone().ok_or_else(|| AppError::from("This amp isn't linked to a network amp".to_string()))?;
        mac
    };
    let reading = read_linked_amp(live, &mac)?
        .filter(|r| r.device.online)
        .ok_or_else(|| AppError::from("The linked amp is offline".to_string()))?;
    let snapshot = reading
        .snapshot
        .as_ref()
        .ok_or_else(|| AppError::from("The linked amp's settings haven't been read yet".to_string()))?;

    let mut guard = project_data.lock()?;
    let inner = &mut *guard;
    let (candidate, candidate_fp, live_fp) = {
        let project = store::project(&inner.projects, &project_id)?;
        let assignment = store::assignment(&project, &assignment_id)?;
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
            &reading.fir,
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

    let project = store::project_mut(&mut inner.projects, &project_id)?;
    let assignment = store::assignment_mut(project, &assignment_id)?;
    *assignment = candidate;
    let project = store::commit(app, &inner.data_dir, project)?;
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
    let mut guard = project_data.lock()?;
    let inner = &mut *guard;
    let project = store::project_mut(&mut inner.projects, &project_id)?;
    let assignment = store::assignment_mut(project, &assignment_id)?;

    assignment.live_disengaged = disengaged;
    store::commit(&app, &inner.data_dir, project)
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
    let mut guard = project_data.lock()?;
    let inner = &mut *guard;
    let project = store::project_mut(&mut inner.projects, &project_id)?;
    let assignment = store::assignment_mut(project, &assignment_id)?;

    assignment.mac = None;
    // A disengagement from hardware this slot is no longer linked to means
    // nothing, and leaving it set would make a later re-link start silently
    // disengaged.
    assignment.live_disengaged = false;
    store::commit(&app, &inner.data_dir, project)
}

/// Adds a discovered amp to the project as what it reports itself to be —
/// its detected model, its firmware family, its name — already linked by MAC.
/// The one-step form of add-from-the-catalogue, then link: nothing is left
/// half done when a check fails. Its settings are not copied here; the caller
/// pulls them (`projects_merge_amp_from_live`) once the amp has been read.
#[tauri::command]
#[specta::specta]
pub fn projects_add_live_amp(
    app: AppHandle,
    project_data: State<ProjectDataState>,
    live: State<LiveDeviceState>,
    project_id: String,
    device_id: String,
) -> Result<Project, AppError> {
    let device = live_device(&live, &device_id)?;
    if !device.online {
        return Err(AppError::from("The amp is offline".to_string()));
    }
    let mut guard = project_data.lock()?;
    let inner = &mut *guard;

    let model = resolve_device_model(&inner.amp_models, &inner.device_model_links, &device)
        .cloned()
        .ok_or_else(|| AppError::from("Model could not be detected — assign one in Live Control".to_string()))?;
    let firmware = device
        .firmware_family
        .clone()
        .ok_or_else(|| AppError::from(format!("Firmware \"{}\" is not recognized", device.firmware_version)))?;

    let project = store::project_mut(&mut inner.projects, &project_id)?;
    let mac = normalize_mac(&device.mac);
    if project.amp_assignments.iter().any(|a| a.mac.as_deref().map(normalize_mac).as_deref() == Some(mac.as_str())) {
        return Err(AppError::from("This amp is already linked in this project".to_string()));
    }

    let name = Some(device.name.trim().to_string()).filter(|n| !n.is_empty());
    let mut assignment =
        AmpAssignment::new(Some(device.mac), name, model.channel_count, Some(model.id.clone()), Some(firmware));
    assignment.reconcile_matrix_size(model.topology.matrix_input_count);
    assignment.reconcile_eq_bands(model.topology.eq_bands_per_channel);
    project.amp_assignments.push(assignment);
    store::commit(&app, &inner.data_dir, project)
}

/// Renames a project amp and sets the firmware it is planned for — the
/// Workspace's Edit Amp. The device name is part of the amp's fingerprint,
/// so for a linked, online, engaged amp the change is pushed to the amp and
/// only stored once it holds it (`save_or_push`); otherwise it is saved.
/// A linked amp's firmware is its own (adopted on every push and pull), so it
/// can't be changed here, and it keeps a name, as the amp always has one.
#[tauri::command]
#[specta::specta]
pub async fn projects_edit_amp(
    app: AppHandle,
    project_data: State<'_, ProjectDataState>,
    live: State<'_, LiveDeviceState>,
    project_id: String,
    assignment_id: String,
    device_name: Option<String>,
    firmware_version: Option<String>,
) -> Result<Project, AppError> {
    let name = validate_name("Device name", device_name.as_deref().unwrap_or(""), DEVICE_NAME_FIELD_LEN)?.to_string();
    save_or_push(&app, &project_data, &live, project_id, assignment_id, "the name", |candidate, _| {
        let linked = candidate.mac.is_some();
        if linked && name.is_empty() {
            return Err(AppError::from("A linked amp needs a name — the amp always has one"));
        }
        if linked && firmware_version != candidate.firmware_version {
            return Err(AppError::from("The firmware comes from the linked amp"));
        }
        candidate.device_name = Some(name).filter(|n| !n.is_empty());
        candidate.firmware_version = firmware_version;
        Ok(())
    })
    .await
}
