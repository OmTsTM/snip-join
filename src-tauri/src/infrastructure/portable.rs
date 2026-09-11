use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Presence of this file beside the executable switches the application into
/// portable mode.
///
/// A marker file rather than a build flag, so one binary serves both cases: the
/// portable archive ships the marker, the installer does not. Deleting it turns
/// a portable copy back into an ordinary one.
const MARKER: &str = "portable.txt";

static PORTABLE_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The directory everything writable lives under when running portable, or
/// `None` when running installed.
///
/// Resolved once: the executable cannot move while it is running, and the answer
/// decides where caches and the web view's own storage go, which must not change
/// mid-session.
pub fn root() -> Option<&'static PathBuf> {
    PORTABLE_ROOT.get_or_init(detect).as_ref()
}

pub fn is_portable() -> bool {
    root().is_some()
}

fn detect() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent().map(Path::to_path_buf)?;

    if !exe_dir.join(MARKER).is_file() {
        return None;
    }

    // Writability is the whole premise of portable mode. A copy run from a
    // read-only location falls back to the ordinary user directories rather than
    // failing every cache write later on.
    let data = exe_dir.join("data");
    if std::fs::create_dir_all(&data).is_err() {
        tracing::warn!(
            dir = %data.display(),
            "portable marker found but the folder is not writable; using the standard locations"
        );
        return None;
    }

    Some(data)
}

/// Where the web view keeps its own storage, including the remembered language.
///
/// Without this a "portable" copy would still leave state in the user's roaming
/// profile, which defeats carrying the app on a stick.
pub fn webview_data_dir() -> Option<PathBuf> {
    root().map(|data| data.join("webview"))
}

/// Applies the portable environment before anything reads it.
///
/// Must run before the web view is created: the user-data folder is read once at
/// initialisation and ignored afterwards.
pub fn apply_environment() {
    let Some(dir) = webview_data_dir() else {
        return;
    };

    if std::fs::create_dir_all(&dir).is_err() {
        tracing::warn!(dir = %dir.display(), "could not create the portable web view folder");
        return;
    }

    // SAFETY: called once from `main`, before any thread is spawned and before
    // the web view reads the environment.
    unsafe {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
    }

    tracing::info!(dir = %dir.display(), "running portable");
}
