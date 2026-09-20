//! AmpCore Mobile — amp discovery on top of `ampcore-core`'s CVR driver.
//! Mirrors desktop's `live_control_start/stop/list_devices` (see
//! apps/desktop/src-tauri/src/commands/live_control.rs), minus everything
//! past discovery: telemetry, writes and poll subscriptions stay unused.

use tauri::{AppHandle, Emitter, Manager, State};

use ampcore_core::live::driver::all_drivers;
use ampcore_core::live::state::{DiscoveredDevice, EventEmitter, LiveDeviceState, LiveEvent, LiveEventSink};

/// Forwards only the device list to the frontend; the other `LiveEvent`s
/// (telemetry, config, ...) never fire here because nothing subscribes to
/// the heavy polls.
struct MobileEmitter(AppHandle);

impl EventEmitter for MobileEmitter {
    fn emit(&self, event: LiveEvent) {
        if let LiveEvent::Devices(devices) = event {
            self.0.emit("live_device:updated", &devices).ok();
        }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(LiveDeviceState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![discovery_start, discovery_stop, discovery_list])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
