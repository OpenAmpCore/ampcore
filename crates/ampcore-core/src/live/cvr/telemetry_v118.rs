//! CVR firmware 1.1.8 heartbeat body -> live telemetry (voltages, currents,
//! temperatures, limiter/clip state). Ported from the reference
//! implementation's `heartbeat-parser.ts`/`heartbeat-structs.ts`, scoped to
//! the WHOLE118 family only (4-channel amps, body lengths 72/76/88/92/96) —
//! the other body-length families (2-channel, 8-channel/DA8300) are a
//! different model shape and are out of scope for this pass. Ground-truthed
//! against real 1.1.8 hardware.
//!
//! Dispatch is purely by heartbeat body byte length, not by catalog model —
//! the wire data is self-describing.
//!
//! The reference's `outputDbu` is `Telemetry::output_level_db` here, but it
//! is NOT filled in by this adapter: `20*log10(v / ratedRmsVoltage)` needs a
//! rated voltage, which can only be looked up from the device's firmware
//! string, and this function only sees raw packet bytes. `driver.rs` fills
//! it (and `rated_rms_voltage`) in after parsing, via
//! `capability::cvr::rated_rms_voltage_from_firmware_string` — leaving it
//! `None` for any model that lookup doesn't recognize.

use crate::data::common::now_millis;
use crate::live::dsp::voltage_to_db;

use super::protocol::{CHECKSUM_LEN, FC_HEARTBEAT};
use super::telemetry::Telemetry;

const WHOLE117: usize = 72;
const ACTIVE: usize = 76;
const WHOLE118_MINUS_INSTATES: usize = 88;
const WHOLE118: usize = 92;
const WHOLE118_PLUS: usize = 96;

/// Byte offset 20 = NetworkHeader(10) + StructHeader(10).
const BODY_START: usize = 20;

struct HeartFields {
    temperatures: Vec<f32>,
    output_voltages: Vec<f32>,
    output_currents: Vec<f32>,
    output_states: Vec<u32>,
    input_voltages: Vec<f32>,
    input_states: Vec<i32>,
    limiters: Vec<f32>,
    fan_voltage: Option<f32>,
}

