use tauri::State;

use ampcore_core::data::capability::{resolve, AmpCapability};
use ampcore_core::data::filter_response::{fir_response_curve as fir_curve, response_curves, EqStageRef, ResponseCurves, ResponsePoint, DEFAULT_CURVE_POINTS};
use ampcore_core::data::project::ChannelEq;
use crate::data::store::ProjectDataState;
use ampcore_core::error::AppError;

/// Resolves what can be configured, and within what ranges, for a given amp
/// model + firmware version — purely offline, no live device involved.
/// Nothing here is persisted independently: it's always recomputed from the
/// catalog entry's topology and the (free-text) firmware version string.
#[tauri::command]
#[specta::specta]
pub fn amp_capability_resolve(
    state: State<ProjectDataState>,
    amp_model_id: String,
    firmware_version: Option<String>,
) -> Result<AmpCapability, AppError> {
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    let model = inner
        .amp_models
        .iter()
        .find(|m| m.id == amp_model_id)
        .ok_or_else(|| AppError::from(format!("amp model {} not found", amp_model_id)))?;
    Ok(resolve(model, firmware_version.as_deref()))
}

/// Magnitude response of one EQ chain for the EQ graph — the whole chain, and
/// one stage isolated when `stage` is given. Pure math over the passed-in
/// values (a live preview of an uncommitted drag included), shared with the
/// mobile app via core. `async` so it runs off the main thread: a drag asks
/// for it every frame.
#[tauri::command]
#[specta::specta]
pub async fn eq_response_curves(eq: ChannelEq, stage: Option<EqStageRef>, points: Option<u32>) -> ResponseCurves {
    response_curves(&eq, stage, points.unwrap_or(DEFAULT_CURVE_POINTS))
}

/// Magnitude response of an FIR filter's taps, on the EQ curve's frequency
/// axis, floored at `floor_db`.
#[tauri::command]
#[specta::specta]
pub async fn fir_response_curve(taps: Vec<f64>, sample_rate_hz: f64, floor_db: f64, points: Option<u32>) -> Vec<ResponsePoint> {
    fir_curve(&taps, sample_rate_hz, floor_db, points.unwrap_or(DEFAULT_CURVE_POINTS))
}
