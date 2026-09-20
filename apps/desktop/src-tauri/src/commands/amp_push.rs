//! Online ← offline push commands: plan the writes that make a linked network
//! amp adopt its project amp's settings, then execute them in order.
//!
//! The counterpart to `amp_links.rs::projects_merge_amp_from_live`, and it
//! borrows that command's guard sequence verbatim — a push and a pull are
//! valid under exactly the same preconditions. What differs is the ending: a
//! pull is one all-or-nothing in-memory swap, while a push leaves real
//! hardware partly configured if it fails halfway. That is why it stops at the
//! first failed write and reports which stage, rather than pretending to be a
//! transaction: planning again resumes from whatever is still different.
//!
//! See `data/amp_push.rs` for what is planned, in what order, and why three
//! device-determined fields flow the other way instead.

use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use ampcore_core::data::amp_link::normalize_mac;
use ampcore_core::data::amp_push::{adopt_device_facts, plan_push, AmpPushPlan, PushAction, PushPlan};
use ampcore_core::data::capability::SourceKind;
use ampcore_core::data::edit_lock::LiveAmpReading;
use ampcore_core::data::fingerprint::{compare_fingerprints, fingerprint_live_device, fingerprint_project_amp, FingerprintRow};
use ampcore_core::data::project::{ChannelEq, EqDirection, Project};
use crate::data::store::{save_project_file, ProjectDataState};
use ampcore_core::error::AppError;
use ampcore_core::live::cvr::channel_config::{ChannelConfigSnapshot, EqChainWire};
use ampcore_core::live::cvr::channel_config_v118::{crossover_filter_type_code, eq_filter_type_code};
use ampcore_core::live::cvr::write;
use ampcore_core::live::cvr::write_v118::{EqChainBand, EQ_CHAIN_BANDS};
use ampcore_core::live::state::LiveDeviceState;

use super::amp_links::read_linked_amp;
use ampcore_core::live::write_helpers::{resolve_write_target, unknown_firmware_error, WriteTally};

/// How long to wait for an FC=27 poll that postdates the last write before
/// giving up on verifying the push.
///
/// Background polling is suppressed for the whole push (`WriteRegistry::
/// has_pending`), so the cached snapshot is always stale by the time the last
/// ACK lands — the amp's real state only becomes observable one poll later.
/// The driver's config tick runs at ~200 ms, so this is generous; exceeding it
/// means the amp went quiet, which is worth reporting rather than hiding.
const FRESH_SNAPSHOT_TIMEOUT: Duration = Duration::from_millis(3000);
const FRESH_SNAPSHOT_INTERVAL: Duration = Duration::from_millis(50);

/// Drained before the clock is started for `wait_for_fresh_snapshot`.
///
/// "Fresh" has to mean *requested* after the last write, but a snapshot only
/// carries the time it arrived. The gap is a poll that slipped out between two
/// writes — `has_pending` only gates polls from *starting*, and each
/// `send_control` briefly leaves nothing pending — and then landed after the
/// last write, carrying pre-push data with a post-push timestamp.
///
/// Waiting this out first closes it: any such poll has landed (and is
/// discarded with the old timestamp) well inside a tick, while every poll that
/// starts during the wait is already reading the finished amp, so accepting it
/// is correct. One tick is ~200 ms in `driver.rs`.
const WRITE_SETTLE_DELAY: Duration = Duration::from_millis(300);

