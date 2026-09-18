use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::data::common::now_millis;

use super::cvr::bridge::DeviceBridgeSnapshot;
use super::cvr::channel_config::ChannelConfigSnapshot;
use super::cvr::channel_state::AmpChannelState;
use super::cvr::fir::ChannelFirSnapshot;
use super::cvr::preset::DevicePresetsSnapshot;
use super::cvr::request::{RequestSpec, WriteSpec};
use super::cvr::telemetry::Telemetry;
use super::driver::DriverHandle;

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDevice {
    /// "{driver_id}:{mac}", e.g. "cvr:AA:BB:CC:DD:EE:FF" — stable, brand-namespaced.
    pub id: String,
    pub driver_id: String,
    pub brand: String,
    pub name: String,
    pub mac: String,
    pub ip: String,
    pub firmware_version: String,
    /// Human-readable firmware family (e.g. "1.1.8"/"1.1.9" for CVR),
    /// `None` if unknown or not applicable to this brand's protocol.
    /// Brand-agnostic free text — driver-specific detection enums (like
    /// CVR's `CvrFirmwareFamily`) map into this rather than leaking here.
    pub firmware_family: Option<String>,
    pub gain_max: u32,
    pub analog_input_channels: u32,
    pub digital_input_channels: u32,
    pub output_channels: u32,
    /// Raw FC=0 BASIC_INFO `Machine_state` byte — the same vendor state enum
    /// the heartbeat's per-channel bytes use. Kept raw for wire debugging;
    /// `machine_state_decoded` is the form the UI reads.
    pub machine_state: u32,
    /// `machine_state` decoded. `None` for a firmware family with no state
    /// table (see `cvr::channel_state::decode`) — never a guessed meaning.
    pub machine_state_decoded: Option<AmpChannelState>,
    pub online: bool,
    pub last_seen_at: f64,
}

pub struct LiveDeviceInner {
    pub devices: HashMap<String, DiscoveredDevice>,
    pub handles: Vec<DriverHandle>,
    /// Latest parsed heartbeat telemetry per device id. Kept separate from
    /// `devices` (and emitted via its own event) rather than as a field on
    /// `DiscoveredDevice` — that struct's own upsert/touch/mark-offline paths
    /// all emit a full-list snapshot, and heartbeats land per-device every
    /// couple of seconds, so folding telemetry into it would re-broadcast
    /// every device's identity data on every single device's heartbeat.
    /// Deliberately never cleared on offline — the UI dims the last reading
    /// via `DiscoveredDevice.online` instead of blanking it.
    pub telemetry: HashMap<String, Telemetry>,
    /// Latest FC=27 channel-config snapshot per device id — same
    /// never-cleared-on-offline, separately-emitted pattern as `telemetry`.
    pub channel_config: HashMap<String, ChannelConfigSnapshot>,
    /// Latest FC=59 preset snapshot per device id — on-demand only (no
    /// background poll, see `commands/live_control.rs`'s
    /// `live_control_fetch_presets`), but stored/emitted the same way as
    /// `telemetry`/`channel_config` so every mounted view stays in sync.
    pub presets: HashMap<String, DevicePresetsSnapshot>,
    /// Latest FC=50 bridge state per device id. Polled by the driver on its
    /// own tick (see `bridge.rs` for why this is not read out of FC=27).
    pub bridge: HashMap<String, DeviceBridgeSnapshot>,
    /// Which devices receive the heavy polls (heartbeat, FC=27, FC=50), keyed
    /// by subscription token. Every discovered amp not in any set gets
    /// discovery alone. One token per live consumer — Live Control's current
    /// selection today, project mode once offline/online amp fusion exists —
    /// so consumers add to each other instead of overwriting one shared slot.
    /// Maintained by `live_control_set_poll_subscription`; read through
    /// `is_polled`.
    pub poll_subscriptions: HashMap<String, HashSet<String>>,
    /// Reaches into the running CVR driver's request engine from outside its
    /// task (e.g. a future Tauri command) — `None` whenever no driver is
    /// running. `Some` while `CvrDriver::start`'s spawned task is alive.
    pub request_tx: Option<mpsc::UnboundedSender<RequestSpec>>,
    /// Write counterpart to `request_tx` — routes control packets through the
    /// driver's single long-lived socket (bound to `PC_LISTEN_PORT`) so the
    /// device's ACK echo comes back to a socket that still exists and can be
    /// correlated. `None` whenever no driver is running.
    pub write_tx: Option<mpsc::UnboundedSender<WriteSpec>>,
}

