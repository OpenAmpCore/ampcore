//! CVR firmware 1.1.8 write/control command encoding.
//!
//! Ported from a prior web-based implementation of this same CVR controller
//! (`cvr-amp-controller-web`'s `lib/amp-device.ts` `FuncCode` table and
//! `app/api/amp-actions/route.ts`), itself confirmed against real 1.1.8
//! hardware and the original vendor C# source. Only the actions this app
//! currently exposes a Tauri command for are ported here — the reference has
//! many more (EQ bands, crossover, limiter, matrix gain, renaming, etc.),
//! to be added mechanically as each gets its own command.

use crate::data::capability::PowerMode;

use super::protocol::{build_control_packet, build_control_packet_with_status};

pub const FC_VOL: u8 = 9;
pub const FC_MUTE: u8 = 10;
pub const FC_SOURCE_SELECT: u8 = 11;
pub const FC_ROUTING: u8 = 12;
pub const FC_DELAY: u8 = 14;
pub const FC_STANDBY: u8 = 15;
pub const FC_ROTARY_LOCK: u8 = 17;
pub const FC_PHASE: u8 = 18;
pub const FC_FILTER_TYPE: u8 = 30;
pub const FC_FILTER_GAIN: u8 = 31;
pub const FC_FILTER_FREQ: u8 = 32;
pub const FC_FILTER_Q: u8 = 34;
pub const FC_DZ_DY: u8 = 49;
pub const FC_BRIDGE: u8 = 50;
pub const FC_PEAK_LIMITER: u8 = 54;
pub const FC_RMS_LIMITER: u8 = 55;
pub const FC_NOISE_GATE: u8 = 69;
pub const FC_SPEAKER_NAME: u8 = 77;
pub const FC_ANALOG_MATRIX_INPUT: u8 = 79;

/// Ported for the offline → online push (`data/amp_push.rs`), which needs a
/// write for every field the fingerprint hashes. Function codes are the
/// ordinals of the vendor source's `Struct_test.Gongneng` enum
/// (`Struct_test.cs:236-428`); each builder's doc comment names the vendor
/// call site its header/body layout was read from.
pub const FC_FILTER_CH_DATA: u8 = 52;
pub const FC_FIR_BYPASS: u8 = 44;
pub const FC_RMS_LIMITER_AUTO: u8 = 48;
pub const FC_CUSTOMER_NAME: u8 = 60;
pub const FC_SOURCE_DATA: u8 = 62;
pub const FC_PRIORITY_INPUTS: u8 = 80;

/// The device's per-channel name field is a fixed 16-byte null-padded ASCII
/// buffer — half the width of the 32-byte *preset* name field, so the two
/// are not interchangeable.
pub const CHANNEL_NAME_FIELD_LEN: usize = 16;

/// Shape of an FC=52 chain body: 10 slots of 14 bytes, then the trailing
/// chain-bypass byte. Mirrors `channel_config_v118::parse_eq_block`'s stride.
pub const EQ_CHAIN_BANDS: usize = 10;
pub const EQ_CHAIN_STRIDE: usize = 14;
pub const EQ_CHAIN_BODY_LEN: usize = EQ_CHAIN_BANDS * EQ_CHAIN_STRIDE + 1;

/// The device-name field is a fixed 32-byte null-padded ASCII buffer — twice
/// the width of the per-channel name field above, so the two are not
/// interchangeable (the vendor truncates to 32 in `InfoBar.xaml.cs:35-55`).
pub const DEVICE_NAME_FIELD_LEN: usize = 32;

const IN_OUT_FLAG_INPUT: u8 = 0;
const IN_OUT_FLAG_OUTPUT: u8 = 1;

/// FC=10 MUTE, `in_out_flag=1` (output). Wire body: `0x00`=muted,
/// `0x01`=unmuted — inverted relative to the boolean, confirmed against the
/// reference's `muteOut` action.
pub fn build_set_output_mute(channel_index: u8, muted: bool) -> Vec<u8> {
    let body = [if muted { 0x00 } else { 0x01 }];
    build_control_packet(FC_MUTE, channel_index, 0, 0, IN_OUT_FLAG_OUTPUT, &body)
}

/// FC=10 MUTE, `in_out_flag=0` (input) — same body convention as output mute.
pub fn build_set_input_mute(channel_index: u8, muted: bool) -> Vec<u8> {
    let body = [if muted { 0x00 } else { 0x01 }];
    build_control_packet(FC_MUTE, channel_index, 0, 0, IN_OUT_FLAG_INPUT, &body)
}

/// FC=9 VOL, `in_out_flag=1` (output). Wire body: `f32` LE dB. Confirmed
/// against the reference's `outputTrim` action.
pub fn build_set_output_trim(channel_index: u8, trim_db: f32) -> Vec<u8> {
    build_control_packet(
        FC_VOL,
        channel_index,
        0,
        0,
        IN_OUT_FLAG_OUTPUT,
        &trim_db.to_le_bytes(),
    )
}

