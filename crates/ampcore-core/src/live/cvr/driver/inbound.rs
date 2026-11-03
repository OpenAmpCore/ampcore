use super::*;

/// Parses a resolved FC=27 SYNC_DATA frame, stores it, and broadcasts
/// `live_channel_config:updated` — shared by the config-poll tick's
/// `Internal` path here and `live_control_refresh_now`'s `External`
/// on-demand path (see `commands/live_control.rs`), so both go through
/// identical validation/parsing instead of two copies drifting apart.
/// Diagnostic: prints which FC=27 body bytes changed since the previous
/// poll for this device.
///
/// This is how the prior web port located `mute_in` ("empirically confirmed
/// by diffing live snapshots with known mute states") and it is the only
/// reliable way to locate a field whose offset is otherwise guesswork.
/// Toggle one setting on the amp and whatever offsets print are that
/// setting's bytes.
///
/// It already earned its keep: bridging pair 0 printed
/// `34 (ch0+34): 0x01 -> 0x00`, i.e. absolute offset 34 — exactly
/// `Machine_Dname[32] + Standby[1] + Rotary_lock[1]` from the vendor
/// `Syncdata_44` struct. So that prefix block is real, and sits at the
/// *start* of the body rather than after the channel blocks (where an
/// earlier attempt wrongly placed it, via `trailer_base`). Bridge state is
/// read from FC=50 rather than from here (see `bridge.rs`), but the finding
/// puts `Standby`/`Rotary_lock` at absolute offsets 32/33, which is where
/// `channel_config_v118::parse_channel_config` reads them.
///
/// FC=27 carries configuration, not telemetry (levels/temps arrive on their
/// own function code), so a quiescent amp should print nothing at all and a
/// single toggle should print a handful of offsets. Offsets are reported
/// both absolutely and relative to whichever region they fall in, since the
/// per-channel stride and the trailer base are what the parser actually
/// indexes against.
pub(super) fn log_sync_body_diff(ip: &str, body: &[u8]) {
    if !wire_log_enabled() {
        return;
    }
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static LAST: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    let store = LAST.get_or_init(|| Mutex::new(HashMap::new()));
    let mut store = match store.lock() {
        Ok(g) => g,
        Err(_) => return,
    };

    let previous = match store.get(ip) {
        Some(prev) if prev.len() == body.len() => prev.clone(),
        // First sight of this device, or the payload changed shape — nothing
        // meaningful to diff against, so just record and wait for the next.
        _ => {
            store.insert(ip.to_string(), body.to_vec());
            println!("[cvr driver] FC=27 diff baseline for {ip}: {} body bytes", body.len());
            return;
        }
    };

    // Same geometry the v118 parser derives, so reported offsets line up
    // with the constants in `channel_config_v118.rs`.
    const BYTES_PER_CHANNEL: usize = 515;
    const TRAILER: usize = 172;
    let trailer_base = if body.len() > TRAILER && (body.len() - TRAILER) % BYTES_PER_CHANNEL == 0 {
        Some(body.len() - TRAILER)
    } else {
        None
    };

    let mut changes: Vec<String> = Vec::new();
    for (abs, (old, new)) in previous.iter().zip(body.iter()).enumerate() {
        if old == new {
            continue;
        }
        let where_ = match trailer_base {
            Some(base) if abs >= base => format!("trailer+{}", abs - base),
            Some(_) => format!("ch{}+{}", abs / BYTES_PER_CHANNEL, abs % BYTES_PER_CHANNEL),
            None => "?".to_string(),
        };
        changes.push(format!("{abs} ({where_}): 0x{old:02x} -> 0x{new:02x}"));
    }

    if !changes.is_empty() {
        println!("[cvr driver] FC=27 body changed for {ip}: {}", changes.join(", "));
    }
    store.insert(ip.to_string(), body.to_vec());
}

pub fn parse_and_store_sync_data(ip: &str, frame: &[u8], sink: &LiveEventSink) -> Result<channel_config::ChannelConfigSnapshot, String> {
    if frame.len() < STRUCT_HEADER_LEN + CHECKSUM_LEN {
        return Err(format!("FC=27 frame too short for {}: {} bytes", ip, frame.len()));
    }
    let body = &frame[STRUCT_HEADER_LEN..frame.len() - CHECKSUM_LEN];
    log_sync_body_diff(ip, body);
    let device = {
        let inner = sink.state.lock().unwrap();
        inner.devices.values().find(|d| d.ip == ip).cloned()
    };
    let Some(device) = device else {
        return Err(format!("no known device for ip {}", ip));
    };
    match channel_config::parse_channel_config(device.firmware_family.as_deref(), body, device.output_channels) {
        Some(mut cfg) => {
            let gain_from_volume = device.firmware_family.as_deref() == Some("1.1.8");
            for channel in &mut cfg.channels {
                if gain_from_volume {
                    // No gain setting on 1.1.8: derived from the volume, read-only.
                    channel.amp_gain_db =
                        amp_gain_v118_db(device.gain_max, channel.power_mode, f64::from(channel.output_volume_db)).map(|g| g as f32);
                } else {
                    channel.amp_gain_range_db = amp_gain_range_db(device.gain_max, channel.power_mode);
                }
                channel.amp_sensitivity_v =
                    channel.amp_gain_db.and_then(|g| amp_sensitivity_v(f64::from(g), device.gain_max, channel.power_mode));
            }
            sink.set_channel_config(device.id, cfg.clone());
            Ok(cfg)
        }
        None => Err(format!(
            "FC=27 parse failure for {} (firmware {:?}, {} body bytes)",
            ip,
            device.firmware_family,
            body.len()
        )),
    }
}

