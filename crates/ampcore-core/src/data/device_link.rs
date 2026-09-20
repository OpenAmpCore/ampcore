use serde::{Deserialize, Serialize};
use specta::Type;

use super::amp_model::AmpModelCatalogEntry;
use crate::live::state::DiscoveredDevice;

/// Persists which catalog `AmpModelCatalogEntry` a live-discovered device
/// (identified by MAC, not by any Project's `AmpAssignment`) should be
/// configured as — needed so Direct Edit mode can resolve `AmpCapability`
/// for a bare `DiscoveredDevice` the same way Project mode resolves it for
/// an `AmpAssignment`. Deliberately independent of `AmpAssignment.mac`
/// (which stays unpopulated) and of any `Project` — this is a small,
/// standalone, MAC-keyed pairing, not the (separate, out-of-scope) feature
/// of linking a live device into a Project's persisted config.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceModelLink {
    pub mac: String,
    pub amp_model_id: String,
    /// `true` when produced by `match_catalog_model`, `false` when the user
    /// explicitly picked/overrode it — an auto-match is safe to silently
    /// re-run and refresh on every reconnect, a manual pick never is.
    pub auto_matched: bool,
    pub updated_at: f64,
}

/// Matches a live device's raw firmware string against the catalog using the
/// same trusted substring technique as
/// `capability::cvr::rated_rms_voltage_from_firmware_string` — a model
/// designation baked in at the factory is real identity, not a guess.
/// Returns `None` (never a first-match-wins fallback) whenever the match
/// isn't unambiguous: no known designation found, more than one distinct
/// base model name found in the string, or the matched entry's channel
/// count disagrees with what the device itself reports — a wrong-but-
/// confident capability resolution is worse than an honestly missing one,
/// same rule this codebase already applies to rated-voltage lookup and
/// firmware-family detection.
pub fn match_catalog_model<'a>(
    models: &'a [AmpModelCatalogEntry],
    firmware_version: &str,
    digital_input_channels: u32,
    output_channels: u32,
) -> Option<&'a AmpModelCatalogEntry> {
    let upper = firmware_version.to_uppercase();
    let candidates: Vec<&AmpModelCatalogEntry> = models
        .iter()
        .filter(|m| !m.archived)
        .filter(|m| upper.contains(m.model.strip_suffix('D').unwrap_or(m.model.as_str())))
        .collect();

    let mut base_names: Vec<&str> = candidates
        .iter()
        .map(|m| m.model.strip_suffix('D').unwrap_or(m.model.as_str()))
        .collect();
    base_names.sort_unstable();
    base_names.dedup();
    if base_names.len() != 1 {
        return None;
    }

    // Same base model name may still match twice (an Analog/Dante variant
    // pair, e.g. "DSP-2004" / "DSP-2004D") — disambiguate by whether the
    // device itself reports any digital inputs.
    let wants_dante = digital_input_channels > 0;
    let matched = candidates.into_iter().find(|m| m.is_dante == wants_dante)?;

    if matched.channel_count != output_channels {
        return None;
    }

    Some(matched)
}

/// Read-only: which catalog model a live device currently resolves to. A
/// saved link (manual pick or earlier auto-match) wins over re-matching;
/// otherwise `match_catalog_model`. Never persists anything — use
/// `device_model_link_auto_match` when a match should be recorded.
pub fn resolve_device_model<'a>(
    models: &'a [AmpModelCatalogEntry],
    links: &[DeviceModelLink],
    device: &DiscoveredDevice,
) -> Option<&'a AmpModelCatalogEntry> {
    links
        .iter()
        .find(|l| l.mac == device.mac)
        .and_then(|l| models.iter().find(|m| m.id == l.amp_model_id))
        .or_else(|| {
            match_catalog_model(models, &device.firmware_version, device.digital_input_channels, device.output_channels)
        })
}
