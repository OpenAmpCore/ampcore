//! CVR Pro Audio UDP control protocol, ground-truthed against a working
//! reverse-engineered reference implementation (firmware v1.1.8 only).
//! Discovery (FC=0 BASIC_INFO), heartbeat (FC=6), multi-fragment
//! request/response (see `request.rs`, used by FC=27 SYNC_DATA), and
//! per-parameter write commands (see `write.rs`, built on
//! `build_control_packet` below) are all covered.
//!
//! Firmware 1.1.9 is known to differ from 1.1.8 in byte offsets *and*
//! function codes for at least some commands, but no 1.1.9 reference/spec
//! exists yet — `detect_firmware_family` below buckets a device into the
//! V118 or V119 wire adapter (used by `channel_config.rs`, `telemetry.rs`,
//! and `write.rs` to pick which firmware-specific parser/encoder to use),
//! not just for display. BASIC_INFO parsing already handles multiple
//! body-length variants generically and has been verified against real
//! 1.1.8 hardware; whether it also holds unmodified for 1.1.9 remains
//! unconfirmed.

use std::net::Ipv4Addr;

use serde::Serialize;
use specta::Type;

/// Per-packet wire logging, off unless `AMPCORE_WIRE_LOG` is set to a
/// non-empty, non-"0" value. Read once and cached.
///
/// This exists because every `println!` is a synchronous, lock-taking write to
/// stdout made from *inside* the driver's `select!` loop. The FC=27 line alone
/// fires ~5x/s per device, and on Windows with a console attached that is
/// enough to stall the loop — which delays exactly the `recv` branch that
/// correlates write ACKs, causing writes to refire against a device that
/// already applied them.
///
/// Genuine faults (write failures, request timeouts, parse failures) are
/// logged unconditionally and ignore this flag.
pub fn wire_log_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("AMPCORE_WIRE_LOG").map(|v| !v.is_empty() && v != "0").unwrap_or(false))
}

pub const PC_LISTEN_PORT: u16 = 45454;
pub const AMP_PORT: u16 = 45455;

pub const NETWORK_DATA_FLAG: u16 = 0xD903;
pub const NETWORK_HEADER_LEN: usize = 10;
pub const STRUCT_HEADER_LEN: usize = 10;
pub const CHECKSUM_LEN: usize = 3;

pub const FC_BASIC_INFO: u8 = 0;
pub const FC_HEARTBEAT: u8 = 6;
/// SYNC_DATA — bulk per-channel DSP config readback (see
/// `channel_config.rs`). One request (empty body, built generically by
/// `RequestRegistry::register` — see `request.rs`) returns every channel's
/// config in one response; there is no per-channel request variant, the
/// wire protocol doesn't support asking for just one.
pub const FC_SYNC_DATA: u8 = 27;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CvrFirmwareFamily {
    V118,
    V119,
    Unknown,
}

/// `firmware_family` is a *wire-adapter bucket*, not a literal version claim.
/// Delegates to `capability::cvr::extract_vnum` (its own doc comment already
/// invites this: "the future live driver can reuse this exact function...
/// do not duplicate this parsing there") rather than a narrow ad-hoc
/// substring check, so every CVR-generation firmware gets bucketed instead
/// of silently dropped. 118 is the baseline: any detected vNum below 119
/// (including older strings such as 116/117) routes to the V118 adapter as
/// an honest best-effort, the same caveat already applied to
/// `channel_config_v119.rs`/`telemetry_v119.rs` reusing v118's parser. The
/// precise raw string is untouched and still fully visible via
/// `DiscoveredDevice.firmware_version` — this only changes which adapter
/// file handles a device, not what's displayed.
impl CvrFirmwareFamily {
    /// The brand-agnostic `DiscoveredDevice.firmware_family` label for this
    /// bucket. Shared by the driver and offline fingerprinting
    /// (`data/fingerprint.rs`) so a planned "1.1.9" and a device string land
    /// on the exact same label.
    pub fn label(self) -> Option<&'static str> {
        match self {
            CvrFirmwareFamily::V118 => Some("1.1.8"),
            CvrFirmwareFamily::V119 => Some("1.1.9"),
            CvrFirmwareFamily::Unknown => None,
        }
    }
}

