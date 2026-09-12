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

use base64::Engine;
use serde_json::Value;

use crate::application::error::{AppError, AppResult};
use crate::domain::version::Version;

/// The public half of the key every release is signed with.
///
/// In the source on purpose: it is public, it has to ship inside the binary to
/// be worth anything, and pinning it here is what makes an update *this
/// project's* update rather than whatever the network handed over. The private
/// half is a GitHub Actions secret and exists nowhere else — losing it means
/// future releases cannot be signed with it, and copies running this version
/// would refuse them.
const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENFNzYzODFBQUU4NkU3QTcKUldTbjU0YXVHamgyenNwaW0rMk5RQk56bi9MUXVCSjhyV2hnRGlWNUphOENWYnArejdZMXFZVW8K";

/// The extension the signature of an asset is published under.
pub const SIGNATURE_SUFFIX: &str = ".sig";

/// Where the newest published release is described.
///
/// `/releases/latest` skips drafts and pre-releases, which is what makes a draft
/// safe to prepare while everyone keeps running the version before it.
pub const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/OmTsTM/snip-join/releases/latest";

/// The same question, asked of the website instead of the API.
///
/// `api.github.com` and `github.com` are different names, and a machine can
/// reach one and not the other: a DNS filter, a security suite's web shield or
/// a network that allowlists hosts will often know about the site and nothing
/// about its API. This page answers with a redirect to the newest release's tag,
/// which is enough to know whether there is a newer version and what its files
/// are called.
pub const LATEST_RELEASE_PAGE: &str = "https://github.com/OmTsTM/snip-join/releases/latest";

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

/// The signature published beside an asset, if it is there.
pub fn signature_for<'a>(
    assets: &'a [ReleaseAsset],
    asset: &ReleaseAsset,
) -> Option<&'a ReleaseAsset> {
    let wanted = format!("{}{SIGNATURE_SUFFIX}", asset.name);
    assets.iter().find(|candidate| candidate.name == wanted)
}

/// Whether these bytes were signed by this project's key.
///
/// The whole reason the update mechanism is defensible. Everything else about a
/// download can be arranged by whoever is between the machine and GitHub — the
/// address, the size, the name — but not a signature over the bytes, which
/// nobody without the private half of the key can produce. A file that fails
/// this is deleted rather than offered.
///
/// The format is minisign, wrapped in base64, which is what the Tauri signer
/// writes: both the key and the signature are base64 of the file the tool
/// produces.
pub fn verify_signature(bytes: &[u8], signature: &str) -> AppResult<()> {
    let engine = base64::engine::general_purpose::STANDARD;

    let key_text = engine
        .decode(PUBLIC_KEY.trim())
        .ok()
        .and_then(|raw| String::from_utf8(raw).ok())
        .ok_or_else(|| AppError::Internal("this build has no readable signing key".into()))?;

    let key = minisign_verify::PublicKey::decode(key_text.trim())
        .map_err(|error| AppError::Internal(format!("the signing key is unreadable: {error}")))?;

    let signature_text = engine
        .decode(signature.trim())
        .ok()
        .and_then(|raw| String::from_utf8(raw).ok())
        .ok_or_else(|| AppError::InvalidInput("that update has no readable signature".into()))?;

    let signature = minisign_verify::Signature::decode(signature_text.trim())
        .map_err(|_| AppError::InvalidInput("that update has no readable signature".into()))?;

    key.verify(bytes, &signature, true)
        .map_err(|_| AppError::InvalidInput("that update was not signed by Snip Join".into()))
}

/// Reads the tag out of wherever the releases page sends a browser.
///
/// The address is checked as carefully as any other from the network: it has to
/// be this project's own releases, and what follows has to be a version rather
/// than whatever the reply felt like saying.
pub fn tag_from_redirect(location: &str) -> Option<String> {
    const MARK: &str = "/OmTsTM/snip-join/releases/tag/";

    let (before, tag) = location.split_once(MARK)?;
    if !(before.is_empty() || before == "https://github.com") {
        return None;
    }

    let tag = tag.split(['?', '#', '/']).next()?;
    Version::parse(tag)?;
    Some(tag.to_string())
}

