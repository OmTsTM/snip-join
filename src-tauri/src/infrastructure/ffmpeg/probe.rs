use std::path::Path;

use serde::Deserialize;

use crate::application::error::{AppError, AppResult};
use crate::domain::media::{
    classify_playability, AudioStream, MediaKind, MediaSource, Playability, VideoStream,
    STILL_DEFAULT_SECONDS, STILL_MAX_SECONDS,
};
use crate::domain::time::Instant;

use super::locator;
use super::runner;

/// Inspects a media file and returns everything the editor needs to open it.
pub async fn probe(path: &Path) -> AppResult<MediaSource> {
    let tools = locator::tools()?;

    let args = vec![
        "-v".into(),
        "error".into(),
        "-hide_banner".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        path.to_string_lossy().into_owned(),
    ];

    let json = runner::run_capturing_stdout(&tools.ffprobe, &args).await?;
    let report: ProbeReport = serde_json::from_str(&json)
        .map_err(|e| AppError::ProbeFailed(format!("unreadable probe output: {e}")))?;

    build_source(path, report)
}

fn build_source(path: &Path, report: ProbeReport) -> AppResult<MediaSource> {
    let format = report
        .format
        .ok_or_else(|| AppError::ProbeFailed("the file has no readable container".into()))?;

    let video = report
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video") && !s.is_cover_art())
        .map(to_video_stream);

    let audio = report
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"))
        .map(to_audio_stream);

    if video.is_none() && audio.is_none() {
        return Err(AppError::UnsupportedMedia);
    }

    // The container duration is authoritative; a stream duration is the fallback
    // for formats that do not carry one at the container level, such as raw TS.
    let probed_seconds = format
        .duration
        .as_deref()
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| {
            report
                .streams
                .iter()
                .filter_map(|s| s.duration.as_deref())
                .filter_map(|d| d.parse::<f64>().ok())
                .fold(None, |acc: Option<f64>, d| Some(acc.map_or(d, |a| a.max(d))))
        })
        .unwrap_or(0.0);

    let container = format.format_name.unwrap_or_default();
    let kind = if is_still(&container, &report.streams, audio.as_ref()) {
        MediaKind::Still
    } else {
        MediaKind::Motion
    };

    // A still's own duration is meaningless — a PNG reports a fortieth of a
    // second, which is where a two-pixel block on the timeline came from — so
    // the editor's length replaces it rather than being layered on top of it.
    let (duration_seconds, max_seconds) = match kind {
        MediaKind::Still => (STILL_DEFAULT_SECONDS, STILL_MAX_SECONDS),
        MediaKind::Motion => (probed_seconds, probed_seconds),
    };

    if duration_seconds <= 0.0 {
        return Err(AppError::ProbeFailed(
            "the file reports no duration, so it cannot be trimmed".into(),
        ));
    }

    // A single frame is never something the web view can play back: there is no
    // video track to drive, so the preview copy is not optional here the way it
    // is for an unusual codec.
    let playability = match kind {
        MediaKind::Still => Playability::NeedsProxy,
        MediaKind::Motion => classify_playability(&container, video.as_ref(), audio.as_ref()),
    };

    Ok(MediaSource {
        path: path.to_string_lossy().into_owned(),
        file_name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        size_bytes: format.size.as_deref().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0),
        container,
        duration: Instant::saturating(duration_seconds),
        max_duration: Instant::saturating(max_seconds),
        kind,
        video,
        audio,
        playability,
    })
}

/// Containers that only ever hold one picture.
///
/// FFmpeg demuxes still images through per-format "pipe" demuxers, so the
/// container name is the strongest signal there is. Deliberately excluding
/// `gif`: an animated one is a real video and has to stay one.
const STILL_CONTAINERS: &[&str] = &[
    "image2",
    "png_pipe",
    "jpeg_pipe",
    "webp_pipe",
    "bmp_pipe",
    "tiff_pipe",
    "jpegls_pipe",
    "pgm_pipe",
    "ppm_pipe",
    "pam_pipe",
    "psd_pipe",
    "svg_pipe",
    "qoi_pipe",
];

