use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use super::amp_model::{AmpModelCatalogEntry, AmpProtocol};
use super::capability::cvr::builtin_topology;
use super::common::EntryOrigin;
use super::device_link::DeviceModelLink;
use super::project::{Project, CURRENT_PROJECT_SCHEMA_VERSION};

/// Rust-owned canonical store for Projects + Amp Model Catalog — the "Project Data" domain from the architecture plan. Writes
/// here are infrequent and user-paced (not a polling loop), so a single
/// coarse lock is fine; this is deliberately kept independent from the
/// (future, separate) live-device-state domain.
pub struct ProjectDataState(pub Mutex<ProjectDataInner>);

pub struct ProjectDataInner {
    pub data_dir: PathBuf,
    pub projects: Vec<Project>,
    pub amp_models: Vec<AmpModelCatalogEntry>,
    pub device_model_links: Vec<DeviceModelLink>,
}

/// Builtin CVR amp product line — (model, channel_count). Seeded into the
/// catalog on every load if missing; ids are deterministic (`builtin-<model
/// lowercased>`) so this is idempotent rather than a one-time migration.
const BUILTIN_AMP_MODELS: &[(&str, u32)] = &[
    ("DSP-654", 4),
    ("DSP-802", 2),
    ("DSP-1002", 2),
    ("DSP-1004", 4),
    ("DSP-1502", 2),
    ("DSP-2002", 2),
    ("DSP-1504", 4),
    ("DSP-2004", 4),
    ("DSP-3002", 2),
    ("DSP-3004", 4),
    ("DSP-3302", 2),
    ("DSP-4302", 2),
];

/// Dante-networked counterparts of `BUILTIN_AMP_MODELS` — same product line,
/// model name suffixed with "D" (e.g. "DSP-2004D").
fn dante_builtin_amp_models() -> Vec<(String, u32)> {
    BUILTIN_AMP_MODELS
        .iter()
        .map(|(model, channel_count)| (format!("{model}D"), *channel_count))
        .collect()
}

fn seed_builtin_amp_models(amp_models: &mut Vec<AmpModelCatalogEntry>) -> bool {
    let mut changed = false;
    for (model, channel_count) in BUILTIN_AMP_MODELS {
        let id = format!("builtin-{}", model.to_lowercase());
        if !amp_models.iter().any(|m| m.id == id) {
            let mut entry =
                AmpModelCatalogEntry::new_builtin(&id, "CVR", model, *channel_count, false, AmpProtocol::CvrUdp);
            entry.topology = builtin_topology(model, *channel_count, false);
            amp_models.push(entry);
            changed = true;
        }
    }
    for (model, channel_count) in dante_builtin_amp_models() {
        let id = format!("builtin-{}", model.to_lowercase());
        if !amp_models.iter().any(|m| m.id == id) {
            let mut entry =
                AmpModelCatalogEntry::new_builtin(&id, "CVR", &model, channel_count, true, AmpProtocol::CvrUdp);
            entry.topology = builtin_topology(&model, channel_count, true);
            amp_models.push(entry);
            changed = true;
        }
    }
    changed
}

/// Backfill for installs whose `amp_models.json` predates real topology data
/// (when `AmpDspTopology` was an always-empty placeholder), or predates a
/// field later added to `AmpDspTopology` (e.g. `source_counts` replacing
/// `available_sources`). Scoped to `BuiltIn` origin only, same rationale as
/// `migrate_dante_flag` — a user-defined model's hand-authored topology must
/// never be overwritten. Recomputed from `builtin_topology` every load
/// (deterministic from model/channel_count/is_dante) and compared
/// field-for-field via `PartialEq`, so this is idempotent rather than a
/// one-time migration, and self-updating — no per-field staleness check to
/// remember to extend the next time `AmpDspTopology` grows a field.
fn migrate_builtin_topology(amp_models: &mut Vec<AmpModelCatalogEntry>) -> bool {
    let mut changed = false;
    for m in amp_models.iter_mut() {
        if m.origin != EntryOrigin::BuiltIn {
            continue;
        }
        let expected = builtin_topology(&m.model, m.channel_count, m.is_dante);
        if m.topology != expected {
            m.topology = expected;
            changed = true;
        }
    }
    changed
}

