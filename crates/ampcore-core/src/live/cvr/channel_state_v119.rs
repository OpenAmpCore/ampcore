//! CVR firmware 1.1.9 channel/machine state numbering.
//!
//! No 1.1.9 hardware or wire captures exist to verify against yet — the only
//! CVR unit available for this work runs 1.1.8 — so this reuses the 1.1.8
//! table verbatim, the same deliberate placeholder as `telemetry_v119.rs` and
//! `write_v119.rs`. It WILL report wrong states on real 1.1.9 hardware if the
//! numbering has actually diverged there.
//!
//! Replace this function's body with a real 1.1.9 table once 1.1.9 traffic can
//! be captured and ground-truthed. Keeping it as its own file rather than an
//! alias means that divergence stays a one-file change.

use super::channel_state::AmpChannelState;

pub fn decode(raw: i32) -> AmpChannelState {
    super::channel_state_v118::decode(raw)
}
