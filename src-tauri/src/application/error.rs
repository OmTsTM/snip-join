use serde::Serialize;
use thiserror::Error;

use crate::domain::error::DomainError;

/// Everything that can go wrong outside the domain: missing tools, unreadable
/// files, encoder failures, cancellation.
///
/// Variants carry a stable `code` so the interface can translate them, rather
/// than the renderer pattern-matching on English prose that may change.
#[derive(Debug, Error)]
pub enum AppError {
    #[error(transparent)]
    Domain(#[from] DomainError),

    #[error("FFmpeg could not be found. Install it and make sure it is on your PATH.")]
    FfmpegMissing,

    #[error("{0}")]
    InvalidInput(String),

    #[error("the file could not be read: {0}")]
    UnreadableFile(String),

    #[error("this file has no video or audio that can be read")]
    UnsupportedMedia,

    #[error("the media could not be inspected: {0}")]
    ProbeFailed(String),

    #[error("the export stopped: {0}")]
    EncodeFailed(String),

    #[error("cancelled")]
    Cancelled,

    #[error("an internal error occurred: {0}")]
    Internal(String),
}

impl AppError {
    /// Machine-readable discriminator used by the renderer for translation.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Domain(_) => "domain",
            AppError::FfmpegMissing => "ffmpegMissing",
            AppError::InvalidInput(_) => "invalidInput",
            AppError::UnreadableFile(_) => "unreadableFile",
            AppError::UnsupportedMedia => "unsupportedMedia",
            AppError::ProbeFailed(_) => "probeFailed",
            AppError::EncodeFailed(_) => "encodeFailed",
            AppError::Cancelled => "cancelled",
            AppError::Internal(_) => "internal",
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        AppError::Internal(error.to_string())
    }
}

/// Wire shape for an error crossing the IPC boundary.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

impl Serialize for AppErrorWire<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ErrorPayload { code: self.0.code().to_string(), message: self.0.to_string() }
            .serialize(serializer)
    }
}

/// Newtype used only to give `AppError` a `Serialize` implementation without
/// leaking serde into the error type itself.
pub struct AppErrorWire<'a>(pub &'a AppError);

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        AppErrorWire(self).serialize(serializer)
    }
}

pub type AppResult<T> = Result<T, AppError>;
