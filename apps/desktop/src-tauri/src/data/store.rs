use std::collections::HashSet;
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
use ampcore_core::data::speaker::{SpeakerLibraryEntry, SpeakerProcessing, CURRENT_SPEAKER_LIBRARY_VERSION};

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
    /// Project amps (by assignment id) in a live session with their linked
    /// amp — see `AmpEditLock.following`. Runtime only, never saved.
    pub following: HashSet<String>,
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
        let speakers = load_speakers(&data_dir.join("speakers.json"), &mut load_problems)?;
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
            following: HashSet::new(),
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
            set_aside_and_report(path, &e, problems)?;
            Ok(T::default())
        }
    }
}

fn set_aside_and_report(path: &Path, reason: &dyn std::fmt::Display, problems: &mut Vec<String>) -> Result<(), String> {
    let aside = set_aside(path)?;
    problems.push(format!(
        "{} couldn't be read ({reason}) and was moved aside, unchanged, to {}; AmpCore started with an empty one.",
        path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        aside.display()
    ));
    Ok(())
}

/// A stored library's format: a bare list is 0, from before it had a version.
/// `None` if this isn't a library at all.
fn speaker_library_version(raw: &Value) -> Option<u64> {
    if raw.is_array() {
        return Some(0);
    }
    raw.get("schemaVersion")?.as_u64()
}

fn newer_speaker_library(version: u64) -> String {
    format!(
        "it was saved by a newer AmpCore (speaker library format {version}; this version reads up to {CURRENT_SPEAKER_LIBRARY_VERSION}) — update AmpCore to open it"
    )
}

/// A speaker list in format `version`, rewritten to the current format: the
/// one way a library enters the app, from `speakers.json` or an imported file.
/// A newer list is refused rather than loaded lossily. A change that renames,
/// removes or reinterprets a field bumps `CURRENT_SPEAKER_LIBRARY_VERSION` and
/// rewrites `speakers` here, oldest step first. Format 1 changed only the
/// wrapper.
pub fn migrate_speakers(version: u64, mut speakers: Value) -> Result<Value, String> {
    if version > u64::from(CURRENT_SPEAKER_LIBRARY_VERSION) {
        return Err(newer_speaker_library(version));
    }
    if version < 2 {
        // 2: a way carries every field of the output. One that left a field
        // out (`null`, "the amp keeps its own") gets a fresh output's value.
        let neutral = serde_json::to_value(SpeakerProcessing::neutral()).map_err(|e| e.to_string())?;
        let ways = speakers.as_array_mut().into_iter().flatten().filter_map(|e| e.get_mut("ways")?.as_array_mut());
        for processing in ways.flatten().filter_map(|w| w.get_mut("processing")?.as_object_mut()) {
            for (key, value) in neutral.as_object().into_iter().flatten() {
                if processing.get(key).is_none_or(Value::is_null) {
                    processing.insert(key.clone(), value.clone());
                }
            }
        }
    }
    Ok(speakers)
}

