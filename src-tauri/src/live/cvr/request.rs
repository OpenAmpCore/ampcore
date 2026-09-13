//! General-purpose UDP request/response primitive for the CVR protocol:
//! inbound multi-fragment reassembly, a pending-request registry with
//! per-request correlation, and settle-timer + hard-timeout + retry
//! mechanics. Built for FC=27 (SYNC_DATA)'s bulk multi-frame response, but
//! deliberately not FC=27-specific — any future one-shot request/response
//! FC degenerates to the same primitive (one frame arrives, the settle timer
//! elapses with no follow-up, it resolves).
//!
//! The reference implementation has the same frames+settle-timer shape but
//! keys pending requests only by `(ip, function_code)` with no per-request
//! correlation — a stale reply from an already-timed-out request can be
//! misattributed to a newer request for the same key. This module fixes
//! that with a monotonic generation counter per key (see `RequestRegistry`).
//!
//! The second half of this file is the *write* counterpart, `WriteRegistry`
//! — a separate, much simpler engine built on the protocol's transport-level
//! ACK (`NetworkDataHeader.data_state`) rather than on function-code replies.
//! The two are independent: a request correlates a full response frame by
//! `(ip, function_code)`, whereas a write only ever gets back a bare 10-byte
//! header carrying no identifying field at all, so it correlates by device IP
//! under strict stop-and-wait. See `WriteRegistry::on_ack`.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

use crate::data::common::now_millis;

use super::protocol::{FC_SYNC_DATA, NETWORK_HEADER_LEN};

pub const REQUEST_TIMEOUT_MS: u64 = 2000;
pub const REQUEST_RETRY_TIMEOUT_MS: u64 = 2200;
pub const SETTLE_MS: u64 = 20;
pub const MAX_RETRIES: u8 = 1;
/// Half-assembled fragment sets older than this are dropped — a lost
/// fragment must not wedge a source IP's reassembly state forever.
pub const FRAGMENT_MAX_AGE_MS: f64 = 3_000.0;

#[derive(Debug)]
pub enum RequestError {
    Timeout,
    /// The concatenated response didn't match any plausible shape for its
    /// function code (see `RequestRegistry::resolve`'s FC=27 check) — a real
    /// surfaced error, never silently handed to a byte parser as if valid.
    ShapeMismatch(usize),
    /// Another request was already pending for this IP (any function code)
    /// when this one was submitted — rejected before ever registering it.
    /// Necessary because `FragmentReassembler`'s `by_ip` map (see below) has
    /// no per-function-code or per-request correlation id to key on — the
    /// wire's `NetworkDataHeader` doesn't carry one at the individual
    /// fragment level — so two concurrent multi-fragment response streams
    /// from the same IP (e.g. the FC=27 poll tick and an on-demand FC=59
    /// fetch racing each other) would silently interleave into one garbled
    /// buffer instead of failing loudly. Retriable — the caller should back
    /// off briefly and try again once the other exchange has resolved.
    Busy,
}

/// Where a resolved request's result goes. `Internal` is what the driver's
/// own FC=27 poll tick uses — handled synchronously, inline, in the same
/// loop iteration that discovers the resolution (no channel, no await:
/// parsing ~2.5KB of already-in-memory bytes is not actually async work).
/// `External` is for a future Tauri command reaching in from outside the
/// driver's task — fire-and-forget `send` on the oneshot; the command's own
/// async task is what awaits the `Receiver`, not the driver loop.
pub enum ResultSink {
    Internal,
    External(oneshot::Sender<Result<Vec<u8>, RequestError>>),
}