/// FC=9 VOL, `in_out_flag=0` — same function code as trim but the *input*
/// flag, despite this being an output-path control. Confirmed against the
/// reference's `volumeOut` action/comment: "Observed devices apply this
/// control to the output path even though the working packet shape still
/// uses in_out_flag=0."
pub fn build_set_output_volume(channel_index: u8, volume_db: f32) -> Vec<u8> {
    build_control_packet(
        FC_VOL,
        channel_index,
        0,
        0,
        IN_OUT_FLAG_INPUT,
        &volume_db.to_le_bytes(),
    )
}

/// FC=14 DELAY, `in_out_flag=0` (input). Wire body: `f32` LE ms.
pub fn build_set_delay_in(channel_index: u8, delay_ms: f32) -> Vec<u8> {
    build_control_packet(
        FC_DELAY,
        channel_index,
        0,
        0,
        IN_OUT_FLAG_INPUT,
        &delay_ms.to_le_bytes(),
    )
}

/// FC=14 DELAY, `in_out_flag=1` (output). Wire body: `f32` LE ms.
pub fn build_set_delay_out(channel_index: u8, delay_ms: f32) -> Vec<u8> {
    build_control_packet(
        FC_DELAY,
        channel_index,
        0,
        0,
        IN_OUT_FLAG_OUTPUT,
        &delay_ms.to_le_bytes(),
    )
}

/// FC=17 ROTARY_LOCK, `chx=0`, `in_out_flag=0`. Wire body: `0x01`=front-panel
/// knobs locked, `0x00`=unlocked. Function code from the vendor source's
/// `Struct_test.Gongneng` enum (17th entry, after STANDBY/RESET); body and
/// header fields from the reference web app's `setAmpLock` action. Read back
/// through FC=27's `rotary_locked`.
pub fn build_set_rotary_lock(locked: bool) -> Vec<u8> {
    let body = [u8::from(locked)];
    build_control_packet(FC_ROTARY_LOCK, 0, 0, 0, IN_OUT_FLAG_INPUT, &body)
}

/// FC=15 STANDBY, `chx=0`, `in_out_flag=0`. Wire body: `0x01`=standby,
/// `0x00`=powered on.
///
/// Note the `status_code` of **0**, which no other write in this app uses.
/// The vendor source calls the `SendStruct(..., Responsed.Response, ...)`
/// overload for this one command (`Variable\Basic.cs`), where every other
/// write goes through the `NOT_Response` (1) path; the reference web app's
/// `setAmpStandby` records the same thing from a captured frame of the
/// original software. Sending the usual `1` here is therefore untested and
/// would be a guess.
///
/// Read back through FC=27's `standby` (absolute body byte 32), which is also
/// where the "standby locked out" state comes from — see
/// `channel_config_v118.rs`.
pub fn build_set_standby(standby: bool) -> Vec<u8> {
    let body = [u8::from(standby)];
    build_control_packet_with_status(FC_STANDBY, 0, 0, 0, 0, IN_OUT_FLAG_INPUT, &body)
}

/// FC=18 PHASE, `in_out_flag=1` (output). Wire body: `0x01`=inverted,
/// `0x00`=normal.
pub fn build_set_phase_invert(channel_index: u8, inverted: bool) -> Vec<u8> {
    let body = [if inverted { 0x01 } else { 0x00 }];
    build_control_packet(FC_PHASE, channel_index, 0, 0, IN_OUT_FLAG_OUTPUT, &body)
}

/// FC=49 DZ_DY, `in_out_flag=1` (output). Wire body: `0`=Low-Ohm, `1`=70V,
/// `2`=100V.
pub fn build_set_power_mode(channel_index: u8, mode: PowerMode) -> Vec<u8> {
    let code: u8 = match mode {
        PowerMode::LowOhm => 0,
        PowerMode::V70 => 1,
        PowerMode::V100 => 2,
    };
    build_control_packet(FC_DZ_DY, channel_index, 0, 0, IN_OUT_FLAG_OUTPUT, &[code])
}

/// FC=30 FILTER_TYPE. Body: the wire type code as-is when `active`,
/// `255 - type_code` when not — the same "enabled=type, bypassed=255-type"
/// convention this app's own read-side parsing already relies on
/// (`channel_config_v118.rs`). Used for both parametric bands (`segment`
/// 1-8) and HP/LP crossover slots (`segment` 0=HP / 9=LP) — the wire
/// encoding is identical, only `segment` (and, for a crossover slot, the
/// follow-up `CROSSOVER_COMMIT_PACKET`) differs. `type_code` is resolved by
/// the caller via `channel_config_v118::eq_filter_type_code`/
/// `crossover_filter_type_code` — kept as a plain `u8` here rather than
/// generic over which of the two disjoint filter-type enums applies.
pub fn build_set_eq_filter_type(
    channel_index: u8,
    in_out_flag: u8,
    segment: u8,
    type_code: u8,
    active: bool,
) -> Vec<u8> {
    let body = [if active { type_code } else { 255 - type_code }];
    build_control_packet(
        FC_FILTER_TYPE,
        channel_index,
        segment,
        0,
        in_out_flag,
        &body,
    )
}

