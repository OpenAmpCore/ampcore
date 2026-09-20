//! CVR firmware 1.1.9 write/control command encoding.
//!
//! No 1.1.9 hardware exists to verify a write path against yet — the only
//! CVR unit available for this work runs 1.1.8. This is a deliberate,
//! explicit placeholder rather than gating 1.1.9 devices out of writes
//! entirely: it reuses the 1.1.8 encoding verbatim (same FC, same body
//! layout). It WILL silently send the wrong bytes if 1.1.9's write protocol
//! has actually diverged from 1.1.8 — same honesty caveat as
//! `channel_config_v119.rs`.
//!
//! Replace this file's bodies with real 1.1.9-specific encodings once that
//! hardware exists to ground-truth against — kept as a separate file (not
//! just a re-export) so that divergence is a one-file change, not a refactor
//! that risks the already-verified 1.1.8 path.

use crate::data::capability::PowerMode;

pub fn build_set_output_mute(channel_index: u8, muted: bool) -> Vec<u8> {
    super::write_v118::build_set_output_mute(channel_index, muted)
}

pub fn build_set_input_mute(channel_index: u8, muted: bool) -> Vec<u8> {
    super::write_v118::build_set_input_mute(channel_index, muted)
}

pub fn build_set_output_trim(channel_index: u8, trim_db: f32) -> Vec<u8> {
    super::write_v118::build_set_output_trim(channel_index, trim_db)
}

pub fn build_set_output_volume(channel_index: u8, volume_db: f32) -> Vec<u8> {
    super::write_v118::build_set_output_volume(channel_index, volume_db)
}

pub fn build_set_delay_in(channel_index: u8, delay_ms: f32) -> Vec<u8> {
    super::write_v118::build_set_delay_in(channel_index, delay_ms)
}

pub fn build_set_delay_out(channel_index: u8, delay_ms: f32) -> Vec<u8> {
    super::write_v118::build_set_delay_out(channel_index, delay_ms)
}

pub fn build_set_phase_invert(channel_index: u8, inverted: bool) -> Vec<u8> {
    super::write_v118::build_set_phase_invert(channel_index, inverted)
}

pub fn build_set_power_mode(channel_index: u8, mode: PowerMode) -> Vec<u8> {
    super::write_v118::build_set_power_mode(channel_index, mode)
}

pub fn build_set_rotary_lock(locked: bool) -> Vec<u8> {
    super::write_v118::build_set_rotary_lock(locked)
}

pub fn build_set_standby(standby: bool) -> Vec<u8> {
    super::write_v118::build_set_standby(standby)
}

pub fn build_set_eq_filter_type(channel_index: u8, in_out_flag: u8, segment: u8, type_code: u8, active: bool) -> Vec<u8> {
    super::write_v118::build_set_eq_filter_type(channel_index, in_out_flag, segment, type_code, active)
}

pub fn build_set_eq_freq(channel_index: u8, in_out_flag: u8, segment: u8, freq_hz: f32) -> Vec<u8> {
    super::write_v118::build_set_eq_freq(channel_index, in_out_flag, segment, freq_hz)
}

pub fn build_set_eq_gain(channel_index: u8, in_out_flag: u8, band_index: u8, gain_db: f32) -> Vec<u8> {
    super::write_v118::build_set_eq_gain(channel_index, in_out_flag, band_index, gain_db)
}

pub fn build_set_eq_q(channel_index: u8, in_out_flag: u8, band_index: u8, q: f32) -> Vec<u8> {
    super::write_v118::build_set_eq_q(channel_index, in_out_flag, band_index, q)
}

pub fn build_set_matrix_crosspoint(channel_index: u8, source_index: u8, gain_db: f32, active: bool) -> Vec<u8> {
    super::write_v118::build_set_matrix_crosspoint(channel_index, source_index, gain_db, active)
}