pub struct RequestSpec {
    pub ip: String,
    pub function_code: u8,
    /// StructHeader `chx`. Zero for whole-device queries (FC=27, FC=59),
    /// but FC=50 addresses one bridgeable *pair* per request, so the field
    /// has to reach `build_protocol_packet` rather than being hardcoded.
    ///
    /// Note the registry still keys pending requests by `(ip,
    /// function_code)` alone, so two requests differing only in `chx` cannot
    /// be in flight at once — callers that need several (the driver's bridge
    /// poll) issue them across successive ticks instead.
    pub chx: u8,
    pub body: Vec<u8>,
    /// Whether this function code's reply arrives as several fragments —
    /// true for FC=27 (always fragmented) and FC=59, false for a
    /// single-datagram reply like FC=50's one-byte body.
    ///
    /// This is what `conflicts_with` gates on. Only a fragmented exchange
    /// needs the per-IP `FragmentReassembler`, so only those wait for a clear
    /// line; a single-datagram request rides alongside one safely
    /// (`FragmentReassembler::accept` returns `Single` without ever touching
    /// its `by_ip` state). **Default to `true` for a new function code**:
    /// wrongly exclusive only costs latency, wrongly concurrent garbles a
    /// reassembly buffer.
    pub expects_fragments: bool,
    /// StructHeader `in_out_flag` (0 = input side, 1 = output side). Every
    /// read this app made before FIR was input-side, which is why
    /// `build_protocol_packet` hardcoded it to 0 — but FC=43 FIR_datas is an
    /// output-channel query and the vendor sends it with 1
    /// (`Mypages/FIRPage.xaml.cs:434`), so it has to reach the packet builder.
    /// Leave 0 for anything whose vendor call site doesn't set it.
    pub in_out_flag: u8,
    pub sink: ResultSink,
}

struct PendingRequest {
    generation: u64,
    /// Retained verbatim so `poll_deadlines`' retransmit rebuilds the *same*
    /// packet. It used to hardcode `chx = 0`, which silently retried FC=50
    /// pair 1 as pair 0 — and would have retried every per-channel FC=43 FIR
    /// read as channel A.
    chx: u8,
    in_out_flag: u8,
    body: Vec<u8>,
    frames: Vec<Vec<u8>>,
    hard_deadline: Instant,
    settle_deadline: Option<Instant>,
    retries_left: u8,
    sink: ResultSink,
}

pub struct ResolvedRequest {
    pub ip: String,
    pub function_code: u8,
    pub result: Result<Vec<u8>, RequestError>,
    pub sink: ResultSink,
}

/// Bytes to (re)send for a request still awaiting its reply — returned by
/// `register`/`poll_deadlines` so the driver loop does the actual
/// `socket.send_to`, keeping this module free of any I/O.
pub struct Transmit {
    pub ip: String,
    pub packet: Vec<u8>,
}

#[derive(Default)]
pub struct RequestRegistry {
    generations: HashMap<(String, u8), u64>,
    pending: HashMap<(String, u8), PendingRequest>,
}

impl RequestRegistry {
    /// Whether registering this request now would clash with something
    /// already in flight for the same ip. The driver calls this before
    /// registering anything; a clash is reported to external callers as
    /// `RequestError::Busy`.
    ///
    /// Two ways to clash:
    /// - the same `(ip, function_code)` is already pending — `pending` holds
    ///   at most one entry per key, so a second would supersede the first; or
    /// - the new request expects fragments and anything at all is in flight
    ///   for that ip.
    ///
    /// The second is the real constraint, and it is deliberately one-sided.
    /// The per-IP `FragmentReassembler` cannot interleave two multi-fragment
    /// exchanges, so a *fragmented* request waits for a clear line. It is
    /// indifferent to a single-datagram reply, which `accept()` returns as
    /// `Single` without ever touching per-IP state — so a *single-datagram*
    /// request goes out even while a fragmented one is mid-flight. That is
    /// what stops the 200ms FC=27 poll starving FC=50 bridge reads, which it
    /// used to do for seconds at a time.
    pub fn conflicts_with(&self, ip: &str, function_code: u8, expects_fragments: bool) -> bool {
        self.pending
            .keys()
            .any(|(pending_ip, pending_fc)| pending_ip == ip && (*pending_fc == function_code || expects_fragments))
    }

