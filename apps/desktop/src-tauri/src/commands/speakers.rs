//! Speakers on project outputs: fitting a library speaker to an amp, applying
//! it, and the project speakers the Workspace places. The library itself is
//! `speaker_library.rs`. The logic lives in `ampcore_core::data::speaker`; these are the thin
//! Tauri wrappers.
//!
//! `speakers_apply` is the one way values get in, and it has no write path of
//! its own: it changes a copy of the project amp and hands that to the push
//! (`amp_push::push_assignment`), the same endpoint the online/offline sync
//! uses. Offline, the copy is simply saved.


use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use ampcore_core::live::state::LiveDeviceState;

use ampcore_core::data::project::{
    shift_output, CanvasPosition, GroupOffset, Project, ProjectSpeaker, SpeakerGroup, SpeakerRef, MAX_PARALLEL,
};
use ampcore_core::data::capability;
use ampcore_core::data::speaker::{
    speaker_states, ChannelSpeakerState, SpeakerLibraryEntry, SpeakerProcessing, SpeakerWay,
};
use ampcore_core::live::cvr::write_v118::CHANNEL_NAME_FIELD_LEN;
use ampcore_core::error::AppError;

use super::amp_write::{assignment_limits, save_or_push};
use super::speaker_library::find_entry;
use crate::data::store;
use crate::data::store::ProjectDataState;

/// One output's way, fitted to the amp it is going onto.
struct FittedWay {
    channel_index: u32,
    processing: SpeakerProcessing,
    reference: SpeakerRef,
    /// The way's label as the output's name, cut to the amp's 16-byte field.
    /// `None` when it isn't ASCII — the amp can't store that, and a name is
    /// no reason to refuse the speaker — so the output keeps its own.
    output_name: Option<String>,
    /// The output's Load when linked to a project speaker: the way's nominal
    /// impedance over its parallel count. Display only, never written.
    load: Option<f64>,
    /// The output's group offset right after the way's values went on (its
    /// delay and polarity are the preset's, so only gain and mute are left)
    /// and once linked as `reference` says.
    group_shift: (GroupOffset, GroupOffset),
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
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let project = inner.projects.iter().find(|p| p.id == project_id).ok_or_else(|| AppError::from("amp not found"))?;
    let assignment =
        project.amp_assignments.iter().find(|a| a.id == assignment_id).ok_or_else(|| AppError::from("amp not found"))?;
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
            let SpeakerWay { label, processing, nominal_ohms, .. } = entry.ways.get(way as usize).ok_or("No such way")?;
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
            let parallel = reference
                .project_speaker_id
                .as_deref()
                .and_then(|id| project.speakers.iter().find(|s| s.id == id))
                .map(|s| s.parallel.max(1));
            let load = nominal_ohms.zip(parallel).map(|(ohms, n)| ohms / n as f64);
            let offset = |speaker: Option<&str>| speaker.map(|id| project.speaker_offset(id)).unwrap_or_default();
            let group_shift = (
                offset(channel.speaker.as_ref().and_then(|s| s.project_speaker_id.as_deref())).without_preset_fields(),
                offset(reference.project_speaker_id.as_deref()),
            );
            Ok(FittedWay { channel_index, processing: fitted, reference, output_name, load, group_shift, issues, rows })
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

    save_or_push(&app, &state, &live, project_id, assignment_id, "the speaker", |candidate, limits| {
        for f in fitted {
            let channel = store::channel_mut(candidate, f.channel_index)?;
            f.processing.apply_to(channel);
            let (volume, delay) = (limits.ranges.output_volume_db, limits.ranges.delay_out_ms);
            shift_output(channel, f.group_shift.0, f.group_shift.1, volume, delay)
                .map_err(|e| AppError::from(format!("The speaker's groups don't fit: {e}")))?;
            channel.speaker = Some(f.reference);
            if f.output_name.is_some() {
                channel.output_name = f.output_name;
            }
            if let Some(ohms) = f.load {
                channel.ohms = ohms;
            }
        }
        Ok(())
    })
    .await
}

