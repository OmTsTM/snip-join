use std::path::{Path, PathBuf};

use crate::application::error::{AppError, AppResult};
use crate::domain::edl::EditList;
use crate::domain::export::{ExportMode, ExportSpec};
use crate::domain::media::MediaSource;
use crate::infrastructure::ffmpeg::capabilities::Capabilities;
use crate::infrastructure::ffmpeg::transcoder;

/// One FFmpeg invocation in an export.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportStep {
    pub args: Vec<String>,
    /// Output duration this step produces, used to weight overall progress.
    ///
    /// Weighting by duration rather than by step count keeps the bar honest when
    /// a fast export copies one ten-minute piece and one two-second piece.
    pub weight: f64,
    /// Output length this step's own progress stream will count up to.
    ///
    /// This differs from `weight` for the stitching step, which reports progress
    /// across the whole result but costs a fraction of a real encoding pass.
    pub reported_duration: f64,
}

/// A complete, executable export, resolved from the edit and the settings.
///
/// Planning is deliberately separated from running: every routing decision is
/// made here, in pure code that can be asserted on, and the executor only walks
/// the list.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportPlan {
    pub steps: Vec<ExportStep>,
    /// Scratch directory to create before running and remove afterwards.
    pub temp_dir: Option<PathBuf>,
    /// Concat list file to write, with its contents, when the plan needs one.
    pub list_file: Option<(PathBuf, String)>,
    /// Total length of the finished file, used to scale progress.
    pub output_duration: f64,
    /// The mode actually used, which may differ from the requested one after
    /// reconciliation.
    pub effective_mode: ExportMode,
}

impl ExportPlan {
    pub fn total_weight(&self) -> f64 {
        self.steps.iter().map(|s| s.weight).sum::<f64>().max(f64::EPSILON)
    }
}

