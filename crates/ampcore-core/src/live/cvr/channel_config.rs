//! Shared channel-config adapter surface — the struct every firmware-specific
//! FC=27 (SYNC_DATA) adapter parses a reassembled response into, plus the
//! single dispatch point that picks which adapter handles a device based on
//! its `firmware_family` (same pattern as `telemetry.rs`).
//!
//! Deliberately separate from `AmpChannel` (`data/project.rs`): that struct
//! carries planning-only fields (`id`, `ohms`) with no live-wire equivalent — the same separation already
//! established between `Telemetry` and `AmpChannel`.

use serde::Serialize;
use specta::Type;

use crate::data::capability::PowerMode;
use crate::data::project::{BackupPriority, ChannelEq, ChannelSource, Limiter, MatrixCrosspoint};

/// The parts of one EQ chain's wire body this app's model has no home for,
/// kept so the whole-chain write (FC=52, `write_v118::build_set_eq_chain`) can
/// echo them back instead of inventing values — the same rule
/// `commands/live_control.rs`'s `current_channel` states for partial writes.
///
/// - `chain_bypass`: the vendor's `f_CH_bypass` (0 = chain active). CVR amps
///   have no whole-EQ bypass, so nothing here models it.
/// - the HP/LP `gain`/`q`: a `CrossoverSlot` carries only type/freq/active,
///   because the slope type implies Q and gain is meaningless for it.
///
/// Rust-side only (`#[serde(skip)]`): the frontend has no use for any of it,
/// and it would otherwise ride along on every `live_channel_config:updated`.
#[derive(Debug, Clone, Default)]
pub struct EqChainWire {
    pub chain_bypass: u8,
    pub hp_gain_db: f32,
    pub hp_q: f32,
    pub lp_gain_db: f32,
    pub lp_q: f32,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConfig {
    pub channel_index: u32,
    pub delay_in_ms: f32,
    /// Sourced from the trailer's `muteIn` block, NOT any channel-body byte
    /// — see `channel_config_v118.rs`.
    pub input_muted: bool,
    pub matrix_crosspoints: Vec<MatrixCrosspoint>,
    pub input_eq: ChannelEq,
    pub output_eq: ChannelEq,
    /// Companion bytes of `input_eq`/`output_eq` — see `EqChainWire`.
    #[serde(skip)]
    pub input_eq_wire: EqChainWire,
    #[serde(skip)]
    pub output_eq_wire: EqChainWire,
    pub output_trim_db: f32,
    pub output_volume_db: f32,
    pub output_muted: bool,
    pub delay_out_ms: f32,
    pub output_phase_inverted: bool,
    pub noise_gate_enabled: bool,
    pub limiter: Limiter,
    pub fir_bypassed: bool,
    /// `None` when the raw byte doesn't match a confirmed mapping — no
    /// mapping table for this exists anywhere in this codebase yet, so an
    /// unconfirmed guess is never substituted (see `channel_config_v118.rs`).
    pub power_mode: Option<PowerMode>,
    /// `None` when the raw source-selector byte doesn't match a confirmed
    /// mapping — same honesty rule as `power_mode`.
    pub source: Option<ChannelSource>,
    pub input_name: Option<String>,
    pub output_name: Option<String>,
    pub analog_trim_db: f32,
    pub analog_delay_ms: f32,
    pub dante_trim_db: f32,
    pub dante_delay_ms: f32,
    /// Vendor `load_data` — the load impedance the amp is set to (Ω; unit to
    /// verify on hardware).
    pub load_ohms: f32,
    pub backup_priority: BackupPriority,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConfigSnapshot {
    pub channels: Vec<ChannelConfig>,
    /// Header `Standby` — whether the amp is in standby. True for both the
    /// plain standby value and the locked-out one (see `standby_locked`);
    /// `None` for a byte outside the known 0/1/2 set.
    pub standby: Option<bool>,
    /// Whether standby is locked out on the amp, i.e. it will ignore a
    /// standby write. Comes from the same header byte as `standby` (the value
    /// `2`), so it is `Some(false)` whenever `standby` is known and not
    /// locked, and `None` exactly when `standby` is `None`. The frontend
    /// disables its standby control on `Some(true)` rather than letting the
    /// user press something the amp will drop.
    pub standby_locked: Option<bool>,
    /// Header `Rotary_lock` (front-panel knob lock); `None` for a byte other
    /// than 0/1.
    pub rotary_locked: Option<bool>,
    /// Label of the last recalled preset (trailer `Scene_mode_name`).
    pub preset_name: Option<String>,
    pub received_at: f64,
}

/// Routes a reassembled FC=27 response body to the adapter for
/// `firmware_family`. A family this dispatch doesn't recognize (`None`/
/// unknown) gets no channel config at all — no generic fallback parser,
/// since guessing wrong would silently produce plausible-looking garbage
/// instead of an honest gap. `body` is the pure per-channel-data region:
/// the reassembled frame with StructHeader and checksum already stripped,
/// channel 0 starting at offset 0 (the driver does this slicing before
/// calling in — see `driver.rs`).
pub fn parse_channel_config(firmware_family: Option<&str>, body: &[u8]) -> Option<ChannelConfigSnapshot> {
    match firmware_family {
        Some("1.1.8") => super::channel_config_v118::parse_channel_config(body),
        Some("1.1.9") => super::channel_config_v119::parse_channel_config(body),
        _ => None,
    }
}
