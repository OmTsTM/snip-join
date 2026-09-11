//! Event channel names shared with the renderer.
//!
//! Declared once here so a rename cannot leave one side listening on a topic
//! nobody emits on. The matching TypeScript constants live in
//! `src/infrastructure/tauri/events.ts`.

pub const EXPORT_PROGRESS: &str = "snipjoin://export-progress";
pub const PROXY_PROGRESS: &str = "snipjoin://proxy-progress";
pub const THUMBNAIL_READY: &str = "snipjoin://thumbnail-ready";
