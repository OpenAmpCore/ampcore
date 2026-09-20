//! CVR firmware 1.1.9 FC=27 (SYNC_DATA) channel-config adapter.
//!
//! No 1.1.9 hardware or wire captures exist to verify against yet — the only
//! CVR unit available for this work runs 1.1.8. This is a deliberate,
//! explicit placeholder rather than gating 1.1.9 devices out entirely: it
//! reuses the 1.1.8 parser verbatim. It WILL silently produce wrong values
//! (or `None`, if the geometry check fails) on real 1.1.9 hardware if the
//! layout has actually diverged there.
//!
//! The reference implementation guesses a 1.1.9 layout — a 192-byte
//! standard trailer plus a 455-byte extension (4 signed-byte noise-gate
//! thresholds + 451 reserved bytes) — purely from whether that arithmetic
//! happens to divide payload length evenly, never cross-checked against a
//! device's actual known firmware version. That guess is exactly the kind of
//! unverified-data-presented-as-real this session has been steering away
//! from, so it is deliberately NOT ported here. The 119-only noise-gate
//! thresholds are the known first candidate divergence to implement for
//! real once genuine 1.1.9 hardware exists to ground-truth against — same
//! process `channel_config_v118.rs` went through for 1.1.8.
//!
//! Replace this function's body with a real 1.1.9-specific implementation
//! once that hardware/data exists — this file stays separate from
//! `channel_config_v118.rs` (not just a re-export) so that divergence is a
//! one-file change, not a refactor that risks the already-verified 1.1.8
//! path.

use super::channel_config::ChannelConfigSnapshot;

pub fn parse_channel_config(body: &[u8]) -> Option<ChannelConfigSnapshot> {
    super::channel_config_v118::parse_channel_config(body)
}
