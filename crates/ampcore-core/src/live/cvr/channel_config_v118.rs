//! CVR firmware 1.1.8 FC=27 (SYNC_DATA) response -> per-channel DSP config.
//! Ground-truthed against the reference implementation's
//! `lib/parse-channel-data.ts`, which itself documents these offsets as
//! "empirically confirmed by diffing live snapshots with known [device]
//! states" — this is real, not guessed, data.
//!
//! Unlike that reference (and unlike this app's own earlier heartbeat
//! telemetry work before this file), channel/trailer geometry here is
//! derived from the device's *real known* `firmware_family` (1.1.8's fixed
//! trailer size — see `TRAILER_SIZE_V118`), not from guessing the layout by
//! testing which length-modulo-515 arithmetic happens to divide evenly — see
//! `channel_config.rs`'s module doc for why that guess-based approach is
//! being deliberately avoided. Note the trailer size itself was corrected
//! from the reference's documented value based on real hardware traffic —
//! see `TRAILER_SIZE_V118`'s doc.
//!
//! `prmsW`/`ppeakW` (wattage computed from limiter thresholds × load
//! impedance) are not parsed here — the reference computes them downstream,
//! dependent on data (configured load impedance) this parser doesn't have.

use crate::data::capability::{CrossoverFilterType, EqFilterType, PowerMode, SourceKind};
use crate::data::common::now_millis;
use crate::data::project::{
    BackupPriority, ChannelEq, ChannelSource, CrossoverSlot, EqBand, Limiter, MatrixCrosspoint, PeakLimiter, RmsLimiter,
};

use super::channel_config::{ChannelConfig, ChannelConfigSnapshot, EqChainWire};

/// 172, NOT the reference implementation's documented 192 — this value is
/// corrected from direct measurement against real hardware (a 1.1.8
/// `DSP-2004`), not carried over from the reference. Its FC=27 replies
/// consistently assemble to exactly `4*515 + 172 + 13 (StructHeader+
/// checksum) = 2245` bytes, an exact division with no remainder — the
/// reference's 192 does not divide evenly against this device's real
/// traffic at all. The trailer's *internal* field offsets below
/// (muteIn@132, analog-matrix@136, rotary-lock@33, backup-priority@140/176)
/// are still only as verified as the reference documented them — this fix
/// corrects the trailer's total *size* (and therefore channel-count
/// derivation), not necessarily every byte's meaning within it. Worth
/// testing those specifically (e.g. toggle a real channel's mute and confirm
/// the parsed `inputMuted` flips) now that geometry derivation succeeds.
pub const TRAILER_SIZE_V118: usize = 172;
pub const BYTES_PER_CHANNEL: usize = 515;

fn f32_le(body: &[u8], abs: usize) -> f32 {
    body.get(abs..abs + 4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).unwrap_or(0.0)
}

fn u16_le(body: &[u8], abs: usize) -> u16 {
    body.get(abs..abs + 2).map(|b| u16::from_le_bytes([b[0], b[1]])).unwrap_or(0)
}

fn u8_at(body: &[u8], abs: usize) -> u8 {
    body.get(abs).copied().unwrap_or(0)
}

fn i8_at(body: &[u8], abs: usize) -> i8 {
    u8_at(body, abs) as i8
}

/// 16-byte ASCII, NUL-terminated. `None` for an empty/all-NUL field, rather
/// than the reference's synthetic `"Ch{n}{field}"` fallback label — an
/// absent name should read as absent, not as fabricated placeholder text.
fn ascii_16(body: &[u8], abs: usize) -> Option<String> {
    ascii_n(body, abs, 16)
}

