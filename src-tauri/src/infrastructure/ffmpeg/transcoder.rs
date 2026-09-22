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
///
/// `frames` is the packet count between the two keyframes the range sits on,
/// when it does and it is known. With it the copy begins on exactly that
/// keyframe and stops on exactly the packet before the next one; the time bound
/// alone lets the next group's first packets in, because their decode
/// timestamps come before their pictures, and they are then shown twice at the
/// seam. Without it the old, approximate behaviour stands.
pub fn copy_segment_args(
    source_path: &str,
    start: f64,
    duration: f64,
    frames: Option<u64>,
    output: &Path,
) -> Vec<String> {
    let mut args = base_args();
    match frames {
        Some(_) => {
            args.extend(["-ss".into(), format!("{:.6}", (start - COPY_SEEK_MARGIN).max(0.0))])
        }
        None => args.extend(["-ss".into(), format!("{start:.6}")]),
    }
    args.extend(["-i".into(), source_path.to_string()]);
    args.extend(["-t".into(), format!("{duration:.6}")]);

    // Only the primary video and audio streams are carried across. `?` makes the
    // audio mapping optional so a silent source does not fail the command.
    args.extend(["-map".into(), "0:v:0".into()]);
    args.extend(["-map".into(), "0:a:0?".into()]);
    args.extend(["-c".into(), "copy".into()]);

    if let Some(frames) = frames {
        args.extend(["-copypriorss".into(), "0".into()]);
        args.extend(["-frames:v".into(), frames.to_string()]);
    }

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

/// Container every piece of a joined-in-place export is written to.
///
/// MPEG-TS, not the destination's own container, because it carries the
/// parameter sets in-band before every keyframe. A copied stretch and a
/// re-encoded one share no header, and in a container that keeps one header
/// per track the second would be decoded with the first's and come out as
/// blocks. Going through a transport stream and remuxing at the end is the
/// route every TS-to-MP4 conversion already takes, so nothing here is novel.
pub const PIECE_EXTENSION: &str = "ts";

/// Bitstream filter that drops the leading pictures of an open group.
///
/// HEVC names them: RADL and RASL units are types 6 to 9, and they are the only
/// pictures a copy that starts on a keyframe cannot decode. H.264 has no such
/// name for them, which is why the planner re-encodes an H.264 clip that would
/// have to start on one instead of copying it.
const HEVC_LEADING_FILTER: &str = "filter_units=remove_types=6-9";

/// How far before a keyframe a copy is asked to begin, in seconds.
///
/// FFmpeg's seek lands on the last keyframe at or before the time it is given,
/// and the time is a decimal rounded from a rational, so asking for exactly the
/// keyframe risks landing one group of pictures early in a container whose
/// index rounds the other way. So it is asked for a hair earlier, on purpose,
/// and `-copypriorss 0` then discards everything before that time up to the
/// first keyframe past it — which is the one wanted, whichever side the seek
/// came down on.
const COPY_SEEK_MARGIN: f64 = 0.0005;

/// How far short of a keyframe a re-encoded piece is told to stop, in frames.
///
/// The bound is compared against a decimal that was rounded from the keyframe's
/// own timestamp, and a frame that lands exactly on the bound is a coin toss.
/// Stopping a quarter of a frame early excludes the keyframe, which the copied
/// piece after it begins with, and keeps every frame before it.
const ENCODE_END_MARGIN_FRAMES: f64 = 0.25;

/// Copies `frames` packets starting at a keyframe, into a transport stream.
///
/// Bounded by packet count rather than by time. With B-frames the decode
/// timestamps run ahead of the pictures, so a time bound lets the next group's
/// keyframe and a frame or two after it slip into the piece, where they are
/// shown a second time at the seam. The count of packets between two keyframes
/// is exact, and it is what the keyframe index records.
pub fn copy_piece_args(
    source_path: &str,
    keyframe_at: f64,
    frames: u64,
    strip_leading: bool,
    output: &Path,
) -> Vec<String> {
    let mut args = base_args();
    args.extend(["-ss".into(), format!("{:.6}", (keyframe_at - COPY_SEEK_MARGIN).max(0.0))]);
    args.extend(["-i".into(), source_path.to_string()]);
    args.extend(["-map".into(), "0:v:0".into()]);
    args.extend(["-c:v".into(), "copy".into()]);
    args.extend(["-copypriorss".into(), "0".into()]);
    args.extend(["-frames:v".into(), frames.to_string()]);
    if strip_leading {
        args.extend(["-bsf:v".into(), HEVC_LEADING_FILTER.into()]);
    }
    args.extend(["-f".into(), "mpegts".into()]);
    args.extend(progress_args());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// Re-encodes the frames of `[start, end)` into a transport stream that can sit
/// beside copied packets of the same file.
///
/// Nothing about the picture is changed: no scaling, no rotation (the display
/// matrix is put back on the finished file instead), the source's own pixel
/// format and colour tags, and its timestamps passed through rather than
/// regenerated. The seek is exact because the input is decoded, so the first
/// frame is the first one at or after `start`.
pub fn encode_piece_args(
    source: &MediaSource,
    start: f64,
    end: f64,
    ends_on_keyframe: bool,
    capabilities: &Capabilities,
    backend: crate::domain::export::EncoderBackend,
    output: &Path,
) -> Vec<String> {
    let video = source.video.as_ref();
    let frame_rate = video.map(|v| v.frame_rate).filter(|r| *r > 0.1).unwrap_or(30.0);
    let margin = if ends_on_keyframe { ENCODE_END_MARGIN_FRAMES / frame_rate } else { 0.0 };
    let duration = (end - start - margin).max(1.0 / frame_rate);
    let (encoder, pixel_format) = piece_encoder(source, capabilities, backend, duration);

    let mut args = base_args();
    // The pixels stay the way they are stored, exactly like the copied ones
    // beside them; rotation is metadata on the finished file.
    args.extend(["-noautorotate".into()]);
    args.extend(["-ss".into(), format!("{start:.6}")]);
    args.extend(["-t".into(), format!("{duration:.6}")]);
    args.extend(["-i".into(), source.path.clone()]);
    args.extend(["-map".into(), "0:v:0".into()]);
    args.extend(piece_encoder_args(encoder, &pixel_format, video));
    args.extend(["-fps_mode".into(), "passthrough".into()]);
    args.extend(["-f".into(), "mpegts".into()]);
    args.extend(progress_args());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// Draws a hole as black frames in the source's own format.
///
/// The stored size rather than the displayed one: the copied packets beside it
/// are stored unrotated too, and the display matrix put on the finished file
/// turns both the same way.
pub fn gap_piece_args(
    source: &MediaSource,
    duration: f64,
    capabilities: &Capabilities,
    backend: crate::domain::export::EncoderBackend,
    output: &Path,
) -> Vec<String> {
    let video = source.video.as_ref();
    let (width, height) = video.map(|v| (v.width, v.height)).unwrap_or((1920, 1080));
    let frame_rate = video.map(|v| v.frame_rate).filter(|r| *r > 0.1).unwrap_or(30.0);
    let (encoder, pixel_format) = piece_encoder(source, capabilities, backend, duration);

    let mut args = base_args();
    args.extend(["-f".into(), "lavfi".into()]);
    args.extend([
        "-i".into(),
        format!("color=c=black:s={width}x{height}:r={frame_rate:.6}:d={duration:.6}"),
    ]);
    args.extend(piece_encoder_args(encoder, &pixel_format, video));
    args.extend(["-f".into(), "mpegts".into()]);
    args.extend(progress_args());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// One stretch of the finished sound track, in output order.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AudioPart {
    /// Sound read from the source between two instants.
    Source { start: f64, duration: f64 },
    /// Silence, under a hole.
    Silence { duration: f64 },
}

/// Joins the pieces into the destination and lays a freshly encoded sound track
/// under them.
///
/// The video is copied out of the concatenated pieces untouched. The sound is
/// re-encoded as one continuous track rather than copied piece by piece: a
/// compressed audio packet is twenty milliseconds long and cannot be cut
/// inside, so copying would put every seam up to that far out of step, and a
/// separate encode at every piece would leave the encoder's start-up gap at each
/// one. Reading each stretch through its own seeked input keeps the work
/// proportional to what is kept, not to the length of the file.
pub fn smart_join_args(
    list_file: &Path,
    source: &MediaSource,
    parts: &[AudioPart],
    spec: &ExportSpec,
    output: &Path,
) -> Vec<String> {
    let options = GraphOptions::from_source(source, spec);
    let with_audio = options.include_audio && !parts.is_empty();

    let mut args = base_args();

    // The pieces carry no display matrix, a transport stream having nowhere to
    // put one, so the source's is restated here. `-display_rotation` takes the
    // angle the way the probe read it, before it was turned into the clockwise
    // number the editor uses.
    if let Some(rotation) = video_rotation(source) {
        args.extend(["-display_rotation".into(), rotation.to_string()]);
    }
    args.extend(["-f".into(), "concat".into()]);
    args.extend(["-safe".into(), "0".into()]);
    args.extend(["-i".into(), list_file.to_string_lossy().into_owned()]);

    if with_audio {
        let mut chains: Vec<String> = Vec::with_capacity(parts.len() + 1);
        let mut labels = String::new();
        let mut input = 1usize;

        for (index, part) in parts.iter().enumerate() {
            match *part {
                AudioPart::Source { start, duration } => {
                    args.extend(["-ss".into(), format!("{start:.6}")]);
                    args.extend(["-t".into(), format!("{duration:.6}")]);
                    args.extend(["-i".into(), source.path.clone()]);
                    // Padded and then trimmed to exactly the length of the
                    // picture it sits under. A sound track that ends before the
                    // video does, as a screen recording's often does, would
                    // otherwise pull everything after it out of step.
                    chains.push(format!(
                        "[{input}:a]asetpts=PTS-STARTPTS,apad=whole_dur={duration:.6},atrim=end={duration:.6},{}[a{index}]",
                        filtergraph::audio_format(&options)
                    ));
                    input += 1;
                }
                AudioPart::Silence { duration } => {
                    chains.push(format!(
                        "{}[a{index}]",
                        filtergraph::gap_audio_chain(duration, &options)
                    ));
                }
            }
            labels.push_str(&format!("[a{index}]"));
        }

        chains.push(format!("{labels}concat=n={}:v=0:a=1[{AUDIO_OUT}]", parts.len()));
        args.extend(["-filter_complex".into(), chains.join(";")]);
    }

    args.extend(["-map".into(), "0:v:0".into()]);
    args.extend(["-c:v".into(), "copy".into()]);

    if with_audio {
        args.extend(["-map".into(), format!("[{AUDIO_OUT}]")]);
        args.extend(["-c:a".into(), "aac".into()]);
        let bitrate = encoding::audio_bitrate(
            source.audio.as_ref().and_then(|a| a.bit_rate),
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

/// The angle `-display_rotation` restores, or nothing for an upright source.
///
/// The probe negates the display matrix's angle to get the clockwise turn the
/// editor works in; this undoes that, and folds the result into the half-turn
/// either side of zero the option expects.
fn video_rotation(source: &MediaSource) -> Option<i32> {
    let rotation = source.video.as_ref()?.rotation.rem_euclid(360);
    if rotation == 0 {
        return None;
    }
    let restored = (360 - rotation) % 360;
    Some(if restored > 180 { restored - 360 } else { restored })
}

/// Shortest piece a hardware encoder is trusted with, in seconds.
///
/// NVENC hands back an empty stream for an input of a handful of frames: with
/// its look-ahead and B-frame delay it never gets round to flushing. A piece
/// this short is a fraction of a second of work for the software encoder, so
/// it goes there, whatever backend was asked for.
const SHORT_PIECE_SECONDS: f64 = 1.0;

/// Picks the encoder and pixel format for a piece that has to match the source.
///
/// The codec is the source's, never the one the dialog offers: the piece is
/// going to be decoded by the same decoder as the packets around it. Hardware
/// encoders are only trusted with the formats they all accept — eight-bit
/// 4:2:0, and ten-bit 4:2:0 for HEVC under the name they know it by — and
/// with pieces long enough for them to produce anything. Everything else goes
/// to the software encoder, which takes every format the source can be in.
fn piece_encoder(
    source: &MediaSource,
    capabilities: &Capabilities,
    backend: crate::domain::export::EncoderBackend,
    duration: f64,
) -> (&'static str, String) {
    use crate::domain::export::EncoderBackend;

    let video = source.video.as_ref();
    let codec = match video.map(|v| v.codec.as_str()) {
        Some("hevc") => VideoCodec::Hevc,
        _ => VideoCodec::H264,
    };
    let stored = video.map(|v| v.pixel_format.as_str()).unwrap_or("yuv420p");
    let eight_bit = matches!(stored, "yuv420p" | "yuvj420p" | "");
    let ten_bit_hevc = stored == "yuv420p10le" && codec == VideoCodec::Hevc;

    let long_enough = duration >= SHORT_PIECE_SECONDS;
    let backend =
        if (eight_bit || ten_bit_hevc) && long_enough { backend } else { EncoderBackend::Software };
    let encoder = capabilities.resolve_encoder(codec, backend);

    let pixel_format = if ten_bit_hevc && !encoder.starts_with("lib") {
        "p010le".to_string()
    } else if stored.is_empty() {
        "yuv420p".to_string()
    } else {
        stored.to_string()
    };

    (encoder, pixel_format)
}

/// Encoder settings for a piece: the highest quality target, because the piece
/// is going to be compared with the original on either side of it, and the
/// source's profile and colour tags so the stream it joins stays one stream.
fn piece_encoder_args(
    encoder: &'static str,
    pixel_format: &str,
    video: Option<&crate::domain::media::VideoStream>,
) -> Vec<String> {
    use crate::domain::export::QualityTarget;

    let mut args = vec!["-c:v".to_string(), encoder.to_string()];
    args.extend(encoding::rate_control(encoder, QualityTarget::Maximum));
    args.extend(["-pix_fmt".into(), pixel_format.to_string()]);

    if let Some(profile) =
        video.and_then(|v| v.profile.as_deref()).and_then(|p| profile_name(encoder, p))
    {
        args.extend(["-profile:v".into(), profile.into()]);
    }

    if encoder == "libx265" {
        // Closed groups only: a piece that opened a group onto the copied
        // packets after it would hand the decoder leading pictures with
        // nothing to lead from.
        args.extend(["-x265-params".into(), "open-gop=0:log-level=error".into()]);
    }

    if let Some(video) = video {
        for (flag, value) in [
            ("-color_primaries", video.color_primaries.as_deref()),
            ("-color_trc", video.color_transfer.as_deref()),
            ("-colorspace", video.color_space.as_deref()),
        ] {
            if let Some(value) = value.filter(|v| is_named_colour_tag(v)) {
                args.extend([flag.into(), value.into()]);
            }
        }
    }

    args
}

/// A colour tag worth restating. The prober reports the absence of one as a
/// word, and passing that word back would make the encoder refuse it.
fn is_named_colour_tag(value: &str) -> bool {
    !value.is_empty() && !matches!(value, "unknown" | "unspecified" | "reserved")
}

/// The software encoder's name for the profile the prober reported.
///
/// Software only: the hardware encoders spell their profiles differently from
/// one another, and a name one of them refuses fails the whole export over a
/// tag the decoder reads from the stream anyway.
fn profile_name(encoder: &str, reported: &str) -> Option<&'static str> {
    match (encoder, reported) {
        ("libx264", "High") => Some("high"),
        ("libx264", "Main") => Some("main"),
        ("libx264", "Baseline" | "Constrained Baseline") => Some("baseline"),
        ("libx264", "High 10") => Some("high10"),
        ("libx265", "Main") => Some("main"),
        ("libx265", "Main 10") => Some("main10"),
        _ => None,
    }
}

/// One line of a concat list that also states how long the piece is.
///
/// Stated rather than measured: a transport stream's duration is estimated
/// from its last timestamp and comes up one frame short, which would start
/// every next piece a frame early and squeeze the seam. The planner knows the
/// length exactly, from the keyframe index.
pub fn concat_list_entry_with_duration(path: &Path, duration: f64) -> String {
    format!("{}\nduration {duration:.6}", concat_list_entry(path))
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
                profile: None,
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
        let args = copy_segment_args("in.mkv", 20.0, 10.0, None, Path::new("part.mkv"));
        let seek = args.iter().position(|a| a == "-ss").unwrap();
        let input = args.iter().position(|a| a == "-i").unwrap();
        assert!(seek < input, "an output seek would decode everything before the cut");
        assert_eq!(pair(&args, "-t").unwrap(), "10.000000");
        assert!(args.contains(&"copy".to_string()));
    }

    #[test]
    fn a_copy_makes_the_audio_mapping_optional() {
        let args = copy_segment_args("in.mp4", 0.0, 5.0, None, Path::new("part.mp4"));
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

    /// The re-encoded frames beside a cut have to decode as one stream with
    /// the copied packets around them, so the piece takes the source's codec
    /// and pixel format, not the dialog's, and nothing about the picture moves.
    #[test]
    fn a_piece_matches_the_source_and_leaves_the_picture_alone() {
        let mut source = source(true);
        if let Some(video) = source.video.as_mut() {
            video.rotation = 90;
            video.profile = Some("High".into());
            video.color_primaries = Some("bt709".into());
            video.color_transfer = Some("unknown".into());
        }

        let args = encode_piece_args(
            &source,
            4.5,
            6.0,
            true,
            &capabilities(),
            EncoderBackend::Software,
            Path::new("piece.ts"),
        );

        assert!(args.contains(&"-noautorotate".to_string()), "pixels stay as stored");
        assert!(!args.iter().any(|a| a.contains("transpose")));
        assert_eq!(pair(&args, "-c:v").unwrap(), "libx264");
        assert_eq!(pair(&args, "-pix_fmt").unwrap(), "yuv420p");
        assert_eq!(pair(&args, "-profile:v").unwrap(), "high");
        assert_eq!(pair(&args, "-color_primaries").unwrap(), "bt709");
        assert!(pair(&args, "-color_trc").is_none(), "an absent tag is not restated");
        assert_eq!(pair(&args, "-f").unwrap(), "mpegts");

        // A quarter of a frame short of the keyframe at six seconds.
        let length: f64 = pair(&args, "-t").unwrap().parse().unwrap();
        assert!(length > 1.49 && length < 1.5, "got {length}");
    }

    /// NVENC hands back nothing at all for a piece of a few frames, so a short
    /// one goes to the software encoder whatever backend was asked for.
    #[test]
    fn a_short_piece_never_goes_to_a_hardware_encoder() {
        let short = encode_piece_args(
            &source(true),
            9.0,
            9.1,
            false,
            &capabilities(),
            EncoderBackend::Nvenc,
            Path::new("piece.ts"),
        );
        assert_eq!(pair(&short, "-c:v").unwrap(), "libx264");

        let long = encode_piece_args(
            &source(true),
            9.0,
            12.0,
            false,
            &capabilities(),
            EncoderBackend::Nvenc,
            Path::new("piece.ts"),
        );
        assert_eq!(pair(&long, "-c:v").unwrap(), "h264_nvenc");
    }

    /// An HEVC source is matched with an HEVC piece, and a ten-bit one keeps
    /// its depth under the name the encoder in question knows it by.
    #[test]
    fn a_piece_of_a_ten_bit_hevc_source_keeps_its_depth() {
        let mut source = source(true);
        if let Some(video) = source.video.as_mut() {
            video.codec = "hevc".into();
            video.pixel_format = "yuv420p10le".into();
        }
        let software = encode_piece_args(
            &source,
            0.0,
            5.0,
            false,
            &capabilities(),
            EncoderBackend::Software,
            Path::new("piece.ts"),
        );
        assert_eq!(pair(&software, "-c:v").unwrap(), "libx265");
        assert_eq!(pair(&software, "-pix_fmt").unwrap(), "yuv420p10le");
        assert!(pair(&software, "-x265-params").unwrap().contains("open-gop=0"));
    }

    #[test]
    fn a_copied_piece_is_bounded_by_packets_and_aligned_on_its_keyframe() {
        let args = copy_piece_args("in.mp4", 6.0, 90, true, Path::new("piece.ts"));
        let seek: f64 = pair(&args, "-ss").unwrap().parse().unwrap();
        assert!(seek < 6.0 && seek > 5.999, "a hair early, got {seek}");
        assert_eq!(pair(&args, "-copypriorss").unwrap(), "0");
        assert_eq!(pair(&args, "-frames:v").unwrap(), "90");
        assert_eq!(pair(&args, "-bsf:v").unwrap(), HEVC_LEADING_FILTER);
        assert!(!args.iter().any(|a| a == "-t"), "time would let the next keyframe in");
    }

    #[test]
    fn the_join_restates_rotation_and_reads_sound_where_the_pieces_are() {
        let mut source = source(true);
        if let Some(video) = source.video.as_mut() {
            video.rotation = 270;
        }
        let parts = [
            AudioPart::Source { start: 4.5, duration: 5.5 },
            AudioPart::Silence { duration: 2.0 },
            AudioPart::Source { start: 20.0, duration: 10.0 },
        ];
        let args = smart_join_args(
            Path::new("C:/tmp/pieces.txt"),
            &source,
            &parts,
            &ExportSpec::fast(),
            Path::new("C:/out/final.mp4"),
        );

        assert_eq!(pair(&args, "-display_rotation").unwrap(), "90");
        assert_eq!(args.iter().filter(|a| *a == "-i").count(), 3, "the list and two clips");
        assert_eq!(pair(&args, "-c:v").unwrap(), "copy");
        let graph = pair(&args, "-filter_complex").unwrap();
        assert!(graph.contains("anullsrc"), "silence under the hole");
        assert!(graph.contains("concat=n=3:v=0:a=1[aout]"));
        assert!(args.contains(&"+faststart".to_string()));
    }

    #[test]
    fn a_silent_source_is_joined_without_a_sound_track() {
        let args = smart_join_args(
            Path::new("C:/tmp/pieces.txt"),
            &source(false),
            &[AudioPart::Source { start: 0.0, duration: 5.0 }],
            &ExportSpec::fast(),
            Path::new("C:/out/final.mp4"),
        );
        assert!(args.contains(&"-an".to_string()));
        assert!(pair(&args, "-filter_complex").is_none());
    }
}
