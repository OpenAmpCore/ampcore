use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::sync::{mpsc, oneshot};

use crate::data::amp_model::AmpProtocol;
use crate::data::capability::cvr::rated_rms_voltage_from_firmware_string;
use crate::data::common::now_millis;
use crate::live::driver::{AmpDriver, DriverHandle};
use crate::live::dsp::voltage_to_db;
use crate::live::state::{DiscoveredDevice, LiveEventSink};

use super::channel_config;
use super::channel_state;
use super::protocol::*;
use super::bridge::{BRIDGE_PAIR_COUNT, FC_BRIDGE};
use super::request::{
    Assembled, FragmentReassembler, RequestError, RequestRegistry, RequestSpec, ResultSink, WriteRegistry, WriteSpec,
};
use super::telemetry;

// Faster than the reference implementation's `TimerRefresh.Interval = 4000`,
// deliberately: discovery is the *only* evidence that an amp has come back
// (heartbeats go to online, subscribed amps alone), so its cadence is the
// floor on how quickly a returning amp is noticed — 4s there, ~1s here. The
// cost is a broadcast query and one tiny reply per amp per second, and
// `LiveEventSink::upsert` only emits when something actually changed, so an
// amp that simply keeps answering costs the UI nothing.
//
// Heartbeat carries parsed telemetry (see `telemetry.rs`), so it's polled
// faster than the reference's 140ms cycle — an async Rust task has no
// event-loop/GC contention to worry about at this rate.
const DISCOVERY_INTERVAL: Duration = Duration::from_millis(1000);
const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(50);
// Four discovery cycles. Only subscribed amps get heartbeats, so every other
// discovered amp stays "online" purely on its discovery reply — the timeout
// has to tolerate a few lost broadcast replies in a row, which is what ties
// it to the cadence above rather than to any wall-clock feel. It went from
// 12s to 4s *because* the cadence went from 4s to 1s: shortening one without
// the other either flickers amps offline or leaves them stale for seconds.
const OFFLINE_TIMEOUT_MS: f64 = 4_000.0;
const STATS_INTERVAL: Duration = Duration::from_secs(1);
/// FC=27 is far heavier than a 6-byte heartbeat (~2.4KB for a 4-channel amp,
/// requiring fragmentation + reassembly + a full round trip), but the
/// config-poll tick's own `has_pending` check (see the tick handler below)
/// already skips issuing a new request per device while its previous one is
/// still in flight — so this interval is just an upper bound on cadence, not
/// a request-pileup risk, however low it's set. 200ms is close to (slightly
/// under) the reference app's own fast tier for its actively-viewed device
/// (250ms, see below) — the fastest cadence known to work against real
/// hardware, chosen so a write (e.g. `live_control_set_output_mute`) is
/// reflected back to the UI quickly. Uniform across all devices — this
/// backend has no notion of "which device the UI has selected".
///
/// Worth knowing when tuning this: the C# vendor app does **not** poll FC=27
/// on a timer at all. It syncs once on entering a device (`UDP.intoCW`) and
/// thereafter only on discrete events — preset recall, channel copy, import.
/// A periodic sync is this app's own choice, which is why the write interlock
/// below (`WriteRegistry::has_pending`) is load-bearing here in a way it never
/// needed to be there.
/// Bridge state changes only when someone writes it, so once every pair of a
/// device has been reported it refreshes one pair per `BRIDGE_STEADY_INTERVAL`
/// — far slower than the config tick. Until then the tick primes at
/// `BRIDGE_PRIME_INTERVAL`, so a freshly subscribed amp learns both pairs in a
/// few hundred ms rather than seconds: a project amp's fingerprint (hence its
/// edit lock) cannot complete while a pair is still unknown, and FC=50 no
/// longer queues behind the FC=27 poll either (see
/// `RequestRegistry::conflicts_with`).
const BRIDGE_PRIME_INTERVAL: Duration = Duration::from_millis(200);
const BRIDGE_STEADY_INTERVAL: Duration = Duration::from_millis(1500);
const CONFIG_POLL_INTERVAL: Duration = Duration::from_millis(200);
/// Drives the request registry's settle/hard-timeout checks — finer than
/// `SETTLE_MS` (20ms) so a settled request resolves promptly.
const DEADLINE_TICK_INTERVAL: Duration = Duration::from_millis(10);

