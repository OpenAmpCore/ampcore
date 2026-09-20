//! FC=50 (`BRIDGE`) — per-pair output bridging state.
//!
//! Bridging joins a pair of amplifier channels into one higher-power output.
//! The wire carries one byte per *pair*, not per channel: pair 0 is outputs
//! A/B, pair 1 is C/D.
//!
//! Read via its own query rather than out of FC=27. The vendor C# sync
//! structs (`Syncdata_44`, `SynData_DD`) do declare a `Bridge_data[2]` field,
//! which makes the trailer look like a free source for this — it is not, at
//! least not on the 1.1.8 hardware this app targets, where reading it there
//! produced wrong values. The prior web port reaches the same conclusion by
//! construction: its FC=27 parser never touches bridge state and it polls
//! FC=50 separately (`_pollBridgePairs`). Note that port's own trailer
//! comments mark the neighbouring `standby`/`rotary_lock` offsets as
//! "reverse-engineered from original C# sync structs" while only the
//! `mute_in` offset is "empirically confirmed" — so the whole
//! prefix-in-trailer idea rests on inference, and the bridge bytes are the
//! case where that inference is known to be wrong.
//!
//! Query: `status_code=2`, `chx` = pair index, empty body — built by
//! `RequestRegistry::register` from a `RequestSpec`, so there is no explicit
//! request builder here.

use super::protocol::{CHECKSUM_LEN, STRUCT_HEADER_LEN};
use serde::Serialize;
use specta::Type;

pub const FC_BRIDGE: u8 = 50;

/// How many bridgeable pairs this app ever queries. A 4-channel amp has two
/// (A/B and C/D); the vendor struct fixes the array at 2 for every model it
/// covers.
pub const BRIDGE_PAIR_COUNT: u8 = 2;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceBridgeSnapshot {
    /// Indexed by pair — `bridged[0]` is outputs A/B, `bridged[1]` is C/D.
    /// A pair the device has not answered for yet is `None` rather than
    /// `false`, so "not reported" never renders as a confident "not
    /// bridged".
    pub bridged: Vec<Option<bool>>,
    pub received_at: f64,
}

impl DeviceBridgeSnapshot {
    pub fn empty() -> Self {
        Self { bridged: vec![None; BRIDGE_PAIR_COUNT as usize], received_at: 0.0 }
    }
}

/// Parses a resolved FC=50 reply into `(pair_index, bridged)`.
///
/// The pair comes from the reply's own StructHeader `chx` rather than being
/// assumed from what was asked — the registry keys pending requests by
/// `(ip, function_code)` only, so a reply cannot otherwise be attributed to
/// the right pair with certainty.
///
/// Body is a single `Bridge_data.Bridge` byte, wire-inverted like MUTE:
/// `0` = bridged. Confirmed three ways — the vendor's receive handler
/// (`RD_All.setBridge`), its demo-data writer
/// (`bridges[i].Bridge = (bridgeOut ? 0 : 1)`), and the web port's readback
/// (`bridged: raw === 0`).
pub fn parse_bridge_reply(frame: &[u8]) -> Option<(u8, bool)> {
    if frame.len() < STRUCT_HEADER_LEN + CHECKSUM_LEN {
        return None;
    }
    let pair = frame[3];
    if pair >= BRIDGE_PAIR_COUNT {
        return None;
    }
    let body = &frame[STRUCT_HEADER_LEN..frame.len() - CHECKSUM_LEN];
    let raw = *body.first()?;
    Some((pair, raw == 0))
}
