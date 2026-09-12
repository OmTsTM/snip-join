//! Which of two versions is newer.
//!
//! Small enough to write, and worth writing rather than pulling in: the whole
//! question the update check asks is "is the published number ahead of the one
//! running", and comparing the two as strings answers it wrongly the first time
//! a tenth minor release comes out — `"1.10.0" < "1.9.0"` is true of text and
//! false of versions.

use std::cmp::Ordering;
use std::fmt;

/// A released version: three numbers, and whether it is a final one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    /// What followed a `-`, if anything: `1.2.0-beta.1` carries `beta.1`.
    pub pre_release: Option<String>,
}

impl Version {
    /// Reads `1.2.3`, `v1.2.3` or `1.2.3-beta.1`, and nothing else.
    ///
    /// Deliberately strict about the shape and forgiving about the leading `v`:
    /// tags carry it, `package.json` does not, and the two are compared to each
    /// other constantly. Build metadata after `+` is dropped, as semver says it
    /// takes no part in ordering.
    pub fn parse(raw: &str) -> Option<Version> {
        let text = raw.trim();
        let text = text.strip_prefix('v').or_else(|| text.strip_prefix('V')).unwrap_or(text);
        let text = text.split('+').next()?;

        let (numbers, pre_release) = match text.split_once('-') {
            Some((numbers, pre)) if !pre.is_empty() => (numbers, Some(pre.to_string())),
            Some(_) => return None,
            None => (text, None),
        };

        let mut parts = numbers.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }

        Some(Version { major, minor, patch, pre_release })
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.major
            .cmp(&other.major)
            .then(self.minor.cmp(&other.minor))
            .then(self.patch.cmp(&other.patch))
            // A pre-release comes before the final version of the same number,
            // so someone running 1.2.0-beta is told that 1.2.0 is out. Two
            // pre-releases of the same number are compared as text, which is
            // right for `beta.1` against `beta.2` and near enough for the rest.
            .then(match (&self.pre_release, &other.pre_release) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => a.cmp(b),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(pre) = &self.pre_release {
            write!(f, "-{pre}")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(raw: &str) -> Version {
        Version::parse(raw).expect("parses")
    }

    #[test]
    fn the_leading_v_a_tag_carries_is_optional() {
        assert_eq!(v("v1.2.3"), v("1.2.3"));
        assert_eq!(v(" 1.2.3 "), v("1.2.3"));
    }

    /// The reason this module exists rather than a string comparison.
    #[test]
    fn numbers_are_compared_as_numbers() {
        assert!(v("1.10.0") > v("1.9.9"));
        assert!(v("2.0.0") > v("1.99.99"));
        assert!(v("1.2.10") > v("1.2.9"));
    }

    #[test]
    fn a_pre_release_comes_before_the_version_it_leads_to() {
        assert!(v("1.2.0-beta.1") < v("1.2.0"));
        assert!(v("1.2.0-beta.1") < v("1.2.0-beta.2"));
        assert!(v("1.2.0-beta.9") > v("1.1.9"));
    }

    #[test]
    fn build_metadata_takes_no_part() {
        assert_eq!(v("1.2.3+windows"), v("1.2.3"));
    }

    #[test]
    fn anything_that_is_not_three_numbers_is_refused() {
        for raw in ["", "1", "1.2", "1.2.3.4", "1.2.x", "latest", "v", "1.2.3-"] {
            assert!(Version::parse(raw).is_none(), "{raw} should not parse");
        }
    }

    #[test]
    fn it_prints_the_way_it_was_read() {
        assert_eq!(v("v1.2.3").to_string(), "1.2.3");
        assert_eq!(v("1.2.0-beta.1").to_string(), "1.2.0-beta.1");
    }
}