impl LiveDeviceInner {
    /// Whether any live consumer currently wants the heavy polls for this
    /// device — the union across every `poll_subscriptions` entry, so a device
    /// two views both subscribe to is still polled exactly once.
    pub fn is_polled(&self, device_id: &str) -> bool {
        self.poll_subscriptions.values().any(|ids| ids.contains(device_id))
    }
}

/// Arc-wrapped (unlike `ProjectDataState`'s bare `Mutex<T>`) because a clone
/// of it has to be moved into a detached background task that outlives the
/// synchronous command invocation that spawned it.
pub struct LiveDeviceState(pub Arc<Mutex<LiveDeviceInner>>);

impl LiveDeviceState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(LiveDeviceInner {
            devices: HashMap::new(),
            handles: Vec::new(),
            telemetry: HashMap::new(),
            channel_config: HashMap::new(),
            presets: HashMap::new(),
            bridge: HashMap::new(),
            poll_subscriptions: HashMap::new(),
            request_tx: None,
            write_tx: None,
        })))
    }
}

impl Default for LiveDeviceState {
    fn default() -> Self {
        Self::new()
    }
}

/// What a live write reports back so the frontend can confirm delivery in the
/// UI, not just in the console. Aggregated across every packet one command
/// puts on the wire — an EQ band patch is up to 4, a crossover slot up to 3.
#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LiveWriteAck {
    /// Packets this command produced, coalesced ones included.
    pub packets: u32,
    /// Highest transmission count any one packet needed. 1 means everything
    /// was acknowledged on its first send; higher means refires were spent.
    pub attempts: u32,
    /// Summed ACK round-trip over the packets that actually went out.
    pub elapsed_ms: u32,
    /// Packets superseded by a newer write to the same parameter before they
    /// were ever transmitted (see `WriteOutcome::attempts == 0`). A command
    /// whose packets were *all* coalesced did nothing on the wire, and the
    /// UI should stay quiet about it — the write that replaced it reports.
    pub coalesced: u32,
}

/// Event/command payload pairing a device id with its latest telemetry —
/// the shape `live_telemetry:updated` emits and `live_control_get_telemetry`
/// returns a snapshot `Vec` of.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTelemetry {
    pub device_id: String,
    pub telemetry: Telemetry,
}

/// Event/command payload pairing a device id with its latest channel-config
/// snapshot — the shape `live_channel_config:updated` emits and
/// `live_control_get_channel_config` returns a snapshot `Vec` of.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceChannelConfig {
    pub device_id: String,
    pub config: ChannelConfigSnapshot,
}

/// Event/command payload pairing a device id with its latest FC=59 preset
/// snapshot — the shape `live_presets:updated` emits and
/// `live_control_get_presets` returns a snapshot `Vec` of.
/// Event/command payload pairing a device id with its latest FC=50 bridge
/// snapshot — the shape `live_bridge:updated` emits and
/// `live_control_get_bridge` returns a `Vec` of.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceBridge {
    pub device_id: String,
    pub bridge: DeviceBridgeSnapshot,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DevicePresets {
    pub device_id: String,
    pub presets: DevicePresetsSnapshot,
}

/// Command payload pairing a device id with one output channel's FC=43 FIR
/// snapshot — what `live_control_fetch_channel_fir` returns. Unlike its
/// siblings above there is no matching `LiveDeviceInner` field and no event:
/// FIR is fetched on demand per channel and never refreshed behind the
/// caller's back (see that command's doc comment).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceChannelFir {
    pub device_id: String,
    pub fir: ChannelFirSnapshot,
}

#[derive(Clone)]
pub struct LiveEventSink {
    pub app: AppHandle,
    pub state: Arc<Mutex<LiveDeviceInner>>,
}

impl LiveEventSink {
    /// Records one device's freshly parsed heartbeat telemetry and emits it
    /// alone — not the full device snapshot `upsert`/`touch_by_ip` emit.
    pub fn set_telemetry(&self, device_id: String, telemetry: Telemetry) {
        {
            let mut inner = self.state.lock().unwrap();
            inner.telemetry.insert(device_id.clone(), telemetry.clone());
        }
        self.app.emit("live_telemetry:updated", &DeviceTelemetry { device_id, telemetry }).ok();
    }

