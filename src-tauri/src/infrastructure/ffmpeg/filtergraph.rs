use crate::domain::edl::{EditList, Segment};
use crate::domain::export::{
    AudioHandling, Restoration, RestorationLevel, ScaleTarget, UpscaleAlgorithm, VideoCodec,
};
use crate::domain::media::MediaSource;

/// Label of the finished video chain inside the generated graph.
pub const VIDEO_OUT: &str = "vout";
/// Label of the finished audio chain inside the generated graph.
pub const AUDIO_OUT: &str = "aout";

/// Everything the graph builder needs that is not already in the edit list.
// No longer `Copy`: the per-medium audio table is a Vec.
#[derive(Debug, Clone)]
pub struct GraphOptions {
    /// Frame rate every segment is normalised to. Concatenation requires a single
    /// rate across inputs, and synthesised gaps have no rate of their own.
    pub frame_rate: f64,
    /// Size every segment is normalised to, before any upscaling.
    pub width: u32,
    pub height: u32,
    pub rotation: i32,
    pub sample_rate: u32,
    pub channels: u32,
    pub pixel_format: &'static str,
    pub include_audio: bool,
    /// Whether each medium, in table order, carries an audio stream.
    ///
    /// A silent medium has no `[n:a]` pad to draw from, so its segment is given
    /// the same generated silence a hole gets. Without this a single clip from
    /// a file with no sound takes the whole graph down.
    pub media_has_audio: Vec<bool>,
    pub upscale: UpscaleAlgorithm,
    pub scale: ScaleTarget,
    pub restoration: Restoration,
}

impl GraphOptions {
    /// Derives graph options from the media table and a reconciled export spec.
    ///
    /// The first medium sets the output format. Everything else is normalised
    /// onto it, which is the only way `concat` can be handed segments from
    /// different files at all.
    pub fn from_media(media: &[MediaSource], spec: &crate::domain::export::ExportSpec) -> Self {
        let mut options = Self::from_source(&media[0], spec);
        options.media_has_audio = media.iter().map(MediaSource::has_audio).collect();
        // Any medium with sound is reason enough to carry an audio track: the
        // silent ones contribute silence rather than dropping the track.
        options.include_audio =
            options.media_has_audio.iter().any(|has| *has) && spec.audio != AudioHandling::Remove;
        options
    }

    /// Derives graph options from a probed source and a reconciled export spec.
    pub fn from_source(source: &MediaSource, spec: &crate::domain::export::ExportSpec) -> Self {
        let video = source.video.as_ref();
        let (width, height) = video.map(|v| v.display_size()).unwrap_or((1920, 1080));
        let frame_rate = spec
            .frame_rate
            .unwrap_or_else(|| video.map(|v| v.frame_rate).filter(|r| *r > 0.1).unwrap_or(30.0));

        GraphOptions {
            frame_rate,
            width,
            height,
            rotation: video.map(|v| v.rotation).unwrap_or(0),
            sample_rate: source.audio.as_ref().map(|a| a.sample_rate).unwrap_or(48_000),
            channels: source.audio.as_ref().map(|a| a.channels.clamp(1, 8)).unwrap_or(2),
            pixel_format: pixel_format_for(source, spec.codec),
            include_audio: source.has_audio() && spec.audio != AudioHandling::Remove,
            media_has_audio: vec![source.has_audio()],
            upscale: spec.upscale,
            scale: spec.scale,
            restoration: spec.restoration,
        }
    }

    /// Final output dimensions after any upscaling.
    pub fn output_size(&self) -> (u32, u32) {
        match self.upscale {
            UpscaleAlgorithm::None => (self.width, self.height),
            _ => self.scale.resolve(self.width, self.height),
        }
    }
}