/// Where a push got to. `pushed` is the only field that says the amp and the
/// project now agree — everything else is there to explain why they don't.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpPushResult {
    /// True only when every stage was written *and* the two fingerprints
    /// matched afterwards.
    pub pushed: bool,
    /// The saved project. Always `Some` on a result: the three device facts
    /// are re-read and saved even when no write was needed, so the caller can
    /// use it unconditionally. `Option` only so the shape matches
    /// `AmpMergeResult`, whose pull can legitimately save nothing.
    pub project: Option<Project>,
    /// The amp hash both sides now share; `Some` only when `pushed`.
    pub amp_hash: Option<String>,
    pub stages_completed: u32,
    pub stages_total: u32,
    pub packets_sent: u32,
    /// The stage that failed, by `PushStage.id`; `None` when every write
    /// landed.
    pub failed_stage_id: Option<String>,
    /// Human-readable "Out A · Speaker" for the failed stage.
    pub failed_stage_label: Option<String>,
    /// Why it failed — an ACK timeout, a full queue, a stopped driver.
    pub error: Option<String>,
    /// Settings still differing after the push. Empty when `pushed`.
    pub remaining: Vec<FingerprintRow>,
}

/// Progress for one stage, emitted as `amp_push:progress` at each stage
/// boundary so the modal's step list can advance without polling.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpPushProgress {
    pub assignment_id: String,
    pub stage_index: u32,
    pub stage_id: String,
    /// "running" | "done" | "failed"
    pub state: String,
    pub packets_done: u32,
    pub packets_total: u32,
}

/// Everything a push needs out of the two stores, cloned so neither lock is
/// held across an `.await`.
struct PushContext {
    device_id: String,
    mac: String,
    reading: LiveAmpReading,
    matrix_input_count: u32,
}

/// The merge command's guard sequence, in the same order and with the same
/// messages — see `amp_links.rs::projects_merge_amp_from_live`. Returns the
/// cloned inputs a plan is built from.
///
/// Both locks are taken and released here, never together and never held on
/// return, so the caller is free to await writes.
fn push_context(
    project_data: &State<'_, ProjectDataState>,
    live: &State<'_, LiveDeviceState>,
    project_id: &str,
    assignment_id: &str,
) -> Result<PushContext, AppError> {
    let mac = {
        let inner = project_data.0.lock().map_err(|e| e.to_string())?;
        let assignment = inner
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?
            .amp_assignments
            .iter()
            .find(|a| a.id == assignment_id)
            .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;
        assignment.mac.clone().ok_or_else(|| AppError::from("This amp isn't linked to a network amp".to_string()))?
    };

    let reading = read_linked_amp(live, &mac)?
        .filter(|r| r.device.online)
        .ok_or_else(|| AppError::from("The linked amp is offline".to_string()))?;
    if reading.snapshot.is_none() {
        return Err(AppError::from("The linked amp's settings haven't been read yet".to_string()));
    }

    let inner = project_data.0.lock().map_err(|e| e.to_string())?;
    let project = inner
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    let assignment = project
        .amp_assignments
        .iter()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;
    // The link can change while the live store is being read.
    if assignment.mac.as_deref().map(normalize_mac) != Some(normalize_mac(&mac)) {
        return Err(AppError::from("The amp's link changed — try again".to_string()));
    }
    let model = assignment
        .amp_model_id
        .as_deref()
        .and_then(|id| inner.amp_models.iter().find(|m| m.id == id))
        .ok_or_else(|| AppError::from("The project amp has no model assigned".to_string()))?;
    let matrix_input_count = model.topology.matrix_input_count;

    let snapshot = reading.snapshot.as_ref().expect("checked above");
    let live_fp = fingerprint_live_device(
        &reading.device,
        snapshot,
        reading.bridge.as_ref(),
        &inner.amp_models,
        &inner.device_model_links,
    );
    if let Some(reason) = live_fp.missing.first() {
        return Err(AppError::from(format!("The online amp can't be read completely: {reason}")));
    }
    // An EQ chain of a different length isn't a difference a push can write
    // away — it means the two sides disagree about the amp's topology.
    let eq_bands_differ = assignment.channels.iter().any(|channel| {
        snapshot.channels.iter().find(|c| c.channel_index == channel.channel_index).is_some_and(|config| {
            config.input_eq.bands.len() != channel.input_eq.bands.len()
                || config.output_eq.bands.len() != channel.output_eq.bands.len()
        })
    });
    if eq_bands_differ {
        return Err(AppError::from("The offline and online amp have different EQ band counts".to_string()));
    }
    let project_fp = fingerprint_project_amp(project, assignment, &inner.amp_models);
    if let Some(reason) = project_fp.missing.first() {
        return Err(AppError::from(format!("The offline amp can't be fingerprinted: {reason}")));
    }
    let (planned, online) = (&project_fp.identity, &live_fp.identity);
    if planned.model != online.model
        || planned.channel_count != online.channel_count
        || planned.firmware_family != online.firmware_family
    {
        return Err(AppError::from(
            "The offline and online amp differ in model, channel count or firmware — re-link the amp".to_string(),
        ));
    }

    Ok(PushContext { device_id: reading.device.id.clone(), mac, reading, matrix_input_count })
}

