use std::collections::{BTreeMap, HashMap};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::sync::{mpsc, oneshot};

use crate::data::amp_model::AmpProtocol;
use crate::data::capability::cvr::{amp_gain_range_db, amp_gain_v118_db, amp_sensitivity_v, rated_rms_voltage_from_firmware_string};
use crate::data::common::now_millis;
use crate::live::dsp::voltage_to_db;
use crate::live::state::{DiscoveredDevice, DriverHandle, LiveEventSink};

use super::channel_config;
use super::channel_state;
use super::protocol::*;
use super::bridge::{BRIDGE_PAIR_COUNT, FC_BRIDGE};
use super::fir::{build_fir_request_body, parse_fir_data, FC_FIR_DATA, FIR_IN_OUT_FLAG};
use super::request::{
    Assembled, FragmentReassembler, RequestError, RequestRegistry, RequestSpec, ResultSink, WriteRegistry, WriteSpec,
};
use super::telemetry;

mod sockets;
mod stats;
mod inbound;
use sockets::*;
use stats::*;
pub use inbound::*;

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

/// An output's FIR filter is hashed into the amp's fingerprint but isn't in
/// FC=27, so the config-poll arm reads it with FC=43, one output per device
/// at a time, in place of that cycle's FC=27. An output with no reading goes
/// first, at most every `FIR_PRIME_INTERVAL` — so FC=27 keeps at least every
/// other cycle even against an amp that never answers FC=43. Once every
/// output is known they are re-read in rotation, one per
/// `FIR_STEADY_INTERVAL`: a filter changed by another tool shows up within
/// `output_channels × 2 s`, for the price of one settings poll in ten.
const FIR_PRIME_INTERVAL: Duration = Duration::from_millis(400);

const FIR_STEADY_INTERVAL: Duration = Duration::from_millis(2000);

/// Whether background polling has to stay off the wire right now: a write is
/// awaiting its ACK (the vendor `isRefresh` interlock — see
/// `WriteRegistry::has_pending`), or a multi-packet operation is holding
/// polls across its whole length (`LiveDeviceState::hold_polls`).
fn polls_blocked(writes: &WriteRegistry, sink: &LiveEventSink) -> bool {
    writes.has_pending() || sink.state.lock().unwrap().polls_held > 0
}

/// Per-device FC=43 poll state, keyed by IP — `BridgeCursor`'s twin.
struct FirCursor {
    next_channel: u32,
    last_sent: Instant,
}

/// Binds the driver's sockets, spawns the CVR driver task on `runtime` and
/// returns immediately. The first bind happens here rather than in the task, so
/// `LiveDeviceState::start` can report it; the task retries whatever failed.
///
/// `runtime` is threaded in explicitly (rather than calling `tokio::spawn`)
/// because this is called from a synchronous command handler that isn't
/// itself running inside a tokio task — bare `tokio::spawn` would panic with
/// "no reactor running". Locks `sink.state`, so the caller must not hold it.
pub fn start(sink: LiveEventSink, runtime: &tokio::runtime::Handle) -> DriverHandle {
    let (stop_tx, stop_rx) = oneshot::channel();
    let (request_tx, request_rx) = mpsc::unbounded_channel();
    let (write_tx, write_rx) = mpsc::unbounded_channel();
    let (inbound, inbound_rx) = mpsc::unbounded_channel();
    let mut net = AdapterSockets { open: BTreeMap::new(), routes: HashMap::new(), inbound };
    {
        let mut inner = sink.state.lock().unwrap();
        let _context = runtime.enter();
        inner.socket_error = net.reconcile(inner.adapter.as_deref());
        inner.request_tx = Some(request_tx);
        inner.write_tx = Some(write_tx);
    }
    runtime.spawn(async move {
        if let Err(e) = run(net, inbound_rx, sink, stop_rx, request_rx, write_rx, AmpProtocol::CvrUdp.slug(), "CVR").await {
            eprintln!("[cvr driver] exited with error: {e}");
        }
    });
    DriverHandle { stop_tx }
}

