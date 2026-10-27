//! Bounds every stored or sent value has to respect — one set of checks
//! shared by the project setters, paste, push and the live write commands
//! (desktop and mobile), so what an editor offers and what the backend
//! accepts can't drift apart. The ranges themselves are
//! `capability::cvr::cvr_param_ranges`; a channel's limiter ceiling is
//! `limiter_ceiling`. Speaker fitting clamps into the same ranges instead of
//! refusing (see `speaker.rs`).
//!
//! Errors are sentences for the user: they surface as the failure toast.

use std::f64::consts::SQRT_2;

use super::amp_push::PushAction;
use super::capability::cvr::AmpParamRanges;
use super::capability::{EqFilterType, ParamRange, SourceKind};
use super::fingerprint::output_letter;
use super::project::{ChannelEq, CrossoverSlot, EqBand, EqBandPatch, EqDirection, Limiter, LimiterPatch};

/// Slack for a value that went through f32 on the wire, so a boundary value
/// read back as 19.999999 isn't refused.
const EPSILON: f64 = 1e-4;

/// `value` finite and within `range`. `unit` is appended to the numbers in
/// the message (" ms", " dB", "" for Q).
pub fn check_range(label: &str, unit: &str, value: f64, range: ParamRange) -> Result<(), String> {
    if !value.is_finite() {
        return Err(format!("{label} must be a number"));
    }
    if value < range.min - EPSILON || value > range.max + EPSILON {
        return Err(format!("{label} {value}{unit} is outside {}–{}{unit}", range.min, range.max));
    }
    Ok(())
}

/// `check_range` for a field the wire carries as an integer, where a fraction
/// would be truncated on the way out.
pub fn check_whole(label: &str, unit: &str, value: f64, range: ParamRange) -> Result<(), String> {
    check_range(label, unit, value, range)?;
    if value.fract().abs() > EPSILON {
        return Err(format!("{label} must be a whole number, not {value}{unit}"));
    }
    Ok(())
}

/// The Q range a band of `filter_type` accepts — shelves narrower than the
/// rest (`EqFilterType::q_range`).
pub fn eq_q_range(filter_type: EqFilterType, ranges: &AmpParamRanges) -> ParamRange {
    filter_type.q_range().unwrap_or(ranges.eq_band_q)
}

/// The fields one band edit sets, against the band as it will be once the
/// edit lands (`merged`), since Q's range depends on the filter type. A type
/// change is refused when the band's existing Q doesn't fit the new type —
/// the editor sends a fitted Q along with it.
pub fn check_eq_band_patch(label: &str, patch: &EqBandPatch, merged: &EqBand, ranges: &AmpParamRanges) -> Result<(), String> {
    if let Some(freq_hz) = patch.freq_hz {
        check_range(&format!("{label} frequency"), " Hz", freq_hz, ranges.crossover_freq_hz)?;
    }
    if let Some(gain_db) = patch.gain_db {
        check_range(&format!("{label} gain"), " dB", gain_db, ranges.eq_band_gain_db)?;
    }
    let q_range = eq_q_range(merged.filter_type, ranges);
    if let Some(q) = patch.q {
        check_range(&format!("{label} Q"), "", q, q_range)?;
    } else if patch.filter_type.is_some() && merged.filter_type.capabilities().supports_q {
        check_range(&format!("{label} Q"), "", merged.q, q_range)?;
    }
    Ok(())
}

pub fn check_crossover_freq(label: &str, freq_hz: f64, ranges: &AmpParamRanges) -> Result<(), String> {
    check_range(&format!("{label} frequency"), " Hz", freq_hz, ranges.crossover_freq_hz)
}

