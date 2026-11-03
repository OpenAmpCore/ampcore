use super::*;

/// Byte written for an absent optional value.
pub(super) const NONE_TAG: u8 = 0xFF;

pub(super) const SECTION_IDENTITY: u8 = b'I';

pub(super) const SECTION_SPEAKER: u8 = b'S';

pub(super) const SECTION_CHANNEL: u8 = b'C';

pub(super) const SECTION_EQ: u8 = b'E';

pub(super) const SECTION_LIMITER: u8 = b'L';

pub(super) const SECTION_BRIDGE: u8 = b'B';

pub(super) const SECTION_SETTINGS: u8 = b'A';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

pub(super) struct HashInput(pub(super) Vec<u8>);

impl HashInput {
    pub(super) fn new() -> Self {
        Self(vec![FINGERPRINT_VERSION])
    }
    pub(super) fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    pub(super) fn bool(&mut self, v: bool) {
        self.0.push(v as u8);
    }
    pub(super) fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    pub(super) fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    pub(super) fn i32(&mut self, v: i32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    pub(super) fn str(&mut self, s: &str) {
        self.u32(s.len() as u32);
        self.0.extend_from_slice(s.as_bytes());
    }
    pub(super) fn opt_tag(&mut self, v: Option<u8>) {
        self.u8(v.unwrap_or(NONE_TAG));
    }
    pub(super) fn opt_i32(&mut self, v: Option<i32>) {
        match v {
            Some(v) => {
                self.u8(1);
                self.i32(v);
            }
            None => self.u8(0),
        }
    }
}

pub(super) fn encode_crossover(h: &mut HashInput, slot: &CrossoverCanonical) {
    h.bool(slot.active);
    if slot.active {
        h.u8(crossover_filter_tag(slot.filter_type));
        h.i32(steps(slot.freq_hz, FREQ_STEPS));
    }
}

pub(super) fn encode_eq(h: &mut HashInput, eq: &EqCanonical) {
    h.u8(SECTION_EQ);
    encode_crossover(h, &eq.hp);
    h.u32(eq.bands.len() as u32);
    for band in &eq.bands {
        h.bool(band.active);
        if band.active {
            h.u8(eq_filter_tag(band.filter_type));
            h.i32(steps(band.freq_hz, FREQ_STEPS));
            h.opt_i32(band.gain_db.map(|g| steps(g, GAIN_STEPS)));
            h.opt_i32(band.q.map(|q| steps(q, Q_STEPS)));
        }
    }
    encode_crossover(h, &eq.lp);
}

pub(super) fn encode_speaker(h: &mut HashInput, speaker: &SpeakerCanonical) {
    h.u8(SECTION_SPEAKER);
    encode_eq(h, &speaker.output_eq);
    h.u8(SECTION_LIMITER);
    let rms = &speaker.rms_limiter;
    h.bool(rms.enabled);
    if rms.enabled {
        h.i32(steps(rms.threshold_vrms, VOLT_STEPS));
        h.i32(steps(rms.attack_ms, WHOLE_STEPS));
        h.i32(steps(rms.release_multiplier, WHOLE_STEPS));
        h.bool(rms.auto);
        h.i32(steps(rms.max_vrms, VOLT_STEPS));
    }
    let peak = &speaker.peak_limiter;
    h.bool(peak.enabled);
    if peak.enabled {
        h.i32(steps(peak.threshold_vp, VOLT_STEPS));
        h.i32(steps(peak.hold_ms, WHOLE_STEPS));
        h.i32(steps(peak.release_ms, WHOLE_STEPS));
        h.i32(steps(peak.max_vp, VOLT_STEPS));
    }
    h.i32(steps(speaker.delay_out_ms, DELAY_STEPS));
    h.bool(speaker.phase_inverted);
    h.opt_tag(speaker.power_mode.map(power_mode_tag));
    h.bool(speaker.fir_bypassed);
}

pub(super) fn encode_settings(h: &mut HashInput, settings: &AmpSettingsCanonical) {
    h.u8(SECTION_SETTINGS);
    h.str(&settings.device_name);
}

pub(super) fn encode_identity(h: &mut HashInput, identity: &AmpIdentity) {
    h.u8(SECTION_IDENTITY);
    h.str(identity.model.as_deref().unwrap_or(""));
    h.u32(identity.channel_count);
    h.str(identity.firmware_family.as_deref().unwrap_or(""));
}

pub(super) fn encode_channel_amp(h: &mut HashInput, channel_index: u32, speaker_hash: u16, fields: &ChannelAmpCanonical) {
    h.u8(SECTION_CHANNEL);
    h.u32(channel_index);
    h.u16(speaker_hash);
    encode_eq(h, &fields.input_eq);
    match fields.source {
        Some(source) => {
            h.u8(source_kind_tag(source.kind));
            h.u32(source.index);
        }
        None => h.u8(NONE_TAG),
    }
    h.u32(fields.matrix_crosspoints.len() as u32);
    for cp in &fields.matrix_crosspoints {
        h.u32(cp.source_index);
        h.bool(cp.active);
        if cp.active {
            h.i32(steps(cp.gain_db, GAIN_STEPS));
        }
    }
    h.i32(steps(fields.delay_in_ms, DELAY_STEPS));
    h.i32(steps(fields.output_trim_db, GAIN_STEPS));
    h.i32(steps(fields.output_volume_db, GAIN_STEPS));
    h.bool(fields.noise_gate_enabled);
    h.opt_i32(fields.noise_gate_threshold_dbu.map(|t| steps(t, WHOLE_STEPS)));
    h.str(&fields.input_name);
    h.bool(fields.input_muted);
    h.bool(fields.output_muted);
    h.str(&fields.output_name_base);
    for trim in [fields.source_trims.analog, fields.source_trims.dante] {
        h.i32(steps(trim.trim_db, GAIN_STEPS));
        h.i32(steps(trim.delay_ms, DELAY_STEPS));
    }
    // `backup_priority` is deliberately not hashed — see the module doc
    // comment.
}

pub(super) fn encode_bridge_pairs(h: &mut HashInput, pairs: &[Option<bool>]) {
    h.u8(SECTION_BRIDGE);
    h.u32(pairs.len() as u32);
    for pair in pairs {
        h.opt_tag(pair.map(u8::from));
    }
}

// ---------------------------------------------------------------------------
// Field comparison — what the edit-lock modal shows side by side
// ---------------------------------------------------------------------------

/// CRC-16/XModem (poly 0x1021, init 0) — same variant as the prior web app.
pub(super) fn crc16_xmodem(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &byte in data {
        crc ^= (byte as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

pub(super) fn fnv1a_64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in data {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

// ---------------------------------------------------------------------------
// Output-name hash suffix
// ---------------------------------------------------------------------------
