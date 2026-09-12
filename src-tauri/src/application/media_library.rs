use std::path::{Path, PathBuf};

use crate::application::error::AppResult;
use crate::domain::media::{MediaSource, Playability};
use crate::infrastructure::ffmpeg::probe;
use crate::infrastructure::paths;

/// Validates a path and inspects the media behind it.
pub async fn open(raw_path: &str) -> AppResult<MediaSource> {
    let path = paths::validate_input(raw_path)?;
    probe::probe(&path).await
}

/// Where a scrubbing proxy for this source should live.
///
/// The name is derived from the file's identity rather than its title, so two
/// different clips that happen to share a name cannot collide, and reopening the
/// same clip reuses the proxy instead of transcoding it again.
pub fn proxy_path(source: &MediaSource) -> PathBuf {
    let fingerprint = fingerprint(source);
    proxy_dir().join(format!("proxy-{fingerprint:016x}.mp4"))
}

pub fn proxy_dir() -> PathBuf {
    paths::scratch_root().join("proxies")
}

/// True when a usable proxy already exists on disk.
pub fn proxy_is_cached(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
}

pub fn needs_proxy(source: &MediaSource) -> bool {
    source.playability == Playability::NeedsProxy && source.has_video()
}

/// Identity of a source file, combining path, size and modification time.
///
/// Size and time are included so that replacing a file with different content
/// under the same name invalidates the cached proxy. Using content hashing would
/// be stronger but would mean reading gigabytes before the editor can open.
fn fingerprint(source: &MediaSource) -> u64 {
    let modified = std::fs::metadata(&source.path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut hash = FNV_OFFSET;
    for byte in source.path.to_lowercase().as_bytes() {
        hash = fnv_step(hash, *byte);
    }
    for byte in source.size_bytes.to_le_bytes() {
        hash = fnv_step(hash, byte);
    }
    for byte in modified.to_le_bytes() {
        hash = fnv_step(hash, byte);
    }
    hash
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

#[inline]
fn fnv_step(hash: u64, byte: u8) -> u64 {
    (hash ^ byte as u64).wrapping_mul(FNV_PRIME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::media::{MediaKind, MediaSource, VideoStream};
    use crate::domain::time::Instant;

    fn source(path: &str, playability: Playability, with_video: bool) -> MediaSource {
        MediaSource {
            path: path.into(),
            file_name: "x".into(),
            size_bytes: 100,
            container: "matroska".into(),
            duration: Instant::new(10.0).unwrap(),
            max_duration: Instant::new(10.0).unwrap(),
            kind: MediaKind::Motion,
            video: with_video.then(|| VideoStream {
                index: 0,
                codec: "hevc".into(),
                codec_long: "HEVC".into(),
                width: 1920,
                height: 1080,
                rotation: 0,
                frame_rate: 30.0,
                pixel_format: "yuv420p".into(),
                bit_rate: None,
                color_primaries: None,
                color_transfer: None,
                color_space: None,
            }),
            audio: None,
            playability,
        }
    }

    #[test]
    fn only_unplayable_video_sources_need_a_proxy() {
        assert!(needs_proxy(&source("a.mkv", Playability::NeedsProxy, true)));
        assert!(!needs_proxy(&source("a.mp4", Playability::Native, true)));
        assert!(
            !needs_proxy(&source("a.flac", Playability::NeedsProxy, false)),
            "an audio-only source has nothing to preview"
        );
    }

    #[test]
    fn different_files_get_different_proxies() {
        let a = proxy_path(&source("C:/a.mkv", Playability::NeedsProxy, true));
        let b = proxy_path(&source("C:/b.mkv", Playability::NeedsProxy, true));
        assert_ne!(a, b);
    }

    #[test]
    fn the_same_file_maps_to_a_stable_proxy_name() {
        let a = proxy_path(&source("C:/a.mkv", Playability::NeedsProxy, true));
        let b = proxy_path(&source("C:/a.mkv", Playability::NeedsProxy, true));
        assert_eq!(a, b, "reopening a clip must reuse its proxy");
    }

    #[test]
    fn a_changed_size_invalidates_the_proxy() {
        let mut grown = source("C:/a.mkv", Playability::NeedsProxy, true);
        grown.size_bytes = 999;
        assert_ne!(
            proxy_path(&source("C:/a.mkv", Playability::NeedsProxy, true)),
            proxy_path(&grown)
        );
    }
}