/// Chooses an output pixel format.
///
/// Ten-bit sources keep their depth on codecs that support it, because dropping
/// to eight bits reintroduces the banding the source was encoded to avoid. H.264
/// stays at eight bits: several hardware encoders refuse 10-bit H.264 outright,
/// and a failed export is worse than a slightly shallower one.
fn pixel_format_for(source: &MediaSource, codec: VideoCodec) -> &'static str {
    let source_is_deep = source
        .video
        .as_ref()
        .map(|v| {
            let pix = &v.pixel_format;
            pix.contains("10") || pix.contains("12") || pix.contains("p010")
        })
        .unwrap_or(false);

    match (source_is_deep, codec) {
        (true, VideoCodec::Hevc) | (true, VideoCodec::Av1) => "yuv420p10le",
        _ => "yuv420p",
    }
}

/// Builds the `filter_complex` string that turns a single input file into the
/// edited result.
///
/// The shape is always the same: normalise every segment to identical video and
/// audio parameters, concatenate them, then run one restoration and scaling pass
/// over the joined result. Doing the expensive pass once after the concatenation
/// rather than per segment is what keeps a twelve-cut edit as fast as a one-cut
/// edit.
pub fn build(edit: &EditList, options: &GraphOptions) -> String {
    let segments = edit.segments();
    let mut chains: Vec<String> = Vec::with_capacity(segments.len() * 2 + 4);
    let mut concat_inputs = String::new();

    for (index, segment) in segments.iter().enumerate() {
        match segment {
            Segment::Media(clip) => {
                let input = clip.media;
                chains.push(format!(
                    "[{input}:v]{}[v{index}]",
                    media_video_chain(
                        clip.source.start().seconds(),
                        clip.source.end().seconds(),
                        options
                    )
                ));
                if options.include_audio {
                    // A medium with no sound of its own contributes silence of
                    // the right length, exactly as a hole does.
                    if options.media_has_audio.get(input).copied().unwrap_or(false) {
                        chains.push(format!(
                            "[{input}:a]{}[a{index}]",
                            media_audio_chain(
                                clip.source.start().seconds(),
                                clip.source.end().seconds(),
                                options
                            )
                        ));
                    } else {
                        chains.push(format!(
                            "{}[a{index}]",
                            gap_audio_chain(clip.source.duration(), options)
                        ));
                    }
                }
            }
            Segment::Gap(range) => {
                chains.push(format!("{}[v{index}]", gap_video_chain(range.duration(), options)));
                if options.include_audio {
                    chains
                        .push(format!("{}[a{index}]", gap_audio_chain(range.duration(), options)));
                }
            }
        }

        concat_inputs.push_str(&format!("[v{index}]"));
        if options.include_audio {
            concat_inputs.push_str(&format!("[a{index}]"));
        }
    }

    let count = segments.len();
    let audio_flag = u8::from(options.include_audio);

    if count == 1 && !needs_post_pass(options) {
        // A single segment with no restoration needs no concatenation at all.
        // Renaming the labels keeps the caller's mapping uniform.
        chains.push(format!("[v0]null[{VIDEO_OUT}]"));
        if options.include_audio {
            chains.push(format!("[a0]anull[{AUDIO_OUT}]"));
        }
        return chains.join(";");
    }

    let concat_video_label = if needs_post_pass(options) { "cv" } else { VIDEO_OUT };
    let concat_audio_label = AUDIO_OUT;

    let mut concat =
        format!("{concat_inputs}concat=n={count}:v=1:a={audio_flag}[{concat_video_label}]");
    if options.include_audio {
        concat.push_str(&format!("[{concat_audio_label}]"));
    }
    chains.push(concat);

    if needs_post_pass(options) {
        chains.push(format!("[cv]{}[{VIDEO_OUT}]", post_pass_chain(options)));
    }

    chains.join(";")
}

/// Whether anything has to happen after the segments are joined.
fn needs_post_pass(options: &GraphOptions) -> bool {
    options.upscale != UpscaleAlgorithm::None || !options.restoration.is_noop()
}

