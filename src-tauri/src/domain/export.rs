use serde::{Deserialize, Serialize};

/// How much work the encoder is allowed to do, which is the single decision that
/// separates a three second export from a twenty minute one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportMode {
    /// Copy the original streams untouched. Nothing is re-encoded, so quality is
    /// bit-for-bit identical and the export finishes at disk speed. Cuts snap to
    /// the nearest keyframe because a stream copy cannot start mid-GOP.
    Fast,
    /// Decode and re-encode. Cuts land on the exact requested frame and gaps can
    /// be filled, at the cost of a full encoding pass.
    Precise,
    /// Precise, plus a resolution and restoration pass.
    Enhanced,
}

impl ExportMode {
    pub fn re_encodes(self) -> bool {
        !matches!(self, ExportMode::Fast)
    }
}

/// Resampling kernel used when the output resolution differs from the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpscaleAlgorithm {
    /// Keep the source resolution.
    None,
    /// Lanczos resampling. Fast, sharp, and the sane default for live footage.
    Lanczos,
    /// GPU resampling through libplacebo with an EWA Lanczos kernel. A radially
    /// symmetric kernel reconstructs edges more faithfully than a separable one,
    /// so diagonals keep their shape instead of picking up faint stair-stepping.
    Placebo,
    /// The GPU kernel followed by contrast-adaptive sharpening at the output
    /// resolution, to recover the micro-detail any resample softens. Slowest of
    /// the three, and still GPU bound.
    Detail,
}

impl UpscaleAlgorithm {
    /// Whether the kernel runs on the GPU, which is worth surfacing because it
    /// changes the time estimate by an order of magnitude.
    pub fn is_gpu(self) -> bool {
        matches!(self, UpscaleAlgorithm::Placebo | UpscaleAlgorithm::Detail)
    }
}

/// The output resolution, expressed relative to the source or as an exact size.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ScaleTarget {
    Source,
    Multiplier { factor: f64 },
    Absolute { width: u32, height: u32 },
}

impl ScaleTarget {
    /// Resolves to concrete even dimensions.
    ///
    /// Every codec here subsamples chroma, so odd dimensions are rejected by the
    /// encoder. Rounding down to even is done once, here, rather than in each
    /// filter builder.
    pub fn resolve(self, source_width: u32, source_height: u32) -> (u32, u32) {
        let (w, h) = match self {
            ScaleTarget::Source => (source_width, source_height),
            ScaleTarget::Multiplier { factor } => {
                let f = factor.clamp(0.25, 8.0);
                (
                    (source_width as f64 * f).round() as u32,
                    (source_height as f64 * f).round() as u32,
                )
            }
            ScaleTarget::Absolute { width, height } => (width, height),
        };
        (even(w.clamp(16, 15360)), even(h.clamp(16, 15360)))
    }
}

#[inline]
fn even(value: u32) -> u32 {
    value & !1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestorationLevel {
    Off,
    Light,
    Medium,
    Strong,
}

impl RestorationLevel {
    pub fn is_off(self) -> bool {
        matches!(self, RestorationLevel::Off)
    }
}

/// Optional restoration applied before scaling. Order matters and is fixed:
/// denoise first so the scaler is not asked to magnify grain, sharpen last so it
/// acts on the final pixel grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Restoration {
    pub denoise: RestorationLevel,
    pub sharpen: RestorationLevel,
    /// Smooths the banding that low-bitrate gradients develop.
    pub deband: bool,
}

impl Default for Restoration {
    fn default() -> Self {
        Restoration {
            denoise: RestorationLevel::Off,
            sharpen: RestorationLevel::Off,
            deband: false,
        }
    }
}

impl Restoration {
    pub fn is_noop(self) -> bool {
        self.denoise.is_off() && self.sharpen.is_off() && !self.deband
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoCodec {
    H264,
    Hevc,
    Av1,
}

/// Which encoder implementation to drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EncoderBackend {
    /// Pick the fastest backend the machine actually supports at run time.
    Auto,
    Nvenc,
    QuickSync,
    Amf,
    /// libx264 / libx265 / SVT-AV1. Slowest, but available everywhere and still
    /// the best quality per bit at a given file size.
    Software,
}

/// Perceptual quality target, mapped to per-encoder rate control later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QualityTarget {
    /// Track the source bitrate so the result is visually indistinguishable.
    MatchSource,
    Maximum,
    High,
    Balanced,
    Compact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioHandling {
    /// Copy the source audio stream untouched whenever the container allows it.
    Copy,
    /// Re-encode to AAC. Required as soon as gaps are filled with silence, since
    /// silence has to be encoded into the same stream.
    ReEncode,
    Remove,
}

/// The complete, validated description of one export job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    pub mode: ExportMode,
    pub codec: VideoCodec,
    pub backend: EncoderBackend,
    pub quality: QualityTarget,
    pub upscale: UpscaleAlgorithm,
    pub scale: ScaleTarget,
    pub restoration: Restoration,
    pub audio: AudioHandling,
    /// Output frame rate. `None` keeps the source rate, which is almost always
    /// what the user wants.
    pub frame_rate: Option<f64>,
}

