//! Adapters to the outside world: the encoder toolchain, the filesystem and
//! process execution. Nothing above this layer knows FFmpeg exists.

pub mod executor;
pub mod ffmpeg;
pub mod http;
pub mod paths;
pub mod portable;