/// Normalises one surviving piece of the source.
///
/// `trim` selects the range, `setpts` rebases its timestamps to zero so the
/// concatenation does not inherit gaps from the original timeline, and the rest
/// forces every segment onto identical parameters. Concatenation silently
/// produces corrupt output when inputs disagree on size, pixel format, sample
/// aspect or frame rate, so none of these are optional.
fn media_video_chain(start: f64, end: f64, options: &GraphOptions) -> String {
    let mut steps =
        vec![format!("trim=start={start:.6}:end={end:.6}"), "setpts=PTS-STARTPTS".to_string()];

    // Container rotation is applied by hand: FFmpeg auto-rotates for simple
    // filtering but not inside a complex graph, so skipping this would export a
    // sideways video from any phone clip.
    steps.extend(transpose_steps(options.rotation));

    steps.push(format!("fps={:.6}", options.frame_rate));
    steps.push(format!("scale={}:{}:flags=bicubic", options.width, options.height));
    steps.push("setsar=1".to_string());
    steps.push(format!("format={}", options.pixel_format));
    steps.join(",")
}

fn media_audio_chain(start: f64, end: f64, options: &GraphOptions) -> String {
    format!("atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS,{}", audio_format(options))
}

/// Synthesises a hole as black video of the requested length.
fn gap_video_chain(duration: f64, options: &GraphOptions) -> String {
    format!(
        "color=c=black:s={}x{}:r={:.6}:d={duration:.6},setsar=1,format={}",
        options.width, options.height, options.frame_rate, options.pixel_format
    )
}

/// Synthesises the silence that pairs with a hole.
///
/// `anullsrc` is infinite, so it is trimmed to the gap length; without the trim
/// the concatenation would never reach the following segment.
fn gap_audio_chain(duration: f64, options: &GraphOptions) -> String {
    format!(
        "anullsrc=sample_rate={}:channel_layout={},atrim=duration={duration:.6},asetpts=PTS-STARTPTS,{}",
        options.sample_rate,
        channel_layout(options.channels),
        audio_format(options)
    )
}

fn audio_format(options: &GraphOptions) -> String {
    format!(
        "aformat=sample_fmts=fltp:sample_rates={}:channel_layouts={}",
        options.sample_rate,
        channel_layout(options.channels)
    )
}

/// Maps a channel count onto a layout name FFmpeg accepts.
fn channel_layout(channels: u32) -> &'static str {
    match channels {
        1 => "mono",
        2 => "stereo",
        3 => "2.1",
        4 => "quad",
        6 => "5.1",
        8 => "7.1",
        // Anything unusual is downmixed to stereo rather than risking a layout
        // the encoder cannot accept.
        _ => "stereo",
    }
}

fn transpose_steps(rotation: i32) -> Vec<String> {
    match rotation.rem_euclid(360) {
        90 => vec!["transpose=1".to_string()],
        180 => vec!["hflip".to_string(), "vflip".to_string()],
        270 => vec!["transpose=2".to_string()],
        _ => vec![],
    }
}

/// Restoration and scaling, applied once to the joined result.
///
/// Order is fixed and deliberate: denoise before scaling so grain is not
/// magnified, deband before scaling for the same reason, and sharpen last so it
/// acts on the final pixel grid rather than being resampled away.
fn post_pass_chain(options: &GraphOptions) -> String {
    let mut steps: Vec<String> = Vec::new();

    if let Some(denoise) = denoise_step(options.restoration.denoise) {
        steps.push(denoise);
    }
    if options.restoration.deband {
        steps.push("deband=1thr=0.02:2thr=0.02:3thr=0.02:4thr=0.02:range=16:blur=1".to_string());
    }

    let (out_width, out_height) = options.output_size();
    if options.upscale != UpscaleAlgorithm::None
        && (out_width != options.width || out_height != options.height)
    {
        steps.extend(scale_steps(options.upscale, out_width, out_height, options));
    }

    if let Some(sharpen) = sharpen_step(options.restoration.sharpen) {
        steps.push(sharpen);
    }

    steps.push(format!("format={}", options.pixel_format));
    steps.join(",")
}

