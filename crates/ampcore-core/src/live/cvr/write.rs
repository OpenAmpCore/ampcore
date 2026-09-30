//! Write/control command dispatch — the write-side counterpart to
//! `channel_config.rs`/`telemetry.rs`: one entry point per logical action,
//! gated on `DiscoveredDevice.firmware_family`, rather than hardcoding one
//! firmware's function codes/body layout directly in a Tauri command.
//!
//! 1.1.9 reuses the 1.1.8 encoders (`write_v118.rs`); the noise gate adds a
//! 1.1.9-only threshold packet. Mute, EQ, delay and trim have been read back correctly on
//! 1.1.9 hardware; the rest is unverified there and would silently send the
//! wrong bytes if 1.1.9 has diverged. Give a diverging action its own `match`
//! arm (see `build_set_noise_gate`).
//!
//! Writes are delivery-confirmed, but not *value*-confirmed. `send_control`
//! submits through the driver's socket and resolves only once the device has
//! echoed the packet's NetworkData header back with `data_state = 1`,
//! refiring up to `WRITE_MAX_REFIRES` times first (see `request.rs`'s
//! `WriteRegistry`, and the vendor reference's `UDP.send`/`outTime` loop it
//! mirrors). What that ACK proves is that the datagram arrived — nothing
//! about whether the parameter took the requested value. The resulting state
//! is still observed the same way it always was: via the next FC=27 poll
//! (already running, see `driver.rs`) reaching the frontend through the
//! existing `live_channel_config:updated` event, with no optimistic update.
//!
//! This is a *transport* ACK and so has nothing to do with `request.rs`'s
//! function-code request/response engine, which the read path uses — the two
//! registries are independent and run side by side in the driver loop.

use std::net::Ipv4Addr;

use tokio::sync::{mpsc, oneshot};

use crate::data::capability::PowerMode;
use crate::data::project::{CrossoverSlotKind, EqDirection};

use super::protocol::{is_known_family, wire_log_enabled, CHECKSUM_LEN, NETWORK_HEADER_LEN, STRUCT_HEADER_LEN};
use super::request::{write_max_attempts, WriteError, WriteOutcome, WriteSpec};

/// Wire `in_out_flag`: 0 = input side of a channel, 1 = output side.
pub fn in_out_flag(direction: EqDirection) -> u8 {
    match direction {
        EqDirection::Input => 0,
        EqDirection::Output => 1,
    }
}

/// Wire `segment` of parametric band `band_index` (0-7). The fixed 10-slot
/// chain reserves 0 for HP and 9 for LP, so band `i` is always `i + 1` —
/// passing it unshifted silently aims band 0 at the HP crossover slot.
pub fn eq_band_segment(band_index: u8) -> u8 {
    band_index + 1
}

/// Wire `segment` of a crossover slot, per the reference's `getCrossoverSegment`.
pub fn crossover_segment(slot: CrossoverSlotKind) -> u8 {
    match slot {
        CrossoverSlotKind::Hp => 0,
        CrossoverSlotKind::Lp => 9,
    }
}

/// Routes a "set output mute" request to the adapter for `firmware_family`.
/// A family this dispatch doesn't recognize (`None`/unknown) builds no
/// packet at all — no generic fallback encoding, since guessing wrong would
/// silently send bytes the device might misinterpret instead of an honest
/// error (see `commands/live_control.rs`).
pub fn build_set_output_mute(firmware_family: Option<&str>, channel_index: u8, muted: bool) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_output_mute(channel_index, muted))
}

pub fn build_set_input_mute(firmware_family: Option<&str>, channel_index: u8, muted: bool) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_input_mute(channel_index, muted))
}

pub fn build_set_output_trim(firmware_family: Option<&str>, channel_index: u8, trim_db: f32) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_output_trim(channel_index, trim_db))
}

pub fn build_set_output_volume(firmware_family: Option<&str>, channel_index: u8, volume_db: f32) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_output_volume(channel_index, volume_db))
}

pub fn build_set_delay_in(firmware_family: Option<&str>, channel_index: u8, delay_ms: f32) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_delay_in(channel_index, delay_ms))
}

pub fn build_set_delay_out(firmware_family: Option<&str>, channel_index: u8, delay_ms: f32) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_delay_out(channel_index, delay_ms))
}

pub fn build_set_phase_invert(firmware_family: Option<&str>, channel_index: u8, inverted: bool) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_phase_invert(channel_index, inverted))
}

/// Routes an amp-level standby set to the adapter for `firmware_family`.
/// Amp-wide, not per channel — `chx` is 0 and there is no channel parameter.
pub fn build_set_standby(firmware_family: Option<&str>, standby: bool) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_standby(standby))
}

pub fn build_set_rotary_lock(firmware_family: Option<&str>, locked: bool) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_rotary_lock(locked))
}

