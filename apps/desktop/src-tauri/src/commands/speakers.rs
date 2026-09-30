//! The speaker library (`speakers.json`) and project outputs' references into
//! it. The logic lives in `ampcore_core::data::speaker`; these are the thin
//! Tauri wrappers.
//!
//! Setting a reference never touches an output's values. The frontend applies
//! those through its `ConfigureActions`, like any other edit, so a linked amp
//! in a live session is written to directly instead of the project going
//! stale behind it.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, State};

use ampcore_core::data::project::{AmpAssignment, Project};
use ampcore_core::data::speaker::{
    speaker_states, ChannelSpeakerState, SpeakerDetails, SpeakerLibraryEntry, SpeakerProcessing,
};
use ampcore_core::error::AppError;
use ampcore_core::live::cvr::speaker_data::parse_sl;

use crate::data::store::{save_project_file, save_speakers, ProjectDataInner, ProjectDataState};

fn saved_library(app: &AppHandle, inner: &ProjectDataInner) -> Result<(), AppError> {
    save_speakers(&inner.data_dir, &inner.speakers).map_err(AppError::from)?;
    app.emit("speakers:updated", &inner.speakers).ok();
    Ok(())
}

/// `edit_assignment` (see `projects.rs`) with the library in reach, for the
/// commands that touch both. The library is saved first only when `edit`
/// reports it changed it.
fn edit_with_library(
    app: &AppHandle,
    state: &State<ProjectDataState>,
    project_id: &str,
    assignment_id: &str,
    edit: impl FnOnce(&mut Vec<SpeakerLibraryEntry>, &mut AmpAssignment) -> Result<bool, AppError>,
) -> Result<Project, AppError> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let inner = &mut *guard;
    let project = inner
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {project_id} not found")))?;
    let assignment = project
        .amp_assignments
        .iter_mut()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {assignment_id} not found")))?;
    let library_changed = edit(&mut inner.speakers, assignment)?;
    project.touch();
    let project = project.clone();

    if library_changed {
        saved_library(app, inner)?;
    }
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}

fn find_entry<'a>(library: &'a mut [SpeakerLibraryEntry], id: &str) -> Result<&'a mut SpeakerLibraryEntry, AppError> {
    library.iter_mut().find(|e| e.id == id).ok_or_else(|| AppError::from("That speaker is no longer in the library"))
}

fn channel_mut(
    assignment: &mut AmpAssignment,
    channel_index: u32,
) -> Result<&mut ampcore_core::data::project::AmpChannel, AppError> {
    assignment
        .channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
        .ok_or_else(|| AppError::from(format!("channel {channel_index} not found")))
}

#[tauri::command]
#[specta::specta]
pub fn speakers_list(state: State<ProjectDataState>) -> Result<Vec<SpeakerLibraryEntry>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.speakers.clone())
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SlUpload {
    pub file_name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SlImportResult {
    pub file_name: String,
    /// Why the file can't be imported; `None` when it can (or was).
    pub error: Option<String>,
    /// The entry the file makes. Not in the library unless `commit` was set.
    pub entry: Option<SpeakerLibraryEntry>,
    /// Brand, family and model already exist in the library — imported anyway.
    pub duplicate: bool,
}

/// Parses vendor `.sl` files. With `commit`, every file that parses is added
/// to the library; without, nothing is saved (the import preview).
#[tauri::command]
#[specta::specta]
pub fn speakers_import_sl(
    app: AppHandle,
    state: State<ProjectDataState>,
    files: Vec<SlUpload>,
    commit: bool,
) -> Result<Vec<SlImportResult>, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let key = |e: &SpeakerLibraryEntry| (e.brand.to_lowercase(), e.family.to_lowercase(), e.model.to_lowercase());
    let results: Vec<SlImportResult> = files
        .into_iter()
        .map(|file| match parse_sl(&file.bytes).and_then(|sl| SpeakerLibraryEntry::from_sl(&sl)) {
            Ok(entry) => SlImportResult {
                duplicate: inner.speakers.iter().any(|e| key(e) == key(&entry)),
                file_name: file.file_name,
                error: None,
                entry: Some(entry),
            },
            Err(error) => SlImportResult { file_name: file.file_name, error: Some(error), entry: None, duplicate: false },
        })
        .collect();

    if commit {
        inner.speakers.extend(results.iter().filter_map(|r| r.entry.clone()));
        saved_library(&app, &inner)?;
    }
    Ok(results)
}