/// Spatial and temporal denoising. Strength values follow FFmpeg's own scale,
/// where the defaults sit near the "light" row.
fn denoise_step(level: RestorationLevel) -> Option<String> {
    let params = match level {
        RestorationLevel::Off => return None,
        RestorationLevel::Light => "2:1.5:3:3",
        RestorationLevel::Medium => "4:3:6:6",
        RestorationLevel::Strong => "8:6:12:12",
    };
    Some(format!("hqdn3d={params}"))
}

/// Contrast-adaptive sharpening.
///
/// Chosen over an unsharp mask because it scales its strength with local
/// contrast: flat areas keep their noise floor instead of having it lifted, and
/// edges do not gain the bright halo an unsharp mask leaves at these amounts.
fn sharpen_step(level: RestorationLevel) -> Option<String> {
    let strength = match level {
        RestorationLevel::Off => return None,
        RestorationLevel::Light => "0.25",
        RestorationLevel::Medium => "0.5",
        RestorationLevel::Strong => "0.8",
    };
    Some(format!("cas=strength={strength}"))
}

fn scale_steps(
    algorithm: UpscaleAlgorithm,
    width: u32,
    height: u32,
    options: &GraphOptions,
) -> Vec<String> {
    match algorithm {
        UpscaleAlgorithm::None => vec![],

        UpscaleAlgorithm::Lanczos => {
            vec![format!("scale={width}:{height}:flags=lanczos+accurate_rnd+full_chroma_int")]
        }

        // libplacebo runs on the GPU through Vulkan. Its anti-ringing option is
        // deliberately left off: it applies only to separable kernels, an EWA
        // kernel suppresses ringing by construction, and passing it makes builds
        // that validate the option list refuse the whole graph.
        UpscaleAlgorithm::Placebo => {
            vec![placebo_step(width, height), format!("format={}", options.pixel_format)]
        }

        // The same GPU kernel, then contrast-adaptive sharpening at the output
        // resolution to recover the micro-detail any resample softens.
        UpscaleAlgorithm::Detail => vec![
            placebo_step(width, height),
            format!("format={}", options.pixel_format),
            "cas=strength=0.4".to_string(),
        ],
    }
}

