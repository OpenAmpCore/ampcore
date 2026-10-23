use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, State};

use ampcore_core::data::amp_model::AmpModelCatalogEntry;
use ampcore_core::data::capability::cvr::{cvr_param_ranges, CvrFirmwareCapability};
use ampcore_core::data::capability::{PowerMode, SourceKind};
use ampcore_core::data::validation::{self, AmpLimits};
use ampcore_core::data::channel_clipboard::{copy_from_project, paste_into_project, ChannelClip, ClipSection};
use ampcore_core::data::project::{
    AmpAssignment, AmpChannel, BackupPriorityPatch, ChannelFir, ChannelSource, CrossoverSlotKind, CrossoverSlotPatch, EqBandPatch,
    EqDirection, LimiterPatch, Project, SourceTrimPatch,
};
use ampcore_core::data::common::{new_id, now_millis};
use ampcore_core::live::cvr::fir::FIR_MAX_TAPS;
use crate::data::exchange::{add_missing, export_project, import_project};
use crate::data::store::{
    delete_project_file, reconcile_project_eq_band_sizes, reconcile_project_matrix_sizes, save_amp_models,
    save_project_file, save_speakers, ProjectDataState,
};
use ampcore_core::error::AppError;
use ampcore_core::live::state::LiveDeviceState;
use super::speakers::{candidate_of, save_or_push};

fn find_amp_model<'a>(models: &'a [AmpModelCatalogEntry], id: &str) -> Option<&'a AmpModelCatalogEntry> {
    models.iter().find(|m| m.id == id)
}

/// What an assignment's values are checked against: its planned firmware's
/// ranges and its model's rated voltage. CVR is the only protocol, so the
/// ranges don't need the model itself.
fn assignment_limits(models: &[AmpModelCatalogEntry], assignment: &AmpAssignment) -> AmpLimits {
    AmpLimits {
        ranges: cvr_param_ranges(&CvrFirmwareCapability::from_version(assignment.firmware_version.as_deref())),
        rated_rms_voltage: assignment
            .amp_model_id
            .as_deref()
            .and_then(|id| find_amp_model(models, id))
            .and_then(|m| m.topology.rated_rms_voltage),
    }
}

/// The mutation pipeline every amp-level command shares: lock → find project →
/// find assignment → `edit` → touch → save → emit `project:updated`. An error
/// from `edit` aborts before anything is saved. `edit` gets the assignment's
/// limits, so a setter can refuse a value before storing it.
fn edit_assignment(
    app: &AppHandle,
    state: &State<ProjectDataState>,
    project_id: &str,
    assignment_id: &str,
    edit: impl FnOnce(&mut AmpAssignment, &AmpLimits) -> Result<(), AppError>,
) -> Result<Project, AppError> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let inner = &mut *guard;
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
    let limits = assignment_limits(&inner.amp_models, assignment);
    edit(assignment, &limits)?;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}

/// `edit_assignment` narrowed to one channel.
fn edit_channel(
    app: &AppHandle,
    state: &State<ProjectDataState>,
    project_id: &str,
    assignment_id: &str,
    channel_index: u32,
    edit: impl FnOnce(&mut AmpChannel, &AmpLimits) -> Result<(), AppError>,
) -> Result<Project, AppError> {
    edit_assignment(app, state, project_id, assignment_id, |assignment, limits| {
        let channel = assignment
            .channels
            .iter_mut()
            .find(|c| c.channel_index == channel_index)
            .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;
        edit(channel, limits)
    })
}

#[tauri::command]
#[specta::specta]
pub fn projects_list(state: State<ProjectDataState>) -> Result<Vec<Project>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.projects.clone())
}

#[tauri::command]
#[specta::specta]
pub fn projects_get(state: State<ProjectDataState>, id: String) -> Result<Option<Project>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.projects.iter().find(|p| p.id == id).cloned())
}

#[tauri::command]
#[specta::specta]
pub fn projects_create(
    app: AppHandle,
    state: State<ProjectDataState>,
    name: String,
    description: String,
) -> Result<Project, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let project = Project::new(name, description);
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    inner.projects.push(project.clone());
    app.emit("project:updated", &project).ok();
    Ok(project)
}

