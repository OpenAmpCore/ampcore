use std::net::Ipv4Addr;

use tauri::{AppHandle, State};
use tokio::sync::mpsc;

use crate::data::capability::{PowerMode, SourceKind};
use crate::data::common::now_millis;
use crate::data::project::{CrossoverSlot, CrossoverSlotKind, CrossoverSlotPatch, EqBand, EqBandPatch, EqDirection, LimiterPatch};
use crate::error::AppError;
use crate::live::cvr::channel_config::ChannelConfig;
use crate::live::cvr::channel_config_v118::{crossover_filter_type_code, eq_filter_type_code};
use crate::live::cvr::write_v118::{CHANNEL_NAME_FIELD_LEN, DEVICE_NAME_FIELD_LEN};
use crate::live::cvr::fir;
use crate::live::cvr::preset;
use crate::live::cvr::request::{WriteOutcome, WriteSpec};
use crate::live::cvr::write;
use crate::live::driver::all_drivers;
use crate::live::state::{
    DeviceBridge, DeviceChannelConfig, DeviceChannelFir, DevicePresets, DeviceTelemetry, DiscoveredDevice, LiveDeviceState,
    LiveEventSink, LiveWriteAck,
};

/// Shared lookup for every write command below: resolves `device_id` to its
/// current `firmware_family`, parsed IP, and the running driver's write
/// channel in one pass, so each command body is just "build a packet or
/// error, then send it". The channel is resolved here rather than at each
/// send so a command against a stopped driver fails before building anything.
pub(crate) fn resolve_write_target(
    state: &State<'_, LiveDeviceState>,
    device_id: &str,
) -> Result<(Option<String>, Ipv4Addr, mpsc::UnboundedSender<WriteSpec>), AppError> {
    let (device, write_tx) = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        let device = inner
            .devices
            .get(device_id)
            .cloned()
            .ok_or_else(|| AppError::from(format!("device {} not found", device_id)))?;
        let write_tx = inner.write_tx.clone().ok_or_else(|| AppError::from("live control is not running"))?;
        (device, write_tx)
    };
    let ip: Ipv4Addr = device
        .ip
        .parse()
        .map_err(|_| AppError::from(format!("device {} has an unparseable ip {}", device_id, device.ip)))?;
    Ok((device.firmware_family, ip, write_tx))
}

/// Accumulates the per-packet `WriteOutcome`s of one command into the single
/// `LiveWriteAck` it returns. Every write command uses this, including the
/// single-packet ones, so the shape the frontend receives never depends on
/// how many packets a given parameter happens to require.
#[derive(Default)]
pub(crate) struct WriteTally {
    packets: u32,
    attempts: u32,
    elapsed_ms: u32,
    coalesced: u32,
}

impl WriteTally {
    pub(crate) fn record(&mut self, outcome: WriteOutcome) {
        self.packets += 1;
        if outcome.attempts == 0 {
            // Coalesced: never transmitted, so it contributes no latency and
            // must not drag the reported attempt count down to 0.
            self.coalesced += 1;
        } else {
            self.attempts = self.attempts.max(outcome.attempts as u32);
            self.elapsed_ms += outcome.elapsed_ms as u32;
        }
    }

    pub(crate) fn finish(self) -> LiveWriteAck {
        LiveWriteAck {
            packets: self.packets,
            attempts: self.attempts,
            elapsed_ms: self.elapsed_ms,
            coalesced: self.coalesced,
        }
    }
}

pub(crate) fn unknown_firmware_error(device_id: &str) -> AppError {
    AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id))
}

/// FC=59 preset fetch/recall has no confirmed 1.1.9 spec in either reference
/// source (see `live/cvr/preset.rs`'s module doc) — gate the feature to 1.1.8
/// only rather than guessing it also works there, matching this app's
/// "no generic fallback encoding" write philosophy.
fn require_v118_firmware(device_id: &str, firmware_family: Option<&str>) -> Result<(), AppError> {
    if firmware_family != Some("1.1.8") {
        return Err(AppError::from(format!(
            "device {} preset fetch/recall requires firmware 1.1.8 (detected: {:?})",
            device_id, firmware_family
        )));
    }
    Ok(())
}

/// FC=43 FIR_datas is confirmed against 1.1.8, and 1.1.9 is accepted on the
/// same basis `write.rs` already accepts it for FC=44 FIR bypass: the two
/// firmwares share the v118 encoder for every FIR command, and
/// `capability::cvr` gates the whole feature on vNum >= 118 (`fir_filters`).
/// Anything older — or an unrecognized firmware — is refused rather than
/// guessed at, matching this app's no-fallback-encoding rule.
fn require_fir_firmware(device_id: &str, firmware_family: Option<&str>) -> Result<(), AppError> {
    if !matches!(firmware_family, Some("1.1.8") | Some("1.1.9")) {
        return Err(AppError::from(format!(
            "device {} FIR data requires firmware 1.1.8 or 1.1.9 (detected: {:?})",
            device_id, firmware_family
        )));
    }
    Ok(())
}

/// FC=30 FILTER_TYPE's wire body encodes `filter_type` and `active`
/// (bypass) together in one byte — writing one field without knowing the
/// other's current value would silently clobber it. Reads the most recent
/// FC=27 poll result already cached in `LiveDeviceState` (refreshed every
/// ~200ms, see `driver.rs`) rather than querying the device directly.
/// `None` when nothing has been polled for this device/channel yet — the
/// caller must treat that as an honest "can't merge yet" error, not guess.
fn current_eq_band(
    state: &State<'_, LiveDeviceState>,
    device_id: &str,
    channel_index: u8,
    direction: EqDirection,
    band_index: usize,
) -> Result<Option<EqBand>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.channel_config.get(device_id).and_then(|snapshot| {
        snapshot.channels.iter().find(|c| c.channel_index == channel_index as u32).and_then(|c| {
            let eq = match direction {
                EqDirection::Input => &c.input_eq,
                EqDirection::Output => &c.output_eq,
            };
            eq.bands.get(band_index).copied()
        })
    }))
}

