use serde::{Deserialize, Serialize};

use super::time::Instant;

/// A decoded description of one video stream inside a source file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStream {
    pub index: u32,
    pub codec: String,
    /// Codec name as stored, e.g. `h264`, before any friendly relabelling.
    pub codec_long: String,
    pub width: u32,
    pub height: u32,
    /// Rotation in degrees from container side data, normalised to 0/90/180/270.
    pub rotation: i32,
    pub frame_rate: f64,
    pub pixel_format: String,
    pub bit_rate: Option<u64>,
    /// Nominal colour primaries/transfer, used to decide whether an export needs
    /// explicit tone-mapping rather than a silent colour shift.
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
    pub color_space: Option<String>,
}

impl VideoStream {
    /// Dimensions after container rotation is applied, which is what the viewer
    /// actually sees and therefore what the export must target.
    pub fn display_size(&self) -> (u32, u32) {
        if self.rotation == 90 || self.rotation == 270 {
            (self.height, self.width)
        } else {
            (self.width, self.height)
        }
    }

    /// True for transfer functions that need tone-mapping when the export target
    /// is standard dynamic range.
    pub fn is_high_dynamic_range(&self) -> bool {
        matches!(self.color_transfer.as_deref(), Some("smpte2084") | Some("arib-std-b67"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pub index: u32,
    pub codec: String,
    pub codec_long: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub channel_layout: Option<String>,
    pub bit_rate: Option<u64>,
}

/// Whether the embedded web view can decode a source directly, or whether the
/// editor has to build a proxy before it can be scrubbed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Playability {
    /// The web view decodes the original file; no proxy needed.
    Native,
    /// The container or a codec is unsupported; a proxy is required for preview.
    NeedsProxy,
}

/// Everything the application knows about a source file after probing it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSource {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    /// Comma-separated container short names exactly as reported by the prober.
    pub container: String,
    pub duration: Instant,
    pub video: Option<VideoStream>,
    pub audio: Option<AudioStream>,
    pub playability: Playability,
}

impl MediaSource {
    pub fn has_video(&self) -> bool {
        self.video.is_some()
    }

    pub fn has_audio(&self) -> bool {
        self.audio.is_some()
    }
}

/// Containers the embedded Chromium media stack can demux.
const WEB_CONTAINERS: &[&str] = &["mp4", "mov", "m4v", "webm", "ogg", "matroska"];

/// Video codecs Chromium decodes without relying on an optional OS component.
/// HEVC is deliberately excluded: playback depends on a hardware decoder plus an
/// OS codec pack, so treating it as native produces a silent black preview on
/// machines that lack either.
const WEB_VIDEO_CODECS: &[&str] = &["h264", "vp8", "vp9", "av1", "theora"];

const WEB_AUDIO_CODECS: &[&str] = &["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le"];

/// Decides whether a probed source can be previewed directly.
///
/// The rule is intentionally conservative. A false `Native` means the user sees
/// a black frame with no explanation; a false `NeedsProxy` only costs one
/// background transcode, so the cheap failure is the one we bias toward.
pub fn classify_playability(
    container: &str,
    video: Option<&VideoStream>,
    audio: Option<&AudioStream>,
) -> Playability {
    let container_ok =
        container.split(',').map(str::trim).any(|name| WEB_CONTAINERS.contains(&name));
    if !container_ok {
        return Playability::NeedsProxy;
    }

    // Matroska carries almost anything; Chromium only accepts the WebM subset.
    let is_matroska = container.split(',').map(str::trim).any(|n| n == "matroska");

    if let Some(v) = video {
        if !WEB_VIDEO_CODECS.contains(&v.codec.as_str()) {
            return Playability::NeedsProxy;
        }
        if is_matroska && !matches!(v.codec.as_str(), "vp8" | "vp9" | "av1") {
            return Playability::NeedsProxy;
        }
        // 10-bit and higher pixel formats have no software fallback in the web view.
        if v.pixel_format.contains("10le")
            || v.pixel_format.contains("12le")
            || v.pixel_format.contains("p010")
        {
            return Playability::NeedsProxy;
        }
        if v.is_high_dynamic_range() {
            return Playability::NeedsProxy;
        }
    }

    if let Some(a) = audio {
        if !WEB_AUDIO_CODECS.contains(&a.codec.as_str()) {
            return Playability::NeedsProxy;
        }
    }

    Playability::Native
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(codec: &str, pix: &str) -> VideoStream {
        VideoStream {
            index: 0,
            codec: codec.to_string(),
            codec_long: codec.to_string(),
            width: 1920,
            height: 1080,
            rotation: 0,
            frame_rate: 30.0,
            pixel_format: pix.to_string(),
            bit_rate: Some(8_000_000),
            color_primaries: None,
            color_transfer: None,
            color_space: None,
        }
    }

    #[test]
    fn plain_h264_mp4_plays_natively() {
        assert_eq!(
            classify_playability("mov,mp4,m4a,3gp,3g2,mj2", Some(&video("h264", "yuv420p")), None),
            Playability::Native
        );
    }

    #[test]
    fn hevc_and_exotic_containers_need_a_proxy() {
        assert_eq!(
            classify_playability("mov,mp4", Some(&video("hevc", "yuv420p")), None),
            Playability::NeedsProxy
        );
        assert_eq!(
            classify_playability("avi", Some(&video("h264", "yuv420p")), None),
            Playability::NeedsProxy
        );
    }

    #[test]
    fn h264_inside_matroska_needs_a_proxy() {
        assert_eq!(
            classify_playability("matroska,webm", Some(&video("h264", "yuv420p")), None),
            Playability::NeedsProxy,
            "Chromium demuxes Matroska only for the WebM codec subset"
        );
    }

    #[test]
    fn ten_bit_needs_a_proxy() {
        assert_eq!(
            classify_playability("mov,mp4", Some(&video("h264", "yuv420p10le")), None),
            Playability::NeedsProxy
        );
    }

    #[test]
    fn rotation_swaps_display_dimensions() {
        let mut v = video("h264", "yuv420p");
        v.rotation = 90;
        assert_eq!(v.display_size(), (1080, 1920));
    }
}
