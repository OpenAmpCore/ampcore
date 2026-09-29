//! AmpCore Mobile — thin Tauri commands over `ampcore-core`: discovery, live
//! polling, a few writes and presets. All device logic (packets, gates,
//! request sequencing) lives in core; nothing here builds wire bytes itself.
//! Mirrors desktop's `live_control_*` commands (see
//! apps/desktop/src-tauri/src/commands/live_control.rs).

use tauri::{AppHandle, Emitter, Manager, State};

use ampcore_core::data::capability::cvr::{cvr_param_ranges, AmpParamRanges};
use ampcore_core::data::capability::{eq_filter_capabilities, EqFilterCapabilityEntry};
use ampcore_core::data::project::{
    CrossoverSlotKind, CrossoverSlotPatch, EqBandPatch, EqDirection, LimiterPatch,
};
use ampcore_core::live::cvr::channel_config_v118::{crossover_filter_type_code, eq_filter_type_code};
use ampcore_core::live::cvr::write_v118::{CHANNEL_NAME_FIELD_LEN, DEVICE_NAME_FIELD_LEN};
use ampcore_core::live::cvr::{preset, write};
use ampcore_core::live::cvr::request::WriteOutcome;
use ampcore_core::live::state::{DiscoveredDevice, EventEmitter, LiveDeviceState, LiveEvent, LiveEventSink, LiveWriteAck};
use ampcore_core::live::write_helpers::{self, send_write, WriteTally};

/// Forwards everything the mobile screens read; bridge state is never consumed.
struct MobileEmitter(AppHandle);

impl EventEmitter for MobileEmitter {
    fn emit(&self, event: LiveEvent) {
        match event {
            LiveEvent::Devices(p) => self.0.emit("live_device:updated", &p),
            LiveEvent::ChannelConfig(p) => self.0.emit("live_channel_config:updated", &p),
            LiveEvent::Telemetry(p) => self.0.emit("live_telemetry:updated", &p),
            LiveEvent::Presets(p) => self.0.emit("live_presets:updated", &p),
            LiveEvent::Bridge(_) => Ok(()),
        }
        .ok();
    }
}

fn sink(app: AppHandle, state: &LiveDeviceState) -> LiveEventSink {
    LiveEventSink { emitter: std::sync::Arc::new(MobileEmitter(app)), state: state.0.clone() }
}

#[tauri::command]
fn discovery_start(app: AppHandle, state: State<LiveDeviceState>) -> Result<(), String> {
    state.start(sink(app, &state), tauri::async_runtime::handle().inner()).map_err(|e| e.message)
}

#[tauri::command]
fn discovery_stop(state: State<LiveDeviceState>) -> Result<(), String> {
    state.stop().map_err(|e| e.message)
}

#[tauri::command]
fn discovery_list(state: State<LiveDeviceState>) -> Result<Vec<DiscoveredDevice>, String> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.devices.values().cloned().collect())
}

/// Which devices get the heavy polls (FC=27 config + heartbeat), keyed by
/// subscription token; an empty list removes the token. Same as desktop's
/// `live_control_set_poll_subscription`.
#[tauri::command]
fn poll_subscribe(state: State<LiveDeviceState>, token: String, device_ids: Vec<String>) -> Result<(), String> {
    state.set_poll_subscription(token, device_ids).map_err(|e| e.message)
}

// Writes: the amp's new state comes back via the next FC=27 poll. Each command
// reports a `LiveWriteAck` so the UI can say the amp acknowledged the packets —
// delivery only, never that the parameter took the value (see core's
// `send_control`). Same shape for one-packet and multi-packet commands.

/// One packet's outcome as the `LiveWriteAck` shape every command returns.
fn ack(outcome: WriteOutcome) -> LiveWriteAck {
    let mut tally = WriteTally::default();
    tally.record(outcome);
    tally.finish()
}

#[tauri::command]
async fn set_standby(state: State<'_, LiveDeviceState>, device_id: String, standby: bool) -> Result<LiveWriteAck, String> {
    send_write(&state, &device_id, |fw| write::build_set_standby(fw, standby)).await.map(ack).map_err(|e| e.message)
}

#[tauri::command]
async fn set_output_mute(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    muted: bool,
) -> Result<LiveWriteAck, String> {
    send_write(&state, &device_id, |fw| write::build_set_output_mute(fw, channel_index, muted)).await.map(ack).map_err(|e| e.message)
}