    /// Records one device's freshly parsed FC=27 channel config and emits it
    /// alone — same rationale as `set_telemetry`: a separate, targeted event
    /// rather than folding into the full device-list broadcast.
    pub fn set_channel_config(&self, device_id: String, config: ChannelConfigSnapshot) {
        {
            let mut inner = self.state.lock().unwrap();
            inner.channel_config.insert(device_id.clone(), config.clone());
        }
        self.app.emit("live_channel_config:updated", &DeviceChannelConfig { device_id, config }).ok();
    }

    /// Records one device's freshly fetched FC=59 preset snapshot and emits
    /// it — same never-cleared, separately-emitted pattern as
    /// `set_channel_config`, just triggered on-demand rather than by a
    /// background poll.
    pub fn set_presets(&self, device_id: String, presets: DevicePresetsSnapshot) {
        {
            let mut inner = self.state.lock().unwrap();
            inner.presets.insert(device_id.clone(), presets.clone());
        }
        self.app.emit("live_presets:updated", &DevicePresets { device_id, presets }).ok();
    }

    /// Merges one pair's FC=50 result into the device's snapshot, leaving
    /// the other pair's last-known value untouched — the driver polls the
    /// two pairs on separate ticks (the request registry keys by
    /// `(ip, function_code)`, so they cannot be in flight together), so a
    /// whole-snapshot replace would blank the pair that wasn't just asked.
    pub fn set_bridge_pair(&self, device_id: String, pair: u8, bridged: bool) {
        let snapshot = {
            let mut inner = self.state.lock().unwrap();
            let entry = inner.bridge.entry(device_id.clone()).or_insert_with(DeviceBridgeSnapshot::empty);
            if let Some(slot) = entry.bridged.get_mut(pair as usize) {
                *slot = Some(bridged);
            }
            entry.received_at = now_millis();
            entry.clone()
        };
        self.app.emit("live_bridge:updated", &DeviceBridge { device_id, bridge: snapshot }).ok();
    }

    /// Records a discovery reply. Emits **only when something actually
    /// changed**: every amp answers every discovery broadcast, so emitting
    /// unconditionally re-broadcast the whole device list to the frontend
    /// once per amp per cycle — and every consumer of `useLiveDevices`
    /// re-rendered for it. That was tolerable at a 4s cadence and is not at
    /// 1s (see `DISCOVERY_INTERVAL`); a steady amp's reply is identical each
    /// time, so the common case now emits nothing at all.
    pub fn upsert(&self, mut device: DiscoveredDevice) {
        device.online = true;
        device.last_seen_at = now_millis();
        let snapshot = {
            let mut inner = self.state.lock().unwrap();
            let previous = inner.devices.insert(device.id.clone(), device.clone());
            let changed = match previous {
                // `last_seen_at` ticks on every reply, so it is held equal for
                // this comparison — otherwise nothing would ever be
                // "unchanged". Liveness is carried by `online`, which is
                // compared.
                Some(previous) => DiscoveredDevice { last_seen_at: previous.last_seen_at, ..device } != previous,
                None => true,
            };
            if !changed {
                return;
            }
            inner.devices.values().cloned().collect::<Vec<_>>()
        };
        self.app.emit("live_device:updated", &snapshot).ok();
    }

    /// Refresh liveness for a device already known by ip (e.g. on a heartbeat
    /// reply, where we don't re-parse full identity).
    pub fn touch_by_ip(&self, ip: &str) {
        let snapshot = {
            let mut inner = self.state.lock().unwrap();
            let mut changed = false;
            for d in inner.devices.values_mut() {
                if d.ip == ip {
                    d.last_seen_at = now_millis();
                    if !d.online {
                        d.online = true;
                        changed = true;
                    }
                }
            }
            if !changed {
                return;
            }
            inner.devices.values().cloned().collect::<Vec<_>>()
        };
        self.app.emit("live_device:updated", &snapshot).ok();
    }

    pub fn mark_stale_offline(&self, timeout_ms: f64) {
        let now = now_millis();
        let snapshot = {
            let mut inner = self.state.lock().unwrap();
            let mut changed = false;
            for d in inner.devices.values_mut() {
                if d.online && now - d.last_seen_at > timeout_ms {
                    d.online = false;
                    changed = true;
                }
            }
            if !changed {
                return;
            }
            inner.devices.values().cloned().collect::<Vec<_>>()
        };
        self.app.emit("live_device:updated", &snapshot).ok();
    }
}
