use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use tauri::{AppHandle, Manager};

use ampcore_core::data::amp_model::{AmpModelCatalogEntry, AmpProtocol};
use ampcore_core::data::common::now_millis;
use ampcore_core::data::capability::cvr::builtin_topology;
use ampcore_core::data::device_link::DeviceModelLink;
use ampcore_core::data::project::{Project, CURRENT_PROJECT_SCHEMA_VERSION};
use ampcore_core::data::speaker::SpeakerLibraryEntry;

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
    /// This machine's speaker library (`speakers.json`), shared by every
    /// project — see `ampcore_core::data::speaker`.
    pub speakers: Vec<SpeakerLibraryEntry>,
    /// What loading couldn't open, as sentences for the project list — a
    /// file set aside as unreadable, or one saved by a newer AmpCore.
    pub load_problems: Vec<String>,
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

impl ProjectDataState {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("project-data");
        fs::create_dir_all(data_dir.join("projects")).map_err(|e| e.to_string())?;

        // The old metadata-only Speaker Library (`speaker_library.json`) was
        // removed together with speaker planning, and its saved data is
        // deleted rather than left orphaned — nothing reads it any more. The
        // current library lives in `speakers.json`. Idempotent: a no-op once the file is gone.
        // A failed delete is logged, not fatal; it must never block loading
        // the projects the user can still open.
        let speaker_library_path = data_dir.join("speaker_library.json");
        if speaker_library_path.exists() {
            if let Err(e) = fs::remove_file(&speaker_library_path) {
                eprintln!("[project data] could not delete obsolete {}: {e}", speaker_library_path.display());
            }
        }
        let mut load_problems = Vec::new();
        let device_model_links = load_json_or_set_aside(&data_dir.join("device_model_links.json"), &mut load_problems)?;
        let speakers = load_json_or_set_aside(&data_dir.join("speakers.json"), &mut load_problems)?;
        let mut amp_models = load_json_or_set_aside(&data_dir.join("amp_models.json"), &mut load_problems)?;
        let seeded = seed_builtin_amp_models(&mut amp_models);
        if seeded {
            save_amp_models(&data_dir, &amp_models)?;
        }

        let mut projects = load_projects(&data_dir, &mut load_problems)?;
        for project in projects.iter_mut() {
            let mut changed = false;
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
            speakers,
            load_problems,
        })))
    }
}

/// Backfill for assignments whose stored `matrix_crosspoints` length no
/// longer matches their assigned model's current `matrix_input_count` — e.g.
/// projects saved before a topology formula change (like the Dante
/// input-doubling fix) or before this field existed at all. Explicit
/// mutation commands (`projects_set_amp_model` etc.) already reconcile this
/// going forward; this backfill catches project files that predate that.
pub(crate) fn reconcile_project_matrix_sizes(project: &mut Project, amp_models: &[AmpModelCatalogEntry]) -> bool {
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
pub(crate) fn reconcile_project_eq_band_sizes(project: &mut Project, amp_models: &[AmpModelCatalogEntry]) -> bool {
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

/// Why a project file didn't load.
#[derive(Debug)]
pub enum ProjectFileError {
    /// Saved by a newer AmpCore, in a format this version can't read whole —
    /// opening and re-saving it would drop what this version doesn't know.
    Newer(u32),
    Unreadable(String),
}

impl std::fmt::Display for ProjectFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectFileError::Newer(version) => write!(
                f,
                "it was saved by a newer AmpCore (project format {version}; this version reads up to {CURRENT_PROJECT_SCHEMA_VERSION}) — update AmpCore to open it"
            ),
            ProjectFileError::Unreadable(reason) => f.write_str(reason),
        }
    }
}

