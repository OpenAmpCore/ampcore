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
//! and not hashed — see the `fingerprint.rs` module doc) and
//! `noise_gate_threshold_dbu` (no 1.1.8 readback). Both keep the project's
//! values.

use serde::Serialize;
use specta::Type;

use super::edit_lock::LiveAmpReading;
use super::fingerprint::{
    canonical_input_name, canonical_output_name, round_to_step, split_hash_suffix, FingerprintRow, DELAY_STEPS,
    FREQ_STEPS, GAIN_STEPS, OHM_STEPS, Q_STEPS, VOLT_STEPS, WHOLE_STEPS,
};
use super::project::{
    AmpAssignment, AmpChannel, ChannelEq, CrossoverSlot, EqBand, Limiter, MatrixCrosspoint, PeakLimiter, Project,
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
    use super::super::amp_model::{AmpModelCatalogEntry, AmpProtocol};
    use super::super::capability::cvr::builtin_topology;
    use super::super::capability::{CrossoverFilterType, EqFilterType, PowerMode, SourceKind};
    use super::super::device_link::DeviceModelLink;
    use super::super::fingerprint::{compare_fingerprints, fingerprint_live_device, fingerprint_project_amp};
    use super::super::project::{BackupPriority, ChannelSource};
    use super::*;
    use crate::live::cvr::bridge::DeviceBridgeSnapshot;
    use crate::live::cvr::channel_config::{ChannelConfigSnapshot, EqChainWire};
    use crate::live::cvr::channel_state::AmpChannelState;
    use crate::live::state::DiscoveredDevice;

    const MAC: &str = "6A:20:67:18:B5:8A";
    const MODEL_ID: &str = "builtin-dsp-2004";

    fn models() -> Vec<AmpModelCatalogEntry> {
        let mut entry = AmpModelCatalogEntry::new_builtin(MODEL_ID, "CVR", "DSP-2004", 4, false, AmpProtocol::CvrUdp);
        entry.topology = builtin_topology("DSP-2004", 4, false);
        vec![entry]
    }

    fn links() -> Vec<DeviceModelLink> {
        vec![DeviceModelLink {
            mac: MAC.to_string(),
            amp_model_id: MODEL_ID.to_string(),
            auto_matched: false,
            updated_at: 0.0,
        }]
    }

    /// A freshly planned DSP-2004 — every setting at its default.
    fn assignment() -> AmpAssignment {
        let mut assignment =
            AmpAssignment::new(Some(MAC.to_string()), None, 4, Some(MODEL_ID.to_string()), Some("1.1.8".to_string()));
        assignment.reconcile_matrix_size(4);
        assignment.reconcile_eq_bands(10);
        assignment
    }

    /// A value as the FC=27 parser hands it over: through `f32`.
    fn wire(value: f64) -> f64 {
        value as f32 as f64
    }

    fn live_eq(gain_db: f64) -> ChannelEq {
        ChannelEq {
            hp: CrossoverSlot { filter_type: CrossoverFilterType::Butterworth24, freq_hz: wire(110.0), active: true },
            bands: (0..8)
                .map(|i| EqBand {
                    filter_type: if i == 0 { EqFilterType::LowShelf } else { EqFilterType::Peaking },
                    freq_hz: wire(100.0 * (i + 1) as f64 + 0.3),
                    gain_db: wire(gain_db),
                    q: wire(0.7),
                    active: i % 3 == 0,
                })
                .collect(),
            lp: CrossoverSlot { filter_type: CrossoverFilterType::Butterworth12, freq_hz: wire(19900.0), active: false },
        }
    }

    /// A tuned channel: nothing at its default.
    fn live_channel(index: u32) -> ChannelConfig {
        ChannelConfig {
            channel_index: index,
            delay_in_ms: 1.23,
            input_muted: index == 2,
            matrix_crosspoints: (0..4)
                .map(|source_index| MatrixCrosspoint {
                    source_index,
                    gain_db: wire(-3.1),
                    active: source_index == index || source_index == 0,
                })
                .collect(),
            input_eq: live_eq(12.0),
            output_eq: live_eq(-1.5),
            // The merge ignores these (they have no project counterpart);
            // `amp_push`'s own fixture gives them real values.
            input_eq_wire: EqChainWire::default(),
            output_eq_wire: EqChainWire::default(),
            output_trim_db: -18.0,
            output_volume_db: -20.0,
            output_muted: false,
            delay_out_ms: 7.87,
            output_phase_inverted: index == 1,
            noise_gate_enabled: index == 3,
            limiter: Limiter {
                rms: RmsLimiter {
                    enabled: true,
                    threshold_vrms: wire(56.99),
                    attack_ms: 25.0,
                    release_multiplier: 8.0,
                    auto: true,
                    max_vrms: wire(127.35),
                },
                peak: PeakLimiter {
                    enabled: true,
                    threshold_vp: wire(84.84),
                    hold_ms: 0.0,
                    release_ms: 75.0,
                    max_vp: wire(179.89),
                },
            },
            fir_bypassed: true,
            power_mode: Some(PowerMode::LowOhm),
            source: Some(ChannelSource { kind: SourceKind::Analog, index }),
            input_name: Some(format!("In{}", index + 1)),
            output_name: Some(
                match index {
                    0 => "Kick_A91C",
                    1 => "OutB",
                    _ => "TR",
                }
                .to_string(),
            ),
            analog_trim_db: 1.5,
            analog_delay_ms: 0.25,
            dante_trim_db: 0.0,
            dante_delay_ms: 0.0,
            load_ohms: 4.0,
            backup_priority: BackupPriority { enabled: true, first: 1, second: 2, threshold_db: -80 },
        }
    }

    fn reading() -> LiveAmpReading {
        LiveAmpReading {
            device: DiscoveredDevice {
                id: format!("cvr:{MAC}"),
                driver_id: "cvr".to_string(),
                brand: "CVR".to_string(),
                name: " AMP-2004-ETH ".to_string(),
                mac: MAC.to_string(),
                ip: "192.168.1.50".to_string(),
                firmware_version: "1.1.8".to_string(),
                firmware_family: Some("1.1.8".to_string()),
                gain_max: 0,
                analog_input_channels: 4,
                digital_input_channels: 4,
                output_channels: 4,
                machine_state: 0,
                machine_state_decoded: Some(AmpChannelState::Normal),
                online: true,
                last_seen_at: 0.0,
            },
            snapshot: Some(ChannelConfigSnapshot {
                channels: (0..4).map(live_channel).collect(),
                standby: Some(false),
                standby_locked: Some(false),
                rotary_locked: Some(true),
                preset_name: Some("Lab".to_string()),
                received_at: 0.0,
            }),
            bridge: Some(DeviceBridgeSnapshot { bridged: vec![Some(true), Some(false)], received_at: 0.0 }),
        }
    }

    #[test]
    fn merge_makes_hashes_equal() {
        let (models, links, reading) = (models(), links(), reading());
        let project = Project::new("Test".to_string(), String::new());
        let assignment = assignment();

        let live =
            fingerprint_live_device(&reading.device, reading.snapshot.as_ref().unwrap(), reading.bridge.as_ref(), &models, &links);
        assert!(live.missing.is_empty(), "{:?}", live.missing);
        assert!(live.amp_hash.is_some());
        assert_ne!(fingerprint_project_amp(&project, &assignment, &models).amp_hash, live.amp_hash);

        let candidate = mirror_live_into_assignment(&assignment, &reading, 4);
        let merged = fingerprint_project_amp(&project, &candidate, &models);
        assert_eq!(merged.amp_hash, live.amp_hash);
        assert!(compare_fingerprints(&merged, &live).iter().all(|row| !row.differs));
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
