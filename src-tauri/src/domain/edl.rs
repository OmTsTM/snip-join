use serde::{Deserialize, Serialize};

use super::error::{DomainError, DomainResult};
use super::time::{Instant, TimeRange, EPSILON};

/// One surviving piece of the source, placed at a position on the output
/// timeline. `source` says which part of the original file to read; `timeline_start`
/// says where that part lands in the exported result.
///
/// Keeping the two independent is what lets a block be dragged elsewhere without
/// touching the media: only `timeline_start` changes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub source: TimeRange,
    pub timeline_start: Instant,
}

impl Clip {
    pub fn new(source: TimeRange, timeline_start: Instant) -> Self {
        Clip { source, timeline_start }
    }

    #[inline]
    pub fn duration(&self) -> f64 {
        self.source.duration()
    }

    /// The interval this clip occupies on the output timeline.
    pub fn timeline_range(&self) -> TimeRange {
        TimeRange::new(
            self.timeline_start,
            Instant::saturating(self.timeline_start.seconds() + self.duration()),
        )
        .expect("a clip carries a non-empty source range, so its timeline range advances")
    }

    #[inline]
    pub fn timeline_end(&self) -> Instant {
        Instant::saturating(self.timeline_start.seconds() + self.duration())
    }
}

/// A single stretch of the output timeline: either media read from the source,
/// or an intentional hole left behind by a removal.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Segment {
    Media(Clip),
    /// A hole, rendered as black video and silence on export.
    Gap(TimeRange),
}

impl Segment {
    pub fn duration(&self) -> f64 {
        match self {
            Segment::Media(clip) => clip.duration(),
            Segment::Gap(range) => range.duration(),
        }
    }
}

/// An ordered, non-overlapping list of clips: the complete recipe for an export.
///
/// This is the boundary object between the editor and the encoder. The editor
/// owns a richer block model for the interface; that model is flattened into an
/// `EditList` exactly once, at export time, so the encoder never has to know
/// about selection state, undo history or block numbering.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditList {
    clips: Vec<Clip>,
}

