//! Test fixtures shared by `amp_merge` and `amp_push`: a tuned DSP-2004 as
//! the amp reports it, and its freshly planned project twin.

use super::amp_model::{AmpModelCatalogEntry, AmpProtocol};
use super::capability::cvr::builtin_topology;
use super::capability::{CrossoverFilterType, EqFilterType, PowerMode, SourceKind};
use super::device_link::DeviceModelLink;
use super::project::{
    AmpAssignment, BackupPriority, ChannelEq, ChannelSource, CrossoverSlot, EqBand, Limiter, MatrixCrosspoint,
    PeakLimiter, RmsLimiter,
};
use crate::live::cvr::channel_config::{ChannelConfig, ChannelConfigSnapshot, EqChainWire};
use crate::live::cvr::channel_state::AmpChannelState;
use crate::live::state::DiscoveredDevice;

pub(crate) const MAC: &str = "6A:20:67:18:B5:8A";
pub(crate) const MODEL_ID: &str = "builtin-dsp-2004";
pub(crate) const DEVICE_NAME: &str = "AMP-2004-ETH";

pub(crate) fn models() -> Vec<AmpModelCatalogEntry> {
    let mut entry = AmpModelCatalogEntry::new_builtin(MODEL_ID, "CVR", "DSP-2004", 4, false, AmpProtocol::CvrUdp);
    entry.topology = builtin_topology("DSP-2004", 4, false);
    vec![entry]
}

pub(crate) fn links() -> Vec<DeviceModelLink> {
    vec![DeviceModelLink {
        mac: MAC.to_string(),
        amp_model_id: MODEL_ID.to_string(),
        auto_matched: false,
        updated_at: 0.0,
    }]
}

/// A freshly planned DSP-2004 — every setting at its default.
pub(crate) fn assignment() -> AmpAssignment {
    let mut assignment =
        AmpAssignment::new(Some(MAC.to_string()), None, 4, Some(MODEL_ID.to_string()), Some("1.1.8".to_string()));
    assignment.reconcile_matrix_size(4);
    assignment.reconcile_eq_bands(10);
    assignment
}

/// A value as the FC=27 parser hands it over: through `f32`.
pub(crate) fn wire(value: f64) -> f64 {
    value as f32 as f64
}


/// The companion bytes of a chain, as the amp reports them. Non-default on
/// purpose: a push echoes these rather than deriving them, so if
/// `eq_chain_bands` mapped the HP/LP slots wrong the round-trip test would
/// still pass with zeros here.
pub(crate) fn live_eq_wire() -> EqChainWire {
    EqChainWire { chain_bypass: 0, hp_gain_db: 1.5, hp_q: 0.71, lp_gain_db: -2.25, lp_q: 1.41 }
}

pub(crate) fn live_eq(gain_db: f64) -> ChannelEq {
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

/// A tuned channel as the amp reports it: nothing at its default.
pub(crate) fn live_channel(index: u32) -> ChannelConfig {
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
        // Deliberately non-zero: these are echoed rather than derived, so
        // zeros here would hide a mapping bug in `eq_chain_bands`.
        input_eq_wire: live_eq_wire(),
        output_eq_wire: live_eq_wire(),
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
        noise_gate_threshold_dbu: None,
    }
}

pub(crate) fn snapshot() -> ChannelConfigSnapshot {
    ChannelConfigSnapshot {
        channels: (0..4).map(live_channel).collect(),
        standby: Some(false),
        standby_locked: Some(false),
        rotary_locked: Some(true),
        preset_name: Some("Lab".to_string()),
        received_at: 0.0,
    }
}

pub(crate) fn device() -> DiscoveredDevice {
    DiscoveredDevice {
        id: format!("cvr:{MAC}"),
        driver_id: "cvr".to_string(),
        brand: "CVR".to_string(),
        name: DEVICE_NAME.to_string(),
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
    }
}
