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

/// One place a stream copy can start.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Keyframe {
    /// Presentation time in seconds.
    pub at: f64,
    /// How many video packets precede it in the file.
    ///
    /// Packet order is decode order, and it is what `-frames:v` counts, so this
    /// is what lets a copy be bounded to exactly one run of groups of pictures
    /// rather than to "whatever has a timestamp before the next keyframe". That
    /// bound lands on the wrong side of the keyframe once B-frames are involved,
    /// because their decode timestamps run ahead of their pictures.
    pub index: u64,
    /// Packets that follow this keyframe in the file but are shown before it.
    ///
    /// Zero for a closed group of pictures. An open one starts on a keyframe
    /// whose leading pictures refer back to the group before it, so a copy that
    /// begins here carries frames it cannot decode. Counting them is what lets
    /// the planner strip them, or refuse to start a copy on this keyframe.
    pub leading: u32,
    /// The earliest picture this keyframe's group shows, which is the keyframe
    /// itself unless it has leading pictures.
    pub lead_start: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Keyframes {
    /// Ascending by position.
    pub entries: Vec<Keyframe>,
    /// Every video packet in the file, which is where a copy that runs to the
    /// end stops counting.
    pub packets: u64,
    /// True when the source has more keyframes than were returned, which means
    /// a cut lands exactly where asked no matter where it is placed.
    pub truncated: bool,
}

impl Keyframes {
    /// Positions alone, which is all the timeline draws.
    pub fn positions(&self) -> Vec<f64> {
        self.entries.iter().map(|k| k.at).collect()
    }

    /// The keyframe at or before `at`, which is where a stream copy starting at
    /// `at` will actually begin.
    pub fn at_or_before(&self, at: f64) -> Option<f64> {
        let index = self.entries.partition_point(|k| k.at <= at + 1e-6);
        (index > 0).then(|| self.entries[index - 1].at)
    }

    /// The first keyframe at or after `at`, with a millisecond of grace so a cut
    /// placed on one by snapping is not pushed a whole group later by rounding.
    pub fn at_or_after(&self, at: f64) -> Option<&Keyframe> {
        let index = self.entries.partition_point(|k| k.at < at - 1e-3);
        self.entries.get(index)
    }

    /// The last keyframe at or before `at`, with the same grace.
    pub fn last_at_or_before(&self, at: f64) -> Option<&Keyframe> {
        let index = self.entries.partition_point(|k| k.at <= at + 1e-3);
        (index > 0).then(|| &self.entries[index - 1])
    }

    /// The keyframe that follows `keyframe` in the file, if any.
    pub fn after(&self, keyframe: &Keyframe) -> Option<&Keyframe> {
        let index = self.entries.partition_point(|k| k.index <= keyframe.index);
        self.entries.get(index)
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

/// Parses `pts_time,flags` rows, in the order the packets sit in the file.
///
/// Rows arrive as `12.345000,K__`. Every row counts as a packet, including one
/// whose timestamp is `N/A`, because the count has to agree with what FFmpeg
/// will write when asked for a number of frames. Only a timestamped keyframe
/// becomes a cut point.
fn parse(output: &str) -> Keyframes {
    let mut entries: Vec<Keyframe> = Vec::new();
    let mut packets: u64 = 0;
    let mut truncated = false;

    for line in output.lines() {
        let mut parts = line.split(',');
        let Some(time) = parts.next() else { continue };
        let Some(flags) = parts.next() else { continue };

        let index = packets;
        packets += 1;

        let seconds = time.trim().parse::<f64>().ok().filter(|s| s.is_finite());

        if flags.starts_with('K') {
            let Some(at) = seconds.filter(|s| *s >= 0.0) else { continue };
            if entries.len() >= MAX_KEYFRAMES {
                truncated = true;
                continue;
            }
            entries.push(Keyframe { at, index, leading: 0, lead_start: at });
            continue;
        }

        // A picture that sits after a keyframe in the file but before it on
        // screen belongs to the group before: it is a leading picture, and it
        // is the mark of an open group of pictures.
        if let (Some(at), Some(last)) = (seconds, entries.last_mut()) {
            if at < last.at - 1e-6 && last.index + 1 + u64::from(last.leading) == index {
                last.leading += 1;
                last.lead_start = last.lead_start.min(at);
            }
        }
    }

    // Containers do not guarantee packets in presentation order, and a cut point
    // list is only useful sorted.
    entries.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal));
    entries.dedup_by(|a, b| (a.at - b.at).abs() < 1e-6);

