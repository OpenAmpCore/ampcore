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
use ampcore_core::data::common::log_clock;
use ampcore_core::data::amp_push::{action_packets, adopt_device_facts, plan_fir, plan_push, AmpPushPlan, PushAction, PushPlan};
use ampcore_core::data::edit_lock::LiveAmpReading;
use ampcore_core::data::fingerprint::{compare_fingerprints, fingerprint_live_device, fingerprint_project_amp, FingerprintRow};
use ampcore_core::data::project::{AmpAssignment, Project};
use crate::data::store::{save_project_file, ProjectDataState};
use ampcore_core::error::AppError;
use ampcore_core::live::cvr::channel_config::ChannelConfigSnapshot;
use ampcore_core::live::cvr::fir::ChannelFirSnapshot;
use ampcore_core::live::cvr::protocol::{parse_network_data_header, NETWORK_HEADER_LEN, STRUCT_HEADER_LEN};
use ampcore_core::live::cvr::write;
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
/// For `wait_for_fir`: the driver re-reads at most one output per 400 ms, so
/// a four-channel amp with every FIR rewritten needs about two seconds.
const FRESH_FIR_TIMEOUT: Duration = Duration::from_millis(8000);

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
///
/// 500 ms is also what the old app waited after writing a speaker before
/// reading it back ("the original takes ~420ms").
const WRITE_SETTLE_DELAY: Duration = Duration::from_millis(500);

/// How long a round waits, with polling held, before its first write: long
/// enough for the amp's replies and ACKs to polls already sent to arrive
/// (a heartbeat round trip is a few ms, a settings poll some tens).
const POLL_DRAIN_DELAY: Duration = Duration::from_millis(150);

/// How long the push waits after a FIR frame before its next packet. Measured
/// on a DSP-2004: the first packet sent right after one went unanswered, and
/// only its refire some 270 ms later got through. The old app waited 500 ms
/// after each speaker write for the same reason ("original takes ~420ms").
const FIR_COMMIT_DELAY: Duration = Duration::from_millis(500);

/// How long after the first FIR read-back the push reads the filters again.
/// Seen on a DSP-2004: a filter read back as written, and one to two seconds
/// later the amp held its previous filter, or a mix of both.
const FIR_SETTLE_DELAY: Duration = Duration::from_millis(2500);

/// Write → read back → write what is still missing, at most this many times.
/// The amp occasionally acknowledges a write and doesn't keep it; the old app
/// met the same thing and re-sent a speaker up to three times against a
/// read-back before calling it failed.
const PUSH_ROUNDS: u32 = 3;

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
    /// Stages planned so far, over every round — `stage_index` counts into it.
    pub stages_total: u32,
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
        &reading.fir,
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

