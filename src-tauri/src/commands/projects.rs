use tauri::{AppHandle, Emitter, State};

use crate::data::amp_model::AmpModelCatalogEntry;
use crate::data::capability::{PowerMode, SourceKind};
use crate::data::project::{
    AmpAssignment, BackupPriorityPatch, ChannelSource, CrossoverSlotKind, CrossoverSlotPatch, EqBandPatch, EqDirection,
    LimiterPatch, Project, SourceTrimPatch,
};
use crate::data::store::{delete_project_file, save_project_file, ProjectDataState};
use crate::error::AppError;

fn find_amp_model<'a>(models: &'a [AmpModelCatalogEntry], id: &str) -> Option<&'a AmpModelCatalogEntry> {
    models.iter().find(|m| m.id == id)
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

    let project = inner
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;

    let mut assignment = AmpAssignment::new(None, device_name, channel_count, amp_model_id, firmware_version);
    assignment.reconcile_matrix_size(matrix_input_count);
    assignment.reconcile_eq_bands(eq_bands_per_channel);
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    channel.ohms = ohms;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    channel.source = ChannelSource { kind, index: index.unwrap_or(0) };
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    let trim = match kind {
        SourceKind::Analog => &mut channel.source_trims.analog,
        SourceKind::Dante => &mut channel.source_trims.dante,
        SourceKind::Backup => {
            return Err(AppError::from(
                "backup is a failover state, not an input with its own trim".to_string(),
            ))
        }
    };
    if let Some(trim_db) = patch.trim_db {
        trim.trim_db = trim_db;
    }
    if let Some(delay_ms) = patch.delay_ms {
        trim.delay_ms = delay_ms;
    }
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

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
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

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
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    channel.delay_in_ms = delay_in_ms;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    channel.input_muted = muted;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    if let Some(trim_db) = trim_db {
        channel.output_trim_db = trim_db;
    }
    if let Some(volume_db) = volume_db {
        channel.output_volume_db = volume_db;
    }
    if let Some(delay_out_ms) = delay_out_ms {
        channel.delay_out_ms = delay_out_ms;
    }
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

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
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    let eq = match direction {
        EqDirection::Input => &mut channel.input_eq,
        EqDirection::Output => &mut channel.output_eq,
    };
    let band = eq
        .bands
        .get_mut(band_index as usize)
        .ok_or_else(|| AppError::from(format!("eq band {} not found", band_index)))?;

    if let Some(filter_type) = patch.filter_type {
        band.filter_type = filter_type;
    }
    if let Some(freq_hz) = patch.freq_hz {
        band.freq_hz = freq_hz;
    }
    if let Some(gain_db) = patch.gain_db {
        band.gain_db = gain_db;
    }
    if let Some(q) = patch.q {
        band.q = q;
    }
    if let Some(active) = patch.active {
        band.active = active;
    }
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    if let Some(enabled) = patch.rms_enabled {
        channel.limiter.rms.enabled = enabled;
    }
    if let Some(threshold_vrms) = patch.rms_threshold_vrms {
        channel.limiter.rms.threshold_vrms = threshold_vrms;
    }
    if let Some(attack_ms) = patch.rms_attack_ms {
        channel.limiter.rms.attack_ms = attack_ms;
    }
    if let Some(release_multiplier) = patch.rms_release_multiplier {
        channel.limiter.rms.release_multiplier = release_multiplier;
    }
    if let Some(enabled) = patch.peak_enabled {
        channel.limiter.peak.enabled = enabled;
    }
    if let Some(threshold_vp) = patch.peak_threshold_vp {
        channel.limiter.peak.threshold_vp = threshold_vp;
    }
    if let Some(hold_ms) = patch.peak_hold_ms {
        channel.limiter.peak.hold_ms = hold_ms;
    }
    if let Some(release_ms) = patch.peak_release_ms {
        channel.limiter.peak.release_ms = release_ms;
    }
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    if let Some(enabled) = enabled {
        channel.noise_gate_enabled = enabled;
    }
    if let Some(threshold_dbu) = threshold_dbu {
        channel.noise_gate_threshold_dbu = threshold_dbu;
    }
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    channel.output_phase_inverted = inverted;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    channel.power_mode = power_mode;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    match direction {
        EqDirection::Input => channel.input_name = name,
        EqDirection::Output => channel.output_name = name,
    }
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    assignment.device_name = name;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    channel.output_muted = muted;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}

/// Toggles a channel's FIR bypass — Output tab. The flag is already persisted,
/// already merged in from a live amp (`amp_merge`) and already pushed back to
/// one (`PushAction::FirBypass`); this is the direct-edit leg that was missing.
/// Only the bypass flag lives here — the coefficients themselves are read from
/// the device with FC=43 and never enter the project file.
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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

    let channel = assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {} not found", channel_index)))?;

    channel.fir_bypassed = bypassed;
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}

/// Toggles mono-bridging for a channel pair — Output tab. `pair_leader_channel_index`
/// must be even and have a following odd-indexed partner in the same
/// assignment; the flag itself lives only on the leader (see
/// `AmpChannel.output_bridged`'s doc comment).
#[tauri::command]
#[specta::specta]
pub fn projects_set_output_bridge(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    pair_leader_channel_index: u32,
    bridged: bool,
) -> Result<Project, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
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
    project.touch();

    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}