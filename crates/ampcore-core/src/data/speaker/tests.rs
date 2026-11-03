use super::*;

fn channel() -> AmpChannel {
    AmpAssignment::new(None, None, 2, None, None).channels[0].clone()
}

fn details(ways: usize) -> SpeakerDetails {
    SpeakerDetails {
        brand: "Seeburg".into(),
        family: "PS1".into(),
        model: "Hi".into(),
        application: String::new(),
        notes: String::new(),
        way_labels: (0..ways).map(|i| format!("W{i}")).collect(),
    }
}

/// `save_edit` with the edit's ways in stored order (any beyond the
/// stored ones count as added).
fn save(entry: &mut SpeakerLibraryEntry, edit: SpeakerLibraryEntry) -> Result<(), String> {
    let stored = entry.ways.len() as u32;
    let origins: Vec<_> = (0..edit.ways.len() as u32).map(|i| Some(i).filter(|&i| i < stored)).collect();
    entry.save_edit(edit, &origins)
}

/// Removing a middle way: its outputs lose the speaker, later ways' outputs
/// follow their way, and stale origins are refused.
#[test]
fn removing_a_middle_way_moves_its_outputs_along() {
    let p = SpeakerProcessing::from_channel(&channel());
    let mut entry = SpeakerLibraryEntry::new(details(3), vec![p.clone(), p.clone(), p]).unwrap();
    let mut project = Project::new("P".into(), String::new());
    let mut amp = AmpAssignment::new(None, None, 4, None, None);
    for way in 0..3 {
        amp.channels[way].speaker = Some(entry.reference(way as u32).unwrap());
    }
    amp.channels[3].speaker = Some(SpeakerRef { library_id: "other".into(), ..entry.reference(2).unwrap() });
    project.amp_assignments.push(amp);

    let origins = [Some(0), Some(2)];
    let mut edit = entry.clone();
    edit.ways.remove(1);
    assert!(entry.save_edit(edit.clone(), &[Some(0), Some(5)]).is_err(), "no stored way 5");
    assert!(entry.save_edit(edit.clone(), &[Some(0), Some(0)]).is_err(), "a way can't come from one twice");
    entry.save_edit(edit, &origins).unwrap();
    assert_eq!(entry.ways.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(), ["W0", "W2"]);

    assert!(remap_way_refs(&mut project, &entry.id, &origins));
    let ways: Vec<_> = project.amp_assignments[0].channels.iter().map(|c| c.speaker.as_ref().map(|s| s.way_index)).collect();
    assert_eq!(ways, [Some(0), None, Some(1), Some(2)], "the other speaker's output is left alone");
    assert!(!remap_way_refs(&mut project, &entry.id, &[Some(0), Some(1)]), "nothing left to move");
}

#[test]
fn status_follows_values_and_revision() {
    let mut ch = channel();
    ch.delay_out_ms = 2.5;
    let mut entry = SpeakerLibraryEntry::new(details(1), vec![SpeakerProcessing::from_channel(&ch)]).unwrap();
    let speaker = entry.reference(0).unwrap();
    assert_eq!(speaker.label, "Seeburg Hi");
    let library = vec![entry.clone()];
    assert!(matches!(speaker_status(&ch, &speaker, &library, None), SpeakerStatus::Match));

    // f32 wire rounding must not read as an edit.
    ch.delay_out_ms = 2.5 + 1e-9;
    assert!(matches!(speaker_status(&ch, &speaker, &library, None), SpeakerStatus::Match));

    ch.output_eq.bands[2].gain_db += 1.5;
    ch.output_eq.bands[2].active = true;
    match speaker_status(&ch, &speaker, &library, None) {
        SpeakerStatus::Edited { fields } => assert_eq!(fields, ["EQ · Band 3"]),
        other => panic!("{other:?}"),
    }

    // The library catching up with the output is no news.
    entry.set_way_processing(0, SpeakerProcessing::from_channel(&ch)).unwrap();
    assert!(matches!(speaker_status(&ch, &speaker, &[entry.clone()], None), SpeakerStatus::Match));

    let mut moved = SpeakerProcessing::from_channel(&ch);
    moved.delay_out_ms = 4.0;
    entry.set_way_processing(0, moved).unwrap();
    match speaker_status(&ch, &speaker, &[entry.clone()], None) {
        SpeakerStatus::LibraryUpdated { fields } => assert_eq!(fields, ["Delay"]),
        other => panic!("{other:?}"),
    }

    assert!(matches!(speaker_status(&ch, &speaker, &[], None), SpeakerStatus::Detached));
}