/// Same merge problem as `current_eq_band`, for a crossover (HP/LP) slot.
fn current_crossover_slot(
    state: &State<'_, LiveDeviceState>,
    device_id: &str,
    channel_index: u8,
    direction: EqDirection,
    slot: CrossoverSlotKind,
) -> Result<Option<CrossoverSlot>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.channel_config.get(device_id).and_then(|snapshot| {
        snapshot.channels.iter().find(|c| c.channel_index == channel_index as u32).map(|c| {
            let eq = match direction {
                EqDirection::Input => &c.input_eq,
                EqDirection::Output => &c.output_eq,
            };
            match slot {
                CrossoverSlotKind::Hp => eq.hp,
                CrossoverSlotKind::Lp => eq.lp,
            }
        })
    }))
}

#[tauri::command]
#[specta::specta]
pub fn live_control_start(app: AppHandle, state: State<LiveDeviceState>) -> Result<(), AppError> {
    {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        if !inner.handles.is_empty() {
            return Ok(()); // idempotent — already running
        }
    }
    // Lock must be released before calling `start()` — `CvrDriver::start`
    // locks this same `Arc<Mutex<LiveDeviceInner>>` itself (to store
    // `request_tx`), and `std::sync::Mutex` isn't reentrant: holding it
    // across the call deadlocks the very first `live_control_start`
    // invocation, which fires when the first live-aware view mounts (see
    // `useLiveDriver`).
    let sink = LiveEventSink {
        app,
        state: state.0.clone(),
    };
    let handles: Vec<_> = all_drivers().into_iter().map(|driver| driver.start(sink.clone())).collect();
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    inner.handles.extend(handles);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn live_control_stop(state: State<LiveDeviceState>) -> Result<(), AppError> {
    let handles = {
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        inner.request_tx = None;
        inner.write_tx = None;
        std::mem::take(&mut inner.handles)
    };
    for h in handles {
        h.request_stop();
    }
    Ok(())
}

/// Declares which devices one live consumer needs the heavy polls (heartbeat,
/// FC=27, FC=50) for. Devices no consumer has asked for get discovery alone.
///
/// `token` identifies one subscription, and `device_ids` replaces that
/// token's whole set; an empty list removes the token. The driver polls the
/// union of every token's set, so any number of views can subscribe at once
/// — Live Control today, project mode once offline/online amp fusion lands —
/// without overwriting each other, and two views on the same amp never
/// double-poll it. The frontend mints a fresh token per effect run (see
/// `useLivePolling`), which keeps this correct even when a subscribe and a
/// clear arrive out of order.
///
/// Pure state, no wire I/O: the ticks read it on their next pass, so a newly
/// subscribed device gets its first heartbeat within ~50ms and its first
/// FC=27 within ~200ms. On-demand commands (preset fetch, refresh, writes and
/// the post-bridge-write refetch) do not depend on it.
#[tauri::command]
#[specta::specta]
pub fn live_control_set_poll_subscription(
    state: State<LiveDeviceState>,
    token: String,
    device_ids: Vec<String>,
) -> Result<(), AppError> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    if device_ids.is_empty() {
        inner.poll_subscriptions.remove(&token);
    } else {
        inner.poll_subscriptions.insert(token, device_ids.into_iter().collect());
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn live_control_list_devices(state: State<LiveDeviceState>) -> Result<Vec<DiscoveredDevice>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.devices.values().cloned().collect())
}

#[tauri::command]
#[specta::specta]
pub fn live_control_get_telemetry(state: State<LiveDeviceState>) -> Result<Vec<DeviceTelemetry>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner
        .telemetry
        .iter()
        .map(|(device_id, telemetry)| DeviceTelemetry { device_id: device_id.clone(), telemetry: telemetry.clone() })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn live_control_get_channel_config(state: State<LiveDeviceState>) -> Result<Vec<DeviceChannelConfig>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner
        .channel_config
        .iter()
        .map(|(device_id, config)| DeviceChannelConfig { device_id: device_id.clone(), config: config.clone() })
        .collect())
}

/// On-demand counterpart to the background ~200ms FC=27 poll (see
/// `driver.rs`'s `config_poll_tick`): sends one SYNC_DATA request through the
/// driver's request registry with an `External` sink and awaits its result
/// directly, instead of waiting for the next passive poll tick to pick it up.
/// Still updates `LiveDeviceState.channel_config` and emits
/// `live_channel_config:updated` exactly like the background poll does (via
/// the shared `parse_and_store_sync_data`), so callers that only listen for
/// the event rather than this command's return value stay in sync too.
#[tauri::command]
#[specta::specta]
pub async fn live_control_refresh_now(app: AppHandle, state: State<'_, LiveDeviceState>, device_id: String) -> Result<DeviceChannelConfig, AppError> {
    let (ip, request_tx) = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        let device = inner.devices.get(&device_id).cloned().ok_or_else(|| AppError::from(format!("device {} not found", device_id)))?;
        let request_tx = inner.request_tx.clone().ok_or_else(|| AppError::from("live control is not running"))?;
        (device.ip, request_tx)
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    let spec = crate::live::cvr::request::RequestSpec {
        ip: ip.clone(),
        function_code: crate::live::cvr::protocol::FC_SYNC_DATA,
        chx: 0,
        body: Vec::new(),
        // FC=27 is always fragmented.
        expects_fragments: true,
        in_out_flag: 0,
        sink: crate::live::cvr::request::ResultSink::External(tx),
    };
    request_tx.send(spec).map_err(|_| AppError::from("live control driver is not running"))?;
    let frame = rx
        .await
        .map_err(|_| AppError::from("live control driver dropped the request"))?
        .map_err(|e| AppError::from(format!("{:?}", e)))?;

    let sink = LiveEventSink { app, state: state.0.clone() };
    let config = crate::live::cvr::driver::parse_and_store_sync_data(&ip, &frame, &sink).map_err(AppError::from)?;
    Ok(DeviceChannelConfig { device_id, config })
}

