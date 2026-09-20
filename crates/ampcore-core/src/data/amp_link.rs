use serde::Serialize;
use specta::Type;

use super::amp_model::AmpModelCatalogEntry;
use super::device_link::{resolve_device_model, DeviceModelLink};
use super::project::{AmpAssignment, Project};
use crate::live::state::DiscoveredDevice;

/// "AA:BB:CC:DD:EE:FF", "aa-bb-cc-dd-ee-ff" and "aabbccddeeff" all compare
/// equal. Mirrors `normalizeMac` in `src/lib/ampLinkStatus.ts`.
pub fn normalize_mac(mac: &str) -> String {
    mac.chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AmpLinkCheckKind {
    DeviceOnline,
    ModelDetected,
    ModelMatches,
    FirmwareMatches,
    NotLinkedElsewhere,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpLinkCheck {
    pub kind: AmpLinkCheckKind,
    pub passed: bool,
    /// User-facing explanation, shown next to the check in the Link Amp modal.
    pub detail: String,
}

/// Whether a live device may be linked to a planned project amp. Every check
/// is always present (so the UI can list them); `compatible` only when all
/// pass. All checks are hard blocks — there is no "link anyway".
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpLinkValidation {
    pub compatible: bool,
    pub detected_model_id: Option<String>,
    pub checks: Vec<AmpLinkCheck>,
}

impl AmpLinkValidation {
    pub fn first_failure(&self) -> Option<&AmpLinkCheck> {
        self.checks.iter().find(|c| !c.passed)
    }
}

fn model_label(model: &AmpModelCatalogEntry) -> String {
    format!("{} {}", model.brand, model.model)
}

fn find_model<'a>(models: &'a [AmpModelCatalogEntry], id: Option<&str>) -> Option<&'a AmpModelCatalogEntry> {
    id.and_then(|id| models.iter().find(|m| m.id == id))
}

/// Same fallback chain the Workspace uses for a card's name.
fn assignment_name(assignment: &AmpAssignment, models: &[AmpModelCatalogEntry]) -> String {
    assignment
        .device_name
        .clone()
        .or_else(|| find_model(models, assignment.amp_model_id.as_deref()).map(model_label))
        .unwrap_or_else(|| "Unnamed".to_string())
}

pub fn validate_amp_link(
    project: &Project,
    assignment: &AmpAssignment,
    device: &DiscoveredDevice,
    models: &[AmpModelCatalogEntry],
    links: &[DeviceModelLink],
) -> AmpLinkValidation {
    let mut checks = Vec::with_capacity(5);
    let mut push = |kind, passed, detail: String| checks.push(AmpLinkCheck { kind, passed, detail });

    push(
        AmpLinkCheckKind::DeviceOnline,
        device.online,
        if device.online { "Amp is reachable on the network" } else { "Amp is offline" }.to_string(),
    );

    let detected = resolve_device_model(models, links, device);
    push(
        AmpLinkCheckKind::ModelDetected,
        detected.is_some(),
        match detected {
            Some(model) => format!("Detected as {}", model_label(model)),
            None => "Model could not be detected — assign one in Live Control".to_string(),
        },
    );

    let planned = find_model(models, assignment.amp_model_id.as_deref());
    let (passed, detail) = match (planned, detected) {
        (None, _) => (false, "Project amp has no model assigned".to_string()),
        (Some(p), None) => (false, format!("Project amp is {}, network amp model is unknown", model_label(p))),
        (Some(p), Some(d)) if p.id == d.id => (true, format!("Both are {}", model_label(p))),
        (Some(p), Some(d)) => (
            false,
            format!("Project amp is {}, network amp is {}", model_label(p), model_label(d)),
        ),
    };
    push(AmpLinkCheckKind::ModelMatches, passed, detail);

    let (passed, detail) = match (assignment.firmware_version.as_deref(), device.firmware_family.as_deref()) {
        (Some(p), Some(d)) if p == d => (true, format!("Both on firmware {}", p)),
        (Some(p), Some(d)) => (false, format!("Project amp is planned for {}, network amp runs {}", p, d)),
        (None, _) => (false, "Project amp has no planned firmware version".to_string()),
        (Some(p), None) => (
            false,
            format!(
                "Project amp is planned for {}, network amp firmware \"{}\" is not recognized",
                p, device.firmware_version
            ),
        ),
    };
    push(AmpLinkCheckKind::FirmwareMatches, passed, detail);

    let mac = normalize_mac(&device.mac);
    let other = project
        .amp_assignments
        .iter()
        .find(|a| a.id != assignment.id && a.mac.as_deref().map(normalize_mac).as_deref() == Some(mac.as_str()));
    let (passed, detail) = match other {
        Some(a) => (false, format!("Already linked to \"{}\" in this project", assignment_name(a, models))),
        None => (true, "Not linked to any other amp in this project".to_string()),
    };
    push(AmpLinkCheckKind::NotLinkedElsewhere, passed, detail);

    AmpLinkValidation {
        compatible: checks.iter().all(|c| c.passed),
        detected_model_id: detected.map(|m| m.id.clone()),
        checks,
    }
}
