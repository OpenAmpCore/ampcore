//! The built-in web server: a page other devices on the network can open, the
//! groundwork for Operator View. Off until switched on in Settings.
//!
//! Read-only on purpose. There is no login, so nothing here may change an amp;
//! add authentication before adding a route that writes.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::State as Shared;
use axum::response::Html;
use axum::routing::get;
use axum::{Json, Router};
use tauri::async_runtime::JoinHandle;
use tauri::State;
use tokio::sync::oneshot;

use ampcore_core::error::AppError;
use ampcore_core::live::cvr::protocol::local_ipv4_addresses;
use ampcore_core::live::state::{DiscoveredDevice, LiveDeviceInner, LiveDeviceState};

type Live = Arc<Mutex<LiveDeviceInner>>;

const PAGE: &str = include_str!("../web/index.html");

/// Ports below this need elevated rights on most systems.
const MIN_PORT: u16 = 1024;

struct Running {
    port: u16,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct WebServerState(Mutex<Option<Running>>);

fn router(live: Live) -> Router {
    Router::new()
        .route("/", get(|| async { Html(PAGE.replace("{{version}}", env!("CARGO_PKG_VERSION"))) }))
        .route("/api/devices", get(devices))
        .with_state(live)
}

/// The amps the app currently knows, by name.
async fn devices(Shared(live): Shared<Live>) -> Json<Vec<DiscoveredDevice>> {
    let mut devices: Vec<DiscoveredDevice> =
        live.lock().map(|inner| inner.devices.values().cloned().collect()).unwrap_or_default();
    devices.sort_by(|a, b| a.name.cmp(&b.name));
    Json(devices)
}

/// Where the page can be opened from another device: one address per network
/// interface of this machine.
fn urls(port: u16) -> Vec<String> {
    let addresses = local_ipv4_addresses();
    if addresses.is_empty() {
        return vec![format!("http://localhost:{port}")];
    }
    addresses.iter().map(|ip| format!("http://{ip}:{port}")).collect()
}

/// Starts the server on `port`, moves it there, or stops it. Returns the
/// addresses it is reachable at (empty when stopped). Asking for what is
/// already running changes nothing, so the frontend can call this freely.
#[tauri::command]
#[specta::specta]
pub async fn web_server_set(
    server: State<'_, WebServerState>,
    live: State<'_, LiveDeviceState>,
    enabled: bool,
    port: u16,
) -> Result<Vec<String>, AppError> {
    let running = server.0.lock().map_err(|e| e.to_string())?.take();
    if let Some(running) = running {
        if enabled && running.port == port {
            *server.0.lock().map_err(|e| e.to_string())? = Some(running);
            return Ok(urls(port));
        }
        // Waited for, so the port is free again before it is bound anew.
        let _ = running.stop.send(());
        let _ = running.task.await;
    }
    if !enabled {
        return Ok(Vec::new());
    }
    if port < MIN_PORT {
        return Err(AppError::from(format!("Choose a port from {MIN_PORT} to 65535")));
    }

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
        .await
        .map_err(|e| format!("Port {port} can't be used: {e}"))?;
    let (stop, stopped) = oneshot::channel::<()>();
    let app = router(live.0.clone());
    let task = tauri::async_runtime::spawn(async move {
        let served = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
        if let Err(e) = served {
            eprintln!("[web server] stopped: {e}");
        }
    });
    *server.0.lock().map_err(|e| e.to_string())? = Some(Running { port, stop, task });
    Ok(urls(port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn serves_the_known_devices_and_a_page_that_asks_for_them() {
        let live = LiveDeviceState::new();
        let Json(none) = devices(Shared(live.0.clone())).await;
        assert!(none.is_empty());
        assert!(PAGE.contains("/api/devices") && PAGE.contains("{{version}}"));
        let _ = router(live.0); // the routes are valid (axum panics on a bad path)
        assert_eq!(urls(8642).iter().filter(|u| u.ends_with(":8642")).count(), urls(8642).len());
    }
}