pub fn build_set_power_mode(firmware_family: Option<&str>, channel_index: u8, mode: PowerMode) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_power_mode(channel_index, mode))
}

pub fn build_set_eq_filter_type(
    firmware_family: Option<&str>,
    channel_index: u8,
    in_out_flag: u8,
    segment: u8,
    type_code: u8,
    active: bool,
) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_eq_filter_type(channel_index, in_out_flag, segment, type_code, active))
}

pub fn build_set_eq_freq(
    firmware_family: Option<&str>,
    channel_index: u8,
    in_out_flag: u8,
    segment: u8,
    freq_hz: f32,
) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_eq_freq(channel_index, in_out_flag, segment, freq_hz))
}

pub fn build_set_eq_gain(
    firmware_family: Option<&str>,
    channel_index: u8,
    in_out_flag: u8,
    band_index: u8,
    gain_db: f32,
) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_eq_gain(channel_index, in_out_flag, band_index, gain_db))
}

pub fn build_set_eq_q(
    firmware_family: Option<&str>,
    channel_index: u8,
    in_out_flag: u8,
    band_index: u8,
    q: f32,
) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_eq_q(channel_index, in_out_flag, band_index, q))
}

pub fn build_set_matrix_crosspoint(
    firmware_family: Option<&str>,
    channel_index: u8,
    source_index: u8,
    gain_db: f32,
    active: bool,
) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_matrix_crosspoint(channel_index, source_index, gain_db, active))
}

/// The enable flag is FC=69's single byte on every firmware (the vendor's
/// `Channels_out.cs:772`; Hagen's clone confirms it on 1.1.9 by read-back).
/// Only 1.1.9 stores a threshold (`SynData_Flow_n.cs:67`), which the vendor
/// sends as a second packet: FC=87 `Noise_Gate`, one signed byte
/// (`Channels_out.cs:804`). FC=87 is vendor-sourced, not yet seen on the wire;
/// its value reads back via `channel_config_v119`, which is what keeps a gate
/// toggle from resending a stale threshold. `threshold_dbu` is ignored on 1.1.8, matching
/// `CvrFirmwareCapability.noise_gate_threshold`.
pub fn build_set_noise_gate(
    firmware_family: Option<&str>,
    channel_index: u8,
    enabled: bool,
    threshold_dbu: i8,
) -> Option<Vec<Vec<u8>>> {
    let enable = super::write_v118::build_set_noise_gate(channel_index, enabled);
    match firmware_family {
        Some("1.1.8") => Some(vec![enable]),
        Some("1.1.9") => {
            let threshold = super::protocol::build_control_packet(
                super::write_v118::FC_NOISE_GATE_THRESHOLD,
                channel_index,
                0,
                0,
                1,
                &[threshold_dbu as u8],
            );
            Some(vec![enable, threshold])
        }
        _ => None,
    }
}

pub fn build_set_rms_limiter(
    firmware_family: Option<&str>,
    channel_index: u8,
    enabled: bool,
    threshold_vrms: f32,
    attack_ms: u16,
    release_multiplier: u8,
) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_rms_limiter(channel_index, enabled, threshold_vrms, attack_ms, release_multiplier))
}

pub fn build_set_peak_limiter(
    firmware_family: Option<&str>,
    channel_index: u8,
    enabled: bool,
    threshold_vp: f32,
    hold_ms: u16,
    release_ms: u16,
) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_peak_limiter(channel_index, enabled, threshold_vp, hold_ms, release_ms))
}

pub fn build_set_channel_name(
    firmware_family: Option<&str>,
    channel_index: u8,
    in_out_flag: u8,
    name: &str,
) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_channel_name(channel_index, in_out_flag, name))
}

pub fn build_set_source_select(firmware_family: Option<&str>, channel_index: u8, source_code: u8) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_source_select(channel_index, source_code))
}

pub fn build_set_analog_input(firmware_family: Option<&str>, channel_index: u8, analog_input_index: u8) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_analog_input(channel_index, analog_input_index))
}

/// `pair_index`, not a channel index — see `write_v118::build_set_output_bridge`.
pub fn build_set_output_bridge(firmware_family: Option<&str>, pair_index: u8, bridged: bool) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_output_bridge(pair_index, bridged))
}

/// One whole 10-band EQ chain in a single packet — see
/// `write_v118::build_set_eq_chain`. Used by the offline → online push; the
/// interactive Direct Edit path stays on the per-band codes above, where a
/// fader drag should move one field and coalesce, not rewrite the chain.
pub fn build_set_eq_chain(
    firmware_family: Option<&str>,
    channel_index: u8,
    in_out_flag: u8,
    bands: &[super::write_v118::EqChainBand; super::write_v118::EQ_CHAIN_BANDS],
    chain_bypass: u8,
) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_eq_chain(channel_index, in_out_flag, bands, chain_bypass))
}