/// `ascii_16` for any fixed field width (device and preset names are 32).
fn ascii_n(body: &[u8], abs: usize, len: usize) -> Option<String> {
    let bytes = body.get(abs..abs + len)?;
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    if end == 0 {
        return None;
    }
    let s = String::from_utf8_lossy(&bytes[..end]).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Confirmed 1:1 against the reference's `EQ_FILTER_TYPE_NAMES` — numeric
/// code equals `EqFilterType`'s declaration-order index exactly (0=Peaking
/// .. 10=BesselHigh). Any code outside 0..=10 falls back to `Peaking` with a
/// `// FLAG` — the struct field isn't `Option`, so an unmapped code can't
/// cleanly express "unknown" the way `power_mode`/`source` do.
fn eq_filter_type(code: u8) -> EqFilterType {
    match code {
        0 => EqFilterType::Peaking,
        1 => EqFilterType::LowShelf,
        2 => EqFilterType::HighShelf,
        3 => EqFilterType::AllPass1st,
        4 => EqFilterType::AllPass2nd,
        5 => EqFilterType::GeneralLow,
        6 => EqFilterType::GeneralHigh,
        7 => EqFilterType::ButterworthLow,
        8 => EqFilterType::ButterworthHigh,
        9 => EqFilterType::BesselLow,
        10 => EqFilterType::BesselHigh,
        _ => EqFilterType::Peaking, // FLAG: unmapped code, defaulted rather than panicking
    }
}

/// Confirmed 1:1 against the reference's `HPLP_FILTER_TYPE_NAMES` (its own
/// comment: "indices match the C# HPorLP_InttoString array") — numeric code
/// equals `CrossoverFilterType`'s declaration-order index exactly
/// (0=Butterworth12 .. 10=LinkwitzRiley48).
fn crossover_filter_type(code: u8) -> CrossoverFilterType {
    match code {
        0 => CrossoverFilterType::Butterworth12,
        1 => CrossoverFilterType::Bessel12,
        2 => CrossoverFilterType::LinkwitzRiley12,
        3 => CrossoverFilterType::Butterworth18,
        4 => CrossoverFilterType::Butterworth24,
        5 => CrossoverFilterType::Bessel24,
        6 => CrossoverFilterType::LinkwitzRiley24,
        7 => CrossoverFilterType::Butterworth36,
        8 => CrossoverFilterType::Butterworth48,
        9 => CrossoverFilterType::Bessel48,
        10 => CrossoverFilterType::LinkwitzRiley48,
        _ => CrossoverFilterType::Butterworth12, // FLAG: unmapped code
    }
}

/// Inverse of `eq_filter_type` — the wire code for a given `EqFilterType`,
/// used by `write_v118.rs` to encode outgoing FC=30 FILTER_TYPE writes. Kept
/// next to the read-side mapping (not duplicated in the write module) so
/// read and write can never silently drift into disagreeing about which
/// code means what.
pub fn eq_filter_type_code(filter_type: EqFilterType) -> u8 {
    match filter_type {
        EqFilterType::Peaking => 0,
        EqFilterType::LowShelf => 1,
        EqFilterType::HighShelf => 2,
        EqFilterType::AllPass1st => 3,
        EqFilterType::AllPass2nd => 4,
        EqFilterType::GeneralLow => 5,
        EqFilterType::GeneralHigh => 6,
        EqFilterType::ButterworthLow => 7,
        EqFilterType::ButterworthHigh => 8,
        EqFilterType::BesselLow => 9,
        EqFilterType::BesselHigh => 10,
    }
}

/// Inverse of `crossover_filter_type` — see `eq_filter_type_code`.
pub fn crossover_filter_type_code(filter_type: CrossoverFilterType) -> u8 {
    match filter_type {
        CrossoverFilterType::Butterworth12 => 0,
        CrossoverFilterType::Bessel12 => 1,
        CrossoverFilterType::LinkwitzRiley12 => 2,
        CrossoverFilterType::Butterworth18 => 3,
        CrossoverFilterType::Butterworth24 => 4,
        CrossoverFilterType::Bessel24 => 5,
        CrossoverFilterType::LinkwitzRiley24 => 6,
        CrossoverFilterType::Butterworth36 => 7,
        CrossoverFilterType::Butterworth48 => 8,
        CrossoverFilterType::Bessel48 => 9,
        CrossoverFilterType::LinkwitzRiley48 => 10,
    }
}

/// Confirmed 1:1 against the reference's `POWER_MODE_NAMES` (0=Low-Ω,
/// 1=70V, 2=100V) — matches `PowerMode`'s declaration order exactly. `None`
/// for any other byte value — genuinely unmapped, not defaulted.
fn power_mode(code: u8) -> Option<PowerMode> {
    match code {
        0 => Some(PowerMode::LowOhm),
        1 => Some(PowerMode::V70),
        2 => Some(PowerMode::V100),
        _ => None,
    }
}

/// Confirmed base mapping against the reference's `clampSourceCode`/
/// `sourceNameFromCode`: 0=Analog, 1=Dante, >=3=Backup.
///
/// **Code 2 is AES3, which this app does not support**, so it decodes to
/// `None` — "the amp is on a source we have no name for" — rather than being
/// folded into a kind we do have. Both cheap alternatives are actively
/// harmful: calling it `Dante` would report a source the amp is not on, and
/// calling it `Backup` hits the hard error in `plan_input` and would be
/// hashed as a genuine tag. `None` already has well-defined meaning
/// downstream — `ChannelConfig.source` is `Option` and `fingerprint`'s
/// `source_readable` flag covers exactly this — so the reading stays honest
/// and no code path can round-trip a 2 back out.
///
/// An explicit push still plans an `FC_SOURCE_SELECT` write for such a
/// channel, moving the amp onto whatever the project asks for. That is push
/// doing its job (`None` can never compare equal to a planned source), not a
/// decode artifact — but it does mean pushing to a genuinely AES3-fed amp
/// will take it off AES3.
///
/// Code 1 stays `Dante`. The vendor treats code 1 as AES3 on an
/// AES3-but-no-Dante amp, but that model line is out of scope here, and
/// `Dante` is correct for every amp this app supports.
///
/// `index`: for Analog, the trailer's per-channel analog-matrix source
/// index (patchable, not fixed to `channel_index`). For Dante, this app's
/// own established convention is a fixed 1:1 pairing (Dante channel N feeds
/// digital input N — see `data/project.rs`'s `SourceChannelCount` doc), so
/// `index = channel_index`. For Backup, there is no established index
/// semantics in this app's model yet — `0` is a placeholder, not a
/// meaningful position.
fn source(raw_code: u8, channel_index: u32, analog_matrix_index: u8) -> Option<ChannelSource> {
    if raw_code >= 3 {
        return Some(ChannelSource { kind: SourceKind::Backup, index: 0 });
    }
    match raw_code {
        0 => Some(ChannelSource { kind: SourceKind::Analog, index: analog_matrix_index as u32 }),
        1 => Some(ChannelSource { kind: SourceKind::Dante, index: channel_index }),
        _ => None,
    }
}

struct EqBlockResult {
    hp: CrossoverSlot,
    bands: Vec<EqBand>,
    lp: CrossoverSlot,
    wire: EqChainWire,
}

/// 10 bands x 14-byte stride: type(u8,1) + gain(f32LE,4) + freq(f32LE,4) +
/// q(f32LE,4) + bypass(u8,1) = 14 bytes. Bypass is C# sbyte-convention
/// sign-encoded into the type byte (`raw_type >= 128` => bypassed, real type
/// = `255 - raw_type`) OR the trailing byte — either condition means
/// bypassed. Band 0 = HP crossover slot, band 9 = LP crossover slot (their
/// own type vocabulary); bands 1..=8 = parametric EQ bands.
///
/// This is byte-for-byte the same body FC=52 writes (see
/// `write_v118::build_set_eq_chain`), which is what makes that write
/// auditable: the layout below has been correct against real hardware since
/// long before anything wrote it. The fields this app's model has no home for
/// come back in `EqChainWire` so that write can echo them.
fn parse_eq_block(body: &[u8], block_offset: usize) -> EqBlockResult {
    const STRIDE: usize = 14;
    let mut hp = None;
    let mut lp = None;
    let mut bands = Vec::with_capacity(8);
    let mut wire = EqChainWire::default();

    for band_index in 0..10usize {
        let off = block_offset + band_index * STRIDE;
        let raw_type = u8_at(body, off);
        let bypass_encoded = raw_type >= 128;
        let real_type = if bypass_encoded { 255 - raw_type } else { raw_type };
        let bypass = bypass_encoded || u8_at(body, off + 13) != 0;
        let gain = f32_le(body, off + 1);
        let freq = f32_le(body, off + 5);
        let q = f32_le(body, off + 9);
        let active = !bypass;

        if band_index == 0 {
            // A crossover slot's gain/Q are not part of `CrossoverSlot` — the
            // slope type implies Q, and gain is meaningless — but they still
            // occupy their bytes, so they are kept for the echo.
            (wire.hp_gain_db, wire.hp_q) = (gain, q);
            hp = Some(CrossoverSlot { filter_type: crossover_filter_type(real_type), freq_hz: freq as f64, active });
        } else if band_index == 9 {
            (wire.lp_gain_db, wire.lp_q) = (gain, q);
            lp = Some(CrossoverSlot { filter_type: crossover_filter_type(real_type), freq_hz: freq as f64, active });
        } else {
            bands.push(EqBand {
                filter_type: eq_filter_type(real_type),
                freq_hz: freq as f64,
                gain_db: gain as f64,
                q: q as f64,
                active,
            });
        }
    }

    // The vendor struct has one more byte after the 10 filters
    // (`f_CH_bypass`, 0 = chain active). CVR amps have no whole-EQ bypass —
    // bands are only active or bypassed individually — so it is still not
    // modelled, but FC=52 has to send *something* in that byte, and echoing
    // what the amp reports is the only value that can't change its behaviour
    // behind the user's back.
    wire.chain_bypass = u8_at(body, block_offset + 10 * STRIDE);

    EqBlockResult { hp: hp.unwrap(), bands, lp: lp.unwrap(), wire }
}

fn parse_channel(body: &[u8], channel_index: u32, trailer_base: usize) -> ChannelConfig {
    let base = channel_index as usize * BYTES_PER_CHANNEL;
    let at = |rel: usize| base + rel;

    let input_eq_raw = parse_eq_block(body, at(121));
    let output_eq_raw = parse_eq_block(body, at(262));

    let matrix_crosspoints = (0..4u32)
        .map(|k| {
            let off = at(60 + k as usize * 5);
            MatrixCrosspoint { source_index: k, gain_db: f32_le(body, off) as f64, active: u8_at(body, off + 4) != 0 }
        })
        .collect();

    // Trailer fields — source of truth for input_muted and the analog
    // matrix source index (NOT any channel-body byte).
    let input_muted = u8_at(body, trailer_base + 132 + channel_index as usize) == 0; // wire-inverted
    let analog_matrix_index = u8_at(body, trailer_base + 136 + channel_index as usize);

    let raw_source_code = u8_at(body, at(85));

    // Trailer `SourcePrioritys[4]`: [first, second, enabled, threshold i8].
    // `enabled == 1` per the reference web app — verify on hardware.
    let priority_base = trailer_base + 140 + channel_index as usize * 4;
    let backup_priority = BackupPriority {
        first: u8_at(body, priority_base),
        second: u8_at(body, priority_base + 1),
        enabled: u8_at(body, priority_base + 2) == 1,
        threshold_db: i8_at(body, priority_base + 3) as i32,
    };

    ChannelConfig {
        channel_index,
        delay_in_ms: f32_le(body, at(86)),
        input_muted,
        matrix_crosspoints,
        input_eq: ChannelEq { hp: input_eq_raw.hp, bands: input_eq_raw.bands, lp: input_eq_raw.lp },
        output_eq: ChannelEq { hp: output_eq_raw.hp, bands: output_eq_raw.bands, lp: output_eq_raw.lp },
        input_eq_wire: input_eq_raw.wire,
        output_eq_wire: output_eq_raw.wire,
        output_trim_db: f32_le(body, at(80)),
        output_volume_db: f32_le(body, at(405)),
        output_muted: u8_at(body, at(84)) == 0, // inverted: 0=muted
        delay_out_ms: f32_le(body, at(90)),
        output_phase_inverted: u8_at(body, at(94)) != 0,
        noise_gate_enabled: u8_at(body, at(409)) == 0, // inverted: 0=enabled
        limiter: Limiter {
            rms: RmsLimiter {
                // active-low: offset 102 is correct (not 100 — a previously
                // fixed reference-side bug); device sets byte 102=1 during
                // bypass.
                enabled: u8_at(body, at(102)) == 0,
                threshold_vrms: f32_le(body, at(98)) as f64,
                attack_ms: u16_le(body, at(95)) as f64,
                release_multiplier: u8_at(body, at(97)) as f64,
                // Vendor `RMS_Auto = (auto == 0)` — verify on hardware.
                auto: u8_at(body, at(103)) == 0,
                max_vrms: f32_le(body, at(104)) as f64,
            },
            peak: PeakLimiter {
                enabled: u8_at(body, at(116)) == 0, // active-low
                threshold_vp: f32_le(body, at(112)) as f64,
                hold_ms: u16_le(body, at(108)) as f64,
                release_ms: u16_le(body, at(110)) as f64,
                // Vendor `peak_Limiter_max` — these 4 bytes used to be misread
                // as a signed `gain_in` byte.
                max_vp: f32_le(body, at(117)) as f64,
            },
        },
        fir_bypassed: u8_at(body, at(404)) != 0, // inverted: 0=enabled
        power_mode: power_mode(u8_at(body, at(403))),
        source: source(raw_source_code, channel_index, analog_matrix_index),
        input_name: ascii_16(body, at(414)),
        output_name: ascii_16(body, at(430)),
        // Offsets are absolute, so skipping AES3's pair at 52/56 shifts
        // nothing — the amp still sends those bytes, this app just ignores
        // them.
        analog_trim_db: f32_le(body, at(36)),
        analog_delay_ms: f32_le(body, at(40)),
        dante_trim_db: f32_le(body, at(44)),
        dante_delay_ms: f32_le(body, at(48)),
        load_ohms: f32_le(body, at(410)),
        backup_priority,
    }
}

// Channel bytes 446–551 hold the vendor's dynamic EQ (`SynDEQ_Data`). Dynamic
// EQ is not supported by this app for any model, so they are deliberately
// not read.

/// `body` = the pure per-channel-data region (StructHeader/checksum already
/// stripped by the caller — see `channel_config.rs`'s dispatcher doc).
/// Returns `None` on any geometry failure: too short, remainder doesn't
/// divide evenly by 515, or channel count outside 1..=4 — a real parse
/// failure surfaced as an honest gap, never a silent best-effort fallback
/// (contrast the reference's `detectPayloadLayout`, which falls back to
/// `floor(len/515)` and assumes the 118 trailer on any unrecognized shape).
pub fn parse_channel_config(body: &[u8]) -> Option<ChannelConfigSnapshot> {
    if body.len() < TRAILER_SIZE_V118 {
        return None;
    }
    let remainder = body.len() - TRAILER_SIZE_V118;
    if remainder % BYTES_PER_CHANNEL != 0 {
        return None;
    }
    let channel_count = remainder / BYTES_PER_CHANNEL;
    if !(1..=4).contains(&channel_count) {
        return None;
    }
    let trailer_base = channel_count * BYTES_PER_CHANNEL;

    let channels = (0..channel_count as u32).map(|c| parse_channel(body, c, trailer_base)).collect();

    // Header (absolute, before channel A's fields): `Machine_Dname[32]` — on a
    // real DSP-2004 this holds the firmware/model ID string, not the user's
    // name (that is FC=0 BASIC_INFO's `DiscoveredDevice.name`), so it is not
    // read — then `Standby` @32, `Rotary_lock` @33, bridges @34/35 (bridges come from
    // FC=50 instead — see `bridge.rs`). Confirmed by `driver.rs`'s
    // `log_sync_body_diff`: toggling bridge pair 0 changed absolute byte 34.
    // The lock used to be read at `trailer_base + 33`, which lands inside
    // channel D's dynamic-EQ block.
    let flag = |abs: usize| match u8_at(body, abs) {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    };
    // Standby is tri-state, not a flag: the vendor's FC=15 receive path treats
    // `0` as powered on, `1` as standby, and `2` as standby *locked out* —
    // `RunState = num != 0` with a separate `IsBanRunState = num == 2` that
    // disables its own toggle. FC=27's `Standbys` is the same `Standby_data`
    // struct, so the same three values are assumed here; only `2`'s meaning is
    // inferred rather than observed on this byte. Anything past the known set
    // stays unknown rather than being folded into "on".
    let (standby, standby_locked) = match u8_at(body, 32) {
        0 => (Some(false), Some(false)),
        1 => (Some(true), Some(false)),
        2 => (Some(true), Some(true)),
        _ => (None, None),
    };
    let rotary_locked = flag(33);

    // Trailer from `trailer_base + 36`: `link_input[8]` and `link_output[8]`
    // (i32 channel link groups — not supported by this app for any model, so
    // deliberately not read), then `Scene_mode_name[32]`; mutes, analog
    // matrix and priority follow and are read per channel in `parse_channel`.
    // The trailing vendor `Gains[4]` is no setting on CVR amps and is not read.
    let preset_name = ascii_n(body, trailer_base + 100, 32);

    // `Bridge_data.Bridge` is wire-inverted like MUTE: 0 = bridged.
    // Confirmed twice over — the reference's readback (`bridged: raw === 0`)
    // and the vendor's own demo-data writer
    // (`bridges[0].Bridge = (bridgeOut ? 0 : 1)`).
    //
    // One entry per *pair*, so a 4-channel amp reports 2 and the array is
    // truncated to the pairs this payload's channel count actually has —
    // never padded out to a fixed 2, which would invent a C/D pair on a
    // 2-channel amp.
    Some(ChannelConfigSnapshot {
        channels,
        standby,
        standby_locked,
        rotary_locked,
        preset_name,
        received_at: now_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Code 2 is AES3, which this app dropped. It must read back as `None`
    /// ("on a source we can't name") rather than being folded into a kind we
    /// do have — reporting it as Dante would name an input the amp is not on.
    /// Codes 0/1 and the backup range must be unaffected by that removal.
    #[test]
    fn unsupported_source_code_reads_as_unknown() {
        // Projected to a tuple because `ChannelSource` has no `PartialEq` —
        // the same comparison `amp_push::plan_input` makes.
        let source_of = |code: u8| {
            let mut body = vec![0u8; 4 * BYTES_PER_CHANNEL + TRAILER_SIZE_V118];
            body[85] = code; // channel 0's source selector
            body[4 * BYTES_PER_CHANNEL + 136] = 3; // channel 0's analog matrix index
            parse_channel_config(&body).unwrap().channels[0].source.map(|s| (s.kind, s.index))
        };

        assert_eq!(source_of(2), None, "AES3 must not be folded into a supported kind");
        assert_eq!(source_of(0), Some((SourceKind::Analog, 3)));
        assert_eq!(source_of(1), Some((SourceKind::Dante, 0)));
        assert_eq!(source_of(3), Some((SourceKind::Backup, 0)));
    }

    #[test]
    fn header_flags_are_read_at_absolute_offsets() {
        let mut body = vec![0u8; 4 * BYTES_PER_CHANNEL + TRAILER_SIZE_V118];
        body[32] = 1; // standby
        body[33] = 1; // knob lock
        body[4 * BYTES_PER_CHANNEL + 33] = 7; // the old, wrong offset
        let snapshot = parse_channel_config(&body).unwrap();
        assert_eq!(snapshot.standby, Some(true));
        assert_eq!(snapshot.rotary_locked, Some(true));
    }

    /// `2` must not read as "unknown" (which would render a dead control on an
    /// amp that really is in standby) nor as plain standby (which would offer
    /// a toggle the amp ignores).
    #[test]
    fn standby_byte_is_tri_state() {
        let read = |value: u8| {
            let mut body = vec![0u8; 4 * BYTES_PER_CHANNEL + TRAILER_SIZE_V118];
            body[32] = value;
            let snapshot = parse_channel_config(&body).unwrap();
            (snapshot.standby, snapshot.standby_locked)
        };
        assert_eq!(read(0), (Some(false), Some(false)));
        assert_eq!(read(1), (Some(true), Some(false)));
        assert_eq!(read(2), (Some(true), Some(true)));
        assert_eq!(read(3), (None, None), "an unexpected value stays honestly unknown");
    }
}
