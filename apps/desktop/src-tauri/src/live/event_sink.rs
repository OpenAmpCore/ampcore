//! The desktop-only half of `ampcore_core::live::state::LiveEventSink`:
//! turns a `LiveEvent` into an actual Tauri frontend event. `LiveEventSink`
//! itself (the mutate-then-decide-whether-to-emit logic) lives in
//! `ampcore-core`, Tauri-free, so it can be reused by a future mobile app
//! with its own `EventEmitter` impl.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use ampcore_core::live::state::{EventEmitter, LiveDeviceInner, LiveEvent, LiveEventSink};

pub struct TauriEmitter(pub AppHandle);

impl EventEmitter for TauriEmitter {
    fn emit(&self, event: LiveEvent) {
        match event {
            LiveEvent::Telemetry(payload) => {
                self.0.emit("live_telemetry:updated", &payload).ok();
            }
            LiveEvent::ChannelConfig(payload) => {
                self.0.emit("live_channel_config:updated", &payload).ok();
            }
            LiveEvent::Presets(payload) => {
                self.0.emit("live_presets:updated", &payload).ok();
            }
            LiveEvent::Bridge(payload) => {
                self.0.emit("live_bridge:updated", &payload).ok();
            }
            LiveEvent::Devices(snapshot) => {
                self.0.emit("live_device:updated", &snapshot).ok();
            }
        }
    }
}

pub fn make_event_sink(app: AppHandle, state: Arc<Mutex<LiveDeviceInner>>) -> LiveEventSink {
    LiveEventSink { emitter: Arc::new(TauriEmitter(app)), state }
}