    /// Registers a new request, bumping the `(ip, fc)` generation counter.
    /// Returns the outbound packet to send plus, if a *different* request
    /// was already pending for this key (shouldn't happen given callers
    /// check `has_pending` first, but guarded regardless), that superseded
    /// request resolved as a failure.
    pub fn register(&mut self, spec: RequestSpec, now: Instant) -> (Vec<u8>, Option<ResolvedRequest>) {
        let key = (spec.ip.clone(), spec.function_code);
        let generation = self.generations.entry(key.clone()).and_modify(|g| *g += 1).or_insert(1);
        let generation = *generation;

        let packet = build_request_packet(spec.function_code, spec.chx, spec.in_out_flag, &spec.body);

        let superseded = self.pending.remove(&key).map(|old| ResolvedRequest {
            ip: key.0.clone(),
            function_code: key.1,
            result: Err(RequestError::Timeout),
            sink: old.sink,
        });

        self.pending.insert(
            key,
            PendingRequest {
                generation,
                chx: spec.chx,
                in_out_flag: spec.in_out_flag,
                body: spec.body,
                frames: Vec::new(),
                hard_deadline: now + Duration::from_millis(REQUEST_TIMEOUT_MS),
                settle_deadline: None,
                retries_left: MAX_RETRIES,
                sink: spec.sink,
            },
        );

        (packet, superseded)
    }

    /// Feeds one already-reassembled logical frame (StructHeader+body+
    /// checksum, i.e. `Assembled::Multi`) into the matching pending request,
    /// if any. A frame that doesn't match a *live* (current-generation)
    /// pending entry — because there is no pending request for this `(ip,
    /// fc)`, or because the one that used to be there already resolved or
    /// timed out and moved to a new generation — is silently discarded. This
    /// is the concrete fix for the reference implementation's stale-frame
    /// misattribution bug: since `pending` holds at most one entry per key
    /// and every entry is tagged with the generation active when it was
    /// registered, a late frame from an old, already-removed entry can never
    /// land in a newer one.
    pub fn on_frame(&mut self, ip: &str, function_code: u8, frame: Vec<u8>, now: Instant) {
        let key = (ip.to_string(), function_code);
        let Some(current_gen) = self.generations.get(&key) else { return };
        let Some(pending) = self.pending.get_mut(&key) else { return };
        if pending.generation != *current_gen {
            return;
        }
        pending.frames.push(frame);
        pending.settle_deadline = Some(now + Duration::from_millis(SETTLE_MS));
    }

    /// Drives settle/timeout/retry for every pending request. Returns
    /// resolved requests (to be delivered via their `sink`) and any packets
    /// that need retransmitting. Never blocks, never awaits anything —
    /// purely a synchronous sweep over in-memory state.
    pub fn poll_deadlines(&mut self, now: Instant) -> (Vec<ResolvedRequest>, Vec<Transmit>) {
        let mut resolved = Vec::new();
        let mut retransmits = Vec::new();
        let mut done_keys = Vec::new();

        for (key, pending) in self.pending.iter_mut() {
            if let Some(settle_deadline) = pending.settle_deadline {
                if now >= settle_deadline {
                    done_keys.push(key.clone());
                    continue;
                }
            }
            if now >= pending.hard_deadline {
                if pending.retries_left > 0 {
                    pending.retries_left -= 1;
                    pending.hard_deadline = now + Duration::from_millis(REQUEST_RETRY_TIMEOUT_MS);
                    pending.frames.clear();
                    pending.settle_deadline = None;
                    let packet = build_request_packet(key.1, pending.chx, pending.in_out_flag, &pending.body);
                    retransmits.push(Transmit { ip: key.0.clone(), packet });
                } else {
                    done_keys.push(key.clone());
                }
            }
        }

        for key in done_keys {
            let Some(pending) = self.pending.remove(&key) else { continue };
            let (ip, function_code) = key;
            // Reached "done" either via the settle timer firing after at
            // least one frame arrived (resolve it), or via the hard deadline
            // with retries exhausted and nothing ever arrived (timeout).
            let result =
                if pending.frames.is_empty() { Err(RequestError::Timeout) } else { resolve_frames(function_code, pending.frames) };
            resolved.push(ResolvedRequest { ip, function_code, result, sink: pending.sink });
        }

        (resolved, retransmits)
    }
}

