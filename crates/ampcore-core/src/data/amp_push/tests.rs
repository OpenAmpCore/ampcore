use super::super::amp_merge::mirror_live_into_assignment;
use super::super::edit_lock::LiveAmpReading;
use super::super::fingerprint::{fingerprint_live_device, fingerprint_project_amp};
use super::super::project::{ChannelFir, ChannelSource, Project};
use super::super::test_fixtures::*;
use super::*;
use crate::live::cvr::bridge::DeviceBridgeSnapshot;

fn bridged() -> Vec<Option<bool>> {
    vec![Some(true), Some(false)]
}

/// The amp's side of the conversation: obeys one planned write the way the
/// device would, so a plan can be replayed against a snapshot and the
/// result re-fingerprinted. Any field this doesn't model would show up as
/// a surviving difference in `push_makes_hashes_equal`.
fn apply(
    action: &PushAction,
    snapshot: &mut ChannelConfigSnapshot,
    device_name: &mut String,
    bridged: &mut [Option<bool>],
) {
    let channel_of = |snapshot: &mut ChannelConfigSnapshot, ch: u8| -> usize {
        snapshot.channels.iter().position(|c| c.channel_index == u32::from(ch)).expect("channel in snapshot")
    };
    match action {
        PushAction::DeviceName { name } => *device_name = name.clone(),
        PushAction::Source { channel, kind, analog_index } => {
            let i = channel_of(snapshot, *channel);
            // Digital inputs read back 1:1 with their channel; only an
            // analog pick carries its own index (see `plan_input`).
            let index = analog_index.map(u32::from).unwrap_or(u32::from(*channel));
            snapshot.channels[i].source = Some(ChannelSource { kind: *kind, index });
        }
        PushAction::InputMute { channel, muted } => {
            let i = channel_of(snapshot, *channel);
            snapshot.channels[i].input_muted = *muted;
        }
        PushAction::DelayIn { channel, delay_ms } => {
            let i = channel_of(snapshot, *channel);
            snapshot.channels[i].delay_in_ms = *delay_ms as f32;
        }
        PushAction::SourceTrim { channel, family, trim_db, delay_ms } => {
            let i = channel_of(snapshot, *channel);
            let config = &mut snapshot.channels[i];
            let (trim, delay) = (*trim_db as f32, *delay_ms as f32);
            match family {
                SourceTrimFamily::Analog => (config.analog_trim_db, config.analog_delay_ms) = (trim, delay),
                SourceTrimFamily::Dante => (config.dante_trim_db, config.dante_delay_ms) = (trim, delay),
            }
        }
        PushAction::EqChain { channel, direction, eq, wire: chain } => {
            let i = channel_of(snapshot, *channel);
            let config = &mut snapshot.channels[i];
            let (live_eq, live_wire) = match direction {
                EqDirection::Input => (&mut config.input_eq, &mut config.input_eq_wire),
                EqDirection::Output => (&mut config.output_eq, &mut config.output_eq_wire),
            };
            // FC=52 replaces the whole chain, so the device ends up
            // holding every slot that was sent — including bands the hash
            // ignores. Values land as f32, which is what makes the
            // rounding in `differs` load-bearing.
            live_eq.hp = CrossoverSlot { freq_hz: wire(eq.hp.freq_hz), ..eq.hp };
            live_eq.lp = CrossoverSlot { freq_hz: wire(eq.lp.freq_hz), ..eq.lp };
            for (band_index, band) in eq.bands.iter().enumerate() {
                // Unlike the per-band path, gain and Q are always carried
                // — the body has no way to omit them.
                live_eq.bands[band_index] = EqBand {
                    freq_hz: wire(band.freq_hz),
                    gain_db: wire(band.gain_db),
                    q: wire(band.q),
                    ..*band
                };
            }
            // The companion bytes were echoed, so this must leave them
            // exactly as they were — a mapping bug in `eq_chain_bands`
            // shows up here as a changed value.
            *live_wire = chain.clone();
        }
        PushAction::MatrixCrosspoint { channel, source_index, gain_db, active } => {
            let i = channel_of(snapshot, *channel);
            let crosspoint = snapshot.channels[i]
                .matrix_crosspoints
                .iter_mut()
                .find(|cp| cp.source_index == u32::from(*source_index))
                .expect("crosspoint in snapshot");
            crosspoint.gain_db = wire(*gain_db);
            crosspoint.active = *active;
        }
        PushAction::OutputTrim { channel, trim_db } => {
            let i = channel_of(snapshot, *channel);
            snapshot.channels[i].output_trim_db = *trim_db as f32;
        }
        PushAction::OutputVolume { channel, volume_db } => {
            let i = channel_of(snapshot, *channel);
            snapshot.channels[i].output_volume_db = *volume_db as f32;
        }
        PushAction::OutputMute { channel, muted } => {
            let i = channel_of(snapshot, *channel);
            snapshot.channels[i].output_muted = *muted;
        }
        PushAction::DelayOut { channel, delay_ms } => {
            let i = channel_of(snapshot, *channel);
            snapshot.channels[i].delay_out_ms = *delay_ms as f32;
        }
        PushAction::PhaseInvert { channel, inverted } => {
            let i = channel_of(snapshot, *channel);
            snapshot.channels[i].output_phase_inverted = *inverted;
        }
        PushAction::PowerMode { channel, mode } => {
            let i = channel_of(snapshot, *channel);
            snapshot.channels[i].power_mode = Some(*mode);
        }
        PushAction::FirBypass { channel, bypassed } => {
            let i = channel_of(snapshot, *channel);
            snapshot.channels[i].fir_bypassed = *bypassed;
        }
        // Not in the FC=27 snapshot, and never planned by `plan_push`.
        PushAction::FirData { .. } => {}
        PushAction::NoiseGate { channel, enabled, threshold_dbu } => {
            let i = channel_of(snapshot, *channel);
            let config = &mut snapshot.channels[i];
            config.noise_gate_enabled = *enabled;
            // Only 1.1.9+ stores a threshold (FC=87); 1.1.8 reports none.
            if config.noise_gate_threshold_dbu.is_some() {
                config.noise_gate_threshold_dbu = Some(*threshold_dbu);
            }
        }
        PushAction::RmsLimiter { channel, enabled, threshold_vrms, attack_ms, release_multiplier } => {
            let i = channel_of(snapshot, *channel);
            let rms = &mut snapshot.channels[i].limiter.rms;
            rms.enabled = *enabled;
            rms.threshold_vrms = wire(*threshold_vrms);
            // The wire narrows these to u16/u8.
            rms.attack_ms = (*attack_ms as u16) as f64;
            rms.release_multiplier = (*release_multiplier as u8) as f64;
        }
        PushAction::RmsLimiterAuto { channel, auto } => {
            let i = channel_of(snapshot, *channel);
            snapshot.channels[i].limiter.rms.auto = *auto;
        }
        PushAction::PeakLimiter { channel, enabled, threshold_vp, hold_ms, release_ms } => {
            let i = channel_of(snapshot, *channel);
            let peak = &mut snapshot.channels[i].limiter.peak;
            peak.enabled = *enabled;
            peak.threshold_vp = wire(*threshold_vp);
            peak.hold_ms = (*hold_ms as u16) as f64;
            peak.release_ms = (*release_ms as u16) as f64;
        }
        PushAction::ChannelName { channel, direction, name } => {
            let i = channel_of(snapshot, *channel);
            let config = &mut snapshot.channels[i];
            let stored = Some(name.clone());
            match direction {
                EqDirection::Input => config.input_name = stored,
                EqDirection::Output => config.output_name = stored,
            }
        }
        PushAction::Bridge { pair_index, bridged: value } => {
            bridged[*pair_index as usize] = Some(*value);
        }
    }
}

