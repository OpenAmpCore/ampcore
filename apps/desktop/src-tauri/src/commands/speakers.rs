//! The speaker library (`speakers.json`) and project outputs' references into
//! it. The logic lives in `ampcore_core::data::speaker`; these are the thin
//! Tauri wrappers.
//!
//! `speakers_apply` is the one way values get in, and it has no write path of
//! its own: it changes a copy of the project amp and hands that to the push
//! (`amp_push::push_assignment`), the same endpoint the online/offline sync
//! uses. Offline, the copy is simply saved.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, State};

use ampcore_core::live::state::LiveDeviceState;

use ampcore_core::data::project::{AmpAssignment, CanvasPosition, Project, ProjectSpeaker, SpeakerRef};
use ampcore_core::data::capability;
use ampcore_core::data::speaker::{
    speaker_states, ChannelSpeakerState, OldProfile, SpeakerDetails, SpeakerLibraryEntry, SpeakerProcessing, SpeakerWay,
};
use ampcore_core::live::cvr::write_v118::CHANNEL_NAME_FIELD_LEN;
use ampcore_core::error::AppError;

use super::amp_links::read_linked_amp;
use super::amp_push::push_assignment;
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

/// Parses the old app's speaker preset files (JSON). With `commit`, every file
/// that parses is added to the library; without, nothing is saved (the import
/// preview).
#[tauri::command]
#[specta::specta]
pub fn speakers_import_profiles(
    app: AppHandle,
    state: State<ProjectDataState>,
    files: Vec<ProfileUpload>,
    commit: bool,
) -> Result<Vec<ProfileImportResult>, AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    let key = |e: &SpeakerLibraryEntry| (e.brand.to_lowercase(), e.family.to_lowercase(), e.model.to_lowercase());
    let results: Vec<ProfileImportResult> = files
        .into_iter()
        .map(|file| {
            let parsed = serde_json::from_str::<OldProfile>(&file.text)
                .map_err(|e| format!("not a speaker preset file: {e}"))
                .and_then(|profile| SpeakerLibraryEntry::from_profile(&profile));
            match parsed {
                Ok(entry) => ProfileImportResult {
                    duplicate: inner.speakers.iter().any(|e| key(e) == key(&entry)),
                    file_name: file.file_name,
                    error: None,
                    entry: Some(entry),
                },
                Err(error) => ProfileImportResult { file_name: file.file_name, error: Some(error), entry: None, duplicate: false },
            }
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

/// One output's way, fitted to the amp it is going onto.
struct FittedWay {
    channel_index: u32,
    processing: SpeakerProcessing,
    reference: SpeakerRef,
    /// The way's label as the output's name, cut to the amp's 16-byte field.
    /// `None` when it isn't ASCII — the amp can't store that, and a name is
    /// no reason to refuse the speaker — so the output keeps its own.
    output_name: Option<String>,
    issues: Vec<String>,
    rows: Vec<FitRow>,
}

/// One compared value, three ways: the debug comparator's diff row.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FitRow {
    pub label: String,
    /// What the output holds now.
    pub current: String,
    /// What the library way stores.
    pub preset: String,
    /// What applying writes, after `fit`.
    pub written: String,
}

/// `entries()` of the three, joined by label. A label one side lacks (a band
/// count that differs) reads "—" there.
fn fit_rows(current: &SpeakerProcessing, preset: &SpeakerProcessing, written: &SpeakerProcessing) -> Vec<FitRow> {
    let sides = [current.entries(), preset.entries(), written.entries()];
    let longest = sides.iter().max_by_key(|s| s.len()).unwrap();
    let value = |side: &[(String, String)], label: &str| {
        side.iter().find(|(l, _)| l == label).map_or("—".to_string(), |(_, v)| v.clone())
    };
    longest
        .iter()
        .map(|(label, _)| FitRow {
            label: label.clone(),
            current: value(&sides[0], label),
            preset: value(&sides[1], label),
            written: value(&sides[2], label),
        })
        .collect()
}

/// One output to set up: which way of which library entry goes onto it.
/// Entries may differ between items, so any number of speakers is one apply
/// — and one push.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerItem {
    pub channel_index: u32,
    pub library_id: String,
    pub way_index: u32,
    /// Links the output to this project speaker. Without one, an output that
    /// is re-applied from the way it already holds keeps its link; any other
    /// becomes a speaker set up on the amp.
    #[serde(default)]
    pub project_speaker_id: Option<String>,
}