pub fn detect_firmware_family(version_string: &str) -> CvrFirmwareFamily {
    use crate::data::capability::cvr::{extract_vnum, VNUM_119};
    match extract_vnum(version_string) {
        Some(v) if v >= VNUM_119 => CvrFirmwareFamily::V119,
        Some(_) => CvrFirmwareFamily::V118,
        None => CvrFirmwareFamily::Unknown,
    }
}

/// Only `data_flag`/`data_state` are read this pass; the rest document the
/// full wire format for the fragmentation/reassembly work deferred to a
/// future phase (see module doc).
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct NetworkDataHeader {
    pub data_flag: u16,
    pub machine_mode: i16,
    pub packets_count: u8,
    pub packets_lastlen: u16,
    pub packets_step: u8,
    pub data_state: u8, // 0 = data, 1 = ACK
    pub padding: u8,
}

pub fn parse_network_data_header(raw: &[u8]) -> Option<NetworkDataHeader> {
    if raw.len() < NETWORK_HEADER_LEN {
        return None;
    }
    Some(NetworkDataHeader {
        data_flag: u16::from_le_bytes([raw[0], raw[1]]),
        machine_mode: i16::from_le_bytes([raw[2], raw[3]]),
        packets_count: raw[4],
        packets_lastlen: u16::from_le_bytes([raw[5], raw[6]]),
        packets_step: raw[7],
        data_state: raw[8],
        padding: raw[9],
    })
}

pub fn build_network_data_header(
    frame_len: u16,
    machine_mode: i16,
    data_state: u8,
    packets_count: u8,
    packets_step: u8,
) -> [u8; NETWORK_HEADER_LEN] {
    let mut buf = [0u8; NETWORK_HEADER_LEN];
    buf[0..2].copy_from_slice(&NETWORK_DATA_FLAG.to_le_bytes());
    buf[2..4].copy_from_slice(&machine_mode.to_le_bytes());
    buf[4] = packets_count;
    buf[5..7].copy_from_slice(&frame_len.to_le_bytes());
    buf[7] = packets_step;
    buf[8] = data_state;
    buf[9] = 0;
    buf
}

/// byte0=0x55 sentinel, byte1=FC, byte2=status, byte3=chx, byte4=segment,
/// bytes5-8=link (i32 LE), byte9=inOutFlag(0=in,1=out).
///
/// `status` is the vendor reference's `Responsed` enum, in full:
/// 0=`Response`, 1=`NOT_Response`, 2=`Request`, 3=`Response_aa`,
/// 4=`Response_error`, 5=`Response_bb`, 6=`Response_cc`, 7=`Response_dd`.
/// This app sends 1 (writes, via `build_control_packet`), 2 (queries, via
/// `build_protocol_packet`) and — for FC=15 STANDBY alone — 0, via
/// `build_control_packet_with_status` (see `write_v118::build_set_standby`).
/// Note 4 is an explicit *error*
/// status a device can reply with; nothing here inspects it yet, and doing
/// so would be an application-level check entirely separate from the
/// transport ACK that `request.rs`'s `WriteRegistry` waits on.
pub fn build_struct_header(
    function_code: u8,
    status_code: u8,
    chx: u8,
    segment: u8,
    link: i32,
    in_out_flag: u8,
) -> [u8; STRUCT_HEADER_LEN] {
    let mut buf = [0u8; STRUCT_HEADER_LEN];
    buf[0] = 0x55;
    buf[1] = function_code;
    buf[2] = status_code;
    buf[3] = chx;
    buf[4] = segment;
    buf[5..9].copy_from_slice(&link.to_le_bytes());
    buf[9] = in_out_flag;
    buf
}