/// The device's preset name field is a fixed 32-byte ASCII buffer (see
/// `preset.rs`'s `PRESET_NAME_LEN`); anything longer is silently truncated
/// on the wire, so reject it up front instead.
const PRESET_NAME_MAX_LEN: usize = 32;
/// Retry budget for `RequestError::Busy` — the FC=27 poll tick fires every
/// `CONFIG_POLL_INTERVAL` (200ms) and a single exchange typically resolves
/// in well under that, so 10 retries at 30ms apart (up to ~300ms worst case)
/// comfortably outlasts one poll cycle without adding noticeable latency to
/// the common case (which succeeds on the first attempt). Shared by every
/// `send_request_with_retry` caller, which is why it is no longer named
/// after presets.
const REQUEST_BUSY_MAX_RETRIES: u32 = 10;
const REQUEST_BUSY_RETRY_DELAY_MS: u64 = 30;

/// Sends one request through the driver's request registry with an
/// `External` sink and awaits its resolved frame — the one place every
/// on-demand read goes through (presets, bridge). Not reusable across an
/// `.await` point with a second call in flight for the same device and
/// function code: `RequestRegistry` keys pending requests by `(ip,
/// function_code)` only, so a second request under the same code sent before
/// the first resolves would supersede/fail it (see
/// `live/cvr/request.rs`'s `RequestRegistry::register`) — callers must fully
/// await one call before making the next.
///
/// Transparently retries `RequestError::Busy` (the driver rejects a new
/// request outright when it would clash with an exchange already in flight
/// for this ip — see `RequestRegistry::conflicts_with`). Without this retry,
/// a fetch racing the poll tick (most likely right after mount, when several
/// things fire close together) would surface a raw "Busy" error instead of
/// just quietly succeeding a moment later.
///
/// `expects_fragments` and `in_out_flag` are passed straight through to the
/// spec — see their docs for why a single-datagram read must declare itself as
/// one, and why an output-side query has to say so.
async fn send_request_with_retry(
    request_tx: &tokio::sync::mpsc::UnboundedSender<crate::live::cvr::request::RequestSpec>,
    ip: &str,
    function_code: u8,
    chx: u8,
    body: Vec<u8>,
    expects_fragments: bool,
    in_out_flag: u8,
) -> Result<Vec<u8>, AppError> {
    let mut last_err = AppError::from(format!("device {} request never attempted", ip));
    for attempt in 0..=REQUEST_BUSY_MAX_RETRIES {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let spec = crate::live::cvr::request::RequestSpec {
            ip: ip.to_string(),
            function_code,
            chx,
            body: body.clone(),
            expects_fragments,
            in_out_flag,
            sink: crate::live::cvr::request::ResultSink::External(tx),
        };
        request_tx.send(spec).map_err(|_| AppError::from("live control driver is not running"))?;
        match rx.await.map_err(|_| AppError::from("live control driver dropped the request"))? {
            Ok(frame) => return Ok(frame),
            Err(crate::live::cvr::request::RequestError::Busy) => {
                last_err = AppError::from(format!("device {} still busy after {} attempt(s)", ip, attempt + 1));
                if attempt < REQUEST_BUSY_MAX_RETRIES {
                    tokio::time::sleep(std::time::Duration::from_millis(REQUEST_BUSY_RETRY_DELAY_MS)).await;
                }
            }
            Err(e) => return Err(AppError::from(format!("{:?}", e))),
        }
    }
    Err(last_err)
}

/// Fetches the full preset slot-name list (FC=59 mode=0) and the currently
/// active preset's name (mode=4) as one command — deliberately not two
/// independently-callable commands, since both share the same FC=59 request
/// registry key and must not overlap (see `send_request_with_retry`'s doc). The
/// mode=4 request is only sent after the mode=0 oneshot has resolved. Stores
/// the result and emits `live_presets:updated`, same pattern as
/// `live_control_refresh_now`/`parse_and_store_sync_data`.
#[tauri::command]
#[specta::specta]
pub async fn live_control_fetch_presets(app: AppHandle, state: State<'_, LiveDeviceState>, device_id: String) -> Result<DevicePresets, AppError> {
    let (ip, firmware_family, request_tx) = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        let device = inner.devices.get(&device_id).cloned().ok_or_else(|| AppError::from(format!("device {} not found", device_id)))?;
        let request_tx = inner.request_tx.clone().ok_or_else(|| AppError::from("live control is not running"))?;
        (device.ip, device.firmware_family, request_tx)
    };
    require_v118_firmware(&device_id, firmware_family.as_deref())?;

    let list_frame =
        send_request_with_retry(&request_tx, &ip, preset::FC_SAVE_RECALL, 0, preset::build_list_request_body(), true, 0)
            .await?;
    let slots = preset::parse_preset_list(&list_frame)
        .ok_or_else(|| AppError::from(format!("device {} FC=59 mode=0 response had an unexpected shape", device_id)))?;

    let current_frame =
        send_request_with_retry(&request_tx, &ip, preset::FC_SAVE_RECALL, 0, preset::build_current_request_body(), true, 0)
            .await?;
    let active_preset_name = preset::parse_preset_current(&current_frame)
        .ok_or_else(|| AppError::from(format!("device {} FC=59 mode=4 response had an unexpected shape", device_id)))?;

    let snapshot = preset::DevicePresetsSnapshot { slots, active_preset_name: Some(active_preset_name), received_at: now_millis() };
    let sink = LiveEventSink { app, state: state.0.clone() };
    sink.set_presets(device_id.clone(), snapshot.clone());
    Ok(DevicePresets { device_id, presets: snapshot })
}