/// Full-document replace, matching the old app's PUT-whole-project pattern.
/// Bumps `updated_at` regardless of what the caller passed.
#[tauri::command]
#[specta::specta]
pub fn projects_update(
    app: AppHandle,
    state: State<ProjectDataState>,
    mut project: Project,
) -> Result<Project, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    if !inner.projects.iter().any(|p| p.id == project.id) {
        return Err(AppError::from(format!("project {} not found", project.id)));
    }
    project.touch();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    if let Some(slot) = inner.projects.iter_mut().find(|p| p.id == project.id) {
        *slot = project.clone();
    }
    app.emit("project:updated", &project).ok();
    Ok(project)
}

/// What startup couldn't open — files set aside as unreadable, or saved by a
/// newer AmpCore — for the project list to show.
#[tauri::command]
#[specta::specta]
pub fn projects_load_problems(state: State<ProjectDataState>) -> Result<Vec<String>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.load_problems.clone())
}

/// A copy of a project under a new id and "<name> (copy)". Amps stay linked to
/// the same network amps, so a copy can be a variant of one rig.
#[tauri::command]
#[specta::specta]
pub fn projects_duplicate(app: AppHandle, state: State<ProjectDataState>, project_id: String) -> Result<Project, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let mut copy = inner
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .cloned()
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    let now = now_millis();
    copy.id = new_id();
    copy.name = format!("{} (copy)", copy.name);
    copy.created_at = now;
    copy.updated_at = now;
    save_project_file(&inner.data_dir, &copy).map_err(AppError::from)?;
    inner.projects.push(copy.clone());
    app.emit("project:updated", &copy).ok();
    Ok(copy)
}

/// The project as an export file's text (`data/exchange.rs`), for the caller
/// to save where the user picks.
#[tauri::command]
#[specta::specta]
pub fn projects_export(state: State<ProjectDataState>, project_id: String) -> Result<String, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    let project = inner
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    export_project(project, &inner.speakers, &inner.amp_models).map_err(AppError::from)
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImport {
    pub project: Project,
    /// Library speakers and custom amp models the file brought that this
    /// machine didn't have.
    pub speakers_added: u32,
    pub amp_models_added: u32,
}

/// Imports an exported project (or a bare project file) as a new project:
/// a fresh id, so importing the same file twice gives two, and " (imported)"
/// after the name when one is already taken. Its speakers and custom amp
/// models are added to this machine's library and catalogue where missing.
#[tauri::command]
#[specta::specta]
pub fn projects_import(app: AppHandle, state: State<ProjectDataState>, text: String) -> Result<ProjectImport, AppError> {
    let imported = import_project(&text).map_err(|e| AppError::from(format!("This file can't be imported: {e}")))?;
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let inner = &mut *guard;

    let amp_models_added = add_missing(&mut inner.amp_models, imported.amp_models, |m| &m.id);
    if amp_models_added > 0 {
        save_amp_models(&inner.data_dir, &inner.amp_models).map_err(AppError::from)?;
        app.emit("amp_model:updated", &inner.amp_models).ok();
    }
    let speakers_added = add_missing(&mut inner.speakers, imported.speakers, |e| &e.id);
    if speakers_added > 0 {
        save_speakers(&inner.data_dir, &inner.speakers).map_err(AppError::from)?;
        app.emit("speakers:updated", &inner.speakers).ok();
    }

    let mut project = imported.project;
    project.id = new_id();
    project.touch();
    if inner.projects.iter().any(|p| p.name == project.name) {
        project.name = format!("{} (imported)", project.name);
    }
    // The file's amps may predate a topology change on this machine's models.
    reconcile_project_matrix_sizes(&mut project, &inner.amp_models);
    reconcile_project_eq_band_sizes(&mut project, &inner.amp_models);
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    inner.projects.push(project.clone());
    app.emit("project:updated", &project).ok();
    Ok(ProjectImport { project, speakers_added: speakers_added as u32, amp_models_added: amp_models_added as u32 })
}

#[tauri::command]
#[specta::specta]
pub fn projects_delete(app: AppHandle, state: State<ProjectDataState>, id: String) -> Result<(), AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    delete_project_file(&inner.data_dir, &id).map_err(AppError::from)?;
    inner.projects.retain(|p| p.id != id);
    app.emit("project:deleted", &id).ok();
    Ok(())
}