/// Whether a source holds a single frame rather than moving pictures.
///
/// Two signals, and either is enough. The container name catches the ordinary
/// cases; the frame count catches a still wearing a video container, which is
/// what a one-frame GIF or a single-picture MP4 is. Sound rules it out outright:
/// whatever else a file with audio is, it has a length of its own.
fn is_still(container: &str, streams: &[ProbeStream], audio: Option<&AudioStream>) -> bool {
    if audio.is_some() {
        return false;
    }

    if container.split(',').map(str::trim).any(|name| STILL_CONTAINERS.contains(&name)) {
        return true;
    }

    streams
        .iter()
        .filter(|s| s.codec_type.as_deref() == Some("video") && !s.is_cover_art())
        .any(|s| s.frame_count() == Some(1))
}

fn to_video_stream(stream: &ProbeStream) -> VideoStream {
    VideoStream {
        index: stream.index,
        codec: stream.codec_name.clone().unwrap_or_default(),
        codec_long: stream.codec_long_name.clone().unwrap_or_default(),
        width: stream.width.unwrap_or(0),
        height: stream.height.unwrap_or(0),
        rotation: stream.rotation(),
        frame_rate: stream.frame_rate(),
        pixel_format: stream.pix_fmt.clone().unwrap_or_default(),
        bit_rate: stream.bit_rate.as_deref().and_then(|b| b.parse().ok()),
        color_primaries: stream.color_primaries.clone(),
        color_transfer: stream.color_transfer.clone(),
        color_space: stream.color_space.clone(),
        profile: stream.profile.clone(),
    }
}

fn to_audio_stream(stream: &ProbeStream) -> AudioStream {
    AudioStream {
        index: stream.index,
        codec: stream.codec_name.clone().unwrap_or_default(),
        codec_long: stream.codec_long_name.clone().unwrap_or_default(),
        sample_rate: stream.sample_rate.as_deref().and_then(|r| r.parse().ok()).unwrap_or(48_000),
        channels: stream.channels.unwrap_or(2),
        channel_layout: stream.channel_layout.clone(),
        bit_rate: stream.bit_rate.as_deref().and_then(|b| b.parse().ok()),
    }
}

/// Parses FFmpeg's `numerator/denominator` rational notation.
fn parse_rational(value: &str) -> Option<f64> {
    let (numerator, denominator) = value.split_once('/')?;
    let n: f64 = numerator.trim().parse().ok()?;
    let d: f64 = denominator.trim().parse().ok()?;
    if d.abs() < f64::EPSILON {
        return None;
    }
    let result = n / d;
    (result.is_finite() && result > 0.0).then_some(result)
}

/// Normalises any rotation expression to one of 0, 90, 180, 270.
fn normalise_rotation(degrees: f64) -> i32 {
    if !degrees.is_finite() {
        return 0;
    }
    let rounded = (degrees / 90.0).round() * 90.0;
    let wrapped = ((rounded % 360.0) + 360.0) % 360.0;
    wrapped as i32
}

// -- ffprobe JSON shapes -----------------------------------------------------
// Only the fields the editor consumes are modelled. Unknown fields are ignored,
// so a newer FFmpeg adding keys cannot break parsing.

#[derive(Debug, Deserialize)]
struct ProbeReport {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Debug, Deserialize)]
struct ProbeFormat {
    format_name: Option<String>,
    duration: Option<String>,
    size: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    index: u32,
    codec_type: Option<String>,
    codec_name: Option<String>,
    codec_long_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    pix_fmt: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    bit_rate: Option<String>,
    duration: Option<String>,
    nb_frames: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
    color_primaries: Option<String>,
    #[serde(rename = "color_transfer")]
    color_transfer: Option<String>,
    #[serde(rename = "color_space")]
    color_space: Option<String>,
    profile: Option<String>,
    #[serde(default)]
    disposition: Disposition,
    #[serde(default)]
    tags: std::collections::HashMap<String, String>,
    #[serde(default)]
    side_data_list: Vec<SideData>,
}

