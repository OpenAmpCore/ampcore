use tauri::{AppHandle, State};

use ampcore_core::data::capability::{PowerMode, SourceKind};
use ampcore_core::data::project::{CrossoverSlotKind, CrossoverSlotPatch, EqBandPatch, EqDirection, LimiterPatch};
use ampcore_core::error::AppError;
use ampcore_core::live::cvr::channel_config_v118::{crossover_filter_type_code, eq_filter_type_code};
use ampcore_core::live::cvr::write_v118::{CHANNEL_NAME_FIELD_LEN, DEVICE_NAME_FIELD_LEN};
use ampcore_core::live::cvr::fir;
use ampcore_core::live::cvr::write;
use ampcore_core::live::driver::all_drivers;
use ampcore_core::live::state::{
    DeviceBridge, DeviceChannelConfig, DeviceChannelFir, DevicePresets, DeviceTelemetry, DiscoveredDevice, LiveDeviceState,
    LiveWriteAck,
};
use ampcore_core::live::write_helpers::{
    current_channel, current_crossover_slot, current_eq_band, fetch_presets, require_fir_firmware, require_v118_firmware, resolve_write_target,
    send_fragmented_write, send_request_with_retry,
    unknown_firmware_error, WriteTally,
};

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
    let sink = crate::live::event_sink::make_event_sink(app, state.0.clone());
    let runtime = tauri::async_runtime::handle().inner().clone();
    let handles: Vec<_> = all_drivers().into_iter().map(|driver| driver.start(sink.clone(), &runtime)).collect();
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
    let spec = ampcore_core::live::cvr::request::RequestSpec {
        ip: ip.clone(),
        function_code: ampcore_core::live::cvr::protocol::FC_SYNC_DATA,
        chx: 0,
        body: Vec::new(),
        // FC=27 is always fragmented.
        expects_fragments: true,
        in_out_flag: 0,
        sink: ampcore_core::live::cvr::request::ResultSink::External(tx),
    };
    request_tx.send(spec).map_err(|_| AppError::from("live control driver is not running"))?;
    let frame = rx
        .await
        .map_err(|_| AppError::from("live control driver dropped the request"))?
        .map_err(|e| AppError::from(format!("{:?}", e)))?;

    let sink = crate::live::event_sink::make_event_sink(app, state.0.clone());
    let config = ampcore_core::live::cvr::driver::parse_and_store_sync_data(&ip, &frame, &sink).map_err(AppError::from)?;
    Ok(DeviceChannelConfig { device_id, config })
}