impl EditList {
    /// Builds an edit list, sorting by timeline position and rejecting overlaps.
    ///
    /// Overlaps are a programming error rather than a user error: the editor
    /// prevents them at drag time, so reaching here means an invariant broke.
    pub fn new(mut clips: Vec<Clip>) -> DomainResult<Self> {
        if clips.is_empty() {
            return Err(DomainError::EmptyEdit);
        }

        clips.sort_by(|a, b| {
            a.timeline_start
                .seconds()
                .partial_cmp(&b.timeline_start.seconds())
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for window in 1..clips.len() {
            let previous_end = clips[window - 1].timeline_end().seconds();
            let start = clips[window].timeline_start.seconds();
            if start < previous_end - EPSILON {
                return Err(DomainError::OverlappingClips { index: window, start, previous_end });
            }
        }

        Ok(EditList { clips })
    }

    /// Builds an edit list from clip durations alone, laying them end to end with
    /// no gaps. This is the "join the ends" result.
    pub fn contiguous(sources: Vec<TimeRange>) -> DomainResult<Self> {
        let mut cursor = 0.0;
        let clips = sources
            .into_iter()
            .map(|source| {
                let clip = Clip::new(source, Instant::saturating(cursor));
                cursor += source.duration();
                clip
            })
            .collect();
        EditList::new(clips)
    }

    pub fn clips(&self) -> &[Clip] {
        &self.clips
    }

    pub fn len(&self) -> usize {
        self.clips.len()
    }

    pub fn is_empty(&self) -> bool {
        self.clips.is_empty()
    }

    /// Total length of the exported result, including any leading or interior
    /// gaps. Trailing gaps cannot exist: the timeline ends with the last clip.
    pub fn duration(&self) -> f64 {
        self.clips.last().map(|clip| clip.timeline_end().seconds()).unwrap_or(0.0)
    }

    /// True when the clips run end to end with no holes between them.
    pub fn is_contiguous(&self) -> bool {
        self.segments().iter().all(|s| matches!(s, Segment::Media(_)))
    }

    /// Walks the whole output timeline in order, emitting media and gap segments.
    ///
    /// Gaps shorter than `EPSILON` are swallowed: they are floating point noise
    /// from a drag that landed a hair off, not holes the user asked for. Emitting
    /// them would add zero-length black inserts that some muxers reject.
    pub fn segments(&self) -> Vec<Segment> {
        let mut segments = Vec::with_capacity(self.clips.len() * 2);
        let mut cursor = 0.0_f64;

        for clip in &self.clips {
            let start = clip.timeline_start.seconds();
            if start - cursor > EPSILON {
                if let Ok(gap) = TimeRange::from_seconds(cursor, start) {
                    segments.push(Segment::Gap(gap));
                }
            }
            segments.push(Segment::Media(*clip));
            cursor = clip.timeline_end().seconds();
        }

        segments
    }

    /// The holes on the output timeline, in order.
    pub fn gaps(&self) -> Vec<TimeRange> {
        self.segments()
            .into_iter()
            .filter_map(|segment| match segment {
                Segment::Gap(range) => Some(range),
                Segment::Media(_) => None,
            })
            .collect()
    }

    /// Maps an instant on the output timeline back to an instant in the source
    /// file, or `None` when it lands in a gap.
    ///
    /// This is what drives preview playback: the player asks where to seek the
    /// underlying video element for the current timeline position.
    pub fn source_at(&self, timeline_at: Instant) -> Option<Instant> {
        let at = timeline_at.seconds();
        self.clips.iter().find_map(|clip| {
            let start = clip.timeline_start.seconds();
            let end = clip.timeline_end().seconds();
            if at >= start - EPSILON && at < end - EPSILON {
                Some(Instant::saturating(clip.source.start().seconds() + (at - start)))
            } else {
                None
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(source_start: f64, source_end: f64, timeline_start: f64) -> Clip {
        Clip::new(
            TimeRange::from_seconds(source_start, source_end).unwrap(),
            Instant::new(timeline_start).unwrap(),
        )
    }

    #[test]
    fn an_empty_edit_is_rejected() {
        assert_eq!(EditList::new(vec![]).unwrap_err(), DomainError::EmptyEdit);
    }

    #[test]
    fn overlapping_clips_are_rejected() {
        let result = EditList::new(vec![clip(0.0, 10.0, 0.0), clip(20.0, 30.0, 5.0)]);
        assert!(matches!(result.unwrap_err(), DomainError::OverlappingClips { .. }));
    }

    #[test]
    fn clips_are_sorted_by_timeline_position() {
        let edl = EditList::new(vec![clip(20.0, 30.0, 10.0), clip(0.0, 10.0, 0.0)]).unwrap();
        assert_eq!(edl.clips()[0].timeline_start.seconds(), 0.0);
        assert_eq!(edl.clips()[1].timeline_start.seconds(), 10.0);
    }

    #[test]
    fn joining_the_ends_produces_a_contiguous_list() {
        // Removing 10..20 from a 30 second source and joining the remainder.
        let edl = EditList::contiguous(vec![
            TimeRange::from_seconds(0.0, 10.0).unwrap(),
            TimeRange::from_seconds(20.0, 30.0).unwrap(),
        ])
        .unwrap();

        assert!(edl.is_contiguous());
        assert_eq!(edl.duration(), 20.0);
        assert!(edl.gaps().is_empty());
        assert_eq!(edl.clips()[1].timeline_start.seconds(), 10.0);
    }

    #[test]
    fn leaving_the_hole_produces_a_gap_segment() {
        // The same removal, but the surviving pieces stay where they were.
        let edl = EditList::new(vec![clip(0.0, 10.0, 0.0), clip(20.0, 30.0, 20.0)]).unwrap();

        assert!(!edl.is_contiguous());
        assert_eq!(edl.duration(), 30.0);

        let gaps = edl.gaps();
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].start().seconds(), 10.0);
        assert_eq!(gaps[0].end().seconds(), 20.0);
    }

    #[test]
    fn a_block_moved_away_from_zero_leaves_a_leading_gap() {
        let edl = EditList::new(vec![clip(0.0, 10.0, 5.0)]).unwrap();
        let segments = edl.segments();
        assert!(matches!(segments[0], Segment::Gap(_)));
        assert_eq!(segments[0].duration(), 5.0);
        assert_eq!(edl.duration(), 15.0);
    }

    #[test]
    fn sub_epsilon_gaps_are_swallowed() {
        let edl = EditList::new(vec![clip(0.0, 10.0, 0.0), clip(20.0, 30.0, 10.0 + 1e-9)]).unwrap();
        assert!(edl.gaps().is_empty(), "float noise must not become a black insert");
    }

    #[test]
    fn timeline_position_maps_back_into_the_source() {
        let edl = EditList::contiguous(vec![
            TimeRange::from_seconds(0.0, 10.0).unwrap(),
            TimeRange::from_seconds(20.0, 30.0).unwrap(),
        ])
        .unwrap();

        // Before the seam: identity.
        assert_eq!(edl.source_at(Instant::new(4.0).unwrap()).unwrap().seconds(), 4.0);
        // After the seam: the removed stretch is skipped.
        assert_eq!(edl.source_at(Instant::new(12.0).unwrap()).unwrap().seconds(), 22.0);
        // Past the end.
        assert!(edl.source_at(Instant::new(25.0).unwrap()).is_none());
    }

    #[test]
    fn a_position_inside_a_gap_maps_to_nothing() {
        let edl = EditList::new(vec![clip(0.0, 10.0, 0.0), clip(20.0, 30.0, 20.0)]).unwrap();
        assert!(edl.source_at(Instant::new(15.0).unwrap()).is_none());
    }
}