/// A project file's JSON as this version's `Project` — the one way a project
/// enters the app, from its own data folder or from an imported file.
///
/// The format version gates it: a newer file is refused rather than loaded
/// lossily. Formats 1–5 only ever *added* fields, each with a serde default, so
/// an older file deserializes as it is. A change that renames, removes or
/// reinterprets a field bumps `CURRENT_PROJECT_SCHEMA_VERSION` and rewrites
/// `raw` here, oldest step first, before it is typed.
pub fn parse_project_value(raw: Value) -> Result<Project, ProjectFileError> {
    let version = raw.get("schemaVersion").and_then(Value::as_u64).unwrap_or(0);
    if version > u64::from(CURRENT_PROJECT_SCHEMA_VERSION) {
        return Err(ProjectFileError::Newer(version as u32));
    }
    let mut project: Project =
        serde_json::from_value(raw).map_err(|e| ProjectFileError::Unreadable(format!("not a project file: {e}")))?;
    project.schema_version = CURRENT_PROJECT_SCHEMA_VERSION;
    Ok(project)
}

pub fn parse_project(contents: &str) -> Result<Project, ProjectFileError> {
    let raw = serde_json::from_str(contents).map_err(|e| ProjectFileError::Unreadable(format!("not valid JSON: {e}")))?;
    parse_project_value(raw)
}

/// Every project in the data folder that loads. One that doesn't never stops
/// the others: an unreadable file is renamed out of the way (kept, for
/// recovery) and a newer one left where it is, each reported in `problems`.
fn load_projects(data_dir: &Path, problems: &mut Vec<String>) -> Result<Vec<Project>, String> {
    let projects_dir = data_dir.join("projects");
    let mut projects = Vec::new();
    for entry in fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let parsed = fs::read_to_string(&path)
            .map_err(|e| ProjectFileError::Unreadable(format!("could not be read: {e}")))
            .and_then(|contents| parse_project(&contents));
        match parsed {
            Ok(project) => projects.push(project),
            Err(newer @ ProjectFileError::Newer(_)) => {
                problems.push(format!("A project wasn't opened: {newer}. ({})", path.display()));
            }
            Err(ProjectFileError::Unreadable(reason)) => {
                let aside = set_aside(&path)?;
                problems.push(format!(
                    "A project file couldn't be read ({reason}) and was moved aside, unchanged, to {}.",
                    aside.display()
                ));
            }
        }
    }
    Ok(projects)
}

/// `path` parsed, or `T::default()` when it doesn't exist yet. A file that
/// won't parse is renamed out of the way (kept, for recovery) and reported,
/// so the app still starts — and the next save can't overwrite it.
fn load_json_or_set_aside<T>(path: &Path, problems: &mut Vec<String>) -> Result<T, String>
where
    T: Default + serde::de::DeserializeOwned,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let contents = fs::read_to_string(path).map_err(|e| e.to_string())?;
    match serde_json::from_str(&contents) {
        Ok(value) => Ok(value),
        Err(e) => {
            let aside = set_aside(path)?;
            problems.push(format!(
                "{} couldn't be read ({e}) and was moved aside, unchanged, to {}; AmpCore started with an empty one.",
                path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                aside.display()
            ));
            Ok(T::default())
        }
    }
}

/// Renames `path` to `<name>.unreadable` (or `.unreadable-<ms>` if that is
/// taken) beside it, where no loader looks.
fn set_aside(path: &Path) -> Result<PathBuf, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut aside = path.with_file_name(format!("{name}.unreadable"));
    if aside.exists() {
        aside = path.with_file_name(format!("{name}.unreadable-{}", now_millis() as u64));
    }
    fs::rename(path, &aside).map_err(|e| format!("could not move unreadable {} aside: {e}", path.display()))?;
    Ok(aside)
}

/// Replaces `path` with `contents` without ever leaving it half-written: the
/// bytes go to a sibling temp file, are flushed to disk, and only then renamed
/// over the original (atomic on one filesystem). A crash or full disk leaves
/// the previous file intact.
pub fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = path.with_file_name(format!("{name}.tmp"));
    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    };
    write().map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("could not save {}: {e}", path.display())
    })
}

fn save_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_atomic(path, json.as_bytes())
}

pub fn save_project_file(data_dir: &Path, project: &Project) -> Result<(), String> {
    save_json(&data_dir.join("projects").join(format!("{}.json", project.id)), project)
}