pub fn build_set_fir_bypass(firmware_family: Option<&str>, channel_index: u8, bypassed: bool) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_fir_bypass(channel_index, bypassed))
}

pub fn build_set_fir_data(firmware_family: Option<&str>, channel_index: u8, name: &str, coefficients: &[f32]) -> Option<Vec<Vec<u8>>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_fir_data(channel_index, name, coefficients))
}

pub fn build_clear_fir_data(firmware_family: Option<&str>, channel_index: u8) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_clear_fir_data(channel_index))
}

/// Auto travels on its own function code (FC=48), not inside the FC=55 record
/// — see `write_v118::build_set_rms_limiter_auto`.
pub fn build_set_rms_limiter_auto(firmware_family: Option<&str>, channel_index: u8, auto: bool) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_rms_limiter_auto(channel_index, auto))
}

/// Amp-level, not per channel: `chx` is always 0 (see
/// `write_v118::build_set_device_name`).
pub fn build_set_device_name(firmware_family: Option<&str>, name: &str) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_device_name(name))
}

/// `segment` selects the source family: 0=Analog, 1=Dante. Trim and delay
/// have no partial form and must both be supplied.
pub fn build_set_source_trim(
    firmware_family: Option<&str>,
    channel_index: u8,
    segment: u8,
    trim_db: f32,
    delay_ms: f32,
) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_source_trim(channel_index, segment, trim_db, delay_ms))
}

/// `first`/`second` are `FC_SOURCE_SELECT` source codes (0=Analog, 1=Dante)
/// and `threshold_db` is signed — see
/// `write_v118::build_set_backup_priority`, including why only the 3-source
/// payload form is emitted.
pub fn build_set_backup_priority(
    firmware_family: Option<&str>,
    channel_index: u8,
    first: u8,
    second: u8,
    enabled: bool,
    threshold_db: i8,
) -> Option<Vec<u8>> {
    is_known_family(firmware_family).then(|| super::write_v118::build_set_backup_priority(channel_index, first, second, enabled, threshold_db))
}

/// Fixed 10-byte follow-up packet the device expects after any crossover
/// (HP/LP) FILTER_TYPE/FILTER_FREQ write before the change takes effect —
/// reverse-engineered by the reference implementation (`amp-device.ts`'s
/// `CROSSOVER_COMMIT_PACKET`) from real packet captures and the vendor C#
/// source; not something `build_control_packet` can construct (it isn't a
/// standard struct-header + body frame), so it's sent verbatim. Unlike every
/// other write in this module, the reference does not gate this by firmware
/// family, so it's sent as-is regardless of `firmware_family` here too.
///
/// Decoded as a `NetworkDataHeader` it is not a control frame at all — it is
/// an *ACK*: `data_flag = 0xD903`, `machine_mode = 404`, `packets_count = 1`,
/// `packets_lastlen = 92`, `packets_step = 1`, `data_state = 1`. In other
/// words the capture this was lifted from recorded the PC acknowledging a
/// 92-byte frame, and replaying those exact bytes is what the device treats
/// as the commit. That is why `send_control` sends it with
/// `expect_ack = false`: a device never ACKs an ACK, so waiting on one would
/// time out every time.
pub const CROSSOVER_COMMIT_PACKET: [u8; 10] = [0x03, 0xd9, 0x94, 0x01, 0x01, 0x5c, 0x00, 0x01, 0x01, 0x5a];

fn hex_dump(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")
}

/// Logs one outgoing write with the same `[cvr driver]` prefix/console the
/// read path (`driver.rs`) already uses, so a write shows up alongside the
/// FC=27/heartbeat traffic it's meant to influence, not silently. Decodes
/// FC/chx/segment/in_out_flag/body when `packet` has the shape
/// `build_control_packet` produces (NetworkHeader+StructHeader+body+
/// checksum); falls back to a plain length+hex dump for anything else — the
/// one exception today being `CROSSOVER_COMMIT_PACKET`, a fixed raw packet
/// with no StructHeader at all.
fn log_write(ip: Ipv4Addr, packet: &[u8]) {
    if !wire_log_enabled() {
        return;
    }
    let header_len = NETWORK_HEADER_LEN + STRUCT_HEADER_LEN;
    if packet.len() >= header_len + CHECKSUM_LEN {
        let function_code = packet[NETWORK_HEADER_LEN + 1];
        let chx = packet[NETWORK_HEADER_LEN + 3];
        let segment = packet[NETWORK_HEADER_LEN + 4];
        let in_out_flag = packet[NETWORK_HEADER_LEN + 9];
        let body = &packet[header_len..packet.len() - CHECKSUM_LEN];
        println!(
            "[cvr driver] write to {ip}: FC={function_code} chx={chx} segment={segment} in_out_flag={in_out_flag} body=[{}] ({} bytes)",
            hex_dump(body),
            packet.len()
        );
    } else {
        println!("[cvr driver] write to {ip}: {} raw bytes [{}]", packet.len(), hex_dump(packet));
    }
}

