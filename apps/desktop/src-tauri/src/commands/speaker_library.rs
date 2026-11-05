//! The speaker library (`speakers.json`): create, edit, import/export, and
//! saving outputs back into it. Nothing here writes to an amp.

use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, State};


use ampcore_core::data::project::{AmpAssignment, Project};
use ampcore_core::data::speaker::{
    check_way_count, remap_way_refs, OldProfile, SpeakerDetails, SpeakerLibraryEntry, SpeakerProcessing,
};
use ampcore_core::error::AppError;

use crate::data::exchange::{add_missing, export_library, import_library};
use crate::data::store;
use crate::data::store::{save_speakers, ProjectDataState};

pub(super) fn saved_library(app: &AppHandle, data_dir: &Path, speakers: &[SpeakerLibraryEntry]) -> Result<(), AppError> {
    save_speakers(data_dir, speakers).map_err(AppError::from)?;
    app.emit("speakers:updated", speakers).ok();
    Ok(())
}

/// `amp_write.rs::edit_plan` with the library in reach, for the commands that
/// touch both. The library is saved first only when `edit`
/// reports it changed it.
pub(super) fn edit_with_library(
    app: &AppHandle,
    state: &State<ProjectDataState>,
    project_id: &str,
    assignment_id: &str,
    edit: impl FnOnce(&mut Vec<SpeakerLibraryEntry>, &mut AmpAssignment) -> Result<bool, AppError>,
) -> Result<Project, AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let project = store::project_mut(&mut inner.projects, &project_id)?;
    let assignment = store::assignment_mut(project, &assignment_id)?;
    if edit(&mut inner.speakers, assignment)? {
        saved_library(app, &inner.data_dir, &inner.speakers)?;
    }
    store::commit(app, &inner.data_dir, project)
}

pub(super) fn find_entry<'a>(library: &'a mut [SpeakerLibraryEntry], id: &str) -> Result<&'a mut SpeakerLibraryEntry, AppError> {
    library.iter_mut().find(|e| e.id == id).ok_or_else(|| AppError::from("That speaker is no longer in the library"))
}


#[tauri::command]
#[specta::specta]
pub fn speakers_list(state: State<ProjectDataState>) -> Result<Vec<SpeakerLibraryEntry>, AppError> {
    let inner = state.lock()?;
    Ok(inner.speakers.clone())
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUpload {
    pub file_name: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileImportResult {
    pub file_name: String,
    /// Why the file can't be imported; `None` when it can (or was).
    pub error: Option<String>,
    /// The entry the file makes. Not in the library unless `commit` was set.
    pub entry: Option<SpeakerLibraryEntry>,
    /// Brand, family and model already exist in the library — imported anyway.
    pub duplicate: bool,
}

/// The whole library as an export file's text (`data/exchange.rs`), for the
/// caller to save where the user picks.
#[tauri::command]
#[specta::specta]
pub fn speakers_export(state: State<ProjectDataState>) -> Result<String, AppError> {
    let inner = state.lock()?;
    export_library(&inner.speakers).map_err(AppError::from)
}

/// Opens the folder holding `speakers.json` in the system file manager.
#[tauri::command]
#[specta::specta]
pub fn speakers_open_folder(state: State<ProjectDataState>) -> Result<(), AppError> {
    let dir = state.lock()?.data_dir.clone();
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map_err(|e| AppError::from(format!("Could not open {}: {e}", dir.display())))?;
    Ok(())
}

/// Parses the old app's speaker preset files (JSON) and this app's exported
/// libraries — one result per speaker, so a library file gives several. A
/// library speaker keeps its id, so projects that reference it find it; one
/// this library already has (same id) is reported and left out. With
/// `commit`, every importable speaker is added to the library; without,
/// nothing is saved (the import preview).
#[tauri::command]
#[specta::specta]
pub fn speakers_import_profiles(
    app: AppHandle,
    state: State<ProjectDataState>,
    files: Vec<ProfileUpload>,
    commit: bool,
) -> Result<Vec<ProfileImportResult>, AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let key = |e: &SpeakerLibraryEntry| (e.brand.to_lowercase(), e.family.to_lowercase(), e.model.to_lowercase());
    let results: Vec<ProfileImportResult> = files
        .into_iter()
        .flat_map(|file| match import_library(&file.text) {
            Some(Ok(entries)) => entries
                .into_iter()
                .map(|entry| {
                    if inner.speakers.iter().any(|e| e.id == entry.id) {
                        ProfileImportResult {
                            file_name: file.file_name.clone(),
                            error: Some(format!("{} {} is already in this library", entry.brand, entry.model)),
                            entry: None,
                            duplicate: false,
                        }
                    } else {
                        ProfileImportResult {
                            duplicate: inner.speakers.iter().any(|e| key(e) == key(&entry)),
                            file_name: file.file_name.clone(),
                            error: None,
                            entry: Some(entry),
                        }
                    }
                })
                .collect::<Vec<_>>(),
            Some(Err(error)) => vec![ProfileImportResult { file_name: file.file_name, error: Some(error), entry: None, duplicate: false }],
            None => vec![import_profile(&inner.speakers, file, key)],
        })
        .collect();

    if commit {
        add_missing(&mut inner.speakers, results.iter().filter_map(|r| r.entry.clone()).collect(), |e| &e.id);
        saved_library(&app, &inner.data_dir, &inner.speakers)?;
    }
    Ok(results)
}

/// One old-app speaker preset file as an import result.
fn import_profile(
    library: &[SpeakerLibraryEntry],
    file: ProfileUpload,
    key: impl Fn(&SpeakerLibraryEntry) -> (String, String, String),
) -> ProfileImportResult {
    let parsed = serde_json::from_str::<OldProfile>(&file.text)
        .map_err(|e| format!("not a speaker preset file: {e}"))
        .and_then(|profile| SpeakerLibraryEntry::from_profile(&profile));
    match parsed {
        Ok(entry) => ProfileImportResult {
            duplicate: library.iter().any(|e| key(e) == key(&entry)),
            file_name: file.file_name,
            error: None,
            entry: Some(entry),
        },
        Err(error) => ProfileImportResult { file_name: file.file_name, error: Some(error), entry: None, duplicate: false },
    }
}

#[tauri::command]
#[specta::specta]
pub fn speakers_update_details(
    app: AppHandle,
    state: State<ProjectDataState>,
    id: String,
    details: SpeakerDetails,
) -> Result<SpeakerLibraryEntry, AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let entry = find_entry(&mut inner.speakers, &id)?;
    entry.set_details(details)?;
    let entry = entry.clone();
    saved_library(&app, &inner.data_dir, &inner.speakers)?;
    Ok(entry)
}

