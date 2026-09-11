use crate::application::error::AppResult;
use crate::domain::media::MediaSource;

use super::{locator, runner};

/// Rendered height of a filmstrip frame, in device pixels.
///
/// The strip is around 50 CSS pixels tall by default but the dock divider lets it
/// grow to roughly 300, so frames are extracted for the larger case. Sized for
/// the tall strip rather than the short one: upscaling a small frame is visible,
/// while downscaling a large one is free.
const THUMBNAIL_HEIGHT: u32 = 200;

/// One frame of the filmstrip.
#[derive(Debug, Clone)]
pub struct Thumbnail {
    /// Position in the source, in seconds.
    pub at: f64,
    /// JPEG bytes, base64 encoded as a `data:` URL ready for an `img` tag.
    pub data_url: String,
}

/// Extracts a single frame at `at` seconds and encodes it as a JPEG data URL.
///
/// The seek is placed before the input so FFmpeg jumps to the nearest keyframe
/// rather than decoding from the start. Filmstrip frames are approximate by
/// nature, so trading exactness for a hundredfold speed-up is the right call.
pub async fn extract(source: &MediaSource, at: f64) -> AppResult<Thumbnail> {
    let tools = locator::tools()?;

    // Clamp just inside the end: seeking exactly to the final timestamp returns
    // no frame at all on many containers.
    let duration = source.duration.seconds();
    let position = at.clamp(0.0, (duration - 0.05).max(0.0));

    let args = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        format!("{position:.3}"),
        "-i".into(),
        source.path.clone(),
        "-frames:v".into(),
        "1".into(),
        // -2 keeps the aspect ratio while forcing an even width, which the JPEG
        // encoder requires for subsampled chroma.
        "-vf".into(),
        format!("scale=-2:{THUMBNAIL_HEIGHT}:flags=bilinear"),
        "-q:v".into(),
        "6".into(),
        "-f".into(),
        "image2".into(),
        "-c:v".into(),
        "mjpeg".into(),
        "pipe:1".into(),
    ];

    let bytes = runner::run_capturing_bytes(&tools.ffmpeg, &args).await?;

    Ok(Thumbnail {
        at: position,
        data_url: format!("data:image/jpeg;base64,{}", base64_encode(&bytes)),
    })
}

/// Chooses the sample positions for a filmstrip of `count` frames.
///
/// Samples sit at the centre of each slice rather than at its edge, so a frame
/// represents the stretch of video drawn beneath it instead of the instant it
/// starts.
pub fn sample_positions(duration: f64, count: usize) -> Vec<f64> {
    if count == 0 || duration <= 0.0 {
        return Vec::new();
    }
    let slice = duration / count as f64;
    (0..count).map(|index| (index as f64 + 0.5) * slice).collect()
}

/// Minimal base64 encoder.
///
/// Pulling a crate in for forty lines would add a dependency to audit for no
/// benefit; this is the standard alphabet with padding and no line wrapping.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[(triple >> 18) as usize & 0x3F] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3F] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3F] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 { ALPHABET[triple as usize & 0x3F] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_reference_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_handles_high_bytes() {
        assert_eq!(base64_encode(&[0xFF, 0xD8, 0xFF]), "/9j/");
    }

    #[test]
    fn samples_sit_at_slice_centres() {
        let positions = sample_positions(10.0, 5);
        assert_eq!(positions, vec![1.0, 3.0, 5.0, 7.0, 9.0]);
    }

    #[test]
    fn degenerate_requests_produce_nothing() {
        assert!(sample_positions(0.0, 5).is_empty());
        assert!(sample_positions(10.0, 0).is_empty());
    }

    #[test]
    fn no_sample_lands_on_the_final_timestamp() {
        let duration = 10.0;
        let positions = sample_positions(duration, 4);
        assert!(positions.iter().all(|p| *p < duration));
    }
}
