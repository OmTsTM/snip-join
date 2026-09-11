use std::collections::HashSet;

use serde::Serialize;
use tokio::sync::OnceCell;

use crate::application::error::AppResult;
use crate::domain::export::{EncoderBackend, UpscaleAlgorithm, VideoCodec};

use super::{locator, runner};

/// What this machine can actually do.
///
/// Not what the build carries: the two are different, and confusing them is
/// how an export reaches a user's machine and dies at the first frame. Probing
/// costs a handful of process launches, so it is done once and shared. Nothing
/// here can change while the app runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub encoders: Vec<String>,
    pub filters: Vec<String>,
    /// Hardware backends with at least one usable video encoder.
    pub hardware_backends: Vec<EncoderBackend>,
    /// Upscalers whose required filters are present in this build.
    pub upscalers: Vec<UpscaleAlgorithm>,
}

static CAPABILITIES: OnceCell<Capabilities> = OnceCell::const_new();

pub async fn capabilities() -> AppResult<&'static Capabilities> {
    CAPABILITIES.get_or_try_init(detect).await
}

async fn detect() -> AppResult<Capabilities> {
    let tools = locator::tools()?;

    let encoders = list_names(
        &runner::run_capturing_stdout(&tools.ffmpeg, &["-hide_banner".into(), "-encoders".into()])
            .await
            .unwrap_or_default(),
    );

    let filters = list_names(
        &runner::run_capturing_stdout(&tools.ffmpeg, &["-hide_banner".into(), "-filters".into()])
            .await
            .unwrap_or_default(),
    );

    // Listed is not usable. Every build shipped here carries h264_nvenc, and on
    // a machine with no NVIDIA card it fails with "Cannot load nvcuda.dll" only
    // once the export is already running — which is exactly the argument the
    // libplacebo probe below was written for, applied to the wrong half of the
    // file. Four end-to-end tests died this way on a runner with no GPU.
    //
    // Concurrently, so three probes cost about what one does.
    let (nvenc, quick_sync, amf) = tokio::join!(
        encoder_opens(&tools.ffmpeg, &encoders, "h264_nvenc"),
        encoder_opens(&tools.ffmpeg, &encoders, "h264_qsv"),
        encoder_opens(&tools.ffmpeg, &encoders, "h264_amf"),
    );

    let hardware_backends = [
        (EncoderBackend::Nvenc, nvenc),
        (EncoderBackend::QuickSync, quick_sync),
        (EncoderBackend::Amf, amf),
    ]
    .into_iter()
    .filter(|(_, opens)| *opens)
    .map(|(backend, _)| backend)
    .collect();

    let mut upscalers = vec![UpscaleAlgorithm::None, UpscaleAlgorithm::Lanczos];

    // The filter being compiled in is not enough: libplacebo needs a working
    // Vulkan device at run time, and a machine without one fails only once the
    // export has already started. One cheap frame settles it now instead.
    if filters.contains("libplacebo") && gpu_scaling_works(&tools.ffmpeg).await {
        upscalers.push(UpscaleAlgorithm::Placebo);
        if filters.contains("cas") {
            upscalers.push(UpscaleAlgorithm::Detail);
        }
    }

    let capabilities = Capabilities {
        encoders: encoders.iter().cloned().collect(),
        filters: filters.iter().cloned().collect(),
        hardware_backends,
        upscalers,
    };

    tracing::info!(
        hardware = ?capabilities.hardware_backends,
        upscalers = ?capabilities.upscalers,
        "detected FFmpeg capabilities"
    );

    Ok(capabilities)
}

/// Encodes one frame to confirm the encoder opens on this machine.
///
/// 256x256 clears NVENC's minimum dimensions with room to spare and is even on
/// both axes, and the pixel format is stated rather than negotiated, so a
/// failure here means the encoder could not open and not that the probe asked
/// for something odd.
async fn encoder_opens(ffmpeg: &std::path::Path, encoders: &HashSet<String>, name: &str) -> bool {
    if !encoders.contains(name) {
        return false;
    }

    let args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=256x256:d=0.1",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        name,
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    let ok = runner::run_capturing_stdout(ffmpeg, &args).await.is_ok();
    if !ok {
        tracing::info!(encoder = name, "compiled into this build but it does not open here");
    }
    ok
}

