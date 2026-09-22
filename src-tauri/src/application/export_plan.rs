use std::path::{Path, PathBuf};

use crate::application::error::{AppError, AppResult};
use crate::domain::edl::{Clip, EditList, Segment};
use crate::domain::export::{ExportMode, ExportSpec};
use crate::domain::media::MediaSource;
use crate::infrastructure::ffmpeg::capabilities::Capabilities;
use crate::infrastructure::ffmpeg::keyframes::{Keyframe, Keyframes};
use crate::infrastructure::ffmpeg::transcoder::{self, AudioPart, PIECE_EXTENSION};

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
    /// How much of the picture is re-encoded, in seconds of output.
    ///
    /// Zero for a pure copy and the whole length for a re-encode; in between
    /// for a copy that re-encodes only the frames beside each cut.
    pub re_encoded: f64,
}

impl ExportPlan {
    pub fn total_weight(&self) -> f64 {
        self.steps.iter().map(|s| s.weight).sum::<f64>().max(f64::EPSILON)
    }
}

/// How much cheaper a copied piece is than an encoded one of the same length,
/// for the progress bar.
const COPY_COST: f64 = 0.05;

/// Cost of drawing a hole, relative to encoding footage: the encoder is fed
/// black, which it dispatches in a fraction of the time.
const GAP_COST: f64 = 0.3;

/// Cost of the final join, which copies the picture and encodes the sound.
const JOIN_COST: f64 = 0.15;

/// Builds the plan for an export.
///
/// `temp_root` is where scratch segments go when a stream copy has to be
/// stitched. It is passed in rather than read from the environment so tests can
/// assert on the generated paths. `cut_points` holds each medium's keyframe
/// index in table order, where one has been read; without it a copy can only be
/// bounded by time, which is exact only when every cut sits on a keyframe.
#[allow(clippy::too_many_arguments)]
pub fn plan(
    media: &[MediaSource],
    edit: &EditList,
    spec: &ExportSpec,
    capabilities: &Capabilities,
    output: &Path,
    temp_root: &Path,
    job_id: &str,
    cut_points: &[Option<Keyframes>],
) -> AppResult<ExportPlan> {
    if edit.is_empty() {
        return Err(AppError::Domain(crate::domain::error::DomainError::EmptyEdit));
    }
    if media.is_empty() {
        return Err(AppError::UnsupportedMedia);
    }
    if media.iter().all(|source| source.video.is_none() && source.audio.is_none()) {
        return Err(AppError::UnsupportedMedia);
    }

    // The one file a single-medium timeline reads. Every clip names the same
    // index once `spans_multiple_media` is false, and it is not necessarily
    // the first entry of the table.
    let used = edit.clips().first().map(|clip| clip.media).unwrap_or(0);
    let source = media.get(used).ok_or(AppError::UnsupportedMedia)?;
    let index = cut_points
        .get(used)
        .and_then(Option::as_ref)
        .filter(|index| !index.truncated && !index.entries.is_empty());
    let smart = !edit.spans_multiple_media() && source.supports_smart_cut() && index.is_some();

    // The spec is reconciled against the edit before anything is built. Two
    // things rule out copying outright: a timeline drawing on more than one
    // file, whose packets cannot be concatenated however alike the two
    // encodings look, and a still, which is one packet that has to be looped
    // into a stretch of video. A hole used to be a third, and still is for a
    // file whose packets cannot be joined with drawn ones; where they can, the
    // hole is drawn as one more piece and the footage around it is copied.
    let must_re_encode = edit.spans_multiple_media()
        || media.iter().any(MediaSource::is_still)
        || (!edit.is_contiguous() && !smart);
    let spec = spec.clone().reconciled(must_re_encode);
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
            re_encoded: output_duration,
        });
    }

    let temp_dir = temp_root.join(format!("snipjoin-{job_id}"));

    if smart {
        let index = index.expect("checked above");
        let pieces = pieces_for(edit, source, index);
        if pieces.iter().any(|piece| !matches!(piece, Piece::Copy { .. })) {
            return Ok(smart_plan(source, &pieces, &spec, capabilities, output, &temp_dir));
        }
        // Every cut sits on a keyframe and there is no hole: nothing needs
        // drawing, so the plain copy below does the job with the sound
        // untouched as well.
    }

    copy_plan(source, edit, index, &spec, output, &temp_dir, output_duration)
}