fn build_plan(
    context: &PushContext,
    project_data: &State<'_, ProjectDataState>,
    project_id: &str,
    assignment_id: &str,
) -> Result<PushPlan, AppError> {
    let inner = project_data.0.lock().map_err(|e| e.to_string())?;
    let assignment = inner
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?
        .amp_assignments
        .iter()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;
    let snapshot = context.reading.snapshot.as_ref().expect("guarded in push_context");
    let bridged = context.reading.bridge.as_ref().map(|b| b.bridged.clone()).unwrap_or_default();

    plan_push(assignment, snapshot, &context.reading.device.name, &bridged, context.matrix_input_count)
        .map_err(|e| AppError::from(e.0))
}

/// Read-only: what a push would write, stage by stage. Lets the modal render
/// the step list (and the adopted-fields note) before the user commits to it.
#[tauri::command]
#[specta::specta]
pub fn projects_plan_amp_push(
    project_data: State<'_, ProjectDataState>,
    live: State<'_, LiveDeviceState>,
    project_id: String,
    assignment_id: String,
) -> Result<AmpPushPlan, AppError> {
    let context = push_context(&project_data, &live, &project_id, &assignment_id)?;
    let plan = build_plan(&context, &project_data, &project_id, &assignment_id)?;
    Ok(plan.describe())
}

// ---------------------------------------------------------------------------
// Encoding — one planned action to its packet(s)
// ---------------------------------------------------------------------------

fn in_out_flag(direction: EqDirection) -> u8 {
    match direction {
        EqDirection::Input => 0,
        EqDirection::Output => 1,
    }
}

/// Lays a `ChannelEq` out into the ten positional slots FC=52 expects: slot 0
/// is the HP crossover, slots 1..=8 the parametric bands, slot 9 the LP — the
/// same numbering `channel_config_v118::parse_eq_block` reads back and that
/// the per-band `segment` field uses.
///
/// The HP/LP slots take their gain and Q from `wire`, echoing whatever the amp
/// reported: a `CrossoverSlot` has no such fields (its slope type implies Q),
/// so there is no project value to write and inventing one would change the
/// amp behind the user's back.
///
/// A band the project is missing keeps the amp's own values rather than a
/// fabricated default; the caller has already refused a push whose band counts
/// disagree, so this is a belt-and-braces fallback, not a normal path.
fn eq_chain_bands(eq: &ChannelEq, wire: &EqChainWire) -> [EqChainBand; EQ_CHAIN_BANDS] {
    std::array::from_fn(|slot| match slot {
        0 => EqChainBand {
            type_code: crossover_filter_type_code(eq.hp.filter_type),
            active: eq.hp.active,
            gain_db: wire.hp_gain_db,
            freq_hz: eq.hp.freq_hz as f32,
            q: wire.hp_q,
        },
        9 => EqChainBand {
            type_code: crossover_filter_type_code(eq.lp.filter_type),
            active: eq.lp.active,
            gain_db: wire.lp_gain_db,
            freq_hz: eq.lp.freq_hz as f32,
            q: wire.lp_q,
        },
        _ => match eq.bands.get(slot - 1) {
            Some(band) => EqChainBand {
                type_code: eq_filter_type_code(band.filter_type),
                active: band.active,
                gain_db: band.gain_db as f32,
                freq_hz: band.freq_hz as f32,
                q: band.q as f32,
            },
            None => EqChainBand { type_code: 0, active: false, gain_db: 0.0, freq_hz: 0.0, q: 0.0 },
        },
    })
}