/// One query packet: `status = 2` (`Responsed::Request`), `segment = 0`,
/// `link = 0`. Identical bytes to the `build_protocol_packet` this replaced
/// whenever `in_out_flag` is 0 — which is every read but FC=43 — so FC=27,
/// FC=50 and FC=59 are unchanged on the wire.
fn build_request_packet(function_code: u8, chx: u8, in_out_flag: u8, body: &[u8]) -> Vec<u8> {
    super::protocol::build_control_packet_with_status(function_code, 2, chx, 0, 0, in_out_flag, body)
}

/// Concatenates accumulated frames and, for FC=27 specifically, sanity-checks
/// the result's shape before accepting it — a mismatch becomes a real
/// surfaced error rather than silently corrupt data handed to the channel
/// parser. Other function codes have no known fixed shape to check against
/// (they degenerate to "whatever came back"), so they pass through as-is.
fn resolve_frames(function_code: u8, frames: Vec<Vec<u8>>) -> Result<Vec<u8>, RequestError> {
    let body: Vec<u8> = frames.into_iter().flatten().collect();
    if function_code == FC_SYNC_DATA {
        use super::channel_config_v118::{BYTES_PER_CHANNEL, TRAILER_SIZE_V118};
        // The frame here still includes StructHeader+checksum; the pure
        // per-channel body starts after StructHeader (10) and ends before
        // the checksum (3) — see channel_config.rs's slicing convention.
        //
        // This check is 1.1.8-shaped (imports its constants directly) even
        // though `resolve_frames` itself is firmware-agnostic — there's no
        // other known-good shape to validate against yet (1.1.9 has none;
        // see `channel_config_v119.rs`). Revisit if/when a second firmware's
        // real geometry is confirmed.
        let inner_len = body.len().saturating_sub(super::protocol::STRUCT_HEADER_LEN + super::protocol::CHECKSUM_LEN);
        let plausible = inner_len >= TRAILER_SIZE_V118
            && (inner_len - TRAILER_SIZE_V118) % BYTES_PER_CHANNEL == 0
            && (1..=4).contains(&((inner_len - TRAILER_SIZE_V118) / BYTES_PER_CHANNEL));
        if !plausible {
            return Err(RequestError::ShapeMismatch(body.len()));
        }
    }
    Ok(body)
}

struct FragmentState {
    packets_count: u8,
    received: HashMap<u8, Vec<u8>>,
    first_seen_at: f64,
}

/// What one reassembled logical frame looks like, depending on whether real
/// multi-datagram reassembly happened.
pub enum Assembled {
    /// `packets_count <= 1` — the ORIGINAL full datagram, byte-for-byte
    /// unchanged. Existing FC=0/FC=6 dispatch keeps consuming this exactly
    /// as it does today; nothing about those code paths changes.
    Single(Vec<u8>),
    /// Genuine multi-fragment reassembly — the concatenated inner frame
    /// (StructHeader + body + checksum, i.e. the same shape as today's
    /// `assembled = &raw[NETWORK_HEADER_LEN..]`), for FC=27 handling.
    Multi(Vec<u8>),
}

#[derive(Default)]
pub struct FragmentReassembler {
    by_ip: HashMap<String, FragmentState>,
}

impl FragmentReassembler {
    pub fn accept(&mut self, ip: &str, nd: &super::protocol::NetworkDataHeader, raw_datagram: &[u8]) -> Option<Assembled> {
        if nd.packets_count <= 1 {
            return Some(Assembled::Single(raw_datagram.to_vec()));
        }
        if raw_datagram.len() < NETWORK_HEADER_LEN {
            return None;
        }
        let inner = raw_datagram[NETWORK_HEADER_LEN..].to_vec();

        let state = self.by_ip.entry(ip.to_string()).or_insert_with(|| FragmentState {
            packets_count: nd.packets_count,
            received: HashMap::new(),
            first_seen_at: now_millis(),
        });
        // A fragment set for a different packets_count arriving mid-assembly
        // means the previous one was abandoned (lost fragments) — restart.
        if state.packets_count != nd.packets_count {
            *state =
                FragmentState { packets_count: nd.packets_count, received: HashMap::new(), first_seen_at: now_millis() };
        }
        state.received.insert(nd.packets_step, inner);

        if state.received.len() < nd.packets_count as usize {
            return None;
        }

        let state = self.by_ip.remove(ip)?;
        let mut steps: Vec<u8> = state.received.keys().copied().collect();
        steps.sort_unstable();
        let assembled: Vec<u8> = steps.into_iter().flat_map(|step| state.received[&step].clone()).collect();
        Some(Assembled::Multi(assembled))
    }

