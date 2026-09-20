//! Shared channel/machine state surface — the decoded form of the raw state
//! bytes the FC=6 heartbeat carries per channel (`Telemetry.output_states`,
//! `input_states`), the raw `machine_mode` in every NetworkData header, and
//! FC=0 BASIC_INFO's `Machine_state`. All four are the same one-byte vendor
//! enum, so they all decode through here.
//!
//! Split into a shared enum plus per-firmware tables (`channel_state_v118.rs`,
//! `channel_state_v119.rs`) for the same reason `telemetry.rs` and `write.rs`
//! are: a firmware whose state numbering turns out to differ can be corrected
//! without touching another firmware's already-ground-truthed path.

use serde::Serialize;
use specta::Type;

/// One channel's (or the amp's) operating state, decoded from the vendor's
/// `Jiqizhuangtai` enum. See `channel_state_v118.rs` for the raw-value table
/// and the two places the vendor's own identifiers and UI labels disagree.
///
/// `Unknown` is a plain variant rather than `Unknown(u32)`: a tagged enum
/// makes an awkward TypeScript shape, and the raw values stay available on
/// `Telemetry.output_states`/`input_states`/`machine_mode` for wire debugging,
/// so carrying the byte twice buys nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AmpChannelState {
    Offline,
    Normal,
    Standby,
    Fault,
    Open,
    Overload,
    Clip,
    Dcp,
    PowerError,
    Run,
    Temp,
    Limit,
    Sleep,
    Unknown,
}

/// Routes a raw state value to the table for `firmware_family` (as set on
/// `DiscoveredDevice.firmware_family` at discovery time). A family this
/// dispatch doesn't recognize gets `None` — deliberately no generic fallback
/// table, matching `telemetry::parse_heartbeat_telemetry` and `write.rs`:
/// guessing a numbering would render confident, wrong state text (a faulted
/// amp reading "Normal") instead of an honest gap.
pub fn decode(firmware_family: Option<&str>, raw: i32) -> Option<AmpChannelState> {
    match firmware_family {
        Some("1.1.8") => Some(super::channel_state_v118::decode(raw)),
        Some("1.1.9") => Some(super::channel_state_v119::decode(raw)),
        _ => None,
    }
}

/// Decodes a whole array of raw per-channel state values, preserving length.
/// Every element is `None` for an unrecognized firmware family, so a caller
/// renders "unknown" per channel rather than dropping the array to empty and
/// losing which channels the packet actually covered.
pub fn decode_all(firmware_family: Option<&str>, raw: impl IntoIterator<Item = i32>) -> Vec<Option<AmpChannelState>> {
    raw.into_iter().map(|v| decode(firmware_family, v)).collect()
}
