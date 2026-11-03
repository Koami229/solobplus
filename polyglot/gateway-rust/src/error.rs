use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;

#[derive(Debug, Clone)]
pub struct AppError { pub status: u16, pub code: String, pub message: String }

impl AppError {
    pub fn new(status: u16, code: &str, message: &str) -> Self {
        AppError { status, code: code.into(), message: message.into() }
    }
    pub fn internal() -> Self { Self::new(500, "INTERNAL_ERROR", "Internal server error.") }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.code, self.message) }
}
impl std::error::Error for AppError {}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self { eprintln!("db error: {e}"); AppError::internal() }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(json!({"ok": false, "error": {"code": self.code, "message": self.message}}))).into_response()
    }
}