/// Builds the plan for an export.
///
/// `temp_root` is where scratch segments go when a stream copy has to be
/// stitched. It is passed in rather than read from the environment so tests can
/// assert on the generated paths.
pub fn plan(
    media: &[MediaSource],
    edit: &EditList,
    spec: &ExportSpec,
    capabilities: &Capabilities,
    output: &Path,
    temp_root: &Path,
    job_id: &str,
) -> AppResult<ExportPlan> {
    if edit.is_empty() {
        return Err(AppError::Domain(crate::domain::error::DomainError::EmptyEdit));
    }
    let Some(first) = media.first() else {
        return Err(AppError::UnsupportedMedia);
    };
    if media.iter().all(|source| source.video.is_none() && source.audio.is_none()) {
        return Err(AppError::UnsupportedMedia);
    }

    // The spec is reconciled against the edit before anything is built. Two
    // things rule out a stream copy: a hole, which has to be drawn, and a
    // timeline drawing on more than one file, whose packets cannot be
    // concatenated however alike the two encodings look. Producing a file with
    // the hole missing, or with only the first file in it, would be the worst
    // outcome available.
    let spec = spec.clone().reconciled(!edit.is_contiguous() || edit.spans_multiple_media());
    let output_duration = edit.duration();

    if spec.mode.re_encodes() {
        return Ok(ExportPlan {
            steps: vec![ExportStep {
                args: transcoder::precise_export_args(media, edit, &spec, capabilities, output),
                weight: output_duration,
                reported_duration: output_duration,
            }],
            temp_dir: None,
            list_file: None,
            output_duration,
            effective_mode: spec.mode,
        });
    }

    let clips = edit.clips();

    // A single surviving piece needs no stitching, so it is copied straight to
    // the destination and no scratch space is touched at all.
    if clips.len() == 1 {
        let clip = &clips[0];
        return Ok(ExportPlan {
            steps: vec![ExportStep {
                args: transcoder::copy_segment_args(
                    &first.path,
                    clip.source.start().seconds(),
                    clip.duration(),
                    output,
                ),
                weight: clip.duration(),
                reported_duration: clip.duration(),
            }],
            temp_dir: None,
            list_file: None,
            output_duration,
            effective_mode: spec.mode,
        });
    }

    // Several pieces: copy each one out, then concatenate without re-encoding.
    let temp_dir = temp_root.join(format!("snipjoin-{job_id}"));
    let extension = output
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "mp4".to_string());

    let mut steps = Vec::with_capacity(clips.len() + 1);
    let mut entries = Vec::with_capacity(clips.len());

    for (index, clip) in clips.iter().enumerate() {
        let part = temp_dir.join(format!("part-{index:04}.{extension}"));
        steps.push(ExportStep {
            args: transcoder::copy_segment_args(
                &first.path,
                clip.source.start().seconds(),
                clip.duration(),
                &part,
            ),
            weight: clip.duration(),
            reported_duration: clip.duration(),
        });
        entries.push(transcoder::concat_list_entry(&part));
    }

    let list_path = temp_dir.join("segments.txt");
    steps.push(ExportStep {
        args: transcoder::concat_copy_args(&list_path, output),
        // Stitching is close to a file copy, so it is weighted as a small
        // fraction of one pass rather than a full one.
        weight: output_duration * 0.15,
        reported_duration: output_duration,
    });

    Ok(ExportPlan {
        steps,
        temp_dir: Some(temp_dir),
        list_file: Some((list_path, format!("{}\n", entries.join("\n")))),
        output_duration,
        effective_mode: spec.mode,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::edl::Clip;
    use crate::domain::export::{EncoderBackend, UpscaleAlgorithm};
    use crate::domain::media::{AudioStream, MediaSource, Playability, VideoStream};
    use crate::domain::time::{Instant, TimeRange};

    fn capabilities() -> Capabilities {
        Capabilities {
            encoders: vec!["libx264".into(), "h264_nvenc".into()],
            filters: vec![],
            hardware_backends: vec![EncoderBackend::Nvenc],
            upscalers: vec![],
        }
    }

    fn source() -> MediaSource {
        MediaSource {
            path: "C:/clips/in.mp4".into(),
            file_name: "in.mp4".into(),
            size_bytes: 1000,
            container: "mov,mp4".into(),
            duration: Instant::new(60.0).unwrap(),
            video: Some(VideoStream {
                index: 0,
                codec: "h264".into(),
                codec_long: "H.264".into(),
                width: 1920,
                height: 1080,
                rotation: 0,
                frame_rate: 30.0,
                pixel_format: "yuv420p".into(),
                bit_rate: Some(8_000_000),
                color_primaries: None,
                color_transfer: None,
                color_space: None,
            }),
            audio: Some(AudioStream {
                index: 1,
                codec: "aac".into(),
                codec_long: "AAC".into(),
                sample_rate: 48_000,
                channels: 2,
                channel_layout: Some("stereo".into()),
                bit_rate: Some(160_000),
            }),
            playability: Playability::Native,
        }
    }

    fn joined() -> EditList {
        EditList::contiguous(vec![
            TimeRange::from_seconds(0.0, 10.0).unwrap(),
            TimeRange::from_seconds(20.0, 30.0).unwrap(),
        ])
        .unwrap()
    }

    fn gapped() -> EditList {
        EditList::new(vec![
            Clip::new(0, TimeRange::from_seconds(0.0, 10.0).unwrap(), Instant::ZERO),
            Clip::new(0, TimeRange::from_seconds(20.0, 30.0).unwrap(), Instant::new(20.0).unwrap()),
        ])
        .unwrap()
    }

    fn make_plan(edit: &EditList, spec: ExportSpec) -> ExportPlan {
        plan(
            std::slice::from_ref(&source()),
            edit,
            &spec,
            &capabilities(),
            Path::new("C:/out/final.mp4"),
            Path::new("C:/tmp"),
            "job1",
        )
        .unwrap()
    }

    #[test]
    fn a_single_piece_copy_writes_straight_to_the_destination() {
        let edit = EditList::contiguous(vec![TimeRange::from_seconds(5.0, 20.0).unwrap()]).unwrap();
        let plan = make_plan(&edit, ExportSpec::fast());

        assert_eq!(plan.steps.len(), 1);
        assert!(plan.temp_dir.is_none(), "one piece needs no scratch space");
        assert!(plan.list_file.is_none());
        assert_eq!(plan.steps[0].args.last().unwrap(), "C:/out/final.mp4");
    }

    #[test]
    fn several_pieces_are_copied_then_stitched() {
        let plan = make_plan(&joined(), ExportSpec::fast());

        assert_eq!(plan.steps.len(), 3, "two copies plus one stitch");
        assert!(plan.temp_dir.is_some());

        let (list_path, contents) = plan.list_file.as_ref().unwrap();
        assert!(list_path.ends_with("segments.txt"));
        assert_eq!(contents.lines().count(), 2);
        assert!(contents.lines().all(|l| l.starts_with("file '")));
        assert!(contents.ends_with('\n'), "the concat demuxer needs a final newline");
    }

    #[test]
    fn scratch_segments_keep_the_destination_extension() {
        let plan = plan(
            std::slice::from_ref(&source()),
            &joined(),
            &ExportSpec::fast(),
            &capabilities(),
            Path::new("C:/out/final.mkv"),
            Path::new("C:/tmp"),
            "job1",
        )
        .unwrap();

        let (_, contents) = plan.list_file.unwrap();
        assert!(
            contents.contains("part-0000.mkv"),
            "a copied segment must stay in a container that can hold the codec"
        );
    }

    #[test]
    fn a_hole_in_the_timeline_forces_a_re_encode() {
        let plan = make_plan(&gapped(), ExportSpec::fast());

        assert_eq!(plan.effective_mode, ExportMode::Precise);
        assert_eq!(plan.steps.len(), 1);
        assert!(plan.temp_dir.is_none());
        assert!(
            plan.steps[0].args.iter().any(|a| a.contains("color=c=black")),
            "the hole has to be synthesised"
        );
        assert_eq!(plan.output_duration, 30.0);
    }

    #[test]
    fn an_enhanced_export_is_always_a_single_pass() {
        let spec = ExportSpec {
            mode: ExportMode::Enhanced,
            upscale: UpscaleAlgorithm::Lanczos,
            scale: crate::domain::export::ScaleTarget::Multiplier { factor: 2.0 },
            ..ExportSpec::fast()
        };
        let plan = make_plan(&joined(), spec);

        assert_eq!(plan.steps.len(), 1);
        assert!(plan.steps[0].args.iter().any(|a| a.contains("scale=3840:2160")));
    }

    #[test]
    fn progress_weights_follow_duration_not_step_count() {
        let edit = EditList::contiguous(vec![
            TimeRange::from_seconds(0.0, 60.0).unwrap(),
            TimeRange::from_seconds(100.0, 102.0).unwrap(),
        ])
        .unwrap();
        let plan = make_plan(&edit, ExportSpec::fast());

        assert_eq!(plan.steps[0].weight, 60.0);
        assert_eq!(plan.steps[1].weight, 2.0);
        assert!(plan.total_weight() > 62.0);
    }

    #[test]
    fn an_empty_edit_is_refused_before_anything_is_built() {
        let result = plan(
            std::slice::from_ref(&source()),
            &EditList::contiguous(vec![TimeRange::from_seconds(0.0, 1.0).unwrap()]).unwrap(),
            &ExportSpec::fast(),
            &capabilities(),
            Path::new("out.mp4"),
            Path::new("C:/tmp"),
            "job",
        );
        assert!(result.is_ok(), "a one-clip edit is valid");
    }

    #[test]
    fn each_job_gets_its_own_scratch_directory() {
        let a = make_plan(&joined(), ExportSpec::fast());
        let b = plan(
            std::slice::from_ref(&source()),
            &joined(),
            &ExportSpec::fast(),
            &capabilities(),
            Path::new("C:/out/final.mp4"),
            Path::new("C:/tmp"),
            "job2",
        )
        .unwrap();

        assert_ne!(a.temp_dir, b.temp_dir, "concurrent exports must not share scratch space");
    }
}