#[tauri::command]
#[specta::specta]
pub fn speakers_update_details(
    app: AppHandle,
    state: State<ProjectDataState>,
    id: String,
    details: SpeakerDetails,
) -> Result<SpeakerLibraryEntry, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let entry = find_entry(&mut inner.speakers, &id)?;
    entry.set_details(details)?;
    let entry = entry.clone();
    saved_library(&app, &inner)?;
    Ok(entry)
}

/// Outputs set up from the entry keep their values and read as detached.
#[tauri::command]
#[specta::specta]
pub fn speakers_delete(app: AppHandle, state: State<ProjectDataState>, id: String) -> Result<(), AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    inner.speakers.retain(|e| e.id != id);
    saved_library(&app, &inner)
}

/// Creates a library entry from consecutive outputs — one way per output, in
/// order — and sets those outputs up from it.
#[tauri::command]
#[specta::specta]
pub fn speakers_save_from_outputs(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_indices: Vec<u32>,
    details: SpeakerDetails,
) -> Result<Project, AppError> {
    edit_with_library(&app, &state, &project_id, &assignment_id, |library, assignment| {
        let processing = channel_indices
            .iter()
            .map(|&i| channel_mut(assignment, i).map(|c| SpeakerProcessing::from_channel(c)))
            .collect::<Result<Vec<_>, _>>()?;
        let entry = SpeakerLibraryEntry::new(details, processing)?;
        for (way, &i) in channel_indices.iter().enumerate() {
            channel_mut(assignment, i)?.speaker = Some(entry.reference(way as u32)?);
        }
        library.push(entry);
        Ok(true)
    })
}

/// Replaces one way of an entry with an output's current values. Only that
/// output is marked current; every other output set up from the entry then
/// reads "library updated".
#[tauri::command]
#[specta::specta]
pub fn speakers_update_from_output(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
) -> Result<Project, AppError> {
    edit_with_library(&app, &state, &project_id, &assignment_id, |library, assignment| {
        let channel = channel_mut(assignment, channel_index)?;
        let speaker = channel.speaker.clone().ok_or("This output has no speaker")?;
        let entry = find_entry(library, &speaker.library_id)?;
        entry.set_way_processing(speaker.way_index, SpeakerProcessing::from_channel(channel))?;
        channel.speaker = Some(entry.reference(speaker.way_index)?);
        Ok(true)
    })
}

/// Sets (`library_id` given) or removes an output's speaker reference. Its
/// values are left alone — see the module doc.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_speaker(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
    library_id: Option<String>,
    way_index: u32,
) -> Result<Project, AppError> {
    edit_with_library(&app, &state, &project_id, &assignment_id, |library, assignment| {
        let speaker = match library_id {
            Some(id) => Some(find_entry(library, &id)?.reference(way_index)?),
            None => None,
        };
        channel_mut(assignment, channel_index)?.speaker = speaker;
        Ok(false)
    })
}

#[tauri::command]
#[specta::specta]
pub fn speakers_channel_states(
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
) -> Result<Vec<ChannelSpeakerState>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    let assignment = inner
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .and_then(|p| p.amp_assignments.iter().find(|a| a.id == assignment_id))
        .ok_or_else(|| AppError::from("amp not found"))?;
    Ok(speaker_states(assignment, &inner.speakers))
}
