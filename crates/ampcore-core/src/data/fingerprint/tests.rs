use super::super::project::{PeakLimiter, RmsLimiter};
use super::*;

fn eq(gain_db: f64, q: f64) -> ChannelEq {
    let hp = CrossoverSlot { filter_type: CrossoverFilterType::LinkwitzRiley24, freq_hz: 80.0, active: true };
    let band = EqBand { filter_type: EqFilterType::Peaking, freq_hz: 1234.5, gain_db, q, active: true };
    ChannelEq {
        hp,
        bands: vec![band; 8],
        lp: CrossoverSlot { freq_hz: 20000.0, active: false, ..hp },
    }
}

fn limiter() -> Limiter {
    Limiter {
        rms: RmsLimiter {
            enabled: true,
            threshold_vrms: 63.3,
            attack_ms: 5.0,
            release_multiplier: 4.0,
            auto: false,
            max_vrms: 0.0,
        },
        peak: PeakLimiter { enabled: false, threshold_vp: 140.0, hold_ms: 10.0, release_ms: 50.0, max_vp: 0.0 },
    }
}

fn input<'a>(eq: &'a ChannelEq, limiter: &'a Limiter, delay_out_ms: f64) -> ChannelInput<'a> {
    ChannelInput {
        channel_index: 0,
        source: None,
        source_readable: true,
        matrix_crosspoints: &[],
        delay_in_ms: 0.0,
        output_trim_db: 0.0,
        output_volume_db: 0.0,
        delay_out_ms,
        input_eq: eq,
        output_eq: eq,
        limiter,
        noise_gate_enabled: false,
        noise_gate_threshold_dbu: None,
        output_phase_inverted: false,
        input_name: None,
        output_name: None,
        power_mode: Some(PowerMode::LowOhm),
        bridged: None,
        input_muted: false,
        output_muted: false,
        fir_bypassed: false,
        fir: Some(NO_FIR),
        source_trims: SourceTrims::default(),
        backup_priority: BackupPriority::default(),
    }
}

fn no_amp_settings() -> AmpInput<'static> {
    AmpInput { device_name: None, status: AmpStatus::default() }
}

fn speaker_hash(input: &ChannelInput) -> u16 {
    let mut h = HashInput::new();
    encode_speaker(&mut h, &canonical_speaker(input));
    crc16_xmodem(&h.0)
}

fn amp_hash(inputs: Vec<ChannelInput>, matrix_input_count: u32) -> Option<String> {
    let origin = FingerprintOrigin {
        kind: FingerprintSource::Offline,
        project_id: None,
        assignment_id: None,
        device_id: None,
        mac: None,
        label: None,
    };
    let identity = AmpIdentity {
        model: Some("DSP-1002".to_string()),
        amp_model_id: None,
        channel_count: inputs.len() as u32,
        firmware_family: Some("1.1.8".to_string()),
    };
    build(origin, identity, matrix_input_count, no_amp_settings(), inputs, Vec::new()).amp_hash
}

/// FIR taps are hashed bit for bit, minus the wire's zero padding; the
/// name is a label; and an output nobody has read makes the amp
/// unreadable rather than guessed at.
#[test]
fn fir_taps_are_hashed_and_the_name_is_not() {
    let limiter = limiter();
    let eq = eq(0.1, 1.41);
    let with = |fir: Option<FirInput<'static>>| amp_hash(vec![ChannelInput { fir, ..input(&eq, &limiter, 0.0) }], 0);
    let fir = |name: Option<&'static str>, coefficients: &'static [f32]| Some(FirInput { name, coefficients });

    let base = with(fir(Some("top"), &[0.5, 0.25]));
    assert!(base.is_some());
    assert_eq!(base, with(fir(None, &[0.5, 0.25, 0.0, 0.0])), "padding and a missing name change nothing");
    assert_eq!(base, with(fir(Some("other"), &[0.5, 0.25])), "the name is not hashed");
    assert_ne!(base, with(fir(Some("top"), &[0.5, 0.250_000_03])), "one tap, one bit");
    assert_ne!(base, with(Some(NO_FIR)));
    assert_eq!(with(None), None, "an unread FIR is unreadable, not a default");

    let stats = fir_stats(&FirInput { name: Some("---"), coefficients: &[1.0, 0.0] });
    assert!(!stats.loaded && stats.name.is_none() && stats.summary == "none");
}

