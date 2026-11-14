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

/// Whether a stream copy may begin at any of this file's keyframes.
///
/// `ffprobe` flags a packet as a keyframe for any picture a seek can land on,
/// which for H.264 includes a plain I-frame and not only an IDR. The two are
/// not interchangeable to a copy: an IDR resets the reference lists and carries
/// its parameter sets, while a non-IDR I-frame does neither, so a piece that
/// starts on one is decoded against pictures that are no longer in the file. It
/// comes out as grey frames with a band of rubble across the top, which is
/// exactly what an open-GOP or intra-refresh recording produced.
///
/// One packet is read, from a keyframe in the middle of the file rather than
/// from its start, because the first frame of any file is an IDR and would
/// answer yes for all of them. Encoders do not mix the two styles within one
/// file, so a single sample settles it — and the sample costs one seek, not a
/// pass over the video.
pub async fn keyframes_are_idr(path: &Path, codec: &str, duration: f64) -> AppResult<bool> {
    // Nothing to sample in a file too short to hold a second keyframe, and a
    // copy of it can only begin at its first frame, which is always an IDR.
    if duration < 1.0 {
        return Ok(true);
    }

    let format = match codec {
        "h264" => "h264",
        "hevc" => "hevc",
        // Only these two are ever stream copied piece by piece; anything else
        // is answered without a process, and conservatively.
        _ => return Ok(false),
    };

    let tools = locator::tools()?;
    let args = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        format!("{:.6}", duration / 2.0),
        "-i".into(),
        path.to_string_lossy().into_owned(),
        "-map".into(),
        "0:v:0".into(),
        "-c:v".into(),
        "copy".into(),
        "-frames:v".into(),
        "1".into(),
        // The raw muxer converts out of the container's length-prefixed form
        // into the byte-stream one, which is where a NAL type can be read.
        "-f".into(),
        format.into(),
        "pipe:1".into(),
    ];

    let bytes = runner::run_capturing_bytes(&tools.ffmpeg, &args).await?;
    Ok(first_picture_is_irap(&bytes, format == "hevc"))
}

/// Reads the first coded picture's NAL type out of a byte stream.
///
/// H.264 numbers an IDR slice 5 and an ordinary one 1. HEVC gives the whole
/// random-access family 16 to 23, which includes CRA: its leading pictures
/// refer backwards, and those are stripped by the planner rather than being a
/// reason to refuse the file.
fn first_picture_is_irap(bytes: &[u8], hevc: bool) -> bool {
    let mut index = 0;
    while index + 4 < bytes.len() {
        if bytes[index] != 0 || bytes[index + 1] != 0 || bytes[index + 2] != 1 {
            index += 1;
            continue;
        }
        let header = bytes[index + 3];
        index += 3;

        if hevc {
            let kind = (header >> 1) & 0x3F;
            // Anything below 32 is a coded picture; the rest is parameter sets
            // and other non-picture data, which says nothing either way.
            if kind < 32 {
                return (16..=23).contains(&kind);
            }
        } else {
            let kind = header & 0x1F;
            if kind == 1 || kind == 5 {
                return kind == 5;
            }
        }
    }
    // Nothing recognisable came back, so the file is not one to copy from.
    false
}

#[cfg(test)]
mod idr_tests {
    use super::first_picture_is_irap;

    fn nal(kind: u8) -> Vec<u8> {
        vec![0, 0, 1, kind]
    }

    #[test]
    fn an_h264_idr_slice_is_a_place_a_copy_may_begin() {
        let mut stream = nal(7); // SPS
        stream.extend(nal(8)); // PPS
        stream.extend(nal(5)); // IDR
        stream.extend([0u8; 8]);
        assert!(first_picture_is_irap(&stream, false));
    }

    /// The defect: a plain I-frame is flagged as a keyframe by the prober and
    /// is not a place a copy may begin.
    #[test]
    fn an_h264_non_idr_slice_is_not() {
        let mut stream = nal(1);
        stream.extend([0u8; 8]);
        assert!(!first_picture_is_irap(&stream, false));
    }

    #[test]
    fn parameter_sets_before_the_picture_are_stepped_over() {
        let mut stream = nal(9); // access unit delimiter
        stream.extend(nal(6)); // SEI
        stream.extend(nal(1)); // an ordinary slice, which is the answer
        stream.extend([0u8; 8]);
        assert!(!first_picture_is_irap(&stream, false));
    }

    #[test]
    fn hevc_random_access_pictures_are_accepted_and_trailing_ones_are_not() {
        for kind in [16u8, 19, 20, 21] {
            let mut stream = nal(32); // VPS
            stream.extend(nal(kind << 1));
            stream.extend([0u8; 8]);
            assert!(first_picture_is_irap(&stream, true), "type {kind} is a random access point");
        }
        let mut trailing = nal(1 << 1);
        trailing.extend([0u8; 8]);
        assert!(!first_picture_is_irap(&trailing, true));
    }

    #[test]
    fn an_empty_or_unreadable_stream_is_refused() {
        assert!(!first_picture_is_irap(&[], false));
        assert!(!first_picture_is_irap(&[0, 0, 0, 0, 0], false));
    }
}