/// Replays a whole plan, stage by stage in order, the way the command does.
fn replay(plan: &PushPlan, snapshot: &mut ChannelConfigSnapshot, name: &mut String, bridged: &mut [Option<bool>]) {
    for stage in &plan.stages {
        for action in &stage.actions {
            apply(action, snapshot, name, bridged);
        }
    }
}

/// The inverse of `amp_merge`'s `merge_makes_hashes_equal`, and the test
/// that actually proves the feature: plan a push from a default project
/// amp onto a fully tuned amp, obey every write, adopt the two
/// device-determined fields, and the two fingerprints must agree.
#[test]
fn push_makes_hashes_equal() {
    let (models, links) = (models(), links());
    let project = Project::new("Test".to_string(), String::new());
    let mut assignment = assignment();
    // A filter the amp doesn't hold yet, so the FIR stage has work too.
    assignment.channels[0].fir = ChannelFir { name: "top".to_string(), coefficients: vec![0.5, 0.25] };
    let mut snapshot = snapshot();
    let mut name = DEVICE_NAME.to_string();
    let mut bridged = bridged();
    let mut fir = firs();

    let before = fingerprint_project_amp(&project, &assignment, &models);
    let live_before = fingerprint_live_device(&device(), &snapshot, Some(&DeviceBridgeSnapshot { bridged: bridged.clone(), received_at: 0.0 }), &fir, &models, &links);
    assert!(live_before.missing.is_empty(), "{:?}", live_before.missing);
    assert_ne!(before.amp_hash, live_before.amp_hash, "the fixture must start out different");

    let plan = plan_push(&assignment, &snapshot, &name, &bridged, 4).expect("plan");
    assert!(!plan.stages.is_empty());
    replay(&plan, &mut snapshot, &mut name, &mut bridged);
    // FIR is planned against the driver's own readings and obeyed likewise.
    for stage in plan_fir(&assignment, &fir) {
        for action in &stage.actions {
            if let PushAction::FirData { channel, name, coefficients } = action {
                fir[*channel as usize] = fir_snapshot(u32::from(*channel), name, coefficients);
            }
        }
    }
    adopt_device_facts(&mut assignment, &snapshot);

    let mut device = device();
    device.name = name;
    let after = fingerprint_project_amp(&project, &assignment, &models);
    let live_after = fingerprint_live_device(
        &device,
        &snapshot,
        Some(&DeviceBridgeSnapshot { bridged: bridged.clone(), received_at: 0.0 }),
        &fir,
        &models,
        &links,
    );
    assert!(live_after.missing.is_empty(), "{:?}", live_after.missing);
    assert_eq!(after.amp_hash, live_after.amp_hash, "a fully replayed push must converge");
}