/// The 1.1.9 gate threshold counts only while the gate is on, and a
/// firmware without one (`None`) hashes the same whatever the project holds.
#[test]
fn gate_threshold_is_hashed_only_where_stored_and_while_on() {
    let limiter = limiter();
    let eq = eq(0.1, 1.41);
    let gate = |enabled: bool, threshold: Option<f64>| ChannelInput {
        noise_gate_enabled: enabled,
        noise_gate_threshold_dbu: threshold,
        ..input(&eq, &limiter, 0.0)
    };

    assert_ne!(amp_hash(vec![gate(true, Some(-40.0))], 0), amp_hash(vec![gate(true, Some(-30.0))], 0));
    assert_eq!(amp_hash(vec![gate(false, Some(-40.0))], 0), amp_hash(vec![gate(false, Some(-30.0))], 0));
    assert_eq!(
        amp_hash(vec![gate(true, Some(-40.0))], 0),
        amp_hash(vec![gate(true, Some(-40.2))], 0),
        "whole dBu, as the wire stores it"
    );
    assert_ne!(amp_hash(vec![gate(true, None)], 0), amp_hash(vec![gate(true, Some(-40.0))], 0));
}

#[test]
fn crc16_xmodem_check_value() {
    assert_eq!(crc16_xmodem(b"123456789"), 0x31C3);
}

#[test]
fn fnv1a_64_offset_basis() {
    assert_eq!(fnv1a_64(b""), 0xCBF2_9CE4_8422_2325);
}

#[test]
fn offline_f64_matches_online_f32_readback() {
    let limiter = limiter();
    let offline = eq(0.1, 1.41);
    let online = eq(0.1f32 as f64, 1.41f32 as f64);
    assert_eq!(
        speaker_hash(&input(&offline, &limiter, 2.35)),
        speaker_hash(&input(&online, &limiter, 2.35f32 as f64))
    );
    // And both display as the clean value, not the f32 noise.
    assert_eq!(canonical_band(&online.bands[0]).gain_db, Some(0.1));
    assert_eq!(canonical_band(&online.bands[0]).q, Some(1.41));
}

#[test]
fn real_changes_change_the_hash() {
    let limiter = limiter();
    let a = eq(0.1, 1.41);
    let b = eq(0.2, 1.41);
    assert_ne!(speaker_hash(&input(&a, &limiter, 0.0)), speaker_hash(&input(&b, &limiter, 0.0)));
}

#[test]
fn inactive_and_unused_values_are_ignored() {
    let limiter = limiter();
    let mut a = eq(3.0, 1.0);
    let mut b = eq(3.0, 1.0);
    // Leftover values on an inactive band and LP slot.
    a.bands[2].active = false;
    b.bands[2] = EqBand { gain_db: -12.0, freq_hz: 50.0, active: false, ..b.bands[2] };
    b.lp.freq_hz = 15000.0;
    // Gain/Q an all-pass filter doesn't use.
    a.bands[3].filter_type = EqFilterType::AllPass1st;
    b.bands[3] = EqBand { filter_type: EqFilterType::AllPass1st, gain_db: 9.0, q: 4.0, ..b.bands[3] };
    // A disabled peak limiter's parameters.
    let mut other_limiter = limiter;
    other_limiter.peak.threshold_vp = 300.0;
    assert_eq!(speaker_hash(&input(&a, &limiter, 0.0)), speaker_hash(&input(&b, &other_limiter, 0.0)));
}

#[test]
fn bypassed_values_stay_visible_and_unused_ones_are_null() {
    let band = EqBand { filter_type: EqFilterType::Peaking, freq_hz: 56.0, gain_db: 9.0, q: 1.8, active: false };
    let shown = canonical_band(&band);
    assert_eq!((shown.freq_hz, shown.gain_db, shown.q, shown.active), (56.0, Some(9.0), Some(1.8), false));

    let all_pass = canonical_band(&EqBand { filter_type: EqFilterType::AllPass1st, active: true, ..band });
    assert_eq!((all_pass.gain_db, all_pass.q), (None, None));
}

