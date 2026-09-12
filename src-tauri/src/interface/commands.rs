use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::application::error::{AppError, AppResult};
use crate::application::{export_plan, media_library, portable_update, project_file, update};
use crate::domain::media::MediaSource;
use crate::domain::version::Version;
use crate::infrastructure::executor;
use crate::infrastructure::ffmpeg::{capabilities, keyframes, thumbnailer, transcoder};
use crate::infrastructure::{http, paths, portable};
use crate::state::EditorState;

use super::dto::{
    ExportOutcome, ExportRequest, JobProgress, KeyframeReport, PreviewSource, ThumbnailDto,
    UpdateProgress, UpdateReleaseDto, UpdateReportDto,
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

    state.register(source.clone());
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
    path: String,
    job_id: String,
) -> AppResult<PreviewSource> {
    let source = media_named(&state, &path)?;

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
    path: String,
    count: usize,
    token: String,
) -> AppResult<()> {
    let source = media_named(&state, &path)?;
    if !source.has_video() {
        return Ok(());
    }

    // Nothing changes across a still, so one frame is its whole filmstrip. Asking
    // for eighty would spawn eighty processes to decode the same picture, and
    // seventy-nine of them would come back empty: there is nothing to seek to
    // past the single packet the file holds.
    let positions = if source.is_still() {
        vec![0.0]
    } else {
        let count = count.clamp(1, MAX_THUMBNAILS);
        thumbnailer::sample_positions(source.duration.seconds(), count)
    };

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
                    media: source.path.clone(),
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
pub async fn keyframe_positions(
    state: State<'_, EditorState>,
    path: String,
) -> AppResult<KeyframeReport> {
    let source = media_named(&state, &path)?;
    if !source.has_video() {
        return Ok(KeyframeReport { positions: vec![], truncated: false });
    }

    // A still is looped frame by frame on export, so every instant is a cut
    // point. `truncated` is exactly that claim, and it saves a process launch
    // that would report the file's single packet.
    if source.is_still() {
        return Ok(KeyframeReport { positions: vec![], truncated: true });
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
    let source =
        state.primary().ok_or_else(|| AppError::InvalidInput("no video is open".into()))?;
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
    let edit = request.edit_list()?;

    // Every file the timeline names has to have been opened through this
    // application. Resolving them here rather than probing whatever path
    // arrives keeps an export to files the user actually chose.
    let media = request
        .media
        .iter()
        .map(|path| media_named(&state, path))
        .collect::<AppResult<Vec<_>>>()?;

    // Checked against every input, not only the first: writing over any file
    // being read truncates it halfway through the export.
    let sources: Vec<std::path::PathBuf> =
        media.iter().map(|source| std::path::PathBuf::from(&source.path)).collect();
    let output = paths::validate_output(&request.output_path, &sources)?;
    let capabilities = capabilities::capabilities().await?;

    let plan = export_plan::plan(
        &media,
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

/// Forgets every open file and stops anything still running for them.
#[tauri::command]
pub async fn close_media(state: State<'_, EditorState>) -> AppResult<()> {
    state.cancel_all();
    state.forget_all();
    Ok(())
}

/// Drops one file from the pool, leaving the rest of the project alone.
#[tauri::command]
pub async fn forget_media(state: State<'_, EditorState>, path: String) -> AppResult<()> {
    state.forget(&path);
    Ok(())
}

/// Writes a project file.
///
/// The renderer has no filesystem capability at all, so every byte it wants on
/// disk comes through a command like this one — which is also where the path is
/// checked. A project is the one file this application produces that cannot be
/// produced again, so the write goes through a scratch file and a rename.
#[tauri::command]
pub async fn save_project(path: String, contents: String) -> AppResult<String> {
    let destination = project_file::validate_project_destination(&path)?;
    project_file::write_project(&destination, &contents)?;
    Ok(destination.to_string_lossy().into_owned())
}

/// Reads a project file back.
///
/// Returns the text rather than a parsed shape: what a project *means* is the
/// editor's business, and the backend has no use for a block.
#[tauri::command]
pub async fn load_project(path: String) -> AppResult<String> {
    let source = project_file::validate_project_source(&path)?;
    project_file::read_project(&source)
}

/// Whether a path still points at a readable file.
///
/// Media can be moved or deleted while a project sits saved on disk, and a
/// project naming a file that is no longer there has to say so when it opens
/// rather than fail at export time.
#[tauri::command]
pub async fn media_exists(path: String) -> AppResult<bool> {
    Ok(std::fs::metadata(&path).map(|m| m.is_file() && m.len() > 0).unwrap_or(false))
}

fn media_named(state: &State<'_, EditorState>, path: &str) -> AppResult<MediaSource> {
    state.media(path).ok_or_else(|| AppError::InvalidInput("that file is not open".into()))
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

/// How this copy was put on the machine, and therefore how it is replaced.
fn install_kind() -> update::InstallKind {
    if portable::is_portable() {
        update::InstallKind::Portable
    } else {
        update::InstallKind::Installed
    }
}

/// Asks GitHub whether a newer Snip Join has been published.
///
/// Nothing is fetched until the user presses the button: the application makes
/// no network request of its own accord, at startup or otherwise. A repository
/// with no releases yet answers 404, which is reported as "nothing to do" — it
/// is the ordinary state of a project before its first release. Anything else
/// that goes wrong is reported as what it is: answering "you have the newest
/// version" to a question that never reached GitHub is a lie.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> AppResult<UpdateReportDto> {
    let current = Version::parse(&app.package_info().version.to_string())
        .ok_or_else(|| AppError::Internal("this build has no readable version".into()))?;

    let kind = install_kind();

    let latest = match http::get_json(update::LATEST_RELEASE_URL).await? {
        Some(body) => Some(update::parse_release(&body)?),
        None => None,
    };

    let report = update::compare(current, kind, latest);

    Ok(UpdateReportDto {
        current: report.current.to_string(),
        kind: match report.kind {
            update::InstallKind::Installed => "installer".into(),
            update::InstallKind::Portable => "portable".into(),
        },
        // `compare` has already refused a release with nothing to install, so
        // the asset is there — and asked rather than asserted, because a
        // command that panics takes the window with it.
        newer: report.newer.and_then(|release| {
            let asset = update::pick_asset(&release.assets, kind)?;
            let signature = update::signature_for(&release.assets, asset)?;
            Some(UpdateReleaseDto {
                version: release.version.to_string(),
                tag: release.tag.clone(),
                asset_name: asset.name.clone(),
                asset_url: asset.url.clone(),
                asset_size: asset.size,
                signature_url: signature.url.clone(),
            })
        }),
    })
}

/// Fetches the file the check found, and refuses it unless it was signed here.
///
/// Both addresses are checked against the project's own release downloads before
/// a single byte is requested. They arrived in a JSON document from the network,
/// and a URL from there is untrusted input like any other — without this, a
/// tampered reply could have the application download anything from anywhere and
/// then offer to run it.
///
/// The file lands under a scratch name and is only given its real one once the
/// signature over its bytes checks out against the key built into this binary.
/// Everything else about a download can be arranged by whoever sits between this
/// machine and GitHub; that signature cannot.
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    url: String,
    name: String,
    signature_url: String,
) -> AppResult<String> {
    for address in [&url, &signature_url] {
        if !update::is_download_allowed(address) {
            return Err(AppError::InvalidInput("that download is not from Snip Join".into()));
        }
    }

    // The name comes from the same document. Only its last component is used,
    // and only as a file name, so nothing can be written outside the folder.
    let file_name = Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| AppError::InvalidInput("that file has no name".into()))?;

    let destination = paths::updates_dir().join(file_name);
    let partial = destination.with_extension("part");

    // Asked for first: a signature that is not there is a reason not to spend
    // fifty megabytes of somebody's connection.
    let signature = http::get_text(&signature_url).await?;

    let handle = app.clone();
    http::download(&url, &partial, move |received, total| {
        let _ = handle.emit(events::UPDATE_PROGRESS, UpdateProgress { received, total });
    })
    .await?;

    let bytes = tokio::fs::read(&partial).await?;
    if let Err(refusal) = update::verify_signature(&bytes, &signature) {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(refusal);
    }

    // A previous attempt at the same version is stale by definition.
    let _ = tokio::fs::remove_file(&destination).await;
    tokio::fs::rename(&partial, &destination).await?;

    Ok(destination.to_string_lossy().to_string())
}

/// Hands the downloaded update over, and gets out of its way.
///
/// Both kinds of copy end the same way — this process exits and a new Snip Join
/// takes its place — and differ only in who does the replacing. An installed
/// copy has an installer that knows how; a portable copy is a folder somebody
/// unzipped, so the new version finishes the job for the old one: it is unpacked
/// beside the folder, a copy of the new executable is started with
/// `--finish-update`, and this process leaves so its own files can be replaced.
///
/// Whichever path is taken, the renderer has already asked about unsaved work:
/// neither of these goes through the window's close event.
#[tauri::command]
pub async fn apply_update(app: AppHandle, path: String, version: String) -> AppResult<()> {
    let file = Path::new(&path);
    if !file.is_file() {
        return Err(AppError::InvalidInput("that update is no longer there".into()));
    }

    match install_kind() {
        update::InstallKind::Portable => {
            let install = portable::folder()
                .ok_or_else(|| AppError::Internal("this copy has no folder of its own".into()))?;

            // Unpacked and checked before anything is touched: an archive that
            // is not a Snip Join copy has to fail while the old one is still
            // running and still able to say so.
            let staging = portable_update::staging(&version);
            let _ = std::fs::remove_dir_all(&staging);
            let payload = portable_update::extract(file, &staging)?;

            // The finisher is a copy of the *new* executable, placed outside the
            // folder about to be replaced — it cannot be inside it, since that
            // is the folder it is going to overwrite.
            let finisher = staging.join("finish-update.exe");
            let program = portable_update::executable_in(&payload)
                .ok_or_else(|| AppError::InvalidInput("that archive holds no Snip Join".into()))?;
            std::fs::copy(program, &finisher)?;

            std::process::Command::new(&finisher)
                .arg("--finish-update")
                .arg(&payload)
                .arg(&install)
                .current_dir(&staging)
                .spawn()
                .map_err(|error| {
                    AppError::Internal(format!("the update would not start: {error}"))
                })?;

            app.exit(0);
            Ok(())
        }
        update::InstallKind::Installed => {
            // Spawned with an argument vector and no shell, like every other
            // process this application starts. It is the user's own download,
            // started because they pressed "install", and it puts its own window
            // on screen — nothing here is silent.
            std::process::Command::new(file).spawn().map_err(|error| {
                AppError::Internal(format!("the installer would not start: {error}"))
            })?;

            // The installer cannot replace files this process is holding open,
            // so the application leaves. Everything unsaved has already been
            // asked about: the renderer only reaches this command from a button
            // it puts behind that question.
            app.exit(0);
            Ok(())
        }
    }
}