/// hi/lo = length prefix of (inner_frame.len()+3); sum = hi+lo+Σbytes.
pub fn calc_check_code(inner_frame: &[u8]) -> [u8; CHECKSUM_LEN] {
    let num = inner_frame.len() as u32 + CHECKSUM_LEN as u32;
    let hi = ((num >> 8) & 0xff) as u8;
    let lo = (num & 0xff) as u8;
    let mut sum: u32 = hi as u32 + lo as u32;
    for &b in inner_frame {
        sum += b as u32;
    }
    [hi, lo, (sum & 0xff) as u8]
}

/// Full packet = NetworkHeader(10) + StructHeader(10) + body + Checksum(3).
pub fn build_protocol_packet(function_code: u8, status_code: u8, chx: u8, body: &[u8]) -> Vec<u8> {
    let struct_header = build_struct_header(function_code, status_code, chx, 0, 0, 0);
    let mut inner = Vec::with_capacity(STRUCT_HEADER_LEN + body.len());
    inner.extend_from_slice(&struct_header);
    inner.extend_from_slice(body);
    let checksum = calc_check_code(&inner);
    inner.extend_from_slice(&checksum);
    let network_header = build_network_data_header(inner.len() as u16, 0, 0, 1, 1);
    let mut packet = Vec::with_capacity(NETWORK_HEADER_LEN + inner.len());
    packet.extend_from_slice(&network_header);
    packet.extend_from_slice(&inner);
    packet
}

/// Full packet for a write/control command — the write-side counterpart to
/// `build_protocol_packet` (which hardcodes `segment=link=in_out_flag=0` for
/// the read-only queries it serves). `status_code` is `1`, the reference
/// implementation's write/control convention (see `write.rs`); the one command
/// that needs a different one reaches for `build_control_packet_with_status`.
pub fn build_control_packet(function_code: u8, chx: u8, segment: u8, link: i32, in_out_flag: u8, body: &[u8]) -> Vec<u8> {
    build_control_packet_with_status(function_code, 1, chx, segment, link, in_out_flag, body)
}

/// `build_control_packet` with an explicit `status_code`. Exists for FC=15
/// STANDBY, which the vendor software alone among writes sends with
/// `Responsed::Response` (0) rather than `NOT_Response` (1) — see
/// `write_v118::build_set_standby`. Prefer `build_control_packet` for anything
/// else: a non-standard status on a command the device expects `1` on is the
/// kind of difference that shows up as a silently ignored write.
pub fn build_control_packet_with_status(
    function_code: u8,
    status_code: u8,
    chx: u8,
    segment: u8,
    link: i32,
    in_out_flag: u8,
    body: &[u8],
) -> Vec<u8> {
    let struct_header = build_struct_header(function_code, status_code, chx, segment, link, in_out_flag);
    let mut inner = Vec::with_capacity(STRUCT_HEADER_LEN + body.len());
    inner.extend_from_slice(&struct_header);
    inner.extend_from_slice(body);
    let checksum = calc_check_code(&inner);
    inner.extend_from_slice(&checksum);
    let network_header = build_network_data_header(inner.len() as u16, 0, 0, 1, 1);
    let mut packet = Vec::with_capacity(NETWORK_HEADER_LEN + inner.len());
    packet.extend_from_slice(&network_header);
    packet.extend_from_slice(&inner);
    packet
}

pub fn build_basic_info_query() -> Vec<u8> {
    build_protocol_packet(FC_BASIC_INFO, 2, 0, &[])
}

pub fn build_heartbeat_query() -> Vec<u8> {
    build_protocol_packet(FC_HEARTBEAT, 2, 0, &[])
}

/// Every received data packet (dataState=0) gets ACK'd by echoing its
/// NetworkData header with dataState flipped to 1 — no body, stateless.
pub fn build_ack_packet(raw_packet: &[u8]) -> Option<[u8; NETWORK_HEADER_LEN]> {
    if raw_packet.len() < NETWORK_HEADER_LEN {
        return None;
    }
    let mut ack = [0u8; NETWORK_HEADER_LEN];
    ack.copy_from_slice(&raw_packet[..NETWORK_HEADER_LEN]);
    ack[8] = 1;
    Some(ack)
}