    /// Drops half-assembled fragment sets older than `max_age_ms` — call
    /// periodically (the driver's `deadline_tick` branch) so a lost fragment
    /// can't wedge an IP's reassembly state forever.
    pub fn sweep(&mut self, max_age_ms: f64) {
        let now = now_millis();
        self.by_ip.retain(|_, state| now - state.first_seen_at <= max_age_ms);
    }
}

// ---------------------------------------------------------------------------
// Write ACK confirmation
// ---------------------------------------------------------------------------

/// How long to wait for a write's ACK echo before refiring. Deliberately
/// tighter than the vendor reference's `UDP_tool.outTime(1.0, ip)` 1s budget:
/// on the LAN this app targets, an ACK round trip is single-digit
/// milliseconds, so 1s spends almost all of its time waiting on a packet that
/// is already lost. Trading that for more, faster refires recovers a dropped
/// write sooner and keeps the worst case well under the old single timeout.
pub const WRITE_ACK_TIMEOUT_MS: u64 = 200;
/// Retransmissions after the initial send before a write is failed — so
/// 6 transmissions total, and a worst case of
/// `(1 + WRITE_MAX_REFIRES) * WRITE_ACK_TIMEOUT_MS` = 1.2s before the caller
/// sees an error (versus 3s for the reference's 3-attempt/1s loop).
pub const WRITE_MAX_REFIRES: u8 = 5;
/// Upper bound on writes queued behind the in-flight one for a single device.
/// Only reachable when a device stops ACKing (each write then costs the full
/// 1.2s above) while the UI keeps producing them — a fader drag against an
/// amp that just went offline. The *oldest* queued write is dropped rather
/// than the newest, so the final position of a drag is the one that survives.
pub const WRITE_QUEUE_MAX: usize = 64;

#[derive(Debug)]
pub enum WriteError {
    /// The device never echoed this write's NetworkData header back with
    /// `data_state = 1`, across the initial send and all `WRITE_MAX_REFIRES`
    /// refires.
    Timeout,
    /// Dropped from an over-long per-device queue (see `WRITE_QUEUE_MAX`) —
    /// superseded by newer writes that were still waiting behind it.
    Backlogged,
    /// The driver task stopped while this write was queued or in flight.
    DriverStopped,
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::Timeout => write!(
                f,
                "device did not acknowledge the write after {} attempts ({WRITE_ACK_TIMEOUT_MS}ms each)",
                write_max_attempts()
            ),
            WriteError::Backlogged => {
                write!(f, "write dropped — more than {WRITE_QUEUE_MAX} writes were queued for this device")
            }
            WriteError::DriverStopped => write!(f, "live control stopped before the write was acknowledged"),
        }
    }
}

/// What a successful write reports back. `attempts` counts transmissions,
/// so 1 means it was ACKed on the first send and anything higher means that
/// many refires were needed — a direct read on how lossy the link is, which
/// is otherwise invisible once the retry succeeds.
///
/// `attempts == 0` is the *coalesced* sentinel: this write never went on the
/// wire because a newer write to the same parameter replaced it while it was
/// still queued (see `WriteRegistry::submit`). It is reported as success
/// because the caller's intent — "this parameter now holds this value" — is
/// satisfied by the packet that superseded it, and surfacing an error would
/// make the UI toast a failure for a write it deliberately discarded. The
/// honest caveat: if that *replacement* later fails, this caller has already
/// been told `Ok`.
#[derive(Debug, Clone, Copy)]
pub struct WriteOutcome {
    pub attempts: u8,
    pub elapsed_ms: u64,
}

/// Transmissions a write gets in total: the initial send plus every refire.
pub const fn write_max_attempts() -> u8 {
    WRITE_MAX_REFIRES + 1
}

