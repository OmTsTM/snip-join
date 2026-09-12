//! Snip Join: remove a stretch from a video, join what is left, export it.
//!
//! The crate is layered so that a change to the encoder cannot reach the editing
//! rules, and a change to the editing rules cannot reach the window:
//!
//! - `domain` holds the editing concepts and their invariants. It has no
//!   knowledge of FFmpeg, Tauri, or the filesystem, and every rule in it is unit
//!   tested without a process running.
//! - `application` orchestrates. Its most important piece is a pure planner that
//!   turns an edit plus a set of options into an ordered list of commands, so
//!   every routing decision can be asserted on rather than observed.
//! - `infrastructure` is the only layer that knows what FFmpeg is.
//! - `interface` exposes commands to the renderer and owns nothing else.
//!
//! Dependencies point inward only. `domain` imports nothing from the others.

pub mod application;
pub mod domain;
pub mod infrastructure;
pub mod interface;
pub mod state;

use tauri::Manager;

use interface::commands;
use state::EditorState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "snipjoin=info,warn".into()),
        )
        .with_target(false)
        .init();

    // Before anything else, including the web view: this start may not be an
    // editor at all. A portable copy that is updating starts a copy of the new
    // executable purely to replace the old one's files, which is a job that has
    // to happen while no Snip Join is running out of that folder.
    if let Some((payload, install)) =
        application::portable_update::finishing_arguments(std::env::args())
    {
        match application::portable_update::finish(&payload, &install) {
            Ok(()) => return,
            Err(error) => {
                tracing::error!(%error, "the update could not be finished");
                return;
            }
        }
    }

    // Must precede the web view: the user-data folder is read once, at creation.
    infrastructure::portable::apply_environment();

    // A crash or a forced quit skips the scratch cleanup that normally runs on
    // drop, so anything left behind by a previous session is swept at startup.
    infrastructure::paths::sweep_stale_scratch();

    // And, if this start is the first after an update, the copy it replaced.
    if let Some(root) = infrastructure::portable::root() {
        application::portable_update::sweep(root);
    }

    // Windows passes a file here when the application is picked from "Open with"
    // or a video is dropped onto its shortcut.
    interface::startup::remember(interface::startup::capture_from_args(std::env::args()));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(EditorState::default())
        .setup(|app| {
            // The installer places FFmpeg under the resource directory. Telling
            // the locator where that is keeps the infrastructure layer free of a
            // Tauri dependency while still preferring the shipped build.
            if let Ok(resources) = app.path().resource_dir() {
                infrastructure::ffmpeg::locator::use_bundled_dir(resources.join("bin"));
            }

            // The splash is up already; from here the clock that decides how
            // long it stays is running.
            interface::splash::mark_shown();
            interface::splash::arm_deadline(app.handle().clone());

            // Alt-Tab and the taskbar read this, and a support question starts
            // with which version is running. Taken from the package metadata
            // rather than written into the config, so it cannot fall behind the
            // installer's number.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&format!("Snip Join {}", app.package_info().version));
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window must not leave an FFmpeg process encoding in the
            // background with nothing left to report to.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<EditorState>() {
                    state.cancel_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_media,
            commands::close_media,
            commands::encoder_capabilities,
            commands::prepare_preview,
            commands::generate_thumbnails,
            commands::suggest_output_path,
            commands::export_timeline,
            commands::cancel_job,
            commands::initial_file,
            commands::keyframe_positions,
            commands::finish_startup,
            commands::save_project,
            commands::load_project,
            commands::media_exists,
            commands::check_for_update,
            commands::download_update,
            commands::apply_update,
        ])
        .run(tauri::generate_context!())
        .expect("the Snip Join window could not be created");
}
