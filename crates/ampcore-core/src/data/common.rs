use serde::{Deserialize, Serialize};
use specta::Type;

/// Marks whether a catalog entry (Amp Model Catalog) was
/// authored by the user or shipped built-in with the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EntryOrigin {
    UserDefined,
    BuiltIn,
}

/// Milliseconds since the Unix epoch — used for created_at/updated_at.
/// `f64` (not i64/u64) deliberately: specta forbids exporting BigInt-style
/// types to TypeScript, and f64 exactly represents integers this size for
/// millennia, so there's no real precision tradeoff.
pub fn now_millis() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
