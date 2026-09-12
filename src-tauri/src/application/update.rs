//! Is there a newer Snip Join, and which file of it belongs on this machine.
//!
//! The renderer has no HTTP capability of its own and is not getting one for
//! this: everything here runs in the backend, reaches exactly two addresses, and
//! hands back a description rather than a file the web view could do anything
//! with.
//!
//! What this deliberately is not: a silent updater. Nothing is fetched until the
//! user asks, nothing is run without them pressing "install", and the installer
//! that appears is the same signed-or-not executable they would have downloaded
//! from the releases page by hand. The trust here is in GitHub over TLS and
//! nothing more — there is no signature check, so an update is exactly as
//! trustworthy as the repository it comes from.

use serde_json::Value;

use crate::application::error::{AppError, AppResult};
use crate::domain::version::Version;

/// Where the newest published release is described.
///
/// `/releases/latest` skips drafts and pre-releases, which is what makes a draft
/// safe to prepare while everyone keeps running the version before it.
pub const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/OmTsTM/snip-join/releases/latest";

/// Every download has to start here.
///
/// The addresses come out of a JSON document fetched over the network, and a
/// URL from there is untrusted input like any other: without this a tampered or
/// mistaken response could point the download at any host on the internet and
/// the application would fetch it and offer to run it. GitHub redirects these to
/// its own asset storage, which the client follows — the guard is on where the
/// chain begins, which is the part the response cannot move.
const DOWNLOAD_PREFIX: &str = "https://github.com/OmTsTM/snip-join/releases/download/";

/// How this copy of Snip Join was put on the machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    /// Installed by the NSIS installer, and replaced by running a newer one.
    Installed,
    /// Unzipped somewhere by hand, and replaced by unzipping a newer one.
    Portable,
}

/// One file attached to a release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
}

/// A published release, as much of it as matters here.
///
/// Three things are taken from the document and nothing else: a tag that has to
/// parse as a version, an asset name that is only ever used as a file name, and
/// an asset address that is checked against this project's own downloads. The
/// page to read about it is built from the tag rather than taken from the reply,
/// so no address out of a network document is ever handed to a browser.
#[derive(Debug, Clone)]
pub struct Release {
    pub version: Version,
    pub tag: String,
    pub assets: Vec<ReleaseAsset>,
}

