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

/// Output RMS below this reads as "no signal": headroom is `None`, and the
/// firmware's gain-reduction figure (an after/before ratio, meaningless at the
/// noise floor) is ignored.
// ponytail: one fixed floor for every amp; make it a capability field if a
// model's idle noise sits above it.
pub const SIGNAL_FLOOR_V: f32 = 0.05;

/// ArmoníaPlus-style headroom of one output: dB to the nearest limiting stage.
/// Positive = room left before any limiter acts, negative = gain reduction
/// happening now. `None` = no signal, or no ceiling to measure against.
///
/// Ceilings: the enabled RMS threshold, the enabled peak threshold ÷ √2 (the
/// reading is RMS, so this is exact only for a sine), and the amp's rated RMS
/// voltage (its own clip). Brand-agnostic: any driver that knows output volts,
/// a gain-reduction figure and the channel's `Limiter` can fill it.
pub fn output_headroom_db(
    v_rms: f32,
    gain_reduction_db: f32,
    limiter: Option<&crate::data::project::Limiter>,
    rated_rms: Option<f64>,
) -> Option<f32> {
    if v_rms <= SIGNAL_FLOOR_V {
        return None;
    }
    let gr = gain_reduction_db.abs();
    if gr > 0.1 {
        return Some(-gr);
    }
    let ceilings = [
        limiter.filter(|l| l.rms.enabled).map(|l| l.rms.threshold_vrms),
        limiter.filter(|l| l.peak.enabled).map(|l| l.peak.threshold_vp / std::f64::consts::SQRT_2),
        rated_rms,
    ];
    let ceiling = ceilings.into_iter().flatten().filter(|&c| c > 0.0).fold(f64::INFINITY, f64::min);
    ceiling.is_finite().then(|| 20.0 * (ceiling as f32 / v_rms).log10())
}

#[cfg(test)]
mod headroom_tests {
    use super::*;
    use crate::data::project::{Limiter, PeakLimiter, RmsLimiter};

    fn lim(rms: Option<f64>, vp: Option<f64>) -> Limiter {
        Limiter {
            rms: RmsLimiter { enabled: rms.is_some(), threshold_vrms: rms.unwrap_or(100.0), attack_ms: 5.0, release_multiplier: 4.0, auto: false, max_vrms: 0.0 },
            peak: PeakLimiter { enabled: vp.is_some(), threshold_vp: vp.unwrap_or(141.0), hold_ms: 0.0, release_ms: 50.0, max_vp: 0.0 },
        }
    }

    fn close(a: Option<f32>, b: f32) -> bool {
        a.is_some_and(|a| (a - b).abs() < 0.01)
    }

    #[test]
    fn headroom() {
        // Limiting: gain reduction wins, as a negative figure.
        assert_eq!(output_headroom_db(20.0, 4.0, Some(&lim(Some(10.0), None)), Some(100.0)), Some(-4.0));
        // 10 V under a 20 Vrms threshold: 6.02 dB left.
        assert!(close(output_headroom_db(10.0, 0.0, Some(&lim(Some(20.0), None)), Some(100.0)), 6.02));
        // Peak 20 Vp (≈14.1 Vrms) is tighter than RMS 20 V.
        assert!(close(output_headroom_db(10.0, 0.0, Some(&lim(Some(20.0), Some(20.0))), None), 3.01));
        // No limiter stage on: the rated voltage is the ceiling.
        assert!(close(output_headroom_db(10.0, 0.0, Some(&lim(None, None)), Some(40.0)), 12.04));
        // Nothing to measure against.
        assert_eq!(output_headroom_db(10.0, 0.0, None, None), None);
        // Silence: no reading, even with a bogus gain-reduction figure.
        assert_eq!(output_headroom_db(0.0, 9.0, Some(&lim(Some(20.0), None)), Some(100.0)), None);
    }
}