/// A way whose peak sits below the floor used to read "Edited" forever:
/// apply raised it, the library didn't.
#[test]
fn imported_way_applies_to_match() {
    let mut data = crate::live::cvr::speaker_data::decode_speaker_data(&vec![0u8; 2310]).unwrap();
    data.limiter.rms.threshold_vrms = 50.0;
    data.limiter.peak.threshold_vp = 60.0;
    data.limiter.peak.enabled = true;
    let processing = SpeakerProcessing::from_speaker_data(&data);
    assert!((processing.limiter.peak.threshold_vp - 50.0 * std::f64::consts::SQRT_2).abs() < 1e-9, "floored on import");
    let entry = SpeakerLibraryEntry::new(details(1), vec![processing.clone()]).unwrap();
    let mut ch = channel();
    processing.apply_to(&mut ch);
    let speaker = entry.reference(0).unwrap();
    assert!(matches!(speaker_status(&ch, &speaker, &[entry], None), SpeakerStatus::Match));
}

fn capability(firmware: &str) -> AmpCapability {
    let model = crate::data::test_fixtures::models().remove(0);
    crate::data::capability::resolve(&model, Some(firmware))
}

fn profile_json(ways: &[&str]) -> String {
    let ways: Vec<String> = ways
        .iter()
        .enumerate()
        .map(|(i, hex)| format!(r#"{{"label":"W{i}","deviceData":{{"hex":"{hex}"}}}}"#))
        .collect();
    format!(r#"{{"speaker":{{"brand":"Seeburg","model":"Hi","ways":[{}]}}}}"#, ways.join(","))
}

#[test]
fn imports_old_profile_files() {
    let hex = "00".repeat(2310);
    let profile: OldProfile = serde_json::from_str(&profile_json(&[&hex, &hex])).unwrap();
    let entry = SpeakerLibraryEntry::from_profile(&profile).unwrap();
    assert_eq!((entry.brand.as_str(), entry.ways.len()), ("Seeburg", 2));
    assert_eq!(entry.ways[1].label, "W1");
    assert_eq!(entry.ways[0].fc57_hex.as_deref(), Some(hex.as_str()));

    let no_ways: OldProfile = serde_json::from_str(&profile_json(&[])).unwrap();
    assert!(SpeakerLibraryEntry::from_profile(&no_ways).is_err());
    for bad in ["zz", "", "00"] {
        let p: OldProfile = serde_json::from_str(&profile_json(&[bad])).unwrap();
        assert!(SpeakerLibraryEntry::from_profile(&p).is_err(), "{bad:?}");
    }
}

#[test]
fn fit_reports_what_the_amp_cannot_take() {
    let ch = channel();
    let cap = capability("1.1.8");
    let mut way = SpeakerProcessing::from_channel(&ch);
    assert!(way.fit(&ch, &cap).unwrap().1.is_empty(), "an amp's own values always fit");

    way.delay_out_ms = 25.0;
    way.output_eq.bands[2].active = true;
    way.output_eq.bands[2].gain_db = 30.0; // above the vendor's ±24 dB
    way.output_eq.bands.push(way.output_eq.bands[0]); // a 9th band the amp lacks
    way.output_eq.bands[8].active = true;
    let (fitted, issues) = way.fit(&ch, &cap).unwrap();
    assert_eq!(fitted.delay_out_ms, 20.0);
    assert_eq!(fitted.output_eq.bands[2].gain_db, 24.0);
    assert_eq!(fitted.output_eq.bands.len(), ch.output_eq.bands.len());
    assert!(issues.iter().any(|i| i.starts_with("Delay: 25.00 → 20.00")), "{issues:?}");
    assert!(issues.iter().any(|i| i.starts_with("EQ · Band 3 gain")), "{issues:?}");
    assert!(issues.iter().any(|i| i.starts_with("EQ · Band 9: dropped")), "{issues:?}");

    // A preset with fewer bands keeps the amp's own for the rest.
    let mut short = SpeakerProcessing::from_channel(&ch);
    short.output_eq.bands.truncate(6);
    let (fitted, issues) = short.fit(&ch, &cap).unwrap();
    assert_eq!(fitted.output_eq.bands.len(), ch.output_eq.bands.len());
    assert_eq!(issues.len(), ch.output_eq.bands.len() - 6);

    assert!(way.fit(&ch, &capability("1.0.5")).is_err(), "no speaker management before 1.1.8");
}

/// A way the amp had to clamp reads Match once applied — and Edited only
/// when the output is changed after that.
#[test]
fn a_clamped_way_matches_once_applied() {
    let cap = capability("1.1.8");
    let mut ch = channel();
    let mut way = SpeakerProcessing::from_channel(&ch);
    way.delay_out_ms = 25.0; // the amp takes 20
    let entry = SpeakerLibraryEntry::new(details(1), vec![way.clone()]).unwrap();
    let speaker = entry.reference(0).unwrap();
    way.fit(&ch, &cap).unwrap().0.apply_to(&mut ch);
    let library = [entry];
    assert!(matches!(speaker_status(&ch, &speaker, &library, Some(&cap)), SpeakerStatus::Match));
    assert!(matches!(speaker_status(&ch, &speaker, &library, None), SpeakerStatus::Edited { .. }));
    ch.delay_out_ms = 3.0;
    assert!(matches!(speaker_status(&ch, &speaker, &library, Some(&cap)), SpeakerStatus::Edited { .. }));
}

#[test]
fn whole_output_conflicts_with_older_firmware() {
    let mut saved_on_119 = channel();
    saved_on_119.noise_gate_threshold_dbu = -40.0;
    let way = SpeakerProcessing::from_channel(&saved_on_119);
    let mut target = channel();
    target.noise_gate_threshold_dbu = -60.0;
    let (fitted, issues) = way.fit(&target, &capability("1.1.8")).unwrap();
    assert!(issues.iter().any(|i| i.starts_with("Noise gate threshold")), "{issues:?}");
    assert_eq!(fitted.noise_gate_threshold_dbu, -60.0, "the amp keeps its own");
    assert!(way.fit(&target, &capability("1.1.9")).unwrap().1.is_empty());
}

/// A speaker carries the whole output: an imported one starts trim, gate
/// and power mode at a fresh output's values, applying writes them, and
/// any of them changed on the output afterwards reads Edited.
#[test]
fn a_speaker_owns_the_whole_output() {
    let profile: OldProfile = serde_json::from_str(&profile_json(&["00".repeat(2310).as_str()])).unwrap();
    let entry = SpeakerLibraryEntry::from_profile(&profile).unwrap();
    let way = &entry.ways[0].processing;
    let neutral = SpeakerProcessing::neutral();
    assert!(neutral.fir_bypassed, "a fresh way's empty FIR starts bypassed");
    assert_eq!(
        (way.output_trim_db, way.noise_gate_enabled, way.power_mode),
        (neutral.output_trim_db, neutral.noise_gate_enabled, neutral.power_mode)
    );

    let mut ch = channel();
    ch.output_trim_db = -3.0;
    ch.noise_gate_enabled = true;
    ch.power_mode = PowerMode::V70;
    way.apply_to(&mut ch);
    assert_eq!((ch.output_trim_db, ch.noise_gate_enabled, ch.power_mode), (0.0, false, neutral.power_mode));

    let speaker = entry.reference(0).unwrap();
    let library = [entry.clone()];
    assert!(matches!(speaker_status(&ch, &speaker, &library, None), SpeakerStatus::Match));
    ch.power_mode = PowerMode::V100;
    match speaker_status(&ch, &speaker, &library, None) {
        SpeakerStatus::Edited { fields } => assert_eq!(fields, ["Power mode"]),
        other => panic!("{other:?}"),
    }
}

#[test]
fn fir_travels_with_the_preset() {
    let mut hex = "00".repeat(2310);
    // FIR name "top" at +32, first tap 0.5 at +64.
    hex.replace_range(64..70, "746f70");
    hex.replace_range(128..136, "0000003f");
    let profile: OldProfile = serde_json::from_str(&profile_json(&[&hex])).unwrap();
    let entry = SpeakerLibraryEntry::from_profile(&profile).unwrap();
    let fir = entry.ways[0].processing.fir.clone();
    assert_eq!((fir.name.as_str(), fir.coefficients[0], fir.coefficients.len()), ("top", 0.5, 512));

    // Applied, the output matches; with another filter on it, it doesn't.
    let mut ch = channel();
    let (fitted, issues) = entry.ways[0].processing.fit(&ch, &capability("1.1.8")).unwrap();
    assert!(!issues.iter().any(|i| i.starts_with("FIR")), "{issues:?}");
    assert!(fitted.fir.same_taps(&fir.coefficients), "1.1.8 has FIR, so it is kept");
    entry.ways[0].processing.apply_to(&mut ch);
    let speaker = entry.reference(0).unwrap();
    assert!(matches!(speaker_status(&ch, &speaker, &[entry.clone()], None), SpeakerStatus::Match));
    ch.fir = ChannelFir::identity();
    match speaker_status(&ch, &speaker, &[entry], None) {
        SpeakerStatus::Edited { fields } => assert_eq!(fields, ["FIR filter"]),
        other => panic!("{other:?}"),
    }
}

#[test]
fn details_rules() {
    let p = SpeakerProcessing::from_channel(&channel());
    assert!(SpeakerLibraryEntry::new(details(2), vec![p.clone()]).is_err(), "label count must match");
    let mut no_brand = details(1);
    no_brand.brand = " ".into();
    assert!(SpeakerLibraryEntry::new(no_brand, vec![p.clone()]).is_err());

    let mut entry = SpeakerLibraryEntry::new(details(2), vec![p.clone(), p]).unwrap();
    assert_eq!(entry.reference(1).unwrap().label, "Seeburg Hi · W1");
    let rev = entry.revision;
    entry.set_details(details(2)).unwrap();
    assert_eq!(entry.revision, rev, "metadata never bumps the revision");
}

/// A hand edit stores what an import would: the peak floor applied, and no
/// blob that no longer matches the values.
#[test]
fn a_way_edit_applies_the_peak_floor_and_drops_the_blob() {
    let mut p = SpeakerProcessing::from_channel(&channel());
    p.limiter.rms.threshold_vrms = 100.0;
    p.limiter.peak.threshold_vp = 50.0;
    let mut entry = SpeakerLibraryEntry::new(details(1), vec![SpeakerProcessing::from_channel(&channel())]).unwrap();
    entry.ways[0].fc57_hex = Some("00".into());

    entry.set_way_processing(0, p).unwrap();
    let limiter = entry.ways[0].processing.limiter;
    assert!((limiter.peak.threshold_vp - 100.0 * std::f64::consts::SQRT_2).abs() < 1e-9);
    assert_eq!(entry.ways[0].fc57_hex, None);
}

#[test]
fn duplicate_is_a_fresh_entry() {
    let mut ch = channel();
    ch.delay_out_ms = 1.5;
    let mut entry = SpeakerLibraryEntry::new(details(1), vec![SpeakerProcessing::from_channel(&ch)]).unwrap();
    entry.set_way_processing(0, SpeakerProcessing::from_channel(&ch)).unwrap();

    let copy = entry.duplicate();
    assert_ne!(copy.id, entry.id);
    assert_eq!(copy.model, "Hi (copy)");
    assert_eq!(copy.revision, 1);
    assert_eq!(copy.ways[0].processing.delay_out_ms, 1.5);
}

/// One editor save is one revision, and only when an output would get
/// something new.
#[test]
fn a_save_bumps_the_revision_once_and_only_for_values() {
    let p = SpeakerProcessing::from_channel(&channel());
    let mut entry = SpeakerLibraryEntry::new(details(2), vec![p.clone(), p]).unwrap();
    entry.ways[0].fc57_hex = Some("00".into());
    entry.ways[1].fc57_hex = Some("00".into());
    let rev = entry.revision;

    let same = entry.clone();
    save(&mut entry, same).unwrap();
    assert_eq!(entry.revision, rev, "a save that changes nothing");

    let mut edit = entry.clone();
    edit.model = "Renamed".into();
    edit.ways[0].label = String::new();
    edit.ways[1].nominal_ohms = Some(4.0);
    save(&mut entry, edit).unwrap();
    assert_eq!(entry.revision, rev, "metadata and impedance are not values");
    assert_eq!((entry.model.as_str(), entry.ways[0].label.as_str()), ("Renamed", "Way 1"));

    let mut edit = entry.clone();
    edit.ways[0].processing.delay_out_ms = 1.0;
    edit.ways[1].processing.phase_inverted = true;
    edit.ways[1].processing.limiter.rms.threshold_vrms = 100.0;
    edit.ways[1].processing.limiter.peak.threshold_vp = 50.0;
    save(&mut entry, edit).unwrap();
    assert_eq!(entry.revision, rev + 1, "two ways changed, one revision");
    assert_eq!(entry.ways[0].fc57_hex, None, "a changed way drops its blob");
    let peak = entry.ways[1].processing.limiter.peak.threshold_vp;
    assert!((peak - 100.0 * std::f64::consts::SQRT_2).abs() < 1e-9, "peak floor applied");

    let mut edit = entry.clone();
    edit.ways.pop();
    save(&mut entry, edit).unwrap();
    assert_eq!((entry.ways.len(), entry.revision), (1, rev + 2), "way count is a change");

    let mut bad = entry.clone();
    bad.ways[0].nominal_ohms = Some(0.0);
    assert!(save(&mut entry, bad).is_err());
    let mut bad = entry.clone();
    bad.ways.clear();
    assert!(save(&mut entry, bad).is_err());
    let mut bad = entry.clone();
    bad.ways = vec![bad.ways[0].clone(); MAX_WAYS + 1];
    assert!(save(&mut entry, bad).is_err(), "at most {MAX_WAYS} ways");
}
