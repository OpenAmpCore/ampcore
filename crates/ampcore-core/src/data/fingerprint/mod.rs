//! Deterministic amp/channel fingerprints — the groundwork for matching a live
//! amp to a Project `AmpAssignment` (offline↔online) and for verifying that a
//! channel's speaker processing is what it is supposed to be.
//!
//! One canonical path serves both sides: a project `AmpChannel` and a live
//! FC=27 `ChannelConfig` are each reduced to the same borrowed `ChannelInput`,
//! canonicalized, and hashed from a hand-written byte encoding. Nothing is
//! persisted; fingerprints are recomputed on demand.
//!
//! Two hashes:
//! - **`speakerHash`** (per output channel): CRC-16/XModem, 4 hex chars, over
//!   output-side speaker processing — output EQ (HP, parametric
//!   bands, LP), RMS + peak limiter (incl. auto/max), output delay, polarity,
//!   power mode and FIR bypass. Short enough to embed in the
//!   16-byte output name as `Name_XXXX`, the same convention (and CRC variant,
//!   not byte layout) as the prior web app's `speaker-sync-hash.ts`.
//! - **`ampHash`**: FNV-1a 64, 16 hex chars, over the amp's identity (model,
//!   channel count, firmware family), its settings (device name and
//!   bridge pairs) and every channel's remaining settings: the speaker hashes,
//!   input EQ, source, matrix, input delay, trim, volume, mutes, noise-gate
//!   on/off, input name, output name (without its `_XXXX` suffix, which is
//!   derived from the speaker hash), and per-source trim/delay.
//!
//! Everything the amp stores as a *setting* in FC=27 is hashed, with one
//! current exception: **backup priority** is read and shown but deliberately
//! left out of the hash. `channel_config_v118.rs`'s trailer offset for it
//! (`trailer_base + 140`) is unverified against real hardware, and a live
//! capture showed the identical `{enabled, first, second, threshold}` on
//! every channel — including `first == second`, which nothing would
//! configure — the signature of a misaligned read rather than real
//! per-channel config. Hashing an unverified field would lock every linked
//! amp on a value that might just be wrong; once the offset is confirmed
//! against hardware, move it back into `encode_channel_amp`.
//!
//! Pure status — standby, the last recalled preset's name, the front-panel
//! knob lock — is carried in `AmpFingerprint.status` and shown, never hashed.
//!
//! **FIR.** Each output's FIR taps are part of its speaker hash. They are the
//! one hashed setting that isn't in FC=27: the project stores them
//! (`AmpChannel.fir`), and the live side takes them from the driver's own
//! FC=43 reads (`LiveDeviceInner.fir`). An output the driver hasn't read yet
//! is unreadable, like an unreported bridge pair. The filter's *name* is
//! shown, never hashed — an amp answering with the nameless reply form can't
//! report one. Firmware without FIR hashes a unit impulse on both sides.
//! Not covered at all: MAC/IP (identity, not config).
//! The noise-gate threshold is hashed only where the firmware stores it (1.1.9+,
//! read back by `channel_config_v119`) and only while the gate is on.
//!
//! **What the JSON shows vs. what is hashed.** The JSON shows what the amp
//! actually stores, in natural units, including a bypassed band's or a
//! disabled limiter's values. Every number is already rounded to its fixed
//! step (0.1 Hz, 0.01 dB, 0.001 Q, 0.01 ms, 0.01 V, 1 ms) after a cast through
//! `f32` — the precision the wire stores (see `write_v118.rs`) — so an offline
//! `f64` and its online `f32` readback display, and hash, identically. The
//! hash then ignores what doesn't affect the sound: a bypassed band/slot's
//! settings, a disabled limiter stage's settings, an inactive crosspoint's
//! gain, and a gain/Q the filter type doesn't use (shown as `null`).
//!
//! **Not tied to one model.** Nothing assumes a channel count, band count or
//! matrix size: those come from the data or the catalog topology (crosspoints
//! beyond `matrix_input_count` are ignored — the CVR parser always reads 4,
//! even on 2-channel amps). Enums hash by fingerprint-owned tags, not by any
//! protocol's wire codes. The firmware family is the live driver's own
//! `DiscoveredDevice.firmware_family` label online, and the same protocol's
//! bucketing of the planned version offline.
//!
//! Nothing is guessed: an input that can't be read (live power mode, source,
//! unreported bridge pair, unresolved model) makes the affected hash `None`
//! and adds a reason to `missing`.

