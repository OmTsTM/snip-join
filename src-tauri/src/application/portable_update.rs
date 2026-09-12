//! Replacing a portable copy with a newer one, in place.
//!
//! An installed copy is replaced by its own installer, which knows how to do
//! this. A portable copy is a folder somebody unzipped, so there is no installer
//! to run and the application has to do the swap itself — and it cannot do it
//! while it is the thing being swapped: Windows will not let a running
//! executable be overwritten.
//!
//! What makes it possible without a shell script is that the new version can
//! finish the job for the old one. A copy of the new executable is put somewhere
//! outside the folder being replaced and started with `--finish-update`; it
//! waits for the old process to let go, copies the new files over the old ones,
//! and starts what it just installed. Nothing here writes a batch file, and
//! every process is started with an argument vector.

use std::path::{Component, Path, PathBuf};

use crate::application::error::{AppError, AppResult};

/// What the swap leaves alone.
///
/// The portable copy's own storage: preview cache, scratch space, the web
/// view's data, the chosen language and dock height. It is the user's, it is not
/// part of the release, and an update that wiped it would be a downgrade
/// wearing a new version number.
pub const KEPT: &str = "data";

/// What the outgoing executable is renamed to.
///
/// Windows will not overwrite a running executable but will happily rename one,
/// which is the whole trick: the old file steps aside under this name and the
/// new one takes its place. The next start sweeps it.
pub const OLD_SUFFIX: &str = ".old";

/// The executable, in both folders.
pub const EXECUTABLE: &str = "snipjoin.exe";

/// How long the finisher keeps trying before giving up.
///
/// The old process is on its way out when the finisher starts, and "on its way"
/// is not instant: the window has to close, the runtime has to unwind, and until
/// it does its executable cannot be renamed. Half a minute is far longer than
/// that ever takes and short enough that a genuinely stuck copy does not leave a
/// process waiting forever.
pub const PATIENCE: std::time::Duration = std::time::Duration::from_secs(30);

/// Unpacks the archive and answers with the folder holding the new copy.
///
/// The portable archive wraps everything in one folder, so the payload is that
/// folder rather than the extraction directory. A zip that arrives shaped some
/// other way is refused rather than guessed at.
pub fn extract(archive: &Path, into: &Path) -> AppResult<PathBuf> {
    let file = std::fs::File::open(archive)
        .map_err(|error| AppError::UnreadableFile(format!("{}: {error}", archive.display())))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| {
        AppError::InvalidInput(format!("that update is not an archive: {error}"))
    })?;

    std::fs::create_dir_all(into)?;

    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| AppError::InvalidInput(format!("that archive is damaged: {error}")))?;

        // `enclosed_name` refuses `..` and absolute paths. Without it an archive
        // could name `..\..\Windows\System32\anything` and be extracted over it,
        // which is the oldest trick there is against an unpacker.
        let Some(relative) = entry.enclosed_name() else {
            return Err(AppError::InvalidInput("that archive names a file outside itself".into()));
        };

        let destination = into.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&destination)?;
            continue;
        }

        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut target = std::fs::File::create(&destination)?;
        std::io::copy(&mut entry, &mut target)?;
    }

    payload_root(into)
}

/// The single folder an extracted archive holds, and the checks that it is one.
fn payload_root(extracted: &Path) -> AppResult<PathBuf> {
    let mut directories = Vec::new();
    for entry in std::fs::read_dir(extracted)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            directories.push(entry.path());
        }
    }

    let root = match directories.len() {
        // Some other packer, or a future one, might not wrap the files.
        0 => extracted.to_path_buf(),
        1 => directories.remove(0),
        _ => return Err(AppError::InvalidInput("that archive is not a Snip Join copy".into())),
    };

    if !root.join(EXECUTABLE).is_file() {
        return Err(AppError::InvalidInput("that archive holds no Snip Join".into()));
    }

    Ok(root)
}

/// Copies the new copy over the old one.
///
/// Returns an error rather than half-doing it: the executable is moved aside
/// first, because everything else can be overwritten in place and it cannot, and
/// because a failure after that point still leaves a runnable copy under the old
/// name for someone to rescue by hand.
pub fn swap(payload: &Path, install: &Path) -> AppResult<()> {
    if !install.join(EXECUTABLE).is_file() {
        return Err(AppError::InvalidInput("that is not a Snip Join folder".into()));
    }

    let running = install.join(EXECUTABLE);
    let stepped_aside = install.join(format!("{EXECUTABLE}{OLD_SUFFIX}"));
    let _ = std::fs::remove_file(&stepped_aside);
    std::fs::rename(&running, &stepped_aside).map_err(|error| {
        AppError::Internal(format!("the old copy would not step aside: {error}"))
    })?;

    copy_over(payload, install)
}