/// Reads the release GitHub described.
///
/// Every field is treated as untrusted: this is a JSON document from the
/// network, and a release whose tag is not a version is not something to guess
/// about.
pub fn parse_release(body: &Value) -> AppResult<Release> {
    let tag = body
        .get("tag_name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("the release has no tag".into()))?;

    let version = Version::parse(tag)
        .ok_or_else(|| AppError::Internal(format!("`{tag}` is not a version")))?;

    let assets = body
        .get("assets")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|asset| {
                    Some(ReleaseAsset {
                        name: asset.get("name")?.as_str()?.to_string(),
                        url: asset.get("browser_download_url")?.as_str()?.to_string(),
                        size: asset.get("size").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(Release { version, tag: tag.to_string(), assets })
}

/// The file this machine should be offered.
///
/// An installed copy is replaced by running the installer; a portable one by
/// unzipping the archive over the folder it lives in. Offering the wrong one is
/// worse than offering none: an installer run against a portable copy would
/// leave two Snip Joins on the machine, one of them in the registry.
pub fn pick_asset(assets: &[ReleaseAsset], kind: InstallKind) -> Option<&ReleaseAsset> {
    assets.iter().find(|asset| {
        let name = asset.name.to_ascii_lowercase();
        match kind {
            InstallKind::Installed => name.ends_with(".exe"),
            InstallKind::Portable => name.ends_with(".zip") && name.contains("portable"),
        }
    })
}

/// Whether a download address is one this application is willing to fetch.
pub fn is_download_allowed(url: &str) -> bool {
    url.starts_with(DOWNLOAD_PREFIX)
}

/// What the update check has to say.
#[derive(Debug, Clone)]
pub struct UpdateReport {
    pub current: Version,
    pub kind: InstallKind,
    /// The published release, when there is one that is newer than `current`.
    pub newer: Option<Release>,
}

/// Compares what is running with what was published.
///
/// A release with nothing attached for this kind of copy is reported as no
/// update at all rather than as one the user cannot act on: the button would
/// otherwise offer an update and then refuse to fetch it.
pub fn compare(current: Version, kind: InstallKind, latest: Option<Release>) -> UpdateReport {
    let newer = latest.filter(|release| {
        release.version > current
            && pick_asset(&release.assets, kind)
                .is_some_and(|asset| is_download_allowed(&asset.url))
    });

    UpdateReport { current, kind, newer }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: name.to_string(),
            url: format!("{DOWNLOAD_PREFIX}v1.1.0/{name}"),
            size: 10,
        }
    }

    fn release(tag: &str) -> Release {
        Release {
            version: Version::parse(tag).unwrap(),
            tag: tag.to_string(),
            assets: vec![
                asset("Snip Join_1.1.0_x64-setup.exe"),
                asset("Snip Join_1.1.0_x64_portable.zip"),
            ],
        }
    }

    #[test]
    fn each_kind_of_copy_is_offered_the_file_that_replaces_it() {
        let assets = release("v1.1.0").assets;

        let installed = pick_asset(&assets, InstallKind::Installed).unwrap();
        assert!(installed.name.ends_with(".exe"));

        let portable = pick_asset(&assets, InstallKind::Portable).unwrap();
        assert!(portable.name.ends_with("_portable.zip"));
    }

    /// The portable archive is a zip and so is the source code GitHub attaches
    /// to every release; only one of them is Snip Join.
    #[test]
    fn a_source_archive_is_not_mistaken_for_the_portable_build() {
        let assets = vec![asset("snip-join-1.1.0-source.zip")];
        assert!(pick_asset(&assets, InstallKind::Portable).is_none());
    }

    #[test]
    fn only_the_projects_own_release_downloads_are_allowed() {
        assert!(is_download_allowed(&format!("{DOWNLOAD_PREFIX}v1.1.0/setup.exe")));

        for url in [
            "http://github.com/OmTsTM/snip-join/releases/download/v1.1.0/setup.exe",
            "https://github.com/someone-else/snip-join/releases/download/v1.1.0/setup.exe",
            "https://example.com/setup.exe",
            "https://github.com.example.com/OmTsTM/snip-join/releases/download/v1.1.0/x.exe",
        ] {
            assert!(!is_download_allowed(url), "{url} should be refused");
        }
    }

    #[test]
    fn an_older_or_equal_release_is_not_an_update() {
        let current = Version::parse("1.1.0").unwrap();

        for tag in ["v1.1.0", "v1.0.9", "v0.9.0"] {
            let report = compare(current.clone(), InstallKind::Installed, Some(release(tag)));
            assert!(report.newer.is_none(), "{tag} should not be an update");
        }

        let report = compare(current, InstallKind::Installed, Some(release("v1.2.0")));
        assert!(report.newer.is_some());
    }

    /// Reported as nothing to do rather than as an update that cannot be
    /// fetched: the button would otherwise offer one and then refuse it.
    #[test]
    fn a_release_with_nothing_for_this_copy_is_not_an_update() {
        let mut only_installer = release("v1.2.0");
        only_installer.assets.retain(|asset| asset.name.ends_with(".exe"));

        let current = Version::parse("1.1.0").unwrap();
        assert!(compare(current.clone(), InstallKind::Portable, Some(only_installer.clone()))
            .newer
            .is_none());
        assert!(compare(current, InstallKind::Installed, Some(only_installer)).newer.is_some());
    }

    #[test]
    fn a_download_address_pointing_elsewhere_is_not_an_update_either() {
        let mut tampered = release("v1.2.0");
        tampered.assets = vec![ReleaseAsset {
            name: "Snip Join_1.2.0_x64-setup.exe".into(),
            url: "https://example.com/setup.exe".into(),
            size: 10,
        }];

        let current = Version::parse("1.1.0").unwrap();
        assert!(compare(current, InstallKind::Installed, Some(tampered)).newer.is_none());
    }

    #[test]
    fn the_release_document_is_read_as_untrusted_input() {
        let body: Value = serde_json::json!({
            "tag_name": "v1.2.0",
            "html_url": "https://github.com/OmTsTM/snip-join/releases/tag/v1.2.0",
            "assets": [
                { "name": "Snip Join_1.2.0_x64-setup.exe",
                  "browser_download_url": "https://github.com/OmTsTM/snip-join/releases/download/v1.2.0/setup.exe",
                  "size": 42 },
                { "name": "no url here" },
                "not an object"
            ]
        });

        let release = parse_release(&body).unwrap();
        assert_eq!(release.version, Version::parse("1.2.0").unwrap());
        assert_eq!(release.assets.len(), 1, "entries missing a field are dropped");
        assert_eq!(release.assets[0].size, 42);
    }

    #[test]
    fn a_release_whose_tag_is_not_a_version_is_refused() {
        let body: Value = serde_json::json!({ "tag_name": "nightly" });
        assert!(parse_release(&body).is_err());

        let body: Value = serde_json::json!({});
        assert!(parse_release(&body).is_err());
    }
}
