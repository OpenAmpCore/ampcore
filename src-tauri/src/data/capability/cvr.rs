use serde::{Deserialize, Serialize};
use specta::Type;

use super::super::amp_model::{AmpDspTopology, AmpModelCatalogEntry, SourceChannelCount};
use super::{AmpCapability, ParamRange, PowerMode, SourceKind};

/// Fixed EQ structure on every CVR channel, both directions (input/output):
/// band 0 = HP crossover, bands 1-8 = parametric, band 9 = LP crossover.
/// Ported from the old app's fixed 10-band layout.
const EQ_BANDS_PER_CHANNEL: u32 = 10;

/// V_num threshold for speaker management + FIR filters (current baseline).
pub const VNUM_118: u32 = 118;
/// V_num threshold for noise gate thresholds and extended delay.
pub const VNUM_119: u32 = 119;

/// Numeric firmware "generation" (vNum) and the feature deltas it gates —
/// ported from the old app's `lib/amp-version.ts`. Computed fresh from a
/// firmware version string every time; never persisted independently.
///
/// Deliberately has no trim/volume split flag: that file's comment claims a
/// "split trim/volume" arrives at 119, but output Volume (FC=9 flag 0) and
/// Trim (FC=9 flag 1) are both real, separate controls on 1.1.8 and 1.1.9
/// alike — the old app's own dashboard always showed both.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CvrFirmwareCapability {
    pub v_num: Option<u32>,
    pub speaker_management: bool,
    pub fir_filters: bool,
    pub noise_gate_threshold: bool,
    pub extended_delay: bool,
}

impl CvrFirmwareCapability {
    pub fn from_version(version_string: Option<&str>) -> Self {
        let v_num = version_string.and_then(extract_vnum);
        let at_least = |min: u32| v_num.map(|v| v >= min).unwrap_or(false);
        Self {
            v_num,
            speaker_management: at_least(VNUM_118),
            fir_filters: at_least(VNUM_118),
            noise_gate_threshold: at_least(VNUM_119),
            extended_delay: at_least(VNUM_119),
        }
    }
}

/// Extracts a numeric firmware "generation" (vNum) from a version string.
/// Handles two input shapes:
///   - a user-picked dotted string from offline planning, e.g. "1.1.9" -> 119
///     (single-digit major.minor.patch components — the only shape
///     `firmwareOptions.ts` produces today).
///   - the raw wire/machine-name string a live device reports, e.g.
///     "42404B06-006118-DSP-2004" -> 118 (last 3 digits of the first 6+-digit
///     run). Ported from the old app's `extractVNum` so the future live
///     driver can reuse this exact function once it starts passing real
///     device strings — do not duplicate this parsing there.
pub fn extract_vnum(version_string: &str) -> Option<u32> {
    parse_dotted(version_string).or_else(|| parse_wire_run(version_string))
}

fn parse_dotted(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.trim().split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut digits = String::with_capacity(3);
    for part in parts {
        if part.len() != 1 || !part.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        digits.push_str(part);
    }
    digits.parse().ok()
}

