use crate::domain::export::QualityTarget;

/// Encoder-specific rate control arguments for a perceptual quality target.
///
/// Every encoder spells constant quality differently, and the numeric scales do
/// not line up: CRF 23 on x264 is a very different picture from CQ 23 on NVENC,
/// and x265 needs roughly four more points than x264 for the same look. Mapping
/// is therefore done per encoder family rather than by passing one number
/// through.
pub fn rate_control(encoder: &str, quality: QualityTarget) -> Vec<String> {
    match encoder {
        "libx264" => software_crf(&["-preset", "medium"], crf_x264(quality)),
        "libx265" => software_crf(&["-preset", "medium"], crf_x264(quality) + 4),
        "libsvtav1" => software_crf(&["-preset", "6"], crf_x264(quality) + 8),
        "libaom-av1" => software_crf(&["-cpu-used", "4"], crf_x264(quality) + 8),

        // NVENC constant quality. `-b:v 0` is required: without it the encoder
        // silently falls back to a bitrate cap and ignores the quality target.
        e if e.ends_with("_nvenc") => args(&[
            "-preset",
            "p5",
            "-tune",
            "hq",
            "-rc",
            "vbr",
            "-cq",
            &nvenc_cq(quality).to_string(),
            "-b:v",
            "0",
            "-rc-lookahead",
            "20",
            "-spatial-aq",
            "1",
        ]),

        e if e.ends_with("_qsv") => args(&[
            "-preset",
            "medium",
            "-global_quality",
            &nvenc_cq(quality).to_string(),
            "-look_ahead",
            "1",
        ]),

        e if e.ends_with("_amf") => {
            let qp = nvenc_cq(quality).to_string();
            args(&["-quality", "quality", "-rc", "cqp", "-qp_i", &qp, "-qp_p", &qp])
        }

        _ => software_crf(&["-preset", "medium"], crf_x264(quality)),
    }
}

fn software_crf(preset: &[&str], crf: u8) -> Vec<String> {
    let mut out = args(preset);
    out.push("-crf".into());
    out.push(crf.clamp(0, 63).to_string());
    out
}

/// x264 CRF scale. 18 is the point where re-encoding stops being visible on
/// typical footage, which is what "match the source" has to mean in practice:
/// a stream copy is the only truly lossless path, and that is what Fast mode is.
fn crf_x264(quality: QualityTarget) -> u8 {
    match quality {
        QualityTarget::Maximum => 15,
        QualityTarget::MatchSource => 18,
        QualityTarget::High => 20,
        QualityTarget::Balanced => 23,
        QualityTarget::Compact => 28,
    }
}

/// NVENC and QSV constant-quality scale, which runs slightly coarser than x264
/// at the same number.
fn nvenc_cq(quality: QualityTarget) -> u8 {
    match quality {
        QualityTarget::Maximum => 17,
        QualityTarget::MatchSource => 20,
        QualityTarget::High => 23,
        QualityTarget::Balanced => 26,
        QualityTarget::Compact => 32,
    }
}

/// Audio bitrate in bits per second, tracking the source where one is known.
pub fn audio_bitrate(source_bits_per_second: Option<u64>, channels: u32) -> u64 {
    let floor = if channels > 2 { 256_000 } else { 128_000 };
    source_bits_per_second.filter(|b| *b > 0).map(|b| b.clamp(floor, 320_000)).unwrap_or(192_000)
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn software_encoders_use_crf() {
        let rc = rate_control("libx264", QualityTarget::MatchSource);
        assert!(rc.windows(2).any(|w| w[0] == "-crf" && w[1] == "18"));
    }

    #[test]
    fn x265_is_offset_so_it_looks_the_same_as_x264() {
        let x264 = rate_control("libx264", QualityTarget::Balanced);
        let x265 = rate_control("libx265", QualityTarget::Balanced);
        let value = |rc: &[String]| -> u8 {
            rc.windows(2).find(|w| w[0] == "-crf").map(|w| w[1].parse().unwrap()).unwrap()
        };
        assert_eq!(value(&x265), value(&x264) + 4);
    }

    #[test]
    fn nvenc_pins_the_bitrate_cap_open() {
        let rc = rate_control("h264_nvenc", QualityTarget::High);
        assert!(
            rc.windows(2).any(|w| w[0] == "-b:v" && w[1] == "0"),
            "without -b:v 0 NVENC ignores the constant-quality target"
        );
        assert!(rc.windows(2).any(|w| w[0] == "-cq"));
    }

    #[test]
    fn an_unknown_encoder_still_produces_usable_arguments() {
        let rc = rate_control("some_future_encoder", QualityTarget::Balanced);
        assert!(!rc.is_empty());
    }

    #[test]
    fn audio_bitrate_tracks_the_source_within_bounds() {
        assert_eq!(audio_bitrate(Some(160_000), 2), 160_000);
        assert_eq!(audio_bitrate(Some(12_000), 2), 128_000);
        assert_eq!(audio_bitrate(Some(900_000), 2), 320_000);
        assert_eq!(audio_bitrate(None, 2), 192_000);
        assert_eq!(audio_bitrate(Some(100_000), 6), 256_000);
    }
}