/// `speakers.json`, in any format up to the current one. A newer file is left
/// exactly where it is and `save_speakers` refuses to replace it. One that
/// can't be read is set aside like any other data file.
fn load_speakers(path: &Path, problems: &mut Vec<String>) -> Result<Vec<SpeakerLibraryEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let parsed = serde_json::from_str::<Value>(&contents).map_err(|e| e.to_string()).and_then(|mut raw| {
        let version = speaker_library_version(&raw).ok_or("not a speaker library")?;
        let speakers = if raw.is_array() { raw } else { raw.get_mut("speakers").map(Value::take).unwrap_or(Value::Null) };
        Ok((version, speakers))
    });
    let (version, speakers) = match parsed {
        Ok(parsed) => parsed,
        Err(e) => {
            set_aside_and_report(path, &e, problems)?;
            return Ok(Vec::new());
        }
    };
    if version > u64::from(CURRENT_SPEAKER_LIBRARY_VERSION) {
        problems.push(format!(
            "speakers.json wasn't opened: {}. AmpCore started with an empty speaker library and can't change it until then.",
            newer_speaker_library(version)
        ));
        return Ok(Vec::new());
    }
    match migrate_speakers(version, speakers).and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string())) {
        Ok(entries) => Ok(entries),
        Err(e) => {
            set_aside_and_report(path, &e, problems)?;
            Ok(Vec::new())
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

/// Saves the library in the current format. What's on disk decides what happens
/// first: a newer file is never replaced, and an older one is copied to
/// `speakers.json.v<old>` the first time its format changes.
pub fn save_speakers(data_dir: &Path, entries: &[SpeakerLibraryEntry]) -> Result<(), String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct StoredLibrary<'a> {
        schema_version: u32,
        speakers: &'a [SpeakerLibraryEntry],
    }

    let path = data_dir.join("speakers.json");
    let stored_version = fs::read_to_string(&path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|raw| speaker_library_version(&raw));
    if let Some(version) = stored_version {
        if version > u64::from(CURRENT_SPEAKER_LIBRARY_VERSION) {
            return Err(format!("The speaker library wasn't saved: {}.", newer_speaker_library(version)));
        }
        let backup = data_dir.join(format!("speakers.json.v{version}"));
        if version < u64::from(CURRENT_SPEAKER_LIBRARY_VERSION) && !backup.exists() {
            fs::copy(&path, &backup).map_err(|e| format!("could not back up {}: {e}", path.display()))?;
        }
    }
    save_json(&path, &StoredLibrary { schema_version: CURRENT_SPEAKER_LIBRARY_VERSION, speakers: entries })
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

    fn library_entry(id: &str) -> SpeakerLibraryEntry {
        SpeakerLibraryEntry {
            id: id.into(),
            brand: "B".into(),
            family: String::new(),
            model: id.into(),
            application: String::new(),
            notes: String::new(),
            revision: 1,
            ways: Vec::new(),
            created_at: 0.0,
            updated_at: 0.0,
        }
    }

    /// Today's bare list still loads. The first save moves it to the current
    /// format and keeps the original, once.
    #[test]
    fn a_bare_library_loads_and_is_backed_up_when_saved() {
        let dir = data_dir();
        let path = dir.join("speakers.json");
        let bare = serde_json::to_string(&vec![library_entry("a")]).unwrap();
        fs::write(&path, &bare).unwrap();

        let mut problems = Vec::new();
        let loaded = load_speakers(&path, &mut problems).unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(fs::read_to_string(&path).unwrap(), bare, "loading alone changes nothing");

        save_speakers(&dir, &loaded).unwrap();
        assert_eq!(fs::read_to_string(dir.join("speakers.json.v0")).unwrap(), bare);
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["schemaVersion"], u64::from(CURRENT_SPEAKER_LIBRARY_VERSION));

        assert_eq!(load_speakers(&path, &mut problems).unwrap().len(), 1, "the new format reads back");
        fs::write(&path, &bare).unwrap();
        fs::write(dir.join("speakers.json.v0"), "first backup").unwrap();
        save_speakers(&dir, &loaded).unwrap();
        assert_eq!(fs::read_to_string(dir.join("speakers.json.v0")).unwrap(), "first backup", "never overwritten");
        fs::remove_dir_all(dir).ok();
    }

    /// A format-1 way that left fields out (`null`, or missing) loads with a
    /// fresh output's values there and keeps the ones it had.
    #[test]
    fn a_partial_way_from_format_1_is_filled_in() {
        let mut entry = serde_json::to_value(library_entry("a")).unwrap();
        let mut processing = serde_json::to_value(SpeakerProcessing::neutral()).unwrap();
        processing["delayOutMs"] = 3.0.into();
        processing["outputTrimDb"] = Value::Null;
        processing["powerMode"] = Value::Null;
        processing.as_object_mut().unwrap().remove("fir");
        entry["ways"] = serde_json::json!([{ "label": "Full", "processing": processing }]);

        let migrated = migrate_speakers(1, Value::Array(vec![entry])).unwrap();
        let loaded: Vec<SpeakerLibraryEntry> = serde_json::from_value(migrated).unwrap();
        let (way, neutral) = (&loaded[0].ways[0].processing, SpeakerProcessing::neutral());
        assert_eq!(way.delay_out_ms, 3.0);
        assert_eq!((way.output_trim_db, way.power_mode), (neutral.output_trim_db, neutral.power_mode));
        assert_eq!(way.fir, neutral.fir);
    }

    /// A newer library is neither loaded lossily nor replaced by a save.
    #[test]
    fn a_newer_library_is_left_untouched() {
        let dir = data_dir();
        let path = dir.join("speakers.json");
        let newer = format!(r#"{{"schemaVersion":{},"speakers":[],"futureField":1}}"#, CURRENT_SPEAKER_LIBRARY_VERSION + 1);
        fs::write(&path, &newer).unwrap();

        let mut problems = Vec::new();
        assert!(load_speakers(&path, &mut problems).unwrap().is_empty());
        assert!(problems.iter().any(|p| p.contains("newer AmpCore")), "{problems:?}");
        let err = save_speakers(&dir, &[library_entry("a")]).unwrap_err();
        assert!(err.contains("newer AmpCore"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), newer);
        assert!(!dir.join("speakers.json.unreadable").exists());
        fs::remove_dir_all(dir).ok();
    }

    /// Valid JSON that isn't a library, or entries that can't be read, go the
    /// same way as a broken file.
    #[test]
    fn an_unreadable_library_is_still_set_aside() {
        for contents in ["not json", r#"{"other":true}"#, r#"[{"id":1}]"#] {
            let dir = data_dir();
            let path = dir.join("speakers.json");
            fs::write(&path, contents).unwrap();
            let mut problems = Vec::new();
            assert!(load_speakers(&path, &mut problems).unwrap().is_empty());
            assert_eq!(problems.len(), 1, "{contents}");
            assert_eq!(fs::read_to_string(dir.join("speakers.json.unreadable")).unwrap(), contents);
            save_speakers(&dir, &[library_entry("a")]).unwrap();
            fs::remove_dir_all(dir).ok();
        }
    }
}
