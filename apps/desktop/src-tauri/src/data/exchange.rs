//! Files that carry AmpCore data between machines: a project, with what it
//! needs from this machine's speaker library and amp catalogue, and the
//! speaker library on its own. Both are JSON tagged by `format`, which is what
//! tells them apart from the old app's speaker presets on import.
//!
//! Importing only ever adds: a library speaker or amp model this machine
//! already has (same id) is kept as it is, never overwritten by the file's.

use std::collections::HashSet;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use ampcore_core::data::amp_model::AmpModelCatalogEntry;
use ampcore_core::data::common::EntryOrigin;
use ampcore_core::data::project::Project;
use ampcore_core::data::speaker::SpeakerLibraryEntry;

use super::store::parse_project_value;

const PROJECT_FORMAT: &str = "ampcore-project";
const LIBRARY_FORMAT: &str = "ampcore-speakers";

/// An exported project: the project, the library speakers its placed speakers
/// and outputs reference, and the user-defined amp models its amps use —
/// built-in models exist on every machine. Only what it references, so an
/// export doesn't carry the rest of this machine's library along.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFile<'a> {
    format: &'a str,
    project: &'a Project,
    speakers: Vec<&'a SpeakerLibraryEntry>,
    amp_models: Vec<&'a AmpModelCatalogEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryFile<'a> {
    format: &'a str,
    speakers: &'a [SpeakerLibraryEntry],
}

pub fn export_project(
    project: &Project,
    library: &[SpeakerLibraryEntry],
    amp_models: &[AmpModelCatalogEntry],
) -> Result<String, String> {
    let speaker_ids: HashSet<&str> = project
        .speakers
        .iter()
        .map(|s| s.library_id.as_str())
        .chain(
            project
                .amp_assignments
                .iter()
                .flat_map(|a| &a.channels)
                .filter_map(|c| c.speaker.as_ref().map(|s| s.library_id.as_str())),
        )
        .collect();
    let model_ids: HashSet<&str> = project.amp_assignments.iter().filter_map(|a| a.amp_model_id.as_deref()).collect();
    let file = ProjectFile {
        format: PROJECT_FORMAT,
        project,
        speakers: library.iter().filter(|e| speaker_ids.contains(e.id.as_str())).collect(),
        amp_models: amp_models
            .iter()
            .filter(|m| m.origin == EntryOrigin::UserDefined && model_ids.contains(m.id.as_str()))
            .collect(),
    };
    serde_json::to_string_pretty(&file).map_err(|e| e.to_string())
}

/// What an imported project file holds.
pub struct ImportedProject {
    pub project: Project,
    pub speakers: Vec<SpeakerLibraryEntry>,
    pub amp_models: Vec<AmpModelCatalogEntry>,
}

/// An exported project — or a bare project file, as found in another
/// machine's data folder. Either way the project goes through
/// `parse_project_value`, so one saved by a newer AmpCore is refused.
pub fn import_project(text: &str) -> Result<ImportedProject, String> {
    let mut raw: Value = serde_json::from_str(text).map_err(|e| format!("not valid JSON: {e}"))?;
    let mut take = |key: &str| raw.get_mut(key).map(Value::take).unwrap_or(Value::Null);
    let (project, speakers, amp_models) = if take("format").as_str() == Some(PROJECT_FORMAT) {
        (take("project"), take("speakers"), take("ampModels"))
    } else {
        // `format` was taken out of a bare file only if it had one, and a
        // project has none — `raw` is still the whole project.
        (raw, Value::Null, Value::Null)
    };
    Ok(ImportedProject {
        project: parse_project_value(project).map_err(|e| e.to_string())?,
        speakers: list(speakers, "speakers")?,
        amp_models: list(amp_models, "amp models")?,
    })
}

pub fn export_library(library: &[SpeakerLibraryEntry]) -> Result<String, String> {
    serde_json::to_string_pretty(&LibraryFile { format: LIBRARY_FORMAT, speakers: library }).map_err(|e| e.to_string())
}

/// The entries of an exported speaker library; `None` for any other file.
pub fn import_library(text: &str) -> Option<Result<Vec<SpeakerLibraryEntry>, String>> {
    let mut raw: Value = serde_json::from_str(text).ok()?;
    if raw.get("format").and_then(Value::as_str) != Some(LIBRARY_FORMAT) {
        return None;
    }
    Some(list(raw.get_mut("speakers").map(Value::take).unwrap_or(Value::Null), "speakers"))
}