/// Snapshot getter for FC=50 bridge state — no wire I/O, just whatever the
/// driver's bridge poll tick last stored. Mirrors
/// `live_control_get_presets`; the continuous push side is the
/// `live_bridge:updated` event.
#[tauri::command]
#[specta::specta]
pub fn live_control_get_bridge(state: State<LiveDeviceState>) -> Result<Vec<DeviceBridge>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.bridge.iter().map(|(device_id, bridge)| DeviceBridge { device_id: device_id.clone(), bridge: bridge.clone() }).collect())
}

/// Reads every bridge pair now and waits for the answers, instead of waiting
/// for the driver's own bridge tick to come round to them — the FC=50
/// counterpart to `live_control_fetch_presets`. Used when an amp's editor
/// opens: a project amp's fingerprint cannot be completed until every pair
/// has been reported (see `data/fingerprint.rs`), so the editor would
/// otherwise sit locked until the tick catches up.
///
/// The pairs go out one after another — `RequestRegistry` keys pending
/// requests by `(ip, function_code)`, so two FC=50 requests cannot be in
/// flight at once. Each answer is stored through the same `LiveEventSink`
/// the driver would have used, so `live_bridge:updated` fires exactly as it
/// does for a polled reply.
#[tauri::command]
#[specta::specta]
pub async fn live_control_fetch_bridge(
    app: AppHandle,
    state: State<'_, LiveDeviceState>,
    device_id: String,
) -> Result<DeviceBridge, AppError> {
    let (ip, request_tx) = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        let device = inner
            .devices
            .get(&device_id)
            .cloned()
            .ok_or_else(|| AppError::from(format!("device {} not found", device_id)))?;
        let request_tx = inner.request_tx.clone().ok_or_else(|| AppError::from("live control is not running"))?;
        (device.ip, request_tx)
    };

    let sink = LiveEventSink { app, state: state.0.clone() };
    for pair_index in 0..crate::live::cvr::bridge::BRIDGE_PAIR_COUNT {
        let frame = send_request_with_retry(
            &request_tx,
            &ip,
            crate::live::cvr::bridge::FC_BRIDGE,
            pair_index,
            Vec::new(),
            false,
            0,
        )
        .await?;
        // The pair comes from the reply's own header, not from what was
        // asked — see `parse_bridge_reply`.
        if let Some((pair, bridged)) = crate::live::cvr::bridge::parse_bridge_reply(&frame) {
            sink.set_bridge_pair(device_id.clone(), pair, bridged);
        }
    }

    let bridge = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        inner
            .bridge
            .get(&device_id)
            .cloned()
            .unwrap_or_else(crate::live::cvr::bridge::DeviceBridgeSnapshot::empty)
    };
    Ok(DeviceBridge { device_id, bridge })
}

/// Snapshot getter mirroring `live_control_get_channel_config` — returns
/// whatever `live_control_fetch_presets` last stored, no wire I/O.
#[tauri::command]
#[specta::specta]
pub fn live_control_get_presets(state: State<LiveDeviceState>) -> Result<Vec<DevicePresets>, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    Ok(inner.presets.iter().map(|(device_id, presets)| DevicePresets { device_id: device_id.clone(), presets: presets.clone() }).collect())
}