/// Unlinks an output: removes its speaker reference and takes its groups'
/// offset off (`regroup`). Its other values are left alone —
/// `speakers_apply` is what sets a speaker up.
#[tauri::command]
#[specta::specta]
pub async fn projects_set_channel_speaker(
    app: AppHandle,
    state: State<'_, ProjectDataState>,
    live: State<'_, LiveDeviceState>,
    project_id: String,
    assignment_id: String,
    channel_index: u32,
) -> Result<Project, AppError> {
    regroup(&app, &state, &live, &project_id, None, |project| {
        if let Some(channel) = project
            .amp_assignments
            .iter_mut()
            .find(|a| a.id == assignment_id)
            .and_then(|a| a.channels.iter_mut().find(|c| c.channel_index == channel_index))
        {
            channel.speaker = None;
        }
    })
    .await
}

/// The project-level counterpart of `edit_with_library`, for project speakers.
fn edit_project(
    app: &AppHandle,
    state: &State<ProjectDataState>,
    project_id: &str,
    edit: impl FnOnce(&[SpeakerLibraryEntry], &mut Project) -> Result<(), AppError>,
) -> Result<Project, AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let project = store::project_mut(&mut inner.projects, &project_id)?;
    edit(&inner.speakers, project)?;
    store::commit(&app, &inner.data_dir, project)
}

