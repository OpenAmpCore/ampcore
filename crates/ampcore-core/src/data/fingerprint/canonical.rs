use super::*;

/// An output's FIR as both sides reduce to it.
pub(super) struct FirInput<'a> {
    pub(super) name: Option<&'a str>,
    pub(super) coefficients: &'a [f32],
}

/// What a channel without FIR hardware, or with nothing loaded, holds.
pub(super) const NO_FIR: FirInput<'static> = FirInput { name: None, coefficients: &[1.0] };

pub(super) fn fir_stats(fir: &FirInput) -> ChannelFirStats {
    ChannelFirStats {
        loaded: trimmed_taps(fir.coefficients) != [1.0],
        name: fir.name.map(str::trim).filter(|n| !n.is_empty() && *n != "---").map(String::from),
        order: fir_order(fir.coefficients),
        time_zero_ms: fir_time_zero(fir.coefficients).1,
        summary: taps_summary(fir.coefficients),
    }
}

pub(super) struct ChannelInput<'a> {
    pub(super) channel_index: u32,
    pub(super) source: Option<ChannelSource>,
    /// `false` when a live source byte didn't map.
    pub(super) source_readable: bool,
    pub(super) matrix_crosspoints: &'a [MatrixCrosspoint],
    pub(super) delay_in_ms: f64,
    pub(super) output_trim_db: f64,
    pub(super) output_volume_db: f64,
    pub(super) delay_out_ms: f64,
    pub(super) input_eq: &'a ChannelEq,
    pub(super) output_eq: &'a ChannelEq,
    pub(super) limiter: &'a Limiter,
    pub(super) noise_gate_enabled: bool,
    /// `None` where the firmware stores no threshold.
    pub(super) noise_gate_threshold_dbu: Option<f64>,
    pub(super) output_phase_inverted: bool,
    pub(super) input_name: Option<&'a str>,
    pub(super) output_name: Option<&'a str>,
    pub(super) power_mode: Option<PowerMode>,
    /// Bridge reading for this channel's pair; `None` = not reported. Only
    /// read from pair leaders, in `build`.
    pub(super) bridged: Option<bool>,
    pub(super) input_muted: bool,
    pub(super) output_muted: bool,
    pub(super) fir_bypassed: bool,
    /// `None` = a live output not read yet.
    pub(super) fir: Option<FirInput<'a>>,
    pub(super) source_trims: SourceTrims,
    pub(super) backup_priority: BackupPriority,
}

/// Amp-wide inputs, reduced the same way on both sides.
pub(super) struct AmpInput<'a> {
    pub(super) device_name: Option<&'a str>,
    pub(super) status: AmpStatus,
}

impl<'a> ChannelInput<'a> {
    /// `has_gate_threshold`: whether the planned firmware stores a gate
    /// threshold at all (`CvrFirmwareCapability.noise_gate_threshold`);
    /// `has_fir`: whether it has FIR filters at all.
    pub(super) fn from_project(channel: &'a AmpChannel, has_gate_threshold: bool, has_fir: bool) -> Self {
        Self {
            channel_index: channel.channel_index,
            source: Some(channel.source),
            source_readable: true,
            matrix_crosspoints: &channel.matrix_crosspoints,
            delay_in_ms: channel.delay_in_ms,
            output_trim_db: channel.output_trim_db,
            output_volume_db: channel.output_volume_db,
            delay_out_ms: channel.delay_out_ms,
            input_eq: &channel.input_eq,
            output_eq: &channel.output_eq,
            limiter: &channel.limiter,
            noise_gate_enabled: channel.noise_gate_enabled,
            noise_gate_threshold_dbu: has_gate_threshold.then_some(channel.noise_gate_threshold_dbu),
            output_phase_inverted: channel.output_phase_inverted,
            input_name: channel.input_name.as_deref(),
            output_name: channel.output_name.as_deref(),
            power_mode: Some(channel.power_mode),
            bridged: Some(channel.output_bridged),
            input_muted: channel.input_muted,
            output_muted: channel.output_muted,
            fir_bypassed: channel.fir_bypassed,
            fir: Some(if has_fir {
                FirInput { name: Some(&channel.fir.name), coefficients: &channel.fir.coefficients }
            } else {
                NO_FIR
            }),
            source_trims: channel.source_trims,
            backup_priority: channel.backup_priority,
        }
    }