/// A pure stream copy: one piece straight to the destination, or several
/// copied out and stitched.
fn copy_plan(
    source: &MediaSource,
    edit: &EditList,
    index: Option<&Keyframes>,
    spec: &ExportSpec,
    output: &Path,
    temp_dir: &Path,
    output_duration: f64,
) -> AppResult<ExportPlan> {
    let clips = edit.clips();

    // A single surviving piece needs no stitching, so it is copied straight to
    // the destination and no scratch space is touched at all.
    if clips.len() == 1 {
        let clip = &clips[0];
        return Ok(ExportPlan {
            steps: vec![ExportStep {
                args: transcoder::copy_segment_args(
                    &source.path,
                    clip.source.start().seconds(),
                    clip.duration(),
                    aligned_frames(clip, source, index),
                    output,
                ),
                weight: clip.duration(),
                reported_duration: clip.duration(),
            }],
            temp_dir: None,
            list_file: None,
            output_duration,
            effective_mode: spec.mode,
            re_encoded: 0.0,
        });
    }

    // Several pieces: copy each one out, then concatenate without re-encoding.
    let extension = output
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "mp4".to_string());

    let mut steps = Vec::with_capacity(clips.len() + 1);
    let mut entries = Vec::with_capacity(clips.len());

    for (position, clip) in clips.iter().enumerate() {
        let part = temp_dir.join(format!("part-{position:04}.{extension}"));
        steps.push(ExportStep {
            args: transcoder::copy_segment_args(
                &source.path,
                clip.source.start().seconds(),
                clip.duration(),
                aligned_frames(clip, source, index),
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
        weight: output_duration * JOIN_COST,
        reported_duration: output_duration,
    });

    Ok(ExportPlan {
        steps,
        temp_dir: Some(temp_dir.to_path_buf()),
        list_file: Some((list_path, format!("{}\n", entries.join("\n")))),
        output_duration,
        effective_mode: spec.mode,
        re_encoded: 0.0,
    })
}

/// The packet count of a clip whose both edges sit on keyframes, which is what
/// lets a copy stop exactly at the second one rather than a frame or two past
/// it. Nothing when either edge is off a keyframe or the index is unknown: the
/// copy then falls back to a time bound and starts where the seek lands.
fn aligned_frames(clip: &Clip, source: &MediaSource, index: Option<&Keyframes>) -> Option<u64> {
    let index = index?;
    let frame = 1.0 / frame_rate(source);
    let start = index.at_or_after(clip.source.start().seconds())?;
    if (start.at - clip.source.start().seconds()).abs() > 1e-3 {
        return None;
    }

    let end = clip.source.end().seconds();
    let end_index = if end >= source.duration.seconds() - 0.5 * frame {
        index.packets
    } else {
        let key = index.last_at_or_before(end)?;
        if (key.at - end).abs() > 1e-3 {
            return None;
        }
        key.index
    };

    (end_index > start.index).then_some(end_index - start.index)
}

/// One stretch of the finished picture, in output order.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Piece {
    /// Whole groups of pictures, copied packet for packet.
    Copy {
        keyframe: Keyframe,
        frames: u64,
        /// Drop the leading pictures of the first group, which refer back to a
        /// group this piece does not carry.
        strip_leading: bool,
        /// How long the piece is on screen. Stated in the concat list rather
        /// than measured off the file, whose estimate comes up a frame short.
        declared: f64,
    },
    /// Frames re-encoded from the source, from the first at or after `start`
    /// to the last before `end`.
    Encode { start: f64, end: f64, ends_on_keyframe: bool, declared: f64 },
    /// A hole, drawn black.
    Gap { duration: f64 },
}

impl Piece {
    fn declared(&self) -> f64 {
        match *self {
            Piece::Copy { declared, .. } | Piece::Encode { declared, .. } => declared,
            Piece::Gap { duration } => duration,
        }
    }
}

fn frame_rate(source: &MediaSource) -> f64 {
    source.video.as_ref().map(|v| v.frame_rate).filter(|r| *r > 0.1).unwrap_or(30.0)
}

/// Breaks the whole timeline into pieces, holes included.
fn pieces_for(edit: &EditList, source: &MediaSource, index: &Keyframes) -> Vec<Piece> {
    let mut pieces = Vec::new();
    for segment in edit.segments() {
        match segment {
            Segment::Media(clip) => pieces.extend(pieces_for_clip(&clip, source, index)),
            Segment::Gap(range) => pieces.push(Piece::Gap { duration: range.duration() }),
        }
    }
    pieces
}

