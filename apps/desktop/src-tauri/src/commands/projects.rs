use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, State};

use ampcore_core::data::amp_model::AmpModelCatalogEntry;
use ampcore_core::data::project::{
    AmpAssignment, Project,
};
use ampcore_core::data::common::{new_id, now_millis};
use crate::data::exchange::{add_missing, export_project, import_project};
use crate::data::store;
use crate::data::store::{
    delete_project_file, reconcile_project_eq_band_sizes, reconcile_project_matrix_sizes, save_amp_models,
    save_project_file, save_speakers, ProjectDataInner, ProjectDataState,
};
use ampcore_core::error::AppError;
use super::amp_write::assignment_limits;

/// Saves a new project, adds it to the store and emits `project:updated`.
fn add_project(app: &AppHandle, inner: &mut ProjectDataInner, project: Project) -> Result<Project, AppError> {
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    inner.projects.push(project.clone());
    app.emit("project:updated", &project).ok();
    Ok(project)
}

fn find_amp_model<'a>(models: &'a [AmpModelCatalogEntry], id: &str) -> Option<&'a AmpModelCatalogEntry> {
    models.iter().find(|m| m.id == id)
}

#[tauri::command]
#[specta::specta]
pub fn projects_list(state: State<ProjectDataState>) -> Result<Vec<Project>, AppError> {
    let inner = state.lock()?;
    Ok(inner.projects.clone())
}

#[tauri::command]
#[specta::specta]
pub fn projects_get(state: State<ProjectDataState>, id: String) -> Result<Option<Project>, AppError> {
    let inner = state.lock()?;
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
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    add_project(&app, inner, Project::new(name, description))
}

/// Full-document replace, matching the old app's PUT-whole-project pattern.
/// Bumps `updated_at` regardless of what the caller passed.
#[tauri::command]
#[specta::specta]
pub fn projects_update(
    app: AppHandle,
    state: State<ProjectDataState>,
    project: Project,
) -> Result<Project, AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let slot = store::project_mut(&mut inner.projects, &project.id)?;
    *slot = project;
    store::commit(&app, &inner.data_dir, slot)
}

/// What startup couldn't open — files set aside as unreadable, or saved by a
/// newer AmpCore — for the project list to show.
#[tauri::command]
#[specta::specta]
pub fn projects_load_problems(state: State<ProjectDataState>) -> Result<Vec<String>, AppError> {
    let inner = state.lock()?;
    Ok(inner.load_problems.clone())
}

/// A copy of a project under a new id and "<name> (copy)". Amps stay linked to
/// the same network amps, so a copy can be a variant of one rig.
#[tauri::command]
#[specta::specta]
pub fn projects_duplicate(app: AppHandle, state: State<ProjectDataState>, project_id: String) -> Result<Project, AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let mut copy = store::project(&inner.projects, &project_id)?.clone();
    let now = now_millis();
    copy.id = new_id();
    copy.name = format!("{} (copy)", copy.name);
    copy.created_at = now;
    copy.updated_at = now;
    add_project(&app, inner, copy)
}

/// The project as an export file's text (`data/exchange.rs`), for the caller
/// to save where the user picks.
#[tauri::command]
#[specta::specta]
pub fn projects_export(state: State<ProjectDataState>, project_id: String) -> Result<String, AppError> {
    let inner = state.lock()?;
    let project = store::project(&inner.projects, &project_id)?;
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
    let mut guard = state.lock()?;
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
    let project = add_project(&app, inner, project)?;
    Ok(ProjectImport { project, speakers_added: speakers_added as u32, amp_models_added: amp_models_added as u32 })
}

#[tauri::command]
#[specta::specta]
pub fn projects_delete(app: AppHandle, state: State<ProjectDataState>, id: String) -> Result<(), AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
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
    let mut guard = state.lock()?;
    let inner = &mut *guard;

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
    let project = store::project_mut(&mut inner.projects, &project_id)?;
    project.amp_assignments.push(assignment);
    store::commit(&app, &inner.data_dir, project)
}

#[tauri::command]
#[specta::specta]
pub fn projects_remove_amp_assignment(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
) -> Result<Project, AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let project = store::project_mut(&mut inner.projects, &project_id)?;

    project.amp_assignments.retain(|a| a.id != assignment_id);
    store::commit(&app, &inner.data_dir, project)
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
    let mut guard = state.lock()?;
    let inner = &mut *guard;

    let (channel_count, matrix_input_count, eq_bands_per_channel) = match &amp_model_id {
        Some(id) => {
            let model = find_amp_model(&inner.amp_models, id)
                .ok_or_else(|| AppError::from(format!("amp model {} not found", id)))?;
            (model.channel_count, model.topology.matrix_input_count, model.topology.eq_bands_per_channel)
        }
        None => (0, 0, 0),
    };

    let project = store::project_mut(&mut inner.projects, &project_id)?;
    let assignment = store::assignment_mut(project, &assignment_id)?;

    assignment.amp_model_id = amp_model_id;
    if channel_count > 0 {
        assignment.reconcile_channel_count(channel_count);
    }
    assignment.reconcile_matrix_size(matrix_input_count);
    assignment.reconcile_eq_bands(eq_bands_per_channel);
    // A smaller model's output caps the planned limiter thresholds.
    let limits = assignment_limits(&inner.amp_models, assignment);
    assignment.fit_limiters(limits.rated_rms_voltage, &limits.ranges);
    store::commit(&app, &inner.data_dir, project)
}
