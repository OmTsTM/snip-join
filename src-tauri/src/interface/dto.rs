use serde::{Deserialize, Serialize};

use crate::application::error::{AppError, AppResult};
use crate::domain::edl::{Clip, EditList};
use crate::domain::export::ExportSpec;
use crate::domain::time::{Instant, TimeRange};

/// One block as the renderer describes it.
///
/// The renderer owns block numbering, selection and undo history; none of that
/// crosses the boundary. What arrives is only what the encoder needs: which part
/// of the source to read, and where it lands.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipDto {
    pub source_start: f64,
    pub source_end: f64,
    pub timeline_start: f64,
}

impl ClipDto {
    fn into_clip(self) -> AppResult<Clip> {
        let source = TimeRange::from_seconds(self.source_start, self.source_end)?;
        let timeline_start = Instant::new(self.timeline_start)?;
        Ok(Clip::new(source, timeline_start))
    }
}

/// Everything needed to start an export.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub job_id: String,
    pub output_path: String,
    pub clips: Vec<ClipDto>,
    pub spec: ExportSpec,
}

impl ExportRequest {
    /// Converts the wire shape into a validated edit list.
    ///
    /// Values arriving over IPC are treated as untrusted input even though the
    /// only sender is this application's own renderer: a bug there should surface
    /// as a refused request, not as a malformed command line.
    pub fn edit_list(&self) -> AppResult<EditList> {
        if self.clips.is_empty() {
            return Err(AppError::InvalidInput(
                "there is nothing left on the timeline to export".into(),
            ));
        }
        if self.clips.len() > MAX_CLIPS {
            return Err(AppError::InvalidInput(
                "that timeline has too many pieces to export".into(),
            ));
        }

        let clips =
            self.clips.iter().cloned().map(ClipDto::into_clip).collect::<AppResult<Vec<_>>>()?;

        Ok(EditList::new(clips)?)
    }
}

/// Upper bound on timeline pieces.
///
/// A stream-copy export spawns one process per piece, so an unbounded list would
/// become a process-spawn loop. No real edit comes close to this.
const MAX_CLIPS: usize = 512;

/// Result of a finished export.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub output_path: String,
    pub duration: f64,
    pub size_bytes: u64,
    /// The mode that actually ran, which tells the interface whether to mention
    /// that a stream copy was promoted to a re-encode.
    pub mode: crate::domain::export::ExportMode,
}

/// Result of preparing a source for preview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSource {
    /// Absolute path the renderer should load, which is the proxy when one was
    /// needed and the original otherwise.
    pub path: String,
    pub is_proxy: bool,
}

/// One filmstrip frame crossing to the renderer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailDto {
    /// Echoes the token the request carried, so the renderer can drop frames
    /// belonging to a file it has already closed.
    pub token: String,
    pub index: usize,
    pub at: f64,
    pub data_url: String,
}

/// Positions a stream copy is able to cut at.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyframeReport {
    pub positions: Vec<f64>,
    /// True when the source has more cut points than were listed, which happens
    /// on all-intra footage where every frame is one.
    pub truncated: bool,
}

/// Progress for any long-running job.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub job_id: String,
    /// Fraction from 0 to 1.
    pub progress: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(clips: Vec<ClipDto>) -> ExportRequest {
        ExportRequest {
            job_id: "j".into(),
            output_path: "out.mp4".into(),
            clips,
            spec: ExportSpec::fast(),
        }
    }

    #[test]
    fn a_valid_pair_of_clips_becomes_an_edit_list() {
        let edit = request(vec![
            ClipDto { source_start: 0.0, source_end: 10.0, timeline_start: 0.0 },
            ClipDto { source_start: 20.0, source_end: 30.0, timeline_start: 10.0 },
        ])
        .edit_list()
        .unwrap();

        assert_eq!(edit.len(), 2);
        assert!(edit.is_contiguous());
    }

    #[test]
    fn an_empty_timeline_is_refused() {
        assert!(request(vec![]).edit_list().is_err());
    }

    #[test]
    fn a_backwards_clip_is_refused() {
        let result =
            request(vec![ClipDto { source_start: 10.0, source_end: 5.0, timeline_start: 0.0 }])
                .edit_list();
        assert!(result.is_err());
    }

    #[test]
    fn a_non_finite_value_is_refused() {
        let result = request(vec![ClipDto {
            source_start: 0.0,
            source_end: f64::INFINITY,
            timeline_start: 0.0,
        }])
        .edit_list();
        assert!(result.is_err());
    }

    #[test]
    fn a_negative_position_is_refused() {
        let result =
            request(vec![ClipDto { source_start: 0.0, source_end: 5.0, timeline_start: -1.0 }])
                .edit_list();
        assert!(result.is_err());
    }

    #[test]
    fn an_absurd_number_of_clips_is_refused_before_spawning_anything() {
        let clips = (0..MAX_CLIPS + 1)
            .map(|i| ClipDto {
                source_start: i as f64,
                source_end: i as f64 + 0.5,
                timeline_start: i as f64,
            })
            .collect();
        assert!(request(clips).edit_list().is_err());
    }
}