/// Per-device heartbeat request/reply counters for the terminal stats
/// printout — "cheap" loss/jitter estimation (timing-derived, not a real
/// sequence-numbered ACK correlation, since the wire heartbeat body carries
/// no per-request id to match a reply against). `sent`/`received` reset every
/// `STATS_INTERVAL`; `last_received_at`/inter-arrival accumulators persist
/// across print windows so the very first delta after a reset is still valid.
/// Per-device FC=50 poll state, keyed by IP. `next_pair` round-robins so a
/// device whose pairs are all known refreshes them in turn; `last_sent` is
/// what the steady-state cadence gates on. Per device rather than one shared
/// cursor, so two subscribed amps no longer share a phase and a newly
/// subscribed one starts from pair 0.
struct BridgeCursor {
    next_pair: u8,
    last_sent: Instant,
}

#[derive(Default)]
struct DeviceStats {
    sent: u32,
    received: u32,
    last_received_at: Option<f64>,
    delta_sum_ms: f64,
    delta_sq_sum_ms: f64,
    delta_count: u32,
}

impl DeviceStats {
    fn record_received(&mut self) {
        self.received += 1;
        let now = now_millis();
        if let Some(last) = self.last_received_at {
            let delta = now - last;
            self.delta_sum_ms += delta;
            self.delta_sq_sum_ms += delta * delta;
            self.delta_count += 1;
        }
        self.last_received_at = Some(now);
    }

    /// Standard deviation of inter-arrival time over the current window — a
    /// cheap jitter proxy, not RFC 3550's EWMA jitter estimator.
    fn jitter_ms(&self) -> f64 {
        if self.delta_count == 0 {
            return 0.0;
        }
        let mean = self.delta_sum_ms / self.delta_count as f64;
        let variance = (self.delta_sq_sum_ms / self.delta_count as f64) - mean * mean;
        variance.max(0.0).sqrt()
    }

    fn mean_interval_ms(&self) -> f64 {
        if self.delta_count == 0 {
            0.0
        } else {
            self.delta_sum_ms / self.delta_count as f64
        }
    }

    fn reset_window(&mut self) {
        self.sent = 0;
        self.received = 0;
        self.delta_sum_ms = 0.0;
        self.delta_sq_sum_ms = 0.0;
        self.delta_count = 0;
    }
}

pub struct CvrDriver;

impl AmpDriver for CvrDriver {
    fn protocol(&self) -> AmpProtocol {
        AmpProtocol::CvrUdp
    }

    fn brand(&self) -> &'static str {
        "CVR"
    }

    fn start(&self, sink: LiveEventSink, runtime: &tokio::runtime::Handle) -> DriverHandle {
        let (stop_tx, stop_rx) = oneshot::channel();
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (write_tx, write_rx) = mpsc::unbounded_channel();
        {
            let mut inner = sink.state.lock().unwrap();
            inner.request_tx = Some(request_tx);
            inner.write_tx = Some(write_tx);
        }
        let protocol_slug = self.protocol().slug();
        let brand = self.brand();
        runtime.spawn(async move {
            if let Err(e) = run(sink, stop_rx, request_rx, write_rx, protocol_slug, brand).await {
                eprintln!("[cvr driver] exited with error: {e}");
            }
        });
        DriverHandle::new(stop_tx)
    }
}