/// One-time backfill for installs with `amp_models.json` predating
/// `is_dante`. Scoped to `BuiltIn` origin only — a user-defined model that
/// happens to end in "D" should not be force-flagged as Dante.
fn migrate_dante_flag(amp_models: &mut Vec<AmpModelCatalogEntry>) -> bool {
    let mut changed = false;
    for m in amp_models.iter_mut() {
        if !m.is_dante && m.origin == EntryOrigin::BuiltIn && m.model.ends_with('D') {
            m.is_dante = true;
            changed = true;
        }
    }
    changed
}

impl ProjectDataState {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("project-data");
        fs::create_dir_all(data_dir.join("projects")).map_err(|e| e.to_string())?;

        // The Speaker Library was removed from the app together with speaker
        // planning, and its saved data is deleted rather than left orphaned —
        // nothing reads it any more. Idempotent: a no-op once the file is gone.
        // A failed delete is logged, not fatal; it must never block loading
        // the projects the user can still open.
        let speaker_library_path = data_dir.join("speaker_library.json");
        if speaker_library_path.exists() {
            if let Err(e) = fs::remove_file(&speaker_library_path) {
                eprintln!("[project data] could not delete obsolete {}: {e}", speaker_library_path.display());
            }
        }
        let device_model_links = load_json_or_default(&data_dir.join("device_model_links.json"))?;
        let mut amp_models = load_json_or_default(&data_dir.join("amp_models.json"))?;
        let migrated = migrate_dante_flag(&mut amp_models);
        let seeded = seed_builtin_amp_models(&mut amp_models);
        let topology_migrated = migrate_builtin_topology(&mut amp_models);
        if migrated || seeded || topology_migrated {
            save_amp_models(&data_dir, &amp_models)?;
        }

        let mut projects = load_projects(&data_dir)?;
        for project in projects.iter_mut() {
            let mut changed = false;
            // Files below schema 11 still carry the removed speaker/Join
            // fields (`speakerLibraryId`, `wayIndex`, `joinGroupId`). serde
            // ignores them on load, so rewriting the file here is what strips
            // them from disk — see `CURRENT_PROJECT_SCHEMA_VERSION`.
            if project.schema_version < CURRENT_PROJECT_SCHEMA_VERSION {
                changed = true;
            }
            changed |= reconcile_project_matrix_sizes(project, &amp_models);
            changed |= reconcile_project_eq_band_sizes(project, &amp_models);
            if changed {
                project.schema_version = CURRENT_PROJECT_SCHEMA_VERSION;
                save_project_file(&data_dir, project)?;
            }
        }

        Ok(Self(Mutex::new(ProjectDataInner {
            data_dir,
            projects,
            amp_models,
            device_model_links,
        })))
    }
}

/// Backfill for assignments whose stored `matrix_crosspoints` length no
/// longer matches their assigned model's current `matrix_input_count` — e.g.
/// projects saved before a topology formula change (like the Dante
/// input-doubling fix) or before this field existed at all. Explicit
/// mutation commands (`projects_set_amp_model` etc.) already reconcile this
/// going forward; this backfill catches project files that predate that.
fn reconcile_project_matrix_sizes(project: &mut Project, amp_models: &[AmpModelCatalogEntry]) -> bool {
    let mut changed = false;
    for assignment in project.amp_assignments.iter_mut() {
        let Some(model_id) = &assignment.amp_model_id else {
            continue;
        };
        let Some(model) = amp_models.iter().find(|m| &m.id == model_id) else {
            continue;
        };
        let expected = model.topology.matrix_input_count;
        let needs_fix = assignment
            .channels
            .iter()
            .any(|c| c.matrix_crosspoints.len() as u32 != expected);
        if needs_fix {
            assignment.reconcile_matrix_size(expected);
            changed = true;
        }
    }
    changed
}