/// FC=59 mode=2 recall, same convention as every other write in this app
/// (see `write.rs`'s module doc): returns once the device has ACKed the
/// packet, which confirms delivery only. The device's new active preset
/// still shows up on the next manual `live_control_fetch_presets` call, not
/// pushed automatically here.
#[tauri::command]
#[specta::specta]
pub async fn live_control_recall_preset(state: State<'_, LiveDeviceState>, device_id: String, slot_index: u8) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    require_v118_firmware(&device_id, firmware_family.as_deref())?;
    tally.record(write::send_control(&write_tx, ip, &crate::live::cvr::preset::build_recall_packet(slot_index)).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

/// Reads one channel out of the last FC=27 snapshot.
///
/// Several Tier-A writes are whole-record packets — the matrix crosspoint
/// carries gain *and* active, each limiter stage carries all four of its
/// parameters — while this app's commands take partial patches. Merging the
/// patch onto the device's last-known state is what keeps a partial update
/// from zeroing the fields it doesn't mention. (The reference's `matrixActive`
/// action does exactly that: it hardcodes 0 dB when toggling a crosspoint,
/// silently discarding a configured gain.)
///
/// Erroring when no snapshot exists yet is deliberate: without it there is no
/// honest value for the untouched fields, and inventing defaults would push
/// silent wrong values to a live amp. The FC=27 poll runs continuously for
/// every discovered device, so this is only reachable in the first moments
/// after startup.
fn current_channel(
    state: &State<'_, LiveDeviceState>,
    device_id: &str,
    channel_index: u8,
) -> Result<ChannelConfig, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    let snapshot = inner
        .channel_config
        .get(device_id)
        .ok_or_else(|| AppError::from(format!("device {} has no channel data yet — wait for the first poll", device_id)))?;
    snapshot
        .channels
        .iter()
        .find(|c| c.channel_index == u32::from(channel_index))
        .cloned()
        .ok_or_else(|| AppError::from(format!("device {} has no channel {}", device_id, channel_index)))
}

/// FC=12 ROUTING. `gain_db`/`active` are both optional; whichever is omitted
/// is filled from the crosspoint's current state, since the wire packet has
/// no partial form (see `current_channel`).
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_matrix_crosspoint(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    source_index: u8,
    gain_db: Option<f64>,
    active: Option<bool>,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let channel = current_channel(&state, &device_id, channel_index)?;
    let existing = channel
        .matrix_crosspoints
        .iter()
        .find(|c| c.source_index == u32::from(source_index))
        .ok_or_else(|| AppError::from(format!("channel {} has no matrix source {}", channel_index, source_index)))?;

    let packet = write::build_set_matrix_crosspoint(
        firmware_family.as_deref(),
        channel_index,
        source_index,
        gain_db.unwrap_or(existing.gain_db) as f32,
        active.unwrap_or(existing.active),
    )
    .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;

    let mut tally = WriteTally::default();
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

/// FC=69 NOISE_GATE. `threshold_dbu` is only carried on 1.1.9+ — on 1.1.8 the
/// wire body is the enable flag alone, matching
/// `CvrFirmwareCapability.noise_gate_threshold`.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_channel_noise_gate(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    enabled: bool,
    threshold_dbu: f64,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let packet = write::build_set_noise_gate(firmware_family.as_deref(), channel_index, enabled, threshold_dbu as i8)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    let mut tally = WriteTally::default();
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

/// FC=55 RMS_LIMITER / FC=54 PEAK_LIMITER. Takes the same `LimiterPatch` the
/// project-mode command does, and sends one packet per stage the patch
/// actually touches — a patch that only changes an RMS field leaves the peak
/// stage alone rather than rewriting it.
///
/// Each stage is a whole-record write, so the fields the patch omits come
/// from the current snapshot (see `current_channel`).
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_channel_limiter(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    patch: LimiterPatch,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let channel = current_channel(&state, &device_id, channel_index)?;

    let touches_rms = patch.rms_enabled.is_some()
        || patch.rms_threshold_vrms.is_some()
        || patch.rms_attack_ms.is_some()
        || patch.rms_release_multiplier.is_some();
    let touches_peak = patch.peak_enabled.is_some()
        || patch.peak_threshold_vp.is_some()
        || patch.peak_hold_ms.is_some()
        || patch.peak_release_ms.is_some();

    let mut packets: Vec<Vec<u8>> = Vec::new();
    if touches_rms {
        let rms = &channel.limiter.rms;
        packets.push(
            write::build_set_rms_limiter(
                firmware_family.as_deref(),
                channel_index,
                patch.rms_enabled.unwrap_or(rms.enabled),
                patch.rms_threshold_vrms.unwrap_or(rms.threshold_vrms) as f32,
                patch.rms_attack_ms.unwrap_or(rms.attack_ms) as u16,
                patch.rms_release_multiplier.unwrap_or(rms.release_multiplier) as u8,
            )
            .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?,
        );
    }
    if touches_peak {
        let peak = &channel.limiter.peak;
        packets.push(
            write::build_set_peak_limiter(
                firmware_family.as_deref(),
                channel_index,
                patch.peak_enabled.unwrap_or(peak.enabled),
                patch.peak_threshold_vp.unwrap_or(peak.threshold_vp) as f32,
                patch.peak_hold_ms.unwrap_or(peak.hold_ms) as u16,
                patch.peak_release_ms.unwrap_or(peak.release_ms) as u16,
            )
            .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?,
        );
    }

    let mut tally = WriteTally::default();
    for packet in &packets {
        tally.record(write::send_control(&write_tx, ip, packet).await.map_err(|e| e.to_string())?);
    }
    Ok(tally.finish())
}

/// FC=77 SPEAKER_NAME. `direction` picks which side of the channel is
/// renamed — the only wire difference is `in_out_flag`.
///
/// Clearing a name (`None`) writes an all-zero field, which is how the read
/// side already decodes "unnamed" (`decode_name_field` stops at the first
/// NUL). Same ASCII/length rules as the preset store, against the channel
/// field's narrower 16-byte width.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_channel_name(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    direction: EqDirection,
    name: Option<String>,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;

    let name = name.unwrap_or_default();
    let trimmed = name.trim();
    if !trimmed.is_ascii() {
        return Err(AppError::from("channel name must be ASCII — the device stores names as fixed-width ASCII".to_string()));
    }
    if trimmed.bytes().any(|b| b == 0) {
        return Err(AppError::from("channel name cannot contain a null byte".to_string()));
    }
    if trimmed.len() > CHANNEL_NAME_FIELD_LEN {
        return Err(AppError::from(format!("channel name is limited to {} characters", CHANNEL_NAME_FIELD_LEN)));
    }

    let in_out_flag = match direction {
        EqDirection::Input => 0,
        EqDirection::Output => 1,
    };
    let packet = write::build_set_channel_name(firmware_family.as_deref(), channel_index, in_out_flag, trimmed)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    let mut tally = WriteTally::default();
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

/// FC=11 SOURCE_SELECT, plus FC=79 ANALOG_MATRIX_INPUT for an Analog pick.
///
/// FC=11 carries only the source *kind*. Which physical analog input feeds
/// the channel is a separate write — the vendor's `AnalogType` property
/// (`Channels.cs`) and the reference's `analogType` action both send FC=79
/// with the 0-based input index. Sending FC=11 alone made "Analog 2" on a
/// channel already on analog a no-op on the device, even though the packet
/// was acknowledged. `index` is only meaningful for Analog; Dante/AES3 are
/// hard-wired 1:1 to their channel, so it is ignored for those kinds.
///
/// `SourceKind::Backup` is rejected: it is a readback state (raw code >= 3,
/// see `channel_config_v118::source`), not something FC=11 selects — the
/// reference's own comment notes backup is driven by the priority/auto-source
/// controls (FC=80), which is Tier B.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_channel_source(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    kind: SourceKind,
    index: Option<u32>,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let source_code: u8 = match kind {
        SourceKind::Analog => 0,
        SourceKind::Dante => 1,
        SourceKind::Aes3 => 2,
        SourceKind::Backup => {
            return Err(AppError::from(
                "backup is a readback state, not an FC=11 selection — configure it via priority inputs".to_string(),
            ))
        }
    };
    let analog_input = match (kind, index) {
        (SourceKind::Analog, Some(i)) => Some(
            u8::try_from(i).map_err(|_| AppError::from(format!("analog input index {} is out of range", i)))?,
        ),
        _ => None,
    };
    let unknown_firmware =
        || AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id));
    let packet = write::build_set_source_select(firmware_family.as_deref(), channel_index, source_code)
        .ok_or_else(unknown_firmware)?;
    let mut tally = WriteTally::default();
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    if let Some(analog_input) = analog_input {
        let packet = write::build_set_analog_input(firmware_family.as_deref(), channel_index, analog_input)
            .ok_or_else(unknown_firmware)?;
        tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    }
    Ok(tally.finish())
}