/// Adds the `incoming` items `have` lacks (by id) and returns how many. One
/// it already has stays as it is.
pub fn add_missing<T>(have: &mut Vec<T>, incoming: Vec<T>, id: impl Fn(&T) -> &str) -> usize {
    let known: HashSet<String> = have.iter().map(|t| id(t).to_string()).collect();
    let before = have.len();
    for item in incoming {
        if !known.contains(id(&item)) && !have.iter().skip(before).any(|t| id(t) == id(&item)) {
            have.push(item);
        }
    }
    have.len() - before
}

fn list<T: DeserializeOwned>(value: Value, what: &str) -> Result<Vec<T>, String> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    serde_json::from_value(value).map_err(|e| format!("its {what} can't be read: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ampcore_core::data::amp_model::AmpProtocol;
    use ampcore_core::data::project::{AmpAssignment, ProjectSpeaker, SpeakerRef, CURRENT_PROJECT_SCHEMA_VERSION};

    fn entry(id: &str) -> SpeakerLibraryEntry {
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

    fn model(id: &str, origin: EntryOrigin) -> AmpModelCatalogEntry {
        let mut m = AmpModelCatalogEntry::new("CVR".into(), id.into(), 4, false, AmpProtocol::CvrUdp);
        m.id = id.into();
        m.origin = origin;
        m
    }

    /// A project carries the speakers and custom models it uses, and only
    /// those; the file comes back as the same project.
    #[test]
    fn project_export_round_trips_with_what_it_references() {
        let mut project = Project::new("Gig".into(), String::new());
        let mut amp = AmpAssignment::new(None, None, 2, Some("custom-1".into()), Some("1.1.9".into()));
        amp.channels[0].speaker = Some(SpeakerRef {
            library_id: "on-output".into(),
            way_index: 0,
            revision: 1,
            label: "x".into(),
            project_speaker_id: None,
        });
        project.amp_assignments.push(amp);
        project.amp_assignments.push(AmpAssignment::new(None, None, 2, Some("builtin-dsp-2004".into()), None));
        project.speakers.push(ProjectSpeaker::new("Sub".into(), "placed".into(), "x".into(), 1));
        let library = vec![entry("on-output"), entry("placed"), entry("unrelated")];
        let models = vec![model("custom-1", EntryOrigin::UserDefined), model("builtin-dsp-2004", EntryOrigin::BuiltIn)];

        let text = export_project(&project, &library, &models).unwrap();
        let back = import_project(&text).unwrap();
        assert_eq!(back.project.id, project.id);
        assert_eq!(back.project.amp_assignments.len(), 2);
        let mut ids: Vec<_> = back.speakers.iter().map(|e| e.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["on-output", "placed"]);
        assert_eq!(back.amp_models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["custom-1"]);
    }

    /// A bare project file imports too; one from a newer AmpCore doesn't.
    #[test]
    fn bare_and_newer_project_files() {
        let project = Project::new("Bare".into(), String::new());
        let bare = serde_json::to_string(&project).unwrap();
        let back = import_project(&bare).unwrap();
        assert_eq!(back.project.name, "Bare");
        assert!(back.speakers.is_empty());

        let mut newer: Value = serde_json::from_str(&bare).unwrap();
        newer["schemaVersion"] = (CURRENT_PROJECT_SCHEMA_VERSION + 1).into();
        let err = import_project(&newer.to_string()).err().unwrap();
        assert!(err.contains("newer AmpCore"), "{err}");
        assert!(import_project("{not json").is_err());
    }

    #[test]
    fn library_files_are_told_apart() {
        let text = export_library(&[entry("a"), entry("b")]).unwrap();
        assert_eq!(import_library(&text).unwrap().unwrap().len(), 2);
        assert!(import_library(r#"{"speaker":{"brand":"x"}}"#).is_none(), "an old preset file is not a library");
        assert!(import_library("not json").is_none());
    }

    /// Importing adds what's missing and never replaces what's there.
    #[test]
    fn add_missing_keeps_existing_entries() {
        let mut have = vec![entry("a")];
        have[0].notes = "mine".into();
        let mut incoming = vec![entry("a"), entry("b"), entry("b")];
        incoming[0].notes = "theirs".into();
        assert_eq!(add_missing(&mut have, incoming, |e| &e.id), 1);
        assert_eq!(have.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(have[0].notes, "mine");
    }
}