pub fn delete_project_file(data_dir: &Path, id: &str) -> Result<(), String> {
    let path = data_dir.join("projects").join(format!("{}.json", id));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn save_amp_models(data_dir: &Path, entries: &[AmpModelCatalogEntry]) -> Result<(), String> {
    save_json(&data_dir.join("amp_models.json"), entries)
}

pub fn save_device_model_links(data_dir: &Path, entries: &[DeviceModelLink]) -> Result<(), String> {
    save_json(&data_dir.join("device_model_links.json"), entries)
}

pub fn save_speakers(data_dir: &Path, entries: &[SpeakerLibraryEntry]) -> Result<(), String> {
    save_json(&data_dir.join("speakers.json"), entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ampcore_core::data::common::new_id;

    /// A fresh, empty data folder with a `projects/` directory.
    fn data_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ampcore-store-test-{}", new_id()));
        fs::create_dir_all(dir.join("projects")).unwrap();
        dir
    }

    #[test]
    fn atomic_write_replaces_whole_and_leaves_no_temp_file() {
        let dir = data_dir();
        let path = dir.join("speakers.json");
        write_atomic(&path, b"[1]").unwrap();
        write_atomic(&path, b"[2, 3]").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[2, 3]");
        assert!(!dir.join("speakers.json.tmp").exists());
        fs::remove_dir_all(dir).ok();
    }

    /// One bad project file doesn't stop the others: it is moved aside
    /// unchanged and reported, a newer one is skipped and left in place, and
    /// an older one loads stamped with the current format.
    #[test]
    fn loading_isolates_bad_and_newer_project_files() {
        let dir = data_dir();
        let good = Project::new("Good".into(), String::new());
        save_project_file(&dir, &good).unwrap();

        let broken = dir.join("projects").join("broken.json");
        fs::write(&broken, "{\"name\": \"half writ").unwrap();

        let mut newer: Value = serde_json::to_value(Project::new("Newer".into(), String::new())).unwrap();
        newer["schemaVersion"] = (CURRENT_PROJECT_SCHEMA_VERSION + 1).into();
        let newer_path = dir.join("projects").join("newer.json");
        fs::write(&newer_path, newer.to_string()).unwrap();

        let mut older: Value = serde_json::to_value(Project::new("Older".into(), String::new())).unwrap();
        older["schemaVersion"] = 2.into();
        older.as_object_mut().unwrap().remove("speakers");
        fs::write(dir.join("projects").join("older.json"), older.to_string()).unwrap();

        let mut problems = Vec::new();
        let mut loaded = load_projects(&dir, &mut problems).unwrap();
        loaded.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(loaded.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Good", "Older"]);
        assert!(loaded.iter().all(|p| p.schema_version == CURRENT_PROJECT_SCHEMA_VERSION));

        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(!broken.exists());
        assert_eq!(
            fs::read_to_string(dir.join("projects").join("broken.json.unreadable")).unwrap(),
            "{\"name\": \"half writ",
            "set aside unchanged"
        );
        assert!(newer_path.exists(), "a newer file is left for the newer AmpCore");
        assert!(problems.iter().any(|p| p.contains("newer AmpCore")), "{problems:?}");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_bad_library_file_is_set_aside_and_starts_empty() {
        let dir = data_dir();
        let path = dir.join("speakers.json");
        fs::write(&path, "not json").unwrap();
        let mut problems = Vec::new();
        let speakers: Vec<SpeakerLibraryEntry> = load_json_or_set_aside(&path, &mut problems).unwrap();
        assert!(speakers.is_empty());
        assert!(!path.exists());
        assert!(dir.join("speakers.json.unreadable").exists());
        assert_eq!(problems.len(), 1);

        // A second bad file doesn't overwrite the first one set aside.
        fs::write(&path, "also not json").unwrap();
        let _: Vec<SpeakerLibraryEntry> = load_json_or_set_aside(&path, &mut problems).unwrap();
        assert_eq!(fs::read_to_string(dir.join("speakers.json.unreadable")).unwrap(), "not json");
        fs::remove_dir_all(dir).ok();
    }
}