fn copy_over(from: &Path, to: &Path) -> AppResult<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();

        // The portable copy's own storage stays exactly as it is.
        if name.eq_ignore_ascii_case(KEPT) {
            continue;
        }

        let destination = to.join(&name);
        if entry.file_type()?.is_dir() {
            std::fs::create_dir_all(&destination)?;
            copy_over(&entry.path(), &destination)?;
        } else {
            std::fs::copy(entry.path(), &destination)?;
        }
    }

    Ok(())
}

/// Reads the two paths `--finish-update` carries, if this is that kind of start.
///
/// Both are checked here rather than trusted: they come from a command line, and
/// while the only thing that writes it is the application itself, a mistake in
/// that argument would have the finisher copy a folder over another folder.
pub fn finishing_arguments<I: Iterator<Item = String>>(args: I) -> Option<(PathBuf, PathBuf)> {
    let mut args = args.skip_while(|argument| argument != "--finish-update");
    args.next()?;

    let payload = PathBuf::from(args.next()?);
    let install = PathBuf::from(args.next()?);

    let sane = |path: &Path| {
        path.is_absolute() && !path.components().any(|part| part == Component::ParentDir)
    };
    if !sane(&payload) || !sane(&install) {
        return None;
    }

    Some((payload, install))
}

/// Waits for the old copy to let go, swaps the folders, and starts the new one.
///
/// Runs instead of the editor, before any window exists: the whole point is that
/// this process is not the one being replaced.
pub fn finish(payload: &Path, install: &Path) -> AppResult<()> {
    let deadline = std::time::Instant::now() + PATIENCE;

    loop {
        match swap(payload, install) {
            Ok(()) => break,
            Err(error) if std::time::Instant::now() >= deadline => return Err(error),
            // Usually a file the old copy still has open — an export's FFmpeg,
            // say — which stops being true a moment later.
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(200)),
        }
    }

    /*
      Now wait for the old copy to actually be gone, by deleting what it is
      running from.

      Renaming the executable did not need it to have exited, which is the trick
      that makes the swap possible — but starting the new one does. Both copies
      share the folder the web view keeps its own storage in, and a second
      instance starting while the first still holds it is a window that fails to
      appear. A running executable cannot be deleted on Windows and one that has
      exited can, so this asks the only question that matters and tidies up by
      asking it.
    */
    let outgoing = install.join(format!("{EXECUTABLE}{OLD_SUFFIX}"));
    while std::fs::remove_file(&outgoing).is_err() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    std::process::Command::new(install.join(EXECUTABLE))
        .current_dir(install)
        .spawn()
        .map_err(|error| AppError::Internal(format!("the new copy would not start: {error}")))?;

    Ok(())
}

/// Where an update is unpacked before it replaces anything.
///
/// The system temporary folder rather than the application's own scratch space,
/// which is swept at startup — and the copy doing the sweeping would be the one
/// this update just started.
pub fn staging(version: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{STAGING_PREFIX}{version}"))
}

/// The prefix every staging folder carries, so they can be found again.
const STAGING_PREFIX: &str = "snipjoin-update-";

