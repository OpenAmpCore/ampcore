//! FC=43 (`FIR_datas`) — the per-output-channel FIR filter: its name and its
//! raw coefficient (tap) array. Ground-truthed against the original vendor C#
//! source (`Struct_test.cs:325` for the function code, `FIR_DATA.cs` for the
//! body layout, `ReceiveDatas/RD_All.cs:2212-2223` for the decode) and
//! cross-checked against a prior web port of the same controller.
//!
//! Writing coefficients (the vendor's Import, and its Remove — FC=43 with
//! `status_code=6` and an empty body) needs a 2093-byte frame, which the
//! protocol fragments into five 450-byte datagrams (the last one shorter)
//! with a stop-and-wait ACK per fragment — see `split_into_fragments` and
//! `build_set_fir_data`. Ground-truthed against the vendor's own `UDP.cs`
//! send loop, which does exactly this for this same command.
//!
//! Query: `status_code=2`, `chx` = output channel (0-based), **`in_out_flag=1`**
//! (FIR is an output-side feature; the vendor sets it at
//! `Mypages/FIRPage.xaml.cs:434`), empty body. The reply is always
//! multi-fragment.
//!
//! The one thing that must not be simplified: **the reply comes in two forms
//! and they are told apart by body length alone** — 2080 bytes carries a
//! 32-byte name prefix, 2048 bytes does not. The vendor branches on exactly
//! this (`body.Length == 2048` vs `== 2080`), and the prior web port's bug is
//! instructive: it assumes the name prefix unconditionally, which silently
//! shifts every coefficient by 8 taps against an amp that answers with the
//! nameless form.
//!
//! Everything the vendor's FIR page displays *besides* the name and the taps
//! is computed locally, not read from the amp — see `fir_order`,
//! `fir_time_zero`, and `FIR_SAMPLE_RATE_HZ`.
//!
//! Confirmed against real 1.1.8 hardware: the query above is answered, and
//! that amp replies with the **2080-byte named form**. A 512-tap linear-phase
//! filter read back from it decoded to a peak of `0.9885799` at tap 256 (so
//! `time_zero_ms` = 5.333) with only the final tap exactly zero (so `order` =
//! 511) — note that a symmetric filter whose first tap is also zero still
//! reports 511 rather than 512, because the trim is strictly of *trailing*
//! zeros. The vendor's own readout does the same.

use super::protocol::{
    build_control_packet_with_status, build_network_data_header, build_struct_header, calc_check_code, CHECKSUM_LEN,
    STRUCT_HEADER_LEN,
};
use crate::data::common::now_millis;
use serde::Serialize;
use specta::Type;

pub const FC_FIR_DATA: u8 = 43;

/// StructHeader `in_out_flag` for every FIR query/command — FIR exists only on
/// output channels.
pub const FIR_IN_OUT_FLAG: u8 = 1;

/// Taps the wire always carries, occupied or not: the array is fixed-size and
/// zero-padded. The vendor's "(Max 512)" label is this constant, hardcoded in
/// its XAML — **not** a capability the amp reports.
pub const FIR_MAX_TAPS: usize = 512;

/// Width of the name field that prefixes the 2080-byte reply form.
pub const FIR_NAME_FIELD_LEN: usize = 32;

/// The DSP's sample rate. Not a wire field either — the vendor hardcodes
/// `": 48kHz"` in its XAML and divides by 48000/48.0 throughout. Reported in
/// the snapshot so a reader can see where the number came from instead of
/// assuming it was measured.
pub const FIR_SAMPLE_RATE_HZ: u32 = 48_000;

/// The nameless reply form: `float32[512]`.
const FIR_BODY_LEN_PLAIN: usize = FIR_MAX_TAPS * 4;
/// The named reply form: `name[32]` + `float32[512]`.
const FIR_BODY_LEN_NAMED: usize = FIR_NAME_FIELD_LEN + FIR_BODY_LEN_PLAIN;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelFirSnapshot {
    pub channel_index: u32,
    /// `None` when the amp replied with the 2048-byte nameless form — a
    /// meaningfully different thing from `Some("")`, which is an amp that has
    /// a name field with nothing stored in it. The vendor shows the literal
    /// `"---"` for the latter.
    pub name: Option<String>,
    /// Locally known, not read back — see `FIR_SAMPLE_RATE_HZ`.
    pub sample_rate_hz: u32,
    /// Locally known, not read back — see `FIR_MAX_TAPS`.
    pub max_taps: u32,
    /// Taps minus trailing zeros — the vendor's "Order: N Taps". Derived, not
    /// a wire field. See `fir_order`.
    pub order: u32,
    /// Index of the peak-magnitude tap, and that index in milliseconds — the
    /// vendor's zero-time readout. Derived, not a wire field. See
    /// `fir_time_zero`.
    pub time_zero_index: u32,
    pub time_zero_ms: f64,
    /// All `FIR_MAX_TAPS` coefficients, trailing zeros included, exactly as
    /// the amp sent them: IEEE-754 float32 little-endian with no scaling.
    pub coefficients: Vec<f32>,
    /// Which of the two reply forms this came from (2048 or 2080). Kept so the
    /// answer is visible rather than inferred — the two are distinguished by
    /// nothing else.
    pub body_len: u32,
    pub received_at: f64,
}