/// Finds runs of 6+ consecutive digits (the zero-padded version block —
/// shorter runs are model/serial numbers, e.g. "42404" in
/// "42404B06-006118-DSP-2004") and returns the last 3 digits of the first
/// such run, if it forms a plausible version number (100..=999).
fn parse_wire_run(s: &str) -> Option<u32> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i - start >= 6 {
                if let Ok(n) = s[i - 3..i].parse::<u32>() {
                    if (100..=999).contains(&n) {
                        return Some(n);
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    None
}

/// Global CVR DSP parameter ranges/units — ported 1:1 from the old app's
/// `lib/constants.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpParamRanges {
    pub matrix_gain_db: ParamRange,
    pub output_trim_db: ParamRange,
    pub output_volume_db: ParamRange,
    pub delay_in_ms: ParamRange,
    pub delay_out_ms: ParamRange,
    pub crossover_freq_hz: ParamRange,
    pub eq_band_gain_db: ParamRange,
    pub eq_band_q: ParamRange,
    pub preset_slots: ParamRange,
    pub rms_limiter_threshold_vrms: ParamRange,
    pub rms_limiter_attack_ms: ParamRange,
    pub rms_limiter_release_multiplier: ParamRange,
    pub peak_limiter_threshold_vp: ParamRange,
    pub peak_limiter_hold_ms: ParamRange,
    pub peak_limiter_release_ms: ParamRange,
    pub noise_gate_threshold_dbu: ParamRange,
    /// Per-source input trim. The vendor allows a wider swing on a digital
    /// source than on analog, so these are two separate bounds rather than
    /// one shared with `output_trim_db`.
    pub source_trim_analog_db: ParamRange,
    pub source_trim_digital_db: ParamRange,
    /// Per-source input delay — distinct from `delay_in_ms`, which is the
    /// channel's own post-selection delay.
    pub source_delay_ms: ParamRange,
    /// Signal-loss threshold for backup/auto-source switching.
    pub backup_threshold_db: ParamRange,
    /// Max byte length for `AmpChannel.input_name`/`output_name` — a plain
    /// scalar, not a `ParamRange`, since it's a single bound, not a min/max.
    pub channel_name_max_length: u32,
}

/// Constant across the whole CVR product line today (the old app didn't vary
/// these per model/firmware either). Returned per-resolve rather than
/// exported as raw constants so a future per-model or per-vNum override
/// doesn't change `AmpCapability`'s shape.
pub fn cvr_param_ranges() -> AmpParamRanges {
    AmpParamRanges {
        matrix_gain_db: ParamRange {
            min: -80.0,
            max: 18.0,
        },
        output_trim_db: ParamRange {
            min: -18.0,
            max: 18.0,
        },
        output_volume_db: ParamRange {
            min: -80.0,
            max: 18.0,
        },
        delay_in_ms: ParamRange {
            min: 0.0,
            max: 100.0,
        },
        delay_out_ms: ParamRange {
            min: 0.0,
            max: 20.0,
        },
        crossover_freq_hz: ParamRange {
            min: 20.0,
            max: 20000.0,
        },
        eq_band_gain_db: ParamRange {
            min: -18.0,
            max: 18.0,
        },
        eq_band_q: ParamRange {
            min: 0.1,
            max: 32.0,
        },
        preset_slots: ParamRange {
            min: 1.0,
            max: 40.0,
        },
        rms_limiter_threshold_vrms: ParamRange {
            min: 1.0,
            max: 200.0,
        },
        rms_limiter_attack_ms: ParamRange {
            min: 0.0,
            max: 2000.0,
        },
        rms_limiter_release_multiplier: ParamRange {
            min: 1.0,
            max: 32.0,
        },
        // Max kept at >= 2x rms_limiter_threshold_vrms's max (400.0) so the
        // frontend's "peak threshold must be at least double the RMS
        // threshold" floor (LimiterEditor.tsx) stays reachable across the
        // whole RMS range, even for user-defined models with no per-model
        // rated RMS voltage to derive a tighter cap from.
        peak_limiter_threshold_vp: ParamRange {
            min: 1.4,
            max: 400.0,
        },
        peak_limiter_hold_ms: ParamRange {
            min: 0.0,
            max: 2000.0,
        },
        peak_limiter_release_ms: ParamRange {
            min: 0.0,
            max: 1000.0,
        },
        // Vendor `MyControls1\SoundSoure_All1.xaml`, which is authoritative
        // here: analog trim is +/-18 dB but a digital source gets -30..+21.
        // (The old web app's 0..18 for both is simply wrong — it cannot even
        // express the -12 dB its own screenshots show.)
        source_trim_analog_db: ParamRange {
            min: -18.0,
            max: 18.0,
        },
        source_trim_digital_db: ParamRange {
            min: -30.0,
            max: 21.0,
        },
        // The vendor XAML default. It narrows this to 10 ms for flows
        // D/E/VN117 and widens it to 200 ms for flow G, but the flow letter
        // comes from live BASIC_INFO and `resolve` only has the catalog model
        // plus a firmware string, so the per-flow override is not expressible
        // here yet — see this module's `builtin_topology` note about the same
        // gap for source availability.
        source_delay_ms: ParamRange {
            min: 0.0,
            max: 30.0,
        },
        backup_threshold_db: ParamRange {
            min: -80.0,
            max: 0.0,
        },
        noise_gate_threshold_dbu: ParamRange {
            min: -50.0,
            max: 20.0,
        },
        channel_name_max_length: 16,
    }
}

/// Per-model rated RMS voltage — ported from the old app's `lib/amp-model.ts`.
/// Proxy for electrical/gain limits; `None` for anything outside this 12-SKU
/// product line (e.g. user-defined models). Shared by both lookup styles
/// below rather than duplicated — a single source of truth for the datasheet
/// numbers.
const RATED_RMS_VOLTAGE_TABLE: &[(&str, f64)] = &[
    ("DSP-654", 72.1),
    ("DSP-802", 80.0),
    ("DSP-1002", 89.4),
    ("DSP-1004", 89.4),
    ("DSP-1502", 109.5),
    ("DSP-2002", 126.5),
    ("DSP-1504", 109.5),
    ("DSP-2004", 126.5),
    ("DSP-3002", 154.9),
    ("DSP-3004", 154.9),
    ("DSP-3302", 162.5),
    ("DSP-4302", 185.5),
];

/// Exact-match lookup keyed off a catalog entry's `model` field. Dante
/// variants share their base model's electrical rating, so the trailing "D"
/// is stripped before lookup.
fn rated_rms_voltage(model: &str) -> Option<f64> {
    let base = model.strip_suffix('D').unwrap_or(model);
    RATED_RMS_VOLTAGE_TABLE.iter().find(|(m, _)| *m == base).map(|(_, v)| *v)
}

/// Derives a rated RMS output voltage from a device's raw, factory-set
/// firmware version string (e.g. "42404B06-006118-DSP-2004") by matching the
/// known model designation embedded in it — ported from the old app's
/// `ratedRmsVFromDeviceName`, but matched against `firmware_version`
/// (`DiscoveredDevice.firmwareVersion`), not the user-editable device
/// *name*, since the reference app itself actually prioritizes matching the
/// firmware string first (`version ?? name`) — the firmware string is baked
/// in at the factory and can't be renamed, so a match here is real identity,
/// not a guess.
///
/// Unlike the reference implementation, this returns `None` (not a
/// default/average voltage like its `DEFAULT_RATED_RMS = 80.0` fallback)
/// when no known designation is found: a wrong-but-confident dB reading is
/// worse than an honestly missing one, and this app's whole telemetry
/// pipeline is built on that rule (see `live/dsp.rs`).
pub fn rated_rms_voltage_from_firmware_string(firmware_version: &str) -> Option<f64> {
    let upper = firmware_version.to_uppercase();
    RATED_RMS_VOLTAGE_TABLE.iter().find(|(m, _)| upper.contains(m)).map(|(_, v)| *v)
}

/// Builds the real per-model `AmpDspTopology` for a builtin CVR catalog entry
/// — called by `store.rs` at seed time, the single source of truth for
/// builtin topology data (avoids a third copy of this table alongside
/// `BUILTIN_AMP_MODELS` and the frontend's `ampSpecSheets.ts`).
///
/// Matrix input count is always `channel_count`, regardless of Dante — analog
/// vs. Dante is a per-channel Source Selection choice (`AmpChannel.source`),
/// not a doubling of the matrix's input columns. Each source kind offered
/// has `channel_count` physical inputs of its own (a 4-channel amp has 4
/// analog inputs *and*, if Dante-equipped, 4 Dante inputs — not a combined
/// pool), but only Analog is freely patchable to any digital input — Dante
/// channel N always feeds digital input N (see `SourceChannelCount`).
/// Backup source availability has no offline equivalent in this catalog yet
/// (the old app derived it from a live "line mode" digit) — deliberately not
/// fabricated here. Backup is offered on the strength of `is_dante` instead,
/// since a Dante-equipped amp always has a second source to fail over to.
pub fn builtin_topology(model: &str, channel_count: u32, is_dante: bool) -> AmpDspTopology {
    AmpDspTopology {
        matrix_input_count: channel_count,
        matrix_output_count: channel_count,
        eq_bands_per_channel: EQ_BANDS_PER_CHANNEL,
        source_counts: if is_dante {
            vec![
                SourceChannelCount {
                    kind: SourceKind::Analog,
                    channel_count,
                    patchable: true,
                },
                SourceChannelCount {
                    kind: SourceKind::Dante,
                    channel_count,
                    patchable: false,
                },
            ]
        } else {
            vec![SourceChannelCount {
                kind: SourceKind::Analog,
                channel_count,
                patchable: true,
            }]
        },
        power_modes: vec![PowerMode::LowOhm, PowerMode::V70, PowerMode::V100],
        rated_rms_voltage: rated_rms_voltage(model),
    }
}

pub fn resolve(model: &AmpModelCatalogEntry, firmware_version: Option<&str>) -> AmpCapability {
    AmpCapability {
        topology: model.topology.clone(),
        firmware: CvrFirmwareCapability::from_version(firmware_version),
        param_ranges: cvr_param_ranges(),
        eq_filter_capabilities: super::eq_filter_capabilities(),
    }
}