use serde::Serialize;
use specta::Type;

use super::amp_model::{AmpModelCatalogEntry, AmpProtocol};
use super::capability::{resolve, CrossoverFilterType, EqFilterType, PowerMode, SourceKind};
use super::device_link::{resolve_device_model, DeviceModelLink};
use super::project::{
    AmpAssignment, AmpChannel, BackupPriority, ChannelEq, ChannelSource, CrossoverSlot, EqBand, Limiter, MatrixCrosspoint,
    Project, SourceTrim, SourceTrims,
};
use crate::live::cvr::bridge::DeviceBridgeSnapshot;
use crate::live::cvr::channel_config::{ChannelConfig, ChannelConfigSnapshot};
use crate::live::cvr::fir::{fir_order, fir_time_zero, taps_summary, trimmed_taps, ChannelFirSnapshot};
use crate::live::cvr::protocol::{detect_firmware_family, is_known_family};
use crate::live::state::DiscoveredDevice;

mod canonical;
mod encode;
mod compare;
pub(crate) use canonical::*;
use encode::*;
pub use compare::*;

/// First byte of every hash input. Bump whenever the canonicalization rules,
/// field set or byte encoding change, so fingerprints from different rule
/// sets can never falsely match.
///
/// 2: natural-unit JSON, bypassed values skipped in the hash instead of
/// zeroed, fingerprint-owned filter tags, matrix clipped to topology, bridge
/// state per pair at amp level.
///
/// 3: full FC=27 settings coverage — EQ chain bypass, limiter auto/max, load,
/// FIR bypass, dynamic EQ, mutes, output name base, per-source trims, backup
/// priority, knob gains, device name and link groups.
///
/// 4: dynamic EQ removed (not supported for any model).
///
/// 5: EQ chain bypass removed (CVR amps have none — bands are only active or
/// bypassed individually).
///
/// 6: input/output channel link groups removed (not supported for any model).
///
/// 7: online device name taken from FC=0 BASIC_INFO (the user-set name)
/// instead of the FC=27 header, which holds the firmware/model ID string.
///
/// 8: knob gain removed (CVR amps have no such setting).
///
/// 9: backup priority removed from the hash (still shown) — its trailer
/// offset is unverified against hardware; see the module doc comment.
///
/// 10: AES3 removed (no supported model has it), dropping its trim/delay pair
/// from every channel's digest.
///
/// 11: noise-gate threshold added (1.1.9+ only, while the gate is on).
///
/// 12: FIR taps added to the speaker hash.
///
/// 13: load removed from the speaker hash — it is a local value that only
/// converts volts to watts in the limiter editor, never the amp's.
pub const FINGERPRINT_VERSION: u8 = 13;

/// `_XXXX` — separator plus 4 hex chars appended to an output name.
pub const HASH_SUFFIX_LEN: usize = 5;

/// Rounding steps, as steps per unit. Shared with `amp_merge.rs`, which stores
/// merged values at exactly these steps.
pub(crate) const FREQ_STEPS: f64 = 10.0; // 0.1 Hz

pub(crate) const GAIN_STEPS: f64 = 100.0; // 0.01 dB

pub(crate) const Q_STEPS: f64 = 1000.0; // 0.001

pub(crate) const DELAY_STEPS: f64 = 100.0; // 0.01 ms

pub(crate) const VOLT_STEPS: f64 = 100.0; // 0.01 V

pub(crate) const WHOLE_STEPS: f64 = 1.0; // limiter ms / release multiplier (u16/u8 on the wire)

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FingerprintSource {
    Offline,
    Online,
}