/// Mirrors the reference `validateAssembledFrame`: only the low two checksum
/// bytes (lo, sum) are compared, not the length-prefix `hi` byte — matching
/// that asymmetry exactly is required for compatibility with real firmware.
pub fn validate_frame(assembled: &[u8]) -> bool {
    if assembled.len() < STRUCT_HEADER_LEN + CHECKSUM_LEN {
        return false;
    }
    if assembled[0] != 0x55 {
        return false;
    }
    let inner = &assembled[..assembled.len() - CHECKSUM_LEN];
    let expected = calc_check_code(inner);
    expected[1] == assembled[assembled.len() - 2] && expected[2] == assembled[assembled.len() - 1]
}

#[derive(Debug, Clone)]
pub struct BasicInfoReply {
    pub mac: String,
    pub name: String,
    pub firmware_version: String,
    pub gain_max: u8,
    pub analog_input_channels: u8,
    pub digital_input_channels: u8,
    pub output_channels: u8,
    pub machine_state: u8,
}

/// `raw` = full UDP datagram: NetworkHeader(10) + StructHeader(10) + body + checksum(3).
/// Body variants seen in the original software: 75B base, 79B (base+4B
/// vendor/meta extension), 83B (32-byte name field variant), 87B (83B
/// variant + 4B extension) — all handled here.
pub fn parse_basic_info_reply(raw: &[u8]) -> Option<BasicInfoReply> {
    if raw.len() < 98 {
        return None;
    }
    if raw[10] != 0x55 {
        return None;
    }
    if raw[11] != FC_BASIC_INFO {
        return None;
    }

    let full_body = &raw[20..raw.len() - CHECKSUM_LEN];
    let body: &[u8] = if full_body.len() == 79 || full_body.len() == 87 {
        &full_body[..full_body.len() - 4]
    } else {
        full_body
    };
    if body.len() < 75 {
        return None;
    }

    let read_mac_at = |offset: usize| -> Option<[u8; 6]> {
        if body.len() < offset + 6 {
            return None;
        }
        let mut mac = [0u8; 6];
        mac.copy_from_slice(&body[offset..offset + 6]);
        (mac.iter().map(|&b| b as u32).sum::<u32>() > 0).then_some(mac)
    };

    // Legacy layout: name=24B, mac@64. Newer layout: name=32B, mac@72.
    let mac_offset = if read_mac_at(72).is_some() { 72 } else { 64 };
    let mac_bytes = read_mac_at(mac_offset)?;
    let mac = mac_bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":");

    let ver_slice = &body[0..24];
    let ver_end = ver_slice.iter().position(|&b| b == 0).unwrap_or(24);
    let firmware_version = String::from_utf8_lossy(&ver_slice[..ver_end]).trim().to_string();

    let name_slice = &body[32..mac_offset];
    let name_end = name_slice.iter().position(|&b| b == 0).unwrap_or(name_slice.len());
    let name = String::from_utf8_lossy(&name_slice[..name_end]).trim().to_string();

    let bi_offset = mac_offset + 6;
    let byte_at = |i: usize| -> u8 { body.get(bi_offset + i).copied().unwrap_or(0) };

    Some(BasicInfoReply {
        mac,
        name,
        firmware_version,
        gain_max: byte_at(0),
        analog_input_channels: byte_at(1),
        digital_input_channels: byte_at(2),
        output_channels: byte_at(3),
        machine_state: byte_at(4),
    })
}

/// Directed broadcast address for every active, non-loopback IPv4 interface,
/// falling back to 255.255.255.255 if none are found.
pub fn directed_broadcast_addresses() -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let if_addrs::IfAddr::V4(v4) = iface.addr {
                let ip = v4.ip.octets();
                let mask = v4.netmask.octets();
                let bcast = [
                    ip[0] | !mask[0],
                    ip[1] | !mask[1],
                    ip[2] | !mask[2],
                    ip[3] | !mask[3],
                ];
                out.push(Ipv4Addr::from(bcast));
            }
        }
    }
    if out.is_empty() {
        out.push(Ipv4Addr::new(255, 255, 255, 255));
    }
    out
}
