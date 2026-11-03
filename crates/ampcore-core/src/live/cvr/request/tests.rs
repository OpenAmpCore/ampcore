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

/// A per-channel reply (FC=43 FIR) doesn't say which channel it answers,
/// so the resolved request has to.
#[test]
fn a_resolved_request_reports_its_chx() {
    let mut registry = RequestRegistry::default();
    let now = Instant::now();
    let _ = registry.register(RequestSpec { chx: 2, ..spec(IP, 43, true) }, now);
    registry.on_frame(IP, 43, vec![0; 16], now);
    let (resolved, _) = registry.poll_deadlines(now + Duration::from_millis(SETTLE_MS + 1));
    assert_eq!(resolved.iter().map(|r| r.chx).collect::<Vec<_>>(), [2]);
}

#[test]
fn another_device_never_conflicts() {
    let mut registry = RequestRegistry::default();
    let _ = registry.register(spec(IP, FC_SYNC_DATA, true), Instant::now());
    assert!(!registry.conflicts_with("10.0.0.3", FC_SYNC_DATA, true));
}

fn write_spec_with_packet(packet: Vec<u8>) -> WriteSpec {
    let (tx, _rx) = oneshot::channel();
    WriteSpec { ip: IP.to_string(), packet, expect_ack: true, tx }
}

#[test]
fn a_continuation_fragment_never_coalesces_even_if_its_bytes_look_like_a_matching_header() {
    // Fragment 1: a real StructHeader (FC=43, chx=2, segment=0, flag=1)
    // right after the network header.
    let mut first = vec![0u8; NETWORK_HEADER_LEN];
    first[7] = 1; // packets_step = 1
    first.extend_from_slice(&[0x55, 43, 1, 2, 0, 0, 0, 0, 0, 1]);
    assert_eq!(coalesce_key(&write_spec_with_packet(first)), Some((43, 2, 0, 1)));

    // Fragment 2: same network-header-relative byte layout, but these
    // bytes are actually a slice of the frame's *body*, not a header —
    // they must never be read as one just because packets_step is right
    // after byte 0.
    let mut second = vec![0u8; NETWORK_HEADER_LEN];
    second[7] = 2; // packets_step = 2
    second.extend_from_slice(&[0x55, 43, 1, 2, 0, 0, 0, 0, 0, 1]);
    assert_eq!(coalesce_key(&write_spec_with_packet(second)), None);
}