/// On 1.1.9 a gate threshold that differs by itself must be pushed, sent
/// rounded (not truncated), and converge; with the gate off it is ignored.
#[test]
fn gate_threshold_pushes_on_1_1_9_only_while_on() {
    let (models, links) = (models(), links());
    let project = Project::new("Test".to_string(), String::new());
    let mut device = device();
    device.firmware_version = "1.1.9".to_string();
    device.firmware_family = Some("1.1.9".to_string());
    let mut snapshot = snapshot();
    for config in &mut snapshot.channels {
        config.noise_gate_threshold_dbu = Some(-37);
    }
    let reading =
        LiveAmpReading { device: device.clone(), snapshot: Some(snapshot.clone()), bridge: Some(DeviceBridgeSnapshot { bridged: bridged(), received_at: 0.0 }), fir: firs() };
    let mut assignment = assignment();
    assignment.firmware_version = Some("1.1.9".to_string());
    let mut assignment = mirror_live_into_assignment(&assignment, &reading, 4);
    // Channel 3 has its gate on in the fixture; channel 0 has it off.
    assignment.channels[3].noise_gate_threshold_dbu = -45.6;
    assignment.channels[0].noise_gate_threshold_dbu = -10.0;

    let plan = plan_push(&assignment, &snapshot, DEVICE_NAME, &bridged(), 4).expect("plan");
    let gates: Vec<_> = plan
        .stages
        .iter()
        .flat_map(|s| &s.actions)
        .filter_map(|a| match a {
            PushAction::NoiseGate { channel, threshold_dbu, .. } => Some((*channel, *threshold_dbu)),
            _ => None,
        })
        .collect();
    assert_eq!(gates, [(3, -46)]);

    let (mut name, mut bridged) = (DEVICE_NAME.to_string(), bridged());
    replay(&plan, &mut snapshot, &mut name, &mut bridged);
    let live = fingerprint_live_device(&device, &snapshot, Some(&DeviceBridgeSnapshot { bridged, received_at: 0.0 }), &firs(), &models, &links);
    assert_eq!(fingerprint_project_amp(&project, &assignment, &models).amp_hash, live.amp_hash);
}