/// Breaks one clip into what can be copied and what has to be re-encoded.
///
/// A copy can only begin on a keyframe and only end just before one, so a clip
/// becomes up to three pieces: the frames from its start to the first keyframe
/// inside it, re-encoded; the whole groups of pictures between that keyframe
/// and the last one inside it, copied; and the frames from there to its end,
/// re-encoded. A cut placed on a keyframe by snapping leaves its end piece out,
/// so a snapped edit copies everything and costs nothing at all.
///
/// An open group of pictures complicates the copied stretch: its keyframe is
/// followed in the file by a few pictures that are shown *before* it and refer
/// to the group behind. They cannot be decoded without it, so for HEVC they are
/// stripped from the first group copied, and the pictures leading the keyframe
/// that ends the copy are re-encoded with the tail, since they are stored after
/// the point where the copy stops. H.264 gives its leading pictures no name a
/// filter could drop them by, so an H.264 clip that would have to start a copy
/// on such a keyframe is re-encoded whole instead.
fn pieces_for_clip(clip: &Clip, source: &MediaSource, index: &Keyframes) -> Vec<Piece> {
    let frame = 1.0 / frame_rate(source);
    let hevc = source.video.as_ref().is_some_and(|v| v.codec == "hevc");
    let Some(first) = index.entries.first() else {
        return Vec::new();
    };

    // Nothing exists before the first picture, whatever the timeline says.
    let start = clip.source.start().seconds().max(first.at);
    let end = clip.source.end().seconds();
    if end - start < 0.5 * frame {
        return Vec::new();
    }
    let whole = |start: f64, end: f64| Piece::Encode {
        start,
        end,
        ends_on_keyframe: false,
        declared: end - start,
    };

    let runs_to_end = end >= source.duration.seconds() - 0.5 * frame;
    let Some(first_key) = index.at_or_after(start).filter(|key| key.at < end - 1e-3) else {
        return vec![whole(start, end)];
    };
    if first_key.leading > 0 && !hevc {
        return vec![whole(start, end)];
    }

    // Where the copied stretch stops: at the last keyframe inside the clip, or
    // at the last packet of the file when the clip reaches its end.
    let last_key = if runs_to_end {
        None
    } else {
        match index.last_at_or_before(end).filter(|key| key.index > first_key.index) {
            Some(key) => Some(*key),
            // A single group of pictures or less: not worth three processes.
            None => return vec![whole(start, end)],
        }
    };
    let body_end_index = last_key.map(|key| key.index).unwrap_or(index.packets);
    let body_end_at = last_key.map(|key| key.lead_start).unwrap_or(source.duration.seconds());

    let mut pieces = Vec::with_capacity(4);

    if first_key.at - start >= 0.75 * frame {
        pieces.push(Piece::Encode {
            start,
            end: first_key.at,
            ends_on_keyframe: true,
            declared: first_key.at - start,
        });
    }

    if first_key.leading > 0 {
        // HEVC, open group: the first group alone, with its leading pictures
        // dropped, and the rest of the stretch whole. The first group is
        // declared keyframe to keyframe, not up to the last picture it shows,
        // because the second group's leading pictures are shown inside that
        // span and have to land there.
        let leading = u64::from(first_key.leading);
        match index.after(first_key).filter(|next| next.index < body_end_index) {
            Some(next) => {
                push_copy(
                    &mut pieces,
                    *first_key,
                    next.index - first_key.index - leading,
                    true,
                    next.at - first_key.at,
                );
                push_copy(
                    &mut pieces,
                    *next,
                    body_end_index - next.index,
                    false,
                    body_end_at - next.at,
                );
            }
            None => push_copy(
                &mut pieces,
                *first_key,
                body_end_index - first_key.index - leading,
                true,
                body_end_at - first_key.at,
            ),
        }
    } else {
        push_copy(
            &mut pieces,
            *first_key,
            body_end_index - first_key.index,
            false,
            body_end_at - first_key.at,
        );
    }

    if let Some(last_key) = last_key {
        if end - last_key.lead_start >= 0.5 * frame {
            pieces.push(Piece::Encode {
                start: last_key.lead_start,
                end,
                ends_on_keyframe: false,
                declared: end - last_key.lead_start,
            });
        }
    }

    pieces
}