/// FC=32 FILTER_FREQ. Wire body: `f32` LE Hz. `segment`: 1-8 for a
/// parametric band, 0=HP/9=LP for a crossover slot.
pub fn build_set_eq_freq(channel_index: u8, in_out_flag: u8, segment: u8, freq_hz: f32) -> Vec<u8> {
    build_control_packet(
        FC_FILTER_FREQ,
        channel_index,
        segment,
        0,
        in_out_flag,
        &freq_hz.to_le_bytes(),
    )
}

/// FC=31 FILTER_GAIN. Wire body: `f32` LE dB. Parametric bands only —
/// `CrossoverSlot` has no gain to write.
pub fn build_set_eq_gain(
    channel_index: u8,
    in_out_flag: u8,
    band_index: u8,
    gain_db: f32,
) -> Vec<u8> {
    build_control_packet(
        FC_FILTER_GAIN,
        channel_index,
        band_index,
        0,
        in_out_flag,
        &gain_db.to_le_bytes(),
    )
}

/// FC=34 FILTER_Q. Wire body: `f32` LE. Parametric bands only.
pub fn build_set_eq_q(channel_index: u8, in_out_flag: u8, band_index: u8, q: f32) -> Vec<u8> {
    build_control_packet(
        FC_FILTER_Q,
        channel_index,
        band_index,
        0,
        in_out_flag,
        &q.to_le_bytes(),
    )
}

/// One slot of an FC=52 chain body. `type_code` is the same code space
/// `build_set_eq_filter_type` uses; `active` is sign-encoded into it, not sent
/// separately.
pub struct EqChainBand {
    pub type_code: u8,
    pub active: bool,
    pub gain_db: f32,
    pub freq_hz: f32,
    pub q: f32,
}

/// FC=52 FILTER_CH_DATA — one whole 10-band EQ chain in a single packet, for
/// whichever side `in_out_flag` selects (0 = input, 1 = output). Replaces the
/// up-to-38 per-band FC=30/31/32/34 writes (plus two crossover commits) the
/// same chain would otherwise cost.
///
/// Wire body (141 bytes): 10 × `[i8 type][f32 LE gain_db][f32 LE freq_hz]
/// [f32 LE q][u8 reset]`, then one trailing `u8` chain-bypass byte. Slot 0 is
/// the HP crossover and slot 9 the LP (their own type vocabulary); slots 1..=8
/// are the parametric bands.
///
/// **This body is byte-for-byte what `channel_config_v118::parse_eq_block`
/// already reads** out of the FC=27 snapshot at channel offsets 121/262 — the
/// same stride, field order and `255 - type` bypass encoding. That read has
/// been right against real hardware since long before anything wrote it,
/// which is what makes this write auditable rather than a guess.
///
/// Two deliberate departures from every other builder here:
///
/// - **`status_code` is 0**, not 1. Every single-device vendor writer sends
///   `Responsed.Response`: `Variable\EQdata_CH.cs:143`, and the hand-built
///   headers in `MyWindows\EQWindow_Input_TongDao.xaml.cs:332-350` and
///   `MyWindows1\OutEQ10Window.xaml.cs:364`. (Group broadcasts use 1, reads
///   use 2.) Only FC=15 STANDBY otherwise needs this.
/// - **No commit packet.** Not one of the vendor's ten FC=52 send sites emits
///   a follow-up; the single datagram is the whole transaction. That is what
///   lets this subsume the HP/LP writes, which on the per-band path each need
///   `write::CROSSOVER_COMMIT_PACKET` after them.
///
/// `reset` is always 0 — the vendor leaves `f_CH_reset` at its struct default
/// (`Variable\EQDotData_CH.cs:266-274`). `chain_bypass` (0 = chain active) is
/// passed in rather than assumed, so callers echo what the amp reported; 110
/// must never be sent, as the vendor uses it as a "no reply yet" sentinel.
///
/// Gain and Q go out for every slot regardless of filter type, matching the
/// vendor: the body has no way to omit them, and the fingerprint already
/// ignores a gain/Q the type doesn't use.
pub fn build_set_eq_chain(
    channel_index: u8,
    in_out_flag: u8,
    bands: &[EqChainBand; EQ_CHAIN_BANDS],
    chain_bypass: u8,
) -> Vec<u8> {
    let mut body = [0u8; EQ_CHAIN_BODY_LEN];
    for (slot, band) in bands.iter().enumerate() {
        let off = slot * EQ_CHAIN_STRIDE;
        // Same inversion as `build_set_eq_filter_type`: `255 - t` as a byte is
        // the C# `-t - 1` as an sbyte.
        body[off] = if band.active { band.type_code } else { 255 - band.type_code };
        body[off + 1..off + 5].copy_from_slice(&band.gain_db.to_le_bytes());
        body[off + 5..off + 9].copy_from_slice(&band.freq_hz.to_le_bytes());
        body[off + 9..off + 13].copy_from_slice(&band.q.to_le_bytes());
        // body[off + 13] — `reset`, stays 0.
    }
    body[EQ_CHAIN_BANDS * EQ_CHAIN_STRIDE] = chain_bypass;
    build_control_packet_with_status(FC_FILTER_CH_DATA, 0, channel_index, 0, 0, in_out_flag, &body)
}