/// Delivers one resolved request's result to wherever it needs to go.
/// `Internal` (the config-poll tick's own requests) is handled synchronously
/// right here — parsing ~2.5KB of already-in-memory bytes is not actually
/// async work, so there's no need for a channel/oneshot round trip for this
/// case. `External` wakes whatever task is awaiting the oneshot `Receiver`
/// on the other side (a Tauri command, see `live_control_refresh_now`) via a
/// non-blocking send.
pub(super) fn deliver_resolved(resolved: crate::live::cvr::request::ResolvedRequest, sink: &LiveEventSink) {
    match resolved.sink {
        ResultSink::Internal => {
            if resolved.function_code == FC_BRIDGE {
                // Successful replies are wire-log only; the failure
                // branches still print unconditionally, since "no reply" and
                // "reply the parser rejected" are indistinguishable from the
                // UI (an unanswered pair renders the same as an unbridged
                // one) and are the two things worth knowing about.
                match resolved.result {
                    Ok(frame) => {
                        if wire_log_enabled() {
                            println!(
                                "[cvr driver] FC=50 reply <- {} ({} bytes) [{}]",
                                resolved.ip,
                                frame.len(),
                                frame.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")
                            );
                        }
                        match crate::live::cvr::bridge::parse_bridge_reply(&frame) {
                            Some((pair, bridged)) => {
                                let device_id = {
                                    let inner = sink.state.lock().unwrap();
                                    inner.devices.values().find(|d| d.ip == resolved.ip).map(|d| d.id.clone())
                                };
                                match device_id {
                                    Some(device_id) => {
                                        if wire_log_enabled() {
                                            println!(
                                                "[cvr driver] FC=50 bridge for {}: pair {pair} = {bridged}",
                                                resolved.ip
                                            );
                                        }
                                        sink.set_bridge_pair(device_id, pair, bridged);
                                    }
                                    None => eprintln!(
                                        "[cvr driver] FC=50 reply from {} dropped: no discovered device has that ip",
                                        resolved.ip
                                    ),
                                }
                            }
                            None => eprintln!(
                                "[cvr driver] FC=50 reply from {} rejected by parser (unexpected shape)",
                                resolved.ip
                            ),
                        }
                    }
                    // Timeouts are wire-log only: a model without bridging
                    // never answers, and that would otherwise print forever.
                    Err(RequestError::Timeout) => {
                        if wire_log_enabled() {
                            println!("[cvr driver] FC=50 request to {} timed out — no bridge reply", resolved.ip);
                        }
                    }
                    Err(RequestError::Busy) => {
                        if wire_log_enabled() {
                            println!("[cvr driver] FC=50 request to {} was rejected as busy", resolved.ip);
                        }
                    }
                }
                return;
            }
            if resolved.function_code == FC_FIR_DATA {
                match resolved.result {
                    Ok(frame) => match parse_fir_data(&frame, resolved.chx) {
                        Some(fir) => {
                            let device_id = {
                                let inner = sink.state.lock().unwrap();
                                inner.devices.values().find(|d| d.ip == resolved.ip).map(|d| d.id.clone())
                            };
                            if let Some(device_id) = device_id {
                                sink.set_fir(device_id, fir);
                            }
                        }
                        None => eprintln!(
                            "[cvr driver] FC=43 reply from {} for channel {} rejected by parser ({} bytes)",
                            resolved.ip,
                            resolved.chx,
                            frame.len()
                        ),
                    },
                    // Retried on the FIR cadence; an amp that keeps failing
                    // shows as "FIR filter not read yet" in its fingerprint.
                    Err(_) => {
                        if wire_log_enabled() {
                            println!("[cvr driver] FC=43 request to {} channel {} got no reply", resolved.ip, resolved.chx);
                        }
                    }
                }
                return;
            }
            if resolved.function_code != FC_SYNC_DATA {
                return;
            }
            match resolved.result {
                Ok(frame) => match parse_and_store_sync_data(&resolved.ip, &frame, sink) {
                    Ok(cfg) => {
                        if wire_log_enabled() {
                            println!("[cvr driver] FC=27 config for {}: {} channels", resolved.ip, cfg.channels.len());
                        }
                    }
                    Err(e) => eprintln!("[cvr driver] {e}"),
                },
                Err(RequestError::Timeout) => {
                    eprintln!("[cvr driver] FC=27 request to {} timed out", resolved.ip);
                }
                // Never actually produced for a *registered* Internal request —
                // `Busy` is only ever sent from the `request_rx` arm's rejection
                // path, before a request is registered at all — but matched
                // here for exhaustiveness.
                Err(RequestError::Busy) => {
                    eprintln!("[cvr driver] FC=27 request to {} unexpectedly resolved as Busy", resolved.ip);
                }
            }
        }
        ResultSink::External(tx) => {
            let _ = tx.send(resolved.result);
        }
    }
}

