//! Shared amp device/protocol/DSP domain logic.
//!
//! Zero Tauri dependency by design: this crate is consumed by both the
//! desktop app (`src-tauri`) and, eventually, a mobile app. Anything that
//! needs `tauri::` types (commands, AppHandle, event emission, desktop
//! project-file persistence) stays in the app crates, not here.

pub mod data;
pub mod error;
pub mod live;
