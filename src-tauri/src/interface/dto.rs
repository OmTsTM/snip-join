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
    /// Index into the request's media table.
    #[serde(default)]
    pub media: usize,
    pub source_start: f64,
    pub source_end: f64,
    pub timeline_start: f64,
}

impl ClipDto {
    fn into_clip(self) -> AppResult<Clip> {
        let source = TimeRange::from_seconds(self.source_start, self.source_end)?;
        let timeline_start = Instant::new(self.timeline_start)?;
        Ok(Clip::new(self.media, source, timeline_start))
    }
}

/// Everything needed to start an export.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub job_id: String,
    pub output_path: String,
    /// Every medium the timeline reads from, in the order the clips index it.
    pub media: Vec<String>,
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

        if self.media.is_empty() {
            return Err(AppError::InvalidInput("that export names no media".into()));
        }
        if self.media.len() > MAX_MEDIA {
            return Err(AppError::InvalidInput("that timeline uses too many files".into()));
        }

        let clips =
            self.clips.iter().cloned().map(ClipDto::into_clip).collect::<AppResult<Vec<_>>>()?;
        let edit = EditList::new(clips)?;

        // An index past the end of the table would otherwise reach the planner
        // and panic there, so it is refused at the boundary like every other
        // value arriving over IPC.
        if edit.highest_media_index() >= self.media.len() {
            return Err(AppError::InvalidInput(
                "that export refers to a file it did not list".into(),
            ));
        }

        Ok(edit)
    }
}

/// Upper bound on timeline pieces.
///
/// A stream-copy export spawns one process per piece, so an unbounded list would
/// become a process-spawn loop. No real edit comes close to this.
const MAX_CLIPS: usize = 512;

/// How many distinct files one timeline may draw from. Each becomes an `-i`
/// argument and an open file handle during the export.
const MAX_MEDIA: usize = 64;

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
    /// Which file the frame came from. The strip is filled per medium, and two
    /// files can be read at once.
    pub media: String,
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
            media: vec!["in.mp4".into()],
            clips,
            spec: ExportSpec::fast(),
        }
    }

    #[test]
    fn a_valid_pair_of_clips_becomes_an_edit_list() {
        let edit = request(vec![
            ClipDto { media: 0, source_start: 0.0, source_end: 10.0, timeline_start: 0.0 },
            ClipDto { media: 0, source_start: 20.0, source_end: 30.0, timeline_start: 10.0 },
        ])
        .edit_list()
        .unwrap();

        assert_eq!(edit.len(), 2);
        assert!(edit.is_contiguous());
    }

    #[test]
    fn a_clip_naming_an_unlisted_file_is_refused() {
        let result = ExportRequest {
            job_id: "j".into(),
            output_path: "out.mp4".into(),
            media: vec!["in.mp4".into()],
            clips: vec![ClipDto {
                media: 3,
                source_start: 0.0,
                source_end: 5.0,
                timeline_start: 0.0,
            }],
            spec: ExportSpec::fast(),
        }
        .edit_list();

        assert!(matches!(result.unwrap_err(), AppError::InvalidInput(_)));
    }

    #[test]
    fn an_empty_timeline_is_refused() {
        assert!(request(vec![]).edit_list().is_err());
    }

    #[test]
    fn a_backwards_clip_is_refused() {
        let result = request(vec![ClipDto {
            media: 0,
            source_start: 10.0,
            source_end: 5.0,
            timeline_start: 0.0,
        }])
        .edit_list();
        assert!(result.is_err());
    }

    #[test]
    fn a_non_finite_value_is_refused() {
        let result = request(vec![ClipDto {
            media: 0,
            source_start: 0.0,
            source_end: f64::INFINITY,
            timeline_start: 0.0,
        }])
        .edit_list();
        assert!(result.is_err());
    }

    #[test]
    fn a_negative_position_is_refused() {
        let result = request(vec![ClipDto {
            media: 0,
            source_start: 0.0,
            source_end: 5.0,
            timeline_start: -1.0,
        }])
        .edit_list();
        assert!(result.is_err());
    }

    #[test]
    fn an_absurd_number_of_clips_is_refused_before_spawning_anything() {
        let clips = (0..MAX_CLIPS + 1)
            .map(|i| ClipDto {
                media: 0,
                source_start: i as f64,
                source_end: i as f64 + 0.5,
                timeline_start: i as f64,
            })
            .collect();
        assert!(request(clips).edit_list().is_err());
    }
}

/// What the update check found.
///
/// `newer` is absent when there is nothing to do, which covers three cases the
/// renderer does not need to tell apart: the newest release is the one running,
/// there are no releases yet, and the newest one carries nothing this copy could
/// install.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReportDto {
    pub current: String,
    /// `installer` or `portable`: which of the two ways this copy is replaced.
    pub kind: String,
    pub newer: Option<UpdateReleaseDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReleaseDto {
    pub version: String,
    pub tag: String,
    pub asset_name: String,
    pub asset_url: String,
    pub asset_size: u64,
}

/// How far a download has come.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub received: u64,
    pub total: u64,
}