#[tauri::command]
async fn set_input_mute(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    muted: bool,
) -> Result<LiveWriteAck, String> {
    send_write(&state, &device_id, |fw| write::build_set_input_mute(fw, channel_index, muted)).await.map(ack).map_err(|e| e.message)
}

#[tauri::command]
async fn set_output_volume(state: State<'_, LiveDeviceState>, device_id: String, channel_index: u8, db: f32) -> Result<LiveWriteAck, String> {
    send_write(&state, &device_id, |fw| write::build_set_output_volume(fw, channel_index, db)).await.map(ack).map_err(|e| e.message)
}

#[tauri::command]
async fn set_output_trim(state: State<'_, LiveDeviceState>, device_id: String, channel_index: u8, db: f32) -> Result<LiveWriteAck, String> {
    send_write(&state, &device_id, |fw| write::build_set_output_trim(fw, channel_index, db)).await.map(ack).map_err(|e| e.message)
}

#[tauri::command]
async fn set_output_delay(state: State<'_, LiveDeviceState>, device_id: String, channel_index: u8, ms: f32) -> Result<LiveWriteAck, String> {
    send_write(&state, &device_id, |fw| write::build_set_delay_out(fw, channel_index, ms)).await.map(ack).map_err(|e| e.message)
}

#[tauri::command]
async fn set_input_delay(state: State<'_, LiveDeviceState>, device_id: String, channel_index: u8, ms: f32) -> Result<LiveWriteAck, String> {
    send_write(&state, &device_id, |fw| write::build_set_delay_in(fw, channel_index, ms)).await.map(ack).map_err(|e| e.message)
}

#[tauri::command]
async fn set_output_polarity(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    inverted: bool,
) -> Result<LiveWriteAck, String> {
    send_write(&state, &device_id, |fw| write::build_set_phase_invert(fw, channel_index, inverted)).await.map(ack).map_err(|e| e.message)
}

#[tauri::command]
async fn set_rotary_lock(state: State<'_, LiveDeviceState>, device_id: String, locked: bool) -> Result<LiveWriteAck, String> {
    send_write(&state, &device_id, |fw| write::build_set_rotary_lock(fw, locked)).await.map(ack).map_err(|e| e.message)
}

/// `output` picks which side of the channel is renamed (wire `in_out_flag` 1 = output, 0 = input).
#[tauri::command]
async fn set_channel_name(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    output: bool,
    name: String,
) -> Result<LiveWriteAck, String> {
    let name = write_helpers::validate_name("channel name", &name, CHANNEL_NAME_FIELD_LEN).map_err(|e| e.message)?;
    send_write(&state, &device_id, |fw| write::build_set_channel_name(fw, channel_index, output as u8, name))
        .await
        .map(ack)
        .map_err(|e| e.message)
}

#[tauri::command]
async fn set_device_name(state: State<'_, LiveDeviceState>, device_id: String, name: String) -> Result<LiveWriteAck, String> {
    let name = write_helpers::validate_name("device name", &name, DEVICE_NAME_FIELD_LEN).map_err(|e| e.message)?;
    send_write(&state, &device_id, |fw| write::build_set_device_name(fw, name)).await.map(ack).map_err(|e| e.message)
}