/// Adds an amp assignment to a project by model/name alone — `mac` starts
/// unset (`None`) and is linked later via live network discovery, not typed
/// in manually. If `amp_model_id` references a catalog entry, its channel
/// count pre-populates the assignment's channels.
#[tauri::command]
#[specta::specta]
pub fn projects_add_amp_assignment(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    device_name: Option<String>,
    amp_model_id: Option<String>,
    firmware_version: Option<String>,
) -> Result<Project, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;

    let (channel_count, matrix_input_count, eq_bands_per_channel) = match &amp_model_id {
        Some(id) => {
            let model = find_amp_model(&inner.amp_models, id)
                .ok_or_else(|| AppError::from(format!("amp model {} not found", id)))?;
            (
                model.channel_count,
                model.topology.matrix_input_count,
                model.topology.eq_bands_per_channel,
            )
        }
        None => (0, 0, 0),
    };

    let mut assignment = AmpAssignment::new(None, device_name, channel_count, amp_model_id, firmware_version);
    assignment.reconcile_matrix_size(matrix_input_count);
    assignment.reconcile_eq_bands(eq_bands_per_channel);
    let limits = assignment_limits(&inner.amp_models, &assignment);
    assignment.fit_limiters(limits.rated_rms_voltage, &limits.ranges);
    let project = inner
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    project.amp_assignments.push(assignment);
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}

#[tauri::command]
#[specta::specta]
pub fn projects_remove_amp_assignment(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
) -> Result<Project, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let project = inner
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;

    project.amp_assignments.retain(|a| a.id != assignment_id);
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}

/// Changes (or clears) an assignment's amp model, reconciling its channel
/// count additively — grows/shrinks `channels`, preserving existing
/// per-channel config where indices still exist. Never a destructive wipe.
#[tauri::command]
#[specta::specta]
pub fn projects_set_amp_model(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    amp_model_id: Option<String>,
) -> Result<Project, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;

    let (channel_count, matrix_input_count, eq_bands_per_channel, rated_rms_voltage) = match &amp_model_id {
        Some(id) => {
            let model = find_amp_model(&inner.amp_models, id)
                .ok_or_else(|| AppError::from(format!("amp model {} not found", id)))?;
            (
                model.channel_count,
                model.topology.matrix_input_count,
                model.topology.eq_bands_per_channel,
                model.topology.rated_rms_voltage,
            )
        }
        None => (0, 0, 0, None),
    };

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

    assignment.amp_model_id = amp_model_id;
    if channel_count > 0 {
        assignment.reconcile_channel_count(channel_count);
    }
    assignment.reconcile_matrix_size(matrix_input_count);
    assignment.reconcile_eq_bands(eq_bands_per_channel);
    // A smaller model's output caps the planned limiter thresholds.
    let ranges = cvr_param_ranges(&CvrFirmwareCapability::from_version(assignment.firmware_version.as_deref()));
    assignment.fit_limiters(rated_rms_voltage, &ranges);
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}

#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_ohms(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    ohms: f64,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, _| {
        if !(ohms.is_finite() && ohms > 0.0) {
            return Err(AppError::from(format!("Load {ohms} Ω must be a positive number")));
        }
        channel.ohms = ohms;
        Ok(())
    })
}

/// Sets which physical source feeds a channel's input — Routing tab. There is
/// no "no source": a physical input always has one. A `kind` with no `index`
/// defaults to physical input 0 of that kind.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_source(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    kind: SourceKind,
    index: Option<u32>,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, _| {
        if kind == SourceKind::Aes3 {
            return Err(AppError::from("AES3 is shown as the amp reports it, but can't be selected here"));
        }
        channel.source = ChannelSource { kind, index: index.unwrap_or(0) };
        Ok(())
    })
}

/// Partial update of one source's trim/delay pair — Routing tab. Each source
/// keeps its own pair regardless of which one is selected, so this is
/// addressed by `kind` rather than editing "the current source".
///
/// `SourceKind::Backup` is rejected: it is a failover *state*, not an input
/// with its own gain matching, and the amp has no trim slot for it.
#[tauri::command]
#[specta::specta]
pub fn projects_set_source_trim(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    kind: SourceKind,
    patch: SourceTrimPatch,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, limits| {
        let r = &limits.ranges;
        let (trim, trim_range) = match kind {
            SourceKind::Analog => (&mut channel.source_trims.analog, r.source_trim_analog_db),
            SourceKind::Dante => (&mut channel.source_trims.dante, r.source_trim_digital_db),
            SourceKind::Backup | SourceKind::Aes3 => {
                return Err(AppError::from(format!("{kind:?} has no trim of its own")))
            }
        };
        // Only the half being set: an older delay above today's ceiling
        // mustn't block a trim edit.
        if let Some(trim_db) = patch.trim_db {
            validation::check_range(&format!("{kind:?} trim"), " dB", trim_db, trim_range)?;
        }
        if let Some(delay_ms) = patch.delay_ms {
            validation::check_range(&format!("{kind:?} delay"), " ms", delay_ms, r.source_delay_ms)?;
        }
        if let Some(trim_db) = patch.trim_db {
            trim.trim_db = trim_db;
        }
        if let Some(delay_ms) = patch.delay_ms {
            trim.delay_ms = delay_ms;
        }
        Ok(())
    })
}