/// The files a release of this project is known to carry.
///
/// Built from the tag rather than read from a listing, because the listing is
/// the thing that could not be reached. The names are the ones the release job
/// produces, with the spaces GitHub replaces with dots — a convention this
/// project controls at both ends. A download that turns out not to be there
/// fails as a download rather than as a wrong answer about whether an update
/// exists, and the signature beside it still has to check out either way.
pub fn expected_assets(tag: &str, version: &Version) -> Vec<ReleaseAsset> {
    ["x64-setup.exe", "x64_portable.zip"]
        .iter()
        .flat_map(|kind| {
            let name = format!("Snip.Join_{version}_{kind}");
            let signature = format!("{name}{SIGNATURE_SUFFIX}");
            [name, signature]
        })
        .map(|name| ReleaseAsset {
            url: format!("{DOWNLOAD_PREFIX}{tag}/{name}"),
            name,
            // Unknown until it arrives, and the progress bar copes: what the
            // server reports on the way is what it draws.
            size: 0,
        })
        .collect()
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
/// A release with nothing installable is reported as no update at all rather
/// than as one the user cannot act on: the button would otherwise offer an
/// update and then refuse to fetch it. Installable means all three of a file for
/// this kind of copy, a signature beside it, and both addresses inside this
/// project's own releases — an unsigned release is not an update, because
/// nothing downstream would accept it.
pub fn compare(current: Version, kind: InstallKind, latest: Option<Release>) -> UpdateReport {
    let newer = latest.filter(|release| {
        release.version > current
            && pick_asset(&release.assets, kind).is_some_and(|asset| {
                is_download_allowed(&asset.url)
                    && signature_for(&release.assets, asset)
                        .is_some_and(|signature| is_download_allowed(&signature.url))
            })
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
                asset("Snip Join_1.1.0_x64-setup.exe.sig"),
                asset("Snip Join_1.1.0_x64_portable.zip"),
                asset("Snip Join_1.1.0_x64_portable.zip.sig"),
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
        only_installer.assets.retain(|asset| asset.name.contains("setup.exe"));

        let current = Version::parse("1.1.0").unwrap();
        assert!(compare(current.clone(), InstallKind::Portable, Some(only_installer.clone()))
            .newer
            .is_none());
        assert!(compare(current, InstallKind::Installed, Some(only_installer)).newer.is_some());
    }

    /// Signed with the project's own key, over the bytes of `sigtest.bin`.
    /// Anything else here would be a test of nothing.
    const TEST_BYTES: &[u8] = b"hello snip\n";
    const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTbjU0YXVHamgyenVSdGY4U2laTms4NkJXcUZjTTJCaHZlY2o3bExyMEdkb1MyRGgyV2VHRFZIZ2Z1WURWWmNkRmc4MjRlU0VjbndySnBzaHd4Tm5Ddis2c2RWMTBOY0E4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg5MjEzOTczCWZpbGU6c2lndGVzdC5iaW4KVHI3RmdMcGVrTE95MGUwTnVnalFqTzJlOVB3bDBSM0xVaFYzUk5YSFdmbjNZNFNRRE42SGlneXFjMmxZZmFQQnkvUGV4blcyMVJnRXd5K055Vkl4Q1E9PQo=";

    #[test]
    fn a_file_signed_with_the_projects_key_verifies() {
        assert!(verify_signature(TEST_BYTES, TEST_SIGNATURE).is_ok());
    }

    #[test]
    fn a_single_changed_byte_fails() {
        let mut tampered = TEST_BYTES.to_vec();
        tampered[0] = b'H';
        assert!(verify_signature(&tampered, TEST_SIGNATURE).is_err());
    }

    #[test]
    fn rubbish_in_place_of_a_signature_fails_rather_than_panics() {
        for signature in ["", "not base64 at all !!", "aGVsbG8="] {
            assert!(verify_signature(TEST_BYTES, signature).is_err(), "{signature}");
        }
    }

    #[test]
    fn a_release_with_no_signature_is_not_an_update() {
        let mut unsigned = release("v1.2.0");
        unsigned.assets.retain(|asset| !asset.name.ends_with(SIGNATURE_SUFFIX));

        let current = Version::parse("1.1.0").unwrap();
        assert!(compare(current, InstallKind::Installed, Some(unsigned)).newer.is_none());
    }

    #[test]
    fn each_asset_is_matched_with_its_own_signature() {
        let assets = release("v1.1.0").assets;
        let installer = pick_asset(&assets, InstallKind::Installed).unwrap();
        let signature = signature_for(&assets, installer).unwrap();

        assert_eq!(signature.name, format!("{}{SIGNATURE_SUFFIX}", installer.name));
    }

    #[test]
    fn a_download_address_pointing_elsewhere_is_not_an_update_either() {
        let mut tampered = release("v1.2.0");
        tampered.assets = vec![
            ReleaseAsset {
                name: "Snip Join_1.2.0_x64-setup.exe".into(),
                url: "https://example.com/setup.exe".into(),
                size: 10,
            },
            asset("Snip Join_1.2.0_x64-setup.exe.sig"),
        ];

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
    fn the_releases_page_answers_with_the_newest_tag() {
        for location in [
            "https://github.com/OmTsTM/snip-join/releases/tag/v1.2.0",
            "/OmTsTM/snip-join/releases/tag/v1.2.0",
            "https://github.com/OmTsTM/snip-join/releases/tag/v1.2.0?foo=bar",
        ] {
            assert_eq!(tag_from_redirect(location).as_deref(), Some("v1.2.0"), "{location}");
        }
    }

    #[test]
    fn a_redirect_anywhere_else_is_refused() {
        for location in [
            "https://github.com/someone-else/snip-join/releases/tag/v1.2.0",
            "https://example.com/OmTsTM/snip-join/releases/tag/v1.2.0",
            "https://github.com/OmTsTM/snip-join/releases/tag/nightly",
            "https://github.com/OmTsTM/snip-join/releases",
            "",
        ] {
            assert!(tag_from_redirect(location).is_none(), "{location} should be refused");
        }
    }

    /// The fallback has to produce a release the rest of this module accepts,
    /// or it is an answer nobody can act on.
    #[test]
    fn a_release_built_from_a_tag_alone_is_installable() {
        let version = Version::parse("1.2.0").unwrap();
        let assets = expected_assets("v1.2.0", &version);

        let release = Release { version, tag: "v1.2.0".into(), assets };
        let current = Version::parse("1.1.0").unwrap();

        for kind in [InstallKind::Installed, InstallKind::Portable] {
            let report = compare(current.clone(), kind, Some(release.clone()));
            let newer = report.newer.expect("an update");
            let asset = pick_asset(&newer.assets, kind).unwrap();

            assert!(is_download_allowed(&asset.url));
            assert!(signature_for(&newer.assets, asset).is_some());
        }
    }

    #[test]
    fn a_release_whose_tag_is_not_a_version_is_refused() {
        let body: Value = serde_json::json!({ "tag_name": "nightly" });
        assert!(parse_release(&body).is_err());

        let body: Value = serde_json::json!({});
        assert!(parse_release(&body).is_err());
    }
}