/// Builds the packets for one action, in send order.
///
/// `None` means this firmware has no encoding for the action, which the caller
/// turns into the same "unrecognized/unknown firmware" error every write
/// command uses. Nothing here invents a fallback encoding.
fn action_packets(action: &PushAction, firmware: Option<&str>) -> Option<Vec<Vec<u8>>> {
    let packets = match action {
        PushAction::DeviceName { name } => vec![write::build_set_device_name(firmware, name)?],
        PushAction::Source { channel, kind, analog_index } => {
            let source_code = match kind {
                SourceKind::Analog => 0,
                SourceKind::Dante => 1,
                // Rejected at plan time — FC=11 cannot select backup.
                SourceKind::Backup => return None,
            };
            let mut out = vec![write::build_set_source_select(firmware, *channel, source_code)?];
            if let Some(index) = analog_index {
                out.push(write::build_set_analog_input(firmware, *channel, *index)?);
            }
            out
        }
        PushAction::InputMute { channel, muted } => vec![write::build_set_input_mute(firmware, *channel, *muted)?],
        PushAction::DelayIn { channel, delay_ms } => {
            vec![write::build_set_delay_in(firmware, *channel, *delay_ms as f32)?]
        }
        PushAction::SourceTrim { channel, family, trim_db, delay_ms } => {
            vec![write::build_set_source_trim(firmware, *channel, family.segment(), *trim_db as f32, *delay_ms as f32)?]
        }
        PushAction::EqChain { channel, direction, eq, wire } => {
            vec![write::build_set_eq_chain(firmware, *channel, in_out_flag(*direction), &eq_chain_bands(eq, wire), wire.chain_bypass)?]
        }
        PushAction::MatrixCrosspoint { channel, source_index, gain_db, active } => {
            vec![write::build_set_matrix_crosspoint(firmware, *channel, *source_index, *gain_db as f32, *active)?]
        }
        PushAction::OutputTrim { channel, trim_db } => {
            vec![write::build_set_output_trim(firmware, *channel, *trim_db as f32)?]
        }
        PushAction::OutputVolume { channel, volume_db } => {
            vec![write::build_set_output_volume(firmware, *channel, *volume_db as f32)?]
        }
        PushAction::OutputMute { channel, muted } => vec![write::build_set_output_mute(firmware, *channel, *muted)?],
        PushAction::DelayOut { channel, delay_ms } => {
            vec![write::build_set_delay_out(firmware, *channel, *delay_ms as f32)?]
        }
        PushAction::PhaseInvert { channel, inverted } => {
            vec![write::build_set_phase_invert(firmware, *channel, *inverted)?]
        }
        PushAction::PowerMode { channel, mode } => vec![write::build_set_power_mode(firmware, *channel, *mode)?],
        PushAction::FirBypass { channel, bypassed } => vec![write::build_set_fir_bypass(firmware, *channel, *bypassed)?],
        PushAction::NoiseGate { channel, enabled, threshold_dbu } => {
            vec![write::build_set_noise_gate(firmware, *channel, *enabled, *threshold_dbu)?]
        }
        PushAction::RmsLimiter { channel, enabled, threshold_vrms, attack_ms, release_multiplier } => {
            vec![write::build_set_rms_limiter(
                firmware,
                *channel,
                *enabled,
                *threshold_vrms as f32,
                *attack_ms as u16,
                *release_multiplier as u8,
            )?]
        }
        PushAction::RmsLimiterAuto { channel, auto } => {
            vec![write::build_set_rms_limiter_auto(firmware, *channel, *auto)?]
        }
        PushAction::PeakLimiter { channel, enabled, threshold_vp, hold_ms, release_ms } => {
            vec![write::build_set_peak_limiter(
                firmware,
                *channel,
                *enabled,
                *threshold_vp as f32,
                *hold_ms as u16,
                *release_ms as u16,
            )?]
        }
        PushAction::ChannelName { channel, direction, name } => {
            // The device field is fixed-width ASCII; a non-ASCII name would
            // be truncated mid-sequence, so it is refused rather than mangled.
            if !name.is_ascii() {
                return None;
            }
            vec![write::build_set_channel_name(firmware, *channel, in_out_flag(*direction), name)?]
        }
        PushAction::Bridge { pair_index, bridged } => {
            vec![write::build_set_output_bridge(firmware, *pair_index, *bridged)?]
        }
    };
    Some(packets)
}