/// Each item's way fitted to the project amp's capability
/// (`SpeakerProcessing::fit`). `Err` when the amp can't take a speaker at all.
fn fit_ways(
    state: &State<'_, ProjectDataState>,
    project_id: &str,
    assignment_id: &str,
    items: &[SpeakerItem],
) -> Result<Vec<FittedWay>, AppError> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let inner = &mut *guard;
    let assignment = inner
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .and_then(|p| p.amp_assignments.iter().find(|a| a.id == assignment_id))
        .ok_or_else(|| AppError::from("amp not found"))?;
    let model = assignment
        .amp_model_id
        .as_deref()
        .and_then(|id| inner.amp_models.iter().find(|m| m.id == id))
        .ok_or_else(|| AppError::from("Assign an amp model first"))?;
    let cap = capability::resolve(model, assignment.firmware_version.as_deref());
    items
        .iter()
        .map(|item| {
            let (channel_index, way) = (item.channel_index, item.way_index);
            let entry = find_entry(&mut inner.speakers, &item.library_id)?;
            let SpeakerWay { label, processing, .. } = entry.ways.get(way as usize).ok_or("No such way")?;
            let output_name =
                Some(label.trim()).filter(|l| !l.is_empty() && l.is_ascii()).map(|l| l[..l.len().min(CHANNEL_NAME_FIELD_LEN)].to_string());
            let channel = assignment
                .channels
                .iter()
                .find(|c| c.channel_index == channel_index)
                .ok_or_else(|| AppError::from(format!("channel {channel_index} not found")))?;
            let (fitted, issues) = processing.fit(channel, &cap)?;
            let rows = fit_rows(&SpeakerProcessing::from_channel(channel), processing, &fitted);
            let mut reference = entry.reference(way)?;
            reference.project_speaker_id = item.project_speaker_id.clone().or_else(|| {
                let held = channel.speaker.as_ref().filter(|s| s.library_id == item.library_id && s.way_index == way)?;
                held.project_speaker_id.clone()
            });
            Ok(FittedWay { channel_index, processing: fitted, reference, output_name, issues, rows })
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OutputFit {
    pub channel_index: u32,
    /// What applying changes from the way as stored; empty when it fits as is.
    pub issues: Vec<String>,
    /// Every compared value: now, stored, written (the debug comparator).
    pub rows: Vec<FitRow>,
}

/// What `speakers_apply` would have to adjust, so the user can decide first.
#[tauri::command]
#[specta::specta]
pub fn speakers_fit(
    state: State<'_, ProjectDataState>,
    project_id: String,
    assignment_id: String,
    items: Vec<SpeakerItem>,
) -> Result<Vec<OutputFit>, AppError> {
    Ok(fit_ways(&state, &project_id, &assignment_id, &items)?
        .into_iter()
        .map(|f| OutputFit { channel_index: f.channel_index, issues: f.issues, rows: f.rows })
        .collect())
}

/// Sets outputs up from the library: each item's output gets its way's values
/// (fitted to the amp), reference and label as its name. A way that doesn't
/// fit as is is refused unless `accept_lossy`.
///
/// The change is made on a copy of the project amp. With the linked amp
/// online (and not disengaged) that copy is pushed, and only becomes the
/// project's once the amp holds it; otherwise it is saved as the plan.
#[tauri::command]
#[specta::specta]
pub async fn speakers_apply(
    app: AppHandle,
    state: State<'_, ProjectDataState>,
    live: State<'_, LiveDeviceState>,
    project_id: String,
    assignment_id: String,
    items: Vec<SpeakerItem>,
    accept_lossy: bool,
) -> Result<Project, AppError> {
    let fitted = fit_ways(&state, &project_id, &assignment_id, &items)?;
    if !accept_lossy && fitted.iter().any(|f| !f.issues.is_empty()) {
        return Err(AppError::from("The speaker doesn't fit this amp as is"));
    }

    let candidate = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        let mut candidate = inner
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .and_then(|p| p.amp_assignments.iter().find(|a| a.id == assignment_id))
            .ok_or_else(|| AppError::from("amp not found"))?
            .clone();
        for f in fitted {
            let channel = channel_mut(&mut candidate, f.channel_index)?;
            f.processing.apply_to(channel);
            channel.speaker = Some(f.reference);
            if f.output_name.is_some() {
                channel.output_name = f.output_name;
            }
        }
        candidate
    };

    let online = match candidate.mac.as_deref().filter(|_| !candidate.live_disengaged) {
        Some(mac) => read_linked_amp(&live, mac)?.is_some_and(|r| r.device.online),
        None => false,
    };
    if !online {
        return edit_with_library(&app, &state, &project_id, &assignment_id, |_, assignment| {
            *assignment = candidate;
            Ok(false)
        });
    }

    let result = push_assignment(&app, &state, &live, project_id, assignment_id, Some(candidate)).await?;
    if result.pushed {
        return result.project.ok_or_else(|| AppError::from("the push returned no project"));
    }
    let differing: Vec<String> =
        result.remaining.iter().filter(|r| r.differs).map(|r| format!("{} · {}", r.group, r.label)).collect();
    Err(AppError::from(match (result.failed_stage_label, result.error) {
        (Some(stage), Some(error)) => {
            format!("The amp stopped answering while {stage} was written. Check its connection and apply again. ({error})")
        }
        _ => format!("The amp doesn't hold the speaker after writing it. Still differing: {}", differing.join(", ")),
    }))
}

/// Removes an output's speaker reference. Its values are left alone —
/// `speakers_apply` is what sets a speaker up.
#[tauri::command]
#[specta::specta]
pub fn projects_set_channel_speaker(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
) -> Result<Project, AppError> {
    edit_with_library(&app, &state, &project_id, &assignment_id, |_, assignment| {
        channel_mut(assignment, channel_index)?.speaker = None;
        Ok(false)
    })
}

/// Unlinks an output from its project speaker. Its values and library
/// reference stay, as a speaker set up on the amp — as `Project::remove_speaker`
/// leaves them.
#[tauri::command]
#[specta::specta]
pub fn projects_unlink_output(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
) -> Result<Project, AppError> {
    edit_with_library(&app, &state, &project_id, &assignment_id, |_, assignment| {
        if let Some(speaker) = &mut channel_mut(assignment, channel_index)?.speaker {
            speaker.project_speaker_id = None;
        }
        Ok(false)
    })
}

/// The project-level counterpart of `edit_with_library`, for project speakers.
fn edit_project(
    app: &AppHandle,
    state: &State<ProjectDataState>,
    project_id: &str,
    edit: impl FnOnce(&[SpeakerLibraryEntry], &mut Project) -> Result<(), AppError>,
) -> Result<Project, AppError> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let inner = &mut *guard;
    let project = inner
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {project_id} not found")))?;
    edit(&inner.speakers, project)?;
    project.touch();
    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    app.emit("project:updated", &project).ok();
    Ok(project)
}