/// FC=12 ROUTING, `in_out_flag=1` (output). `chx` is the *output* channel,
/// `segment` the source position within that channel's matrix row. Wire
/// body: `[f32 LE gain_db][u8 active]`.
///
/// Both fields ride in every packet — there is no partial matrix write on
/// the wire — so callers changing only one must supply the crosspoint's
/// current value for the other (see `live_control_set_matrix_crosspoint`,
/// which merges against the last FC=27 snapshot). The reference's
/// `matrixActive` action sends a hardcoded 0 dB when toggling, which
/// silently discards a configured gain; merging avoids that.
pub fn build_set_matrix_crosspoint(
    channel_index: u8,
    source_index: u8,
    gain_db: f32,
    active: bool,
) -> Vec<u8> {
    let mut body = [0u8; 5];
    body[..4].copy_from_slice(&gain_db.to_le_bytes());
    body[4] = u8::from(active);
    build_control_packet(
        FC_ROUTING,
        channel_index,
        source_index,
        0,
        IN_OUT_FLAG_OUTPUT,
        &body,
    )
}

/// FC=69 NOISE_GATE, `in_out_flag=1` (output). Wire body on 1.1.8 is a
/// single byte and, like MUTE, is *inverted*: `0x00`=enabled, `0x01`=
/// disabled.
///
/// 1.1.8 carries no threshold on the wire — the 2-byte
/// `[enable][threshold]` form is a 1.1.9+ extension (see
/// `write_v119::build_set_noise_gate`). That matches
/// `CvrFirmwareCapability.noise_gate_threshold`, which this app already uses
/// to hide the threshold input on 1.1.8.
pub fn build_set_noise_gate(channel_index: u8, enabled: bool) -> Vec<u8> {
    let body = [if enabled { 0x00 } else { 0x01 }];
    build_control_packet(
        FC_NOISE_GATE,
        channel_index,
        0,
        0,
        IN_OUT_FLAG_OUTPUT,
        &body,
    )
}

/// FC=55 RMS_LIMITER, `in_out_flag=1` (output). Wire body (8 bytes):
/// `[u16 LE attack_ms][u8 release_multiplier][f32 LE threshold_vrms][u8 bypass]`,
/// where the trailing byte is `0x00`=enabled / `0x01`=bypassed — the same
/// inversion MUTE and NOISE_GATE use.
///
/// Note the `f32` at offset 3 is *unaligned* in the body; it is written
/// byte-wise here, exactly as the reference's `writeFloatLE(…, 3)` does.
///
/// The reference also has a one-byte bypass-only fallback for when just the
/// enable flag is known. This app always holds the full stage (the FC=27
/// snapshot parses every field), so the full-payload form is the only one
/// built — a bypass-only write would otherwise have to invent values for the
/// three parameters it does not carry.
///
/// That fallback is **FC=46**, not FC=48: the reference's
/// `FuncCode.RMS_BYPASS = 48` is wrong against the vendor enum, where 46 is
/// `RMS_Limiter_bypas_code` and 48 is `RMS_Limiter_auto_code`. So the
/// reference's fallback path toggles *auto*, with inverted meaning. FC=48 is
/// ported here as what it actually is — see `build_set_rms_limiter_auto`.
///
/// The vendor's own FC=55 record is 13 bytes, appending `[u8 auto][f32 max]`
/// to the 8 written here. Neither is sent: `max_vrms` is a device-determined
/// rating this app never changes, and `auto` has its own function code. The
/// vendor itself leaves both at 0 in its link-push path, so the firmware
/// plausibly ignores the trailing bytes on write anyway.
pub fn build_set_rms_limiter(
    channel_index: u8,
    enabled: bool,
    threshold_vrms: f32,
    attack_ms: u16,
    release_multiplier: u8,
) -> Vec<u8> {
    let mut body = [0u8; 8];
    body[..2].copy_from_slice(&attack_ms.to_le_bytes());
    body[2] = release_multiplier;
    body[3..7].copy_from_slice(&threshold_vrms.to_le_bytes());
    body[7] = if enabled { 0x00 } else { 0x01 };
    build_control_packet(
        FC_RMS_LIMITER,
        channel_index,
        0,
        0,
        IN_OUT_FLAG_OUTPUT,
        &body,
    )
}

