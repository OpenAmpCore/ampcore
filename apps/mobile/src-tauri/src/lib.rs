//! AmpCore Mobile — thin Tauri commands over `ampcore-core`: discovery, live
//! polling, a few writes and presets. All device logic (packets, gates,
//! request sequencing) lives in core; nothing here builds wire bytes itself.
//! Mirrors desktop's `live_control_*` commands (see
//! apps/desktop/src-tauri/src/commands/live_control.rs).

use tauri::{AppHandle, Emitter, Manager, State};

use ampcore_core::live::cvr::{preset, write};
use ampcore_core::live::driver::all_drivers;
use ampcore_core::live::state::{DiscoveredDevice, EventEmitter, LiveDeviceState, LiveEvent, LiveEventSink};
use ampcore_core::live::write_helpers::{self, send_write};

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
    if !state.0.lock().map_err(|e| e.to_string())?.handles.is_empty() {
        return Ok(()); // idempotent — already running
    }
    // Lock is released before `start()`: the driver locks the same mutex
    // itself (to store its request/write channels) and it isn't reentrant.
    let sink = sink(app, &state);
    let runtime = tauri::async_runtime::handle().inner().clone();
    let handles: Vec<_> = all_drivers().into_iter().map(|driver| driver.start(sink.clone(), &runtime)).collect();
    state.0.lock().map_err(|e| e.to_string())?.handles.extend(handles);
    Ok(())
}

#[tauri::command]
fn discovery_stop(state: State<LiveDeviceState>) -> Result<(), String> {
    let handles = {
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        inner.request_tx = None;
        inner.write_tx = None;
        std::mem::take(&mut inner.handles)
    };
    handles.into_iter().for_each(|h| h.request_stop());
    Ok(())
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
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    if device_ids.is_empty() {
        inner.poll_subscriptions.remove(&token);
    } else {
        inner.poll_subscriptions.insert(token, device_ids.into_iter().collect());
    }
    Ok(())
}

// Writes: the amp's new state comes back via the next FC=27 poll.

#[tauri::command]
async fn set_standby(state: State<'_, LiveDeviceState>, device_id: String, standby: bool) -> Result<(), String> {
    send_write(&state, &device_id, |fw| write::build_set_standby(fw, standby)).await.map_err(|e| e.message)
}

#[tauri::command]
async fn set_output_mute(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    muted: bool,
) -> Result<(), String> {
    send_write(&state, &device_id, |fw| write::build_set_output_mute(fw, channel_index, muted)).await.map_err(|e| e.message)
}

#[tauri::command]
async fn set_input_mute(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    muted: bool,
) -> Result<(), String> {
    send_write(&state, &device_id, |fw| write::build_set_input_mute(fw, channel_index, muted)).await.map_err(|e| e.message)
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
async fn recall_preset(state: State<'_, LiveDeviceState>, device_id: String, slot_index: u8) -> Result<(), String> {
    send_write(&state, &device_id, |fw| write_helpers::presets_supported(fw).then(|| preset::build_recall_packet(slot_index)))
        .await
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
            amp_presets_supported,
            fetch_presets,
            recall_preset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
