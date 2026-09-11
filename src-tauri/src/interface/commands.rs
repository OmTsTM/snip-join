use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::application::error::{AppError, AppResult};
use crate::application::{export_plan, media_library};
use crate::domain::media::MediaSource;
use crate::infrastructure::executor;
use crate::infrastructure::ffmpeg::{capabilities, keyframes, thumbnailer, transcoder};
use crate::infrastructure::paths;
use crate::state::EditorState;

use super::dto::{
    ExportOutcome, ExportRequest, JobProgress, KeyframeReport, PreviewSource, ThumbnailDto,
};
use super::events;
use super::splash;
use super::startup;

/// Reports that the editor is on screen and the splash can go.
///
/// The renderer decides when it is ready; how long the splash is owed on top of
/// that is the splash module's business, not this command's.
#[tauri::command]
pub async fn finish_startup(app: AppHandle) {
    splash::finish(app).await;
}

/// How many filmstrip frames may be requested at once.
///
/// Each frame is a process launch, so the cap keeps a zoomed-in timeline from
/// turning into a spawn storm.
const MAX_THUMBNAILS: usize = 160;

/// How many thumbnail extractions run at the same time.
///
/// Extraction is IO and decode bound rather than parallel-friendly, and every
/// extra process competes with the preview for the same decoder. Four keeps the
/// strip filling quickly without making playback stutter.
const THUMBNAIL_CONCURRENCY: usize = 4;

/// Opens a file, inspects it, and makes it readable by the preview.
#[tauri::command]
pub async fn open_media(
    app: AppHandle,
    state: State<'_, EditorState>,
    path: String,
) -> AppResult<MediaSource> {
    let source = media_library::open(&path).await?;

    // The renderer has no filesystem capability at all. Granting the asset
    // protocol access to exactly this one file is what lets the video element
    // read it, and nothing else on disk becomes reachable.
    app.asset_protocol_scope()
        .allow_file(&source.path)
        .map_err(|e| AppError::Internal(format!("the file could not be made readable: {e}")))?;

    state.set_source(source.clone());
    Ok(source)
}

/// Reports what this machine's FFmpeg build supports.
#[tauri::command]
pub async fn encoder_capabilities() -> AppResult<capabilities::Capabilities> {
    capabilities::capabilities().await.cloned()
}

/// Returns the file the preview should load, building a proxy when the web view
/// cannot decode the original.
#[tauri::command]
pub async fn prepare_preview(
    app: AppHandle,
    state: State<'_, EditorState>,
    job_id: String,
) -> AppResult<PreviewSource> {
    let source = current_source(&state)?;

    if !media_library::needs_proxy(&source) {
        return Ok(PreviewSource { path: source.path.clone(), is_proxy: false });
    }

    let proxy = media_library::proxy_path(&source);
    if !media_library::proxy_is_cached(&proxy) {
        build_proxy(&app, &state, &source, &proxy, &job_id).await?;
    }

    app.asset_protocol_scope()
        .allow_file(&proxy)
        .map_err(|e| AppError::Internal(format!("the preview could not be made readable: {e}")))?;

    Ok(PreviewSource { path: proxy.to_string_lossy().into_owned(), is_proxy: true })
}

async fn build_proxy(
    app: &AppHandle,
    state: &State<'_, EditorState>,
    source: &MediaSource,
    proxy: &PathBuf,
    job_id: &str,
) -> AppResult<()> {
    tokio::fs::create_dir_all(media_library::proxy_dir())
        .await
        .map_err(|e| AppError::Internal(format!("the preview folder could not be created: {e}")))?;

    let capabilities = capabilities::capabilities().await?;
    let args = transcoder::proxy_args(source, capabilities, proxy);
    let cancel = state.register_job(job_id);

    let emitter = app.clone();
    let id = job_id.to_string();
    let result = executor::run_single(&args, source.duration.seconds(), cancel, move |progress| {
        let _ = emitter.emit(events::PROXY_PROGRESS, JobProgress { job_id: id.clone(), progress });
    })
    .await;

    state.finish_job(job_id);

    if result.is_err() {
        // A half-written proxy would be cached and reused as if it were whole.
        let _ = tokio::fs::remove_file(proxy).await;
    }

    result
}

