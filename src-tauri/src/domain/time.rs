use std::fmt;
use std::ops::{Add, Sub};

use serde::{Deserialize, Serialize};

use super::error::{DomainError, DomainResult};

/// Tolerance used whenever two timeline instants are compared. Media timestamps
/// arrive as floating point seconds, so exact equality is never meaningful; one
/// microsecond sits far below a single frame at any realistic frame rate.
pub const EPSILON: f64 = 1e-6;

/// A non-negative, finite instant on a timeline, expressed in seconds.
///
/// Construction is fallible, which keeps every downstream calculation free of
/// NaN and negative-duration defects without repeated defensive checks.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Instant(f64);

impl Instant {
    pub const ZERO: Instant = Instant(0.0);

    pub fn new(seconds: f64) -> DomainResult<Self> {
        if !seconds.is_finite() || seconds < 0.0 {
            return Err(DomainError::InvalidInstant(seconds));
        }
        Ok(Instant(seconds))
    }

    /// Clamps instead of failing. Used where an out-of-range value is a rounding
    /// artefact rather than a caller mistake, such as a probe reporting a
    /// duration a few microseconds short of the last packet.
    pub fn saturating(seconds: f64) -> Self {
        if !seconds.is_finite() || seconds < 0.0 {
            Instant(0.0)
        } else {
            Instant(seconds)
        }
    }

    #[inline]
    pub fn seconds(self) -> f64 {
        self.0
    }

    pub fn min(self, other: Self) -> Self {
        if self.0 <= other.0 {
            self
        } else {
            other
        }
    }

    pub fn max(self, other: Self) -> Self {
        if self.0 >= other.0 {
            self
        } else {
            other
        }
    }

    /// Formats as `HH:MM:SS.mmm`, the notation used throughout the interface.
    pub fn to_timecode(self) -> String {
        let total_ms = (self.0 * 1000.0).round() as u64;
        let ms = total_ms % 1000;
        let total_s = total_ms / 1000;
        let s = total_s % 60;
        let m = (total_s / 60) % 60;
        let h = total_s / 3600;
        format!("{h:02}:{m:02}:{s:02}.{ms:03}")
    }
}

impl Add for Instant {
    type Output = Instant;
    fn add(self, rhs: Instant) -> Instant {
        Instant(self.0 + rhs.0)
    }
}

impl Sub for Instant {
    type Output = Instant;
    /// Saturating subtraction: a timeline instant can never run below zero.
    fn sub(self, rhs: Instant) -> Instant {
        Instant((self.0 - rhs.0).max(0.0))
    }
}

impl fmt::Display for Instant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_timecode())
    }
}

/// A half-open interval on a timeline, guaranteed to be non-empty.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TimeRange {
    start: Instant,
    end: Instant,
}

impl TimeRange {
    pub fn new(start: Instant, end: Instant) -> DomainResult<Self> {
        if end.seconds() - start.seconds() <= EPSILON {
            return Err(DomainError::EmptyRange { start: start.seconds(), end: end.seconds() });
        }
        Ok(TimeRange { start, end })
    }

    pub fn from_seconds(start: f64, end: f64) -> DomainResult<Self> {
        Self::new(Instant::new(start)?, Instant::new(end)?)
    }

    #[inline]
    pub fn start(self) -> Instant {
        self.start
    }

    #[inline]
    pub fn end(self) -> Instant {
        self.end
    }

    #[inline]
    pub fn duration(self) -> f64 {
        self.end.seconds() - self.start.seconds()
    }

    pub fn contains(self, at: Instant) -> bool {
        at.seconds() >= self.start.seconds() - EPSILON
            && at.seconds() < self.end.seconds() - EPSILON
    }

    pub fn overlaps(self, other: Self) -> bool {
        self.start.seconds() < other.end.seconds() - EPSILON
            && other.start.seconds() < self.end.seconds() - EPSILON
    }

    pub fn intersect(self, other: Self) -> Option<Self> {
        Self::new(self.start.max(other.start), self.end.min(other.end)).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_finite_and_negative_instants() {
        assert!(Instant::new(f64::NAN).is_err());
        assert!(Instant::new(f64::INFINITY).is_err());
        assert!(Instant::new(-0.5).is_err());
        assert!(Instant::new(0.0).is_ok());
    }

    #[test]
    fn rejects_ranges_that_do_not_advance() {
        assert!(TimeRange::from_seconds(5.0, 5.0).is_err());
        assert!(TimeRange::from_seconds(5.0, 4.0).is_err());
        assert!(TimeRange::from_seconds(5.0, 5.5).is_ok());
    }

    #[test]
    fn subtraction_saturates_at_zero() {
        let a = Instant::new(1.0).unwrap();
        let b = Instant::new(4.0).unwrap();
        assert_eq!((a - b).seconds(), 0.0);
    }

    #[test]
    fn timecode_renders_hours_minutes_seconds_millis() {
        assert_eq!(Instant::new(0.0).unwrap().to_timecode(), "00:00:00.000");
        assert_eq!(Instant::new(3661.5).unwrap().to_timecode(), "01:01:01.500");
    }

    #[test]
    fn touching_ranges_do_not_overlap() {
        let a = TimeRange::from_seconds(0.0, 10.0).unwrap();
        let b = TimeRange::from_seconds(10.0, 20.0).unwrap();
        assert!(!a.overlaps(b), "touching ranges must not count as overlapping");
        assert!(a.overlaps(TimeRange::from_seconds(9.5, 12.0).unwrap()));
    }

    #[test]
    fn intersection_of_disjoint_ranges_is_none() {
        let a = TimeRange::from_seconds(0.0, 5.0).unwrap();
        let b = TimeRange::from_seconds(6.0, 9.0).unwrap();
        assert!(a.intersect(b).is_none());
        assert_eq!(
            a.intersect(TimeRange::from_seconds(3.0, 9.0).unwrap()),
            TimeRange::from_seconds(3.0, 5.0).ok()
        );
    }
}