/// A whole chain as it would sound: bypassed stages are skipped, since their
/// values don't reach the audio and refusing one would block a paste or push
/// over a band nobody hears; gain and Q only where the filter type uses them.
pub fn check_eq_chain(label: &str, eq: &ChannelEq, ranges: &AmpParamRanges) -> Result<(), String> {
    for (name, slot) in [("HP", &eq.hp), ("LP", &eq.lp)] {
        check_crossover(&format!("{label} {name}"), slot, ranges)?;
    }
    for (i, band) in eq.bands.iter().enumerate() {
        check_eq_band(&format!("{label} band {}", i + 1), band, ranges)?;
    }
    Ok(())
}

fn check_crossover(label: &str, slot: &CrossoverSlot, ranges: &AmpParamRanges) -> Result<(), String> {
    if !slot.active {
        return Ok(());
    }
    check_crossover_freq(label, slot.freq_hz, ranges)
}

fn check_eq_band(label: &str, band: &EqBand, ranges: &AmpParamRanges) -> Result<(), String> {
    if !band.active {
        return Ok(());
    }
    check_range(&format!("{label} frequency"), " Hz", band.freq_hz, ranges.crossover_freq_hz)?;
    let caps = band.filter_type.capabilities();
    if caps.supports_gain {
        check_range(&format!("{label} gain"), " dB", band.gain_db, ranges.eq_band_gain_db)?;
    }
    if caps.supports_q {
        check_range(&format!("{label} Q"), "", band.q, eq_q_range(band.filter_type, ranges))?;
    }
    Ok(())
}

/// What one amp's values are checked against: its firmware's ranges and its
/// model's rated output voltage (`None` when unknown).
#[derive(Debug, Clone)]
pub struct AmpLimits {
    pub ranges: AmpParamRanges,
    pub rated_rms_voltage: Option<f64>,
}

impl AmpLimits {
    pub fn limiter_ceiling(&self, limiter: &Limiter) -> LimiterCeiling {
        limiter_ceiling(limiter, self.rated_rms_voltage, &self.ranges)
    }
}

/// The highest limiter thresholds one channel can take.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LimiterCeiling {
    pub rms_vrms: f64,
    pub peak_vp: f64,
}

/// `limiter`'s own reported maxima win — the 1.1.8 firmware clamps every
/// threshold to them before it reaches the DSP (static analysis of its image) —
/// then the model's rated voltage (×√2 for peak), then the generic range.
/// A reported 0 means "not reported", never a 0 V ceiling.
pub fn limiter_ceiling(limiter: &Limiter, rated_rms_voltage: Option<f64>, ranges: &AmpParamRanges) -> LimiterCeiling {
    let reported = |v: f64| (v.is_finite() && v > 0.0).then_some(v);
    LimiterCeiling {
        rms_vrms: reported(limiter.rms.max_vrms)
            .or(rated_rms_voltage)
            .unwrap_or(ranges.rms_limiter_threshold_vrms.max),
        peak_vp: reported(limiter.peak.max_vp)
            .or(rated_rms_voltage.map(|v| v * SQRT_2))
            .unwrap_or(ranges.peak_limiter_threshold_vp.max),
    }
}

pub fn rms_threshold_range(ceiling: LimiterCeiling, ranges: &AmpParamRanges) -> ParamRange {
    ParamRange { min: ranges.rms_limiter_threshold_vrms.min, max: ceiling.rms_vrms }
}

pub fn peak_threshold_range(ceiling: LimiterCeiling, ranges: &AmpParamRanges) -> ParamRange {
    ParamRange { min: ranges.peak_limiter_threshold_vp.min, max: ceiling.peak_vp }
}

