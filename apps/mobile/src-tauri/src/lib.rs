//! AmpCore Mobile — amp discovery on top of `ampcore-core`'s CVR driver, plus
//! two writes (standby, output mute) and the poll subscription they need.
//! Mirrors desktop's `live_control_*` commands (see
//! apps/desktop/src-tauri/src/commands/live_control.rs).

use tauri::{AppHandle, Emitter, Manager, State};

use ampcore_core::live::cvr::write;
use ampcore_core::live::driver::all_drivers;
use ampcore_core::live::state::{DiscoveredDevice, EventEmitter, LiveDeviceState, LiveEvent, LiveEventSink};
use ampcore_core::live::write_helpers::resolve_write_target;

/// Forwards the device list and per-device channel config (what the controls
/// panel reads); telemetry/presets/bridge are never consumed here.
struct MobileEmitter(AppHandle);

impl EventEmitter for MobileEmitter {
    fn emit(&self, event: LiveEvent) {
        match event {
            LiveEvent::Devices(devices) => self.0.emit("live_device:updated", &devices).ok(),
            LiveEvent::ChannelConfig(config) => self.0.emit("live_channel_config:updated", &config).ok(),
            _ => None,
        };
    }
}

#[tauri::command]
fn discovery_start(app: AppHandle, state: State<LiveDeviceState>) -> Result<(), String> {
    if !state.0.lock().map_err(|e| e.to_string())?.handles.is_empty() {
        return Ok(()); // idempotent — already running
    }
    // Lock is released before `start()`: the driver locks the same mutex
    // itself (to store its request/write channels) and it isn't reentrant.
    let sink = LiveEventSink { emitter: std::sync::Arc::new(MobileEmitter(app)), state: state.0.clone() };
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

/// Which devices get the heavy polls (FC=27 config), keyed by subscription
/// token; an empty list removes the token. Same as desktop's
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

/// Resolve the device, build one packet for its firmware, send it through the
/// driver's socket. The amp's new state comes back via the next FC=27 poll.
async fn send(
    state: &LiveDeviceState,
    device_id: &str,
    build: impl FnOnce(Option<&str>) -> Option<Vec<u8>>,
) -> Result<(), String> {
    let (firmware, ip, write_tx) = resolve_write_target(state, device_id).map_err(|e| e.message)?;
    let packet = build(firmware.as_deref()).ok_or("unrecognized firmware — cannot build write packet")?;
    write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn set_standby(state: State<'_, LiveDeviceState>, device_id: String, standby: bool) -> Result<(), String> {
    send(&state, &device_id, |fw| write::build_set_standby(fw, standby)).await
}

#[tauri::command]
async fn set_output_mute(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    muted: bool,
) -> Result<(), String> {
    send(&state, &device_id, |fw| write::build_set_output_mute(fw, channel_index, muted)).await
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
            set_output_mute
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