/// Partial update of a channel's backup/auto-source switching — Routing tab.
///
/// `first`/`second` are raw source codes in the amp's own space (0=Analog,
/// 1=Dante), not `SourceKind`s, because that is how the amp stores them; the
/// frontend derives `second` as the complement of `first`, since with two
/// sources the fallback is never a free choice.
#[tauri::command]
#[specta::specta]
pub fn projects_set_backup_priority(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    patch: BackupPriorityPatch,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, limits| {
        if let Some(threshold_db) = patch.threshold_db {
            validation::check_range("Backup threshold", " dB", f64::from(threshold_db), limits.ranges.backup_threshold_db)?;
        }
        if patch.first.is_some_and(|c| c > 1) || patch.second.is_some_and(|c| c > 1) {
            return Err(AppError::from("Backup priorities must be Analog or Dante"));
        }
        let priority = &mut channel.backup_priority;
        if let Some(enabled) = patch.enabled {
            priority.enabled = enabled;
        }
        if let Some(first) = patch.first {
            priority.first = first;
        }
        if let Some(second) = patch.second {
            priority.second = second;
        }
        if let Some(threshold_db) = patch.threshold_db {
            priority.threshold_db = threshold_db;
        }
        Ok(())
    })
}

/// Partial update of one Matrix-tab crosspoint — only touches the fields the
/// caller passes (`Some`), matching the other partial-update commands'
/// per-field-optional convention. Fails if the crosspoint doesn't exist yet
/// (it should always exist by the time the UI can edit it, since
/// `reconcile_matrix_size` pre-populates every crosspoint for the model's
/// `matrix_input_count`).
#[tauri::command]
#[specta::specta]
pub fn projects_set_matrix_crosspoint(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    source_index: u32,
    gain_db: Option<f64>,
    active: Option<bool>,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, limits| {
        if let Some(gain_db) = gain_db {
            validation::check_range("Matrix gain", " dB", gain_db, limits.ranges.matrix_gain_db)?;
        }
        let crosspoint = channel
            .matrix_crosspoints
            .iter_mut()
            .find(|c| c.source_index == source_index)
            .ok_or_else(|| AppError::from(format!("matrix source {} not found", source_index)))?;

        if let Some(gain_db) = gain_db {
            crosspoint.gain_db = gain_db;
        }
        if let Some(active) = active {
            crosspoint.active = active;
        }
        Ok(())
    })
}

/// Sets a channel's input delay — Input tab.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_delay_in(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    delay_in_ms: f64,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, limits| {
        validation::check_range("Input delay", " ms", delay_in_ms, limits.ranges.delay_in_ms)?;
        channel.delay_in_ms = delay_in_ms;
        Ok(())
    })
}

/// Sets whether a channel's input is muted — Input tab.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_input_mute(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    muted: bool,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, _| {
        channel.input_muted = muted;
        Ok(())
    })
}

/// Partial update of a channel's output trim/volume/delay — Output tab. Only
/// touches the fields the caller passes (`Some`), matching
/// `projects_set_matrix_crosspoint`'s per-field-optional convention.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_output(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    trim_db: Option<f64>,
    volume_db: Option<f64>,
    delay_out_ms: Option<f64>,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, limits| {
        let r = &limits.ranges;
        if let Some(v) = trim_db {
            validation::check_range("Output trim", " dB", v, r.output_trim_db)?;
        }
        if let Some(v) = volume_db {
            validation::check_range("Output volume", " dB", v, r.output_volume_db)?;
        }
        if let Some(v) = delay_out_ms {
            validation::check_range("Output delay", " ms", v, r.delay_out_ms)?;
        }
        if let Some(trim_db) = trim_db {
            channel.output_trim_db = trim_db;
        }
        if let Some(volume_db) = volume_db {
            channel.output_volume_db = volume_db;
        }
        if let Some(delay_out_ms) = delay_out_ms {
            channel.delay_out_ms = delay_out_ms;
        }
        Ok(())
    })
}

