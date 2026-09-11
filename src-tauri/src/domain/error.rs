use thiserror::Error;

/// Failures that are meaningful inside the domain itself, independent of any
/// transport, filesystem or encoder concern.
#[derive(Debug, Error, Clone, PartialEq)]
pub enum DomainError {
    #[error("time value must be finite and non-negative, got {0}")]
    InvalidInstant(f64),

    #[error("a time range must advance: start {start} is not before end {end}")]
    EmptyRange { start: f64, end: f64 },

    #[error("the edit list is empty; there is nothing to export")]
    EmptyEdit,

    #[error("clip {index} starts at {start} but the previous clip ends at {previous_end}")]
    OverlappingClips { index: usize, start: f64, previous_end: f64 },

    #[error("the source has no decodable video or audio stream")]
    NoPlayableStream,

    #[error("requested range {start}..{end} falls outside the source duration of {duration}")]
    RangeOutOfBounds { start: f64, end: f64, duration: f64 },
}

pub type DomainResult<T> = Result<T, DomainError>;