fn read_floats(body: &[u8], offset: usize, count: usize) -> Vec<f32> {
    (0..count)
        .map(|i| {
            let abs = offset + i * 4;
            body.get(abs..abs + 4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .unwrap_or(0.0)
        })
        .collect()
}

fn read_bytes(body: &[u8], offset: usize, count: usize) -> Vec<u32> {
    (0..count).map(|i| body.get(offset + i).copied().unwrap_or(0) as u32).collect()
}

fn read_sbytes(body: &[u8], offset: usize, count: usize) -> Vec<i32> {
    (0..count)
        .map(|i| body.get(offset + i).copied().unwrap_or(0) as i8 as i32)
        .collect()
}

/// True if every byte at `[offset, offset+count)` looks like a plausible
/// output-state enum value (0..=11) — used to disambiguate the "legacy" vs
/// "shifted" WHOLE118 layout, which share several body lengths.
fn looks_like_state_block(body: &[u8], offset: usize, count: usize) -> bool {
    if offset + count > body.len() {
        return false;
    }
    body[offset..offset + count].iter().all(|&b| b <= 11)
}

fn parse_whole118_family(body: &[u8]) -> HeartFields {
    let legacy_likely = looks_like_state_block(body, 52, 4);
    let shifted_likely = looks_like_state_block(body, 36, 4);
    let use_shifted = shifted_likely && !legacy_likely;

    if use_shifted {
        HeartFields {
            temperatures: read_floats(body, 0, 5),
            output_voltages: read_floats(body, 0, 4),
            output_currents: read_floats(body, 20, 4),
            output_states: read_bytes(body, 36, 4),
            input_voltages: read_floats(body, 40, 4),
            limiters: read_floats(body, 56, 4),
            input_states: if body.len() >= 76 { read_sbytes(body, 72, 4) } else { Vec::new() },
            fan_voltage: if body.len() >= 96 { Some(read_floats(body, 92, 1)[0]) } else { None },
        }
    } else {
        HeartFields {
            temperatures: read_floats(body, 0, 5),
            output_voltages: read_floats(body, 20, 4),
            output_currents: read_floats(body, 36, 4),
            output_states: read_bytes(body, 52, 4),
            input_voltages: read_floats(body, 56, 4),
            limiters: if body.len() >= 88 { read_floats(body, 72, 4) } else { vec![0.0; 4] },
            // Empty, never `vec![0; 4]`: the vendor's `InputChState` names 0
            // "Clip", so four fabricated zeros would read as every input
            // clipping on any firmware whose body stops short of this field.
            input_states: if body.len() >= 92 { read_sbytes(body, 88, 4) } else { Vec::new() },
            fan_voltage: if body.len() >= 96 { Some(read_floats(body, 92, 1)[0]) } else { None },
        }
    }
}

/// `raw` = full UDP datagram: NetworkHeader(10) + StructHeader(10) + body + checksum(3).
/// Returns `None` for any body length outside the recognized WHOLE118 family
/// set — the caller treats that the same as an unsupported shape (silent
/// skip, no telemetry recorded).
pub fn parse_heartbeat_telemetry(raw: &[u8]) -> Option<Telemetry> {
    if raw.len() < BODY_START + CHECKSUM_LEN {
        return None;
    }
    if raw[10] != 0x55 {
        return None;
    }
    if raw[11] != FC_HEARTBEAT {
        return None;
    }

    let machine_mode = i16::from_le_bytes([raw[2], raw[3]]) as i32;
    let body = &raw[BODY_START..raw.len() - CHECKSUM_LEN];

    let fields = match body.len() {
        WHOLE117 | ACTIVE | WHOLE118_MINUS_INSTATES | WHOLE118 | WHOLE118_PLUS => parse_whole118_family(body),
        _ => return None,
    };

    let output_impedance = fields
        .output_voltages
        .iter()
        .zip(fields.output_currents.iter())
        .map(|(&v, &a)| if a > 0.0 { (v / a).round() } else { 0.0 })
        .collect();

    // Reference is an explicit, honest 1.0V — NOT a calibrated ADC full-scale
    // value (this device's real full-scale voltage isn't known here), so this
    // is "dB relative to 1V", not true dBFS despite the field name. See
    // `dsp::voltage_to_db`'s doc for why no reference is ever guessed.
    let input_dbfs = fields.input_voltages.iter().map(|&v| voltage_to_db(v, 1.0, 1.0)).collect();
    // Filled in by `driver.rs` once it can look up a real rated voltage from
    // the device's firmware string — this adapter only sees raw bytes.
    let output_level_db = vec![None; fields.output_voltages.len()];
    // Same split of responsibility as `output_level_db`: decoding an output
    // state byte needs the device's firmware family, which only `driver.rs`
    // knows, so the raw array is carried through here and the decoded one is
    // left length-matched but empty of meaning for it to fill in.
    let output_channel_states = vec![None; fields.output_states.len()];
    // The input flag needs no such dispatch — it is the fixed two-value
    // `InputChState { Clip = 0, None = 1 }`, and its only firmware-dependence
    // (older bodies omit the field entirely) is the length guard above, which
    // leaves `input_states` empty and so this empty too.
    let input_clipping = fields
        .input_states
        .iter()
        .map(|&v| match v {
            0 => Some(true),
            1 => Some(false),
            _ => None,
        })
        .collect();

    Some(Telemetry {
        temperatures: fields.temperatures,
        output_voltages: fields.output_voltages,
        output_currents: fields.output_currents,
        output_impedance,
        output_level_db,
        rated_rms_voltage: None,
        output_states: fields.output_states,
        input_voltages: fields.input_voltages,
        input_dbfs,
        limiters: fields.limiters,
        input_states: fields.input_states,
        output_channel_states,
        input_clipping,
        machine_state_decoded: None,
        fan_voltage: fields.fan_voltage,
        machine_mode,
        received_at: now_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wraps a heartbeat body in the framing `parse_heartbeat_telemetry`
    /// expects: NetworkHeader(10) + StructHeader(10) + body + Checksum(3).
    /// Only bytes 10 and 11 of the header are inspected, and the checksum is
    /// not verified here, so the padding can be zeros.
    fn framed(body: &[u8]) -> Vec<u8> {
        let mut raw = vec![0u8; BODY_START];
        raw[10] = 0x55;
        raw[11] = FC_HEARTBEAT;
        raw.extend_from_slice(body);
        raw.extend_from_slice(&[0u8; CHECKSUM_LEN]);
        raw
    }

    /// A body that stops before `InStates` must report no input reading at
    /// all. It used to substitute `vec![0; 4]`, and `InputChState` names 0
    /// "Clip" — so that default now means "all four inputs clipping".
    #[test]
    fn body_without_instates_reports_no_input_clip_reading() {
        let parsed = parse_heartbeat_telemetry(&framed(&[0u8; WHOLE118_MINUS_INSTATES])).unwrap();
        assert!(parsed.input_states.is_empty());
        assert!(parsed.input_clipping.is_empty());
    }

    #[test]
    fn instates_decode_to_clip_flags() {
        let mut body = [0u8; WHOLE118];
        // Legacy layout puts InStates at 88; 0 = Clip, 1 = None, 7 = unknown.
        body[88] = 0;
        body[89] = 1;
        body[90] = 1;
        body[91] = 7;
        let parsed = parse_heartbeat_telemetry(&framed(&body)).unwrap();
        assert_eq!(
            parsed.input_clipping,
            vec![Some(true), Some(false), Some(false), None]
        );
    }
}