/// Partial update of a channel's HP or LP crossover slot (band 0 / band 9 of
/// its `input_eq`/`output_eq` chain) — EQ sub-tab. Only touches the fields
/// the caller passes (`Some`), matching `projects_set_matrix_crosspoint`'s
/// per-field-optional convention.
#[tauri::command]
#[specta::specta]
pub fn projects_set_crossover_slot(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    direction: EqDirection,
    slot: CrossoverSlotKind,
    patch: CrossoverSlotPatch,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, limits| {
        if let Some(freq_hz) = patch.freq_hz {
            let name = match slot {
                CrossoverSlotKind::Hp => "HP",
                CrossoverSlotKind::Lp => "LP",
            };
            validation::check_crossover_freq(name, freq_hz, &limits.ranges)?;
        }
        let eq = match direction {
            EqDirection::Input => &mut channel.input_eq,
            EqDirection::Output => &mut channel.output_eq,
        };
        let crossover = match slot {
            CrossoverSlotKind::Hp => &mut eq.hp,
            CrossoverSlotKind::Lp => &mut eq.lp,
        };

        if let Some(filter_type) = patch.filter_type {
            crossover.filter_type = filter_type;
        }
        if let Some(freq_hz) = patch.freq_hz {
            crossover.freq_hz = freq_hz;
        }
        if let Some(active) = patch.active {
            crossover.active = active;
        }
        Ok(())
    })
}

/// Partial update of one parametric EQ band (bands 1-8 of the `input_eq`/
/// `output_eq` chain) — EQ sub-tab. Only touches the fields the caller
/// passes (`Some`). Fails if `band_index` is out of range (it should always
/// exist by the time the UI can edit it, since `reconcile_eq_bands`
/// pre-populates every band for the model's `eq_bands_per_channel`).
#[tauri::command]
#[specta::specta]
pub fn projects_set_eq_band(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    direction: EqDirection,
    band_index: u32,
    patch: EqBandPatch,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, limits| {
        let eq = match direction {
            EqDirection::Input => &mut channel.input_eq,
            EqDirection::Output => &mut channel.output_eq,
        };
        let band = eq
            .bands
            .get_mut(band_index as usize)
            .ok_or_else(|| AppError::from(format!("eq band {} not found", band_index)))?;

        let patched = band.patched(&patch);
        validation::check_eq_band_patch(&format!("Band {}", band_index + 1), &patch, &patched, &limits.ranges)?;
        *band = patched;
        Ok(())
    })
}

/// Partial update of a channel's output protection (RMS + Peak limiter
/// stages) — Output tab's Limiter sub-tab.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_limiter(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    patch: LimiterPatch,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, limits| {
        let patched = channel.limiter.patched(&patch);
        validation::check_limiter_patch(&patch, &patched, limits.limiter_ceiling(&channel.limiter), &limits.ranges)?;
        channel.limiter = patched;
        Ok(())
    })
}

/// Copies one channel section (an EQ chain or a limiter stage) for pasting —
/// see `data/channel_clipboard.rs`. Read-only.
#[tauri::command]
#[specta::specta]
pub fn projects_copy_channel_section(
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    section: ClipSection,
) -> Result<ChannelClip, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    let channel = inner
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?
        .amp_assignments
        .iter()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?
        .channels
        .iter()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;
    Ok(copy_from_project(channel, section))
}

/// Pastes a `ChannelClip` into one channel section. The clip may come from a
/// project or a live amp alike.
#[tauri::command]
#[specta::specta]
pub fn projects_paste_channel_section(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    section: ClipSection,
    clip: ChannelClip,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, limits| {
        paste_into_project(channel, section, &clip, &limits.ranges, limits.rated_rms_voltage).map_err(AppError::from)
    })
}

/// Partial update of a channel's noise gate — Output tab. The threshold is
/// always persisted regardless of firmware; the frontend only shows it as
/// user-adjustable when `CvrFirmwareCapability.noise_gate_threshold` is true.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_noise_gate(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    enabled: Option<bool>,
    threshold_dbu: Option<f64>,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, limits| {
        if let Some(threshold_dbu) = threshold_dbu {
            validation::check_noise_gate_threshold(threshold_dbu, &limits.ranges)?;
        }
        if let Some(enabled) = enabled {
            channel.noise_gate_enabled = enabled;
        }
        if let Some(threshold_dbu) = threshold_dbu {
            channel.noise_gate_threshold_dbu = threshold_dbu;
        }
        Ok(())
    })
}

