use std::path::Path;

use crate::application::error::AppResult;

use super::{locator, runner};

/// Upper bound on returned keyframe positions.
///
/// An all-intra source (ProRes, DNxHD, MJPEG) makes every frame a keyframe, so a
/// long one would otherwise hand the renderer hundreds of thousands of numbers
/// to draw. Past this density every position is a cut point anyway, and the
/// interface says so rather than plotting them.
pub const MAX_KEYFRAMES: usize = 20_000;

#[derive(Debug, Clone, Default)]
pub struct Keyframes {
    /// Positions in seconds, ascending.
    pub positions: Vec<f64>,
    /// True when the source has more keyframes than were returned, which means
    /// a cut lands exactly where asked no matter where it is placed.
    pub truncated: bool,
}

impl Keyframes {
    /// The keyframe at or before `at`, which is where a stream copy starting at
    /// `at` will actually begin.
    pub fn at_or_before(&self, at: f64) -> Option<f64> {
        let index = self.positions.partition_point(|&k| k <= at + 1e-6);
        (index > 0).then(|| self.positions[index - 1])
    }
}

/// Lists the positions a stream copy can start at.
///
/// Packets are inspected rather than frames: reading the container index does
/// not decode anything, so this finishes in a second or two even on a long
/// recording. Asking for frames would decode every keyframe and take minutes.
pub async fn probe(path: &Path) -> AppResult<Keyframes> {
    let tools = locator::tools()?;

    let args = vec![
        "-v".into(),
        "error".into(),
        "-hide_banner".into(),
        "-select_streams".into(),
        "v:0".into(),
        "-show_entries".into(),
        "packet=pts_time,flags".into(),
        "-of".into(),
        "csv=p=0".into(),
        path.to_string_lossy().into_owned(),
    ];

    let output = runner::run_capturing_stdout(&tools.ffprobe, &args).await?;
    Ok(parse(&output))
}

/// Parses `pts_time,flags` rows, keeping the ones marked as keyframes.
///
/// Rows arrive as `12.345000,K__`. A packet with no timestamp is reported as
/// `N/A` and is skipped: it cannot be used as a cut point.
fn parse(output: &str) -> Keyframes {
    let mut positions = Vec::new();
    let mut truncated = false;

    for line in output.lines() {
        let mut parts = line.split(',');
        let Some(time) = parts.next() else { continue };
        let Some(flags) = parts.next() else { continue };

        if !flags.starts_with('K') {
            continue;
        }
        let Ok(seconds) = time.trim().parse::<f64>() else {
            continue;
        };
        if !seconds.is_finite() || seconds < 0.0 {
            continue;
        }

        if positions.len() >= MAX_KEYFRAMES {
            truncated = true;
            break;
        }
        positions.push(seconds);
    }

    // Containers do not guarantee packets in presentation order, and a cut point
    // list is only useful sorted.
    positions.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    positions.dedup_by(|a, b| (*a - *b).abs() < 1e-6);

    Keyframes { positions, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_keyframe_packets_are_kept() {
        let output = "0.000000,K__\n0.033333,___\n2.000000,K__\n2.033333,___\n4.000000,K_D\n";
        let keys = parse(output);
        assert_eq!(keys.positions, vec![0.0, 2.0, 4.0]);
        assert!(!keys.truncated);
    }

    #[test]
    fn packets_without_a_timestamp_are_skipped() {
        let keys = parse("N/A,K__\n1.500000,K__\n");
        assert_eq!(keys.positions, vec![1.5]);
    }

    #[test]
    fn out_of_order_packets_are_sorted_and_deduplicated() {
        let keys = parse("4.000000,K__\n0.000000,K__\n4.000000,K__\n2.000000,K__\n");
        assert_eq!(keys.positions, vec![0.0, 2.0, 4.0]);
    }

    #[test]
    fn malformed_rows_do_not_break_the_list() {
        let keys = parse("garbage\n\n1.0,K__\nalso,bad,extra\n");
        assert_eq!(keys.positions, vec![1.0]);
    }

    #[test]
    fn an_all_intra_source_is_reported_as_truncated() {
        let output: String =
            (0..MAX_KEYFRAMES + 50).map(|i| format!("{:.6},K__\n", i as f64 * 0.04)).collect();
        let keys = parse(&output);

        assert_eq!(keys.positions.len(), MAX_KEYFRAMES);
        assert!(keys.truncated, "the interface has to know the list is not complete");
    }

    #[test]
    fn the_copy_start_is_the_keyframe_at_or_before_the_cut() {
        let keys = parse("0.000000,K__\n2.000000,K__\n4.000000,K__\n");

        assert_eq!(keys.at_or_before(3.5), Some(2.0));
        assert_eq!(keys.at_or_before(2.0), Some(2.0), "landing on one keeps it");
        assert_eq!(keys.at_or_before(0.0), Some(0.0));
        assert_eq!(keys.at_or_before(99.0), Some(4.0));
    }

    #[test]
    fn a_position_before_the_first_keyframe_has_no_start() {
        let keys = parse("5.000000,K__\n");
        assert_eq!(keys.at_or_before(1.0), None);
    }
}