/// True for a packet that is itself an ACK (`data_state = 1` at byte 8 of the
/// NetworkData header) — today only `CROSSOVER_COMMIT_PACKET`, which is a
/// replayed ACK rather than a control frame. Neither side ACKs an ACK, so
/// waiting for confirmation of one would always time out.
fn is_ack_packet(packet: &[u8]) -> bool {
    packet.len() >= NETWORK_HEADER_LEN && packet[8] != 0
}

/// Submits a pre-built control packet to the running driver and awaits the
/// device's transport-level ACK for it (see `request.rs`'s `WriteRegistry`):
/// resolves `Ok` only once the device has echoed the packet's NetworkData
/// header back, or `Err` once the initial send and all `WRITE_MAX_REFIRES`
/// refires have gone unacknowledged.
///
/// This deliberately does *not* send from its own ephemeral socket the way
/// the vendor reference's `sendControl` port did. The ACK returns either to
/// the datagram's source port or to a fixed 45454 depending on firmware —
/// sending from the driver's socket, which is bound to 45454, satisfies both
/// readings, whereas an ephemeral socket is closed before the ACK lands under
/// the first and is simply not listening under the second.
///
/// The device applying the write is still observed separately, via the next
/// FC=27 poll and the existing `live_channel_config:updated` event — an ACK
/// confirms delivery, not that the parameter took the requested value.
pub async fn send_control(
    write_tx: &mpsc::UnboundedSender<WriteSpec>,
    ip: Ipv4Addr,
    packet: &[u8],
) -> Result<WriteOutcome, WriteError> {
    log_write(ip, packet);
    let (tx, rx) = oneshot::channel();
    let spec = WriteSpec {
        ip: ip.to_string(),
        packet: packet.to_vec(),
        expect_ack: !is_ack_packet(packet),
        tx,
    };
    write_tx.send(spec).map_err(|_| WriteError::DriverStopped)?;
    let result = rx.await.map_err(|_| WriteError::DriverStopped)?;
    // Success lines are gated behind `AMPCORE_WIRE_LOG` (see
    // `protocol::wire_log_enabled`) because stdout from inside the driver loop
    // is what stalls ACK correlation in the first place. When enabled, the
    // attempt count is the point: `1/6` is a clean link, anything higher is
    // packet loss the refires papered over and that would otherwise be
    // invisible. Failures always log, unconditionally: a device whose firmware
    // does not ACK writes at all shows up as a FAILED line on *every* write —
    // the signal to look at `WriteSpec::expect_ack`, the single lever that
    // turns confirmation off (the vendor reference's `IsNoACK10` escape hatch).
    match &result {
        Ok(outcome) if wire_log_enabled() => {
            if outcome.attempts == 0 {
                println!("[cvr driver] write to {ip} coalesced into a newer write for the same parameter");
            } else {
                println!(
                    "[cvr driver] write to {ip} ACKed on attempt {}/{} ({}ms)",
                    outcome.attempts,
                    write_max_attempts(),
                    outcome.elapsed_ms
                );
            }
        }
        Ok(_) => {}
        Err(e) => eprintln!("[cvr driver] write to {ip} FAILED: {e}"),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1.1.9's threshold rides on its own FC=87 packet; 1.1.8 sends only the
    /// 1-byte FC=69 enable. Never the old 2-byte FC=69 body.
    #[test]
    fn noise_gate_threshold_is_a_separate_fc87_packet_on_1_1_9() {
        let fc = |p: &Vec<u8>| p[NETWORK_HEADER_LEN + 1];
        let body = |p: &Vec<u8>| p[NETWORK_HEADER_LEN + STRUCT_HEADER_LEN..p.len() - CHECKSUM_LEN].to_vec();

        let v118 = build_set_noise_gate(Some("1.1.8"), 2, true, -40).unwrap();
        assert_eq!(v118.len(), 1);
        assert_eq!((fc(&v118[0]), body(&v118[0])), (69, vec![0x00]));

        let v119 = build_set_noise_gate(Some("1.1.9"), 2, false, -40).unwrap();
        assert_eq!(v119.len(), 2);
        assert_eq!((fc(&v119[0]), body(&v119[0])), (69, vec![0x01]));
        assert_eq!((fc(&v119[1]), body(&v119[1])), (87, vec![-40i8 as u8]));

        assert!(build_set_noise_gate(None, 2, true, -40).is_none());
    }
}
