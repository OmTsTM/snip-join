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

/// Finds the program in a portable copy's folder.
///
/// Looked for rather than named. The packer decides what the executable is
/// called — today `SnipJoin.exe`, which is not what Cargo produced — and a
/// constant here would be a second place that has to agree with it, quietly, in
/// the one piece of code that replaces the application. Windows would forgive a
/// mismatched case; a volume with case sensitivity switched on would not, and
/// neither would a rename.
///
/// There is exactly one program at the top of that folder: FFmpeg lives in
/// `bin/`, and an outgoing executable ends in `.old`.
pub fn executable_in(folder: &Path) -> Option<PathBuf> {
    let mut found = None;

    for entry in std::fs::read_dir(folder).ok()?.flatten() {
        if !entry.file_type().ok()?.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().is_some_and(|end| end.eq_ignore_ascii_case("exe")) {
            // Two would mean this is not the folder anyone thought it was.
            if found.is_some() {
                return None;
            }
            found = Some(path);
        }
    }

    found
}

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

    if executable_in(&root).is_none() {
        return Err(AppError::InvalidInput("that archive holds no Snip Join".into()));
    }

    Ok(root)
}

/// Copies the new copy over the old one.
///
/// The executable is moved aside first, because everything else can be
/// overwritten in place and it cannot. If anything after that goes wrong — a
/// locked file, a full disk, a folder that turns out to be read-only — the old
/// executable is put straight back: a half-copied folder with no program in it
/// is worse than no update at all, and it is what somebody would be left
/// double-clicking.
pub fn swap(payload: &Path, install: &Path) -> AppResult<()> {
    let running = executable_in(install)
        .ok_or_else(|| AppError::InvalidInput("that is not a Snip Join folder".into()))?;

    let stepped_aside = outgoing(install);
    let _ = std::fs::remove_file(&stepped_aside);
    std::fs::rename(&running, &stepped_aside).map_err(|error| {
        AppError::Internal(format!("the old copy would not step aside: {error}"))
    })?;

    if let Err(error) = copy_over(payload, install) {
        let _ = std::fs::rename(&stepped_aside, &running);
        return Err(error);
    }

    Ok(())
}

/// Where the outgoing executable waits until the process using it has ended.
fn outgoing(install: &Path) -> PathBuf {
    install.join(format!("program{OLD_SUFFIX}"))
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
            Err(error) if std::time::Instant::now() >= deadline => {
                // Giving up is not the same as disappearing. The folder is back
                // as it was, so the old copy is started again rather than
                // leaving somebody looking at a window that never returns — the
                // update failed, the application did not.
                launch(install);
                return Err(error);
            }
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
    let outgoing = outgoing(install);
    while std::fs::remove_file(&outgoing).is_err() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    launch(install);
    Ok(())
}

/// Starts whatever program is in the folder, if there is one.
///
/// Best effort by design: this is called both after a successful swap and after
/// a failed one, and in neither case is there anybody left to report to — the
/// window that asked for the update is gone.
fn launch(install: &Path) {
    let Some(program) = executable_in(install) else { return };
    if let Err(error) = std::process::Command::new(program).current_dir(install).spawn() {
        tracing::error!(%error, "the copy in that folder would not start");
    }
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

/// Removes everything an update leaves behind, and keeps asking until it is
/// gone.
///
/// Three things: the copy that was replaced, the folder the new one was unpacked
/// into, and the file it was downloaded from. Together they are a couple of
/// hundred megabytes of nothing, and none of it is the user's — an update is a
/// means to an end that ended a minute ago.
///
/// On a thread, and patient, because the moment this runs is the moment none of
/// them can be deleted yet: the finisher is still exiting from inside the
/// staging folder, and an installer may still be running from the download. A
/// file in use cannot be removed on Windows, and the answer is to ask again in a
/// moment rather than to leave it lying there until somebody notices.
pub fn tidy_up(install: Option<PathBuf>, downloads: PathBuf) {
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);

        loop {
            let mut left_behind = false;

            if let Some(folder) = &install {
                left_behind |= !remove_file(&outgoing(folder));
            }

            left_behind |= !remove_tree(&downloads);

            if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with(STAGING_PREFIX) {
                        left_behind |= !remove_tree(&entry.path());
                    }
                }
            }

            if !left_behind || std::time::Instant::now() >= deadline {
                return;
            }

            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

/// Whether the file is gone, having tried to remove it. Absent counts as gone.
fn remove_file(path: &Path) -> bool {
    std::fs::remove_file(path).is_ok() || !path.exists()
}

/// Whether the folder is gone, having tried to remove it.
fn remove_tree(path: &Path) -> bool {
    std::fs::remove_dir_all(path).is_ok() || !path.exists()
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
            // The name the packer really writes, which is not the one Cargo
            // produced — the reason nothing here hard-codes it.
            ("Snip Join/SnipJoin.exe", version),
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
        assert_eq!(executable_in(&payload).unwrap().file_name().unwrap(), "SnipJoin.exe");
        assert!(payload.join("bin/ffmpeg.exe").is_file());
    }

    #[test]
    fn the_swap_replaces_the_program_and_keeps_what_is_the_users() {
        let root = scratch("swap");
        let install = root.join("Snip Join");
        write(&install.join("SnipJoin.exe"), "old");
        write(&install.join("bin").join("ffmpeg.exe"), "old");
        write(&install.join(KEPT).join("settings.json"), "the user's");

        let zip = root.join("update.zip");
        archive(&zip, "new");
        let payload = extract(&zip, &root.join("staging")).unwrap();

        swap(&payload, &install).unwrap();

        assert_eq!(std::fs::read_to_string(install.join("SnipJoin.exe")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(install.join("bin/ffmpeg.exe")).unwrap(), "new");
        assert_eq!(
            std::fs::read_to_string(install.join(KEPT).join("settings.json")).unwrap(),
            "the user's",
            "the portable copy's own storage is not part of the release"
        );

        // The outgoing executable is kept until the process using it ends,
        // which is what lets the swap happen while the old one is still
        // running. It does not end in `.exe`, so it cannot be mistaken for the
        // program next time either.
        assert!(outgoing(&install).is_file());
        assert!(executable_in(&install).unwrap().file_name().unwrap() == "SnipJoin.exe");

        // And it goes on the next start, along with everything else the update
        // used. Called directly rather than through `tidy_up`, which does this
        // on a thread of its own.
        assert!(remove_file(&outgoing(&install)));
        assert!(!outgoing(&install).exists());
    }

    /// The half-way failure, which is the one that would leave somebody with a
    /// folder and no program in it.
    #[test]
    fn a_swap_that_fails_puts_the_old_program_back() {
        let root = scratch("rescue");
        let install = root.join("Snip Join");
        write(&install.join("SnipJoin.exe"), "old");
        write(&install.join(KEPT).join("settings.json"), "the user's");

        // A payload that is not there: `copy_over` fails after the executable
        // has already stepped aside, which is exactly the dangerous moment.
        let missing = root.join("never unpacked");

        assert!(swap(&missing, &install).is_err());
        assert_eq!(
            std::fs::read_to_string(install.join("SnipJoin.exe")).unwrap(),
            "old",
            "the old program is back where it was"
        );
        assert!(!outgoing(&install).exists());
        assert!(executable_in(&install).is_some());
    }

    #[test]
    fn a_folder_that_is_not_snip_join_is_refused() {
        let root = scratch("refuse");
        let payload = root.join("payload");
        write(&payload.join("SnipJoin.exe"), "new");

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