fn placebo_step(width: u32, height: u32) -> String {
    format!("libplacebo=w={width}:h={height}:upscaler=ewa_lanczossharp:downscaler=mitchell")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::export::Restoration;
    use crate::domain::time::{Instant, TimeRange};

    fn options() -> GraphOptions {
        GraphOptions {
            frame_rate: 30.0,
            width: 1920,
            height: 1080,
            rotation: 0,
            sample_rate: 48_000,
            channels: 2,
            pixel_format: "yuv420p",
            include_audio: true,
            media_has_audio: vec![true, true],
            upscale: UpscaleAlgorithm::None,
            scale: ScaleTarget::Source,
            restoration: Restoration::default(),
        }
    }

    fn joined_edit() -> EditList {
        EditList::contiguous(vec![
            TimeRange::from_seconds(0.0, 10.0).unwrap(),
            TimeRange::from_seconds(20.0, 30.0).unwrap(),
        ])
        .unwrap()
    }

    fn gapped_edit() -> EditList {
        EditList::new(vec![
            crate::domain::edl::Clip::new(
                0,
                TimeRange::from_seconds(0.0, 10.0).unwrap(),
                Instant::ZERO,
            ),
            crate::domain::edl::Clip::new(
                0,
                TimeRange::from_seconds(20.0, 30.0).unwrap(),
                Instant::new(20.0).unwrap(),
            ),
        ])
        .unwrap()
    }

    #[test]
    fn joining_two_pieces_trims_both_and_concatenates() {
        let graph = build(&joined_edit(), &options());

        assert!(graph.contains("trim=start=0.000000:end=10.000000"));
        assert!(graph.contains("trim=start=20.000000:end=30.000000"));
        assert!(graph.contains("concat=n=2:v=1:a=1"));
        assert!(!graph.contains("color=c=black"), "a joined edit has no holes");
    }

    #[test]
    fn a_hole_becomes_black_video_and_silence() {
        let graph = build(&gapped_edit(), &options());

        assert!(graph.contains("color=c=black:s=1920x1080:r=30.000000:d=10.000000"));
        assert!(graph.contains("anullsrc=sample_rate=48000:channel_layout=stereo"));
        assert!(graph.contains("atrim=duration=10.000000"), "silence must be bounded");
        assert!(graph.contains("concat=n=3:v=1:a=1"));
    }

    #[test]
    fn every_segment_is_normalised_before_concatenation() {
        let graph = build(&joined_edit(), &options());

        assert_eq!(graph.matches("setsar=1").count(), 2);
        assert_eq!(graph.matches("fps=30.000000").count(), 2);
        // The leading comma is what separates the video filter from `asetpts`,
        // which contains the video filter's name as a substring.
        assert_eq!(graph.matches(",setpts=PTS-STARTPTS").count(), 2);
        assert_eq!(graph.matches(",asetpts=PTS-STARTPTS").count(), 2);
    }

    #[test]
    fn a_source_without_audio_produces_a_video_only_graph() {
        let mut options = options();
        options.include_audio = false;

        let graph = build(&gapped_edit(), &options);
        assert!(graph.contains("concat=n=3:v=1:a=0"));
        assert!(!graph.contains("anullsrc"));
        assert!(!graph.contains("[aout]"));
    }

    #[test]
    fn rotation_is_baked_in_because_complex_graphs_do_not_auto_rotate() {
        let mut options = options();
        options.rotation = 90;

        let graph = build(&joined_edit(), &options);
        assert_eq!(graph.matches("transpose=1").count(), 2);
    }

    #[test]
    fn a_single_untouched_clip_skips_concatenation_entirely() {
        let edit = EditList::contiguous(vec![TimeRange::from_seconds(2.0, 8.0).unwrap()]).unwrap();
        let graph = build(&edit, &options());

        assert!(!graph.contains("concat="), "one segment needs no concatenation");
        assert!(graph.ends_with("[aout]"));
    }

    #[test]
    fn upscaling_runs_once_after_the_join_not_per_segment() {
        let mut options = options();
        options.upscale = UpscaleAlgorithm::Lanczos;
        options.scale = ScaleTarget::Multiplier { factor: 2.0 };

        let graph = build(&joined_edit(), &options);
        assert_eq!(
            graph.matches("scale=3840:2160:flags=lanczos").count(),
            1,
            "the expensive pass must not be repeated per segment"
        );
        assert!(graph.contains("[cv]"), "the join feeds the post pass");
    }

    #[test]
    fn restoration_runs_denoise_before_scaling_and_sharpen_after() {
        let mut options = options();
        options.upscale = UpscaleAlgorithm::Lanczos;
        options.scale = ScaleTarget::Multiplier { factor: 2.0 };
        options.restoration = Restoration {
            denoise: RestorationLevel::Medium,
            sharpen: RestorationLevel::Light,
            deband: true,
        };

        let graph = build(&joined_edit(), &options);
        let denoise = graph.find("hqdn3d").expect("denoise present");
        let scale = graph.find("scale=3840:2160").expect("scale present");
        let sharpen = graph.rfind("cas=strength").expect("sharpen present");

        assert!(denoise < scale, "grain must not be magnified by the scaler");
        assert!(scale < sharpen, "sharpening must act on the final pixel grid");
    }

    #[test]
    fn the_gpu_kernel_carries_no_option_it_would_ignore() {
        let mut options = options();
        options.upscale = UpscaleAlgorithm::Placebo;
        options.scale = ScaleTarget::Multiplier { factor: 2.0 };

        let graph = build(&joined_edit(), &options);
        assert!(graph.contains("libplacebo=w=3840:h=2160:upscaler=ewa_lanczossharp"));
        assert!(
            !graph.contains("antiringing"),
            "anti-ringing is a no-op for an EWA kernel and is refused by some builds"
        );
    }

    #[test]
    fn the_detail_tier_sharpens_at_the_output_resolution() {
        let mut options = options();
        options.upscale = UpscaleAlgorithm::Detail;
        options.scale = ScaleTarget::Multiplier { factor: 2.0 };

        let graph = build(&joined_edit(), &options);
        let scale = graph.find("libplacebo").unwrap();
        let sharpen = graph.find("cas=strength").unwrap();
        assert!(
            scale < sharpen,
            "sharpening the smaller grid and then scaling it would blur the result again"
        );
    }

    #[test]
    fn unusual_channel_counts_fall_back_to_stereo() {
        assert_eq!(channel_layout(2), "stereo");
        assert_eq!(channel_layout(6), "5.1");
        assert_eq!(channel_layout(7), "stereo");
    }

    #[test]
    fn a_second_medium_is_read_from_its_own_input() {
        let edit = EditList::new(vec![
            crate::domain::edl::Clip::new(
                0,
                TimeRange::from_seconds(0.0, 5.0).unwrap(),
                Instant::ZERO,
            ),
            crate::domain::edl::Clip::new(
                1,
                TimeRange::from_seconds(0.0, 4.0).unwrap(),
                Instant::new(5.0).unwrap(),
            ),
        ])
        .unwrap();

        let graph = build(&edit, &options());
        assert!(graph.contains("[0:v]"), "the first piece reads the first file");
        assert!(graph.contains("[1:v]"), "the second piece reads the second file");
    }

    /// A file with no sound has no `[n:a]` pad, and asking for one takes the
    /// whole graph down rather than costing that one segment.
    #[test]
    fn a_silent_medium_contributes_silence_rather_than_a_missing_pad() {
        let mut settings = options();
        settings.media_has_audio = vec![true, false];

        let edit = EditList::new(vec![
            crate::domain::edl::Clip::new(
                0,
                TimeRange::from_seconds(0.0, 5.0).unwrap(),
                Instant::ZERO,
            ),
            crate::domain::edl::Clip::new(
                1,
                TimeRange::from_seconds(0.0, 4.0).unwrap(),
                Instant::new(5.0).unwrap(),
            ),
        ])
        .unwrap();

        let graph = build(&edit, &settings);
        assert!(graph.contains("[0:a]"), "the first file has sound of its own");
        assert!(!graph.contains("[1:a]"), "the second file has none to draw from");
        assert!(graph.contains("anullsrc"), "so its segment is given silence");
    }

    #[test]
    fn deep_sources_keep_their_bit_depth_only_on_codecs_that_allow_it() {
        use crate::domain::media::{MediaKind, MediaSource, Playability, VideoStream};

        let deep = MediaSource {
            path: "a".into(),
            file_name: "a".into(),
            size_bytes: 0,
            container: "mov,mp4".into(),
            duration: Instant::new(10.0).unwrap(),
            max_duration: Instant::new(10.0).unwrap(),
            kind: MediaKind::Motion,
            video: Some(VideoStream {
                index: 0,
                codec: "hevc".into(),
                codec_long: "HEVC".into(),
                width: 1920,
                height: 1080,
                rotation: 0,
                frame_rate: 30.0,
                pixel_format: "yuv420p10le".into(),
                bit_rate: None,
                color_primaries: None,
                color_transfer: None,
                color_space: None,
            }),
            audio: None,
            playability: Playability::NeedsProxy,
        };

        assert_eq!(pixel_format_for(&deep, VideoCodec::Hevc), "yuv420p10le");
        assert_eq!(
            pixel_format_for(&deep, VideoCodec::H264),
            "yuv420p",
            "10-bit H.264 is refused by several hardware encoders"
        );
    }
}