impl ExportSpec {
    /// The cheapest possible export: copy everything, touch nothing.
    pub fn fast() -> Self {
        ExportSpec {
            mode: ExportMode::Fast,
            codec: VideoCodec::H264,
            backend: EncoderBackend::Auto,
            quality: QualityTarget::MatchSource,
            upscale: UpscaleAlgorithm::None,
            scale: ScaleTarget::Source,
            restoration: Restoration::default(),
            audio: AudioHandling::Copy,
            frame_rate: None,
        }
    }

    /// Normalises combinations that cannot be honoured as written.
    ///
    /// The interface hides most of these, but a spec also arrives over IPC, so it
    /// is reconciled here rather than trusted. Silently producing a wrong file is
    /// worse than quietly promoting the mode.
    pub fn reconciled(mut self, has_gaps: bool) -> Self {
        // A stream copy cannot synthesise the black frames a gap needs.
        if has_gaps && self.mode == ExportMode::Fast {
            self.mode = ExportMode::Precise;
        }

        // Scaling or restoration is meaningless without a re-encode.
        let wants_pixels_changed =
            self.upscale != UpscaleAlgorithm::None || !self.restoration.is_noop();
        if wants_pixels_changed && self.mode == ExportMode::Fast {
            self.mode = ExportMode::Precise;
        }
        if self.mode != ExportMode::Enhanced {
            self.upscale = UpscaleAlgorithm::None;
            self.scale = ScaleTarget::Source;
            self.restoration = Restoration::default();
        }

        if self.upscale == UpscaleAlgorithm::None && self.mode == ExportMode::Enhanced {
            self.scale = ScaleTarget::Source;
        }

        // Concatenating across a silent gap requires a single re-encoded stream.
        if has_gaps && self.audio == AudioHandling::Copy {
            self.audio = AudioHandling::ReEncode;
        }
        if self.mode.re_encodes() && self.audio == AudioHandling::Copy {
            self.audio = AudioHandling::ReEncode;
        }

        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_targets_resolve_to_even_dimensions() {
        // 1921 x 1.5 rounds to 2882, which is already even and is kept as is.
        assert_eq!(ScaleTarget::Multiplier { factor: 1.5 }.resolve(1921, 1081), (2882, 1622));
        // An odd source is rounded down, because subsampled chroma needs even sides.
        assert_eq!(ScaleTarget::Source.resolve(1921, 1081), (1920, 1080));
        assert_eq!(ScaleTarget::Absolute { width: 1281, height: 721 }.resolve(1, 1), (1280, 720));
    }

    #[test]
    fn scale_multipliers_are_clamped_to_a_sane_range() {
        let (w, _) = ScaleTarget::Multiplier { factor: 99.0 }.resolve(1920, 1080);
        assert!(w <= 15360);
    }

    #[test]
    fn a_gap_forces_a_re_encode() {
        let spec = ExportSpec::fast().reconciled(true);
        assert_eq!(spec.mode, ExportMode::Precise);
        assert_eq!(spec.audio, AudioHandling::ReEncode);
    }

    #[test]
    fn fast_stays_fast_without_gaps() {
        let spec = ExportSpec::fast().reconciled(false);
        assert_eq!(spec.mode, ExportMode::Fast);
        assert_eq!(spec.audio, AudioHandling::Copy);
    }

    #[test]
    fn upscaling_outside_enhanced_mode_is_dropped() {
        let spec = ExportSpec {
            upscale: UpscaleAlgorithm::Lanczos,
            scale: ScaleTarget::Multiplier { factor: 2.0 },
            mode: ExportMode::Precise,
            ..ExportSpec::fast()
        }
        .reconciled(false);

        assert_eq!(spec.upscale, UpscaleAlgorithm::None);
        assert_eq!(spec.scale, ScaleTarget::Source);
    }

    #[test]
    fn gpu_kernels_are_identified_for_the_time_estimate() {
        assert!(UpscaleAlgorithm::Placebo.is_gpu());
        assert!(UpscaleAlgorithm::Detail.is_gpu());
        assert!(!UpscaleAlgorithm::Lanczos.is_gpu());
    }

    #[test]
    fn an_enhanced_export_keeps_the_factor_it_was_given() {
        let spec = ExportSpec {
            mode: ExportMode::Enhanced,
            upscale: UpscaleAlgorithm::Detail,
            scale: ScaleTarget::Multiplier { factor: 4.0 },
            ..ExportSpec::fast()
        }
        .reconciled(false);

        assert_eq!(spec.scale, ScaleTarget::Multiplier { factor: 4.0 });
    }
}