/// FC=54 PEAK_LIMITER, `in_out_flag=1` (output). Wire body (9 bytes):
/// `[u16 LE hold_ms][u16 LE release_ms][f32 LE threshold_vp][u8 bypass]`,
/// same `0x00`=enabled / `0x01`=bypassed convention as the RMS stage. Same
/// rationale as `build_set_rms_limiter` for not porting the FC=47
/// bypass-only fallback.
pub fn build_set_peak_limiter(
    channel_index: u8,
    enabled: bool,
    threshold_vp: f32,
    hold_ms: u16,
    release_ms: u16,
) -> Vec<u8> {
    let mut body = [0u8; 9];
    body[..2].copy_from_slice(&hold_ms.to_le_bytes());
    body[2..4].copy_from_slice(&release_ms.to_le_bytes());
    body[4..8].copy_from_slice(&threshold_vp.to_le_bytes());
    body[8] = if enabled { 0x00 } else { 0x01 };
    build_control_packet(
        FC_PEAK_LIMITER,
        channel_index,
        0,
        0,
        IN_OUT_FLAG_OUTPUT,
        &body,
    )
}

/// FC=77 SPEAKER_NAME. Renames one side of a channel: `in_out_flag=0`
/// renames the input, `=1` the output — the only difference between the two,
/// confirmed by the reference's Wireshark note on `renameInput`/
/// `renameOutput`. Wire body: 16-byte null-padded ASCII.
///
/// `name` is truncated on a byte boundary, so callers must reject non-ASCII
/// before calling (see `live_control_set_channel_name`) rather than risk
/// splitting a UTF-8 sequence.
pub fn build_set_channel_name(channel_index: u8, in_out_flag: u8, name: &str) -> Vec<u8> {
    let mut body = [0u8; CHANNEL_NAME_FIELD_LEN];
    let bytes = name.as_bytes();
    let len = bytes.len().min(CHANNEL_NAME_FIELD_LEN);
    body[..len].copy_from_slice(&bytes[..len]);
    build_control_packet(FC_SPEAKER_NAME, channel_index, 0, 0, in_out_flag, &body)
}

/// FC=11 SOURCE_SELECT, `in_out_flag=0` (input). Wire body: one byte,
/// `0`=Analog, `1`=Dante, `2`=AES3 — the same code space
/// `channel_config_v118::source` decodes on the read side, so the two stay
/// in agreement by construction.
pub fn build_set_source_select(channel_index: u8, source_code: u8) -> Vec<u8> {
    build_control_packet(
        FC_SOURCE_SELECT,
        channel_index,
        0,
        0,
        IN_OUT_FLAG_INPUT,
        &[source_code],
    )
}

/// FC=79 ANALOG_MATRIX_INPUT, `in_out_flag=0`. Wire body: one byte, the
/// 0-based physical analog input that feeds `channel_index`. Matches the
/// vendor's `AnalogType` send (`SendStruct(Analog_Matrix_input, ch, b)`, a
/// header with no flag/segment/link) and the reference's `analogType` action.
/// Read back from the FC=27 trailer's analog-matrix bytes (`trailer+136+ch`).
pub fn build_set_analog_input(channel_index: u8, analog_input_index: u8) -> Vec<u8> {
    build_control_packet(
        FC_ANALOG_MATRIX_INPUT,
        channel_index,
        0,
        0,
        IN_OUT_FLAG_INPUT,
        &[analog_input_index],
    )
}

/// FC=50 BRIDGE, `in_out_flag=0`. Wire body is inverted like MUTE:
/// `0x00`=bridged, `0x01`=independent.
///
/// `chx` is the **pair index** (0 = outputs A/B, 1 = C/D), *not* the pair's
/// leader channel index. The two coincide for pair 0 and diverge for every
/// pair after it, which is exactly how the original bug presented: bridging
/// A/B worked and C/D silently did nothing, because it sent `chx=2` for a
/// device that only recognises 0 and 1.
///
/// Same addressing as the read side — `parse_bridge_reply` takes the pair
/// straight out of the reply's `chx`, and the driver's poll queries `chx=0`
/// and `chx=1` — so read and write now agree by construction. The reference
/// implementation does the same (`sendSingle(..., "bridgePair", pair, ...)`
/// passes a pair, never a channel).
pub fn build_set_output_bridge(pair_index: u8, bridged: bool) -> Vec<u8> {
    let body = [if bridged { 0x00 } else { 0x01 }];
    build_control_packet(FC_BRIDGE, pair_index, 0, 0, IN_OUT_FLAG_INPUT, &body)
}

