//! The delivery layer: Tauri commands, the shapes that cross the IPC boundary,
//! and the event topics. Commands stay thin; every decision they need has
//! already been made by a use case.

pub mod commands;
pub mod dto;
pub mod events;
pub mod splash;
pub mod startup;
