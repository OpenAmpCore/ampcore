//! Brand/protocol-agnostic signal-math helpers. Lives directly under `live/`
//! (not `live/cvr/`) since none of this math is CVR-specific — any future
//! protocol driver's telemetry adapter can reuse it.

/// Converts a linear voltage reading into a dB figure relative to a full-
/// scale reference: `0dB` at `max_voltage` (the reference/maximum output
/// level), negative below it, positive above it. `gain` is a linear
/// multiplier applied to `voltage` before the ratio is taken — pass `1.0`
/// when the measured voltage already is the value you want to reference
/// against `max_voltage`; use it only when a known, real fixed gain sits
/// between the raw reading and that value.
///
/// Returns `None` when the result would be undefined — non-positive
/// effective voltage (no signal) or non-positive `max_voltage`. Callers must
/// not substitute a floor/placeholder for `None`, and must not pass a
/// guessed/approximate `max_voltage` just to get a number on screen —
/// displaying a figure with no real reference behind it is worse than
/// displaying nothing.
pub fn voltage_to_db(voltage: f32, gain: f32, max_voltage: f32) -> Option<f32> {
    if max_voltage <= 0.0 {
        return None;
    }
    let effective = voltage * gain;
    if effective <= 0.0 {
        return None;
    }
    Some(20.0 * (effective / max_voltage).log10())
}
