//! Magnitude response of a channel's 10-stage EQ chain (HP -> 8 bands -> LP),
//! for drawing the EQ graph. Lives in core so desktop and mobile draw the same
//! curve from one implementation. Rendering only: nothing here is sent to the
//! amp, and the sample rate only affects the digital-biquad math of the plot.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::capability::{CrossoverFilterType, EqFilterType};
use super::project::{ChannelEq, CrossoverSlot, EqBand};

const SAMPLE_RATE_HZ: f64 = 48000.0;
/// Fixed Q for a 2nd-order Butterworth stage (maximally flat passband).
const BUTTERWORTH_2ND_ORDER_Q: f64 = std::f64::consts::FRAC_1_SQRT_2;
/// Fixed Q for a 2nd-order Bessel stage (maximally flat group delay).
const BESSEL_2ND_ORDER_Q: f64 = 0.5773502691896258;
/// 800 points so a 48 dB/oct slope (under an octave wide) still renders as a
/// crisp curve instead of visible straight segments.
pub const DEFAULT_CURVE_POINTS: u32 = 800;

#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResponsePoint {
    pub freq_hz: f64,
    pub db: f64,
}

/// One of the 10 chain stages: the HP/LP crossover slot or a parametric band
/// by its index into `ChannelEq.bands` (the same index `set_eq_band` takes).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EqStageRef {
    Hp,
    Lp,
    Band {
        #[serde(rename = "bandIndex")]
        band_index: u32,
    },
}

struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a0: f64,
    a1: f64,
    a2: f64,
}

fn w0_alpha(freq_hz: f64, q: f64) -> (f64, f64) {
    let w0 = 2.0 * std::f64::consts::PI * freq_hz / SAMPLE_RATE_HZ;
    (w0.cos(), w0.sin() / (2.0 * q))
}

/// RBJ "Audio EQ Cookbook" 2nd-order low-pass.
fn lpf(freq_hz: f64, q: f64) -> Biquad {
    let (c, alpha) = w0_alpha(freq_hz, q);
    Biquad { b0: (1.0 - c) / 2.0, b1: 1.0 - c, b2: (1.0 - c) / 2.0, a0: 1.0 + alpha, a1: -2.0 * c, a2: 1.0 - alpha }
}

/// RBJ 2nd-order high-pass.
fn hpf(freq_hz: f64, q: f64) -> Biquad {
    let (c, alpha) = w0_alpha(freq_hz, q);
    Biquad { b0: (1.0 + c) / 2.0, b1: -(1.0 + c), b2: (1.0 + c) / 2.0, a0: 1.0 + alpha, a1: -2.0 * c, a2: 1.0 - alpha }
}

/// RBJ peaking EQ.
fn peaking(freq_hz: f64, gain_db: f64, q: f64) -> Biquad {
    let (c, alpha) = w0_alpha(freq_hz, q);
    let a = 10f64.powf(gain_db / 40.0);
    Biquad { b0: 1.0 + alpha * a, b1: -2.0 * c, b2: 1.0 - alpha * a, a0: 1.0 + alpha / a, a1: -2.0 * c, a2: 1.0 - alpha / a }
}

/// RBJ shelves, Q-parameterized (alpha = sin(w0)/(2Q), valid when Q is given
/// instead of the shelf slope S).
fn low_shelf(freq_hz: f64, gain_db: f64, q: f64) -> Biquad {
    let (c, alpha) = w0_alpha(freq_hz, q);
    let a = 10f64.powf(gain_db / 40.0);
    let k = 2.0 * a.sqrt() * alpha;
    Biquad {
        b0: a * (a + 1.0 - (a - 1.0) * c + k),
        b1: 2.0 * a * (a - 1.0 - (a + 1.0) * c),
        b2: a * (a + 1.0 - (a - 1.0) * c - k),
        a0: a + 1.0 + (a - 1.0) * c + k,
        a1: -2.0 * (a - 1.0 + (a + 1.0) * c),
        a2: a + 1.0 + (a - 1.0) * c - k,
    }
}
fn high_shelf(freq_hz: f64, gain_db: f64, q: f64) -> Biquad {
    let (c, alpha) = w0_alpha(freq_hz, q);
    let a = 10f64.powf(gain_db / 40.0);
    let k = 2.0 * a.sqrt() * alpha;
    Biquad {
        b0: a * (a + 1.0 + (a - 1.0) * c + k),
        b1: -2.0 * a * (a - 1.0 + (a + 1.0) * c),
        b2: a * (a + 1.0 + (a - 1.0) * c - k),
        a0: a + 1.0 - (a - 1.0) * c + k,
        a1: 2.0 * (a - 1.0 - (a + 1.0) * c),
        a2: a + 1.0 - (a - 1.0) * c - k,
    }
}

