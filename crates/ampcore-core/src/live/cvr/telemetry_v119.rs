//! CVR firmware 1.1.9 heartbeat telemetry adapter.
//!
//! No 1.1.9 hardware or wire captures exist to verify against yet — the only
//! CVR unit available for this work runs 1.1.8. `protocol.rs`'s module doc
//! already flags that 1.1.9 is known to differ from 1.1.8 in byte offsets
//! and function codes for at least some commands, so this is a deliberate,
//! explicit placeholder rather than gating 1.1.9 devices out entirely: it
//! reuses the 1.1.8 parser verbatim. It WILL silently produce wrong values
//! on real 1.1.9 hardware if the layout has actually diverged there.
//!
//! Replace this function's body with a real 1.1.9-specific implementation
//! (its own body-length table, its own field offsets) once real 1.1.9
//! heartbeat traffic can be captured and ground-truthed, the same way
//! `telemetry_v118.rs` was. Keeping this as its own file rather than an
//! alias/re-export means that future divergence is a one-file change, not a
//! refactor that risks the already-verified 1.1.8 path.

use super::telemetry::Telemetry;

pub fn parse_heartbeat_telemetry(raw: &[u8]) -> Option<Telemetry> {
    super::telemetry_v118::parse_heartbeat_telemetry(raw)
}