/// Toggles a channel's output polarity/phase invert — Output tab.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_phase_invert(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    inverted: bool,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, _| {
        channel.output_phase_inverted = inverted;
        Ok(())
    })
}

/// Sets a channel's output power/impedance mode — Output tab.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_power_mode(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    power_mode: PowerMode,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, _| {
        channel.power_mode = power_mode;
        Ok(())
    })
}

/// Renames a channel's input or output label, overriding the default
/// numbered/lettered label — Input/Output tabs. `name: None` clears back to
/// the default.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_name(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    direction: EqDirection,
    name: Option<String>,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, _| {
        match direction {
            EqDirection::Input => channel.input_name = name,
            EqDirection::Output => channel.output_name = name,
        }
        Ok(())
    })
}

/// Renames an amp's device name — the same name FC=60 writes to the amp
/// itself, editable here whether or not the amp is currently online. `name:
/// None` clears it back to unset.
#[tauri::command]
#[specta::specta]
pub fn projects_set_amp_device_name(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    name: Option<String>,
) -> Result<Project, AppError> {
    edit_assignment(&app, &state, &project_id, &assignment_id, |assignment, _| {
        assignment.device_name = name;
        Ok(())
    })
}

/// Toggles a channel's output mute — Output tab. Mirrors
/// `projects_set_channel_input_mute`.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_output_mute(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    muted: bool,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, _| {
        channel.output_muted = muted;
        Ok(())
    })
}

/// Toggles a channel's FIR bypass — Output tab. The flag is already persisted,
/// already merged in from a live amp (`amp_merge`) and already pushed back to
/// one (`PushAction::FirBypass`); this is the direct-edit leg that was missing.
/// The filter itself is `projects_set_channel_fir`.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_fir_bypass(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    bypassed: bool,
) -> Result<Project, AppError> {
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, _| {
        channel.fir_bypassed = bypassed;
        Ok(())
    })
}

/// Sets an output's FIR filter — the FIR tab's Import, and its Clear (a unit
/// impulse). Reaches the amp with the next push (`amp_push::plan_fir`).
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_fir(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    fir: ChannelFir,
) -> Result<Project, AppError> {
    if fir.coefficients.len() > FIR_MAX_TAPS {
        return Err(AppError::from(format!(
            "FIR import has {} taps, more than the device's {FIR_MAX_TAPS}-tap array",
            fir.coefficients.len()
        )));
    }
    if fir.coefficients.iter().any(|c| !c.is_finite()) {
        return Err(AppError::from("FIR coefficients must be finite numbers"));
    }
    edit_channel(&app, &state, &project_id, &assignment_id, channel_index, |channel, _| {
        channel.fir = fir;
        Ok(())
    })
}

/// Toggles mono-bridging for a channel pair — Output tab. `pair_leader_channel_index`
/// must be even and have a following odd-indexed partner in the same
/// assignment; the flag itself lives only on the leader (see
/// `AmpChannel.output_bridged`'s doc comment).
///
/// With the linked amp online and engaged the change is pushed to it and
/// stored once the amp holds it (`save_or_push`), so the two stay in step —
/// bridging from the Workspace or the Speakers tab no longer leaves a mismatch.
/// Otherwise it is a plain project edit.
#[tauri::command]
#[specta::specta]
pub async fn projects_set_output_bridge(
    app: AppHandle,
    state: State<'_, ProjectDataState>,
    live: State<'_, LiveDeviceState>,
    project_id: String,
    assignment_id: String,
    pair_leader_channel_index: u32,
    bridged: bool,
) -> Result<Project, AppError> {
    let mut assignment = candidate_of(&state, &project_id, &assignment_id)?;
    if pair_leader_channel_index % 2 != 0 {
        return Err(AppError::from(format!(
            "channel {} is not a pair leader (must be even-indexed)",
            pair_leader_channel_index
        )));
    }
    let has_partner = assignment
        .channels
        .iter()
        .any(|c| c.channel_index == pair_leader_channel_index + 1);
    if !has_partner {
        return Err(AppError::from(format!(
            "channel {} has no partner channel {} to bridge with",
            pair_leader_channel_index,
            pair_leader_channel_index + 1
        )));
    }

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == pair_leader_channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", pair_leader_channel_index)))?;

    channel.output_bridged = bridged;
    save_or_push(&app, &state, &live, project_id, assignment_id, assignment, "the bridge").await
}