#[test]
fn crosspoints_beyond_topology_are_ignored() {
    // The CVR parser reads 4 crosspoints even on a 2-channel amp, whose
    // project only has 2.
    let limiter = limiter();
    let eq = eq(0.0, 1.0);
    let planned = [
        MatrixCrosspoint { source_index: 0, gain_db: 0.0, active: true },
        MatrixCrosspoint { source_index: 1, gain_db: -3.0, active: true },
    ];
    let read_back = [
        planned[0].clone(),
        planned[1].clone(),
        MatrixCrosspoint { source_index: 2, gain_db: 6.0, active: true },
        MatrixCrosspoint { source_index: 3, gain_db: -80.0, active: false },
    ];
    let project = ChannelInput { matrix_crosspoints: &planned, ..input(&eq, &limiter, 0.0) };
    let live = ChannelInput { matrix_crosspoints: &read_back, ..input(&eq, &limiter, 0.0) };
    let project_hash = amp_hash(vec![project], 2);
    assert!(project_hash.is_some());
    assert_eq!(project_hash, amp_hash(vec![live], 2));
}

fn fingerprint(inputs: Vec<ChannelInput>) -> AmpFingerprint {
    let origin = FingerprintOrigin {
        kind: FingerprintSource::Offline,
        project_id: None,
        assignment_id: None,
        device_id: None,
        mac: None,
        label: None,
    };
    let identity = AmpIdentity {
        model: Some("DSP-1002".to_string()),
        amp_model_id: None,
        channel_count: inputs.len() as u32,
        firmware_family: Some("1.1.8".to_string()),
    };
    build(origin, identity, 0, no_amp_settings(), inputs, Vec::new())
}

#[test]
fn comparison_agrees_with_the_hash() {
    let limiter = limiter();
    let base = eq(3.0, 1.0);
    // Leftover frequency on the (inactive) LP slot — ignored by the hash.
    let mut leftovers = eq(3.0, 1.0);
    leftovers.lp.freq_hz = 15000.0;
    let mut changed = eq(3.0, 1.0);
    changed.bands[0].gain_db = 4.5;

    let a = fingerprint(vec![input(&base, &limiter, 0.0)]);
    let same = fingerprint(vec![input(&leftovers, &limiter, 0.0)]);
    assert!(a.amp_hash.is_some());
    assert_eq!(a.amp_hash, same.amp_hash);
    assert!(compare_fingerprints(&a, &same).iter().all(|r| !r.differs));

    let b = fingerprint(vec![input(&changed, &limiter, 0.0)]);
    assert_ne!(a.amp_hash, b.amp_hash);
    let differing: Vec<_> = compare_fingerprints(&a, &b).into_iter().filter(|r| r.differs).collect();
    // `input()` feeds the same EQ to both sides of the channel.
    assert_eq!(differing.len(), 2);
    assert!(differing.iter().any(|r| r.group == "Out A" && r.label == "Output EQ · Band 1"));
    assert!(differing.iter().any(|r| r.group == "In 1" && r.label == "Input EQ · Band 1"));
}

#[test]
fn output_name_hash_suffix_and_default_label_are_ignored() {
    assert_eq!(canonical_output_name(0, Some("Kick_A91C")), canonical_output_name(0, Some("Kick")));
    assert_eq!(canonical_output_name(1, Some("OutB")), "");
    assert_eq!(canonical_output_name(1, Some("Out2")), "");
    assert_eq!(canonical_output_name(0, Some("Sub")), "Sub");
}

#[test]
fn default_input_label_equals_unnamed() {
    assert_eq!(canonical_input_name(0, Some("In1")), canonical_input_name(0, None));
    assert_eq!(canonical_input_name(3, Some(" in4 ")), "");
    assert_eq!(canonical_input_name(0, Some("In2")), "In2");
    assert_eq!(canonical_input_name(1, Some("Kick")), "Kick");
}

#[test]
fn name_suffix_split() {
    assert_eq!(split_hash_suffix("Top Left Sp_A91C"), ("Top Left Sp", Some("A91C".to_string())));
    assert_eq!(split_hash_suffix("Sub_a91c").1.as_deref(), Some("A91C"));
    assert_eq!(split_hash_suffix("Sub_XYZ1"), ("Sub_XYZ1", None));
    assert_eq!(split_hash_suffix("Sub"), ("Sub", None));
}