/// The FIR read carries no body at all. A named function rather than a bare
/// `Vec::new()` at the call site so the emptiness reads as the vendor's
/// documented request shape and not as an oversight.
pub fn build_fir_request_body() -> Vec<u8> {
    Vec::new()
}

/// Null-terminates then trims a fixed-width ASCII name field — same decode
/// style as `preset::decode_name_field` and `protocol::parse_basic_info_reply`.
fn decode_name_field(field: &[u8]) -> String {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).trim().to_string()
}

/// Effective tap count: the array length minus its trailing zeros. Mirrors the
/// vendor's `FIRInfo.setFIRData`/`FIRPage.setFIR_Datas`, which both walk
/// backwards from 512 while the coefficient is exactly `0f`. An amp with no
/// filter loaded holds a unit impulse (`[1.0, 0, 0, ...]`) and so reports 1 —
/// which is what the vendor's "Order: 1 Taps" means on an empty channel.
fn fir_order(coefficients: &[f32]) -> u32 {
    let mut order = coefficients.len();
    while order > 0 && coefficients[order - 1] == 0.0 {
        order -= 1;
    }
    order as u32
}

/// Index of the largest-magnitude tap, and that index as milliseconds at
/// `FIR_SAMPLE_RATE_HZ` (so `index / 48.0`), rounded to 3 decimal places —
/// the vendor's `FIRPage.setFIRTimeZero`.
///
/// On a tie the *positive* peak wins, because the vendor compares the absolute
/// min against the absolute max and resolves equality to the max before taking
/// `IndexOf`. (The prior web port uses a strict `>` on the absolute value,
/// which differs from this only when a filter's largest positive and largest
/// negative taps have exactly equal magnitude.)
fn fir_time_zero(coefficients: &[f32]) -> (u32, f64) {
    let mut max_value = f32::NEG_INFINITY;
    let mut min_value = f32::INFINITY;
    for &c in coefficients {
        if c > max_value {
            max_value = c;
        }
        if c < min_value {
            min_value = c;
        }
    }
    if !max_value.is_finite() || !min_value.is_finite() {
        return (0, 0.0);
    }
    // The `>=` is what prefers the positive peak on a tie.
    let peak = if max_value.abs() >= min_value.abs() { max_value } else { min_value };
    let index = coefficients.iter().position(|&c| c == peak).unwrap_or(0);
    let samples_per_ms = FIR_SAMPLE_RATE_HZ as f64 / 1000.0;
    let ms = (index as f64 / samples_per_ms * 1000.0).round() / 1000.0;
    (index as u32, ms)
}

/// Parses a resolved FC=43 frame (StructHeader + body + checksum, the shape
/// `RequestRegistry` resolves to — same slicing convention as
/// `preset::parse_preset_list`).
///
/// `channel_index` comes from the caller rather than the reply header: the
/// request already addressed one channel, and unlike FC=50 — where the reply's
/// own `chx` is authoritative because the driver polls pairs across separate
/// ticks — nothing here fans out.
///
/// Returns `None` for any body that is not exactly one of the two known
/// lengths. That is deliberate strictness: the two forms differ only in
/// length, so a body of some third size cannot be decoded by guessing which
/// one it resembles. The caller surfaces it as a real shape error.
pub fn parse_fir_data(frame: &[u8], channel_index: u8) -> Option<ChannelFirSnapshot> {
    if frame.len() < STRUCT_HEADER_LEN + CHECKSUM_LEN {
        return None;
    }
    let body = &frame[STRUCT_HEADER_LEN..frame.len() - CHECKSUM_LEN];
    let (name, tap_bytes) = match body.len() {
        FIR_BODY_LEN_NAMED => {
            let (name_field, taps) = body.split_at(FIR_NAME_FIELD_LEN);
            (Some(decode_name_field(name_field)), taps)
        }
        FIR_BODY_LEN_PLAIN => (None, body),
        _ => return None,
    };

    let coefficients: Vec<f32> =
        tap_bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let (time_zero_index, time_zero_ms) = fir_time_zero(&coefficients);

    Some(ChannelFirSnapshot {
        channel_index: channel_index as u32,
        name,
        sample_rate_hz: FIR_SAMPLE_RATE_HZ,
        max_taps: FIR_MAX_TAPS as u32,
        order: fir_order(&coefficients),
        time_zero_index,
        time_zero_ms,
        coefficients,
        body_len: body.len() as u32,
        received_at: now_millis(),
    })
}