/// Backfill for assignments whose stored `input_eq.bands`/`output_eq.bands`
/// length no longer matches their assigned model's current
/// `eq_bands_per_channel - 2` — same rationale as
/// `reconcile_project_matrix_sizes`. A no-op for every project today (CVR's
/// `eq_bands_per_channel` is a constant 10, and `#[serde(default = ...)]`
/// already backfills a full 8-band chain for files that predate this field
/// entirely), but kept as the mechanical parallel for when that changes.
fn reconcile_project_eq_band_sizes(project: &mut Project, amp_models: &[AmpModelCatalogEntry]) -> bool {
    let mut changed = false;
    for assignment in project.amp_assignments.iter_mut() {
        let Some(model_id) = &assignment.amp_model_id else {
            continue;
        };
        let Some(model) = amp_models.iter().find(|m| &m.id == model_id) else {
            continue;
        };
        let expected = model.topology.eq_bands_per_channel.saturating_sub(2);
        let needs_fix = assignment
            .channels
            .iter()
            .any(|c| c.input_eq.bands.len() as u32 != expected || c.output_eq.bands.len() as u32 != expected);
        if needs_fix {
            assignment.reconcile_eq_bands(model.topology.eq_bands_per_channel);
            changed = true;
        }
    }
    changed
}

fn load_projects(data_dir: &Path) -> Result<Vec<Project>, String> {
    let projects_dir = data_dir.join("projects");
    let mut projects = Vec::new();
    for entry in fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let contents = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let mut value: serde_json::Value = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
            backfill_channel_sources(&mut value);
            backfill_label_into_device_name(&mut value);
            let project: Project = serde_json::from_value(value).map_err(|e| e.to_string())?;
            projects.push(project);
        }
    }
    Ok(projects)
}

/// Schema 12 made `AmpChannel.source` required. Files written before that may
/// carry a missing or `null` source; those load as Analog `channelIndex` — the
/// same 1:1 default a new channel gets. Runs on the raw JSON because the typed
/// `Project` can no longer represent "no source". Idempotent.
fn backfill_channel_sources(project: &mut serde_json::Value) {
    let Some(assignments) = project.get_mut("ampAssignments").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for assignment in assignments {
        let Some(channels) = assignment.get_mut("channels").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        for channel in channels {
            let Some(channel) = channel.as_object_mut() else {
                continue;
            };
            if channel.get("source").map_or(true, |source| source.is_null()) {
                let index = channel.get("channelIndex").and_then(|v| v.as_u64()).unwrap_or(0);
                channel.insert("source".to_string(), serde_json::json!({ "kind": "analog", "index": index }));
            }
        }
    }
}

/// Schema 19 dropped `AmpAssignment.label` in favor of `device_name`. Files
/// written before that may carry a `label` with no `deviceName`; this copies
/// it over before the field disappears from the typed `Project`. Runs on the
/// raw JSON, same rationale as `backfill_channel_sources`. Idempotent.
fn backfill_label_into_device_name(project: &mut serde_json::Value) {
    let Some(assignments) = project.get_mut("ampAssignments").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for assignment in assignments {
        let Some(assignment) = assignment.as_object_mut() else {
            continue;
        };
        let device_name_empty = assignment
            .get("deviceName")
            .map_or(true, |v| v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty()));
        if !device_name_empty {
            continue;
        }
        let label = assignment.get("label").and_then(|v| v.as_str()).map(str::to_string);
        if let Some(label) = label {
            if !label.trim().is_empty() {
                assignment.insert("deviceName".to_string(), serde_json::Value::String(label));
            }
        }
    }
}

fn load_json_or_default<T>(path: &Path) -> Result<T, String>
where
    T: Default + serde::de::DeserializeOwned,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let contents = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&contents).map_err(|e| e.to_string())
}

pub fn save_project_file(data_dir: &Path, project: &Project) -> Result<(), String> {
    let path = data_dir.join("projects").join(format!("{}.json", project.id));
    let json = serde_json::to_string_pretty(project).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn delete_project_file(data_dir: &Path, id: &str) -> Result<(), String> {
    let path = data_dir.join("projects").join(format!("{}.json", id));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn save_amp_models(data_dir: &Path, entries: &[AmpModelCatalogEntry]) -> Result<(), String> {
    let path = data_dir.join("amp_models.json");
    let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn save_device_model_links(data_dir: &Path, entries: &[DeviceModelLink]) -> Result<(), String> {
    let path = data_dir.join("device_model_links.json");
    let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
