//! Offline ← online merge: copies a linked network amp's settings into a
//! candidate copy of its project amp, so the two fingerprints match.
//!
//! The mapping is the inverse of `fingerprint.rs`'s `ChannelInput::from_live`
//! and shares its rounding (`round_to_step` and the `*_STEPS` constants), so
//! stored values are exactly what the hash sees: `56.99`, not the f32
//! readback `56.9900017`. The caller re-fingerprints the candidate and only
//! saves it when the amp hashes are equal — see
//! `commands/amp_links.rs::projects_merge_amp_from_live`.
//!
//! Deliberately not copied: `backup_priority` (read from an unverified offset
//! and not hashed — see the `fingerprint.rs` module doc), which keeps the
//! project's value. `noise_gate_threshold_dbu` is copied only where the amp
//! reports one (1.1.9+); on 1.1.8 the project keeps its own.

use serde::Serialize;
use specta::Type;

use super::edit_lock::LiveAmpReading;
use super::fingerprint::{
    canonical_input_name, canonical_output_name, round_to_step, split_hash_suffix, FingerprintRow, DELAY_STEPS,
    FREQ_STEPS, GAIN_STEPS, OHM_STEPS, Q_STEPS, VOLT_STEPS, WHOLE_STEPS,
};
use super::project::{
    AmpAssignment, AmpChannel, ChannelEq, ChannelFir, CrossoverSlot, EqBand, Limiter, MatrixCrosspoint, PeakLimiter, Project,
    RmsLimiter, SourceTrim, SourceTrims,
};
use crate::live::cvr::channel_config::ChannelConfig;

/// Outcome of `projects_merge_amp_from_live`. Flat rather than a tagged enum,
/// like `FingerprintOrigin`: `merged` says which fields are set.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpMergeResult {
    pub merged: bool,
    /// The saved project; `Some` only when `merged`.
    pub project: Option<Project>,
    /// The amp hash both sides now share; `Some` only when `merged`.
    pub amp_hash: Option<String>,
    /// Candidate-vs-online rows when the hashes still differed and nothing was
    /// saved; empty when `merged`.
    pub remaining: Vec<FingerprintRow>,
}

/// Returns `assignment` with every mirrored setting taken from `reading`; the
/// original is untouched. Channels are matched by `channel_index`; a channel
/// the snapshot lacks, or an unreadable source/power mode, keeps the project's
/// value (the merge command refuses before mirroring in those cases).
pub fn mirror_live_into_assignment(
    assignment: &AmpAssignment,
    reading: &LiveAmpReading,
    matrix_input_count: u32,
) -> AmpAssignment {
    let mut candidate = assignment.clone();
    let channel_count = candidate.channels.len() as u32;

    if let Some(snapshot) = &reading.snapshot {
        for channel in &mut candidate.channels {
            if let Some(config) = snapshot.channels.iter().find(|c| c.channel_index == channel.channel_index) {
                mirror_channel(channel, config, matrix_input_count);
            }
        }
    }
    // FIR comes from its own reads (FC=43), not from the snapshot. An output
    // not read yet keeps the project's; the merge command refuses before
    // mirroring in that case, as for any other unreadable input.
    for channel in &mut candidate.channels {
        if let Some(fir) = reading.fir.iter().find(|f| f.channel_index == channel.channel_index) {
            channel.fir = ChannelFir { name: fir.name.clone().unwrap_or_default(), coefficients: fir.coefficients.clone() };
        }
    }

    // Bridging is reported per pair and stored on the pair leader only — the
    // same place `fingerprint.rs` reads it back from.
    if let Some(bridge) = &reading.bridge {
        for channel in &mut candidate.channels {
            let leader = channel.channel_index;
            if leader % 2 != 0 || leader + 1 >= channel_count {
                continue;
            }
            if let Some(Some(bridged)) = bridge.bridged.get((leader / 2) as usize) {
                channel.output_bridged = *bridged;
            }
        }
    }

    let device_name = reading.device.name.trim();
    candidate.device_name = (!device_name.is_empty()).then(|| device_name.to_string());
    candidate
}