/// Removes what a previous update left behind, if anything.
///
/// Both halves: the outgoing executable beside the new one, and the folder the
/// new one was unpacked into. Best effort throughout — the finisher may still
/// be exiting, and a file it still holds is one this start simply leaves for the
/// next.
pub fn sweep(install: &Path) {
    let _ = std::fs::remove_file(install.join(format!("{EXECUTABLE}{OLD_SUFFIX}")));

    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(STAGING_PREFIX) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("snipjoin-portable-{name}"));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    /// A portable archive, shaped the way `build-portable.mjs` writes one.
    fn archive(at: &Path, version: &str) {
        let file = std::fs::File::create(at).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();

        for (name, contents) in [
            ("Snip Join/snipjoin.exe", version),
            ("Snip Join/portable.txt", "portable"),
            ("Snip Join/bin/ffmpeg.exe", version),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(contents.as_bytes()).unwrap();
        }

        zip.finish().unwrap();
    }

    #[test]
    fn an_archive_unpacks_to_the_folder_that_holds_the_new_copy() {
        let root = scratch("extract");
        let zip = root.join("update.zip");
        archive(&zip, "new");

        let payload = extract(&zip, &root.join("staging")).unwrap();

        assert_eq!(payload.file_name().unwrap(), "Snip Join");
        assert!(payload.join(EXECUTABLE).is_file());
        assert!(payload.join("bin/ffmpeg.exe").is_file());
    }

    #[test]
    fn the_swap_replaces_the_program_and_keeps_what_is_the_users() {
        let root = scratch("swap");
        let install = root.join("Snip Join");
        write(&install.join(EXECUTABLE), "old");
        write(&install.join("bin").join("ffmpeg.exe"), "old");
        write(&install.join(KEPT).join("settings.json"), "the user's");

        let zip = root.join("update.zip");
        archive(&zip, "new");
        let payload = extract(&zip, &root.join("staging")).unwrap();

        swap(&payload, &install).unwrap();

        assert_eq!(std::fs::read_to_string(install.join(EXECUTABLE)).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(install.join("bin/ffmpeg.exe")).unwrap(), "new");
        assert_eq!(
            std::fs::read_to_string(install.join(KEPT).join("settings.json")).unwrap(),
            "the user's",
            "the portable copy's own storage is not part of the release"
        );

        // The outgoing executable is kept until the next start, which is what
        // lets the swap happen while the old one is still running.
        assert!(install.join(format!("{EXECUTABLE}{OLD_SUFFIX}")).is_file());
        sweep(&install);
        assert!(!install.join(format!("{EXECUTABLE}{OLD_SUFFIX}")).is_file());
    }

    #[test]
    fn a_folder_that_is_not_snip_join_is_refused() {
        let root = scratch("refuse");
        let payload = root.join("payload");
        write(&payload.join(EXECUTABLE), "new");

        let empty = root.join("somewhere else");
        std::fs::create_dir_all(&empty).unwrap();

        assert!(swap(&payload, &empty).is_err());
    }

    /// The oldest trick against an unpacker: a name that climbs out of the
    /// folder it was given.
    #[test]
    fn an_archive_naming_a_file_outside_itself_is_refused() {
        let root = scratch("zipslip");
        let zip = root.join("evil.zip");

        let file = std::fs::File::create(&zip).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        writer.start_file("../escaped.txt", options).unwrap();
        writer.write_all(b"got out").unwrap();
        writer.finish().unwrap();

        assert!(extract(&zip, &root.join("staging")).is_err());
        assert!(!root.join("escaped.txt").exists());
    }

    #[test]
    fn an_archive_with_no_snip_join_in_it_is_refused() {
        let root = scratch("wrong");
        let zip = root.join("wrong.zip");

        let file = std::fs::File::create(&zip).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        writer.start_file("Something Else/readme.txt", options).unwrap();
        writer.write_all(b"not an editor").unwrap();
        writer.finish().unwrap();

        assert!(extract(&zip, &root.join("staging")).is_err());
    }

    #[test]
    fn the_finishing_arguments_are_read_and_checked() {
        let args = |raw: &[&str]| raw.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();

        let (payload, install) = finishing_arguments(args(&[
            "snipjoin.exe",
            "--finish-update",
            "C:\\staging\\Snip Join",
            "C:\\Program Files\\Snip Join",
        ]))
        .unwrap();
        assert_eq!(payload, PathBuf::from("C:\\staging\\Snip Join"));
        assert_eq!(install, PathBuf::from("C:\\Program Files\\Snip Join"));

        // An ordinary start, and two malformed ones.
        assert!(finishing_arguments(args(&["snipjoin.exe"])).is_none());
        assert!(finishing_arguments(args(&["snipjoin.exe", "--finish-update"])).is_none());
        assert!(finishing_arguments(args(&[
            "snipjoin.exe",
            "--finish-update",
            "relative\\path",
            "C:\\Snip Join"
        ]))
        .is_none());
        assert!(finishing_arguments(args(&[
            "snipjoin.exe",
            "--finish-update",
            "C:\\staging\\..\\..\\Windows",
            "C:\\Snip Join"
        ]))
        .is_none());
    }
}
