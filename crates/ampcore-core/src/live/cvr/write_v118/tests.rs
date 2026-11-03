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

/// Pins the FC=8 frame byte for byte. The fields worth guarding are the
/// function code itself (13 is the look-alike the firmware ignores) and
/// `in_out_flag` 0, despite the vendor showing gain beside each *output*.
#[test]
fn amp_gain_frame() {
    assert_eq!(
        build_set_amp_gain(0, 37.0),
        vec![
            // NetworkData: flag 0xd903 LE, machine_mode=0, count=1,
            // frame_len=17, step=1, state=0, pad
            0x03, 0xd9, 0x00, 0x00, 0x01, 0x11, 0x00, 0x01, 0x00, 0x00,
            // StructHeader: 0x55, FC=8, status=1, chx=0, seg=0, link=0, in_out=0
            0x55, 0x08, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            // 37.0f32 LE
            0x00, 0x00, 0x14, 0x42,
            // checksum: hi, lo, sum
            0x00, 0x11, 0xc5,
        ]
    );
    let (header, body) = decode(&build_set_amp_gain(3, 41.5));
    assert_eq!(header, (8, 1, 3, 0, 0));
    assert_eq!(f32::from_le_bytes(body.try_into().unwrap()), 41.5);
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
