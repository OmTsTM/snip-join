//! Swapping the splash window for the editor.
//!
//! The splash is not a progress report. Nothing the editor does at startup
//! takes long enough to need one — the window exists to be read, so the timing
//! below is about legibility rather than about work being done.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// How long the splash stays up, measured from the moment it appeared rather
/// than from when the renderer asks to be shown. The progress bar in
/// `splash.html` animates over the same span: a bar that finishes early reads
/// as a stall, and one still moving when the window goes reads as an
/// interruption.
const MINIMUM: Duration = Duration::from_millis(2600);

/// A renderer that never reports in must not leave a borderless window pinned
/// above everything with no editor behind it.
const DEADLINE: Duration = Duration::from_secs(12);

static SHOWN_AT: OnceLock<Instant> = OnceLock::new();

/// Records when the splash went up. Called from `setup`, before any window has
/// had a chance to finish loading.
pub fn mark_shown() {
    let _ = SHOWN_AT.set(Instant::now());
}

/// Waits out whatever is left of the minimum, then swaps the windows.
pub async fn finish(app: AppHandle) {
    let elapsed = SHOWN_AT.get().map_or(MINIMUM, Instant::elapsed);
    if let Some(remaining) = MINIMUM.checked_sub(elapsed) {
        tokio::time::sleep(remaining).await;
    }
    swap(&app);
}

/// Gives up waiting and shows the editor anyway.
pub fn arm_deadline(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DEADLINE).await;
        swap(&app);
    });
}

/// Shows the editor before closing the splash.
///
/// The other order leaves an instant with no window at all, which the taskbar
/// renders as the application flickering away and back. Both calls are
/// idempotent, so the deadline running after a normal start changes nothing.
fn swap(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
}
