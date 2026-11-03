use super::*;

/// Lays a `ChannelEq` out into the ten positional slots FC=52 expects: slot 0
/// is the HP crossover, slots 1..=8 the parametric bands, slot 9 the LP — the
/// same numbering `channel_config_v118::parse_eq_block` reads back and that
/// the per-band `segment` field uses.
///
/// The HP/LP slots take their gain and Q from `wire`, echoing whatever the amp
/// reported: a `CrossoverSlot` has no such fields (its slope type implies Q),
/// so there is no project value to write and inventing one would change the
/// amp behind the user's back.
///
/// A band the project is missing keeps the amp's own values rather than a
/// fabricated default; the caller has already refused a push whose band counts
/// disagree, so this is a belt-and-braces fallback, not a normal path.
pub fn eq_chain_bands(eq: &ChannelEq, wire: &EqChainWire) -> [EqChainBand; EQ_CHAIN_BANDS] {
    std::array::from_fn(|slot| match slot {
        0 => EqChainBand {
            type_code: crossover_filter_type_code(eq.hp.filter_type),
            active: eq.hp.active,
            gain_db: wire.hp_gain_db,
            freq_hz: eq.hp.freq_hz as f32,
            q: wire.hp_q,
        },
        9 => EqChainBand {
            type_code: crossover_filter_type_code(eq.lp.filter_type),
            active: eq.lp.active,
            gain_db: wire.lp_gain_db,
            freq_hz: eq.lp.freq_hz as f32,
            q: wire.lp_q,
        },
        _ => match eq.bands.get(slot - 1) {
            Some(band) => EqChainBand {
                type_code: eq_filter_type_code(band.filter_type),
                active: band.active,
                gain_db: band.gain_db as f32,
                freq_hz: band.freq_hz as f32,
                q: band.q as f32,
            },
            None => EqChainBand { type_code: 0, active: false, gain_db: 0.0, freq_hz: 0.0, q: 0.0 },
        },
    })
}

/// Builds the packets for one action, in send order.
///
/// `None` means this firmware has no encoding for the action, which the caller
/// turns into the same "unrecognized/unknown firmware" error every write
/// command uses. Nothing here invents a fallback encoding.
pub fn action_packets(action: &PushAction, firmware: Option<&str>) -> Option<Vec<Vec<u8>>> {
    let packets = match action {
        PushAction::DeviceName { name } => vec![write::build_set_device_name(firmware, name)?],
        PushAction::Source { channel, kind, analog_index } => {
            let source_code = match kind {
                SourceKind::Analog => 0,
                SourceKind::Dante => 1,
                // Rejected at plan time — this app never selects either.
                SourceKind::Backup | SourceKind::Aes3 => return None,
            };
            let mut out = vec![write::build_set_source_select(firmware, *channel, source_code)?];
            if let Some(index) = analog_index {
                out.push(write::build_set_analog_input(firmware, *channel, *index)?);
            }
            out
        }
        PushAction::InputMute { channel, muted } => vec![write::build_set_input_mute(firmware, *channel, *muted)?],
        PushAction::DelayIn { channel, delay_ms } => {
            vec![write::build_set_delay_in(firmware, *channel, *delay_ms as f32)?]
        }
        PushAction::SourceTrim { channel, family, trim_db, delay_ms } => {
            vec![write::build_set_source_trim(firmware, *channel, family.segment(), *trim_db as f32, *delay_ms as f32)?]
        }
        PushAction::EqChain { channel, direction, eq, wire } => {
            vec![write::build_set_eq_chain(firmware, *channel, write::in_out_flag(*direction), &eq_chain_bands(eq, wire), wire.chain_bypass)?]
        }
        PushAction::MatrixCrosspoint { channel, source_index, gain_db, active } => {
            vec![write::build_set_matrix_crosspoint(firmware, *channel, *source_index, *gain_db as f32, *active)?]
        }
        PushAction::OutputTrim { channel, trim_db } => {
            vec![write::build_set_output_trim(firmware, *channel, *trim_db as f32)?]
        }
        PushAction::OutputVolume { channel, volume_db } => {
            vec![write::build_set_output_volume(firmware, *channel, *volume_db as f32)?]
        }
        PushAction::OutputMute { channel, muted } => vec![write::build_set_output_mute(firmware, *channel, *muted)?],
        PushAction::DelayOut { channel, delay_ms } => {
            vec![write::build_set_delay_out(firmware, *channel, *delay_ms as f32)?]
        }
        PushAction::PhaseInvert { channel, inverted } => {
            vec![write::build_set_phase_invert(firmware, *channel, *inverted)?]
        }
        PushAction::PowerMode { channel, mode } => vec![write::build_set_power_mode(firmware, *channel, *mode)?],
        PushAction::FirBypass { channel, bypassed } => vec![write::build_set_fir_bypass(firmware, *channel, *bypassed)?],
        PushAction::FirData { channel, name, coefficients } => {
            write::build_set_fir_data(firmware, *channel, name, coefficients)?
        }
        PushAction::NoiseGate { channel, enabled, threshold_dbu } => {
            write::build_set_noise_gate(firmware, *channel, *enabled, *threshold_dbu)?
        }
        PushAction::RmsLimiter { channel, enabled, threshold_vrms, attack_ms, release_multiplier } => {
            vec![write::build_set_rms_limiter(
                firmware,
                *channel,
                *enabled,
                *threshold_vrms as f32,
                *attack_ms as u16,
                *release_multiplier as u8,
            )?]
        }
        PushAction::RmsLimiterAuto { channel, auto } => {
            vec![write::build_set_rms_limiter_auto(firmware, *channel, *auto)?]
        }
        PushAction::PeakLimiter { channel, enabled, threshold_vp, hold_ms, release_ms } => {
            vec![write::build_set_peak_limiter(
                firmware,
                *channel,
                *enabled,
                *threshold_vp as f32,
                *hold_ms as u16,
                *release_ms as u16,
            )?]
        }
        PushAction::ChannelName { channel, direction, name } => {
            // The device field is fixed-width ASCII; a non-ASCII name would
            // be truncated mid-sequence, so it is refused rather than mangled.
            if !name.is_ascii() {
                return None;
            }
            vec![write::build_set_channel_name(firmware, *channel, write::in_out_flag(*direction), name)?]
        }
        PushAction::Bridge { pair_index, bridged } => {
            vec![write::build_set_output_bridge(firmware, *pair_index, *bridged)?]
        }
    };
    Some(packets)
}