/// The hardware backend an encoder name belongs to, if any.
///
/// Keyed on the suffix rather than on a table of names, so a codec added to the
/// candidate lists cannot quietly escape the check.
fn backend_of(encoder: &str) -> Option<EncoderBackend> {
    if encoder.ends_with("_nvenc") {
        Some(EncoderBackend::Nvenc)
    } else if encoder.ends_with("_qsv") {
        Some(EncoderBackend::QuickSync)
    } else if encoder.ends_with("_amf") {
        Some(EncoderBackend::Amf)
    } else {
        None
    }
}

/// Renders one frame through libplacebo to confirm a usable Vulkan device.
async fn gpu_scaling_works(ffmpeg: &std::path::Path) -> bool {
    let args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:d=0.1",
        "-vf",
        "libplacebo=w=128:h=128:upscaler=ewa_lanczossharp",
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();

    let ok = runner::run_capturing_stdout(ffmpeg, &args).await.is_ok();
    if !ok {
        tracing::info!("GPU scaling is unavailable on this machine; offering CPU kernels only");
    }
    ok
}

/// Extracts tool names from an `-encoders` or `-filters` listing.
///
/// Both listings put a flag column first and the name second, after a header
/// block terminated by a line of dashes. Parsing by column index rather than by
/// regex keeps this robust across FFmpeg versions.
fn list_names(listing: &str) -> HashSet<String> {
    listing
        .lines()
        .skip_while(|line| !line.trim_start().starts_with('-'))
        .skip(1)
        .filter_map(|line| line.split_whitespace().nth(1))
        .map(str::to_string)
        .collect()
}

impl Capabilities {
    pub fn has_encoder(&self, name: &str) -> bool {
        self.encoders.iter().any(|e| e == name)
    }

    /// Whether this machine can run the named encoder, as opposed to merely
    /// carrying it.
    ///
    /// Software encoders are taken at their word; a hardware one counts only if
    /// its backend opened during detection.
    fn can_encode(&self, name: &str) -> bool {
        self.has_encoder(name)
            && backend_of(name).map_or(true, |backend| self.hardware_backends.contains(&backend))
    }