#[derive(Debug, Deserialize, Default)]
struct Disposition {
    #[serde(default)]
    attached_pic: u8,
}

#[derive(Debug, Deserialize)]
struct SideData {
    rotation: Option<f64>,
}

impl ProbeStream {
    /// Embedded album art is reported as a video stream of one frame. Treating it
    /// as the source video would show a still image for an audio file.
    fn is_cover_art(&self) -> bool {
        self.disposition.attached_pic == 1
    }

    /// How many frames the stream declares, when it declares any.
    fn frame_count(&self) -> Option<u64> {
        self.nb_frames.as_deref()?.trim().parse().ok()
    }

    fn frame_rate(&self) -> f64 {
        self.avg_frame_rate
            .as_deref()
            .and_then(parse_rational)
            .or_else(|| self.r_frame_rate.as_deref().and_then(parse_rational))
            .unwrap_or(0.0)
    }

    /// Rotation lives in display-matrix side data on modern files and in a
    /// `rotate` tag on older ones. The display matrix expresses the correction as
    /// a negative angle, so it is negated to get the clockwise display rotation.
    fn rotation(&self) -> i32 {
        if let Some(rotation) = self.side_data_list.iter().find_map(|s| s.rotation) {
            return normalise_rotation(-rotation);
        }
        self.tags
            .get("rotate")
            .and_then(|r| r.parse::<f64>().ok())
            .map(normalise_rotation)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::media::Playability;

    #[test]
    fn rationals_are_parsed_and_guarded() {
        assert!((parse_rational("30000/1001").unwrap() - 29.97).abs() < 0.01);
        assert_eq!(parse_rational("0/0"), None);
        assert_eq!(parse_rational("25"), None);
        assert_eq!(parse_rational("0/1"), None);
    }

    #[test]
    fn rotations_normalise_into_quarter_turns() {
        assert_eq!(normalise_rotation(-90.0), 270);
        assert_eq!(normalise_rotation(90.0), 90);
        assert_eq!(normalise_rotation(-180.0), 180);
        assert_eq!(normalise_rotation(450.0), 90);
        assert_eq!(normalise_rotation(f64::NAN), 0);
    }

    fn report_from(json: &str) -> ProbeReport {
        serde_json::from_str(json).expect("fixture must parse")
    }

    #[test]
    fn a_typical_mp4_is_parsed_and_marked_native() {
        let report = report_from(
            r#"{
              "streams": [
                {"index":0,"codec_type":"video","codec_name":"h264","codec_long_name":"H.264",
                 "width":1920,"height":1080,"pix_fmt":"yuv420p","avg_frame_rate":"30000/1001",
                 "bit_rate":"8000000"},
                {"index":1,"codec_type":"audio","codec_name":"aac","codec_long_name":"AAC",
                 "sample_rate":"48000","channels":2,"channel_layout":"stereo"}
              ],
              "format": {"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"120.5","size":"120000000"}
            }"#,
        );

        let source = build_source(Path::new("C:/clips/holiday.mp4"), report).unwrap();
        assert_eq!(source.file_name, "holiday.mp4");
        assert_eq!(source.duration.seconds(), 120.5);
        assert_eq!(source.playability, Playability::Native);
        assert_eq!(source.video.as_ref().unwrap().display_size(), (1920, 1080));
    }

    #[test]
    fn cover_art_is_not_treated_as_video() {
        let report = report_from(
            r#"{
              "streams": [
                {"index":0,"codec_type":"video","codec_name":"mjpeg","width":600,"height":600,
                 "disposition":{"attached_pic":1}},
                {"index":1,"codec_type":"audio","codec_name":"mp3","sample_rate":"44100","channels":2}
              ],
              "format": {"format_name":"mp3","duration":"200.0","size":"5000000"}
            }"#,
        );

        let source = build_source(Path::new("song.mp3"), report).unwrap();
        assert!(source.video.is_none(), "album art must not become the video track");
        assert!(source.audio.is_some());
    }

