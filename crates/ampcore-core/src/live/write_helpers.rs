//! Shared lookup/validation logic for live write commands: resolving a
//! device's write target, tallying packet acknowledgements, and merging a
//! partial parameter write against the most recently polled channel config.
//! Pulled out of the (Tauri command) layer because none of it actually
//! needs `tauri::State` — just `&LiveDeviceState`, which this crate already
//! owns.

use std::net::Ipv4Addr;

use tokio::sync::mpsc;

use crate::data::project::{CrossoverSlot, CrossoverSlotKind, EqBand, EqDirection};
use crate::error::AppError;
use crate::live::cvr::channel_config::ChannelConfig;
use crate::live::cvr::request::{WriteOutcome, WriteSpec};
use crate::live::state::{LiveDeviceState, LiveWriteAck};

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
pub fn require_v118_firmware(device_id: &str, firmware_family: Option<&str>) -> Result<(), AppError> {
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
