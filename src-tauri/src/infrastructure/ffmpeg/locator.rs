use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::application::error::{AppError, AppResult};

/// Resolved absolute paths to the FFmpeg tools.
///
/// Resolution happens once per process. FFmpeg is not going to move while the
/// app is running, and repeating a PATH scan on every probe would add latency to
/// the one operation the user waits on when opening a file.
#[derive(Debug, Clone)]
pub struct FfmpegTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

/// Where the installer placed the bundled copy, registered at startup.
///
/// The renderer's process has no way to know the resource directory, and this
/// module cannot reach for a Tauri handle without dragging the framework into
/// the infrastructure layer. Registering the path once from the setup hook keeps
/// the dependency pointing the right way.
static BUNDLED_DIR: OnceLock<PathBuf> = OnceLock::new();

static TOOLS: OnceLock<Option<FfmpegTools>> = OnceLock::new();

/// Registers the directory the application ships FFmpeg in. Call before any
/// media work; later calls are ignored.
pub fn use_bundled_dir(dir: PathBuf) {
    let _ = BUNDLED_DIR.set(dir);
}

/// Finds `ffmpeg` and `ffprobe`.
///
/// The bundled copy wins over whatever is on PATH. That matters for
/// reproducibility: a user with an old or cut-down FFmpeg on PATH would
/// otherwise get silently different encoder and filter support than the build
/// was tested against, and the failure would surface halfway through an export.
pub fn tools() -> AppResult<&'static FfmpegTools> {
    TOOLS.get_or_init(resolve).as_ref().ok_or(AppError::FfmpegMissing)
}

/// Every directory searched before falling back to PATH, in order.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(registered) = BUNDLED_DIR.get() {
        dirs.push(registered.clone());
    }

    if let Some(exe_dir) =
        std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf))
    {
        // Next to the executable is where a portable copy lives; `bin` is where
        // the installer puts it.
        dirs.push(exe_dir.join("bin"));
        dirs.push(exe_dir.clone());
        // During `tauri dev` the executable sits two levels inside `target`, so
        // a copy staged for packaging is still reachable without a full build.
        dirs.push(exe_dir.join("../../bin"));
    }

    dirs
}

fn resolve() -> Option<FfmpegTools> {
    for dir in candidate_dirs() {
        let ffmpeg = dir.join(exe("ffmpeg"));
        let ffprobe = dir.join(exe("ffprobe"));
        if ffmpeg.is_file() && ffprobe.is_file() {
            let ffmpeg = dunce::canonicalize(&ffmpeg).unwrap_or(ffmpeg);
            let ffprobe = dunce::canonicalize(&ffprobe).unwrap_or(ffprobe);
            tracing::info!(ffmpeg = %ffmpeg.display(), "using the bundled FFmpeg");
            return Some(FfmpegTools { ffmpeg, ffprobe });
        }
    }

    let ffmpeg = which::which(exe("ffmpeg")).ok()?;
    let ffprobe = which::which(exe("ffprobe")).ok()?;
    tracing::info!(ffmpeg = %ffmpeg.display(), "using FFmpeg from PATH");
    Some(FfmpegTools { ffmpeg, ffprobe })
}

#[cfg(windows)]
fn exe(name: &str) -> String {
    format!("{name}.exe")
}

#[cfg(not(windows))]
fn exe(name: &str) -> String {
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_search_order_puts_bundled_locations_before_path() {
        let dirs = candidate_dirs();
        // There is always at least the executable's own directory and its `bin`.
        assert!(dirs.len() >= 2, "expected bundled candidates, got {dirs:?}");
        assert!(dirs.iter().any(|d| d.ends_with("bin")));
    }

    #[test]
    fn executable_names_carry_an_extension_on_windows() {
        #[cfg(windows)]
        assert_eq!(exe("ffmpeg"), "ffmpeg.exe");
        #[cfg(not(windows))]
        assert_eq!(exe("ffmpeg"), "ffmpeg");
    }
}