/// Extracts filmstrip frames, emitting each one as it is ready.
///
/// Results stream rather than arriving as one batch so the strip fills in
/// progressively instead of staying blank until the last frame is decoded.
///
/// `token` identifies the file the request belongs to and is echoed on every
/// event. Extraction of a long video outlives the decision to open a different
/// one, and without the token those late frames would land in the new file's
/// filmstrip.
#[tauri::command]
pub async fn generate_thumbnails(
    app: AppHandle,
    state: State<'_, EditorState>,
    count: usize,
    token: String,
) -> AppResult<()> {
    let source = current_source(&state)?;
    if !source.has_video() {
        return Ok(());
    }

    let count = count.clamp(1, MAX_THUMBNAILS);
    let positions = thumbnailer::sample_positions(source.duration.seconds(), count);

    // A bounded window rather than one task per frame: the cap is what keeps
    // memory and process count flat regardless of how long the video is.
    let mut index = 0usize;
    while index < positions.len() {
        let window = positions.iter().enumerate().skip(index).take(THUMBNAIL_CONCURRENCY);

        let tasks: Vec<_> = window
            .map(|(position_index, at)| {
                let source = source.clone();
                let at = *at;
                async move {
                    thumbnailer::extract(&source, at)
                        .await
                        .map(|thumbnail| (position_index, thumbnail))
                }
            })
            .collect();

        let taken = tasks.len();
        // A frame that cannot be decoded is skipped rather than failing the whole
        // strip: a damaged keyframe in the middle of a long recording should cost
        // one tile, not the entire timeline.
        for (position_index, thumbnail) in futures_join_all(tasks).await.into_iter().flatten() {
            let _ = app.emit(
                events::THUMBNAIL_READY,
                ThumbnailDto {
                    token: token.clone(),
                    index: position_index,
                    at: thumbnail.at,
                    data_url: thumbnail.data_url,
                },
            );
        }

        index += taken.max(1);
    }

    Ok(())
}

/// Lists the positions a stream copy can cut at.
///
/// These are what makes cutting without re-encoding exact rather than
/// approximate: a copy can only begin on a keyframe, so the editor snaps to
/// these and shows them, instead of silently moving the user's cut by up to a
/// whole group of pictures.
#[tauri::command]
pub async fn keyframe_positions(state: State<'_, EditorState>) -> AppResult<KeyframeReport> {
    let source = current_source(&state)?;
    if !source.has_video() {
        return Ok(KeyframeReport { positions: vec![], truncated: false });
    }

    let found = keyframes::probe(std::path::Path::new(&source.path)).await?;
    Ok(KeyframeReport { positions: found.positions, truncated: found.truncated })
}

/// Suggests a destination beside the source file.
#[tauri::command]
pub async fn suggest_output_path(
    state: State<'_, EditorState>,
    extension: Option<String>,
) -> AppResult<String> {
    let source = current_source(&state)?;
    let path = PathBuf::from(&source.path);

    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "video".to_string());
    let extension = extension.unwrap_or_else(|| {
        path.extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_else(|| "mp4".to_string())
    });
    let parent = path.parent().map(PathBuf::from).unwrap_or_default();

    Ok(parent.join(format!("{stem} - snipped.{extension}")).to_string_lossy().into_owned())
}

/// Runs an export to completion.
#[tauri::command]
pub async fn export_timeline(
    app: AppHandle,
    state: State<'_, EditorState>,
    request: ExportRequest,
) -> AppResult<ExportOutcome> {
    let source = current_source(&state)?;
    let edit = request.edit_list()?;
    let output = paths::validate_output(&request.output_path, std::path::Path::new(&source.path))?;
    let capabilities = capabilities::capabilities().await?;

    let plan = export_plan::plan(
        &source,
        &edit,
        &request.spec,
        capabilities,
        &output,
        &paths::scratch_root(),
        &request.job_id,
    )?;

    let cancel = state.register_job(&request.job_id);
    let emitter = app.clone();
    let id = request.job_id.clone();

    let result = executor::run_plan(&plan, cancel, move |progress| {
        let _ = emitter.emit(events::EXPORT_PROGRESS, JobProgress { job_id: id.clone(), progress });
    })
    .await;

    state.finish_job(&request.job_id);

    if result.is_err() {
        // An aborted export leaves a truncated file that looks like a finished
        // one in the folder. Removing it makes the failure unambiguous.
        let _ = tokio::fs::remove_file(&output).await;
    }
    result?;

    let size_bytes = tokio::fs::metadata(&output).await.map(|m| m.len()).unwrap_or(0);

    Ok(ExportOutcome {
        output_path: output.to_string_lossy().into_owned(),
        duration: plan.output_duration,
        size_bytes,
        mode: plan.effective_mode,
    })
}

/// The file the application was launched with, if any.
#[tauri::command]
pub async fn initial_file() -> AppResult<Option<String>> {
    Ok(startup::initial_file())
}

/// Stops a running job. Safe to call for a job that already finished.
#[tauri::command]
pub async fn cancel_job(state: State<'_, EditorState>, job_id: String) -> AppResult<()> {
    state.cancel_job(&job_id);
    Ok(())
}

/// Forgets the open source and stops anything still running for it.
#[tauri::command]
pub async fn close_media(state: State<'_, EditorState>) -> AppResult<()> {
    state.cancel_all();
    state.clear_source();
    Ok(())
}

fn current_source(state: &State<'_, EditorState>) -> AppResult<MediaSource> {
    state.source().ok_or_else(|| AppError::InvalidInput("no video is open".into()))
}

/// Awaits a set of futures concurrently.
///
/// Written by hand rather than pulling in `futures` for one combinator; the
/// window is small and bounded, so a simple sequential poll through `join!`-like
/// behaviour via tasks is enough.
async fn futures_join_all<F, T>(futures: Vec<F>) -> Vec<T>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let handles: Vec<_> = futures.into_iter().map(tokio::spawn).collect();
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(value) = handle.await {
            results.push(value);
        }
    }
    results
}
