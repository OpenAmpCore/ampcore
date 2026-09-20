//! Shared telemetry adapter surface — the `Telemetry` struct every
//! firmware-specific adapter parses a heartbeat reply into, plus the single
//! dispatch point that picks which adapter handles a given device based on
//! its `firmware_family` (detected once at discovery time from the BASIC_INFO
//! reply, see `protocol.rs`'s `detect_firmware_family`).
//!
//! Each firmware family gets its own file (`telemetry_v118.rs`,
//! `telemetry_v119.rs`) rather than one parser branching internally on
//! version, so a firmware's wire format can diverge — or get corrected once
//! real hardware is available to verify against — without touching another
//! firmware's already-ground-truthed code path.

use serde::Serialize;
use specta::Type;

use super::channel_state::AmpChannelState;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Telemetry {
    /// 5 readings: [0-3] = per-channel, [4] = PSU.
    pub temperatures: Vec<f32>,
    pub output_voltages: Vec<f32>,
    pub output_currents: Vec<f32>,
    pub output_impedance: Vec<f32>,
    /// dB relative to the device's rated RMS output voltage (`0dB` = rated
    /// max output) — `None` per-channel until `driver.rs` fills it in, since
    /// the wire-format adapters (`telemetry_v118`/`telemetry_v119`) only see
    /// raw packet bytes, not the device's firmware-version string needed to
    /// look up a real reference voltage (see
    /// `capability::cvr::rated_rms_voltage_from_firmware_string`). Stays
    /// `None` entirely for a model this app doesn't recognize — never a
    /// guessed/default reference.
    pub output_level_db: Vec<Option<f32>>,
    /// The real reference voltage `output_level_db` was computed against
    /// (`0dB` = this voltage) — device-wide, not per-channel. Exposed
    /// alongside `output_level_db` so the frontend can scale a meter against
    /// the *real* rated voltage instead of an approximate/generic constant.
    /// `None` under the same conditions as `output_level_db`.
    pub rated_rms_voltage: Option<f64>,
    /// Raw per-output state bytes, straight off the wire — kept alongside the
    /// decoded `output_channel_states` for wire debugging and because the
    /// decode needs a firmware family this adapter never sees.
    pub output_states: Vec<u32>,
    pub input_voltages: Vec<f32>,
    pub input_dbfs: Vec<Option<f32>>,
    pub limiters: Vec<f32>,
    /// Raw per-input `InStates` bytes — signed, as the vendor struct declares
    /// them. NOT the same enum as `output_states`: see `input_clipping`.
    /// Empty on the body lengths that don't carry the field at all.
    pub input_states: Vec<i32>,
    /// `output_states` decoded to meanings, one entry per raw entry so a
    /// short packet stays distinguishable from a full one. Every element is
    /// `None` until `driver.rs` fills it in (and stays `None` for a firmware
    /// family with no state table), for the same reason `output_level_db`
    /// does: the wire adapters only see raw bytes, never the device's
    /// firmware family.
    pub output_channel_states: Vec<Option<AmpChannelState>>,
    /// Per-input clip flag, decoded from `input_states`. The vendor's
    /// heartbeat struct calls this field `InStates: sbyte[4]` and gives it its
    /// own two-value enum, `Struct_test.InputChState { Clip = 0, None = 1 }` —
    /// it is emphatically *not* the 12-value `Jiqizhuangtai` the output states
    /// use, so there is no such thing as a per-input operating state.
    ///
    /// The two references disagree on what the byte means and both can't be
    /// right: the vendor enum names `0` "Clip" and the vendor UI lights a
    /// yellow LED when it reads 0, while the prior web implementation reads
    /// the same `0` as "signal present" and shows green. This follows the
    /// vendor. `input_states` stays exposed raw so a check against real
    /// hardware can settle it without a rebuild.
    ///
    /// Element is `None` for a byte outside the known 0/1 set; the whole vec
    /// is empty when the packet doesn't carry the field.
    pub input_clipping: Vec<Option<bool>>,
    /// `machine_mode` decoded to a meaning — the amp-level state, and what the
    /// reference web app drives its standby indicator from. Same fill-in and
    /// `None` rules as `output_channel_states`.
    pub machine_state_decoded: Option<AmpChannelState>,
    /// `None` on the (common) heartbeat body lengths that don't include this
    /// trailing field at all — only the 96-byte `WHOLE118_PLUS` variant
    /// carries it. Was previously a bare `f32` that silently defaulted to
    /// `0.0` on every shorter body, i.e. real-looking fake data for any
    /// device that isn't actually sending the 96-byte variant.
    pub fan_voltage: Option<f32>,
    pub machine_mode: i32,
    pub received_at: f64,
}

/// Routes a heartbeat reply to the adapter for `firmware_family` (as set on
/// `DiscoveredDevice.firmware_family` at discovery time). A family this
/// dispatch doesn't recognize (`None`/unknown) gets no telemetry at all —
/// there is deliberately no generic fallback parser, since guessing wrong
/// would silently produce plausible-looking garbage instead of an honest gap.
pub fn parse_heartbeat_telemetry(firmware_family: Option<&str>, raw: &[u8]) -> Option<Telemetry> {
    match firmware_family {
        Some("1.1.8") => super::telemetry_v118::parse_heartbeat_telemetry(raw),
        Some("1.1.9") => super::telemetry_v119::parse_heartbeat_telemetry(raw),
        _ => None,
    }
}