    #[test]
    fn a_portrait_phone_clip_reports_rotated_dimensions() {
        let report = report_from(
            r#"{
              "streams": [
                {"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
                 "pix_fmt":"yuv420p","avg_frame_rate":"30/1",
                 "side_data_list":[{"rotation":-90}]}
              ],
              "format": {"format_name":"mov,mp4","duration":"10.0","size":"1000"}
            }"#,
        );

        let source = build_source(Path::new("vertical.mp4"), report).unwrap();
        let video = source.video.unwrap();
        assert_eq!(video.rotation, 90);
        assert_eq!(video.display_size(), (1080, 1920));
    }

    #[test]
    fn a_png_is_a_still_and_gets_an_editable_length() {
        let report = report_from(
            r#"{
              "streams": [
                {"index":0,"codec_type":"video","codec_name":"png","width":1920,"height":1080,
                 "pix_fmt":"rgba","avg_frame_rate":"25/1","nb_frames":"1"}
              ],
              "format": {"format_name":"png_pipe","duration":"0.040000","size":"250000"}
            }"#,
        );

        let source = build_source(Path::new("card.png"), report).unwrap();
        assert_eq!(source.kind, MediaKind::Still);
        // Not the fortieth of a second the container claims: that is what made a
        // still land on the timeline two pixels wide.
        assert_eq!(source.duration.seconds(), STILL_DEFAULT_SECONDS);
        assert_eq!(source.max_duration.seconds(), STILL_MAX_SECONDS);
        assert_eq!(source.playability, Playability::NeedsProxy);
    }

    #[test]
    fn a_single_frame_inside_a_video_container_is_still_a_still() {
        let report = report_from(
            r#"{
              "streams": [
                {"index":0,"codec_type":"video","codec_name":"h264","width":640,"height":480,
                 "pix_fmt":"yuv420p","avg_frame_rate":"30/1","nb_frames":"1"}
              ],
              "format": {"format_name":"mov,mp4","duration":"0.033","size":"9000"}
            }"#,
        );

        assert_eq!(build_source(Path::new("one.mp4"), report).unwrap().kind, MediaKind::Still);
    }

    /// An animated GIF is a video however short it is, and treating it as a
    /// frozen frame would drop every frame after the first.
    #[test]
    fn an_animated_gif_stays_moving_pictures() {
        let report = report_from(
            r#"{
              "streams": [
                {"index":0,"codec_type":"video","codec_name":"gif","width":320,"height":240,
                 "pix_fmt":"bgra","avg_frame_rate":"10/1","nb_frames":"48"}
              ],
              "format": {"format_name":"gif","duration":"4.8","size":"120000"}
            }"#,
        );

        let source = build_source(Path::new("loop.gif"), report).unwrap();
        assert_eq!(source.kind, MediaKind::Motion);
        assert_eq!(source.duration.seconds(), 4.8);
    }

    /// Sound settles it on its own: whatever else a file with audio is, it has a
    /// length of its own that the editor must not replace.
    #[test]
    fn a_file_with_sound_is_never_a_still() {
        let report = report_from(
            r#"{
              "streams": [
                {"index":0,"codec_type":"video","codec_name":"mjpeg","width":640,"height":480,
                 "nb_frames":"1"},
                {"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000",
                 "channels":2}
              ],
              "format": {"format_name":"image2","duration":"12.0","size":"9000"}
            }"#,
        );

        assert_eq!(build_source(Path::new("odd.mov"), report).unwrap().kind, MediaKind::Motion);
    }

    #[test]
    fn a_file_without_duration_is_rejected() {
        let report = report_from(
            r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":10,"height":10}],
                "format":{"format_name":"mp4"}}"#,
        );
        assert!(build_source(Path::new("broken.mp4"), report).is_err());
    }

    #[test]
    fn a_file_with_no_usable_stream_is_rejected() {
        let report = report_from(r#"{"streams":[],"format":{"format_name":"mp4","duration":"5"}}"#);
        assert!(matches!(
            build_source(Path::new("empty.mp4"), report).unwrap_err(),
            AppError::UnsupportedMedia
        ));
    }
}