/// The one Tier-A action with a *confirmed* 1.1.9 divergence rather than the
/// blanket "reuse 1.1.8" caveat above: the reference documents a 2-byte
/// `[enable][threshold]` body for v119+, against v118's 1-byte enable-only
/// form. `threshold_dbu` is carried as a signed byte.
///
/// This still matches `CvrFirmwareCapability.noise_gate_threshold`, which is
/// what already decides whether the UI offers a threshold control at all.
///
/// **Unresolved: the vendor source disagrees with the reference here.** It
/// never sends a 2-byte FC=69. It sends the enable flag on FC=69 (1 byte,
/// `Variable\Channels_out.cs:772`) and the threshold on **FC=87**
/// `Noise_Gate` (1 signed byte, `Channels_out.cs:799-805`) as two separate
/// packets — and only 1.1.9 stores a threshold at all (`SynData_Flow_n.cs:67`;
/// the vendor fabricates `-70` when upconverting a 1.1.8 payload). So this
/// body is likely wrong, inherited from a reference bug rather than a capture.
///
/// Left as-is deliberately: there is no 1.1.9 hardware to ground-truth
/// against, the threshold has no readback in this app on either firmware, and
/// it is not hashed — so nothing depends on it being right yet. Port FC=87 and
/// drop the second body byte once such a unit exists.
pub fn build_set_noise_gate(channel_index: u8, enabled: bool, threshold_dbu: i8) -> Vec<u8> {
    use super::protocol::build_control_packet;
    let body = [if enabled { 0x00 } else { 0x01 }, threshold_dbu as u8];
    build_control_packet(super::write_v118::FC_NOISE_GATE, channel_index, 0, 0, 1, &body)
}

pub fn build_set_rms_limiter(
    channel_index: u8,
    enabled: bool,
    threshold_vrms: f32,
    attack_ms: u16,
    release_multiplier: u8,
) -> Vec<u8> {
    super::write_v118::build_set_rms_limiter(channel_index, enabled, threshold_vrms, attack_ms, release_multiplier)
}

pub fn build_set_peak_limiter(
    channel_index: u8,
    enabled: bool,
    threshold_vp: f32,
    hold_ms: u16,
    release_ms: u16,
) -> Vec<u8> {
    super::write_v118::build_set_peak_limiter(channel_index, enabled, threshold_vp, hold_ms, release_ms)
}

pub fn build_set_channel_name(channel_index: u8, in_out_flag: u8, name: &str) -> Vec<u8> {
    super::write_v118::build_set_channel_name(channel_index, in_out_flag, name)
}

pub fn build_set_source_select(channel_index: u8, source_code: u8) -> Vec<u8> {
    super::write_v118::build_set_source_select(channel_index, source_code)
}

pub fn build_set_analog_input(channel_index: u8, analog_input_index: u8) -> Vec<u8> {
    super::write_v118::build_set_analog_input(channel_index, analog_input_index)
}

pub fn build_set_output_bridge(pair_index: u8, bridged: bool) -> Vec<u8> {
    super::write_v118::build_set_output_bridge(pair_index, bridged)
}

pub fn build_set_eq_chain(
    channel_index: u8,
    in_out_flag: u8,
    bands: &[super::write_v118::EqChainBand; super::write_v118::EQ_CHAIN_BANDS],
    chain_bypass: u8,
) -> Vec<u8> {
    super::write_v118::build_set_eq_chain(channel_index, in_out_flag, bands, chain_bypass)
}

pub fn build_set_fir_bypass(channel_index: u8, bypassed: bool) -> Vec<u8> {
    super::write_v118::build_set_fir_bypass(channel_index, bypassed)
}

pub fn build_set_rms_limiter_auto(channel_index: u8, auto: bool) -> Vec<u8> {
    super::write_v118::build_set_rms_limiter_auto(channel_index, auto)
}

pub fn build_set_device_name(name: &str) -> Vec<u8> {
    super::write_v118::build_set_device_name(name)
}

pub fn build_set_source_trim(channel_index: u8, segment: u8, trim_db: f32, delay_ms: f32) -> Vec<u8> {
    super::write_v118::build_set_source_trim(channel_index, segment, trim_db, delay_ms)
}

pub fn build_set_backup_priority(
    channel_index: u8,
    first: u8,
    second: u8,
    enabled: bool,
    threshold_db: i8,
) -> Vec<u8> {
    super::write_v118::build_set_backup_priority(channel_index, first, second, enabled, threshold_db)
}
