//! CVR firmware 1.1.8 channel/machine state numbering.
//!
//! Ported from the vendor software's `Struct_test.cs` `Jiqizhuangtai` enum
//! (the ordinal is the wire value) cross-checked against its own UI label
//! table in `fromat_machineState.cs`, and against the prior web
//! implementation, which ported the same table verbatim as `AmpStore.ts`'s
//! `getOutputStateLabel`/`deriveChannelFlags`.
//!
//! Two entries have a vendor *identifier* that disagrees with the vendor's own
//! *displayed label*, and the label is what this app follows (it is what users
//! of the original software and the reference web app both see):
//!
//! - `3` is `Warning` in the enum but displayed "Open" -> `Open`
//! - `8` is `None` in the enum but displayed "Run" -> `Run`
//!
//! `-1` is not in the enum at all; it is the vendor label table's explicit
//! "Offline" sentinel, reachable here because the heartbeat's per-input state
//! block is read as *signed* bytes (see `telemetry_v118.rs`'s `read_sbytes`).

use super::channel_state::AmpChannelState;

/// Maps a raw wire state value to its meaning. Anything outside the known
/// table becomes `Unknown` rather than being clamped into a neighbouring
/// state — an unrecognized byte means this table is incomplete for the device
/// in hand, which should read as a gap, not as a plausible reading.
pub fn decode(raw: i32) -> AmpChannelState {
    match raw {
        -1 => AmpChannelState::Offline,
        0 => AmpChannelState::Normal,
        1 => AmpChannelState::Standby,
        2 => AmpChannelState::Fault,
        3 => AmpChannelState::Open,
        4 => AmpChannelState::Overload,
        5 => AmpChannelState::Clip,
        6 => AmpChannelState::Dcp,
        7 => AmpChannelState::PowerError,
        8 => AmpChannelState::Run,
        9 => AmpChannelState::Temp,
        10 => AmpChannelState::Limit,
        11 => AmpChannelState::Sleep,
        _ => AmpChannelState::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_table_boundaries_decode() {
        assert_eq!(decode(-1), AmpChannelState::Offline);
        assert_eq!(decode(0), AmpChannelState::Normal);
        assert_eq!(decode(1), AmpChannelState::Standby);
        assert_eq!(decode(5), AmpChannelState::Clip);
        assert_eq!(decode(10), AmpChannelState::Limit);
        assert_eq!(decode(11), AmpChannelState::Sleep);
    }

    /// `looks_like_state_block` in `telemetry_v118.rs` treats <=11 as a
    /// plausible state byte, so 12 is the first value that must not decode to
    /// anything real — and negatives past the -1 sentinel likewise.
    #[test]
    fn out_of_table_values_are_unknown() {
        assert_eq!(decode(12), AmpChannelState::Unknown);
        assert_eq!(decode(255), AmpChannelState::Unknown);
        assert_eq!(decode(-2), AmpChannelState::Unknown);
    }
}
