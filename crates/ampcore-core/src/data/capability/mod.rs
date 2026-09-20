use serde::{Deserialize, Serialize};
use specta::Type;

use super::amp_model::{AmpModelCatalogEntry, AmpProtocol};

pub mod cvr;

/// Which physical input can feed a channel — the generic, protocol-agnostic
/// source vocabulary. Which variants a given model actually offers, and how
/// many physical channels each variant has, is `AmpDspTopology.source_counts`,
/// not this enum itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Analog,
    Dante,
    Backup,
}

/// Output power/impedance mode — ported from the old app's `POWER_MODE_NAMES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PowerMode {
    LowOhm,
    V70,
    V100,
}

/// An inclusive min/max bound for a numeric parameter.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParamRange {
    pub min: f64,
    pub max: f64,
}

/// Numeric filter-type identifiers for the 8 parametric EQ bands (bands 1-8 of
/// the fixed 10-band-per-direction structure) — ported 1:1 from the old app's
/// `EQ_FILTER_TYPE_NAMES`/`getEqFilterTypeCapabilities`. Scaffolding only: not
/// yet consumed by any UI or persisted field this phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EqFilterType {
    Peaking,
    LowShelf,
    HighShelf,
    AllPass1st,
    AllPass2nd,
    GeneralLow,
    GeneralHigh,
    ButterworthLow,
    ButterworthHigh,
    BesselLow,
    BesselHigh,
}

/// Numeric filter-type identifiers for the HP (band 0) / LP (band 9) crossover
/// slots — ported 1:1 from the old app's `HPLP_FILTER_TYPE_NAMES`. Scaffolding
/// only, same status as `EqFilterType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CrossoverFilterType {
    Butterworth12,
    Bessel12,
    LinkwitzRiley12,
    Butterworth18,
    Butterworth24,
    Bessel24,
    LinkwitzRiley24,
    Butterworth36,
    Butterworth48,
    Bessel48,
    LinkwitzRiley48,
}

/// Whether a filter type exposes an editable gain and/or Q — e.g. all-pass
/// filters support neither. Ported 1:1 from the old app's
/// `getEqFilterTypeCapabilities`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FilterCapabilities {
    pub supports_gain: bool,
    pub supports_q: bool,
}

impl EqFilterType {
    /// Every variant, in declaration order — used to build
    /// `eq_filter_capabilities()`'s full table. Rust has no automatic enum
    /// iteration without a crate dependency (e.g. `strum`); a manual const
    /// array is the plain-code equivalent for a fixed 11-variant enum like
    /// this one.
    pub const ALL: [EqFilterType; 11] = [
        EqFilterType::Peaking,
        EqFilterType::LowShelf,
        EqFilterType::HighShelf,
        EqFilterType::AllPass1st,
        EqFilterType::AllPass2nd,
        EqFilterType::GeneralLow,
        EqFilterType::GeneralHigh,
        EqFilterType::ButterworthLow,
        EqFilterType::ButterworthHigh,
        EqFilterType::BesselLow,
        EqFilterType::BesselHigh,
    ];

    pub fn capabilities(self) -> FilterCapabilities {
        use EqFilterType::*;
        match self {
            Peaking | LowShelf | HighShelf => FilterCapabilities { supports_gain: true, supports_q: true },
            AllPass1st => FilterCapabilities { supports_gain: false, supports_q: false },
            AllPass2nd | GeneralLow | GeneralHigh => {
                FilterCapabilities { supports_gain: false, supports_q: true }
            }
            ButterworthLow | ButterworthHigh | BesselLow | BesselHigh => {
                FilterCapabilities { supports_gain: false, supports_q: false }
            }
        }
    }
}

/// One `EqFilterType` variant's resolved capabilities — pairs the type with
/// its `FilterCapabilities` so the frontend can gate a band's gain/Q inputs
/// from `AmpCapability.eq_filter_capabilities` instead of hardcoding a copy
/// of `EqFilterType::capabilities()`'s table in TypeScript. Keeps this
/// genuinely capability-driven: if a future model or firmware ever needs a
/// *different* gain/Q table, `eq_filter_capabilities()` is the one place
/// that changes — no frontend edit required, same as `paramRanges`/
/// `topology`/firmware flags.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EqFilterCapabilityEntry {
    pub filter_type: EqFilterType,
    pub supports_gain: bool,
    pub supports_q: bool,
}

/// The full `EqFilterType` -> `FilterCapabilities` table, resolved once per
/// `AmpCapability`. Currently identical across every model/firmware (matches
/// `EqFilterType::capabilities()`, which isn't model-parameterized either),
/// but living here — not inlined at each call site — is what makes it a
/// single seam to change later.
pub fn eq_filter_capabilities() -> Vec<EqFilterCapabilityEntry> {
    EqFilterType::ALL
        .iter()
        .map(|&filter_type| {
            let caps = filter_type.capabilities();
            EqFilterCapabilityEntry { filter_type, supports_gain: caps.supports_gain, supports_q: caps.supports_q }
        })
        .collect()
}

/// Combined, resolved answer to "what can be configured, and within what
/// ranges" for one (amp model, firmware version) pair. Never persisted
/// independently — always recomputed by `resolve()` from an
/// `AmpModelCatalogEntry` and an `AmpAssignment.firmware_version`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpCapability {
    pub topology: super::amp_model::AmpDspTopology,
    pub firmware: cvr::CvrFirmwareCapability,
    pub param_ranges: cvr::AmpParamRanges,
    /// Which `EqFilterType`s expose gain/Q — EQ tab's band editor. See
    /// `eq_filter_capabilities()`.
    pub eq_filter_capabilities: Vec<EqFilterCapabilityEntry>,
}

/// Single dispatch point across protocols. Currently just one arm — a plain
/// `match`, not a trait — because `AmpProtocol` itself is a plain enum today
/// (see its `slug()` method). This match is the seam: promoting it to a
/// `ProtocolCapabilityProvider` trait when a second protocol arrives is a
/// mechanical extraction of the match arms, not a redesign.
pub fn resolve(model: &AmpModelCatalogEntry, firmware_version: Option<&str>) -> AmpCapability {
    match model.protocol {
        AmpProtocol::CvrUdp => cvr::resolve(model, firmware_version),
    }
}
