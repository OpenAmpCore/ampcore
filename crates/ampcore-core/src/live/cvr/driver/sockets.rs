use super::*;

/// One socket bound to one adapter's address, and the task feeding its
/// datagrams into the driver loop.
pub(super) struct AdapterSocket {
    pub(super) socket: Arc<UdpSocket>,
    pub(super) broadcast: Ipv4Addr,
    pub(super) reader: tokio::task::JoinHandle<()>,
}

impl Drop for AdapterSocket {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

pub(super) type Inbound = (Ipv4Addr, SocketAddr, Vec<u8>);

/// The driver's sockets, one per adapter in use. Bound to the adapter's address
/// as the vendor app does, because a single 0.0.0.0 socket leaves the choice of
/// adapter to the OS routing table.
pub(super) struct AdapterSockets {
    pub(super) open: BTreeMap<Ipv4Addr, AdapterSocket>,
    /// Which local socket each amp last answered on, so that traffic to it
    /// leaves the same way.
    pub(super) routes: HashMap<String, Ipv4Addr>,
    pub(super) inbound: mpsc::UnboundedSender<Inbound>,
}

impl AdapterSockets {
    /// Opens and closes sockets to match the adapters in use now: hot-plugged
    /// adapters, changed addresses and a changed selection all land here, and a
    /// bind that failed is retried. Returns what failed. Needs a tokio context.
    pub(super) fn reconcile(&mut self, selected: Option<&str>) -> Option<String> {
        let wanted = wanted_adapters(selected);
        self.open.retain(|ip, _| wanted.iter().any(|(_, wanted_ip, _)| wanted_ip == ip));
        self.routes.retain(|_, local| self.open.contains_key(local));
        let mut errors = Vec::new();
        for (name, ip, broadcast) in wanted {
            if self.open.contains_key(&ip) {
                continue;
            }
            match bind_adapter(ip) {
                Ok(socket) => {
                    let reader = tokio::spawn(read_socket(socket.clone(), ip, self.inbound.clone()));
                    self.open.insert(ip, AdapterSocket { socket, broadcast, reader });
                }
                Err(e) => errors.push(format!(
                    "Couldn't open UDP port {PC_LISTEN_PORT} on {name}. Another program, such as the amp vendor's software or a second AmpCore, may be using it. ({e})"
                )),
            }
        }
        (!errors.is_empty()).then(|| errors.join(" "))
    }

    /// Sends to one amp through the socket it last answered on. An amp not heard
    /// from yet (a device list that outlived a driver restart) goes through the
    /// first socket; its next discovery reply corrects that.
    pub(super) async fn send(&self, packet: &[u8], ip: &str) -> std::io::Result<usize> {
        let socket = self.routes.get(ip).and_then(|local| self.open.get(local)).or_else(|| self.open.values().next());
        match socket {
            Some(s) => s.socket.send_to(packet, (ip, AMP_PORT)).await,
            None => Err(std::io::ErrorKind::NotConnected.into()),
        }
    }

    /// Both broadcasts on every socket: an amp on a subnet other than the
    /// adapter's only hears the limited one, which is all the vendor app sends.
    /// Failures are routine on a disconnected adapter.
    pub(super) async fn broadcast(&self, packet: &[u8]) {
        for s in self.open.values() {
            let _ = s.socket.send_to(packet, (s.broadcast, AMP_PORT)).await;
            let _ = s.socket.send_to(packet, (Ipv4Addr::BROADCAST, AMP_PORT)).await;
        }
    }
}

pub(super) fn bind_adapter(ip: Ipv4Addr) -> std::io::Result<Arc<UdpSocket>> {
    let socket = std::net::UdpSocket::bind((ip, PC_LISTEN_PORT))?;
    socket.set_broadcast(true)?;
    socket.set_nonblocking(true)?;
    Ok(Arc::new(UdpSocket::from_std(socket)?))
}

/// `(name, address, broadcast)` of each socket to hold. `selected` is an adapter
/// name; `None` is all of them. A selected adapter that is gone means no sockets
/// rather than some other adapter. Mobile keeps the single wildcard socket, as
/// does a machine with no adapters at all, so that one joining is still seen.
pub(super) fn wanted_adapters(selected: Option<&str>) -> Vec<(String, Ipv4Addr, Ipv4Addr)> {
    let wildcard = || vec![("this device".to_string(), Ipv4Addr::UNSPECIFIED, Ipv4Addr::BROADCAST)];
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return wildcard();
    }
    let adapters = network_adapters();
    if adapters.is_empty() && selected.is_none() {
        return wildcard();
    }
    adapters
        .into_iter()
        .filter(|(adapter, ..)| selected.map_or(true, |name| name == adapter.name))
        .map(|(adapter, ip, broadcast)| (adapter.name, ip, broadcast))
        .collect()
}

pub(super) async fn read_socket(socket: Arc<UdpSocket>, local: Ipv4Addr, inbound: mpsc::UnboundedSender<Inbound>) {
    let mut buf = [0u8; 2048];
    loop {
        match socket.recv_from(&mut buf).await {
            Ok((len, addr)) => {
                if inbound.send((local, addr, buf[..len].to_vec())).is_err() {
                    return;
                }
            }
            // Windows reports an ICMP "port unreachable" as a failed receive.
            // The socket is fine, but don't spin if it isn't.
            Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
        }
    }
}