/// The fields one limiter edit sets. Only those: a patch that just enables a
/// stage must still go through when the amp holds an older out-of-range
/// timing. The peak floor (`Vp >= √2 · Vrms`, which every limiter editor
/// keeps) is checked on `merged` whenever the patch moves a threshold.
pub fn check_limiter_patch(
    patch: &LimiterPatch,
    merged: &Limiter,
    ceiling: LimiterCeiling,
    ranges: &AmpParamRanges,
) -> Result<(), String> {
    if let Some(v) = patch.rms_threshold_vrms {
        check_range("RMS limiter threshold", " Vrms", v, rms_threshold_range(ceiling, ranges))?;
    }
    if let Some(v) = patch.rms_attack_ms {
        check_whole("RMS limiter attack", " ms", v, ranges.rms_limiter_attack_ms)?;
    }
    if let Some(v) = patch.rms_release_multiplier {
        check_whole("RMS limiter release", "×", v, ranges.rms_limiter_release_multiplier)?;
    }
    if let Some(v) = patch.peak_threshold_vp {
        check_range("Peak limiter threshold", " Vp", v, peak_threshold_range(ceiling, ranges))?;
    }
    if let Some(v) = patch.peak_hold_ms {
        check_whole("Peak limiter hold", " ms", v, ranges.peak_limiter_hold_ms)?;
    }
    if let Some(v) = patch.peak_release_ms {
        check_whole("Peak limiter release", " ms", v, ranges.peak_limiter_release_ms)?;
    }
    if patch.rms_threshold_vrms.is_some() || patch.peak_threshold_vp.is_some() {
        check_peak_floor(merged.rms.threshold_vrms, merged.peak.threshold_vp)?;
    }
    Ok(())
}

/// Both stages as a whole (paste). A disabled stage is skipped like a
/// bypassed EQ band.
pub fn check_limiter(limiter: &Limiter, ceiling: LimiterCeiling, ranges: &AmpParamRanges) -> Result<(), String> {
    let rms = &limiter.rms;
    if rms.enabled {
        check_rms_stage(rms.threshold_vrms, rms.attack_ms, rms.release_multiplier, ceiling, ranges)?;
    }
    let peak = &limiter.peak;
    if peak.enabled {
        check_peak_stage(peak.threshold_vp, peak.hold_ms, peak.release_ms, ceiling, ranges)?;
        check_peak_floor(rms.threshold_vrms, peak.threshold_vp)?;
    }
    Ok(())
}

fn check_rms_stage(threshold_vrms: f64, attack_ms: f64, release_multiplier: f64, ceiling: LimiterCeiling, ranges: &AmpParamRanges) -> Result<(), String> {
    check_range("RMS limiter threshold", " Vrms", threshold_vrms, rms_threshold_range(ceiling, ranges))?;
    check_whole("RMS limiter attack", " ms", attack_ms, ranges.rms_limiter_attack_ms)?;
    check_whole("RMS limiter release", "×", release_multiplier, ranges.rms_limiter_release_multiplier)
}

fn check_peak_stage(threshold_vp: f64, hold_ms: f64, release_ms: f64, ceiling: LimiterCeiling, ranges: &AmpParamRanges) -> Result<(), String> {
    check_range("Peak limiter threshold", " Vp", threshold_vp, peak_threshold_range(ceiling, ranges))?;
    check_whole("Peak limiter hold", " ms", hold_ms, ranges.peak_limiter_hold_ms)?;
    check_whole("Peak limiter release", " ms", release_ms, ranges.peak_limiter_release_ms)
}

fn check_peak_floor(threshold_vrms: f64, threshold_vp: f64) -> Result<(), String> {
    let floor = threshold_vrms * SQRT_2;
    // A hundredth of a volt: the editors round both thresholds to 0.01.
    if threshold_vp < floor - 0.01 {
        return Err(format!(
            "Peak limiter threshold {threshold_vp} Vp is below √2 × the RMS threshold ({:.2} Vp)",
            floor
        ));
    }
    Ok(())
}

/// The noise gate's threshold is a signed byte in whole dBu on the wire.
pub fn check_noise_gate_threshold(threshold_dbu: f64, ranges: &AmpParamRanges) -> Result<(), String> {
    check_whole("Noise gate threshold", " dBu", threshold_dbu, ranges.noise_gate_threshold_dbu)
}

