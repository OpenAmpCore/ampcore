use crate::data::amp_model::AmpProtocol;

use super::state::LiveEventSink;

/// Implemented once per amp brand/protocol family. `start` spawns the
/// driver's own background task(s) and returns immediately with a handle
/// used to stop it later — no `async fn` in the trait itself, so no extra
/// async-trait dependency is needed.
///
/// Forward-looking note (not implemented yet): a later parameter-control
/// phase would extend this with something like `send_command(&self, target,
/// cmd: ParamCommand)` / `read_parameter(...)`, where `ParamCommand` /
/// `ParamQuery` are brand-agnostic enums each driver maps onto its own wire
/// format. The identity/discovery slice built here deliberately stops short
/// of that.
pub trait AmpDriver: Send + Sync {
    /// Identifies which catalog protocol this driver implements — the same
    /// `AmpProtocol` a catalog entry (`AmpModelCatalogEntry.protocol`)
    /// carries, so device ids/catalog entries can eventually be
    /// cross-referenced by this value. `AmpProtocol::slug()` namespaces
    /// device ids as "{slug}:{mac}".
    fn protocol(&self) -> AmpProtocol;
    /// Human-facing brand label, e.g. "CVR".
    fn brand(&self) -> &'static str;
    fn start(&self, sink: LiveEventSink) -> DriverHandle;
}

/// Every amp driver currently supported by the app — the single centralized
/// place declaring which drivers exist, so dispatch (`live_control_start`)
/// doesn't need to know about individual driver types.
pub fn all_drivers() -> Vec<Box<dyn AmpDriver>> {
    vec![Box::new(super::cvr::driver::CvrDriver)]
}

pub struct DriverHandle {
    stop_tx: tokio::sync::oneshot::Sender<()>,
}

impl DriverHandle {
    pub fn new(stop_tx: tokio::sync::oneshot::Sender<()>) -> Self {
        Self { stop_tx }
    }

    /// Fire-and-forget: signals the task to exit on its next `select!` tick.
    /// Deliberately not awaited — commands must stay synchronous.
    pub fn request_stop(self) {
        let _ = self.stop_tx.send(());
    }
}