pub struct WriteSpec {
    pub ip: String,
    pub packet: Vec<u8>,
    /// `false` for a packet that is *itself* an ACK (`data_state = 1`) —
    /// today only `write::CROSSOVER_COMMIT_PACKET`. Neither side ACKs an ACK
    /// (that would loop forever), so such a packet is sent in queue order and
    /// resolved `Ok` the moment it goes out, never waited on.
    pub expect_ack: bool,
    pub tx: oneshot::Sender<Result<WriteOutcome, WriteError>>,
}

struct InFlightWrite {
    packet: Vec<u8>,
    deadline: Instant,
    /// Transmissions made so far, starting at 1 for the initial send —
    /// counted up rather than down so it can be reported verbatim in
    /// `WriteOutcome::attempts`.
    transmissions: u8,
    started_at: Instant,
    tx: oneshot::Sender<Result<WriteOutcome, WriteError>>,
}

#[derive(Default)]
struct WriteQueue {
    in_flight: Option<InFlightWrite>,
    queued: VecDeque<WriteSpec>,
}

/// Stop-and-wait write confirmation, one independent queue per device IP.
/// Mirrors the vendor reference's blocking `UDP.send` retry loop, but
/// non-blocking: the driver loop submits, feeds ACKs in, and polls deadlines,
/// while each caller awaits its own oneshot. Like `RequestRegistry`, this
/// performs no I/O — it returns `Transmit`s for the driver to put on the wire.
#[derive(Default)]
pub struct WriteRegistry {
    by_ip: HashMap<String, WriteQueue>,
}

impl WriteRegistry {
    /// True while any device has a write queued or awaiting its ACK.
    ///
    /// The driver gates its background polling arms on this, mirroring the
    /// vendor reference's `UDP.isRefresh = false` bracket around `UDP.send`
    /// (`UDP.cs:97-100`/`:201-204`): while a write is outstanding, the
    /// heartbeat/sync/discovery traffic goes off the wire entirely so the ACK
    /// contends with nothing. Deliberately global rather than per-IP — the
    /// socket is shared, so another device's fragment burst would delay this
    /// write's ACK just as much as its own device's would.
    pub fn has_pending(&self) -> bool {
        self.by_ip.values().any(|queue| queue.in_flight.is_some() || !queue.queued.is_empty())
    }

    /// Enqueues a write, returning whatever should now go on the wire: the
    /// write itself if the device was idle, plus any `expect_ack = false`
    /// packets behind it, which resolve immediately and let the queue keep
    /// draining in the same pass.
    ///
    /// Coalesces first: a write that targets the same parameter as the last
    /// still-queued write replaces it rather than queueing behind it. Without
    /// this, a held stepper or fast typing produces a run of packets that this
    /// queue can only retire one ACK round trip at a time — and, with the
    /// driver's polling gate, each one extends the window in which no
    /// background traffic flows. See `coalesce_key` for the safety rules.
    pub fn submit(&mut self, spec: WriteSpec, now: Instant) -> Vec<Transmit> {
        let ip = spec.ip.clone();
        let queue = self.by_ip.entry(ip.clone()).or_default();

        let incoming_key = coalesce_key(&spec);
        let replaces_last = incoming_key.is_some()
            && queue.queued.back().and_then(coalesce_key) == incoming_key;
        if replaces_last {
            let superseded = queue.queued.pop_back().expect("back() matched just above");
            let _ = superseded.tx.send(Ok(WriteOutcome { attempts: 0, elapsed_ms: 0 }));
        } else if queue.queued.len() >= WRITE_QUEUE_MAX {
            if let Some(dropped) = queue.queued.pop_front() {
                let _ = dropped.tx.send(Err(WriteError::Backlogged));
            }
        }

        queue.queued.push_back(spec);
        let mut out = Vec::new();
        Self::pump(queue, &ip, now, &mut out);
        out
    }