/// `candidate` plans that assignment instead of the stored one — see
/// `push_assignment`.
fn build_plan(
    context: &PushContext,
    project_data: &State<'_, ProjectDataState>,
    project_id: &str,
    assignment_id: &str,
    candidate: Option<&AmpAssignment>,
) -> Result<PushPlan, AppError> {
    let inner = project_data.0.lock().map_err(|e| e.to_string())?;
    let stored = inner
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?
        .amp_assignments
        .iter()
        .find(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;
    let assignment = candidate.unwrap_or(stored);
    let snapshot = context.reading.snapshot.as_ref().expect("guarded in push_context");
    let bridged = context.reading.bridge.as_ref().map(|b| b.bridged.clone()).unwrap_or_default();

    let mut plan = plan_push(assignment, snapshot, &context.reading.device.name, &bridged, context.matrix_input_count)
        .map_err(|e| AppError::from(e.0))?;
    // FIR is planned against the driver's own readings (it isn't in the
    // snapshot), and goes ahead of bridging, which stays last.
    let at = plan.stages.iter().position(|s| s.stage.id == "bridge").unwrap_or(plan.stages.len());
    plan.stages.splice(at..at, plan_fir(assignment, &context.reading.fir));
    Ok(plan)
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
    let plan = build_plan(&context, &project_data, &project_id, &assignment_id, None)?;
    Ok(plan.describe())
}

/// One push packet for the console: its function code and channel (only the
/// first fragment carries them), which fragment it is, and its size.
fn describe_packet(packet: &[u8]) -> String {
    let Some(header) = parse_network_data_header(packet) else { return format!("{} bytes", packet.len()) };
    let frame = if header.packets_step <= 1 && packet.len() >= NETWORK_HEADER_LEN + STRUCT_HEADER_LEN {
        format!("FC={} ch {}, ", packet[NETWORK_HEADER_LEN + 1], packet[NETWORK_HEADER_LEN + 3])
    } else {
        String::new()
    };
    format!("{frame}fragment {}/{}, {} bytes", header.packets_step, header.packets_count, packet.len())
}

/// The FIR filters the driver holds for an amp, by output, for the console.
fn describe_firs(fir: &[ChannelFirSnapshot]) -> String {
    let mut fir: Vec<&ChannelFirSnapshot> = fir.iter().collect();
    fir.sort_by_key(|f| f.channel_index);
    fir.iter().map(|f| format!("ch {} {}", f.channel_index, f.describe())).collect::<Vec<_>>().join(" | ")
}

/// Waits until the driver has read back every output in `channels` — the
/// outputs a push just wrote a FIR filter to and then dropped from the cache
/// (`forget_fir`). The driver reads an unknown output first, one every
/// `FIR_PRIME_INTERVAL`, so this is well under a second per output.
async fn wait_for_fir(live: &State<'_, LiveDeviceState>, device_id: &str, channels: &[u32]) -> Result<(), AppError> {
    let deadline = std::time::Instant::now() + FRESH_FIR_TIMEOUT;
    loop {
        let read = live.fir_of(device_id)?;
        if channels.iter().all(|ch| read.iter().any(|f| f.channel_index == *ch)) {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(AppError::from(
                "The amp didn't report its FIR filters back, so the push couldn't be verified — it may still have been applied".to_string(),
            ));
        }
        tokio::time::sleep(FRESH_SNAPSHOT_INTERVAL).await;
    }
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
    push_assignment(&app, &project_data, &live, project_id, assignment_id, None).await
}

/// The push itself — the one way settings reach a linked amp from this side.
///
/// With `candidate`, that assignment is pushed instead of the stored one, and
/// it replaces the stored one **only if the two fingerprints match
/// afterwards**: the push's twin of the pull's candidate → verify → save
/// (`projects_merge_amp_from_live`). That is how a change (a speaker apply)
/// reaches the amp and the project as one step, without the project ever
/// claiming something the amp doesn't hold. A candidate that didn't land is
/// dropped; the project is left as it was.
pub(crate) async fn push_assignment(
    app: &AppHandle,
    project_data: &State<'_, ProjectDataState>,
    live: &State<'_, LiveDeviceState>,
    project_id: String,
    assignment_id: String,
    candidate: Option<AmpAssignment>,
) -> Result<AmpPushResult, AppError> {
    let mut context = push_context(project_data, live, &project_id, &assignment_id)?;
    let mut plan = build_plan(&context, project_data, &project_id, &assignment_id, candidate.as_ref())?;

    let (firmware_family, ip, write_tx) = resolve_write_target(live, &context.device_id)?;
    let firmware = firmware_family.as_deref();

    let mut tally = WriteTally::default();
    let mut stages_total: u32 = 0;
    let mut stages_completed: u32 = 0;
    let mut failure: Option<(String, String, String)> = None;

    // Write, read back, and write again whatever the amp still doesn't hold —
    // see `PUSH_ROUNDS`.
    let mut round = 1;
    let (snapshot, fir) = loop {
        // Encode everything before sending anything: an action this firmware
        // has no encoding for should fail with nothing on the wire, not
        // halfway through a channel.
        let mut encoded: Vec<Vec<Vec<u8>>> = Vec::with_capacity(plan.stages.len());
        for planned in &plan.stages {
            let mut stage_packets = Vec::new();
            for action in &planned.actions {
                let packets = action_packets(action, firmware).ok_or_else(|| unknown_firmware_error(&context.device_id))?;
                stage_packets.extend(packets);
            }
            encoded.push(stage_packets);
        }

        // Polling stays off for the whole round, not just while a packet is
        // in flight — see `LiveDeviceState::hold_polls`. The pause lets the
        // replies to polls already on the wire land before the first write,
        // so none of their ACKs can be taken for a write's.
        let hold = live.hold_polls()?;
        if !plan.stages.is_empty() {
            tokio::time::sleep(POLL_DRAIN_DELAY).await;
        }
        let first_stage = stages_total;
        stages_total += plan.stages.len() as u32;
        // Logged from this task, not the driver loop, so it can't delay an ACK.
        println!(
            "[push {}] {} ({ip}) round {round}/{PUSH_ROUNDS}: {} stages, {} packets",
            log_clock(),
            context.device_id,
            plan.stages.len(),
            encoded.iter().map(Vec::len).sum::<usize>()
        );

        for (stage_index, (planned, packets)) in plan.stages.iter().zip(encoded.iter()).enumerate() {
            let stage = &planned.stage;
            let emit = |state: &str, done: u32| {
                app.emit(
                    "amp_push:progress",
                    AmpPushProgress {
                        assignment_id: assignment_id.clone(),
                        stage_index: first_stage + stage_index as u32,
                        stages_total,
                        stage_id: stage.id.clone(),
                        state: state.to_string(),
                        packets_done: done,
                        packets_total: stage.packets,
                    },
                )
                .ok();
            };
            emit("running", 0);

            println!("[push]   {} · {} ({}): {} packets", stage.group, stage.label, stage.id, packets.len());
            let mut done: u32 = 0;
            for packet in packets {
                let what = format!("{}/{} {}", done + 1, packets.len(), describe_packet(packet));
                match write::send_control(&write_tx, ip, packet).await {
                    Ok(outcome) => {
                        // 0 attempts = coalesced into a newer write, never sent.
                        println!("[push]     {what}: ACK on attempt {} ({} ms)", outcome.attempts, outcome.elapsed_ms);
                        tally.record(outcome);
                        done += 1;
                        emit("running", done);
                    }
                    Err(error) => {
                        println!("[push]     {what}: FAILED — {error}");
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
            // The amp is deaf while it stores a FIR filter: the next packet
            // sent straight after one is dropped. See `FIR_COMMIT_DELAY`.
            if planned.actions.iter().any(|a| matches!(a, PushAction::FirData { .. })) {
                tokio::time::sleep(FIR_COMMIT_DELAY).await;
            }
        }

        // A written FIR is verified like everything else, by the fingerprints
        // — but those read FIR from the driver's cache, which still holds the
        // old filter. Dropping the written outputs makes the driver read them
        // back first; `wait_for_fir` below waits for that.
        let fir_written: Vec<u32> = plan
            .stages
            .iter()
            .flat_map(|s| &s.actions)
            .filter_map(|action| match action {
                PushAction::FirData { channel, .. } => Some(u32::from(*channel)),
                _ => None,
            })
            .collect();
        for channel in &fir_written {
            live.forget_fir(&context.device_id, *channel)?;
        }
        drop(hold);

        // Whether or not every write landed, the amp's state has moved and
        // the three device facts are read from it — so the project is
        // reconciled and saved either way. A push that failed halfway still
        // leaves the plan describing the hardware it is linked to.
        //
        // The clock for "fresh" starts *after* the settle delay, not before
        // the writes, so only a reading requested once the amp has digested
        // them counts. See `WRITE_SETTLE_DELAY`.
        tokio::time::sleep(WRITE_SETTLE_DELAY).await;
        let settled_at = ampcore_core::data::common::now_millis();
        let snapshot = match wait_for_fresh_snapshot(live, &context.device_id, settled_at).await {
            Ok(snapshot) => snapshot,
            // No fresh reading means the push can't be verified. Report that
            // rather than claiming success or silently adopting stale values.
            Err(error) if failure.is_none() => return Err(error),
            Err(_) => context.reading.snapshot.clone().expect("guarded in push_context"),
        };
        // Same rule for the FIR read-back: unverifiable is an error, unless
        // the push already failed and this is only reconciling.
        if let Err(error) = wait_for_fir(live, &context.device_id, &fir_written).await {
            if failure.is_none() {
                return Err(error);
            }
        }
        let mut fir = live.fir_of(&context.device_id)?;
        println!("[push {}] round {round} read back, FIR: {}", log_clock(), describe_firs(&fir));
        // The amp answers a read right after a FIR write with the new filter
        // and can still end up keeping the old one, or a mix. So the reading
        // that counts is a second one — see `FIR_SETTLE_DELAY`.
        if failure.is_none() && !fir_written.is_empty() {
            tokio::time::sleep(FIR_SETTLE_DELAY).await;
            for channel in &fir_written {
                live.forget_fir(&context.device_id, *channel)?;
            }
            wait_for_fir(live, &context.device_id, &fir_written).await?;
            fir = live.fir_of(&context.device_id)?;
            println!("[push {}] round {round} late read back, FIR: {}", log_clock(), describe_firs(&fir));
        }

        // An unacknowledged packet means the amp isn't answering; writing
        // more at it won't help. Otherwise plan again against what the amp
        // reports now: anything still planned is a write it acknowledged and
        // didn't keep.
        if failure.is_some() || round == PUSH_ROUNDS {
            break (snapshot, fir);
        }
        let again = push_context(project_data, live, &project_id, &assignment_id).and_then(|next| {
            let plan = build_plan(&next, project_data, &project_id, &assignment_id, candidate.as_ref())?;
            Ok((next, plan))
        });
        match again {
            Ok((next, next_plan)) if !next_plan.stages.is_empty() => {
                println!(
                    "[push] round {round}: acknowledged, but the amp still differs in: {}",
                    next_plan.stages.iter().map(|s| format!("{} · {}", s.stage.group, s.stage.label)).collect::<Vec<_>>().join(", ")
                );
                context = next;
                plan = next_plan;
                round += 1;
            }
            // Nothing left to write, or the amp can't be planned against any
            // more: the comparison below says how it ended.
            _ => break (snapshot, fir),
        }
    };
    let packets_sent = tally.finish().packets;
    let bridge = {
        let inner = live.0.lock().map_err(|e| e.to_string())?;
        inner.bridge.get(&context.device_id).cloned()
    };

    let mut inner = project_data.0.lock().map_err(|e| e.to_string())?;
    let models = inner.amp_models.clone();
    let links = inner.device_model_links.clone();
    let data_dir = inner.data_dir.clone();
    let project = inner
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| AppError::from(format!("project {} not found", project_id)))?;
    let slot = project
        .amp_assignments
        .iter()
        .position(|a| a.id == assignment_id)
        .ok_or_else(|| AppError::from(format!("assignment {} not found", assignment_id)))?;
    // The link can have changed while the writes were in flight; the amp was
    // still written, so this is reported, not rolled back.
    if project.amp_assignments[slot].mac.as_deref().map(normalize_mac) != Some(normalize_mac(&context.mac)) {
        return Err(AppError::from("The amp's link changed while the push was running".to_string()));
    }
    let is_candidate = candidate.is_some();
    let mut assignment = candidate.unwrap_or_else(|| project.amp_assignments[slot].clone());
    adopt_device_facts(&mut assignment, &snapshot);

    let project_fp = fingerprint_project_amp(project, &assignment, &models);
    let live_fp = fingerprint_live_device(&context.reading.device, &snapshot, bridge.as_ref(), &fir, &models, &links);
    let matched = project_fp.amp_hash.is_some() && project_fp.amp_hash == live_fp.amp_hash;
    let pushed = failure.is_none() && matched;
    let remaining = if matched { Vec::new() } else { compare_fingerprints(&project_fp, &live_fp) };
    match &failure {
        Some((_, label, error)) => println!("[push] stopped at {label}: {error}"),
        None if matched => println!("[push] done after {round} round(s): amp and project match"),
        None => {
            println!("[push] done after {round} round(s): still differing —");
            for row in remaining.iter().filter(|r| r.differs) {
                println!(
                    "[push]   {} · {}: project {} / amp {}",
                    row.group,
                    row.label,
                    row.project.as_deref().unwrap_or("—"),
                    row.live.as_deref().unwrap_or("—")
                );
            }
            for reason in project_fp.missing.iter().chain(&live_fp.missing) {
                println!("[push]   unreadable: {reason}");
            }
        }
    }

    // A stored assignment is saved either way (see above). A candidate only
    // once the amp is known to hold it.
    if !is_candidate || pushed {
        project.amp_assignments[slot] = assignment;
        project.touch();
        save_project_file(&data_dir, project).map_err(AppError::from)?;
    }
    let project = project.clone();
    drop(inner);
    app.emit("project:updated", &project).ok();

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