fn mirror_channel(channel: &mut AmpChannel, config: &ChannelConfig, matrix_input_count: u32) {
    let index = channel.channel_index;

    if let Some(source) = config.source {
        channel.source = source;
    }
    if let Some(power_mode) = config.power_mode {
        channel.power_mode = power_mode;
    }

    // Exactly the model's matrix inputs, like `reconcile_matrix_size` keeps
    // them — the parser reads 4 crosspoints even on a 2-channel amp.
    let crosspoints = (0..matrix_input_count)
        .map(|source_index| match config.matrix_crosspoints.iter().find(|cp| cp.source_index == source_index) {
            Some(live) => MatrixCrosspoint {
                source_index,
                gain_db: round_to_step(live.gain_db, GAIN_STEPS),
                active: live.active,
            },
            None => channel
                .matrix_crosspoints
                .iter()
                .find(|cp| cp.source_index == source_index)
                .cloned()
                .unwrap_or(MatrixCrosspoint { source_index, gain_db: 0.0, active: source_index == index }),
        })
        .collect();
    channel.matrix_crosspoints = crosspoints;

    channel.delay_in_ms = round_to_step(config.delay_in_ms as f64, DELAY_STEPS);
    channel.input_muted = config.input_muted;
    channel.input_eq = mirror_eq(&config.input_eq);
    channel.output_eq = mirror_eq(&config.output_eq);
    channel.output_trim_db = round_to_step(config.output_trim_db as f64, GAIN_STEPS);
    channel.output_volume_db = round_to_step(config.output_volume_db as f64, GAIN_STEPS);
    channel.output_muted = config.output_muted;
    channel.delay_out_ms = round_to_step(config.delay_out_ms as f64, DELAY_STEPS);
    channel.output_phase_inverted = config.output_phase_inverted;
    channel.noise_gate_enabled = config.noise_gate_enabled;
    if let Some(threshold) = config.noise_gate_threshold_dbu {
        channel.noise_gate_threshold_dbu = f64::from(threshold);
    }
    channel.limiter = mirror_limiter(&config.limiter);
    channel.fir_bypassed = config.fir_bypassed;
    channel.ohms = round_to_step(config.load_ohms as f64, OHM_STEPS);
    channel.source_trims = SourceTrims {
        analog: mirror_trim(config.analog_trim_db, config.analog_delay_ms),
        dante: mirror_trim(config.dante_trim_db, config.dante_delay_ms),
    };

    // The amp stores its default labels ("In1", "OutA") as literal names; the
    // project keeps those as `None`, same as a channel nobody renamed.
    channel.input_name = config.input_name.as_deref().and_then(|name| {
        let name = name.trim();
        (!canonical_input_name(index, Some(name)).is_empty()).then(|| name.to_string())
    });
    channel.output_name = config.output_name.as_deref().and_then(|name| {
        let name = name.trim();
        // A `_XXXX` suffix is data the name carries, so a default label with
        // one is kept verbatim.
        let is_default = canonical_output_name(index, Some(name)).is_empty() && split_hash_suffix(name).1.is_none();
        (!is_default).then(|| name.to_string())
    });
}

fn mirror_trim(trim_db: f32, delay_ms: f32) -> SourceTrim {
    SourceTrim {
        trim_db: round_to_step(trim_db as f64, GAIN_STEPS),
        delay_ms: round_to_step(delay_ms as f64, DELAY_STEPS),
    }
}

fn mirror_eq(eq: &ChannelEq) -> ChannelEq {
    ChannelEq { hp: mirror_slot(&eq.hp), bands: eq.bands.iter().map(mirror_band).collect(), lp: mirror_slot(&eq.lp) }
}

fn mirror_slot(slot: &CrossoverSlot) -> CrossoverSlot {
    CrossoverSlot { freq_hz: round_to_step(slot.freq_hz, FREQ_STEPS), ..*slot }
}

fn mirror_band(band: &EqBand) -> EqBand {
    EqBand {
        freq_hz: round_to_step(band.freq_hz, FREQ_STEPS),
        gain_db: round_to_step(band.gain_db, GAIN_STEPS),
        q: round_to_step(band.q, Q_STEPS),
        ..*band
    }
}