    /// Feeds one inbound ACK (a datagram with `data_state != 0`) in: resolves
    /// this device's in-flight write, then starts the next queued one. An ACK
    /// for a device with nothing in flight is silently ignored — the common
    /// case, since the device ACKs every heartbeat and query we send too.
    ///
    /// Correlation is by **device IP alone**, exactly as the vendor
    /// reference's `UDP_tool.jugeOutTime(string IP)` does. This is not
    /// laziness: real 1.1.8 hardware, verified on the wire, replies with a
    /// bare 10-byte header whose `packets_lastlen` is **0** — it does *not*
    /// echo the value we sent. An ACK carries no function code, no request id
    /// and no usable length, so IP is the only thing to key on. Correlating on
    /// anything richer simply never matches, and every write times out despite
    /// being acknowledged every time (observed: writes failing 6/6 while the
    /// device ACKed each one).
    ///
    /// Two things make IP-only matching sound, and both must keep holding:
    /// 1. writes are strictly stop-and-wait per device, so there is at most
    ///    one outstanding write to attribute an ACK to; and
    /// 2. the driver suspends heartbeat/sync/discovery while any write is
    ///    pending (`has_pending`), so almost no other ACK-generating traffic is
    ///    in flight to steal the match — the same reason the vendor clears
    ///    `isRefresh` for the duration of its send.
    ///
    /// Residual risk, inherited from the reference and accepted: an ACK for a
    /// query sent just before the write can arrive right after it and confirm
    /// the write early. The window is ~1-2ms against a 50ms heartbeat, and the
    /// consequence is an optimistic success on a packet that almost certainly
    /// landed anyway.
    pub fn on_ack(&mut self, ip: &str, now: Instant) -> Vec<Transmit> {
        let Some(queue) = self.by_ip.get_mut(ip) else { return Vec::new() };
        if queue.in_flight.is_none() {
            return Vec::new();
        }
        let done = queue.in_flight.take().expect("in_flight checked just above");
        let _ = done.tx.send(Ok(WriteOutcome {
            attempts: done.transmissions,
            elapsed_ms: now.saturating_duration_since(done.started_at).as_millis() as u64,
        }));
        let mut out = Vec::new();
        Self::pump(queue, ip, now, &mut out);
        out
    }

    /// Retransmit/fail sweep — same role as `RequestRegistry::poll_deadlines`,
    /// driven by the driver's `deadline_tick`. Never blocks.
    pub fn poll_deadlines(&mut self, now: Instant) -> Vec<Transmit> {
        let mut out = Vec::new();
        for (ip, queue) in self.by_ip.iter_mut() {
            if !queue.in_flight.as_ref().is_some_and(|w| now >= w.deadline) {
                continue;
            }
            if queue.in_flight.as_ref().is_some_and(|w| w.transmissions < write_max_attempts()) {
                let in_flight = queue.in_flight.as_mut().expect("in_flight matched just above");
                in_flight.transmissions += 1;
                in_flight.deadline = now + Duration::from_millis(WRITE_ACK_TIMEOUT_MS);
                out.push(Transmit { ip: ip.clone(), packet: in_flight.packet.clone() });
            } else {
                let failed = queue.in_flight.take().expect("in_flight matched just above");
                let _ = failed.tx.send(Err(WriteError::Timeout));
                Self::pump(queue, ip, now, &mut out);
            }
        }
        self.by_ip.retain(|_, queue| queue.in_flight.is_some() || !queue.queued.is_empty());
        out
    }

    /// Starts queued writes until one is left awaiting an ACK (or the queue
    /// empties). Loops rather than promoting a single entry because an
    /// `expect_ack = false` packet resolves the instant it is handed over,
    /// leaving the device idle again within the same pass.
    fn pump(queue: &mut WriteQueue, ip: &str, now: Instant, out: &mut Vec<Transmit>) {
        while queue.in_flight.is_none() {
            let Some(spec) = queue.queued.pop_front() else { return };
            out.push(Transmit { ip: ip.to_string(), packet: spec.packet.clone() });
            if spec.expect_ack {
                queue.in_flight = Some(InFlightWrite {
                    packet: spec.packet,
                    deadline: now + Duration::from_millis(WRITE_ACK_TIMEOUT_MS),
                    transmissions: 1,
                    started_at: now,
                    tx: spec.tx,
                });
            } else {
                // Never waited on, so it is by definition a first-attempt
                // success the moment it goes on the wire.
                let _ = spec.tx.send(Ok(WriteOutcome { attempts: 1, elapsed_ms: 0 }));
            }
        }
    }
}

