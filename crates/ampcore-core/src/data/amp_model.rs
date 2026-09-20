use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;

use super::capability::{PowerMode, SourceKind};
use super::common::{new_id, now_millis, EntryOrigin};

/// Tolerates both a missing field and an explicit JSON `null` for a field
/// that is no longer optional, so a local `amp_models.json` saved earlier
/// this session (before the field existed, or while it was still an
/// `Option<u32>` placeholder) keeps loading instead of hard-failing.
fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// How many physical channels of one `SourceKind` a model exposes, and
/// whether any of them can feed any digital input (`patchable`) or each one
/// is hard-wired to the matching digital input only. Analog is patchable —
/// e.g. a 4-channel amp's Analog-3 jack can feed digital input 1. Dante is
/// not: Dante channel N only ever feeds digital input N (Dante routing
/// happens upstream, at the network/Dante Controller level, not on this
/// amp's input matrix), so digital input N's only Dante option is "Dante-N".
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceChannelCount {
    pub kind: SourceKind,
    pub channel_count: u32,
    /// `#[serde(default)]` so `sourceCounts` entries saved before this field
    /// existed still deserialize (as `false`) instead of hard-failing store
    /// load entirely. Delete `amp_models.json` to force a clean re-seed if a
    /// local `BuiltIn` entry is stuck with a stale value.
    #[serde(default)]
    pub patchable: bool,
}

/// Per-model DSP-capability schema — channel/IO topology, EQ structure, and
/// electrical rating for a catalog entry. Populated at seed time for builtin
/// CVR models (see `capability::cvr::builtin_topology`); defaults to zeroed/
/// empty for user-defined models until the user (or a future datasheet
/// import) fills it in. Combined with a firmware-derived capability delta by
/// `capability::resolve()` to answer "what can be configured" for a given
/// (model, firmware) pair — see `AmpCapability`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct AmpDspTopology {
    #[serde(default, deserialize_with = "deserialize_null_default")]
    #[specta(type = u32)]
    pub matrix_input_count: u32,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    #[specta(type = u32)]
    pub matrix_output_count: u32,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    #[specta(type = u32)]
    pub eq_bands_per_channel: u32,
    #[serde(default)]
    pub source_counts: Vec<SourceChannelCount>,
    #[serde(default)]
    pub power_modes: Vec<PowerMode>,
    /// `None` for models with no known electrical datasheet (e.g. user-defined).
    #[serde(default)]
    pub rated_rms_voltage: Option<f64>,
}

/// Identifies which `AmpDriver` controls a catalog model — a brand-protocol-
/// family concept, not a firmware version (firmware is a runtime property of
/// a physical unit, detected at discovery time, not a fixed catalog attribute).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AmpProtocol {
    CvrUdp,
}

impl AmpProtocol {
    /// Stable short slug used to namespace live device ids (e.g. "cvr:AA:BB:...").
    pub fn slug(&self) -> &'static str {
        match self {
            AmpProtocol::CvrUdp => "cvr",
        }
    }
}

fn default_protocol() -> AmpProtocol {
    // Safe today: every existing/seeded catalog entry is CVR-brand.
    AmpProtocol::CvrUdp
}

/// A reusable, project-independent amp hardware model. Referenced by `AmpAssignment.amp_model_id` to pre-populate
/// an assignment's channel count during offline planning.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpModelCatalogEntry {
    pub id: String,
    pub brand: String,
    pub model: String,
    pub channel_count: u32,
    /// Authoritative Dante-variant flag — replaces string-matching on the
    /// model name (e.g. a trailing "D") in the frontend.
    #[serde(default)]
    pub is_dante: bool,
    #[serde(default = "default_protocol")]
    pub protocol: AmpProtocol,
    #[serde(default)]
    pub topology: AmpDspTopology,
    pub notes: Option<String>,
    pub origin: EntryOrigin,
    /// Soft-delete flag — archived entries stay resolvable for existing
    /// Project references but are hidden from pickers for new assignments.
    pub archived: bool,
    pub created_at: f64,
    pub updated_at: f64,
}

impl AmpModelCatalogEntry {
    pub fn new(brand: String, model: String, channel_count: u32, is_dante: bool, protocol: AmpProtocol) -> Self {
        let now = now_millis();
        Self {
            id: new_id(),
            brand,
            model,
            channel_count,
            is_dante,
            protocol,
            topology: AmpDspTopology::default(),
            notes: None,
            origin: EntryOrigin::UserDefined,
            archived: false,
            created_at: now,
            updated_at: now,
        }
    }

    /// Builtin catalog entries use a deterministic id (not `new_id()`'s
    /// random uuid) so re-seeding on every app start is idempotent — no
    /// need to track "have we seeded yet" separately from the data itself.
    pub fn new_builtin(
        id: &str,
        brand: &str,
        model: &str,
        channel_count: u32,
        is_dante: bool,
        protocol: AmpProtocol,
    ) -> Self {
        let now = now_millis();
        Self {
            id: id.to_string(),
            brand: brand.to_string(),
            model: model.to_string(),
            channel_count,
            is_dante,
            protocol,
            topology: AmpDspTopology::default(),
            notes: None,
            origin: EntryOrigin::BuiltIn,
            archived: false,
            created_at: now,
            updated_at: now,
        }
    }
}