/// Trim and delay for one source. Backup and AES3 have no trim slot here.
pub fn check_source_trim(kind: SourceKind, trim_db: f64, delay_ms: f64, ranges: &AmpParamRanges) -> Result<(), String> {
    let trim_range = match kind {
        SourceKind::Analog => ranges.source_trim_analog_db,
        SourceKind::Dante => ranges.source_trim_digital_db,
        SourceKind::Backup | SourceKind::Aes3 => {
            return Err(format!("{kind:?} has no trim of its own"));
        }
    };
    check_range(&format!("{kind:?} trim"), " dB", trim_db, trim_range)?;
    check_range(&format!("{kind:?} delay"), " ms", delay_ms, ranges.source_delay_ms)
}

/// One planned push or live-paste write. `ceiling` gives a channel's limiter
/// ceiling on the target amp. Values that don't reach the audio (a bypassed
/// band, a disabled stage, an inactive crosspoint) are skipped, as above.
pub fn check_push_action(
    action: &PushAction,
    ranges: &AmpParamRanges,
    ceiling: impl Fn(u8) -> LimiterCeiling,
) -> Result<(), String> {
    let input = |ch: u8| format!("In {}", u32::from(ch) + 1);
    let output = |ch: u8| format!("Out {}", output_letter(u32::from(ch)));
    match action {
        PushAction::DelayIn { channel, delay_ms } => {
            check_range(&format!("{} delay", input(*channel)), " ms", *delay_ms, ranges.delay_in_ms)
        }
        PushAction::SourceTrim { channel, family, trim_db, delay_ms } => {
            let kind = match family {
                super::amp_push::SourceTrimFamily::Analog => SourceKind::Analog,
                super::amp_push::SourceTrimFamily::Dante => SourceKind::Dante,
            };
            check_source_trim(kind, *trim_db, *delay_ms, ranges).map_err(|e| format!("{}: {e}", input(*channel)))
        }
        PushAction::EqChain { channel, direction, eq, .. } => {
            let side = match direction {
                EqDirection::Input => format!("{} EQ", input(*channel)),
                EqDirection::Output => format!("{} EQ", output(*channel)),
            };
            check_eq_chain(&side, eq, ranges)
        }
        PushAction::MatrixCrosspoint { channel, source_index, gain_db, active } if *active => check_range(
            &format!("{} matrix input {}", output(*channel), u32::from(*source_index) + 1),
            " dB",
            *gain_db,
            ranges.matrix_gain_db,
        ),
        PushAction::OutputTrim { channel, trim_db } => {
            check_range(&format!("{} trim", output(*channel)), " dB", *trim_db, ranges.output_trim_db)
        }
        PushAction::OutputVolume { channel, volume_db } => {
            check_range(&format!("{} volume", output(*channel)), " dB", *volume_db, ranges.output_volume_db)
        }
        PushAction::DelayOut { channel, delay_ms } => {
            check_range(&format!("{} delay", output(*channel)), " ms", *delay_ms, ranges.delay_out_ms)
        }
        PushAction::NoiseGate { channel, threshold_dbu, .. } => {
            check_noise_gate_threshold(f64::from(*threshold_dbu), ranges).map_err(|e| format!("{}: {e}", output(*channel)))
        }
        PushAction::RmsLimiter { channel, enabled: true, threshold_vrms, attack_ms, release_multiplier } => {
            check_rms_stage(*threshold_vrms, *attack_ms, *release_multiplier, ceiling(*channel), ranges)
                .map_err(|e| format!("{}: {e}", output(*channel)))
        }
        PushAction::PeakLimiter { channel, enabled: true, threshold_vp, hold_ms, release_ms } => {
            check_peak_stage(*threshold_vp, *hold_ms, *release_ms, ceiling(*channel), ranges)
                .map_err(|e| format!("{}: {e}", output(*channel)))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::capability::cvr::{cvr_param_ranges, CvrFirmwareCapability};
    use crate::data::project::{PeakLimiter, RmsLimiter};

    fn ranges() -> AmpParamRanges {
        cvr_param_ranges(&CvrFirmwareCapability::from_version(Some("1.1.8")))
    }

    fn limiter(max_vrms: f64, max_vp: f64) -> Limiter {
        Limiter {
            rms: RmsLimiter { enabled: true, threshold_vrms: 50.0, attack_ms: 5.0, release_multiplier: 4.0, auto: false, max_vrms },
            peak: PeakLimiter { enabled: true, threshold_vp: 80.0, hold_ms: 10.0, release_ms: 50.0, max_vp },
        }
    }

    fn patch() -> LimiterPatch {
        LimiterPatch {
            rms_enabled: None,
            rms_threshold_vrms: None,
            rms_attack_ms: None,
            rms_release_multiplier: None,
            peak_enabled: None,
            peak_threshold_vp: None,
            peak_hold_ms: None,
            peak_release_ms: None,
        }
    }

    /// Reported maxima beat the catalog; a 0 report falls through to it, and
    /// with neither the generic range applies.
    #[test]
    fn limiter_ceiling_prefers_the_amps_reported_maxima() {
        let r = ranges();
        assert_eq!(limiter_ceiling(&limiter(90.0, 130.0), Some(126.5), &r), LimiterCeiling { rms_vrms: 90.0, peak_vp: 130.0 });
        let catalog = limiter_ceiling(&limiter(0.0, 0.0), Some(72.1), &r);
        assert_eq!(catalog.rms_vrms, 72.1);
        assert!((catalog.peak_vp - 101.964_798).abs() < 1e-5);
        assert_eq!(limiter_ceiling(&limiter(0.0, 0.0), None, &r), LimiterCeiling { rms_vrms: 200.0, peak_vp: 400.0 });
    }

    /// The vendor's timing minimums, and integer wire fields.
    #[test]
    fn limiter_patch_refuses_values_the_vendor_controller_excludes() {
        let r = ranges();
        let merged = limiter(0.0, 0.0);
        let ceiling = limiter_ceiling(&merged, Some(126.5), &r);
        let check = |p: LimiterPatch| check_limiter_patch(&p, &merged, ceiling, &r);
        assert!(check(LimiterPatch { rms_attack_ms: Some(0.0), ..patch() }).is_err());
        assert!(check(LimiterPatch { rms_attack_ms: Some(1.0), ..patch() }).is_ok());
        assert!(check(LimiterPatch { rms_attack_ms: Some(2.5), ..patch() }).is_err());
        assert!(check(LimiterPatch { rms_release_multiplier: Some(1.0), ..patch() }).is_err());
        assert!(check(LimiterPatch { peak_release_ms: Some(10.0), ..patch() }).is_err());
        assert!(check(LimiterPatch { peak_release_ms: Some(1000.0), ..patch() }).is_ok());
        assert!(check(LimiterPatch { rms_threshold_vrms: Some(127.0), ..patch() }).is_err());
        // Only touched fields: enabling over an out-of-range stored attack goes through.
        let stale = Limiter { rms: RmsLimiter { attack_ms: 0.0, ..merged.rms }, ..merged };
        assert!(check_limiter_patch(&LimiterPatch { rms_enabled: Some(true), ..patch() }, &stale, ceiling, &r).is_ok());
    }

    #[test]
    fn peak_floor_is_checked_when_a_threshold_moves() {
        let r = ranges();
        let low_peak = Limiter { peak: PeakLimiter { threshold_vp: 60.0, ..limiter(0.0, 0.0).peak }, ..limiter(0.0, 0.0) };
        let ceiling = limiter_ceiling(&low_peak, None, &r);
        let moved = LimiterPatch { peak_threshold_vp: Some(60.0), ..patch() };
        assert!(check_limiter_patch(&moved, &low_peak, ceiling, &r).is_err());
        assert!(check_limiter_patch(&LimiterPatch { peak_hold_ms: Some(20.0), ..patch() }, &low_peak, ceiling, &r).is_ok());
    }

    /// Shelves take 0.25–1.25; a type change carries its Q check along.
    #[test]
    fn eq_q_follows_the_filter_type() {
        let r = ranges();
        let band = |filter_type, q| EqBand { filter_type, freq_hz: 1000.0, gain_db: 0.0, q, active: true };
        let q_patch = |q| EqBandPatch { filter_type: None, freq_hz: None, gain_db: None, q: Some(q), active: None };
        assert!(check_eq_band_patch("Band 1", &q_patch(2.0), &band(EqFilterType::LowShelf, 2.0), &r).is_err());
        assert!(check_eq_band_patch("Band 1", &q_patch(2.0), &band(EqFilterType::Peaking, 2.0), &r).is_ok());
        assert!(check_eq_band_patch("Band 1", &q_patch(0.01), &band(EqFilterType::Peaking, 0.01), &r).is_ok());
        assert!(check_eq_band_patch("Band 1", &q_patch(25.0), &band(EqFilterType::Peaking, 25.0), &r).is_err());
        let to_shelf = EqBandPatch { filter_type: Some(EqFilterType::HighShelf), freq_hz: None, gain_db: None, q: None, active: None };
        assert!(check_eq_band_patch("Band 1", &to_shelf, &band(EqFilterType::HighShelf, 4.0), &r).is_err());
        assert!(check_eq_band_patch("Band 1", &to_shelf, &band(EqFilterType::HighShelf, 1.0), &r).is_ok());
        let gain = EqBandPatch { filter_type: None, freq_hz: None, gain_db: Some(21.0), q: None, active: None };
        assert!(check_eq_band_patch("Band 1", &gain, &band(EqFilterType::Peaking, 1.0), &r).is_ok());
    }

    /// A bypassed band is skipped; an active one is checked.
    #[test]
    fn eq_chain_skips_what_does_not_sound() {
        let r = ranges();
        let mut eq = crate::data::project::AmpAssignment::new(None, None, 1, None, None).channels[0].output_eq.clone();
        eq.bands[0].q = 30.0;
        assert!(check_eq_chain("Out A EQ", &eq, &r).is_ok());
        eq.bands[0].active = true;
        assert!(check_eq_chain("Out A EQ", &eq, &r).is_err());
    }

    /// The comparison report's case: a new DSP-654 channel started at
    /// 100 Vrms / 140 Vp, above its 72.1 Vrms / 101.96 Vp ceiling, and 140 Vp
    /// also sat below the √2 × RMS floor. Defaults now sit on the floor, and
    /// fitting to the model caps both; a bigger model leaves them alone.
    #[test]
    fn new_channel_limiters_fit_the_model() {
        let r = ranges();
        let mut small = crate::data::project::AmpAssignment::new(None, None, 2, None, None);
        let fresh = small.channels[0].limiter;
        assert!(fresh.peak.threshold_vp >= fresh.rms.threshold_vrms * SQRT_2 - 1e-9);

        small.fit_limiters(Some(72.1), &r);
        let fitted = small.channels[0].limiter;
        assert_eq!(fitted.rms.threshold_vrms, 72.1);
        assert!((fitted.peak.threshold_vp - 72.1 * SQRT_2).abs() < 1e-9);
        let ceiling = limiter_ceiling(&fitted, Some(72.1), &r);
        assert!(check_limiter(&Limiter { rms: RmsLimiter { enabled: true, ..fitted.rms }, peak: PeakLimiter { enabled: true, ..fitted.peak } }, ceiling, &r).is_ok());

        let mut big = crate::data::project::AmpAssignment::new(None, None, 1, None, None);
        big.fit_limiters(Some(185.5), &r);
        assert_eq!(big.channels[0].limiter.rms.threshold_vrms, 100.0);
    }

    #[test]
    fn gate_threshold_is_whole_dbu() {
        let r = cvr_param_ranges(&CvrFirmwareCapability::from_version(Some("1.1.9")));
        assert!(check_noise_gate_threshold(-20.0, &r).is_ok());
        assert!(check_noise_gate_threshold(-20.5, &r).is_err());
        assert!(check_noise_gate_threshold(-51.0, &r).is_err());
    }
}