/// A second push against an amp that already matches must plan no work —
/// otherwise the UI would offer a push that does nothing, forever.
#[test]
fn push_plan_is_empty_when_already_matching() {
    let reading = LiveAmpReading {
        device: device(),
        snapshot: Some(snapshot()),
        bridge: Some(DeviceBridgeSnapshot { bridged: bridged(), received_at: 0.0 }),
        fir: firs(),
    };
    let mirrored = mirror_live_into_assignment(&assignment(), &reading, 4);
    let plan = plan_push(&mirrored, &snapshot(), DEVICE_NAME, &bridged(), 4).expect("plan");
    assert!(plan.stages.is_empty(), "planned {:?}", plan.stages.iter().map(|s| &s.stage.id).collect::<Vec<_>>());
    assert!(plan.adopted.is_empty());
}

/// A band bypassed on both sides is invisible to the hash, so its stored
/// settings must not trigger a write however far apart they are. With the
/// chain written whole this is what keeps the predicate load-bearing: it
/// no longer decides *which* bands go out, only whether the chain does.
///
/// Starts from a mirrored assignment so the bypassed band is the *only*
/// difference — against a default project amp half the chain differs
/// anyway, and the chain would rightly be written for those reasons.
#[test]
fn bypassed_band_differences_are_skipped() {
    let reading = LiveAmpReading {
        device: device(),
        snapshot: Some(snapshot()),
        bridge: Some(DeviceBridgeSnapshot { bridged: bridged(), received_at: 0.0 }),
        fir: firs(),
    };
    let mut assignment = mirror_live_into_assignment(&assignment(), &reading, 4);
    let mut snapshot = snapshot();
    for channel in &mut assignment.channels {
        channel.input_eq.bands[1].active = false;
        channel.input_eq.bands[1].freq_hz = 777.0;
    }
    for config in &mut snapshot.channels {
        config.input_eq.bands[1].active = false;
        config.input_eq.bands[1].freq_hz = 1234.0;
    }
    let plan = plan_push(&assignment, &snapshot, DEVICE_NAME, &bridged(), 4).expect("plan");
    assert!(
        plan.stages.is_empty(),
        "a band bypassed on both sides must not trigger a chain write; planned {:?}",
        plan.stages.iter().map(|s| &s.stage.id).collect::<Vec<_>>()
    );
}

/// The two fields a push doesn't write are adopted; a local load is left alone.
#[test]
fn device_facts_are_adopted_not_pushed() {
    let mut assignment = assignment();
    assignment.channels[0].ohms = 16.0;
    let snapshot = snapshot();
    assert_ne!(assignment.channels[0].ohms, snapshot.channels[0].load_ohms as f64);

    let plan = plan_push(&assignment, &snapshot, DEVICE_NAME, &bridged(), 4).expect("plan");
    assert!(plan.adopted.iter().all(|row| row.label != "Load"));

    adopt_device_facts(&mut assignment, &snapshot);
    assert_eq!(assignment.channels[0].ohms, 16.0);
    assert_eq!(assignment.channels[0].limiter.rms.max_vrms, 127.35);
    assert_eq!(assignment.channels[0].limiter.peak.max_vp, 179.89);
}

/// Bridging re-pairs outputs, so it has to be the last thing written.
#[test]
fn bridging_is_planned_last() {
    let mut assignment = assignment();
    assignment.channels[0].output_bridged = true;
    assignment.channels[2].output_bridged = true;
    let plan = plan_push(&assignment, &snapshot(), DEVICE_NAME, &bridged(), 4).expect("plan");
    assert_eq!(plan.stages.last().expect("stages").stage.id, "bridge");
}

/// A digital input the amp would read back differently can never converge,
/// so it is refused at plan time instead of pushed.
#[test]
fn unreachable_digital_input_is_refused() {
    let mut assignment = assignment();
    assignment.channels[0].source = ChannelSource { kind: SourceKind::Dante, index: 2 };
    let error = plan_push(&assignment, &snapshot(), DEVICE_NAME, &bridged(), 4).expect_err("must refuse");
    assert!(error.0.contains("wired 1:1"), "{}", error.0);
}