/// |H(e^jw)| in dB, evaluated on the unit circle. No a0 normalization needed:
/// num and den share the same scale, so the ratio is invariant to it.
fn biquad_db(f: &Biquad, freq_hz: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * freq_hz / SAMPLE_RATE_HZ;
    let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
    let num = (f.b0 + f.b1 * c1 + f.b2 * c2).hypot(-f.b1 * s1 - f.b2 * s2);
    let den = (f.a0 + f.a1 * c1 + f.a2 * c2).hypot(-f.a1 * s1 - f.a2 * s2);
    20.0 * (num / den).log10()
}

/// Analog 1st-order (6 dB/oct) magnitude: close enough to the digital one at
/// these orders for graphing. Only `butterworth18` uses it.
fn first_order_db(hp: bool, cutoff_hz: f64, freq_hz: f64) -> f64 {
    let r = freq_hz / cutoff_hz;
    let lp = -10.0 * (1.0 + r * r).log10();
    if hp { 20.0 * r.log10() + lp } else { lp }
}

/// `None` = a 1st-order stage, `Some(q)` = a 2nd-order stage.
type Stage = Option<f64>;

/// Butterworth pole-pair Qs: Q_k = 1 / (2cos((2k-1)pi / 2N)). Order 3 is one
/// real pole + one Q=1 stage.
fn butterworth(order: u32) -> Vec<Stage> {
    match order {
        1 => vec![None],
        3 => vec![None, Some(1.0)],
        n => (1..=n / 2)
            .map(|k| Some(1.0 / (2.0 * ((2 * k - 1) as f64 * std::f64::consts::PI / (2 * n) as f64).cos())))
            .collect(),
    }
}

/// Commonly published per-stage Bessel Qs (references normalize slightly
/// differently; worth a second look if a crossover shape looks off).
fn bessel(order: u32) -> Vec<Stage> {
    let qs: &[f64] = match order {
        2 => &[0.5773],
        4 => &[0.5219, 0.8055],
        _ => &[0.506, 0.5596, 0.7109, 1.2258],
    };
    qs.iter().map(|&q| Some(q)).collect()
}

/// LR-N = two cascaded Butterworths of half the order.
fn linkwitz_riley(order: u32) -> Vec<Stage> {
    let half = butterworth(order / 2);
    half.iter().chain(half.iter()).copied().collect()
}

fn crossover_stages(t: CrossoverFilterType) -> Vec<Stage> {
    use CrossoverFilterType::*;
    match t {
        Butterworth12 => butterworth(2),
        Butterworth18 => butterworth(3),
        Butterworth24 => butterworth(4),
        Butterworth36 => butterworth(6),
        Butterworth48 => butterworth(8),
        Bessel12 => bessel(2),
        Bessel24 => bessel(4),
        Bessel48 => bessel(8),
        LinkwitzRiley12 => linkwitz_riley(2),
        LinkwitzRiley24 => linkwitz_riley(4),
        LinkwitzRiley48 => linkwitz_riley(8),
    }
}

/// One HP/LP slot; a bypassed slot is 0 dB. Q is implied by the filter type,
/// never user-set.
fn crossover_db(slot: &CrossoverSlot, hp: bool, freq_hz: f64) -> f64 {
    if !slot.active {
        return 0.0;
    }
    crossover_stages(slot.filter_type)
        .into_iter()
        .map(|stage| match stage {
            None => first_order_db(hp, slot.freq_hz, freq_hz),
            Some(q) => biquad_db(&if hp { hpf(slot.freq_hz, q) } else { lpf(slot.freq_hz, q) }, freq_hz),
        })
        .sum()
}