fn push_copy(
    pieces: &mut Vec<Piece>,
    keyframe: Keyframe,
    frames: u64,
    strip_leading: bool,
    declared: f64,
) {
    if frames == 0 || declared <= 0.0 {
        return;
    }
    pieces.push(Piece::Copy { keyframe, frames, strip_leading, declared });
}

/// Copies what can be copied, re-encodes the rest, and joins the pieces with a
/// freshly encoded sound track.
fn smart_plan(
    source: &MediaSource,
    pieces: &[Piece],
    spec: &ExportSpec,
    capabilities: &Capabilities,
    output: &Path,
    temp_dir: &Path,
) -> ExportPlan {
    let mut steps = Vec::with_capacity(pieces.len() + 1);
    let mut entries = Vec::with_capacity(pieces.len());
    let mut parts: Vec<AudioPart> = Vec::new();
    let mut re_encoded = 0.0;

    for (position, piece) in pieces.iter().enumerate() {
        let path = temp_dir.join(format!("piece-{position:04}.{PIECE_EXTENSION}"));
        let declared = piece.declared();

        let (args, weight, part_start) = match *piece {
            Piece::Copy { keyframe, frames, strip_leading, .. } => (
                transcoder::copy_piece_args(
                    &source.path,
                    keyframe.at,
                    frames,
                    strip_leading,
                    &path,
                ),
                declared * COPY_COST,
                Some(keyframe.at),
            ),
            Piece::Encode { start, end, ends_on_keyframe, .. } => {
                re_encoded += declared;
                (
                    transcoder::encode_piece_args(
                        source,
                        start,
                        end,
                        ends_on_keyframe,
                        capabilities,
                        spec.backend,
                        &path,
                    ),
                    declared,
                    Some(start),
                )
            }
            Piece::Gap { duration } => (
                transcoder::gap_piece_args(source, duration, capabilities, spec.backend, &path),
                duration * GAP_COST,
                None,
            ),
        };

        steps.push(ExportStep { args, weight, reported_duration: declared });
        entries.push(transcoder::concat_list_entry_with_duration(&path, declared));

        // The sound follows the pieces, not the clips: a clip whose first frame
        // was dropped as too short starts its sound where its first piece does,
        // or the two drift apart by that much.
        match (part_start, parts.last_mut()) {
            (None, _) => parts.push(AudioPart::Silence { duration: declared }),
            (Some(start), Some(AudioPart::Source { start: previous, duration }))
                if (*previous + *duration - start).abs() < 1e-6 =>
            {
                *duration += declared;
            }
            (Some(start), _) => parts.push(AudioPart::Source { start, duration: declared }),
        }
    }

    let output_duration: f64 = pieces.iter().map(Piece::declared).sum();
    let list_path = temp_dir.join("pieces.txt");
    steps.push(ExportStep {
        args: transcoder::smart_join_args(&list_path, source, &parts, spec, output),
        weight: output_duration * JOIN_COST,
        reported_duration: output_duration,
    });

    ExportPlan {
        steps,
        temp_dir: Some(temp_dir.to_path_buf()),
        list_file: Some((list_path, format!("{}\n", entries.join("\n")))),
        output_duration,
        effective_mode: ExportMode::Fast,
        re_encoded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::export::{EncoderBackend, UpscaleAlgorithm};
    use crate::domain::media::{AudioStream, MediaKind, MediaSource, Playability, VideoStream};
    use crate::domain::time::{Instant, TimeRange};

    fn capabilities() -> Capabilities {
        Capabilities {
            encoders: vec!["libx264".into(), "h264_nvenc".into(), "libx265".into()],
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
            max_duration: Instant::new(60.0).unwrap(),
            kind: MediaKind::Motion,
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
                profile: None,
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

    /// A keyframe every two seconds, closed groups, sixty packets each.
    fn index() -> Keyframes {
        Keyframes {
            entries: (0..30)
                .map(|i| Keyframe {
                    at: i as f64 * 2.0,
                    index: i * 60,
                    leading: 0,
                    lead_start: i as f64 * 2.0,
                })
                .collect(),
            packets: 1800,
            truncated: false,
        }
    }

    /// The same file as HEVC with open groups: two leading pictures after every
    /// keyframe but the first.
    fn open_gop_index() -> Keyframes {
        let mut index = index();
        for key in index.entries.iter_mut().skip(1) {
            key.leading = 2;
            key.lead_start = key.at - 2.0 / 30.0;
        }
        index
    }

    fn hevc() -> MediaSource {
        let mut source = source();
        if let Some(video) = source.video.as_mut() {
            video.codec = "hevc".into();
        }
        source
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
        plan_with(&source(), edit, spec, &[])
    }

    fn plan_with(
        source: &MediaSource,
        edit: &EditList,
        spec: ExportSpec,
        cut_points: &[Option<Keyframes>],
    ) -> ExportPlan {
        plan(
            std::slice::from_ref(source),
            edit,
            &spec,
            &capabilities(),
            Path::new("C:/out/final.mp4"),
            Path::new("C:/tmp"),
            "job1",
            cut_points,
        )
        .unwrap()
    }

    fn pair(args: &[String], flag: &str) -> Option<String> {
        args.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
    }

    fn copies(step: &ExportStep) -> bool {
        step.args.iter().any(|a| a == "copy")
    }

    #[test]
    fn a_single_piece_copy_writes_straight_to_the_destination() {
        let edit = EditList::contiguous(vec![TimeRange::from_seconds(5.0, 20.0).unwrap()]).unwrap();
        let plan = make_plan(&edit, ExportSpec::fast());

        assert_eq!(plan.steps.len(), 1);
        assert!(plan.temp_dir.is_none(), "one piece needs no scratch space");
        assert!(plan.list_file.is_none());
        assert_eq!(plan.steps[0].args.last().unwrap(), "C:/out/final.mp4");
        assert_eq!(plan.re_encoded, 0.0);
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
            &[],
        )
        .unwrap();

        let (_, contents) = plan.list_file.unwrap();
        assert!(
            contents.contains("part-0000.mkv"),
            "a copied segment must stay in a container that can hold the codec"
        );
    }

    /// Without a keyframe index there is nothing to draw a hole beside, so the
    /// old rule holds: the whole export is re-encoded.
    #[test]
    fn a_hole_forces_a_re_encode_when_the_cut_points_are_unknown() {
        let plan = make_plan(&gapped(), ExportSpec::fast());

        assert_eq!(plan.effective_mode, ExportMode::Precise);
        assert_eq!(plan.steps.len(), 1);
        assert!(plan.temp_dir.is_none());
        assert!(
            plan.steps[0].args.iter().any(|a| a.contains("color=c=black")),
            "the hole has to be synthesised"
        );
        assert_eq!(plan.output_duration, 30.0);
        assert_eq!(plan.re_encoded, 30.0);
    }

    /// With the index the hole is one drawn piece between two copied ones, and
    /// the footage itself is never touched.
    #[test]
    fn a_hole_is_drawn_between_copied_pieces_when_the_file_allows_it() {
        let plan = plan_with(&source(), &gapped(), ExportSpec::fast(), &[Some(index())]);

        assert_eq!(plan.effective_mode, ExportMode::Fast);
        // Copy, gap, copy, join.
        assert_eq!(plan.steps.len(), 4);
        assert!(copies(&plan.steps[0]));
        assert!(plan.steps[1].args.iter().any(|a| a.starts_with("color=c=black")));
        assert!(copies(&plan.steps[2]));
        assert_eq!(plan.re_encoded, 0.0, "black is drawn, not footage re-encoded");

        let join = &plan.steps[3].args;
        assert!(join.contains(&"concat".to_string()));
        assert!(join.iter().any(|a| a.contains("anullsrc")), "silence under the hole");
        assert!(join.iter().any(|a| a.contains("concat=n=3:v=0:a=1")));
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
            &[],
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
            &[],
        )
        .unwrap();

        assert_ne!(a.temp_dir, b.temp_dir, "concurrent exports must not share scratch space");
    }

    /// The ordinary edit: a cut that lands between keyframes. The frames from
    /// the cut to the next keyframe are re-encoded, the groups after it are
    /// copied, and the frames after the last keyframe are re-encoded again.
    #[test]
    fn an_off_keyframe_clip_becomes_head_body_and_tail() {
        let edit = EditList::contiguous(vec![TimeRange::from_seconds(4.5, 10.5).unwrap()]).unwrap();
        let plan = plan_with(&source(), &edit, ExportSpec::fast(), &[Some(index())]);

        assert_eq!(plan.effective_mode, ExportMode::Fast);
        assert_eq!(plan.steps.len(), 4, "head, body, tail, join");

        let head = &plan.steps[0].args;
        assert_eq!(pair(head, "-ss").unwrap(), "4.500000");
        assert!(!copies(&plan.steps[0]));
        // Stops a quarter of a frame short of the keyframe at six seconds.
        let head_length: f64 = pair(head, "-t").unwrap().parse().unwrap();
        assert!(head_length > 1.49 && head_length < 1.5, "got {head_length}");

        let body = &plan.steps[1].args;
        assert!(copies(&plan.steps[1]));
        assert_eq!(pair(body, "-frames:v").unwrap(), "120", "two whole groups, six to ten");
        assert_eq!(pair(body, "-copypriorss").unwrap(), "0");
        let seek: f64 = pair(body, "-ss").unwrap().parse().unwrap();
        assert!(seek < 6.0 && seek > 5.99, "asked for a hair before the keyframe, got {seek}");

        let tail = &plan.steps[2].args;
        assert_eq!(pair(tail, "-ss").unwrap(), "10.000000");
        assert_eq!(pair(tail, "-t").unwrap(), "0.500000");

        assert!((plan.re_encoded - 2.0).abs() < 1e-6, "one and a half seconds plus half a second");
        assert!((plan.output_duration - 6.0).abs() < 1e-6);

        let (_, list) = plan.list_file.as_ref().unwrap();
        assert!(list.contains("duration 1.500000"));
        assert!(list.contains("duration 4.000000"));
        assert!(list.contains("duration 0.500000"));
        assert!(list.contains(".ts'"), "pieces go through a transport stream");
    }

    /// The sound is one continuous track, read exactly where the pieces are.
    #[test]
    fn the_join_reads_sound_for_each_clip_and_encodes_it_once() {
        let edit = EditList::contiguous(vec![
            TimeRange::from_seconds(4.5, 10.5).unwrap(),
            TimeRange::from_seconds(20.0, 30.0).unwrap(),
        ])
        .unwrap();
        let plan = plan_with(&source(), &edit, ExportSpec::fast(), &[Some(index())]);

        let join = plan.steps.last().unwrap();
        let args = &join.args;
        assert!(args.iter().any(|a| a == "concat"), "the pieces are read through the list");
        assert_eq!(
            args.iter().filter(|a| *a == "-i").count(),
            3,
            "the list and one input per clip"
        );
        assert_eq!(pair(args, "-c:v").unwrap(), "copy");
        assert_eq!(pair(args, "-c:a").unwrap(), "aac");

        let graph = pair(args, "-filter_complex").unwrap();
        assert!(graph.contains("apad=whole_dur=6.000000"));
        assert!(graph.contains("apad=whole_dur=10.000000"));
        assert!(graph.contains("concat=n=2:v=0:a=1[aout]"));
    }

    /// A cut on both keyframes needs nothing re-encoded, so the plain copy runs
    /// and the sound is copied along with the picture.
    #[test]
    fn a_snapped_edit_is_a_plain_copy_bounded_by_packet_count() {
        let plan = plan_with(&source(), &joined(), ExportSpec::fast(), &[Some(index())]);

        assert_eq!(plan.steps.len(), 3, "two copies and a stitch, as before");
        assert_eq!(plan.re_encoded, 0.0);
        assert_eq!(pair(&plan.steps[0].args, "-frames:v").unwrap(), "300");
        assert_eq!(pair(&plan.steps[1].args, "-frames:v").unwrap(), "300");
        assert!(
            plan.steps[0].args.contains(&"0:a:0?".to_string()),
            "sound travels with the picture"
        );
    }

    /// The last clip runs to the end of the file: the copy stops at the last
    /// packet, and nothing after the last keyframe is re-encoded.
    #[test]
    fn a_clip_reaching_the_end_of_the_file_copies_to_the_last_packet() {
        let edit = EditList::contiguous(vec![TimeRange::from_seconds(4.5, 60.0).unwrap()]).unwrap();
        let plan = plan_with(&source(), &edit, ExportSpec::fast(), &[Some(index())]);

        assert_eq!(plan.steps.len(), 3, "head, body, join");
        assert_eq!(pair(&plan.steps[1].args, "-frames:v").unwrap(), "1620", "packets 180 to 1800");
        assert!((plan.re_encoded - 1.5).abs() < 1e-6);
    }

    /// A clip shorter than a group of pictures is re-encoded whole rather than
    /// split into three processes for two seconds of video.
    #[test]
    fn a_clip_within_one_group_is_re_encoded_whole() {
        let edit = EditList::contiguous(vec![TimeRange::from_seconds(4.5, 6.5).unwrap()]).unwrap();
        let plan = plan_with(&source(), &edit, ExportSpec::fast(), &[Some(index())]);

        assert_eq!(plan.steps.len(), 2, "one encode and the join");
        assert_eq!(pair(&plan.steps[0].args, "-t").unwrap(), "2.000000");
        assert!((plan.re_encoded - 2.0).abs() < 1e-6);
    }

    /// HEVC with open groups: the first copied group loses its leading pictures
    /// and is declared keyframe to keyframe, the rest is copied whole, and the
    /// tail begins on the leading pictures of the keyframe that ends the copy,
    /// which are stored after it.
    #[test]
    fn an_open_gop_hevc_clip_strips_the_leading_pictures_of_the_first_group() {
        let edit = EditList::contiguous(vec![TimeRange::from_seconds(4.5, 10.5).unwrap()]).unwrap();
        let plan = plan_with(&hevc(), &edit, ExportSpec::fast(), &[Some(open_gop_index())]);

        assert_eq!(plan.steps.len(), 5, "head, first group, rest, tail, join");

        let first_group = &plan.steps[1].args;
        assert_eq!(pair(first_group, "-frames:v").unwrap(), "58", "sixty packets less two leading");
        assert!(pair(first_group, "-bsf:v").unwrap().contains("remove_types=6-9"));

        let rest = &plan.steps[2].args;
        assert_eq!(pair(rest, "-frames:v").unwrap(), "60");
        assert!(pair(rest, "-bsf:v").is_none(), "later groups keep their leading pictures");

        let tail = &plan.steps[3].args;
        let tail_start: f64 = pair(tail, "-ss").unwrap().parse().unwrap();
        assert!((tail_start - (10.0 - 2.0 / 30.0)).abs() < 1e-5, "got {tail_start}");

        let (_, list) = plan.list_file.as_ref().unwrap();
        assert!(
            list.contains("duration 2.000000"),
            "the first group is declared keyframe to keyframe"
        );
    }

    /// H.264 has no name for its leading pictures, so a copy cannot start on an
    /// open group: the clip is re-encoded whole, and the export still succeeds.
    #[test]
    fn an_open_gop_h264_clip_is_re_encoded_rather_than_copied_broken() {
        let edit = EditList::contiguous(vec![TimeRange::from_seconds(4.5, 10.5).unwrap()]).unwrap();
        let plan = plan_with(&source(), &edit, ExportSpec::fast(), &[Some(open_gop_index())]);

        assert_eq!(plan.steps.len(), 2, "one encode and the join");
        assert!((plan.re_encoded - 6.0).abs() < 1e-6);
    }

    /// A file whose packets cannot be joined with drawn ones keeps the old
    /// rules: a hole means a re-encode, and an off-keyframe cut is copied from
    /// the keyframe before it.
    #[test]
    fn an_unsupported_codec_falls_back_to_the_old_copy() {
        let mut source = source();
        if let Some(video) = source.video.as_mut() {
            video.codec = "vp9".into();
        }
        let edit = EditList::contiguous(vec![TimeRange::from_seconds(4.5, 10.5).unwrap()]).unwrap();
        let plan = plan_with(&source, &edit, ExportSpec::fast(), &[Some(index())]);
        assert_eq!(plan.steps.len(), 1);
        assert!(copies(&plan.steps[0]));
        assert!(pair(&plan.steps[0].args, "-frames:v").is_none(), "no keyframe to count from");

        let plan = plan_with(&source, &gapped(), ExportSpec::fast(), &[Some(index())]);
        assert_eq!(plan.effective_mode, ExportMode::Precise);
    }

    /// A rotated phone clip: the pieces carry no display matrix, so the join
    /// restates it, in the sign the probe read it in.
    #[test]
    fn a_rotated_source_has_its_rotation_restated_on_the_join() {
        let mut source = source();
        if let Some(video) = source.video.as_mut() {
            video.rotation = 90;
        }
        let edit = EditList::contiguous(vec![TimeRange::from_seconds(4.5, 10.5).unwrap()]).unwrap();
        let plan = plan_with(&source, &edit, ExportSpec::fast(), &[Some(index())]);

        let join = plan.steps.last().unwrap();
        assert_eq!(pair(&join.args, "-display_rotation").unwrap(), "-90");
        assert!(plan.steps[0].args.contains(&"-noautorotate".to_string()), "pixels stay as stored");
    }
}