// EQ. Both 10-band chains per channel; segment mapping lives in core's
// `write::eq_band_segment`/`crossover_segment`.
/// Partial update of one parametric band (index 0-7) — port of desktop's
/// `live_control_set_eq_band`. `filter_type`/`active` share one wire byte
/// (FC=30), so touching either merges in the other's current value from the
/// last FC=27 poll rather than writing a stale default over it. Freq/gain/Q
/// are independent FCs and each sends its own packet, so one call is up to 4
/// sends, tallied into the one `LiveWriteAck` the UI reports.
#[tauri::command]
async fn set_eq_band(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    direction: EqDirection,
    band_index: u8,
    patch: EqBandPatch,
) -> Result<LiveWriteAck, String> {
    let flag = write::in_out_flag(direction);
    let segment = write::eq_band_segment(band_index);
    let mut tally = WriteTally::default();

    if patch.filter_type.is_some() || patch.active.is_some() {
        let current = write_helpers::current_eq_band(&state, &device_id, channel_index, direction, band_index as usize)
            .map_err(|e| e.message)?
            .ok_or_else(|| format!("channel {channel_index} has no EQ data yet — try again shortly"))?;
        let type_code = eq_filter_type_code(patch.filter_type.unwrap_or(current.filter_type));
        let active = patch.active.unwrap_or(current.active);
        send_write(&state, &device_id, |fw| write::build_set_eq_filter_type(fw, channel_index, flag, segment, type_code, active))
            .await
            .map(|o| tally.record(o))
            .map_err(|e| e.message)?;
    }
    if let Some(freq_hz) = patch.freq_hz {
        send_write(&state, &device_id, |fw| write::build_set_eq_freq(fw, channel_index, flag, segment, freq_hz as f32))
            .await
            .map(|o| tally.record(o))
            .map_err(|e| e.message)?;
    }
    if let Some(gain_db) = patch.gain_db {
        send_write(&state, &device_id, |fw| write::build_set_eq_gain(fw, channel_index, flag, segment, gain_db as f32))
            .await
            .map(|o| tally.record(o))
            .map_err(|e| e.message)?;
    }
    if let Some(q) = patch.q {
        send_write(&state, &device_id, |fw| write::build_set_eq_q(fw, channel_index, flag, segment, q as f32))
            .await
            .map(|o| tally.record(o))
            .map_err(|e| e.message)?;
    }
    Ok(tally.finish())
}

/// Partial update of the HP or LP crossover slot — same merge rule as
/// `set_eq_band`, plus the device-required follow-up: a FILTER_TYPE/FREQ
/// write to a crossover slot only takes effect once `CROSSOVER_COMMIT_PACKET`
/// is sent after it. Sent once per call, not once per field.
///
/// ponytail: that commit packet goes out with `expect_ack: false`, so core
/// resolves it `Ok` before the socket send is even attempted and discards the
/// send error — it counts in the reported `packets` but was never actually
/// acknowledged, so a crossover ack overstates by one. Send it un-tallied if
/// that ever matters.
#[tauri::command]
async fn set_crossover_slot(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    direction: EqDirection,
    slot: CrossoverSlotKind,
    patch: CrossoverSlotPatch,
) -> Result<LiveWriteAck, String> {
    let flag = write::in_out_flag(direction);
    let segment = write::crossover_segment(slot);
    let mut tally = WriteTally::default();
    let mut wrote_anything = false;

    if patch.filter_type.is_some() || patch.active.is_some() {
        let current = write_helpers::current_crossover_slot(&state, &device_id, channel_index, direction, slot)
            .map_err(|e| e.message)?
            .ok_or_else(|| format!("channel {channel_index} has no EQ data yet — try again shortly"))?;
        let type_code = crossover_filter_type_code(patch.filter_type.unwrap_or(current.filter_type));
        let active = patch.active.unwrap_or(current.active);
        send_write(&state, &device_id, |fw| write::build_set_eq_filter_type(fw, channel_index, flag, segment, type_code, active))
            .await
            .map(|o| tally.record(o))
            .map_err(|e| e.message)?;
        wrote_anything = true;
    }
    if let Some(freq_hz) = patch.freq_hz {
        send_write(&state, &device_id, |fw| write::build_set_eq_freq(fw, channel_index, flag, segment, freq_hz as f32))
            .await
            .map(|o| tally.record(o))
            .map_err(|e| e.message)?;
        wrote_anything = true;
    }
    if wrote_anything {
        send_write(&state, &device_id, |_| Some(write::CROSSOVER_COMMIT_PACKET.to_vec()))
            .await
            .map(|o| tally.record(o))
            .map_err(|e| e.message)?;
    }
    Ok(tally.finish())
}

// Matrix + limiter. Both are whole-record wire packets: a crosspoint carries
// gain *and* active, each limiter stage carries all four of its parameters.
// The commands take partial patches, so the untouched fields are merged from
// the last FC=27 snapshot — writing defaults instead would silently zero a
// configured threshold. Ported from desktop's
// `live_control_set_matrix_crosspoint` / `live_control_set_channel_limiter`.

