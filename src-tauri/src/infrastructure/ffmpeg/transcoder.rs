use std::path::Path;

use crate::domain::edl::EditList;
use crate::domain::export::{ExportSpec, VideoCodec};
use crate::domain::media::MediaSource;

use super::capabilities::Capabilities;
use super::encoding;
use super::filtergraph::{self, GraphOptions, AUDIO_OUT, VIDEO_OUT};

/// Frame rate a still's preview copy is encoded at.
///
/// Low on purpose: nothing moves, so every frame after the first is skipped by
/// the encoder anyway, and a lower rate is a shorter encode and a smaller file.
/// Not lower than this, because a coarse rate makes the playhead visibly step
/// while scrubbing.
const PROXY_STILL_FRAME_RATE: f64 = 15.0;

/// Longest edge a preview proxy is allowed to have.
///
/// The proxy exists to be scrubbed, not admired. Capping it keeps the transcode
/// short and the seek responsive; the export always reads the original file.
const PROXY_MAX_EDGE: u32 = 1280;

/// Builds the argument vector for a re-encoding export.
///
/// Arguments are returned rather than executed so the whole command can be unit
/// tested without touching a disk or spawning a process.
pub fn precise_export_args(
    media: &[MediaSource],
    edit: &EditList,
    spec: &ExportSpec,
    capabilities: &Capabilities,
    output: &Path,
) -> Vec<String> {
    let options = GraphOptions::from_media(media, spec);
    let graph = filtergraph::build(edit, &options);
    let encoder = capabilities.resolve_encoder(spec.codec, spec.backend);

    let mut args = base_args();
    // One input per medium, in table order: a clip's `media` index is its
    // input index in the graph, so the two lists must not be reordered apart.
    for (index, source) in media.iter().enumerate() {
        args.extend(still_input_args(source, edit, index, options.frame_rate));
        args.extend(["-i".into(), source.path.clone()]);
    }
    args.extend(["-filter_complex".into(), graph]);
    args.extend(["-map".into(), format!("[{VIDEO_OUT}]")]);

    if options.include_audio {
        args.extend(["-map".into(), format!("[{AUDIO_OUT}]")]);
    }

    args.extend(["-c:v".into(), encoder.to_string()]);
    args.extend(encoding::rate_control(encoder, spec.quality));
    args.extend(["-pix_fmt".into(), options.pixel_format.to_string()]);

    // The graph already emits a constant frame rate, so a second conversion here
    // would only duplicate or drop frames.
    args.extend(["-fps_mode".into(), "passthrough".into()]);

    // Rotation was baked into the pixels by the graph. Leaving a stale display
    // matrix behind would make players rotate the result a second time.
    args.extend(["-metadata:s:v:0".into(), "rotate=0".into()]);

    if options.include_audio {
        args.extend(["-c:a".into(), "aac".into()]);
        // The first medium sets the output format, so its bit rate is the one
        // worth matching.
        let bitrate = encoding::audio_bitrate(
            media[0].audio.as_ref().and_then(|a| a.bit_rate),
            options.channels,
        );
        args.extend(["-b:a".into(), bitrate.to_string()]);
    } else {
        args.push("-an".into());
    }

    args.extend(container_args(output));
    args.extend(progress_args());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// Input options that turn a single frame into a stream the graph can trim.
///
/// A still holds one packet. Without `-loop` the `trim` in the filter graph runs
/// out after that one frame and the segment collapses to nothing, so a five
/// second title card exports as a blink. `-t` is what bounds the loop: an
/// infinite input has no end of its own and would keep the graph running after
/// every other segment had finished.
///
/// The bound is the furthest into the still any clip reaches, plus a frame of
/// margin, because `trim` reads the timestamp *before* its end and an input that
/// stops exactly there can come up one frame short.
fn still_input_args(
    source: &MediaSource,
    edit: &EditList,
    index: usize,
    frame_rate: f64,
) -> Vec<String> {
    if !source.is_still() {
        return Vec::new();
    }

    let rate = if frame_rate > 0.1 { frame_rate } else { 30.0 };
    let needed = edit
        .clips()
        .iter()
        .filter(|clip| clip.media == index)
        .map(|clip| clip.source.end().seconds())
        .fold(0.0_f64, f64::max)
        + 2.0 / rate;

    vec![
        "-loop".into(),
        "1".into(),
        "-framerate".into(),
        format!("{rate:.6}"),
        "-t".into(),
        format!("{needed:.6}"),
    ]
}

/// Builds the arguments that copy one range of the source without re-encoding.
///
/// The input seek sits before `-i`, which makes FFmpeg jump straight to the
/// nearest preceding keyframe instead of decoding everything up to the cut. That
/// is what makes this mode finish at disk speed, and also why the cut lands on a
/// keyframe rather than the exact requested frame.
pub fn copy_segment_args(
    source_path: &str,
    start: f64,
    duration: f64,
    output: &Path,
) -> Vec<String> {
    let mut args = base_args();
    args.extend(["-ss".into(), format!("{start:.6}")]);
    args.extend(["-i".into(), source_path.to_string()]);
    args.extend(["-t".into(), format!("{duration:.6}")]);

    // Only the primary video and audio streams are carried across. `?` makes the
    // audio mapping optional so a silent source does not fail the command.
    args.extend(["-map".into(), "0:v:0".into()]);
    args.extend(["-map".into(), "0:a:0?".into()]);
    args.extend(["-c".into(), "copy".into()]);

    // A keyframe-aligned cut can leave the first packets with negative
    // timestamps; rebasing them keeps the result seekable.
    args.extend(["-avoid_negative_ts".into(), "make_zero".into()]);

    args.extend(container_args(output));
    args.extend(progress_args());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// Builds the arguments that stitch previously copied segments into one file.
pub fn concat_copy_args(list_file: &Path, output: &Path) -> Vec<String> {
    let mut args = base_args();
    args.extend(["-f".into(), "concat".into()]);
    // The list is written by this application into a private temporary
    // directory, never supplied by the user, so relaxing the path check is safe
    // and is required for absolute Windows paths.
    args.extend(["-safe".into(), "0".into()]);
    args.extend(["-i".into(), list_file.to_string_lossy().into_owned()]);
    args.extend(["-c".into(), "copy".into()]);
    args.extend(container_args(output));
    args.extend(progress_args());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// Builds the arguments for a scrubbing proxy.
///
/// Speed beats quality here by a wide margin, so this uses the fastest preset
/// available and a coarse quality target.
pub fn proxy_args(source: &MediaSource, capabilities: &Capabilities, output: &Path) -> Vec<String> {
    let encoder =
        capabilities.resolve_encoder(VideoCodec::H264, crate::domain::export::EncoderBackend::Auto);

    let mut args = base_args();

    // A still is encoded as a clip of its own longest allowed length, so the
    // preview and the filmstrip work on it exactly as they do on a video and
    // scrubbing can never run past the end of the picture.
    if source.is_still() {
        args.extend(["-loop".into(), "1".into()]);
        args.extend(["-framerate".into(), format!("{PROXY_STILL_FRAME_RATE:.1}")]);
        args.extend(["-t".into(), format!("{:.3}", source.max_duration.seconds())]);
    }

    args.extend(["-i".into(), source.path.clone()]);
    args.extend(["-map".into(), "0:v:0".into()]);
    args.extend(["-map".into(), "0:a:0?".into()]);

    // Simple filtering auto-applies the display matrix, so the proxy comes out
    // the right way up without an explicit transpose.
    if let Some((width, height)) = proxy_size(source) {
        args.extend(["-vf".into(), format!("scale={width}:{height}:flags=bicubic")]);
    }

    args.extend(["-c:v".into(), encoder.to_string()]);
    args.extend(fast_proxy_rate_control(encoder));
    args.extend(["-pix_fmt".into(), "yuv420p".into()]);
    args.extend(["-c:a".into(), "aac".into()]);
    args.extend(["-b:a".into(), "128000".into()]);
    args.extend(["-ac".into(), "2".into()]);
    args.extend(["-movflags".into(), "+faststart".into()]);
    args.extend(progress_args());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// Proxy dimensions, or `None` when the source is already small enough.
fn proxy_size(source: &MediaSource) -> Option<(u32, u32)> {
    let video = source.video.as_ref()?;
    let (width, height) = video.display_size();
    let longest = width.max(height);
    if longest <= PROXY_MAX_EDGE || longest == 0 {
        return None;
    }

    let factor = PROXY_MAX_EDGE as f64 / longest as f64;
    let scaled = |value: u32| ((value as f64 * factor).round() as u32).max(2) & !1;
    Some((scaled(width), scaled(height)))
}

fn fast_proxy_rate_control(encoder: &str) -> Vec<String> {
    if encoder.ends_with("_nvenc") {
        vec![
            "-preset".into(),
            "p1".into(),
            "-rc".into(),
            "vbr".into(),
            "-cq".into(),
            "30".into(),
            "-b:v".into(),
            "0".into(),
        ]
    } else if encoder.ends_with("_qsv") {
        vec!["-preset".into(), "veryfast".into(), "-global_quality".into(), "30".into()]
    } else if encoder.ends_with("_amf") {
        vec![
            "-quality".into(),
            "speed".into(),
            "-rc".into(),
            "cqp".into(),
            "-qp_i".into(),
            "30".into(),
            "-qp_p".into(),
            "30".into(),
        ]
    } else {
        vec!["-preset".into(), "veryfast".into(), "-crf".into(), "28".into()]
    }
}

/// Arguments shared by every invocation.
///
/// `-nostdin` matters: without it FFmpeg competes for the parent's stdin and can
/// hang waiting on input that will never arrive.
fn base_args() -> Vec<String> {
    vec!["-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "error".into(), "-y".into()]
}

/// Machine-readable progress on stdout, with the human status line suppressed so
/// it cannot interleave with it.
fn progress_args() -> Vec<String> {
    vec!["-progress".into(), "pipe:1".into(), "-nostats".into()]
}

/// Container-specific muxer options.
fn container_args(output: &Path) -> Vec<String> {
    let extension =
        output.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();

    match extension.as_str() {
        // Moving the index to the front lets a player start before the whole
        // file has been read, which matters for anything later uploaded.
        "mp4" | "mov" | "m4v" => vec!["-movflags".into(), "+faststart".into()],
        _ => vec![],
    }
}

/// Escapes a path for FFmpeg's concat list format.
///
/// The format terminates a path at an unescaped quote, so a directory containing
/// one would otherwise truncate the entry and read a different file.
pub fn concat_list_entry(path: &Path) -> String {
    let escaped = path.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
    format!("file '{escaped}'")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::edl::Clip;
    use crate::domain::export::{EncoderBackend, ExportMode, QualityTarget};
    use crate::domain::media::{AudioStream, MediaKind, MediaSource, Playability, VideoStream};
    use crate::domain::time::{Instant, TimeRange};

    fn still(path: &str) -> MediaSource {
        let mut source = source(false);
        source.path = path.into();
        source.kind = MediaKind::Still;
        source.duration = Instant::new(5.0).unwrap();
        source.max_duration = Instant::new(60.0).unwrap();
        source
    }

    fn capabilities() -> Capabilities {
        Capabilities {
            encoders: vec!["libx264".into(), "h264_nvenc".into(), "libx265".into()],
            filters: vec!["scale".into()],
            hardware_backends: vec![EncoderBackend::Nvenc],
            upscalers: vec![],
        }
    }

    fn source(with_audio: bool) -> MediaSource {
        MediaSource {
            path: "C:/clips/a b.mp4".into(),
            file_name: "a b.mp4".into(),
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
            }),
            audio: with_audio.then(|| AudioStream {
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

    fn edit() -> EditList {
        EditList::contiguous(vec![
            TimeRange::from_seconds(0.0, 10.0).unwrap(),
            TimeRange::from_seconds(20.0, 30.0).unwrap(),
        ])
        .unwrap()
    }

    fn spec() -> ExportSpec {
        ExportSpec {
            mode: ExportMode::Precise,
            quality: QualityTarget::MatchSource,
            ..ExportSpec::fast()
        }
        .reconciled(false)
    }

    fn pair(args: &[String], flag: &str) -> Option<String> {
        args.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
    }

    #[test]
    fn the_input_path_is_one_argument_and_is_never_quoted() {
        let args = precise_export_args(
            std::slice::from_ref(&source(true)),
            &edit(),
            &spec(),
            &capabilities(),
            Path::new("C:/out/result.mp4"),
        );
        assert_eq!(pair(&args, "-i").unwrap(), "C:/clips/a b.mp4");
        assert!(
            args.iter().all(|a| !a.starts_with('"')),
            "shell quoting has no meaning when arguments are passed as a vector"
        );
    }

    #[test]
    fn a_re_encoding_export_maps_the_graph_outputs() {
        let args = precise_export_args(
            std::slice::from_ref(&source(true)),
            &edit(),
            &spec(),
            &capabilities(),
            Path::new("out.mp4"),
        );
        assert!(args.contains(&"[vout]".to_string()));
        assert!(args.contains(&"[aout]".to_string()));
        assert_eq!(pair(&args, "-c:v").unwrap(), "h264_nvenc");
        assert_eq!(pair(&args, "-c:a").unwrap(), "aac");
    }

    #[test]
    fn a_silent_source_gets_no_audio_stream() {
        let args = precise_export_args(
            std::slice::from_ref(&source(false)),
            &edit(),
            &spec(),
            &capabilities(),
            Path::new("out.mp4"),
        );
        assert!(!args.contains(&"[aout]".to_string()));
        assert!(args.contains(&"-an".to_string()));
    }

    #[test]
    fn stale_rotation_metadata_is_cleared_after_baking_it_in() {
        let args = precise_export_args(
            std::slice::from_ref(&source(true)),
            &edit(),
            &spec(),
            &capabilities(),
            Path::new("out.mp4"),
        );
        assert_eq!(pair(&args, "-metadata:s:v:0").unwrap(), "rotate=0");
    }

    #[test]
    fn faststart_is_applied_to_mp4_only() {
        assert!(container_args(Path::new("a.mp4")).contains(&"+faststart".to_string()));
        assert!(container_args(Path::new("a.mkv")).is_empty());
        assert!(container_args(Path::new("A.MOV")).contains(&"+faststart".to_string()));
    }

    #[test]
    fn a_copy_seeks_before_the_input_so_it_does_not_decode() {
        let args = copy_segment_args("in.mkv", 20.0, 10.0, Path::new("part.mkv"));
        let seek = args.iter().position(|a| a == "-ss").unwrap();
        let input = args.iter().position(|a| a == "-i").unwrap();
        assert!(seek < input, "an output seek would decode everything before the cut");
        assert_eq!(pair(&args, "-t").unwrap(), "10.000000");
        assert!(args.contains(&"copy".to_string()));
    }

    #[test]
    fn a_copy_makes_the_audio_mapping_optional() {
        let args = copy_segment_args("in.mp4", 0.0, 5.0, Path::new("part.mp4"));
        assert!(args.contains(&"0:a:0?".to_string()), "a silent source must not fail the command");
    }

    #[test]
    fn concat_entries_escape_quotes_in_paths() {
        let entry = concat_list_entry(Path::new(r"C:\tmp\it's here\part.mp4"));
        assert_eq!(entry, r"file 'C:/tmp/it'\''s here/part.mp4'");
    }

    #[test]
    fn a_proxy_downscales_large_sources_only() {
        let mut small = source(true);
        if let Some(video) = small.video.as_mut() {
            video.width = 640;
            video.height = 360;
        }
        assert_eq!(proxy_size(&small), None);
        assert_eq!(proxy_size(&source(true)), Some((1280, 720)));
    }

    #[test]
    fn a_proxy_keeps_the_aspect_and_stays_even() {
        let mut portrait = source(true);
        if let Some(video) = portrait.video.as_mut() {
            video.width = 1080;
            video.height = 1921;
        }
        let (w, h) = proxy_size(&portrait).unwrap();
        assert_eq!(h, 1280);
        assert_eq!(w % 2, 0);
    }

    #[test]
    fn every_invocation_blocks_stdin() {
        assert!(base_args().contains(&"-nostdin".to_string()));
    }

    /// A still holds one packet. Without `-loop` the graph's `trim` runs out
    /// after that frame and a five second title card exports as a blink.
    #[test]
    fn a_still_is_looped_for_as_long_as_the_timeline_asks() {
        let media = vec![still("C:/art/card.png")];
        let edit = EditList::new(vec![Clip::new(
            0,
            TimeRange::from_seconds(0.0, 8.0).unwrap(),
            Instant::ZERO,
        )])
        .unwrap();

        let args = precise_export_args(
            &media,
            &edit,
            &ExportSpec::fast().reconciled(true),
            &capabilities(),
            Path::new("out.mp4"),
        );

        let loop_at = args.iter().position(|a| a == "-loop").expect("a still is looped");
        let input_at = args.iter().position(|a| a == "-i").expect("the still is an input");
        assert!(loop_at < input_at, "input options have to precede the input they apply to");

        // Bounded, or the looped input never ends and the graph runs after every
        // other segment has finished. A frame of margin, because `trim` reads
        // the timestamp before its end.
        let bound: f64 = args[args.iter().position(|a| a == "-t").unwrap() + 1].parse().unwrap();
        assert!(bound > 8.0, "the loop must reach the far edge of the longest clip");
        assert!(bound < 8.2, "and not run far past it");
    }

    #[test]
    fn moving_pictures_are_never_looped() {
        let media = vec![source(true)];
        let edit = EditList::new(vec![Clip::new(
            0,
            TimeRange::from_seconds(0.0, 8.0).unwrap(),
            Instant::ZERO,
        )])
        .unwrap();

        let args = precise_export_args(
            &media,
            &edit,
            &ExportSpec::fast().reconciled(true),
            &capabilities(),
            Path::new("out.mp4"),
        );
        assert!(!args.contains(&"-loop".to_string()));
    }

    /// The preview copy is built at the still's longest allowed length, so
    /// scrubbing can never run past the end of the picture.
    #[test]
    fn a_stills_proxy_covers_everything_it_can_be_stretched_to() {
        let args = proxy_args(&still("C:/art/card.png"), &capabilities(), Path::new("p.mp4"));
        assert!(args.contains(&"-loop".to_string()));
        let bound: f64 = args[args.iter().position(|a| a == "-t").unwrap() + 1].parse().unwrap();
        assert_eq!(bound, 60.0);
    }
}