/// Where a fingerprint came from. Flat rather than an internally tagged enum:
/// `kind` says which of the optional ids are set.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintOrigin {
    pub kind: FingerprintSource,
    pub project_id: Option<String>,
    pub assignment_id: Option<String>,
    pub device_id: Option<String>,
    pub mac: Option<String>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpIdentity {
    /// Catalog model name, e.g. "DSP-2004" — the hashed identity.
    pub model: Option<String>,
    /// Informational only; not hashed.
    pub amp_model_id: Option<String>,
    pub channel_count: u32,
    /// Protocol firmware bucket, e.g. "1.1.8"/"1.1.9" for CVR.
    pub firmware_family: Option<String>,
}

/// Amp-wide settings beyond identity.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpSettingsCanonical {
    /// The amp's user-set name (written with FC=60, read back via FC=0
    /// BASIC_INFO). Trimmed; empty when unset.
    pub device_name: String,
}

/// Operational state read from the amp — shown next to the comparison, never
/// hashed. Always empty for a project amp.
#[derive(Debug, Clone, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpStatus {
    pub standby: Option<bool>,
    /// Whether the amp is refusing standby writes — folded into the `Standby`
    /// status row's text rather than given a row of its own, since it is
    /// `false` on every amp that isn't in this unusual state.
    pub standby_locked: Option<bool>,
    pub preset_name: Option<String>,
    pub rotary_locked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CrossoverCanonical {
    pub filter_type: CrossoverFilterType,
    pub freq_hz: f64,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EqBandCanonical {
    pub filter_type: EqFilterType,
    pub freq_hz: f64,
    /// `None` when the filter type has no gain.
    pub gain_db: Option<f64>,
    /// `None` when the filter type has no Q.
    pub q: Option<f64>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EqCanonical {
    pub hp: CrossoverCanonical,
    pub bands: Vec<EqBandCanonical>,
    pub lp: CrossoverCanonical,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RmsLimiterCanonical {
    pub enabled: bool,
    pub threshold_vrms: f64,
    pub attack_ms: f64,
    pub release_multiplier: f64,
    pub auto: bool,
    pub max_vrms: f64,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PeakLimiterCanonical {
    pub enabled: bool,
    pub threshold_vp: f64,
    pub hold_ms: f64,
    pub release_ms: f64,
    pub max_vp: f64,
}

/// The values `speakerHash` is computed from.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerCanonical {
    pub output_eq: EqCanonical,
    pub rms_limiter: RmsLimiterCanonical,
    pub peak_limiter: PeakLimiterCanonical,
    pub delay_out_ms: f64,
    pub phase_inverted: bool,
    /// `None` only for a live channel whose power-mode byte is unmapped.
    pub power_mode: Option<PowerMode>,
    pub fir_bypassed: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CrosspointCanonical {
    pub source_index: u32,
    pub gain_db: f64,
    pub active: bool,
}

/// The per-channel fields `ampHash` covers beyond the speaker hash.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAmpCanonical {
    pub input_eq: EqCanonical,
    /// `None` only for a live channel whose source byte is unreadable (also
    /// listed in `missing`); a project channel always has a source.
    pub source: Option<ChannelSource>,
    /// Only the model's matrix inputs (`0..matrix_input_count`).
    pub matrix_crosspoints: Vec<CrosspointCanonical>,
    pub delay_in_ms: f64,
    pub output_trim_db: f64,
    pub output_volume_db: f64,
    pub noise_gate_enabled: bool,
    /// Whole dBu. `None` when the firmware stores no threshold (1.1.8) or the
    /// gate is off, where it doesn't affect the sound.
    pub noise_gate_threshold_dbu: Option<f64>,
    /// Trimmed; empty when unnamed or still the default "In{n}" label.
    pub input_name: String,
    pub input_muted: bool,
    pub output_muted: bool,
    /// Trimmed, `_XXXX` hash suffix removed; empty when unnamed or still the
    /// default "Out{letter}" label.
    pub output_name_base: String,
    pub source_trims: SourceTrims,
    /// Shown, never hashed — see the module doc comment.
    pub backup_priority: BackupPriority,
}

/// One output's FIR filter as the fingerprint shows it. Deliberately excludes
/// the 512 coefficients: `summary` is what tells two filters apart.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelFirStats {
    /// `false` when the channel holds the unit impulse an empty channel keeps
    /// — i.e. no real filter is loaded.
    pub loaded: bool,
    /// Shown, never hashed. `None` when the amp replied with the 2048-byte
    /// nameless form.
    pub name: Option<String>,
    /// Taps minus trailing zeros — the vendor's "Order: N Taps".
    pub order: u32,
    pub time_zero_ms: f64,
    /// "N taps · checksum" (`fir::taps_summary`): equal exactly when the
    /// hashed taps are.
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelFingerprint {
    pub channel_index: u32,
    /// Output letter, "A", "B", …
    pub label: String,
    pub speaker_hash: Option<String>,
    pub output_name: Option<String>,
    /// `XXXX` from an output name ending in `_XXXX`, if present.
    pub embedded_hash: Option<String>,
    /// Set only when both `embedded_hash` and `speaker_hash` exist.
    pub embedded_hash_matches: Option<bool>,
    pub speaker: SpeakerCanonical,
    pub amp_fields: ChannelAmpCanonical,
    /// `None` only for a live output whose FIR the driver hasn't read yet
    /// (also listed in `missing`).
    pub fir: Option<ChannelFirStats>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpFingerprint {
    pub fingerprint_version: u32,
    pub origin: FingerprintOrigin,
    pub identity: AmpIdentity,
    pub settings: AmpSettingsCanonical,
    /// Shown, never hashed. Always empty for a project amp.
    pub status: AmpStatus,
    /// `None` whenever `missing` is non-empty.
    pub amp_hash: Option<String>,
    pub channels: Vec<ChannelFingerprint>,
    /// One entry per bridgeable pair (A/B, C/D, …); a trailing unpaired
    /// channel has none. `None` = not reported yet (also listed in `missing`).
    pub bridged_pairs: Vec<Option<bool>>,
    /// Human-readable reasons a hash could not be computed.
    pub missing: Vec<String>,
}

// ---------------------------------------------------------------------------
// Shared input — both sources reduce to this
// ---------------------------------------------------------------------------

pub fn fingerprint_project_amp(
    project: &Project,
    assignment: &AmpAssignment,
    models: &[AmpModelCatalogEntry],
) -> AmpFingerprint {
    let mut missing = Vec::new();

    let model = assignment.amp_model_id.as_deref().and_then(|id| models.iter().find(|m| m.id == id));
    let firmware_family = model.and_then(|m| planned_firmware_family(m, assignment.firmware_version.as_deref()));
    match model {
        None => missing.push("No amp model assigned".to_string()),
        Some(_) if firmware_family.is_none() => {
            missing.push("Firmware version not set or not recognized".to_string())
        }
        Some(_) => {}
    }

    let mut channels: Vec<&AmpChannel> = assignment.channels.iter().collect();
    channels.sort_by_key(|c| c.channel_index);

    let channel_count = model.map(|m| m.channel_count).unwrap_or(channels.len() as u32);
    let matrix_input_count = model.map(|m| m.topology.matrix_input_count).unwrap_or(channel_count);
    let identity = AmpIdentity {
        model: model.map(|m| m.model.clone()),
        amp_model_id: model.map(|m| m.id.clone()),
        channel_count,
        firmware_family,
    };
    let origin = FingerprintOrigin {
        kind: FingerprintSource::Offline,
        project_id: Some(project.id.clone()),
        assignment_id: Some(assignment.id.clone()),
        device_id: None,
        mac: assignment.mac.clone(),
        label: assignment.device_name.clone(),
    };
    let firmware = model.map(|m| resolve(m, assignment.firmware_version.as_deref()).firmware);
    let has_gate_threshold = firmware.as_ref().is_some_and(|f| f.noise_gate_threshold);
    let has_fir = firmware.as_ref().is_some_and(|f| f.fir_filters);
    let inputs = channels.into_iter().map(|c| ChannelInput::from_project(c, has_gate_threshold, has_fir)).collect();
    let amp_input = AmpInput {
        device_name: assignment.device_name.as_deref(),
        status: AmpStatus::default(),
    };
    build(origin, identity, matrix_input_count, amp_input, inputs, missing)
}

/// `fir` is what the driver has read of this device's FIR filters (FC=43),
/// one snapshot per output it has reached so far.
pub fn fingerprint_live_device(
    device: &DiscoveredDevice,
    snapshot: &ChannelConfigSnapshot,
    bridge: Option<&DeviceBridgeSnapshot>,
    fir: &[ChannelFirSnapshot],
    models: &[AmpModelCatalogEntry],
    links: &[DeviceModelLink],
) -> AmpFingerprint {
    let mut missing = Vec::new();

    let model = resolve_device_model(models, links, device);
    if model.is_none() {
        missing.push("Amp model not resolved for this device".to_string());
    }
    // The driver's own bucket — the exact label the rest of the live side uses.
    let firmware_family = device.firmware_family.clone();
    if firmware_family.is_none() {
        missing.push(format!("Firmware version \"{}\" not recognized", device.firmware_version));
    }

    let channel_count = device.output_channels;
    let matrix_input_count = model.map(|m| m.topology.matrix_input_count).unwrap_or(channel_count);
    let mut configs: Vec<&ChannelConfig> =
        snapshot.channels.iter().filter(|c| c.channel_index < channel_count).collect();
    configs.sort_by_key(|c| c.channel_index);

    let identity = AmpIdentity {
        model: model.map(|m| m.model.clone()),
        amp_model_id: model.map(|m| m.id.clone()),
        channel_count,
        firmware_family,
    };
    let origin = FingerprintOrigin {
        kind: FingerprintSource::Online,
        project_id: None,
        assignment_id: None,
        device_id: Some(device.id.clone()),
        mac: Some(device.mac.clone()),
        label: Some(device.name.clone()).filter(|n| !n.trim().is_empty()),
    };
    // The same gate every FIR command uses (`require_fir_firmware`).
    let has_fir = is_known_family(device.firmware_family.as_deref());
    let inputs = configs
        .into_iter()
        .map(|c| {
            let pair = (c.channel_index / 2) as usize;
            let bridged = bridge.and_then(|b| b.bridged.get(pair).copied().flatten());
            let fir = if has_fir {
                fir.iter()
                    .find(|f| f.channel_index == c.channel_index)
                    .map(|f| FirInput { name: f.name.as_deref(), coefficients: &f.coefficients })
            } else {
                Some(NO_FIR)
            };
            ChannelInput::from_live(c, bridged, fir)
        })
        .collect();
    let amp_input = AmpInput {
        device_name: Some(device.name.as_str()),
        status: AmpStatus {
            standby: snapshot.standby,
            standby_locked: snapshot.standby_locked,
            preset_name: snapshot.preset_name.clone(),
            rotary_locked: snapshot.rotary_locked,
        },
    };
    build(origin, identity, matrix_input_count, amp_input, inputs, missing)
}

/// Splits `"Name_A91C"` into `("Name", Some("A91C"))`; a name without a
/// valid `_XXXX` suffix comes back whole with `None`.
pub fn split_hash_suffix(name: &str) -> (&str, Option<String>) {
    let bytes = name.as_bytes();
    if bytes.len() >= HASH_SUFFIX_LEN {
        let at = bytes.len() - HASH_SUFFIX_LEN;
        if bytes[at] == b'_' && bytes[at + 1..].iter().all(u8::is_ascii_hexdigit) {
            return (&name[..at], Some(name[at + 1..].to_ascii_uppercase()));
        }
    }
    (name, None)
}

#[cfg(test)]
mod tests;
