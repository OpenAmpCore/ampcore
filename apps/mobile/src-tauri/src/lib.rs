//! AmpCore Mobile — skeleton app crate. Proves the Core -> Mobile dependency
//! (see crates/ampcore-core) compiles and links; no real commands yet. Real
//! functionality (device discovery, live monitoring, basic parameter
//! control — see the monorepo split plan for what's in/out of scope for
//! mobile v1) gets built out from here, reusing ampcore_core::live and
//! ampcore_core::data the same way src-tauri does.

use ampcore_core::data::amp_model::AmpProtocol;

/// Placeholder proving the crate boundary works end to end: calls into
/// ampcore-core's domain types from a real Tauri command. Delete once a
/// real command takes over as the first meaningful call across the
/// boundary.
#[tauri::command]
fn amp_protocol_slug() -> String {
    AmpProtocol::CvrUdp.slug().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![amp_protocol_slug])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