/// FC=44 FIR_BYPASS, `in_out_flag=1` (output). Wire body: one byte,
/// `0x01`=bypassed / `0x00`=active — the same polarity the read side decodes
/// at `channel_config_v118.rs`'s `fir_bypassed` (`// inverted: 0=enabled`),
/// so read and write agree by construction.
///
/// From the vendor's `Variable\Channels.cs:732-746`, which sends
/// `struct FIR_Bypass { byte fir_bypass; }` with `Gongneng.FIR_bypass`. The
/// vendor puts the FIR *link group* bitmask in the header's `link` field; this
/// app has no link groups (they were removed from the model in schema 6), so
/// `link` stays 0 like every other builder here.
pub fn build_set_fir_bypass(channel_index: u8, bypassed: bool) -> Vec<u8> {
    let body = [u8::from(bypassed)];
    build_control_packet(FC_FIR_BYPASS, channel_index, 0, 0, IN_OUT_FLAG_OUTPUT, &body)
}

/// FC=48 RMS_LIMITER_AUTO, `in_out_flag=1` (output). Wire body: one byte,
/// **inverted** — `0x00`=auto on, `0x01`=auto off.
///
/// From the vendor's `Variable\Channels_out.cs:727-735`
/// (`rms_Limiter_Auto.RMS_Limiter_auto = (flag ? 0 : 1)`), matching the read
/// side's `auto: u8_at(body, at(103)) == 0`.
///
/// This is a *separate* packet from `build_set_rms_limiter`: the vendor's full
/// FC=55 record does carry an `auto` byte, but this app deliberately sends the
/// shorter 8-byte body (see that builder), so auto travels on its own code —
/// which is also what the vendor GUI does when the auto switch is toggled.
pub fn build_set_rms_limiter_auto(channel_index: u8, auto: bool) -> Vec<u8> {
    let body = [if auto { 0x00 } else { 0x01 }];
    build_control_packet(FC_RMS_LIMITER_AUTO, channel_index, 0, 0, IN_OUT_FLAG_OUTPUT, &body)
}

/// FC=60 CUSTOMER_NAME_MODIFY, `chx=0`, `in_out_flag=0`. Wire body: 32-byte
/// null-padded ASCII — the amp's user-set name, read back through FC=0
/// BASIC_INFO (never FC=27, whose header holds the firmware/model ID string;
/// see `fingerprint.rs`'s version-7 note).
///
/// From the vendor's `MyControls1\InfoBar.xaml.cs:35-55`. The vendor also
/// sends the same code with `chx=1` and a 16-byte body to overwrite the
/// device's *model* string (`ControlWindow.xaml.cs:832-843`) — deliberately
/// not ported: nothing in this app should rewrite a device's model identity.
///
/// `name` is truncated on a byte boundary, so callers must reject non-ASCII
/// first, exactly as `build_set_channel_name` requires.
pub fn build_set_device_name(name: &str) -> Vec<u8> {
    let mut body = [0u8; DEVICE_NAME_FIELD_LEN];
    let bytes = name.as_bytes();
    let len = bytes.len().min(DEVICE_NAME_FIELD_LEN);
    body[..len].copy_from_slice(&bytes[..len]);
    build_control_packet(FC_CUSTOMER_NAME, 0, 0, 0, IN_OUT_FLAG_INPUT, &body)
}

/// FC=62 SOURCE_DATA, `in_out_flag=0` (input). Wire body (8 bytes):
/// `[f32 LE trim_db][f32 LE delay_ms]` — the vendor's `gain_matching_data`
/// struct (`Struct_test.cs:1462-1471`).
///
/// The `segment` header field selects *which* source family the pair applies
/// to: 0=Analog, 1=Dante (2 was AES3, which this app no longer supports —
/// `SourceTrimFamily` leaves the gap rather than renumbering a device-side
/// value), matching the read side's `analog_`/`dante_` trim+delay offsets.
/// One function code serves every value.
///
/// Trim and delay always travel together — there is no partial form, so the
/// vendor re-reads the sibling value and re-sends it
/// (`Variable\Channels.cs:588-634`). Callers must pass both.
pub fn build_set_source_trim(channel_index: u8, segment: u8, trim_db: f32, delay_ms: f32) -> Vec<u8> {
    let mut body = [0u8; 8];
    body[..4].copy_from_slice(&trim_db.to_le_bytes());
    body[4..].copy_from_slice(&delay_ms.to_le_bytes());
    build_control_packet(FC_SOURCE_DATA, channel_index, segment, 0, IN_OUT_FLAG_INPUT, &body)
}

