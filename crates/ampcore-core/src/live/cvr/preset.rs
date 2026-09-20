//! FC=59 (`SAVE_RECALL`) — device-resident named preset slots. Ground-truthed
//! against both a prior web port of this same controller and the original
//! vendor C# source: the wire protocol only ever carries slot *names*, never
//! actual DSP parameter data — EQ/gain/delay/crossover stay on-device and are
//! applied internally when a slot is recalled.
//!
//! No confirmed firmware (1.1.8 vs 1.1.9) difference exists for FC=59 in
//! either reference source, unlike `channel_config.rs`/`write.rs` which
//! dispatch to firmware-specific adapters for confirmed differences —
//! deliberately not split into `preset_v118.rs`/`preset_v119.rs` here, since
//! that would misrepresent a guess as a verified fact. Firmware gating
//! instead happens at the Tauri command boundary (see
//! `commands/live_control.rs`'s `require_v118_firmware`), restricting the
//! exposed feature to 1.1.8 until a real 1.1.9 spec is confirmed.
//!
//! Request/response body is always 34 bytes: `mode(1) + ch_x(1) +
//! buffers(32)`. Only the modes this app exposes a command for are covered —
//! `mode=3` (clear-all) is out of scope.

use super::protocol::{build_control_packet, CHECKSUM_LEN, STRUCT_HEADER_LEN};
use serde::Serialize;
use specta::Type;

pub const FC_SAVE_RECALL: u8 = 59;

const PRESET_MODE_LIST: u8 = 0;
const PRESET_MODE_STORE: u8 = 1;
const PRESET_MODE_RECALL: u8 = 2;
const PRESET_MODE_CURRENT: u8 = 4;
const PRESET_NAME_LEN: usize = 32;
const PRESET_BODY_LEN: usize = 34; // mode(1) + ch_x(1) + buffers(32)

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PresetSlot {
    pub index: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DevicePresetsSnapshot {
    pub slots: Vec<PresetSlot>,
    pub active_preset_name: Option<String>,
    pub received_at: f64,
}

/// Request body for `mode=0` (list every preset slot's name).
pub fn build_list_request_body() -> Vec<u8> {
    let mut body = vec![0u8; PRESET_BODY_LEN];
    body[0] = PRESET_MODE_LIST;
    body
}

/// Request body for `mode=4` (name of the currently-active preset).
pub fn build_current_request_body() -> Vec<u8> {
    let mut body = vec![0u8; PRESET_BODY_LEN];
    body[0] = PRESET_MODE_CURRENT;
    body
}

/// Full control packet for `mode=2` (recall/apply
/// `slot_index`, 0-based). Device-wide action — all struct-header fields
/// (`chx`/`segment`/`link`/`in_out_flag`) are 0; the slot index lives in the
/// body's `ch_x` byte instead.
pub fn build_recall_packet(slot_index: u8) -> Vec<u8> {
    let mut body = vec![0u8; PRESET_BODY_LEN];
    body[0] = PRESET_MODE_RECALL;
    body[1] = slot_index;
    build_control_packet(FC_SAVE_RECALL, 0, 0, 0, 0, &body)
}

/// Full control packet for `mode=1` (store the device's current DSP state
/// into `slot_index`, 0-based, under `name`). Same device-wide framing as
/// `build_recall_packet` — the slot index rides in the body's `ch_x` byte —
/// but the 32-byte `buffers` field carries the new slot name rather than
/// staying zeroed.
///
/// Ground-truthed against the prior web port's `AmpDevice.storePreset`,
/// which cites the original vendor C# source:
/// `Save_Recall_data { mode = 1, ch_x = slotIndex, buffers = name[32] }`.
///
/// `name` is truncated to 32 bytes and null-padded, matching how
/// `decode_name_field` reads it back. Truncation is on a byte boundary, so
/// non-ASCII input is rejected by the caller rather than risking a split
/// UTF-8 sequence — the device's name fields are ASCII.
pub fn build_store_packet(slot_index: u8, name: &str) -> Vec<u8> {
    let mut body = vec![0u8; PRESET_BODY_LEN];
    body[0] = PRESET_MODE_STORE;
    body[1] = slot_index;
    let bytes = name.as_bytes();
    let len = bytes.len().min(PRESET_NAME_LEN);
    body[2..2 + len].copy_from_slice(&bytes[..len]);
    build_control_packet(FC_SAVE_RECALL, 0, 0, 0, 0, &body)
}

/// Null-terminates then trims a fixed-width ASCII name field — same decode
/// style as `protocol.rs`'s `parse_basic_info_reply`.
fn decode_name_field(field: &[u8]) -> String {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).trim().to_string()
}

/// Parses a resolved `mode=0` frame (StructHeader+body+checksum). The
/// response is `N` concatenated 32-byte name fields with no mode/ch_x
/// prefix — slot count is derived from the body length (`16`/`24`/`40`
/// slots depending on device family), never hardcoded, mirroring
/// `parse_basic_info_reply`'s handling of multiple body-length variants.
/// Returns every slot exactly as decoded — empty/`"null"` filtering is a UI
/// display concern, not this parser's.
pub fn parse_preset_list(frame: &[u8]) -> Option<Vec<PresetSlot>> {
    if frame.len() < STRUCT_HEADER_LEN + CHECKSUM_LEN {
        return None;
    }
    let body = &frame[STRUCT_HEADER_LEN..frame.len() - CHECKSUM_LEN];
    if body.is_empty() || body.len() % PRESET_NAME_LEN != 0 {
        return None;
    }
    Some(
        body.chunks_exact(PRESET_NAME_LEN)
            .enumerate()
            .map(|(index, field)| PresetSlot { index: index as u32, name: decode_name_field(field) })
            .collect(),
    )
}

/// Parses a resolved `mode=4` frame: byte0=mode echo, byte1=ch_x (ignored),
/// bytes2-33=32-byte name of the currently-active preset. `>= 34` rather
/// than `== 34` to tolerate trailing padding, matching the reference
/// implementation's own length check.
pub fn parse_preset_current(frame: &[u8]) -> Option<String> {
    if frame.len() < STRUCT_HEADER_LEN + CHECKSUM_LEN {
        return None;
    }
    let body = &frame[STRUCT_HEADER_LEN..frame.len() - CHECKSUM_LEN];
    if body.len() < PRESET_BODY_LEN {
        return None;
    }
    Some(decode_name_field(&body[2..PRESET_BODY_LEN]))
}