    Keyframes { entries, packets, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_keyframe_packets_are_kept() {
        let output = "0.000000,K__\n0.033333,___\n2.000000,K__\n2.033333,___\n4.000000,K_D\n";
        let keys = parse(output);
        assert_eq!(keys.positions(), vec![0.0, 2.0, 4.0]);
        assert!(!keys.truncated);
        assert_eq!(keys.packets, 5);
    }

    #[test]
    fn packets_without_a_timestamp_are_counted_but_are_not_cut_points() {
        let keys = parse("N/A,K__\n1.500000,K__\n");
        assert_eq!(keys.positions(), vec![1.5]);
        assert_eq!(keys.packets, 2, "FFmpeg counts that packet too when asked for frames");
        assert_eq!(keys.entries[0].index, 1);
    }

    #[test]
    fn out_of_order_packets_are_sorted_and_deduplicated() {
        let keys = parse("4.000000,K__\n0.000000,K__\n4.000000,K__\n2.000000,K__\n");
        assert_eq!(keys.positions(), vec![0.0, 2.0, 4.0]);
    }

    #[test]
    fn malformed_rows_do_not_break_the_list() {
        let keys = parse("garbage\n\n1.0,K__\nalso,bad,extra\n");
        assert_eq!(keys.positions(), vec![1.0]);
    }

    #[test]
    fn an_all_intra_source_is_reported_as_truncated() {
        let output: String =
            (0..MAX_KEYFRAMES + 50).map(|i| format!("{:.6},K__\n", i as f64 * 0.04)).collect();
        let keys = parse(&output);

        assert_eq!(keys.entries.len(), MAX_KEYFRAMES);
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

    /// Packet order is decode order. With B-frames the picture shown third is
    /// stored second, so the count of packets before a keyframe is not the
    /// count of pictures shown before it, and it is the packet count a bounded
    /// copy needs.
    #[test]
    fn keyframes_carry_their_packet_index() {
        let output = "0.000000,K__\n0.100000,___\n0.033333,___\n0.066667,___\n0.133333,K__\n";
        let keys = parse(output);
        assert_eq!(keys.entries[0].index, 0);
        assert_eq!(keys.entries[1].index, 4);
        assert_eq!(keys.entries[0].leading, 0, "a closed group has no leading pictures");
    }

    /// An open group of pictures: the packets right after a keyframe are shown
    /// before it, and refer back to the previous group.
    #[test]
    fn leading_pictures_after_a_keyframe_are_counted() {
        let output = concat!(
            "0.000000,K__\n0.033333,___\n0.066667,___\n",
            "1.000000,K__\n0.966667,___\n0.933333,___\n1.100000,___\n1.033333,___\n"
        );
        let keys = parse(output);

        let second = keys.entries[1];
        assert_eq!(second.at, 1.0);
        assert_eq!(second.index, 3);
        assert_eq!(second.leading, 2);
        assert!((second.lead_start - 0.933333).abs() < 1e-6, "the earliest picture of the group");
        assert_eq!(keys.entries[0].lead_start, 0.0);
    }

    #[test]
    fn neighbours_are_found_with_a_millisecond_of_grace() {
        let keys = parse("0.000000,K__\n2.000000,K__\n4.000000,K__\n");

        assert_eq!(keys.at_or_after(1.9995).map(|k| k.at), Some(2.0), "snapped onto it");
        assert_eq!(keys.at_or_after(2.1).map(|k| k.at), Some(4.0));
        assert_eq!(keys.at_or_after(4.5), None);
        assert_eq!(keys.last_at_or_before(2.0005).map(|k| k.at), Some(2.0));
        assert_eq!(keys.last_at_or_before(3.9).map(|k| k.at), Some(2.0));
        assert_eq!(keys.after(&keys.entries[1]).map(|k| k.at), Some(4.0));
        assert!(keys.after(&keys.entries[2]).is_none());
    }
}