/// FC=55 RMS_LIMITER / FC=54 PEAK_LIMITER. One packet per stage the patch
/// actually touches — an RMS-only patch leaves the peak stage alone instead
/// of rewriting it. Both are tallied into the single `LiveWriteAck` the UI
/// reports.
#[tauri::command]
async fn set_limiter(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    patch: LimiterPatch,
) -> Result<LiveWriteAck, String> {
    let channel = write_helpers::current_channel(&state, &device_id, channel_index).map_err(|e| e.message)?;
    let mut tally = WriteTally::default();

    if let Some((enabled, threshold_vrms, attack_ms, release_multiplier)) = write_helpers::merge_rms(&patch, &channel.limiter.rms) {
        send_write(&state, &device_id, |fw| {
            write::build_set_rms_limiter(fw, channel_index, enabled, threshold_vrms, attack_ms, release_multiplier)
        })
        .await
        .map(|o| tally.record(o))
        .map_err(|e| e.message)?;
    }
    if let Some((enabled, threshold_vp, hold_ms, release_ms)) = write_helpers::merge_peak(&patch, &channel.limiter.peak) {
        send_write(&state, &device_id, |fw| write::build_set_peak_limiter(fw, channel_index, enabled, threshold_vp, hold_ms, release_ms))
            .await
            .map(|o| tally.record(o))
            .map_err(|e| e.message)?;
    }

    Ok(tally.finish())
}

/// FC=12 ROUTING. `gain_db`/`active` are both optional; whichever is omitted
/// is filled from the crosspoint's current state.
#[tauri::command]
async fn set_matrix_crosspoint(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    source_index: u8,
    gain_db: Option<f64>,
    active: Option<bool>,
) -> Result<LiveWriteAck, String> {
    let channel = write_helpers::current_channel(&state, &device_id, channel_index).map_err(|e| e.message)?;
    let existing = channel
        .matrix_crosspoints
        .iter()
        .find(|c| c.source_index == u32::from(source_index))
        .ok_or_else(|| format!("channel {channel_index} has no matrix source {source_index}"))?;
    let gain_db = gain_db.unwrap_or(existing.gain_db) as f32;
    let active = active.unwrap_or(existing.active);

    send_write(&state, &device_id, |fw| write::build_set_matrix_crosspoint(fw, channel_index, source_index, gain_db, active))
        .await
        .map(ack)
        .map_err(|e| e.message)
}

/// Slider bounds come from core, not the UI (`AmpParamRanges`, camelCase).
#[tauri::command]
fn amp_ranges() -> AmpParamRanges {
    cvr_param_ranges()
}

/// Which filter types expose gain/Q — read from core so the EQ sheet greys
/// the right fields instead of hardcoding a copy of the table in TS.
#[tauri::command]
fn amp_eq_filter_capabilities() -> Vec<EqFilterCapabilityEntry> {
    eq_filter_capabilities()
}

// Presets (FC=59, firmware 1.1.8 only — the gate is core's `presets_supported`).

#[tauri::command]
fn amp_presets_supported(state: State<LiveDeviceState>, device_id: String) -> Result<bool, String> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.devices.get(&device_id).is_some_and(|d| write_helpers::presets_supported(d.firmware_family.as_deref())))
}

#[tauri::command]
async fn fetch_presets(
    app: AppHandle,
    state: State<'_, LiveDeviceState>,
    device_id: String,
) -> Result<preset::DevicePresetsSnapshot, String> {
    write_helpers::fetch_presets(&sink(app, &state), &device_id).await.map_err(|e| e.message)
}

#[tauri::command]
async fn recall_preset(state: State<'_, LiveDeviceState>, device_id: String, slot_index: u8) -> Result<LiveWriteAck, String> {
    send_write(&state, &device_id, |fw| write_helpers::presets_supported(fw).then(|| preset::build_recall_packet(slot_index)))
        .await
        .map(ack)
        .map_err(|e| e.message)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(LiveDeviceState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            discovery_start,
            discovery_stop,
            discovery_list,
            poll_subscribe,
            set_standby,
            set_output_mute,
            set_input_mute,
            set_output_volume,
            set_output_trim,
            set_output_delay,
            set_input_delay,
            set_output_polarity,
            set_eq_band,
            set_crossover_slot,
            set_limiter,
            set_matrix_crosspoint,
            amp_eq_filter_capabilities,
            set_rotary_lock,
            set_channel_name,
            set_device_name,
            amp_ranges,
            amp_presets_supported,
            fetch_presets,
            recall_preset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