/// FC=50 BRIDGE. `channel_index` is the bridged pair's **leader channel**,
/// keeping this command's signature identical to the project-mode
/// `projects_set_output_bridge` so `ConfigureActions` needs no per-source
/// branching.
///
/// The wire, however, addresses **pairs** (0 = A/B, 1 = C/D), so the
/// conversion happens right here at the boundary. Passing the leader channel
/// through unconverted is what made bridging work for A/B and silently do
/// nothing for C/D — channel 2 became `chx=2`, which the device does not
/// recognise as a pair.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_output_bridge(
    app: AppHandle,
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    bridged: bool,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;

    // A pair is always led by its even-numbered channel, so an odd index is
    // a caller bug rather than something to round away silently.
    if channel_index % 2 != 0 {
        return Err(AppError::from(format!(
            "channel {} is not a pair leader — bridging is addressed by the even channel of a pair",
            channel_index
        )));
    }
    let pair_index = channel_index / 2;
    if pair_index >= crate::live::cvr::bridge::BRIDGE_PAIR_COUNT {
        return Err(AppError::from(format!("channel {} is outside the bridgeable pairs", channel_index)));
    }

    let packet = write::build_set_output_bridge(firmware_family.as_deref(), pair_index, bridged)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    let mut tally = WriteTally::default();
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);

    // Re-read this pair the moment the device ACKs, instead of waiting for
    // the driver's own bridge tick — that tick alternates pairs and skips
    // whenever another request is in flight, so a toggled pair could take
    // seconds to come back, long enough that the control reads as broken.
    //
    // This deliberately does NOT use `ResultSink::Internal`. The driver
    // rejects a request that would clash with one already in flight for the
    // same IP, and that rejection is only reported back through an
    // `External` sink — an `Internal` one is dropped in silence. So it goes
    // out as `External` and retries on `Busy`, then stores the result
    // through the same `LiveEventSink` the driver would have used.
    //
    // Failure here is still non-fatal: the write itself is already
    // confirmed, so the worst case falls back to the next scheduled poll.
    let request_tx = { state.0.lock().map_err(|e| e.to_string())?.request_tx.clone() };
    if let Some(request_tx) = request_tx {
        let frame = send_request_with_retry(
            &request_tx,
            &ip.to_string(),
            crate::live::cvr::bridge::FC_BRIDGE,
            pair_index,
            Vec::new(),
            false,
            0,
        )
        .await;
        if let Ok(frame) = frame {
            if let Some((pair, is_bridged)) = crate::live::cvr::bridge::parse_bridge_reply(&frame) {
                let sink = LiveEventSink { app, state: state.0.clone() };
                sink.set_bridge_pair(device_id, pair, is_bridged);
            }
        }
    }

    Ok(tally.finish())
}

/// FC=59 mode=1 store — writes the device's *current* DSP state into
/// `slot_index` under `name`. Note the asymmetry with recall: the wire
/// protocol carries only the name, never parameter data (see `preset.rs`),
/// so this saves whatever the amp is doing right now rather than pushing
/// anything from the app.
///
/// Rejects a name the device cannot round-trip: `decode_name_field` reads
/// slot names back as a null-terminated ASCII field, so an embedded NUL
/// would silently truncate the stored name and non-ASCII bytes would come
/// back mangled. Empty names are rejected too — the list parser has no way
/// to distinguish one from an unused slot.
#[tauri::command]
#[specta::specta]
pub async fn live_control_store_preset(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    slot_index: u8,
    name: String,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    require_v118_firmware(&device_id, firmware_family.as_deref())?;

    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::from("preset name cannot be empty".to_string()));
    }
    if !trimmed.is_ascii() {
        return Err(AppError::from("preset name must be ASCII — the device stores names as fixed-width ASCII".to_string()));
    }
    if trimmed.bytes().any(|b| b == 0) {
        return Err(AppError::from("preset name cannot contain a null byte".to_string()));
    }
    if trimmed.len() > PRESET_NAME_MAX_LEN {
        return Err(AppError::from(format!("preset name is limited to {} characters", PRESET_NAME_MAX_LEN)));
    }

    let mut tally = WriteTally::default();
    tally.record(
        write::send_control(&write_tx, ip, &crate::live::cvr::preset::build_store_packet(slot_index, trimmed))
            .await
            .map_err(|e| e.to_string())?,
    );
    Ok(tally.finish())
}

/// Returns once the device has ACKed the write at the transport level (see
/// `write.rs`'s `send_control`), or errors if it never does — delivery is
/// confirmed, but not that the device applied the value. The next FC=27 poll
/// (already running for every discovered device, see `driver.rs`) picks up
/// the real new state and pushes it to the frontend via the existing
/// `live_channel_config:updated` event — no optimistic update here.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_output_mute(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    muted: bool,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let packet = write::build_set_output_mute(firmware_family.as_deref(), channel_index, muted)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