async fn run(
    sink: LiveEventSink,
    mut stop_rx: oneshot::Receiver<()>,
    mut request_rx: mpsc::UnboundedReceiver<RequestSpec>,
    mut write_rx: mpsc::UnboundedReceiver<WriteSpec>,
    protocol_slug: &'static str,
    brand: &'static str,
) -> std::io::Result<()> {
    let socket = UdpSocket::bind(("0.0.0.0", PC_LISTEN_PORT)).await?;
    socket.set_broadcast(true)?;

    let mut discovery_tick = tokio::time::interval(DISCOVERY_INTERVAL);
    let mut heartbeat_tick = tokio::time::interval(HEARTBEAT_INTERVAL);
    let mut stats_tick = tokio::time::interval(STATS_INTERVAL);
    let mut config_poll_tick = tokio::time::interval(CONFIG_POLL_INTERVAL);
    let mut bridge_poll_tick = tokio::time::interval(BRIDGE_PRIME_INTERVAL);
    // FC=50 addresses one pair per request and the request registry keys by
    // `(ip, function_code)`, so both pairs of a device cannot be in flight at
    // once — hence one pair per tick per device, tracked here.
    let mut bridge_cursors: HashMap<String, BridgeCursor> = HashMap::new();
    let mut deadline_tick = tokio::time::interval(DEADLINE_TICK_INTERVAL);
    // When the discovery arm last actually ran. A write burst gates it off
    // entirely, and the liveness sweep must not count silence from a stretch
    // where nobody was asked — see the discovery arm below.
    let mut last_discovery_at = Instant::now();
    let mut stats: HashMap<String, DeviceStats> = HashMap::new();
    let mut reassembler = FragmentReassembler::default();
    let mut registry = RequestRegistry::default();
    let mut writes = WriteRegistry::default();
    let mut buf = [0u8; 2048];

    loop {
        // `biased;` makes branch order *priority* order instead of tokio's
        // default uniform-random pick among ready branches. Writes and their
        // deadline sweep outrank `recv`, which outranks all background polling.
        //
        // This does not starve `recv`: the branches above it are only ready
        // when there is actually a write pending or a timer has elapsed. The
        // polling branches sitting *below* `recv` is the deliberate part —
        // under heavy inbound traffic they yield, which is self-correcting,
        // since our own polling is what generates most of that traffic.
        tokio::select! {
            biased;

            _ = &mut stop_rx => break,

            // Writes are submitted here rather than sent from an ephemeral
            // socket by the calling command, so their ACK echo returns to
            // this long-lived socket and can actually be correlated. Unlike
            // `request_rx`, there is no per-IP exclusivity check: writes are
            // single-datagram and never touch the shared `FragmentReassembler`,
            // and `WriteRegistry` serializes them per device on its own.
            Some(spec) = write_rx.recv() => {
                for t in writes.submit(spec, Instant::now()) {
                    let _ = socket.send_to(&t.packet, (t.ip.as_str(), AMP_PORT)).await;
                }
            }

            Some(spec) = request_rx.recv() => {
                let ip = spec.ip.clone();
                // Same per-IP exclusivity as the config poll tick (below,
                // since writes/requests now outrank polling) — an external caller (e.g.
                // `live_control_fetch_presets`) racing the poll tick must be
                // rejected outright rather than registered, since by the time
                // both are pending it's too late: their responses would already
                // be interleaving in the shared reassembler.
                if registry.conflicts_with(&ip, spec.function_code, spec.expects_fragments) {
                    if let ResultSink::External(tx) = spec.sink {
                        let _ = tx.send(Err(RequestError::Busy));
                    }
                } else {
                    let (packet, superseded) = registry.register(spec, Instant::now());
                    if let Some(resolved) = superseded {
                        deliver_resolved(resolved, &sink);
                    }
                    let _ = socket.send_to(&packet, (ip.as_str(), AMP_PORT)).await;
                }
            }

            _ = deadline_tick.tick() => {
                let now = Instant::now();
                let (resolved, retransmits) = registry.poll_deadlines(now);
                for r in resolved {
                    deliver_resolved(r, &sink);
                }
                for t in retransmits {
                    let _ = socket.send_to(&t.packet, (t.ip.as_str(), AMP_PORT)).await;
                }
                for t in writes.poll_deadlines(now) {
                    let _ = socket.send_to(&t.packet, (t.ip.as_str(), AMP_PORT)).await;
                }
                reassembler.sweep(super::request::FRAGMENT_MAX_AGE_MS);
            }

            recv = socket.recv_from(&mut buf) => {
                if let Ok((len, addr)) = recv {
                    let ip = addr.ip().to_string();
                    let raw = &buf[..len];

                    let Some(nd) = parse_network_data_header(raw) else { continue };
                    if nd.data_flag != NETWORK_DATA_FLAG {
                        continue;
                    }
                    // An inbound ACK is the device confirming one of OUR
                    // datagrams: a bare 10-byte header echo carrying no frame
                    // at all, so it is routed to the write registry and never
                    // reaches reassembly or `handle_single`. Most are for our
                    // heartbeat/discovery/FC=27 queries and match no pending
                    // write — `on_ack` ignores those.
                    if nd.data_state != 0 {
                        // The device ACKs *everything* we send — every 50ms
                        // heartbeat included — so this branch is hot and must
                        // stay cheap and unlogged. `on_ack` is a no-op unless
                        // this device has a write awaiting confirmation.
                        //
                        // Verified on 1.1.8 hardware: these arrive as a bare
                        // 10-byte header with `packets_lastlen = 0`, NOT an
                        // echo of what we sent — which is why `on_ack`
                        // correlates by IP rather than by any header field.
                        for t in writes.on_ack(&ip, Instant::now()) {
                            let _ = socket.send_to(&t.packet, (t.ip.as_str(), AMP_PORT)).await;
                        }
                        continue;
                    }
                    // Stateless per-datagram ACK — not a session handshake.
                    // Must fire before reassembly, for every physical
                    // fragment, not just the logical frame it belongs to.
                    if let Some(ack) = build_ack_packet(raw) {
                        let _ = socket.send_to(&ack, (ip.as_str(), AMP_PORT)).await;
                    }

                    match reassembler.accept(&ip, &nd, raw) {
                        Some(Assembled::Single(raw)) => {
                            // Most request/response FCs (unlike FC=27's always-fragmented
                            // SYNC_DATA) fit in one datagram — feed into the registry first;
                            // on_frame() is a no-op when there's no live pending request for
                            // (ip, fc), so this is safe unconditionally, including for FC=0/6
                            // (never registered via the registry in the first place).
                            if raw.len() >= NETWORK_HEADER_LEN + STRUCT_HEADER_LEN {
                                let inner = &raw[NETWORK_HEADER_LEN..];
                                if validate_frame(inner) {
                                    registry.on_frame(&ip, inner[1], inner.to_vec(), Instant::now());
                                }
                            }
                            if let Some(id) = handle_single(&raw, ip.clone(), &sink, protocol_slug, brand) {
                                stats.entry(id).or_default().record_received();
                            }
                        }
                        Some(Assembled::Multi(inner)) => {
                            if inner.len() >= STRUCT_HEADER_LEN && validate_frame(&inner) {
                                let function_code = inner[1];
                                registry.on_frame(&ip, function_code, inner, Instant::now());
                            } else {
                                eprintln!(
                                    "[cvr driver] assembled Multi frame from {ip} FAILED validate_frame (len={})",
                                    inner.len()
                                );
                            }
                        }
                        None => {} // mid-reassembly, waiting for more fragments
                    }
                }
            }

            _ = config_poll_tick.tick() => {
                // Vendor `isRefresh` interlock — see `WriteRegistry::has_pending`.
                // Skipped outright rather than deferred: the next tick is only
                // 200ms away, and queueing work here would just pile requests
                // up behind the write we are trying to get out cleanly.
                if writes.has_pending() { continue; }
                let targets: Vec<(String, String)> = {
                    let inner = sink.state.lock().unwrap();
                    // Only devices some live consumer has subscribed to (`is_polled`, see
                    // `live_control_set_poll_subscription`), and only while online. Every
                    // other discovered amp gets discovery alone. The online check still
                    // matters for a subscribed amp: `mark_stale_offline` never removes
                    // entries, so an unplugged amp would otherwise keep being polled.
                    // Recovery goes through discovery either way.
                    inner.devices.values().filter(|d| d.online && inner.is_polled(&d.id)).map(|d| (d.id.clone(), d.ip.clone())).collect()
                };
                for (_id, ip) in targets {
                    // FC=27 is fragmented, so it defers to anything already in
                    // flight for this ip (e.g. an on-demand FC=59 fetch): the
                    // shared per-IP FragmentReassembler can't safely interleave
                    // two concurrent multi-fragment exchanges. Just skipped this
                    // cycle — tried again next tick.
                    if registry.conflicts_with(&ip, FC_SYNC_DATA, true) {
                        continue;
                    }
                    let spec = RequestSpec { ip: ip.clone(), function_code: FC_SYNC_DATA, chx: 0, body: Vec::new(), expects_fragments: true, in_out_flag: 0, sink: ResultSink::Internal };
                    let (packet, superseded) = registry.register(spec, Instant::now());
                    if let Some(resolved) = superseded {
                        deliver_resolved(resolved, &sink);
                    }
                    let _ = socket.send_to(&packet, (ip.as_str(), AMP_PORT)).await;
                }
            }

            _ = bridge_poll_tick.tick() => {
                // Still never races a pending write. The per-IP request
                // interlock, though, is now narrow enough to matter: an FC=50
                // reply is a single datagram, so it rides alongside an
                // in-flight FC=27 instead of being skipped by it (see
                // `RequestRegistry::conflicts_with`). That starvation is what
                // used to stretch a two-pair read out to ~5s.
                //
                // Routine poll chatter sits behind `wire_log_enabled()`; only
                // genuine failures still print unconditionally.
                if writes.has_pending() {
                    if wire_log_enabled() {
                        println!("[cvr driver] FC=50 poll skipped: a write is still pending");
                    }
                    continue;
                }
                let now = Instant::now();
                // One pair per subscribed device: a pair nobody has reported
                // yet always wins (priming, every tick), otherwise the
                // device's next pair in turn, and only once its steady-state
                // interval has elapsed. A device with nothing due contributes
                // nothing, so a settled system is as quiet as before.
                let targets: Vec<(String, u8)> = {
                    let inner = sink.state.lock().unwrap();
                    // Only devices some live consumer has subscribed to (`is_polled`, see
                    // `live_control_set_poll_subscription`), and only while online. Every
                    // other discovered amp gets discovery alone. The online check still
                    // matters for a subscribed amp: `mark_stale_offline` never removes
                    // entries, so an unplugged amp would otherwise keep being polled.
                    // Recovery goes through discovery either way.
                    inner
                        .devices
                        .values()
                        .filter(|d| d.online && inner.is_polled(&d.id))
                        .filter_map(|d| {
                            let reported = inner.bridge.get(&d.id);
                            let unknown = (0..BRIDGE_PAIR_COUNT).find(|pair| {
                                reported
                                    .and_then(|b| b.bridged.get(*pair as usize).copied().flatten())
                                    .is_none()
                            });
                            if let Some(pair) = unknown {
                                return Some((d.ip.clone(), pair));
                            }
                            match bridge_cursors.get(&d.ip) {
                                Some(cursor) => (now.saturating_duration_since(cursor.last_sent)
                                    >= BRIDGE_STEADY_INTERVAL)
                                    .then_some((d.ip.clone(), cursor.next_pair)),
                                None => Some((d.ip.clone(), 0)),
                            }
                        })
                        .collect()
                };
                for (ip, pair) in targets {
                    // Only another FC=50 for this device can conflict now.
                    if registry.conflicts_with(&ip, FC_BRIDGE, false) {
                        if wire_log_enabled() {
                            println!("[cvr driver] FC=50 poll to {ip} (pair {pair}) skipped: another FC=50 is in flight");
                        }
                        continue;
                    }
                    let spec = RequestSpec {
                        ip: ip.clone(),
                        function_code: FC_BRIDGE,
                        chx: pair,
                        body: Vec::new(),
                        // A one-byte body — never fragmented.
                        expects_fragments: false,
                        in_out_flag: 0,
                        sink: ResultSink::Internal,
                    };
                    let (packet, superseded) = registry.register(spec, now);
                    if let Some(resolved) = superseded {
                        deliver_resolved(resolved, &sink);
                    }
                    match socket.send_to(&packet, (ip.as_str(), AMP_PORT)).await {
                        Ok(n) => {
                            if wire_log_enabled() {
                                println!("[cvr driver] FC=50 poll -> {ip} pair {pair} ({n} bytes sent)");
                            }
                            // Advanced only once a request actually goes out,
                            // so a skipped pair keeps its turn instead of
                            // being starved.
                            let cursor = bridge_cursors
                                .entry(ip.clone())
                                .or_insert(BridgeCursor { next_pair: 0, last_sent: now });
                            cursor.next_pair = (pair + 1) % BRIDGE_PAIR_COUNT;
                            cursor.last_sent = now;
                        }
                        // A send that fails outright is a real fault, not
                        // routine — always surfaced.
                        Err(e) => eprintln!("[cvr driver] FC=50 poll -> {ip} pair {pair} FAILED to send: {e}"),
                    }
                }
            }

            _ = heartbeat_tick.tick() => {
                // Vendor `isRefresh` interlock — see `WriteRegistry::has_pending`.
                if writes.has_pending() { continue; }
                let targets: Vec<(String, String)> = {
                    let inner = sink.state.lock().unwrap();
                    // Subscribed + online only — see the config poll above. Matters most
                    // here: at 50ms this is 20 packets/s per amp it reaches.
                    inner.devices.values().filter(|d| d.online && inner.is_polled(&d.id)).map(|d| (d.id.clone(), d.ip.clone())).collect()
                };
                let query = build_heartbeat_query();
                for (id, ip) in targets {
                    let _ = socket.send_to(&query, (ip.as_str(), AMP_PORT)).await;
                    stats.entry(id).or_default().sent += 1;
                }
            }

            _ = discovery_tick.tick() => {
                // Vendor `isRefresh` interlock — see `WriteRegistry::has_pending`.
                // `mark_stale_offline` is deliberately inside the gate too: we
                // cannot judge liveness while we are choosing not to poll, and
                // ageing devices out on evidence we suppressed would mark every
                // amp offline after OFFLINE_TIMEOUT_MS during a long write burst.
                if writes.has_pending() { continue; }
                let now = Instant::now();
                let since_last = now.saturating_duration_since(last_discovery_at);
                last_discovery_at = now;

                let query = build_basic_info_query();
                for addr in directed_broadcast_addresses() {
                    let _ = socket.send_to(&query, (addr, AMP_PORT)).await;
                }

                // The gate above can hold this arm off for a long stretch (a
                // fader drag keeps a write pending almost continuously), and
                // heartbeats are gated with it, so every device's
                // `last_seen_at` goes stale while nobody is being asked
                // anything. Sweeping on that silence would mark the whole rig
                // offline the moment a drag ends. So after a suppressed
                // stretch, skip one sweep and let this broadcast's replies —
                // which arrive in milliseconds — refresh liveness first.
                //
                // This matters far more at a 4s timeout than it did at 12s:
                // four seconds of continuous writing is an ordinary drag.
                if since_last <= DISCOVERY_INTERVAL * 2 {
                    sink.mark_stale_offline(OFFLINE_TIMEOUT_MS);
                }
            }

            _ = stats_tick.tick() => {
                // Per-device link quality, once a second. Gated behind
                // `AMPCORE_WIRE_LOG` like the rest of the routine wire chatter —
                // it printed unconditionally and drowned out real errors. The
                // window is still reset when logging is off, so enabling the
                // env var never reports an accumulated backlog.
                if !wire_log_enabled() {
                    for s in stats.values_mut() {
                        s.reset_window();
                    }
                    continue;
                }
                for (id, s) in stats.iter_mut() {
                    if s.sent == 0 {
                        continue;
                    }
                    let lost = s.sent.saturating_sub(s.received);
                    let loss_pct = lost as f64 / s.sent as f64 * 100.0;
                    println!(
                        "[cvr driver] {id}: sent={} recv={} lost={} ({loss_pct:.1}%) avg={:.1}ms jitter={:.1}ms",
                        s.sent,
                        s.received,
                        lost,
                        s.mean_interval_ms(),
                        s.jitter_ms()
                    );
                    s.reset_window();
                }
            }

        }
    }
    Ok(())
}

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
fn log_sync_body_diff(ip: &str, body: &[u8]) {
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
    match channel_config::parse_channel_config(device.firmware_family.as_deref(), body) {
        Some(cfg) => {
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
fn deliver_resolved(resolved: super::request::ResolvedRequest, sink: &LiveEventSink) {
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
                        match super::bridge::parse_bridge_reply(&frame) {
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
                    Err(RequestError::ShapeMismatch(len)) => {
                        eprintln!("[cvr driver] FC=50 reply from {} had an implausible shape ({len} bytes)", resolved.ip)
                    }
                    Err(RequestError::Busy) => {
                        if wire_log_enabled() {
                            println!("[cvr driver] FC=50 request to {} was rejected as busy", resolved.ip);
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
                Err(RequestError::ShapeMismatch(len)) => {
                    eprintln!("[cvr driver] FC=27 response from {} had an implausible shape ({len} bytes)", resolved.ip);
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
fn handle_single(raw: &[u8], ip: String, sink: &LiveEventSink, protocol_slug: &'static str, brand: &'static str) -> Option<String> {
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
            // (telemetry_v118/telemetry_v119) by the family already detected
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