    pub(super) fn from_live(config: &'a ChannelConfig, bridged: Option<bool>, fir: Option<FirInput<'a>>) -> Self {
        Self {
            channel_index: config.channel_index,
            source: config.source,
            source_readable: config.source.is_some(),
            matrix_crosspoints: &config.matrix_crosspoints,
            delay_in_ms: config.delay_in_ms as f64,
            output_trim_db: config.output_trim_db as f64,
            output_volume_db: config.output_volume_db as f64,
            delay_out_ms: config.delay_out_ms as f64,
            input_eq: &config.input_eq,
            output_eq: &config.output_eq,
            limiter: &config.limiter,
            noise_gate_enabled: config.noise_gate_enabled,
            noise_gate_threshold_dbu: config.noise_gate_threshold_dbu.map(f64::from),
            output_phase_inverted: config.output_phase_inverted,
            input_name: config.input_name.as_deref(),
            output_name: config.output_name.as_deref(),
            power_mode: config.power_mode,
            bridged,
            input_muted: config.input_muted,
            output_muted: config.output_muted,
            fir_bypassed: config.fir_bypassed,
            fir,
            source_trims: SourceTrims {
                analog: SourceTrim { trim_db: config.analog_trim_db as f64, delay_ms: config.analog_delay_ms as f64 },
                dante: SourceTrim { trim_db: config.dante_trim_db as f64, delay_ms: config.dante_delay_ms as f64 },
            },
            backup_priority: config.backup_priority,
        }
    }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

pub(super) fn build(
    origin: FingerprintOrigin,
    identity: AmpIdentity,
    matrix_input_count: u32,
    amp_input: AmpInput,
    inputs: Vec<ChannelInput>,
    mut missing: Vec<String>,
) -> AmpFingerprint {
    let count = identity.channel_count;
    for index in 0..count {
        if !inputs.iter().any(|i| i.channel_index == index) {
            missing.push(format!("Out{}: channel data not available", output_letter(index)));
        }
    }

    let settings = AmpSettingsCanonical {
        device_name: amp_input.device_name.map(str::trim).unwrap_or("").to_string(),
    };

    let mut amp = HashInput::new();
    encode_identity(&mut amp, &identity);
    encode_settings(&mut amp, &settings);

    let mut channels = Vec::with_capacity(inputs.len());
    for input in &inputs {
        let label = output_letter(input.channel_index);

        let speaker = canonical_speaker(input);
        if speaker.power_mode.is_none() {
            missing.push(format!("Out{label}: power mode not readable"));
        }
        if input.fir.is_none() {
            missing.push(format!("Out{label}: FIR filter not read yet"));
        }
        let speaker_hash = input.fir.as_ref().filter(|_| speaker.power_mode.is_some()).map(|fir| {
            let mut h = HashInput::new();
            encode_speaker(&mut h, &speaker);
            // Raw bits, not rounded steps: taps are stored, sent and read
            // back as the same f32s.
            let taps = trimmed_taps(fir.coefficients);
            h.u32(taps.len() as u32);
            for tap in taps {
                h.u32(tap.to_bits());
            }
            crc16_xmodem(&h.0)
        });

        if !input.source_readable {
            missing.push(format!("In{}: source selection not readable", input.channel_index + 1));
        }

        let amp_fields = canonical_amp_fields(input, matrix_input_count);
        if let Some(hash) = speaker_hash {
            encode_channel_amp(&mut amp, input.channel_index, hash, &amp_fields);
        }

        let output_name = input.output_name.map(str::trim).filter(|n| !n.is_empty()).map(String::from);
        let embedded_hash = output_name.as_deref().and_then(|n| split_hash_suffix(n).1);
        let speaker_hash = speaker_hash.map(|h| format!("{h:04X}"));
        let embedded_hash_matches = match (&embedded_hash, &speaker_hash) {
            (Some(embedded), Some(current)) => Some(embedded == current),
            _ => None,
        };

        channels.push(ChannelFingerprint {
            channel_index: input.channel_index,
            label: label.to_string(),
            speaker_hash,
            output_name,
            embedded_hash,
            embedded_hash_matches,
            speaker,
            amp_fields,
            fir: input.fir.as_ref().map(fir_stats),
        });
    }

    // Bridging joins a channel with the next one (A/B, C/D, …); only the
    // pair leader carries the flag.
    let mut bridged_pairs = Vec::new();
    for leader in (0..count).step_by(2).filter(|leader| leader + 1 < count) {
        let leader_input = inputs.iter().find(|i| i.channel_index == leader);
        let reading = leader_input.and_then(|i| i.bridged);
        if leader_input.is_some() && reading.is_none() {
            missing.push(format!(
                "Out{}/{}: bridge state not reported yet",
                output_letter(leader),
                output_letter(leader + 1)
            ));
        }
        bridged_pairs.push(reading);
    }
    encode_bridge_pairs(&mut amp, &bridged_pairs);

    let amp_hash = missing.is_empty().then(|| format!("{:016X}", fnv1a_64(&amp.0)));

    AmpFingerprint {
        fingerprint_version: FINGERPRINT_VERSION as u32,
        origin,
        identity,
        settings,
        status: amp_input.status,
        amp_hash,
        channels,
        bridged_pairs,
        missing,
    }
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/// Casts through `f32` first — the precision the wire actually stores — then
/// rounds to the nearest step, so an offline `f64` and its live `f32` readback
/// land on the same value.
pub(crate) fn round_to_step(value: f64, steps_per_unit: f64) -> f64 {
    let wire = value as f32 as f64;
    if !wire.is_finite() {
        return 0.0;
    }
    (wire * steps_per_unit).round() / steps_per_unit
}

/// A value already produced by `round_to_step`, as its integer step count —
/// what the hash actually encodes, so it never depends on float formatting.
pub(super) fn steps(value: f64, steps_per_unit: f64) -> i32 {
    (value * steps_per_unit).round() as i32
}

pub(super) fn canonical_crossover(slot: &CrossoverSlot) -> CrossoverCanonical {
    CrossoverCanonical {
        filter_type: slot.filter_type,
        freq_hz: round_to_step(slot.freq_hz, FREQ_STEPS),
        active: slot.active,
    }
}

pub(super) fn canonical_band(band: &EqBand) -> EqBandCanonical {
    let caps = band.filter_type.capabilities();
    EqBandCanonical {
        filter_type: band.filter_type,
        freq_hz: round_to_step(band.freq_hz, FREQ_STEPS),
        gain_db: caps.supports_gain.then(|| round_to_step(band.gain_db, GAIN_STEPS)),
        q: caps.supports_q.then(|| round_to_step(band.q, Q_STEPS)),
        active: band.active,
    }
}

pub(crate) fn canonical_eq(eq: &ChannelEq) -> EqCanonical {
    EqCanonical {
        hp: canonical_crossover(&eq.hp),
        bands: eq.bands.iter().map(canonical_band).collect(),
        lp: canonical_crossover(&eq.lp),
    }
}

pub(super) fn canonical_speaker(input: &ChannelInput) -> SpeakerCanonical {
    let rms = &input.limiter.rms;
    let peak = &input.limiter.peak;
    SpeakerCanonical {
        output_eq: canonical_eq(input.output_eq),
        rms_limiter: RmsLimiterCanonical {
            enabled: rms.enabled,
            threshold_vrms: round_to_step(rms.threshold_vrms, VOLT_STEPS),
            attack_ms: round_to_step(rms.attack_ms, WHOLE_STEPS),
            release_multiplier: round_to_step(rms.release_multiplier, WHOLE_STEPS),
            auto: rms.auto,
            max_vrms: round_to_step(rms.max_vrms, VOLT_STEPS),
        },
        peak_limiter: PeakLimiterCanonical {
            enabled: peak.enabled,
            threshold_vp: round_to_step(peak.threshold_vp, VOLT_STEPS),
            hold_ms: round_to_step(peak.hold_ms, WHOLE_STEPS),
            release_ms: round_to_step(peak.release_ms, WHOLE_STEPS),
            max_vp: round_to_step(peak.max_vp, VOLT_STEPS),
        },
        delay_out_ms: round_to_step(input.delay_out_ms, DELAY_STEPS),
        phase_inverted: input.output_phase_inverted,
        power_mode: input.power_mode,
        fir_bypassed: input.fir_bypassed,
    }
}

pub(super) fn canonical_trim(trim: SourceTrim) -> SourceTrim {
    SourceTrim { trim_db: round_to_step(trim.trim_db, GAIN_STEPS), delay_ms: round_to_step(trim.delay_ms, DELAY_STEPS) }
}

pub(super) fn canonical_amp_fields(input: &ChannelInput, matrix_input_count: u32) -> ChannelAmpCanonical {
    let mut matrix_crosspoints: Vec<CrosspointCanonical> = input
        .matrix_crosspoints
        .iter()
        .filter(|cp| cp.source_index < matrix_input_count)
        .map(|cp| CrosspointCanonical {
            source_index: cp.source_index,
            gain_db: round_to_step(cp.gain_db, GAIN_STEPS),
            active: cp.active,
        })
        .collect();
    matrix_crosspoints.sort_by_key(|cp| cp.source_index);

    ChannelAmpCanonical {
        input_eq: canonical_eq(input.input_eq),
        source: input.source,
        matrix_crosspoints,
        delay_in_ms: round_to_step(input.delay_in_ms, DELAY_STEPS),
        output_trim_db: round_to_step(input.output_trim_db, GAIN_STEPS),
        output_volume_db: round_to_step(input.output_volume_db, GAIN_STEPS),
        noise_gate_enabled: input.noise_gate_enabled,
        noise_gate_threshold_dbu: input
            .noise_gate_threshold_dbu
            .filter(|_| input.noise_gate_enabled)
            .map(|t| round_to_step(t, WHOLE_STEPS)),
        input_name: canonical_input_name(input.channel_index, input.input_name),
        input_muted: input.input_muted,
        output_muted: input.output_muted,
        output_name_base: canonical_output_name(input.channel_index, input.output_name),
        source_trims: SourceTrims {
            analog: canonical_trim(input.source_trims.analog),
            dante: canonical_trim(input.source_trims.dante),
        },
        backup_priority: input.backup_priority,
    }
}

/// An unnamed project input is displayed as the default "In{n}" label, while
/// the device stores and reports that same default as a literal name (a real
/// DSP-2004 reads back "In1".."In4"). Both canonicalize to "" so the default
/// never reads as a mismatch.
pub(crate) fn canonical_input_name(channel_index: u32, name: Option<&str>) -> String {
    let name = name.map(str::trim).unwrap_or("");
    if name.eq_ignore_ascii_case(&format!("In{}", channel_index + 1)) {
        String::new()
    } else {
        name.to_string()
    }
}

/// Output name with its `_XXXX` speaker-hash suffix removed (the suffix is
/// derived from `speakerHash`, so hashing it would count every change twice),
/// and the default "Out{letter}"/"Out{n}" label treated as unnamed — same rule
/// as `canonical_input_name`.
pub(crate) fn canonical_output_name(channel_index: u32, name: Option<&str>) -> String {
    let base = split_hash_suffix(name.map(str::trim).unwrap_or("")).0.trim();
    let letter = format!("Out{}", output_letter(channel_index));
    let number = format!("Out{}", channel_index + 1);
    if base.eq_ignore_ascii_case(&letter) || base.eq_ignore_ascii_case(&number) {
        String::new()
    } else {
        base.to_string()
    }
}

/// Offline counterpart of `DiscoveredDevice.firmware_family`: buckets a
/// planned version string exactly as that protocol's live driver buckets the
/// device's, so both sides produce the same label.
pub(super) fn planned_firmware_family(model: &AmpModelCatalogEntry, version: Option<&str>) -> Option<String> {
    match model.protocol {
        AmpProtocol::CvrUdp => detect_firmware_family(version?).label().map(String::from),
    }
}

pub(crate) fn output_letter(channel_index: u32) -> char {
    char::from(b'A' + (channel_index % 26) as u8)
}

// Fingerprint-owned enum tags — explicit, never declaration order, and
// independent of any protocol's wire codes.

pub(super) fn power_mode_tag(mode: PowerMode) -> u8 {
    match mode {
        PowerMode::LowOhm => 0,
        PowerMode::V70 => 1,
        PowerMode::V100 => 2,
    }
}

/// The amp's own source codes, so AES3 (read-only, see `SourceKind`) takes
/// the 2 that was left free for it.
pub(super) fn source_kind_tag(kind: SourceKind) -> u8 {
    match kind {
        SourceKind::Analog => 0,
        SourceKind::Dante => 1,
        SourceKind::Aes3 => 2,
        SourceKind::Backup => 3,
    }
}

pub(super) fn eq_filter_tag(filter_type: EqFilterType) -> u8 {
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

pub(super) fn crossover_filter_tag(filter_type: CrossoverFilterType) -> u8 {
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

// ---------------------------------------------------------------------------
// Byte encoding — fixed field order, independent of serde. Settings that
// don't affect the sound are skipped, not encoded.
// ---------------------------------------------------------------------------