    /// Resolves a requested backend to a concrete encoder name.
    ///
    /// `Auto` walks hardware first and falls back to software, so a machine
    /// without a usable GPU still exports rather than failing. An explicitly
    /// requested backend that is unavailable also falls back, because refusing to
    /// export is a worse outcome than exporting a little slower.
    pub fn resolve_encoder(&self, codec: VideoCodec, backend: EncoderBackend) -> &'static str {
        let candidates: &[&'static str] = match (codec, backend) {
            (VideoCodec::H264, EncoderBackend::Nvenc) => &["h264_nvenc", "libx264"],
            (VideoCodec::H264, EncoderBackend::QuickSync) => &["h264_qsv", "libx264"],
            (VideoCodec::H264, EncoderBackend::Amf) => &["h264_amf", "libx264"],
            (VideoCodec::H264, EncoderBackend::Software) => &["libx264"],
            (VideoCodec::H264, EncoderBackend::Auto) => {
                &["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]
            }

            (VideoCodec::Hevc, EncoderBackend::Nvenc) => &["hevc_nvenc", "libx265"],
            (VideoCodec::Hevc, EncoderBackend::QuickSync) => &["hevc_qsv", "libx265"],
            (VideoCodec::Hevc, EncoderBackend::Amf) => &["hevc_amf", "libx265"],
            (VideoCodec::Hevc, EncoderBackend::Software) => &["libx265"],
            (VideoCodec::Hevc, EncoderBackend::Auto) => {
                &["hevc_nvenc", "hevc_qsv", "hevc_amf", "libx265"]
            }

            (VideoCodec::Av1, EncoderBackend::Nvenc) => &["av1_nvenc", "libsvtav1"],
            (VideoCodec::Av1, EncoderBackend::QuickSync) => &["av1_qsv", "libsvtav1"],
            (VideoCodec::Av1, EncoderBackend::Amf) => &["av1_amf", "libsvtav1"],
            (VideoCodec::Av1, EncoderBackend::Software) => &["libsvtav1", "libaom-av1"],
            (VideoCodec::Av1, EncoderBackend::Auto) => {
                &["av1_nvenc", "av1_qsv", "av1_amf", "libsvtav1"]
            }
        };

        candidates.iter().copied().find(|name| self.can_encode(name)).unwrap_or("libx264")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_LISTING: &str = "Encoders:\n\
         V..... = Video\n\
         ------\n\
         V....D libx264              libx264 H.264\n\
         V....D h264_nvenc           NVIDIA NVENC H.264 encoder\n\
         V..... libsvtav1            SVT-AV1 encoder\n";

    /// Every hardware encoder in the listing is taken to open, which is the
    /// machine these tests describe. The case where it does not is its own test.
    fn capabilities_with(encoders: &[&str], filters: &[&str]) -> Capabilities {
        let hardware_backends =
            [EncoderBackend::Nvenc, EncoderBackend::QuickSync, EncoderBackend::Amf]
                .into_iter()
                .filter(|backend| encoders.iter().any(|e| backend_of(e) == Some(*backend)))
                .collect();

        Capabilities {
            encoders: encoders.iter().map(|s| s.to_string()).collect(),
            filters: filters.iter().map(|s| s.to_string()).collect(),
            hardware_backends,
            upscalers: vec![],
        }
    }

    #[test]
    fn names_are_extracted_from_a_listing() {
        let names = list_names(SAMPLE_LISTING);
        assert!(names.contains("libx264"));
        assert!(names.contains("h264_nvenc"));
        assert!(!names.contains("Encoders:"), "the header must be skipped");
    }

    #[test]
    fn auto_prefers_hardware_when_present() {
        let caps = capabilities_with(&["libx264", "h264_nvenc"], &[]);
        assert_eq!(caps.resolve_encoder(VideoCodec::H264, EncoderBackend::Auto), "h264_nvenc");
    }

    #[test]
    fn auto_falls_back_to_software_without_hardware() {
        let caps = capabilities_with(&["libx264"], &[]);
        assert_eq!(caps.resolve_encoder(VideoCodec::H264, EncoderBackend::Auto), "libx264");
    }

    #[test]
    fn an_unavailable_explicit_backend_falls_back_rather_than_failing() {
        let caps = capabilities_with(&["libx265"], &[]);
        assert_eq!(caps.resolve_encoder(VideoCodec::Hevc, EncoderBackend::Nvenc), "libx265");
    }

    /// The defect a GPU-less CI runner found: the build lists h264_nvenc on
    /// every machine, and picking it where nvcuda.dll cannot load fails the
    /// export at the first frame, after the user has already waited.
    #[test]
    fn an_encoder_the_machine_cannot_open_is_never_chosen() {
        let caps = Capabilities {
            encoders: vec!["libx264".into(), "h264_nvenc".into()],
            filters: vec![],
            hardware_backends: vec![],
            upscalers: vec![],
        };

        assert_eq!(caps.resolve_encoder(VideoCodec::H264, EncoderBackend::Auto), "libx264");
        assert_eq!(
            caps.resolve_encoder(VideoCodec::H264, EncoderBackend::Nvenc),
            "libx264",
            "an explicit request for a backend that does not work must still fall back"
        );
    }

    #[test]
    fn software_only_request_never_picks_hardware() {
        let caps = capabilities_with(&["libx264", "h264_nvenc"], &[]);
        assert_eq!(caps.resolve_encoder(VideoCodec::H264, EncoderBackend::Software), "libx264");
    }
}