/// Inverse of `decode_name_field`: ASCII bytes, truncated or zero-padded to
/// `FIR_NAME_FIELD_LEN`.
fn encode_name_field(name: &str) -> [u8; FIR_NAME_FIELD_LEN] {
    let mut field = [0u8; FIR_NAME_FIELD_LEN];
    let bytes = name.as_bytes();
    let n = bytes.len().min(FIR_NAME_FIELD_LEN);
    field[..n].copy_from_slice(&bytes[..n]);
    field
}

/// Splits an already-built inner frame (StructHeader + body + checksum) into
/// the datagrams the vendor's `UDP.cs::send` sends once a write exceeds one
/// datagram: ≤450-byte chunks, each prefixed with its own `NetworkDataHeader`.
///
/// `packets_lastlen` carries the **last** fragment's length and stays constant
/// across every fragment in the set (the vendor computes it once, before the
/// send loop, and never touches it again) — not the current fragment's own
/// length, which is what the field name is easy to misread as.
///
/// A frame that fits in one datagram still goes through this and comes out
/// byte-identical to what `build_control_packet_with_status` already emits
/// for a single-shot write (`packets_count = packets_step = 1`, `packets_lastlen`
/// = the whole frame) — FIR is the only caller today, but nothing here special
/// -cases the single-fragment shape.
fn split_into_fragments(inner: &[u8]) -> Vec<Vec<u8>> {
    const CHUNK: usize = 450;
    let len = inner.len();
    let mut count = len / CHUNK + 1;
    let mut last_len = len % CHUNK;
    if last_len == 0 {
        last_len = CHUNK;
        count -= 1;
    }
    (1..=count as u8)
        .map(|step| {
            let start = (step as usize - 1) * CHUNK;
            let end = if (step as usize) * CHUNK > len { len } else { start + CHUNK };
            let chunk = &inner[start..end];
            let header = build_network_data_header(last_len as u16, 0, 0, count as u8, step);
            let mut packet = Vec::with_capacity(header.len() + chunk.len());
            packet.extend_from_slice(&header);
            packet.extend_from_slice(chunk);
            packet
        })
        .collect()
}

/// FC=43 write (the vendor's Import): `status_code=1`, `in_out_flag=1`, body =
/// `name[32]` + `float32[512]` — same 2080-byte named shape `parse_fir_data`
/// decodes, always sent with the name prefix regardless of what the amp last
/// replied with. `coefficients` longer than `FIR_MAX_TAPS` is truncated;
/// shorter is zero-padded — the caller (the Tauri command) rejects an
/// over-long import instead of relying on this silent truncation.
pub fn build_set_fir_data(channel_index: u8, name: &str, coefficients: &[f32]) -> Vec<Vec<u8>> {
    let mut body = Vec::with_capacity(FIR_BODY_LEN_NAMED);
    body.extend_from_slice(&encode_name_field(name));
    for i in 0..FIR_MAX_TAPS {
        let v = coefficients.get(i).copied().unwrap_or(0.0);
        body.extend_from_slice(&v.to_le_bytes());
    }
    let struct_header = build_struct_header(FC_FIR_DATA, 1, channel_index, 0, 0, FIR_IN_OUT_FLAG);
    let mut inner = Vec::with_capacity(STRUCT_HEADER_LEN + body.len() + CHECKSUM_LEN);
    inner.extend_from_slice(&struct_header);
    inner.extend_from_slice(&body);
    inner.extend_from_slice(&calc_check_code(&inner));
    split_into_fragments(&inner)
}