/// Places a library speaker in the project, linked to nothing yet — a group
/// of `parallel` identical cabinets on the same outputs (1 = one cabinet).
/// Its ways are linked by `speakers_apply` (`SpeakerItem.project_speaker_id`).
#[tauri::command]
#[specta::specta]
pub fn projects_add_speaker(
    app: AppHandle,
    state: State<ProjectDataState>,
    project_id: String,
    library_id: String,
    name: String,
    parallel: u32,
) -> Result<Project, AppError> {
    if !(1..=MAX_PARALLEL).contains(&parallel) {
        return Err(AppError::from(format!("A parallel group holds 1 to {MAX_PARALLEL} cabinets")));
    }
    edit_project(&app, &state, &project_id, |library, project| {
        let entry = library
            .iter()
            .find(|e| e.id == library_id)
            .ok_or_else(|| AppError::from("That speaker is no longer in the library"))?;
        let label = format!("{} {}", entry.brand, entry.model);
        let name = Some(name.trim()).filter(|n| !n.is_empty()).unwrap_or(&entry.model).to_string();
        project.speakers.push(ProjectSpeaker::new(name, library_id, label, parallel));
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
/// outputs keep. Its groups' offset comes off them (`regroup`).
#[tauri::command]
#[specta::specta]
pub async fn projects_remove_speaker(
    app: AppHandle,
    state: State<'_, ProjectDataState>,
    live: State<'_, LiveDeviceState>,
    project_id: String,
    speaker_id: String,
) -> Result<Project, AppError> {
    regroup(&app, &state, &live, &project_id, None, |project| project.remove_speaker(&speaker_id)).await
}

/// Replaces the project's speaker groups (members, values, tile positions),
/// writing what changes on the amps (`regroup`).
#[tauri::command]
#[specta::specta]
pub async fn projects_set_groups(
    app: AppHandle,
    state: State<'_, ProjectDataState>,
    live: State<'_, LiveDeviceState>,
    project_id: String,
    groups: Vec<SpeakerGroup>,
) -> Result<Project, AppError> {
    regroup(&app, &state, &live, &project_id, None, |project| project.groups = groups.clone()).await
}

/// Puts the groups back on top of one amp's outputs, for a pull whose values
/// were the outputs' own (another project, or software that knows nothing of
/// these groups, wrote the amp): every grouped output gets its whole offset
/// added, through `regroup`'s checks and rollback.
#[tauri::command]
#[specta::specta]
pub async fn projects_reapply_groups(
    app: AppHandle,
    state: State<'_, ProjectDataState>,
    live: State<'_, LiveDeviceState>,
    project_id: String,
    assignment_id: String,
) -> Result<Project, AppError> {
    regroup(&app, &state, &live, &project_id, Some(&assignment_id), |_| {}).await
}

/// One amp's outputs whose group offset changes: (channel, from, to).
type Shifts = Vec<(u32, GroupOffset, GroupOffset)>;

/// The one way an output's group offset changes: `change` (groups, links or
/// project speakers) is made on a copy first, every output whose offset moves
/// gets the difference (`shift_output`), written per amp through
/// `save_or_push`, and only once every amp took it is `change` stored. The
/// whole change is refused before anything is written when an output would
/// pass its range; when an amp fails, the amps already written are moved
/// back, so the outputs never hold an offset the project doesn't have.
/// `change` runs twice (copy, then store), so it must be idempotent.
/// `bare` names an amp whose outputs are taken to hold no group offset now
/// (`projects_reapply_groups`).
async fn regroup(
    app: &AppHandle,
    state: &State<'_, ProjectDataState>,
    live: &State<'_, LiveDeviceState>,
    project_id: &str,
    bare: Option<&str>,
    change: impl Fn(&mut Project),
) -> Result<Project, AppError> {
    let plan: Vec<(String, String, Shifts)> = {
        let inner = state.lock()?;
        let mut project = store::project(&inner.projects, project_id)?.clone();
        let mut before = project.group_offsets();
        if let Some(bare) = bare {
            before.retain(|(amp, _), _| amp != bare);
        }
        change(&mut project);
        let after = project.group_offsets();
        let mut plan = Vec::new();
        for amp in &project.amp_assignments {
            let limits = assignment_limits(&inner.amp_models, amp);
            let (volume, delay) = (limits.ranges.output_volume_db, limits.ranges.delay_out_ms);
            let name = amp.device_name.clone().unwrap_or_else(|| "An amp".into());
            let mut shifts = Shifts::new();
            for channel in &amp.channels {
                let key = (amp.id.clone(), channel.channel_index);
                let from = before.get(&key).copied().unwrap_or_default();
                let to = after.get(&key).copied().unwrap_or_default();
                if from == to {
                    continue;
                }
                shift_output(&mut channel.clone(), from, to, volume, delay).map_err(|e| {
                    let label = channel
                        .output_name
                        .clone()
                        .unwrap_or_else(|| format!("Out {}", (b'A' + channel.channel_index as u8) as char));
                    AppError::from(format!("{name}, {label}: {e}"))
                })?;
                shifts.push((channel.channel_index, from, to));
            }
            if !shifts.is_empty() {
                plan.push((amp.id.clone(), name, shifts));
            }
        }
        plan
    };

    let write = |assignment_id: String, shifts: Shifts| {
        save_or_push(app, state, live, project_id.to_string(), assignment_id, "the group", move |candidate, limits| {
            let (volume, delay) = (limits.ranges.output_volume_db, limits.ranges.delay_out_ms);
            for (ch, from, to) in shifts {
                shift_output(store::channel_mut(candidate, ch)?, from, to, volume, delay).map_err(AppError::from)?;
            }
            Ok(())
        })
    };
    let mut done: Vec<(String, Shifts)> = Vec::new();
    for (assignment_id, name, shifts) in plan {
        if let Err(e) = write(assignment_id.clone(), shifts.clone()).await {
            for (id, back) in done {
                let _ = write(id, back.into_iter().map(|(ch, from, to)| (ch, to, from)).collect()).await;
            }
            return Err(AppError::from(format!("Nothing was changed: {name} didn't take it. {}", e.message)));
        }
        done.push((assignment_id, shifts));
    }

    edit_project(app, state, project_id, |_, project| {
        change(project);
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
    let inner = state.lock()?;
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
    let project = inner.projects.iter().find(|p| p.id == project_id);
    Ok(speaker_states(assignment, project, &inner.speakers, cap.as_ref()))
}