fn mirror_limiter(limiter: &Limiter) -> Limiter {
    let rms = &limiter.rms;
    let peak = &limiter.peak;
    Limiter {
        rms: RmsLimiter {
            enabled: rms.enabled,
            threshold_vrms: round_to_step(rms.threshold_vrms, VOLT_STEPS),
            attack_ms: round_to_step(rms.attack_ms, WHOLE_STEPS),
            release_multiplier: round_to_step(rms.release_multiplier, WHOLE_STEPS),
            auto: rms.auto,
            max_vrms: round_to_step(rms.max_vrms, VOLT_STEPS),
        },
        peak: PeakLimiter {
            enabled: peak.enabled,
            threshold_vp: round_to_step(peak.threshold_vp, VOLT_STEPS),
            hold_ms: round_to_step(peak.hold_ms, WHOLE_STEPS),
            release_ms: round_to_step(peak.release_ms, WHOLE_STEPS),
            max_vp: round_to_step(peak.max_vp, VOLT_STEPS),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::fingerprint::{compare_fingerprints, fingerprint_live_device, fingerprint_project_amp};
    use super::super::test_fixtures::*;
    use super::*;
    use crate::live::cvr::bridge::DeviceBridgeSnapshot;

    fn reading() -> LiveAmpReading {
        // Padded, so the merge's trimming of the device name stays covered.
        let mut device = device();
        device.name = format!(" {DEVICE_NAME} ");
        // A real filter on Out A, so the merge has a FIR to copy.
        let mut fir = firs();
        fir[0] = fir_snapshot(0, "top", &[0.5, 0.25]);
        LiveAmpReading {
            device,
            snapshot: Some(snapshot()),
            bridge: Some(DeviceBridgeSnapshot { bridged: vec![Some(true), Some(false)], received_at: 0.0 }),
            fir,
        }
    }

    #[test]
    fn merge_makes_hashes_equal() {
        let (models, links, reading) = (models(), links(), reading());
        let project = Project::new("Test".to_string(), String::new());
        let assignment = assignment();

        let live =
            fingerprint_live_device(&reading.device, reading.snapshot.as_ref().unwrap(), reading.bridge.as_ref(), &reading.fir, &models, &links);
        assert!(live.missing.is_empty(), "{:?}", live.missing);
        assert!(live.amp_hash.is_some());
        assert_ne!(fingerprint_project_amp(&project, &assignment, &models).amp_hash, live.amp_hash);

        let candidate = mirror_live_into_assignment(&assignment, &reading, 4);
        let merged = fingerprint_project_amp(&project, &candidate, &models);
        assert_eq!(merged.amp_hash, live.amp_hash);
        assert!(compare_fingerprints(&merged, &live).iter().all(|row| !row.differs));
        assert_eq!(candidate.channels[0].fir.name, "top", "the amp's FIR came along");
        assert!(candidate.channels[0].fir.same_taps(&[0.5, 0.25]));
    }

    #[test]
    fn merge_leaves_unhashed_fields_alone() {
        let mut assignment = assignment();
        assignment.channels[0].noise_gate_threshold_dbu = -42.0;
        let candidate = mirror_live_into_assignment(&assignment, &reading(), 4);
        assert_eq!(candidate.channels[0].noise_gate_threshold_dbu, -42.0);
        let priority = &candidate.channels[0].backup_priority;
        assert_eq!((priority.enabled, priority.first, priority.second, priority.threshold_db), (false, 0, 0, 0));
    }

    /// 1.1.9 reports the gate threshold, so a pull must take it — otherwise the
    /// project's default would be pushed back over it on the next gate write.
    #[test]
    fn merge_takes_the_1_1_9_gate_threshold() {
        let (models, links, mut reading) = (models(), links(), reading());
        reading.device.firmware_version = "1.1.9".to_string();
        reading.device.firmware_family = Some("1.1.9".to_string());
        for channel in &mut reading.snapshot.as_mut().unwrap().channels {
            channel.noise_gate_threshold_dbu = Some(-37);
        }
        let mut assignment = assignment();
        assignment.firmware_version = Some("1.1.9".to_string());
        let project = Project::new("Test".to_string(), String::new());

        let candidate = mirror_live_into_assignment(&assignment, &reading, 4);
        assert_eq!(candidate.channels[3].noise_gate_threshold_dbu, -37.0);
        let live =
            fingerprint_live_device(&reading.device, reading.snapshot.as_ref().unwrap(), reading.bridge.as_ref(), &reading.fir, &models, &links);
        assert_eq!(fingerprint_project_amp(&project, &candidate, &models).amp_hash, live.amp_hash);
    }

    #[test]
    fn merge_stores_clean_values() {
        let candidate = mirror_live_into_assignment(&assignment(), &reading(), 4);
        let channel = &candidate.channels[0];
        assert_eq!(channel.limiter.rms.threshold_vrms, 56.99);
        assert_eq!(channel.limiter.peak.max_vp, 179.89);
        assert_eq!(channel.delay_out_ms, 7.87);
        assert_eq!(channel.input_eq.bands[0].q, 0.7);
        assert_eq!(channel.matrix_crosspoints[0].gain_db, -3.1);
        assert_eq!(channel.ohms, 4.0);
    }

    #[test]
    fn default_names_become_none() {
        let candidate = mirror_live_into_assignment(&assignment(), &reading(), 4);
        assert_eq!(candidate.channels[0].input_name, None);
        assert_eq!(candidate.channels[0].output_name.as_deref(), Some("Kick_A91C"));
        assert_eq!(candidate.channels[1].output_name, None);
        assert_eq!(candidate.channels[2].output_name.as_deref(), Some("TR"));
        assert_eq!(candidate.device_name.as_deref(), Some("AMP-2004-ETH"));
        assert!(candidate.channels[0].output_bridged);
        assert!(!candidate.channels[2].output_bridged);
    }
}