/// Handles a single-fragment (`packets_count <= 1`) datagram exactly as
/// `handle_packet` always has — this is the trivial passthrough case of the
/// reassembler, so FC=0/FC=6 dispatch is byte-for-byte unchanged from before
/// the request/fragmentation engine existed.
pub(super) fn handle_single(raw: &[u8], ip: String, sink: &LiveEventSink, protocol_slug: &'static str, brand: &'static str) -> Option<String> {
    if raw.len() < NETWORK_HEADER_LEN + STRUCT_HEADER_LEN {
        return None;
    }
    let assembled = &raw[NETWORK_HEADER_LEN..];
    if !validate_frame(assembled) {
        return None;
    }

    match raw[11] {
        FC_BASIC_INFO => {
            if let Some(info) = parse_basic_info_reply(raw) {
                let firmware_family = detect_firmware_family(&info.firmware_version).label().map(String::from);
                let machine_state_decoded =
                    channel_state::decode(firmware_family.as_deref(), info.machine_state as i32);
                sink.upsert(DiscoveredDevice {
                    id: format!("{protocol_slug}:{}", info.mac),
                    driver_id: protocol_slug.to_string(),
                    brand: brand.to_string(),
                    name: info.name,
                    mac: info.mac,
                    ip,
                    firmware_version: info.firmware_version,
                    firmware_family,
                    gain_max: info.gain_max as u32,
                    analog_input_channels: info.analog_input_channels as u32,
                    digital_input_channels: info.digital_input_channels as u32,
                    output_channels: info.output_channels as u32,
                    machine_state: info.machine_state as u32,
                    machine_state_decoded,
                    online: true,
                    last_seen_at: now_millis(),
                });
            }
            None
        }
        FC_HEARTBEAT => {
            sink.touch_by_ip(&ip);
            // Firmware string only arrives via BASIC_INFO, not the heartbeat
            // body itself — dispatch to the firmware-specific adapter
            // (see `telemetry::parse_heartbeat_telemetry`) by the family already detected
            // at discovery time. Unrecognized families get no telemetry.
            let device = {
                let inner = sink.state.lock().unwrap();
                inner.devices.values().find(|d| d.ip == ip).cloned()
            };
            let device = device?;
            if let Some(mut parsed) = telemetry::parse_heartbeat_telemetry(device.firmware_family.as_deref(), raw) {
                // Enrichment step, not part of the wire adapter itself: the
                // adapters only see raw packet bytes, but a real rated
                // voltage (needed as the dB reference) can only be looked up
                // from the device's own firmware string. Stays `None` per
                // channel — never a guessed default — for any model this
                // doesn't recognize.
                if let Some(rated_v) = rated_rms_voltage_from_firmware_string(&device.firmware_version) {
                    let rated_v_f32 = rated_v as f32;
                    parsed.output_level_db =
                        parsed.output_voltages.iter().map(|&v| voltage_to_db(v, 1.0, rated_v_f32)).collect();
                    parsed.rated_rms_voltage = Some(rated_v);
                }
                // Same kind of enrichment for the output state bytes: the
                // numbering is firmware-specific, and the family is only known
                // here. (The input bytes are a different, fixed two-value flag
                // the adapter decodes itself — see `Telemetry::input_clipping`.)
                let family = device.firmware_family.as_deref();
                parsed.output_channel_states =
                    channel_state::decode_all(family, parsed.output_states.iter().map(|&v| v as i32));
                parsed.machine_state_decoded = channel_state::decode(family, parsed.machine_mode);
                sink.set_telemetry(device.id.clone(), parsed);
            }
            Some(device.id)
        }
        _ => None, // out of scope this pass
    }
}

#[cfg(test)]
mod start_tests {
    use super::*;
    use crate::live::state::{EventEmitter, LiveDeviceState, LiveEvent};

    struct NoEmit;
    impl EventEmitter for NoEmit {
        fn emit(&self, _event: LiveEvent) {}
    }

    #[test]
    fn start_reports_a_taken_port() {
        // Bound to the adapter's address, as the vendor app does. Windows lets a
        // specific bind coexist with someone else's 0.0.0.0, so that is no clash.
        // Already taken (a running AmpCore) serves the test just as well.
        let (_, ip, _) = wanted_adapters(None).remove(0);
        let _held = std::net::UdpSocket::bind((ip, PC_LISTEN_PORT)).ok();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let state = LiveDeviceState::new();
        let sink = LiveEventSink { emitter: Arc::new(NoEmit), state: state.0.clone() };

        let error = state.start(sink, runtime.handle()).expect_err("bind should fail");

        assert!(error.message.contains("45454"), "{}", error.message);
    }

    #[test]
    fn a_selected_adapter_that_is_gone_opens_nothing() {
        assert!(wanted_adapters(Some("no such adapter")).is_empty());
    }
}
