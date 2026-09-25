//! Shared lookup/validation logic for live commands, used by both the desktop
//! and mobile apps: resolving a device's write target, sending one built
//! packet, on-demand reads (preset fetch), tallying acknowledgements, and
//! merging a partial parameter write against the most recently polled channel
//! config. Pulled out of the (Tauri command) layer because none of it
//! actually needs `tauri::State` — just `&LiveDeviceState`, which this crate
//! already owns.

use std::net::Ipv4Addr;

use tokio::sync::mpsc;

use crate::data::project::{CrossoverSlot, CrossoverSlotKind, EqBand, EqDirection};
use crate::error::AppError;
use crate::live::cvr::channel_config::ChannelConfig;
use crate::data::common::now_millis;
use crate::live::cvr::preset::{self, DevicePresetsSnapshot};
use crate::live::cvr::request::{RequestError, RequestSpec, ResultSink, WriteOutcome, WriteSpec};
use crate::live::cvr::write;
use crate::live::state::{LiveDeviceState, LiveEventSink, LiveWriteAck};

/// Shared lookup for every write command below: resolves `device_id` to its
/// current `firmware_family`, parsed IP, and the running driver's write
/// channel in one pass, so each command body is just "build a packet or
/// error, then send it". The channel is resolved here rather than at each
/// send so a command against a stopped driver fails before building anything.
pub fn resolve_write_target(
    state: &LiveDeviceState,
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
pub struct WriteTally {
    packets: u32,
    attempts: u32,
    elapsed_ms: u32,
    coalesced: u32,
}

impl WriteTally {
    pub fn record(&mut self, outcome: WriteOutcome) {
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

    pub fn finish(self) -> LiveWriteAck {
        LiveWriteAck {
            packets: self.packets,
            attempts: self.attempts,
            elapsed_ms: self.elapsed_ms,
            coalesced: self.coalesced,
        }
    }
}

pub fn unknown_firmware_error(device_id: &str) -> AppError {
    AppError::from(format!("device {} has unrecognized/unknown firmware — cannot build write packet", device_id))
}

/// FC=59 preset fetch/recall has no confirmed 1.1.9 spec in either reference
/// source (see `live/cvr/preset.rs`'s module doc) — gate the feature to 1.1.8
/// only rather than guessing it also works there, matching this app's
/// "no generic fallback encoding" write philosophy.
pub fn presets_supported(firmware_family: Option<&str>) -> bool {
    firmware_family == Some("1.1.8")
}

pub fn require_v118_firmware(device_id: &str, firmware_family: Option<&str>) -> Result<(), AppError> {
    if !presets_supported(firmware_family) {
        return Err(AppError::from(format!(
            "device {} preset fetch/recall requires firmware 1.1.8 (detected: {:?})",
            device_id, firmware_family
        )));
    }
    Ok(())
}

/// Resolve the device, build one packet for its firmware, send it through the
/// driver's socket. The amp's new state comes back via the next FC=27 poll.
///
/// Returns the packet's `WriteOutcome` so a caller can report delivery — feed
/// it to a `WriteTally` for the `LiveWriteAck` the frontend reads. Resolving
/// `Ok` means the amp acknowledged the datagram (see `send_control`), never
/// that the parameter took the requested value.
pub async fn send_write(
    state: &LiveDeviceState,
    device_id: &str,
    build: impl FnOnce(Option<&str>) -> Option<Vec<u8>>,
) -> Result<WriteOutcome, AppError> {
    let (firmware, ip, write_tx) = resolve_write_target(state, device_id)?;
    let packet = build(firmware.as_deref()).ok_or_else(|| unknown_firmware_error(device_id))?;
    Ok(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?)
}

/// Same shape as `send_write`, for a command whose packet doesn't fit one
/// datagram (today: FIR coefficient import — see `fir::split_into_fragments`).
/// Sends each fragment through `send_control` **sequentially**, awaiting one
/// fragment's ACK before building the next, matching the vendor's own
/// stop-and-wait fragment loop — this is what keeps at most one fragment ever
/// queued in `WriteRegistry` at a time, so ordering and coalescing stay sound
/// with no changes to that registry beyond `coalesce_key`'s continuation-
/// fragment guard. Aborts on the first fragment that fails rather than
/// sending the rest of a frame the device already missed part of.
pub async fn send_fragmented_write(
    state: &LiveDeviceState,
    device_id: &str,
    build: impl FnOnce(Option<&str>) -> Option<Vec<Vec<u8>>>,
) -> Result<LiveWriteAck, AppError> {
    let (firmware, ip, write_tx) = resolve_write_target(state, device_id)?;
    let packets = build(firmware.as_deref()).ok_or_else(|| unknown_firmware_error(device_id))?;
    let mut tally = WriteTally::default();
    for packet in packets {
        tally.record(write::send_control(&write_tx, ip, &packet).await.map_err(|e| e.to_string())?);
    }
    Ok(tally.finish())
}

/// Retry budget for `RequestError::Busy`. Must outlast one stalled request
/// (`REQUEST_TIMEOUT_MS` + `REQUEST_RETRY_TIMEOUT_MS` = 4.2s): an unanswered
/// poll parks the whole per-IP line for that long, since a fragmented read
/// conflicts with anything in flight (see `RequestRegistry::conflicts_with`).
/// The old ~300ms budget made the post-recall FC=59 re-fetch fail every time.
/// Cost: an unreachable device reports Busy after ~6s.
const REQUEST_BUSY_MAX_RETRIES: u32 = 200;
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
pub async fn send_request_with_retry(
    request_tx: &mpsc::UnboundedSender<RequestSpec>,
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
        let spec = RequestSpec {
            ip: ip.to_string(),
            function_code,
            chx,
            body: body.clone(),
            expects_fragments,
            in_out_flag,
            sink: ResultSink::External(tx),
        };
        request_tx.send(spec).map_err(|_| AppError::from("live control driver is not running"))?;
        match rx.await.map_err(|_| AppError::from("live control driver dropped the request"))? {
            Ok(frame) => return Ok(frame),
            Err(RequestError::Busy) => {
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
/// active preset's name (mode=4) as one call — deliberately not two
/// independently-callable ones, since both share the same FC=59 request
/// registry key and must not overlap (see `send_request_with_retry`'s doc). The
/// mode=4 request is only sent after the mode=0 oneshot has resolved. Stores
/// the result and emits it through `sink` (`live_presets:updated`), same
/// pattern as `parse_and_store_sync_data`.
pub async fn fetch_presets(sink: &LiveEventSink, device_id: &str) -> Result<DevicePresetsSnapshot, AppError> {
    let (ip, firmware_family, request_tx) = {
        let inner = sink.state.lock().map_err(|e| e.to_string())?;
        let device = inner.devices.get(device_id).cloned().ok_or_else(|| AppError::from(format!("device {} not found", device_id)))?;
        let request_tx = inner.request_tx.clone().ok_or_else(|| AppError::from("live control is not running"))?;
        (device.ip, device.firmware_family, request_tx)
    };
    require_v118_firmware(device_id, firmware_family.as_deref())?;

    let list_frame =
        send_request_with_retry(&request_tx, &ip, preset::FC_SAVE_RECALL, 0, preset::build_list_request_body(), true, 0).await?;
    let slots = preset::parse_preset_list(&list_frame)
        .ok_or_else(|| AppError::from(format!("device {} FC=59 mode=0 response had an unexpected shape", device_id)))?;

    let current_frame =
        send_request_with_retry(&request_tx, &ip, preset::FC_SAVE_RECALL, 0, preset::build_current_request_body(), true, 0).await?;
    let active_preset_name = preset::parse_preset_current(&current_frame)
        .ok_or_else(|| AppError::from(format!("device {} FC=59 mode=4 response had an unexpected shape", device_id)))?;

    let snapshot = DevicePresetsSnapshot { slots, active_preset_name: Some(active_preset_name), received_at: now_millis() };
    sink.set_presets(device_id.to_string(), snapshot.clone());
    Ok(snapshot)
}


/// FC=43 FIR_datas is confirmed against 1.1.8, and 1.1.9 is accepted on the
/// same basis `write.rs` already accepts it for FC=44 FIR bypass: the two
/// firmwares share the v118 encoder for every FIR command, and
/// `capability::cvr` gates the whole feature on vNum >= 118 (`fir_filters`).
/// Anything older — or an unrecognized firmware — is refused rather than
/// guessed at, matching this app's no-fallback-encoding rule.
pub fn require_fir_firmware(device_id: &str, firmware_family: Option<&str>) -> Result<(), AppError> {
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
pub fn current_eq_band(
    state: &LiveDeviceState,
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
pub fn current_crossover_slot(
    state: &LiveDeviceState,
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
pub fn current_channel(
    state: &LiveDeviceState,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_retry_budget_outlasts_a_stalled_request() {
        use crate::live::cvr::request::{REQUEST_RETRY_TIMEOUT_MS, REQUEST_TIMEOUT_MS};
        let budget_ms = u64::from(REQUEST_BUSY_MAX_RETRIES) * REQUEST_BUSY_RETRY_DELAY_MS;
        assert!(budget_ms > REQUEST_TIMEOUT_MS + REQUEST_RETRY_TIMEOUT_MS, "busy budget {budget_ms}ms is too short");
    }

    #[test]
    fn presets_are_gated_to_1_1_8_only() {
        assert!(presets_supported(Some("1.1.8")));
        assert!(!presets_supported(Some("1.1.9")));
        assert!(!presets_supported(None));
    }
}