// ponytail: one ~420-line select loop, left whole because it is live UDP I/O
// with no tests; split its tick arms into functions when one next changes.
#[allow(clippy::too_many_arguments)]
async fn run(
    mut net: AdapterSockets,
    mut inbound_rx: mpsc::UnboundedReceiver<Inbound>,
    sink: LiveEventSink,
    mut stop_rx: oneshot::Receiver<()>,
    mut request_rx: mpsc::UnboundedReceiver<RequestSpec>,
    mut write_rx: mpsc::UnboundedReceiver<WriteSpec>,
    protocol_slug: &'static str,
    brand: &'static str,
) -> std::io::Result<()> {
    let mut discovery_tick = tokio::time::interval(DISCOVERY_INTERVAL);
    let mut heartbeat_tick = tokio::time::interval(HEARTBEAT_INTERVAL);
    let mut stats_tick = tokio::time::interval(STATS_INTERVAL);
    let mut config_poll_tick = tokio::time::interval(CONFIG_POLL_INTERVAL);
    let mut bridge_poll_tick = tokio::time::interval(BRIDGE_PRIME_INTERVAL);
    // FC=50 addresses one pair per request and the request registry keys by
    // `(ip, function_code)`, so both pairs of a device cannot be in flight at
    // once — hence one pair per tick per device, tracked here.
    let mut bridge_cursors: HashMap<String, BridgeCursor> = HashMap::new();
    let mut fir_cursors: HashMap<String, FirCursor> = HashMap::new();
    let mut deadline_tick = tokio::time::interval(DEADLINE_TICK_INTERVAL);
    // When the discovery arm last actually ran. A write burst gates it off
    // entirely, and the liveness sweep must not count silence from a stretch
    // where nobody was asked — see the discovery arm below.
    let mut last_discovery_at = Instant::now();
    let mut stats: HashMap<String, DeviceStats> = HashMap::new();
    let mut reassembler = FragmentReassembler::default();
    let mut registry = RequestRegistry::default();
    let mut writes = WriteRegistry::default();

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
                    let _ = net.send(&t.packet, t.ip.as_str()).await;
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
                    let _ = net.send(&packet, ip.as_str()).await;
                }
            }

            _ = deadline_tick.tick() => {
                let now = Instant::now();
                let (resolved, retransmits) = registry.poll_deadlines(now);
                for r in resolved {
                    deliver_resolved(r, &sink);
                }
                for t in retransmits {
                    let _ = net.send(&t.packet, t.ip.as_str()).await;
                }
                for t in writes.poll_deadlines(now) {
                    let _ = net.send(&t.packet, t.ip.as_str()).await;
                }
                reassembler.sweep(super::request::FRAGMENT_MAX_AGE_MS);
            }

            recv = inbound_rx.recv() => {
                if let Some((local, addr, data)) = recv {
                    let ip = addr.ip().to_string();
                    net.routes.insert(ip.clone(), local);
                    let raw = &data[..];

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
                        // Verified on hardware: these arrive as a bare 10-byte
                        // header, NOT an echo of what we sent, and its
                        // `packets_count/lastlen` differ by firmware (1.1.8
                        // `1/0`, 1.1.9 `0/450`) — which is why `on_ack`
                        // correlates by IP rather than by any header field.
                        for t in writes.on_ack(&ip, Instant::now()) {
                            let _ = net.send(&t.packet, t.ip.as_str()).await;
                        }
                        continue;
                    }
                    // Stateless per-datagram ACK — not a session handshake.
                    // Must fire before reassembly, for every physical
                    // fragment, not just the logical frame it belongs to.
                    if let Some(ack) = build_ack_packet(raw) {
                        let _ = net.send(&ack, ip.as_str()).await;
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
                if polls_blocked(&writes, &sink) { continue; }
                let now = Instant::now();
                // Each device with the FIR output due this cycle, if any: one
                // nobody has read yet (or that was dropped after a write)
                // first, otherwise the next in rotation once its interval has
                // elapsed. See `FIR_STEADY_INTERVAL`.
                let targets: Vec<(String, Option<u8>)> = {
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
                        .map(|d| {
                            let since = fir_cursors.get(&d.ip).map(|c| now.saturating_duration_since(c.last_sent));
                            let known = inner.fir.get(&d.id);
                            let unread = (0..d.output_channels).find(|ch| !known.is_some_and(|k| k.contains_key(ch)));
                            let due = match unread {
                                Some(channel) => since.map_or(true, |s| s >= FIR_PRIME_INTERVAL).then_some(channel),
                                None => since.map_or(true, |s| s >= FIR_STEADY_INTERVAL).then(|| {
                                    fir_cursors.get(&d.ip).map_or(0, |c| c.next_channel) % d.output_channels.max(1)
                                }),
                            };
                            let due = due.filter(|_| is_known_family(d.firmware_family.as_deref()));
                            (d.ip.clone(), due.and_then(|channel| u8::try_from(channel).ok()))
                        })
                        .collect()
                };
                for (ip, fir_due) in targets {
                    // Both reads are fragmented, so they defer to anything
                    // already in flight for this ip (e.g. an on-demand FC=59
                    // fetch): the shared per-IP FragmentReassembler can't
                    // safely interleave two concurrent multi-fragment
                    // exchanges. Just skipped this cycle — tried again next
                    // tick.
                    if registry.conflicts_with(&ip, FC_SYNC_DATA, true) {
                        continue;
                    }
                    let spec = match fir_due {
                        // The FIR read takes this cycle's turn *instead of*
                        // FC=27 rather than racing it on a tick of its own:
                        // FC=27 is in flight most of the time, and a second
                        // fragmented read would simply never find the line
                        // clear — the starvation FC=50 once had.
                        Some(channel) => {
                            fir_cursors.insert(ip.clone(), FirCursor { next_channel: u32::from(channel) + 1, last_sent: now });
                            RequestSpec {
                                ip: ip.clone(),
                                function_code: FC_FIR_DATA,
                                chx: channel,
                                body: build_fir_request_body(),
                                expects_fragments: true,
                                in_out_flag: FIR_IN_OUT_FLAG,
                                sink: ResultSink::Internal,
                            }
                        }
                        None => RequestSpec { ip: ip.clone(), function_code: FC_SYNC_DATA, chx: 0, body: Vec::new(), expects_fragments: true, in_out_flag: 0, sink: ResultSink::Internal },
                    };
                    let (packet, superseded) = registry.register(spec, Instant::now());
                    if let Some(resolved) = superseded {
                        deliver_resolved(resolved, &sink);
                    }
                    let _ = net.send(&packet, ip.as_str()).await;
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
                if polls_blocked(&writes, &sink) {
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
                    match net.send(&packet, ip.as_str()).await {
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
                if polls_blocked(&writes, &sink) { continue; }
                let targets: Vec<(String, String)> = {
                    let inner = sink.state.lock().unwrap();
                    // Subscribed + online only — see the config poll above. Matters most
                    // here: at 50ms this is 20 packets/s per amp it reaches.
                    inner.devices.values().filter(|d| d.online && inner.is_polled(&d.id)).map(|d| (d.id.clone(), d.ip.clone())).collect()
                };
                let query = build_heartbeat_query();
                for (id, ip) in targets {
                    let _ = net.send(&query, ip.as_str()).await;
                    stats.entry(id).or_default().sent += 1;
                }
            }

            _ = discovery_tick.tick() => {
                {
                    let mut inner = sink.state.lock().unwrap();
                    inner.socket_error = net.reconcile(inner.adapter.as_deref());
                }
                // Vendor `isRefresh` interlock — see `WriteRegistry::has_pending`.
                // `mark_stale_offline` is deliberately inside the gate too: we
                // cannot judge liveness while we are choosing not to poll, and
                // ageing devices out on evidence we suppressed would mark every
                // amp offline after OFFLINE_TIMEOUT_MS during a long write burst.
                if polls_blocked(&writes, &sink) { continue; }
                let now = Instant::now();
                let since_last = now.saturating_duration_since(last_discovery_at);
                last_discovery_at = now;

                let query = build_basic_info_query();
                net.broadcast(&query).await;

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