/// The device's preset name field is a fixed 32-byte ASCII buffer (see
/// `preset.rs`'s `PRESET_NAME_LEN`); anything longer is silently truncated
/// on the wire, so reject it up front instead.
const PRESET_NAME_MAX_LEN: usize = 32;
/// Fetches the preset slot list + active preset and emits `live_presets:updated`;
/// the request sequencing lives in `ampcore_core::live::write_helpers::fetch_presets`.
#[tauri::command]
#[specta::specta]
pub async fn live_control_fetch_presets(app: AppHandle, state: State<'_, LiveDeviceState>, device_id: String) -> Result<DevicePresets, AppError> {
    let sink = crate::live::event_sink::make_event_sink(app, state.0.clone());
    let presets = fetch_presets(&sink, &device_id).await?;
    Ok(DevicePresets { device_id, presets })
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

    let sink = crate::live::event_sink::make_event_sink(app, state.0.clone());
    for pair_index in 0..ampcore_core::live::cvr::bridge::BRIDGE_PAIR_COUNT {
        let frame = send_request_with_retry(
            &request_tx,
            &ip,
            ampcore_core::live::cvr::bridge::FC_BRIDGE,
            pair_index,
            Vec::new(),
            false,
            0,
        )
        .await?;
        // The pair comes from the reply's own header, not from what was
        // asked — see `parse_bridge_reply`.
        if let Some((pair, bridged)) = ampcore_core::live::cvr::bridge::parse_bridge_reply(&frame) {
            sink.set_bridge_pair(device_id.clone(), pair, bridged);
        }
    }

    let bridge = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        inner
            .bridge
            .get(&device_id)
            .cloned()
            .unwrap_or_else(ampcore_core::live::cvr::bridge::DeviceBridgeSnapshot::empty)
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
    tally.record(write::send_control(&write_tx, ip, &ampcore_core::live::cvr::preset::build_recall_packet(slot_index)).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
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
/// was acknowledged. `index` is only meaningful for Analog; Dante is
/// hard-wired 1:1 to its channel, so it is ignored for that kind.
///
/// `SourceKind::Backup` is rejected: it is a readback state (raw code >= 3,
/// see `channel_config_v118::source`), not something FC=11 selects. Backup is
/// driven by the priority/auto-source controls instead — see
/// `live_control_set_backup_priority` (FC=80).
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
    if pair_index >= ampcore_core::live::cvr::bridge::BRIDGE_PAIR_COUNT {
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
            ampcore_core::live::cvr::bridge::FC_BRIDGE,
            pair_index,
            Vec::new(),
            false,
            0,
        )
        .await;
        if let Ok(frame) = frame {
            if let Some((pair, is_bridged)) = ampcore_core::live::cvr::bridge::parse_bridge_reply(&frame) {
                let sink = crate::live::event_sink::make_event_sink(app, state.0.clone());
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
        write::send_control(&write_tx, ip, &ampcore_core::live::cvr::preset::build_store_packet(slot_index, trimmed))
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

/// FC=44 FIR bypass. Unlike the FC=43 coefficient read this is a one-byte body
/// in a single datagram, so none of the outbound fragmentation that blocks
/// *writing* coefficients applies (see `live/cvr/fir.rs`). Gated with
/// `require_fir_firmware` rather than the usual unrecognized-firmware
/// fallthrough, so a pre-1.1.8 amp is told why instead of being handed a
/// packet its DSP has no handler for.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_fir_bypass(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    bypassed: bool,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    require_fir_firmware(&device_id, firmware_family.as_deref())?;
    let mut tally = WriteTally::default();
    let packet = write::build_set_fir_bypass(firmware_family.as_deref(), channel_index, bypassed)
        .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

/// FC=43 write (the vendor's Import): a 2093-byte frame that needs outbound
/// fragmentation (see `send_fragmented_write`/`fir::build_set_fir_data`).
/// `coefficients` longer than the device's fixed 512-tap array is rejected —
/// silently truncating an import would drop the tail of the caller's filter.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_channel_fir_data(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    name: String,
    coefficients: Vec<f32>,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, _, _) = resolve_write_target(&state, &device_id)?;
    require_fir_firmware(&device_id, firmware_family.as_deref())?;
    if coefficients.len() > fir::FIR_MAX_TAPS {
        return Err(AppError::from(format!(
            "FIR import has {} taps, more than the device's {}-tap array",
            coefficients.len(),
            fir::FIR_MAX_TAPS
        )));
    }
    send_fragmented_write(&state, &device_id, |firmware| {
        write::build_set_fir_data(firmware, channel_index, &name, &coefficients)
    })
    .await
}

/// FC=43 write with `status_code=6` — the vendor's Remove. Fits one datagram.
#[tauri::command]
#[specta::specta]
pub async fn live_control_clear_channel_fir_data(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
) -> Result<LiveWriteAck, AppError> {
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    require_fir_firmware(&device_id, firmware_family.as_deref())?;
    let mut tally = WriteTally::default();
    let packet = write::build_clear_fir_data(firmware_family.as_deref(), channel_index)
        .ok_or_else(|| unknown_firmware_error(&device_id))?;
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

/// Native "Save as" for the FIR panel's Export — a webview `<a download>` is a
/// no-op inside Tauri. Returns `false` when the user cancels the dialog.
#[tauri::command]
#[specta::specta]
pub async fn fir_export_file(app: AppHandle, default_name: String, contents: String) -> Result<bool, AppError> {
    use tauri_plugin_dialog::DialogExt;
    let Some(path) = app.dialog().file().set_file_name(&default_name).add_filter("Text", &["txt"]).blocking_save_file() else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| AppError::from(e.to_string()))?;
    std::fs::write(path, contents).map_err(|e| AppError::from(e.to_string()))?;
    Ok(true)
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

/// FC=62 SOURCE_DATA. Takes **both** halves rather than a patch: the wire
/// frame always carries trim and delay together, so there is nothing to send
/// for a half-specified edit, and unlike the project command there is no
/// stored copy here to read the sibling back from. The caller holds the live
/// readback and supplies the unchanged value.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_source_trim(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    kind: SourceKind,
    trim_db: f64,
    delay_ms: f64,
) -> Result<LiveWriteAck, AppError> {
    let segment: u8 = match kind {
        SourceKind::Analog => 0,
        SourceKind::Dante => 1,
        SourceKind::Backup => {
            return Err(AppError::from(
                "backup is a failover state, not an input with its own trim".to_string(),
            ))
        }
    };
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let packet =
        write::build_set_source_trim(firmware_family.as_deref(), channel_index, segment, trim_db as f32, delay_ms as f32)
            .ok_or_else(|| AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id)))?;
    tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    Ok(tally.finish())
}

/// FC=80 PRIORITY_INPUTS. `first`/`second` are the amp's own source codes
/// (0=Analog, 1=Dante); `threshold_db` is signed and arrives as `i32` because
/// that is what the project model stores, so it is range-checked here rather
/// than silently wrapping into the wire's `i8`.
#[tauri::command]
#[specta::specta]
pub async fn live_control_set_backup_priority(
    state: State<'_, LiveDeviceState>,
    device_id: String,
    channel_index: u8,
    first: u8,
    second: u8,
    enabled: bool,
    threshold_db: i32,
) -> Result<LiveWriteAck, AppError> {
    let threshold = i8::try_from(threshold_db)
        .map_err(|_| AppError::from(format!("backup threshold {} dB is out of range", threshold_db)))?;
    let (firmware_family, ip, write_tx) = resolve_write_target(&state, &device_id)?;
    let mut tally = WriteTally::default();
    let packet =
        write::build_set_backup_priority(firmware_family.as_deref(), channel_index, first, second, enabled, threshold)
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