/// FC=43 write with `status_code=6` (`Response_cc`) and an empty body — the
/// vendor's Remove. Fits in one datagram, so no fragmentation.
pub fn build_clear_fir_data(channel_index: u8) -> Vec<u8> {
    build_control_packet_with_status(FC_FIR_DATA, 6, channel_index, 0, 0, FIR_IN_OUT_FLAG, &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a frame in the shape `RequestRegistry` resolves to: a
    /// StructHeader, the body, and a checksum (whose contents this parser
    /// never inspects — `validate_frame` already did).
    fn frame(body: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; STRUCT_HEADER_LEN];
        out.extend_from_slice(body);
        out.extend_from_slice(&[0u8; CHECKSUM_LEN]);
        out
    }

    fn taps(values: &[f32]) -> Vec<u8> {
        let mut out = Vec::with_capacity(FIR_MAX_TAPS * 4);
        for i in 0..FIR_MAX_TAPS {
            out.extend_from_slice(&values.get(i).copied().unwrap_or(0.0).to_le_bytes());
        }
        out
    }

    #[test]
    fn the_named_and_nameless_forms_are_told_apart_by_length_alone() {
        let mut named = b"lowpass".to_vec();
        named.resize(FIR_NAME_FIELD_LEN, 0);
        named.extend_from_slice(&taps(&[0.5, 0.25]));
        let parsed = parse_fir_data(&frame(&named), 2).expect("2080-byte body parses");
        assert_eq!(parsed.name.as_deref(), Some("lowpass"));
        assert_eq!(parsed.body_len, FIR_BODY_LEN_NAMED as u32);
        assert_eq!(parsed.channel_index, 2);
        assert_eq!(parsed.coefficients[0], 0.5);

        // The same taps with no name prefix must decode to the same taps —
        // this is the coefficient-shifting bug the prior web port has.
        let parsed = parse_fir_data(&frame(&taps(&[0.5, 0.25])), 0).expect("2048-byte body parses");
        assert_eq!(parsed.name, None);
        assert_eq!(parsed.coefficients[0], 0.5);
        assert_eq!(parsed.coefficients[1], 0.25);
    }

    #[test]
    fn a_body_of_any_other_length_is_refused_rather_than_guessed() {
        assert!(parse_fir_data(&frame(&[0u8; 1024]), 0).is_none());
        assert!(parse_fir_data(&frame(&[]), 0).is_none());
        assert!(parse_fir_data(&[], 0).is_none());
    }

    #[test]
    fn order_is_taps_minus_trailing_zeros() {
        // An amp with nothing loaded holds a unit impulse: the vendor's
        // "Order: 1 Taps".
        let parsed = parse_fir_data(&frame(&taps(&[1.0])), 0).unwrap();
        assert_eq!(parsed.order, 1);
        assert_eq!(parsed.time_zero_index, 0);
        assert_eq!(parsed.time_zero_ms, 0.0);

        let parsed = parse_fir_data(&frame(&taps(&[0.0, 0.0, 0.3])), 0).unwrap();
        assert_eq!(parsed.order, 3);
    }

    #[test]
    fn time_zero_takes_the_peak_magnitude_tap_and_prefers_the_positive_one() {
        // Peak at index 48 => exactly 1 ms at 48 kHz.
        let mut values = vec![0.0f32; 64];
        values[48] = -0.9;
        let parsed = parse_fir_data(&frame(&taps(&values)), 0).unwrap();
        assert_eq!(parsed.time_zero_index, 48);
        assert_eq!(parsed.time_zero_ms, 1.0);

        // Equal magnitudes: the positive one wins, matching the vendor's
        // absolute-min-vs-absolute-max comparison.
        let mut values = vec![0.0f32; 64];
        values[10] = -0.5;
        values[20] = 0.5;
        let parsed = parse_fir_data(&frame(&taps(&values)), 0).unwrap();
        assert_eq!(parsed.time_zero_index, 20);
    }

    #[test]
    fn a_512_tap_write_fragments_exactly_like_the_vendor() {
        let coefficients = vec![0.1f32; FIR_MAX_TAPS];
        let fragments = build_set_fir_data(2, "lowpass", &coefficients);
        // 2093-byte inner frame (10 header + 2080 body + 3 checksum) over
        // 450-byte chunks: 5 fragments, four full plus a 293-byte remainder.
        assert_eq!(fragments.len(), 5);
        for fragment in &fragments[..4] {
            assert_eq!(fragment.len(), super::super::protocol::NETWORK_HEADER_LEN + 450);
        }
        assert_eq!(fragments[4].len(), super::super::protocol::NETWORK_HEADER_LEN + 293);
        for (i, fragment) in fragments.iter().enumerate() {
            let header = super::super::protocol::parse_network_data_header(fragment).unwrap();
            assert_eq!(header.packets_count, 5);
            assert_eq!(header.packets_step, (i + 1) as u8);
            assert_eq!(header.packets_lastlen, 293);
        }
    }

    #[test]
    fn a_fragmented_write_round_trips_through_parse_fir_data() {
        let mut coefficients = vec![0.0f32; FIR_MAX_TAPS];
        coefficients[0] = 0.5;
        coefficients[10] = -0.25;
        let fragments = build_set_fir_data(0, "test", &coefficients);

        let inner: Vec<u8> = fragments
            .into_iter()
            .flat_map(|f| f[super::super::protocol::NETWORK_HEADER_LEN..].to_vec())
            .collect();
        let parsed = parse_fir_data(&inner, 0).expect("reassembled frame parses");
        assert_eq!(parsed.name.as_deref(), Some("test"));
        assert_eq!(parsed.coefficients, coefficients);
    }

    #[test]
    fn clearing_fir_data_is_a_single_unfragmented_packet() {
        let packet = build_clear_fir_data(3);
        let header = super::super::protocol::parse_network_data_header(&packet).unwrap();
        assert_eq!(header.packets_count, 1);
        assert_eq!(header.packets_step, 1);
    }
}