#[test]
fn fir_is_planned_only_where_the_amp_holds_another() {
    let fir = |name: &str, taps: &[f32]| ChannelFir { name: name.to_string(), coefficients: taps.to_vec() };
    let mut assignment = assignment();
    assignment.channels[0].fir = fir("top", &[0.5, 0.25]);
    assignment.channels[2].fir = fir("sub", &[0.1]);
    assignment.channels[3].fir = fir("mine", &[0.9]);
    let live = [
        fir_snapshot(0, "top", &[0.5, 0.3]),
        // The wire's zero padding is no difference to the default unit impulse.
        fir_snapshot(1, "---", &[1.0]),
        // Nor is a name: it isn't hashed, so writing it could never help.
        fir_snapshot(3, "theirs", &[0.9]),
    ];
    let stages = plan_fir(&assignment, &live);
    // Channel 2 was never read, so it is left alone rather than guessed at.
    assert_eq!(stages.iter().map(|s| s.stage.id.as_str()).collect::<Vec<_>>(), ["fir-0"]);
    assert_eq!(stages[0].stage.packets, 5);
    assert!(matches!(&stages[0].actions[..], [PushAction::FirData { channel: 0, .. }]));
    let packets = action_packets(&stages[0].actions[0], Some("1.1.8")).expect("1.1.8 encodes FIR");
    assert_eq!(packets.len() as u32, stages[0].stage.packets);
}

/// The regression this change exists for: a chain that differs anywhere is
/// one packet, not up to 38. Guards against a future refactor quietly
/// reintroducing the per-band plan.
#[test]
fn a_differing_chain_costs_one_packet() {
    let mut assignment = assignment();
    // One band's gain, on one side of one channel.
    assignment.channels[0].input_eq.bands[2].gain_db = 4.5;
    assignment.channels[0].input_eq.bands[2].active = true;

    let plan = plan_push(&assignment, &snapshot(), DEVICE_NAME, &bridged(), 4).expect("plan");
    let eq_stages: Vec<_> = plan.stages.iter().filter(|s| s.stage.id == "in-eq-0").collect();
    assert_eq!(eq_stages.len(), 1);
    assert_eq!(eq_stages[0].stage.packets, 1, "a whole chain is one FC=52 write");
    assert!(matches!(
        eq_stages[0].actions.as_slice(),
        [PushAction::EqChain { direction: EqDirection::Input, .. }]
    ));
}

/// A whole-chain write still carries the slots the hash ignores, so after
/// a push the amp holds the project's values throughout rather than a
/// mixture — while convergence stays driven by the hashed ones only.
#[test]
fn a_chain_write_carries_every_slot() {
    let mut assignment = assignment();
    let mut snapshot = snapshot();
    // Band 2 is what triggers the write; band 1 is bypassed on both sides
    // and so invisible to the hash, but must still be sent.
    assignment.channels[0].input_eq.bands[2].gain_db = 4.5;
    assignment.channels[0].input_eq.bands[2].active = true;
    assignment.channels[0].input_eq.bands[1].active = false;
    assignment.channels[0].input_eq.bands[1].freq_hz = 777.0;
    snapshot.channels[0].input_eq.bands[1].active = false;
    snapshot.channels[0].input_eq.bands[1].freq_hz = 1234.0;

    let plan = plan_push(&assignment, &snapshot, DEVICE_NAME, &bridged(), 4).expect("plan");
    let mut name = DEVICE_NAME.to_string();
    let mut bridged = bridged();
    replay(&plan, &mut snapshot, &mut name, &mut bridged);

    assert_eq!(snapshot.channels[0].input_eq.bands[1].freq_hz, 777.0, "the ignored band went out too");
    assert_eq!(snapshot.channels[0].input_eq.bands[2].gain_db, 4.5);
}

/// An edit that landed while the push ran survives it; the push's own
/// change wins where it made one.
#[test]
fn a_stored_candidate_keeps_edits_made_meanwhile() {
    let base = assignment();
    let mut edited = base.clone();
    edited.channels[0].output_bridged = true;
    edited.device_name = Some("Pushed".into());
    let mut current = base.clone();
    current.channels[1].output_volume_db = -6.0;
    current.channels[0].output_name = Some("Meanwhile".into());
    current.device_name = Some("Meanwhile".into());

    let stored = rebase_candidate(&current, &base, &edited).expect("rebase");
    assert!(stored.channels[0].output_bridged);
    assert_eq!(stored.channels[1].output_volume_db, -6.0);
    assert_eq!(stored.channels[0].output_name.as_deref(), Some("Meanwhile"));
    assert_eq!(stored.device_name.as_deref(), Some("Pushed"));
}
