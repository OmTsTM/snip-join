//! The domain layer: pure editing concepts with no knowledge of FFmpeg, Tauri,
//! the filesystem or the interface. Everything here is deterministic and unit
//! testable without a process, a window or a file on disk.

pub mod edl;
pub mod error;
pub mod export;
pub mod media;
pub mod time;
pub mod version;