/// FC=80 PRIORITY_INPUTS, `in_out_flag=0` (input). Wire body (4 bytes):
/// `[first u8][second u8][enabled u8][threshold i8]` — the vendor's
/// `StruPriority`, built at `Variable\Channels.cs:794-803`.
///
/// `first`/`second` are source codes in the **same space as
/// `FC_SOURCE_SELECT`** (0=Analog, 1=Dante), and `enabled` is a plain 0/1,
/// not a mode. `threshold_db` is signed and negative in practice (-80..0),
/// hence `i8` — the one field where a sign error would be silent.
///
/// There is deliberately no hold/revert time: the vendor's struct and UI have
/// no such field, so the amp's own hysteresis is all there is.
///
/// **Only the 3-source `StruPriority` form is emitted.** The vendor switches
/// to a shorter `PriorityDD` payload when the device reports flow letter "K"
/// (`Channels.cs:683-690`); no supported model is known to do so, and that
/// form's `mode`/`sourceIden` fields are used inconsistently between the
/// vendor's own read and write paths, so it is not guessed at here. If a
/// flow-K device ever turns up, this needs revisiting rather than extending.
pub fn build_set_backup_priority(
    channel_index: u8,
    first: u8,
    second: u8,
    enabled: bool,
    threshold_db: i8,
) -> Vec<u8> {
    let body = [first, second, u8::from(enabled), threshold_db as u8];
    build_control_packet(FC_PRIORITY_INPUTS, channel_index, 0, 0, IN_OUT_FLAG_INPUT, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the FC=15 frame, above all its `status_code` of 0 — the one field
    /// that makes this command different from every other write here, and the
    /// one a future "why is standby not using `build_control_packet` like
    /// everything else?" cleanup would quietly normalize away.
    ///
    /// The bytes come from this module's own already-ground-truthed header and
    /// checksum builders, so this is a regression lock on the encoding, not
    /// independent proof of what the hardware wants — that part is verified
    /// against a real amp.
    #[test]
    fn standby_frame_uses_status_code_zero() {
        let packet = build_set_standby(true);
        assert_eq!(
            packet,
            vec![
                // NetworkData: flag 0xd903 little-endian (so 0x03 first),
                // machine_mode=0, count=1, frame_len=14, step=1, state=0, pad
                0x03, 0xd9, 0x00, 0x00, 0x01, 0x0e, 0x00, 0x01, 0x00, 0x00,
                // StructHeader: 0x55, FC=15, status=0, chx=0, seg=0, link=0, in_out=0
                0x55, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                // Standby_data = 1
                0x01,
                // checksum: hi, lo, sum
                0x00, 0x0e, 0x73,
            ]
        );
        // Only the body byte differs between standby and powered-on.
        let on = build_set_standby(false);
        assert_eq!(on[20], 0x00);
        assert_eq!(on[12], 0x00, "status_code stays 0 in both directions");
    }

    /// Struct-header fields of a control frame: `(fc, status, chx, segment,
    /// in_out_flag)`, plus the body. The four push-only codes below are
    /// ported from the vendor C# source and have not yet been confirmed
    /// against hardware, so these pin exactly what was read out of it — the
    /// header field each value lands in is the part that is easy to get
    /// silently wrong (FC=62's source family rides in `segment`, FC=60 is
    /// amp-level so `chx` must stay 0).
    fn decode(packet: &[u8]) -> ((u8, u8, u8, u8, u8), Vec<u8>) {
        let header = &packet[10..20];
        assert_eq!(header[0], 0x55, "struct header magic");
        let body = packet[20..packet.len() - 3].to_vec();
        ((header[1], header[2], header[3], header[4], header[9]), body)
    }

    #[test]
    fn fir_bypass_frame() {
        let (header, body) = decode(&build_set_fir_bypass(2, true));
        assert_eq!(header, (44, 1, 2, 0, 1));
        assert_eq!(body, vec![0x01], "1 = bypassed, matching the read side");
        let (_, body) = decode(&build_set_fir_bypass(2, false));
        assert_eq!(body, vec![0x00]);
    }

    #[test]
    fn rms_limiter_auto_frame_is_inverted() {
        let (header, body) = decode(&build_set_rms_limiter_auto(1, true));
        assert_eq!(header, (48, 1, 1, 0, 1));
        assert_eq!(body, vec![0x00], "auto on is 0 — the vendor's `flag ? 0 : 1`");
        let (_, body) = decode(&build_set_rms_limiter_auto(1, false));
        assert_eq!(body, vec![0x01]);
    }

    #[test]
    fn device_name_frame_is_amp_level() {
        let (header, body) = decode(&build_set_device_name("Stage Left"));
        assert_eq!(header, (60, 1, 0, 0, 0), "chx stays 0: this is not a channel write");
        assert_eq!(body.len(), DEVICE_NAME_FIELD_LEN, "32 bytes, not the channel field's 16");
        assert_eq!(&body[..10], b"Stage Left");
        assert!(body[10..].iter().all(|b| *b == 0), "null-padded");
    }

    #[test]
    fn device_name_frame_truncates_to_the_field() {
        let (_, body) = decode(&build_set_device_name(&"x".repeat(40)));
        assert_eq!(body.len(), DEVICE_NAME_FIELD_LEN);
        assert!(body.iter().all(|b| *b == b'x'));
    }

    /// The source family is the `segment` field, not part of the body — the
    /// one detail that makes every trim share a single function code.
    /// Segment 2 was AES3 and is no longer produced by any caller
    /// (`SourceTrimFamily` has no such variant), so only 0/1 are exercised.
    #[test]
    fn source_trim_frame_carries_family_in_segment() {
        for (segment, trim, delay) in [(0u8, 1.5f32, 0.25f32), (1, -2.0, 3.5)] {
            let (header, body) = decode(&build_set_source_trim(3, segment, trim, delay));
            assert_eq!(header, (62, 1, 3, segment, 0));
            assert_eq!(body.len(), 8);
            assert_eq!(f32::from_le_bytes(body[..4].try_into().unwrap()), trim);
            assert_eq!(f32::from_le_bytes(body[4..].try_into().unwrap()), delay);
        }
    }

    /// Pins the FC=80 frame. The threshold is the field worth a test of its
    /// own: it is signed and negative in normal use, so encoding it as a
    /// plain `u8` would send 176 for -80 and the amp would read a threshold
    /// it never offers.
    #[test]
    fn backup_priority_frame_encodes_signed_threshold() {
        let (header, body) = decode(&build_set_backup_priority(2, 0, 1, true, -80));
        assert_eq!(header, (80, 1, 2, 0, 0));
        assert_eq!(body, vec![0, 1, 1, 0xB0]);
        assert_eq!(body[3] as i8, -80);

        // Disabled, reversed priority, and a 0 dB threshold — the other end
        // of each field's range.
        let (_, body) = decode(&build_set_backup_priority(0, 1, 0, false, 0));
        assert_eq!(body, vec![1, 0, 0, 0]);
    }

    fn chain_band(type_code: u8, active: bool) -> EqChainBand {
        EqChainBand { type_code, active, gain_db: -3.5, freq_hz: 1000.0, q: 0.7 }
    }

    /// Pins the FC=52 frame. Two fields here are unlike every other write in
    /// this module and would be silently "cleaned up" by someone normalizing
    /// the builders: the `status_code` of 0, and `segment` staying 0 because
    /// the band index rides in the body rather than the header.
    ///
    /// The layout itself is cross-checked by `channel_config_v118`'s parser
    /// reading the same bytes out of FC=27, so this is a regression lock on
    /// the header and the slot ordering, not independent proof of the wire
    /// format.
    #[test]
    fn eq_chain_frame() {
        let mut bands: [EqChainBand; EQ_CHAIN_BANDS] = std::array::from_fn(|_| chain_band(0, true));
        // Slot 0 = HP, slot 9 = LP, slot 3 bypassed.
        bands[0] = EqChainBand { type_code: 4, active: true, gain_db: 0.0, freq_hz: 110.0, q: 1.41 };
        bands[9] = EqChainBand { type_code: 6, active: false, gain_db: 0.0, freq_hz: 19900.0, q: 1.0 };
        bands[3] = chain_band(2, false);

        let packet = build_set_eq_chain(2, IN_OUT_FLAG_OUTPUT, &bands, 0);
        let (header, body) = decode(&packet);
        assert_eq!(header, (52, 0, 2, 0, 1), "status 0 and segment 0 are both load-bearing");
        assert_eq!(body.len(), EQ_CHAIN_BODY_LEN);

        // HP in slot 0, LP in slot 9 — the ordering `parse_eq_block` reads.
        assert_eq!(body[0], 4);
        assert_eq!(f32::from_le_bytes(body[5..9].try_into().unwrap()), 110.0);
        let lp = 9 * EQ_CHAIN_STRIDE;
        assert_eq!(f32::from_le_bytes(body[lp + 5..lp + 9].try_into().unwrap()), 19900.0);

        // Bypass is sign-encoded into the type byte, the same `255 - t` the
        // parser decodes and `build_set_eq_filter_type` emits.
        assert_eq!(body[9 * EQ_CHAIN_STRIDE], 255 - 6, "bypassed LP");
        assert_eq!(body[3 * EQ_CHAIN_STRIDE], 255 - 2, "bypassed band");
        assert_eq!(body[1 * EQ_CHAIN_STRIDE], 0, "active band keeps its code");

        // Gain and Q go out for every slot; `reset` never does.
        let band = 1 * EQ_CHAIN_STRIDE;
        assert_eq!(f32::from_le_bytes(body[band + 1..band + 5].try_into().unwrap()), -3.5);
        assert_eq!(f32::from_le_bytes(body[band + 9..band + 13].try_into().unwrap()), 0.7);
        for slot in 0..EQ_CHAIN_BANDS {
            assert_eq!(body[slot * EQ_CHAIN_STRIDE + 13], 0, "reset byte of slot {slot}");
        }

        // The chain-bypass byte is echoed, never assumed.
        assert_eq!(*body.last().unwrap(), 0);
        let (_, body) = decode(&build_set_eq_chain(2, IN_OUT_FLAG_OUTPUT, &bands, 1));
        assert_eq!(*body.last().unwrap(), 1);
    }
}