/// One parametric band; inactive bands and all-passes are 0 dB.
fn band_db(b: &EqBand, freq_hz: f64) -> f64 {
    use EqFilterType::*;
    if !b.active {
        return 0.0;
    }
    let f = match b.filter_type {
        Peaking => peaking(b.freq_hz, b.gain_db, b.q),
        LowShelf => low_shelf(b.freq_hz, b.gain_db, b.q),
        HighShelf => high_shelf(b.freq_hz, b.gain_db, b.q),
        AllPass1st | AllPass2nd => return 0.0,
        GeneralLow => lpf(b.freq_hz, b.q),
        GeneralHigh => hpf(b.freq_hz, b.q),
        ButterworthLow => lpf(b.freq_hz, BUTTERWORTH_2ND_ORDER_Q),
        ButterworthHigh => hpf(b.freq_hz, BUTTERWORTH_2ND_ORDER_Q),
        BesselLow => lpf(b.freq_hz, BESSEL_2ND_ORDER_Q),
        BesselHigh => hpf(b.freq_hz, BESSEL_2ND_ORDER_Q),
    };
    biquad_db(&f, freq_hz)
}

/// Whole chain at `freq_hz`. Exact: a series cascade multiplies linear
/// magnitudes, which is summing dB.
pub fn composite_db(eq: &ChannelEq, freq_hz: f64) -> f64 {
    crossover_db(&eq.hp, true, freq_hz) + eq.bands.iter().map(|b| band_db(b, freq_hz)).sum::<f64>() + crossover_db(&eq.lp, false, freq_hz)
}

/// `points` log-spaced samples over 20 Hz-20 kHz. `stage: None` is the whole
/// chain; `Some` isolates one stage (the graph's "what is this band doing"
/// overlay). A band index past the end is flat.
pub fn response_curve(eq: &ChannelEq, stage: Option<EqStageRef>, points: u32) -> Vec<ResponsePoint> {
    let n = points.max(2);
    let (lo, hi) = (20f64.log10(), 20000f64.log10());
    (0..n)
        .map(|i| {
            let freq_hz = 10f64.powf(lo + (hi - lo) * i as f64 / (n - 1) as f64);
            let db = match stage {
                None => composite_db(eq, freq_hz),
                Some(EqStageRef::Hp) => crossover_db(&eq.hp, true, freq_hz),
                Some(EqStageRef::Lp) => crossover_db(&eq.lp, false, freq_hz),
                Some(EqStageRef::Band { band_index }) => eq.bands.get(band_index as usize).map_or(0.0, |b| band_db(b, freq_hz)),
            };
            ResponsePoint { freq_hz, db }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(filter_type: CrossoverFilterType, freq_hz: f64, active: bool) -> CrossoverSlot {
        CrossoverSlot { filter_type, freq_hz, active }
    }
    fn flat() -> ChannelEq {
        let band = EqBand { filter_type: EqFilterType::Peaking, freq_hz: 1000.0, gain_db: 6.0, q: 1.0, active: false };
        ChannelEq { hp: slot(CrossoverFilterType::Butterworth12, 20.0, false), bands: vec![band; 8], lp: slot(CrossoverFilterType::Butterworth12, 20000.0, false) }
    }
    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.05
    }

    #[test]
    fn flat_chain_is_zero_everywhere() {
        assert!(response_curve(&flat(), None, 50).iter().all(|p| p.db == 0.0));
    }

    #[test]
    fn peaking_band_reads_its_gain_at_center() {
        let mut eq = flat();
        eq.bands[2].active = true;
        assert!(close(composite_db(&eq, 1000.0), 6.0));
        // Isolating another band stays flat.
        assert!(response_curve(&eq, Some(EqStageRef::Band { band_index: 0 }), 10).iter().all(|p| p.db == 0.0));
    }

    #[test]
    fn crossover_slopes_at_cutoff() {
        let mut eq = flat();
        eq.lp = slot(CrossoverFilterType::Butterworth12, 1000.0, true);
        assert!(close(composite_db(&eq, 1000.0), -3.01));
        eq.lp = slot(CrossoverFilterType::LinkwitzRiley24, 1000.0, true);
        assert!(close(composite_db(&eq, 1000.0), -6.02));
        eq.lp.active = false;
        eq.hp = slot(CrossoverFilterType::LinkwitzRiley24, 1000.0, true);
        assert!(close(composite_db(&eq, 1000.0), -6.02));
    }
}