// ---------------------------------------------------------------------------
// The push itself
// ---------------------------------------------------------------------------

/// Waits for an FC=27 snapshot that postdates `after`, so the push is verified
/// against what the amp actually holds rather than the pre-push cache.
async fn wait_for_fresh_snapshot(
    live: &State<'_, LiveDeviceState>,
    device_id: &str,
    after: f64,
) -> Result<ChannelConfigSnapshot, AppError> {
    let deadline = std::time::Instant::now() + FRESH_SNAPSHOT_TIMEOUT;
    loop {
        {
            let inner = live.0.lock().map_err(|e| e.to_string())?;
            if let Some(snapshot) = inner.channel_config.get(device_id) {
                if snapshot.received_at > after {
                    return Ok(snapshot.clone());
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(AppError::from(
                "The amp stopped reporting its settings, so the push couldn't be verified — it may still have been applied".to_string(),
            ));
        }
        tokio::time::sleep(FRESH_SNAPSHOT_INTERVAL).await;
    }
}

/// Makes the linked network amp adopt this project amp's settings (online ←
/// offline).
///
/// Not a transaction: the plan's stages are written in order and the first
/// failure stops the push, leaving the amp partly configured. That is reported
/// rather than papered over — the stage that failed comes back in the result,
/// and pushing again re-plans against the amp's new state, so a retry picks up
/// where this left off instead of redoing the work that landed.
///
/// Three hashed fields travel the other way instead of being written (load and
/// the two rated max voltages) — see `data/amp_push.rs`.
#[tauri::command]
#[specta::specta]
pub async fn projects_push_amp_to_live(
    app: AppHandle,
    project_data: State<'_, ProjectDataState>,
    live: State<'_, LiveDeviceState>,
    project_id: String,
    assignment_id: String,
) -> Result<AmpPushResult, AppError> {
    let context = push_context(&project_data, &live, &project_id, &assignment_id)?;
    let plan = build_plan(&context, &project_data, &project_id, &assignment_id)?;
    let stages_total = plan.stages.len() as u32;

    let (firmware_family, ip, write_tx) = resolve_write_target(&live, &context.device_id)?;
    let firmware = firmware_family.as_deref();

    // Encode everything before sending anything: an action this firmware has
    // no encoding for should fail with nothing on the wire, not halfway
    // through a channel.
    let mut encoded: Vec<Vec<Vec<u8>>> = Vec::with_capacity(plan.stages.len());
    for planned in &plan.stages {
        let mut stage_packets = Vec::new();
        for action in &planned.actions {
            let packets = action_packets(action, firmware).ok_or_else(|| unknown_firmware_error(&context.device_id))?;
            stage_packets.extend(packets);
        }
        encoded.push(stage_packets);
    }

    let mut tally = WriteTally::default();
    let mut stages_completed: u32 = 0;
    let mut failure: Option<(String, String, String)> = None;

    for (stage_index, (planned, packets)) in plan.stages.iter().zip(encoded.iter()).enumerate() {
        let stage = &planned.stage;
        let emit = |state: &str, done: u32| {
            app.emit(
                "amp_push:progress",
                AmpPushProgress {
                    assignment_id: assignment_id.clone(),
                    stage_index: stage_index as u32,
                    stage_id: stage.id.clone(),
                    state: state.to_string(),
                    packets_done: done,
                    packets_total: stage.packets,
                },
            )
            .ok();
        };
        emit("running", 0);

        let mut done: u32 = 0;
        for packet in packets {
            match write::send_control(&write_tx, ip, packet).await {
                Ok(outcome) => {
                    tally.record(outcome);
                    done += 1;
                    emit("running", done);
                }
                Err(error) => {
                    emit("failed", done);
                    let label = format!("{} · {}", stage.group, stage.label);
                    failure = Some((stage.id.clone(), label, error.to_string()));
                    break;
                }
            }
        }
        if failure.is_some() {
            break;
        }
        stages_completed += 1;
        emit("done", done);
    }

    let ack = tally.finish();
    let packets_sent = ack.packets;

    // Whether or not every write landed, the amp's state has moved and the
    // three device facts are read from it — so the project is reconciled and
    // saved either way. A push that failed halfway still leaves the plan
    // describing the hardware it is linked to.
    //
    // The clock for "fresh" starts *after* the settle delay, not before the
    // writes: a poll that slipped out mid-push could otherwise land afterwards
    // and pass off pre-push data as the verification. See
    // `WRITE_SETTLE_DELAY`.
    tokio::time::sleep(WRITE_SETTLE_DELAY).await;
    let settled_at = ampcore_core::data::common::now_millis();
    let fresh = wait_for_fresh_snapshot(&live, &context.device_id, settled_at).await;
    let bridge = {
        let inner = live.0.lock().map_err(|e| e.to_string())?;
        inner.bridge.get(&context.device_id).cloned()
    };

    let snapshot = match fresh {
        Ok(snapshot) => snapshot,
        // No fresh reading means the push can't be verified. Report that
        // rather than claiming success or silently adopting stale values.
        Err(error) if failure.is_none() => return Err(error),
        Err(_) => context.reading.snapshot.clone().expect("guarded in push_context"),
    };

    let mut inner = project_data.0.lock().map_err(|e| e.to_string())?;
    let models = inner.amp_models.clone();
    let links = inner.device_model_links.clone();
    let project = inner
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    let assignment = project
        .amp_assignments
        .iter_mut()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;
    // The link can have changed while the writes were in flight; the amp was
    // still written, so this is reported, not rolled back.
    if assignment.mac.as_deref().map(normalize_mac) != Some(normalize_mac(&context.mac)) {
        return Err(AppError::from("The amp's link changed while the push was running".to_string()));
    }
    adopt_device_facts(assignment, &snapshot);
    let assignment = assignment.clone();
    project.touch();
    let project = project.clone();
    save_project_file(&inner.data_dir, &project).map_err(AppError::from)?;
    drop(inner);
    app.emit("project:updated", &project).ok();

    let project_fp = fingerprint_project_amp(&project, &assignment, &models);
    let live_fp = fingerprint_live_device(&context.reading.device, &snapshot, bridge.as_ref(), &models, &links);
    let matched = project_fp.amp_hash.is_some() && project_fp.amp_hash == live_fp.amp_hash;
    let pushed = failure.is_none() && matched;
    let remaining = if matched { Vec::new() } else { compare_fingerprints(&project_fp, &live_fp) };
    let (failed_stage_id, failed_stage_label, error) = match failure {
        Some((id, label, error)) => (Some(id), Some(label), Some(error)),
        None => (None, None, None),
    };

    Ok(AmpPushResult {
        pushed,
        project: Some(project),
        amp_hash: pushed.then_some(live_fp.amp_hash).flatten(),
        stages_completed,
        stages_total,
        packets_sent,
        failed_stage_id,
        failed_stage_label,
        error,
        remaining,
    })
}
