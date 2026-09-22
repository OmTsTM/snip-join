use std::path::{Path, PathBuf};

use tokio::sync::watch;

use crate::application::error::{AppError, AppResult};
use crate::application::export_plan::ExportPlan;

use super::ffmpeg::{locator, runner};

/// Removes a scratch directory when it goes out of scope.
///
/// Cancellation, an encoder failure and a normal finish all have to leave the
/// disk clean, and a cancelled export unwinds through an early return. Tying
/// removal to a drop covers every one of those paths without repeating cleanup
/// at each exit.
struct ScratchGuard(Option<PathBuf>);

impl Drop for ScratchGuard {
    fn drop(&mut self) {
        if let Some(dir) = self.0.take() {
            if let Err(error) = std::fs::remove_dir_all(&dir) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(dir = %dir.display(), %error, "scratch directory was left behind");
                }
            }
        }
    }
}

/// Runs an export plan, reporting overall progress as a fraction from 0 to 1.
///
/// `on_progress` receives monotonic values: a multi-step plan would otherwise
/// reset the bar to zero at the start of every step, which reads as the export
/// having restarted.
pub async fn run_plan<F>(
    plan: &ExportPlan,
    cancel: watch::Receiver<bool>,
    mut on_progress: F,
) -> AppResult<()>
where
    F: FnMut(f64) + Send + Clone + 'static,
{
    let tools = locator::tools()?;
    let _scratch = ScratchGuard(plan.temp_dir.clone());

    if let Some(dir) = plan.temp_dir.as_ref() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| AppError::Internal(format!("scratch space could not be created: {e}")))?;
    }

    let total_weight = plan.total_weight();
    let mut completed_weight = 0.0_f64;

    for (index, step) in plan.steps.iter().enumerate() {
        // The concat list has to exist before the step that reads it, but only
        // after the segments it points at have been produced.
        if let Some((path, contents)) = plan.list_file.as_ref() {
            if index + 1 == plan.steps.len() {
                write_list_file(path, contents).await?;
            }
        }

        let span = step.reported_duration.max(f64::EPSILON);
        let weight = step.weight;
        let base = completed_weight;
        let mut report = on_progress.clone();

        let last =
            runner::run_with_progress(&tools.ffmpeg, &step.args, cancel.clone(), move |progress| {
                let within_step = (progress.out_time / span).clamp(0.0, 1.0);
                report(((base + within_step * weight) / total_weight).clamp(0.0, 1.0));
            })
            .await?;

        // A step that ends cleanly having written nothing is a failure FFmpeg
        // does not report as one: a hardware encoder handed an input too short
        // to flush answers with an empty stream and exit code zero, and the join
        // then treats the empty piece as the end of the list, leaving a file
        // that stops short with no word about it.
        if last.frame == 0 && last.out_time <= 0.0 {
            return Err(AppError::EncodeFailed(format!(
                "step {} of {} finished without writing a single frame",
                index + 1,
                plan.steps.len()
            )));
        }

        completed_weight += weight;
        on_progress((completed_weight / total_weight).clamp(0.0, 1.0));
    }

    on_progress(1.0);
    Ok(())
}

/// Runs a single FFmpeg invocation that produces one file, such as a proxy.
pub async fn run_single<F>(
    args: &[String],
    total_duration: f64,
    cancel: watch::Receiver<bool>,
    mut on_progress: F,
) -> AppResult<()>
where
    F: FnMut(f64) + Send + 'static,
{
    let tools = locator::tools()?;
    let span = total_duration.max(f64::EPSILON);

    runner::run_with_progress(&tools.ffmpeg, args, cancel, move |progress| {
        on_progress((progress.out_time / span).clamp(0.0, 1.0));
    })
    .await
    .map(|_| ())
}

async fn write_list_file(path: &Path, contents: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    tokio::fs::write(path, contents)
        .await
        .map_err(|e| AppError::Internal(format!("the segment list could not be written: {e}")))
}