/// Places a library speaker in the project, linked to nothing yet. Its ways
/// are linked by `speakers_apply` (`SpeakerItem.project_speaker_id`).
#[tauri::command]
#[specta::specta]
pub fn projects_add_speaker(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    library_id: String,
    name: String,
) -> Result<Project, AppError> {
    edit_project(&app, &state, &project_id, |library, project| {
        let entry = library
            .iter()
            .find(|e| e.id == library_id)
            .ok_or_else(|| AppError::from("That speaker is no longer in the library"))?;
        let label = format!("{} {}", entry.brand, entry.model);
        let name = Some(name.trim()).filter(|n| !n.is_empty()).unwrap_or(&label).to_string();
        project.speakers.push(ProjectSpeaker::new(name, library_id, label));
        Ok(())
    })
}

#[tauri::command]
#[specta::specta]
pub fn projects_rename_speaker(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    speaker_id: String,
    name: String,
) -> Result<Project, AppError> {
    edit_project(&app, &state, &project_id, |_, project| {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::from("A speaker needs a name"));
        }
        let speaker =
            project.speakers.iter_mut().find(|s| s.id == speaker_id).ok_or_else(|| AppError::from("speaker not found"))?;
        speaker.name = name.to_string();
        Ok(())
    })
}

/// Where the speaker sits on the Workspace canvas.
#[tauri::command]
#[specta::specta]
pub fn projects_set_speaker_position(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    speaker_id: String,
    x: f64,
    y: f64,
) -> Result<Project, AppError> {
    edit_project(&app, &state, &project_id, |_, project| {
        let speaker =
            project.speakers.iter_mut().find(|s| s.id == speaker_id).ok_or_else(|| AppError::from("speaker not found"))?;
        speaker.position = Some(CanvasPosition { x, y });
        Ok(())
    })
}

/// Removes a project speaker; see `Project::remove_speaker` for what its
/// outputs keep.
#[tauri::command]
#[specta::specta]
pub fn projects_remove_speaker(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    speaker_id: String,
) -> Result<Project, AppError> {
    edit_project(&app, &state, &project_id, |_, project| {
        project.remove_speaker(&speaker_id);
        Ok(())
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
    let cap = assignment
        .amp_model_id
        .as_deref()
        .and_then(|id| inner.amp_models.iter().find(|m| m.id == id))
        .map(|model| capability::resolve(model, assignment.firmware_version.as_deref()));
    Ok(speaker_states(assignment, &inner.speakers, cap.as_ref()))
}