/// Identifies "which knob" a write turns, for coalescing: the StructHeader's
/// `(function_code, chx, segment, in_out_flag)`. Two writes sharing this key
/// set the same parameter on the same channel, so the later one's value is the
/// only one that matters and the earlier can be dropped.
///
/// Returns `None` — meaning *never coalesce* — for:
/// - packets with `expect_ack == false`, i.e. `CROSSOVER_COMMIT_PACKET`, which
///   is a raw ACK echo with no StructHeader to key on and whose position
///   immediately after its freq write is load-bearing;
/// - anything too short to hold a StructHeader;
/// - `FC_SAVE_RECALL` (FC=59), where the slot index lives in the *body* and all
///   header fields are 0 — collapsing two recalls would silently drop a slot
///   change rather than a redundant value.
///
/// Callers must only ever compare this against the **last** queued entry, never
/// scan the queue: coalescing against an earlier entry would reorder writes
/// past the commit packet that has to follow them.
fn coalesce_key(spec: &WriteSpec) -> Option<(u8, u8, u8, u8)> {
    if !spec.expect_ack || spec.packet.len() < NETWORK_HEADER_LEN + super::protocol::STRUCT_HEADER_LEN {
        return None;
    }
    let header = &spec.packet[NETWORK_HEADER_LEN..];
    let function_code = header[1];
    if function_code == super::preset::FC_SAVE_RECALL {
        return None;
    }
    // header[3] = chx, header[4] = segment, header[9] = in_out_flag —
    // see `protocol::build_struct_header`.
    Some((function_code, header[3], header[4], header[9]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FC_SYNC_DATA: u8 = 27;
    const FC_BRIDGE: u8 = 50;
    const FC_SAVE_RECALL: u8 = 59;
    const IP: &str = "10.0.0.2";

    fn spec(ip: &str, function_code: u8, expects_fragments: bool) -> RequestSpec {
        RequestSpec {
            ip: ip.to_string(),
            function_code,
            chx: 0,
            body: Vec::new(),
            expects_fragments,
            in_out_flag: 0,
            sink: ResultSink::Internal,
        }
    }

    #[test]
    fn a_single_datagram_request_rides_alongside_a_fragmented_one() {
        let mut registry = RequestRegistry::default();
        let _ = registry.register(spec(IP, FC_SYNC_DATA, true), Instant::now());
        // The whole point: an FC=50 bridge read no longer waits behind the
        // 200ms FC=27 poll, which used to starve it for seconds.
        assert!(!registry.conflicts_with(IP, FC_BRIDGE, false));
        // A second fragmented exchange still has to wait, though.
        assert!(registry.conflicts_with(IP, FC_SAVE_RECALL, true));
    }

    #[test]
    fn a_fragmented_request_waits_for_a_single_datagram_one() {
        let mut registry = RequestRegistry::default();
        let _ = registry.register(spec(IP, FC_BRIDGE, false), Instant::now());
        assert!(registry.conflicts_with(IP, FC_SYNC_DATA, true));
        // Two single-datagram reads under different codes coexist.
        assert!(!registry.conflicts_with(IP, 17, false));
    }

    #[test]
    fn the_same_function_code_always_conflicts() {
        let mut registry = RequestRegistry::default();
        let _ = registry.register(spec(IP, FC_BRIDGE, false), Instant::now());
        // `pending` holds one entry per (ip, fc), so a second would supersede
        // the first rather than run beside it.
        assert!(registry.conflicts_with(IP, FC_BRIDGE, false));
    }

    #[test]
    fn another_device_never_conflicts() {
        let mut registry = RequestRegistry::default();
        let _ = registry.register(spec(IP, FC_SYNC_DATA, true), Instant::now());
        assert!(!registry.conflicts_with("10.0.0.3", FC_SYNC_DATA, true));
    }
}