/// A new entry from scratch: one way per label, each with neutral values
/// (`SpeakerProcessing::neutral`), edited afterwards in the Presets tab.
#[tauri::command]
#[specta::specta]
pub fn speakers_create(app: AppHandle, state: State<ProjectDataState>, details: SpeakerDetails) -> Result<SpeakerLibraryEntry, AppError> {
    check_way_count(details.way_labels.len())?;
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let processing = details.way_labels.iter().map(|_| SpeakerProcessing::neutral()).collect();
    let entry = SpeakerLibraryEntry::new(details, processing)?;
    inner.speakers.push(entry.clone());
    saved_library(&app, &inner.data_dir, &inner.speakers)?;
    Ok(entry)
}

#[tauri::command]
#[specta::specta]
pub fn speakers_duplicate(app: AppHandle, state: State<ProjectDataState>, id: String) -> Result<SpeakerLibraryEntry, AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let copy = find_entry(&mut inner.speakers, &id)?.duplicate();
    inner.speakers.push(copy.clone());
    saved_library(&app, &inner.data_dir, &inner.speakers)?;
    Ok(copy)
}

/// Stores the library editor's edit of an entry in one go; see
/// `SpeakerLibraryEntry::save_edit` for `origins` and when the revision
/// moves. Outputs in every project set up from the entry follow their way
/// (`remap_way_refs`); those on a removed way lose the speaker.
#[tauri::command]
#[specta::specta]
pub fn speakers_save(
    app: AppHandle,
    state: State<ProjectDataState>,
    id: String,
    entry: SpeakerLibraryEntry,
    origins: Vec<Option<u32>>,
) -> Result<SpeakerLibraryEntry, AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let stored = find_entry(&mut inner.speakers, &id)?;
    stored.save_edit(entry, &origins)?;
    let stored = stored.clone();
    saved_library(&app, &inner.data_dir, &inner.speakers)?;
    for project in inner.projects.iter_mut().filter_map(|p| remap_way_refs(p, &id, &origins).then_some(p)) {
        store::commit(&app, &inner.data_dir, project)?;
    }
    Ok(stored)
}

/// A fresh output's values, for a way the editor adds from scratch.
#[tauri::command]
#[specta::specta]
pub fn speakers_neutral_processing() -> SpeakerProcessing {
    SpeakerProcessing::neutral()
}

/// Outputs set up from the entry keep their values and read as detached.
#[tauri::command]
#[specta::specta]
pub fn speakers_delete(app: AppHandle, state: State<ProjectDataState>, id: String) -> Result<(), AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    inner.speakers.retain(|e| e.id != id);
    saved_library(&app, &inner.data_dir, &inner.speakers)
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
            .map(|&i| store::channel_mut(assignment, i).map(|c| SpeakerProcessing::from_channel(c)))
            .collect::<Result<Vec<_>, _>>()?;
        let mut entry = SpeakerLibraryEntry::new(details, processing)?;
        for (way, &i) in channel_indices.iter().enumerate() {
            let channel = store::channel_mut(assignment, i)?;
            // The output's load is the best guess at the speaker's impedance.
            entry.ways[way].nominal_ohms = Some(channel.ohms).filter(|o| *o > 0.0);
            channel.speaker = Some(entry.reference(way as u32)?);
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
        let channel = store::channel_mut(assignment, channel_index)?;
        let speaker = channel.speaker.clone().ok_or("This output has no speaker")?;
        let entry = find_entry(library, &speaker.library_id)?;
        entry.set_way_processing(speaker.way_index, SpeakerProcessing::from_channel(channel))?;
        channel.speaker = Some(entry.reference(speaker.way_index)?);
        Ok(true)
    })
}

