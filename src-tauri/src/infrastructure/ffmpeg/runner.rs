use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::watch;

use crate::application::error::{AppError, AppResult};

/// Upper bound on retained stderr lines.
///
/// FFmpeg can emit tens of thousands of warning lines on a damaged file. Keeping
/// them all would grow unbounded for the lifetime of a long export, so only the
/// tail is kept: the failure reason is always in the last few lines.
const MAX_STDERR_LINES: usize = 80;

/// Live encoding progress, derived from FFmpeg's machine-readable stream.
#[derive(Debug, Clone, Copy, Default)]
pub struct Progress {
    /// Output position in seconds, which is what maps onto a progress bar.
    pub out_time: f64,
    pub frame: u64,
    pub fps: f64,
    /// Encoding rate relative to real time, as reported by FFmpeg.
    pub speed: f64,
}

/// Builds a child process that never flashes a console window on Windows.
///
/// Without `CREATE_NO_WINDOW` every FFmpeg invocation pops a black console for a
/// few frames. With one process per thumbnail that is a visible strobe.
fn spawn_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.kill_on_drop(true);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

/// Runs a tool to completion and returns its stdout.
///
/// Used for short, bounded invocations such as probing. Arguments are passed as a
/// vector and never interpolated into a shell string, so a file name containing
/// quotes, semicolons or ampersands is inert.
pub async fn run_capturing_stdout(program: &Path, args: &[String]) -> AppResult<String> {
    let output = spawn_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| AppError::Internal(format!("could not start {}: {e}", program.display())))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::ProbeFailed(tail(&stderr, 10)));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Runs a tool to completion and returns its raw stdout bytes.
///
/// Separate from the string variant because image data piped out of FFmpeg is
/// binary; decoding it as UTF-8 would replace every invalid byte and corrupt the
/// result beyond recovery.
pub async fn run_capturing_bytes(program: &Path, args: &[String]) -> AppResult<Vec<u8>> {
    let output = spawn_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| AppError::Internal(format!("could not start {}: {e}", program.display())))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::EncodeFailed(tail(&stderr, 6)));
    }

    Ok(output.stdout)
}

/// Runs FFmpeg to completion, reporting progress and honouring cancellation.
///
/// Answers with the last progress FFmpeg reported, which is how a caller can
/// tell a run that wrote nothing from one that wrote what was asked: FFmpeg
/// exits with zero either way.
///
/// `on_progress` is called from the reader task, so it must be cheap and must not
/// block; emitting a Tauri event is fine, doing file IO is not.
pub async fn run_with_progress<F>(
    program: &Path,
    args: &[String],
    mut cancel: watch::Receiver<bool>,
    mut on_progress: F,
) -> AppResult<Progress>
where
    F: FnMut(Progress) + Send + 'static,
{
    let mut child = spawn_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Internal(format!("could not start FFmpeg: {e}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("FFmpeg stdout was not captured".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("FFmpeg stderr was not captured".into()))?;

    // Progress arrives on stdout as `key=value` lines terminated by `progress=`.
    let progress_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut pending = Progress::default();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some((key, value)) = line.split_once('=') {
                apply_progress_field(&mut pending, key.trim(), value.trim());
                if key.trim() == "progress" {
                    on_progress(pending);
                }
            }
        }
        pending
    });

    // Diagnostics are read concurrently; leaving stderr unread would deadlock
    // FFmpeg once the pipe buffer fills on a file that produces many warnings.
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut kept: VecDeque<String> = VecDeque::with_capacity(MAX_STDERR_LINES);
        while let Ok(Some(line)) = lines.next_line().await {
            if kept.len() == MAX_STDERR_LINES {
                kept.pop_front();
            }
            kept.push_back(line);
        }
        kept.into_iter().collect::<Vec<_>>().join("\n")
    });

    let status = tokio::select! {
        status = child.wait() => {
            status.map_err(|e| AppError::Internal(format!("FFmpeg could not be awaited: {e}")))?
        }
        _ = wait_for_cancel(&mut cancel) => {
            // Terminate the child, then still await both readers so their pipes
            // close and the tasks cannot outlive this call.
            let _ = child.kill().await;
            progress_task.abort();
            let _ = stderr_task.await;
            return Err(AppError::Cancelled);
        }
    };

    let last = progress_task.await.unwrap_or_default();
    let diagnostics = stderr_task.await.unwrap_or_default();

    if !status.success() {
        return Err(AppError::EncodeFailed(tail(&diagnostics, 12)));
    }

    Ok(last)
}

/// Resolves when the cancellation flag is set.
///
/// The flag is copied out of the watch guard before any await point. Holding the
/// guard across one would make the whole future non-Send, which a Tauri command
/// cannot be.
async fn wait_for_cancel(receiver: &mut watch::Receiver<bool>) {
    loop {
        let cancelled = *receiver.borrow();
        if cancelled {
            return;
        }
        if receiver.changed().await.is_err() {
            // Every sender is gone, so the flag can never be set. Parking here
            // leaves the sibling branch of the select to decide the outcome.
            std::future::pending::<()>().await;
        }
    }
}

fn apply_progress_field(progress: &mut Progress, key: &str, value: &str) {
    match key {
        // Microseconds. Older builds spell the same field `out_time_ms`, which is
        // also microseconds despite the name, so both are treated identically.
        "out_time_us" | "out_time_ms" => {
            if let Ok(micros) = value.parse::<i64>() {
                progress.out_time = (micros.max(0) as f64) / 1_000_000.0;
            }
        }
        "frame" => {
            if let Ok(frame) = value.parse::<u64>() {
                progress.frame = frame;
            }
        }
        "fps" => {
            if let Ok(fps) = value.parse::<f64>() {
                progress.fps = fps;
            }
        }
        "speed" => {
            if let Ok(speed) = value.trim_end_matches('x').parse::<f64>() {
                progress.speed = speed;
            }
        }
        _ => {}
    }
}

/// Keeps the last `lines` lines of a diagnostic blob, trimmed.
fn tail(text: &str, lines: usize) -> String {
    let collected: Vec<&str> =
        text.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let start = collected.len().saturating_sub(lines);
    collected[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_fields_are_parsed() {
        let mut progress = Progress::default();
        apply_progress_field(&mut progress, "out_time_us", "4120000");
        apply_progress_field(&mut progress, "frame", "123");
        apply_progress_field(&mut progress, "speed", "1.5x");

        assert!((progress.out_time - 4.12).abs() < 1e-9);
        assert_eq!(progress.frame, 123);
        assert!((progress.speed - 1.5).abs() < 1e-9);
    }

    #[test]
    fn negative_timestamps_clamp_to_zero() {
        let mut progress = Progress::default();
        apply_progress_field(&mut progress, "out_time_us", "-42");
        assert_eq!(progress.out_time, 0.0);
    }

    #[test]
    fn unparsable_values_leave_progress_untouched() {
        let mut progress = Progress { frame: 7, ..Progress::default() };
        apply_progress_field(&mut progress, "frame", "N/A");
        assert_eq!(progress.frame, 7);
    }

    #[test]
    fn tail_keeps_only_the_last_lines() {
        let text = "one\n\ntwo\nthree\nfour";
        assert_eq!(tail(text, 2), "three\nfour");
    }
}
