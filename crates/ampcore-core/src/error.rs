use serde::Serialize;
use specta::Type;

#[derive(Debug, Serialize, Type)]
pub struct AppError {
    pub message: String,
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        AppError { message }
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        AppError {
            message: message.to_string(),
        }
    }
}