#[tauri::command]
#[specta::specta]
pub async fn live_control_set_channel_input_mute(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    muted: bool,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let packet = write::build_set_input_mute(firmware_family.as_deref(), channel_index, muted)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

#[tauri::command]
#[specta::specta]
pub async fn live_control_set_channel_delay_in(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    delay_in_ms: f64,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let packet = write::build_set_delay_in(firmware_family.as_deref(), channel_index, delay_in_ms as f32)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

#[tauri::command]
#[specta::specta]
pub async fn live_control_set_channel_phase_invert(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    inverted: bool,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let packet = write::build_set_phase_invert(firmware_family.as_deref(), channel_index, inverted)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

/// FC=60 CUSTOMER_NAME_MODIFY — renames the amp itself, not a channel. Same
/// ASCII/length rules as `live_control_set_channel_name`, against the
/// device-level field's wider 32-byte width. No explicit refetch: the new
/// name comes back through the next FC=0 `BASIC_INFO` read.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_device_name(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    name: String,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;

    let trimmed = name.trim();
    if !trimmed.is_ascii() {
        return Err(AppError::from("device name must be ASCII — the device stores names as fixed-width ASCII".to_string()));
    }
    if trimmed.bytes().any(|b| b == 0) {
        return Err(AppError::from("device name cannot contain a null byte".to_string()));
    }
    if trimmed.len() > DEVICE_NAME_FIELD_LEN {
        return Err(AppError::from(format!("device name is limited to {} characters", DEVICE_NAME_FIELD_LEN)));
    }

    let packet = write::build_set_device_name(firmware_family.as_deref(), trimmed)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    let mut tally = WriteTally::default();
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

/// FC=17 ROTARY_LOCK — locks/unlocks the amp's front-panel knobs. Does not
/// affect what this app may edit. No explicit refetch: the new state comes
/// back through the next FC=27 poll (`rotary_locked`).
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_rotary_lock(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    locked: bool,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let packet = write::build_set_rotary_lock(firmware_family.as_deref(), locked)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

/// FC=15 STANDBY — puts the amp into standby or brings it back out. Amp-wide,
/// not per channel. No explicit refetch: the new state comes back through the
/// next FC=27 poll (`standby`), same as the front-panel lock.
///
/// Deliberately does not check `standby_locked` (FC=27 byte 32 == 2)
/// before sending: the frontend disables the control in that case, and the
/// authority on whether the amp will accept it is the amp, not a cached poll.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_standby(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    standby: bool,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let packet = write::build_set_standby(firmware_family.as_deref(), standby)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

#[tauri::command]
#[specta::specta]
pub async fn live_control_set_channel_power_mode(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    power_mode: PowerMode,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let packet = write::build_set_power_mode(firmware_family.as_deref(), channel_index, power_mode)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

/// Partial update of a channel's output trim/volume/delay — mirrors
/// `projects_set_channel_output`'s per-field-optional convention, but unlike
/// that single-struct-mutation command, each populated field here is its own
/// wire write (different FC/`in_out_flag` per field, see `write_v118.rs`) —
/// up to three UDP sends per call, each awaited to its ACK before the next
/// goes out (writes are stop-and-wait per device; see `WriteRegistry`), so a
/// failure on any field surfaces instead of being masked by the others.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_channel_output(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    trim_db: Option<f64>,
    volume_db: Option<f64>,
    delay_out_ms: Option<f64>,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let firmware_family = firmware_family.as_deref();

    let mut packets = Vec::with_capacity(3);
    if let Some(trim_db) = trim_db {
        packets.push(write::build_set_output_trim(firmware_family, channel_index, trim_db as f32));
    }
    if let Some(volume_db) = volume_db {
        packets.push(write::build_set_output_volume(firmware_family, channel_index, volume_db as f32));
    }
    if let Some(delay_out_ms) = delay_out_ms {
        packets.push(write::build_set_delay_out(firmware_family, channel_index, delay_out_ms as f32));
    }

    for packet in packets {
        let packet = packet.ok_or_else(|| {
            AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id))
        })?;
        tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    }
    Ok(tally.finish())
}

/// Partial update of one parametric EQ band (1-8) — mirrors
/// `projects_set_eq_band`'s shape (`EqBandPatch`, only non-`None` fields
/// applied), but `filter_type`/`active` share one wire byte (FC=30) on this
/// protocol, so touching either one requires merging in the *other's*
/// current value first (see `current_eq_band`) rather than writing a
/// stale/default byte for whichever field wasn't part of this patch.
/// `freq_hz`/`gain_db`/`q` are independent FCs (32/31/34) and each sends its
/// own packet when present in the patch — up to 4 UDP sends per call.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_eq_band(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    direction: EqDirection,
    band_index: u8,
    patch: EqBandPatch,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let firmware_family = firmware_family.as_deref();
    let in_out_flag: u8 = match direction {
        EqDirection::Input => 0,
        EqDirection::Output => 1,
    };
    // `band_index` (0-7) is the array index into `ChannelEq.bands`; the wire
    // protocol's `segment` numbering reserves 0 for HP and 9 for LP, so a
    // parametric band's wire segment is always `band_index + 1` (1-8), never
    // `band_index` directly — passing it unshifted silently aims every write
    // at the wrong stage (band 0 would land on the HP crossover slot).
    let segment = band_index + 1;

    if patch.filter_type.is_some() || patch.active.is_some() {
        let current = current_eq_band(&state, &device_id, channel_index, direction, band_index as usize)?
            .ok_or_else(|| AppError::from(format!("device {} channel {} has no cached EQ state yet — try again shortly", device_id, channel_index)))?;
        let filter_type = patch.filter_type.unwrap_or(current.filter_type);
        let active = patch.active.unwrap_or(current.active);
        let type_code = eq_filter_type_code(filter_type);
        let packet = write::build_set_eq_filter_type(firmware_family, channel_index, in_out_flag, segment, type_code, active)
            .ok_or_else(|| unknown_firmware_error(&device_id))?;
        tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    }
    if let Some(freq_hz) = patch.freq_hz {
        let packet = write::build_set_eq_freq(firmware_family, channel_index, in_out_flag, segment, freq_hz as f32)
            .ok_or_else(|| unknown_firmware_error(&device_id))?;
        tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    }
    if let Some(gain_db) = patch.gain_db {
        let packet = write::build_set_eq_gain(firmware_family, channel_index, in_out_flag, segment, gain_db as f32)
            .ok_or_else(|| unknown_firmware_error(&device_id))?;
        tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    }
    if let Some(q) = patch.q {
        let packet = write::build_set_eq_q(firmware_family, channel_index, in_out_flag, segment, q as f32)
            .ok_or_else(|| unknown_firmware_error(&device_id))?;
        tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    }
    Ok(tally.finish())
}

/// Partial update of the HP or LP crossover slot — same `filter_type`/
/// `active` merge requirement as `live_control_set_eq_band` (see its doc
/// comment), plus a device-required follow-up: any FILTER_TYPE/FILTER_FREQ
/// write to a crossover slot only takes effect once
/// `write::CROSSOVER_COMMIT_PACKET` is sent afterward (reverse-engineered by
/// the reference implementation from real packet captures — see that
/// constant's doc comment). Sent once per call, after whichever field(s)
/// were actually written, not once per field.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_crossover_slot(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    direction: EqDirection,
    slot: CrossoverSlotKind,
    patch: CrossoverSlotPatch,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let firmware_family = firmware_family.as_deref();
    let in_out_flag: u8 = match direction {
        EqDirection::Input => 0,
        EqDirection::Output => 1,
    };
    // HP = segment 0, LP = segment 9 of the fixed 10-band chain, per the
    // reference's `getCrossoverSegment`.
    let segment: u8 = match slot {
        CrossoverSlotKind::Hp => 0,
        CrossoverSlotKind::Lp => 9,
    };
    let mut wrote_anything = false;

    if patch.filter_type.is_some() || patch.active.is_some() {
        let current = current_crossover_slot(&state, &device_id, channel_index, direction, slot)?.ok_or_else(|| {
            AppError::from(format!("device {} channel {} has no cached EQ state yet — try again shortly", device_id, channel_index))
        })?;
        let filter_type = patch.filter_type.unwrap_or(current.filter_type);
        let active = patch.active.unwrap_or(current.active);
        let type_code = crossover_filter_type_code(filter_type);
        let packet = write::build_set_eq_filter_type(firmware_family, channel_index, in_out_flag, segment, type_code, active)
            .ok_or_else(|| unknown_firmware_error(&device_id))?;
        tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
        wrote_anything = true;
    }
    if let Some(freq_hz) = patch.freq_hz {
        let packet = write::build_set_eq_freq(firmware_family, channel_index, in_out_flag, segment, freq_hz as f32)
            .ok_or_else(|| unknown_firmware_error(&device_id))?;
        tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
        wrote_anything = true;
    }
    if wrote_anything {
        tally.record(write::send_control(&write_tx, ip, &write::CROSSOVER_COMMIT_PACKET).await.map_err(|e| e.to_string())?);
    }
    Ok(tally.finish())
}

/// Reads one output channel's FIR filter (FC=43) — name plus the raw 512-tap
/// coefficient array. The on-demand counterpart to nothing: FIR data is not in
/// the FC=27 sync block and nothing polls it in the background, so this command
/// is the only way it ever reaches the app.
///
/// `expects_fragments` is true because the reply is ~2093 bytes, which the
/// protocol splits into five datagrams. That also makes the request wait for a
/// clear line per `RequestRegistry::conflicts_with` — the per-IP reassembler
/// cannot interleave two fragmented exchanges — so it will collide with the
/// 200ms FC=27 poll tick fairly often; `send_request_with_retry`'s `Busy`
/// retry is what absorbs that.
///
/// **Deliberately unlike `live_control_fetch_presets`/`_fetch_bridge`, this
/// stores nothing in `LiveDeviceState` and emits no event.** Those cache
/// because several views read the same snapshot and a background tick keeps it
/// fresh. FIR has one consumer, is fetched per channel on demand, and is never
/// refreshed behind the caller's back — so a cache here would add an
/// invalidation question and answer none. The snapshot is returned; the caller
/// holds it.
#[tauri::command]
#[specta::specta]
pub async fn live_control_fetch_channel_fir(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
) -> Result<DeviceChannelFir, AppError> {
    let (ip, firmware_family, request_tx) = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        let device = inner.devices.get(&device_id).cloned().ok_or_else(|| AppError::from(format!("device {} not found", device_id)))?;
        let request_tx = inner.request_tx.clone().ok_or_else(|| AppError::from("live control is not running"))?;
        (device.ip, device.firmware_family, request_tx)
    };
    require_fir_firmware(&device_id, firmware_family.as_deref())?;

    let frame = send_request_with_retry(
        &request_tx,
        &ip,
        fir::FC_FIR_DATA,
        channel_index,
        fir::build_fir_request_body(),
        true,
        fir::FIR_IN_OUT_FLAG,
    )
    .await?;

    let snapshot = fir::parse_fir_data(&frame, channel_index).ok_or_else(|| {
        AppError::from(format!(
            "device {} FC=43 response for channel {} had an unexpected shape ({} bytes)",
            device_id,
            channel_index,
            frame.len()
        ))
    })?;
    Ok(DeviceChannelFir { device_id, fir: snapshot })
}
