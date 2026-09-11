use std::path::{Path, PathBuf};

use crate::application::error::{AppError, AppResult};

/// Largest input file the editor will open, in bytes.
///
/// Not a technical limit but a guard against a mis-picked file: a 200 GB disk
/// image probes slowly and would look like a hang.
const MAX_INPUT_BYTES: u64 = 256 * 1024 * 1024 * 1024;

/// Validates and normalises a path the user chose to open.
///
/// Canonicalisation resolves `..` and symbolic links, so the path that is probed
/// is the path that is read. `dunce` is used instead of the standard library so
/// Windows gets a plain `C:\...` path rather than the `\\?\` extended form,
/// which several FFmpeg demuxers mishandle.
pub fn validate_input(raw: &str) -> AppResult<PathBuf> {
    if raw.trim().is_empty() {
        return Err(AppError::InvalidInput("no file was given".into()));
    }

    let path = dunce::canonicalize(Path::new(raw))
        .map_err(|e| AppError::UnreadableFile(format!("{raw}: {e}")))?;

    let metadata = std::fs::metadata(&path)
        .map_err(|e| AppError::UnreadableFile(format!("{}: {e}", path.display())))?;

    if !metadata.is_file() {
        return Err(AppError::InvalidInput("that is a folder, not a video file".into()));
    }
    if metadata.len() == 0 {
        return Err(AppError::InvalidInput("that file is empty".into()));
    }
    if metadata.len() > MAX_INPUT_BYTES {
        return Err(AppError::InvalidInput("that file is too large to open".into()));
    }

    Ok(path)
}

/// Validates a destination chosen for an export.
///
/// Refusing to write over the source is the important part. FFmpeg would open
/// the input for reading and truncate the same file for writing, destroying the
/// original a few frames into the export with no way back.
pub fn validate_output(raw: &str, source: &Path) -> AppResult<PathBuf> {
    if raw.trim().is_empty() {
        return Err(AppError::InvalidInput("no destination was given".into()));
    }

    let path = PathBuf::from(raw);
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::InvalidInput("that destination has no folder".into()))?;

    if !parent.is_dir() {
        return Err(AppError::InvalidInput("that folder does not exist".into()));
    }
    if path.extension().is_none() {
        return Err(AppError::InvalidInput("the destination needs a file extension".into()));
    }

    // Compare canonically so `C:\a\..\a\clip.mp4` is recognised as the source.
    let canonical_parent = dunce::canonicalize(parent)
        .map_err(|e| AppError::InvalidInput(format!("that folder cannot be written to: {e}")))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("that destination has no file name".into()))?;
    let resolved = canonical_parent.join(file_name);

    if paths_equal(&resolved, source) {
        return Err(AppError::InvalidInput(
            "choose a different file: exporting over the original would destroy it".into(),
        ));
    }

    Ok(resolved)
}

/// Case-insensitive comparison on Windows, exact elsewhere.
fn paths_equal(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a.as_os_str().to_string_lossy().eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// Root for scratch space, created lazily by whoever writes into it.
///
/// A portable copy keeps its scratch beside the executable so that unplugging
/// the drive takes every trace with it; an installed copy uses the system
/// temporary directory, which the operating system already knows how to clean.
pub fn scratch_root() -> PathBuf {
    match super::portable::root() {
        Some(data) => data.join("cache"),
        None => std::env::temp_dir().join("snipjoin"),
    }
}

/// Removes scratch directories left behind by a previous run.
///
/// A crash or a forced quit skips the drop that normally cleans up, so stale
/// segments would otherwise accumulate in the temporary folder forever.
pub fn sweep_stale_scratch() {
    let root = scratch_root();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|modified| {
                modified.elapsed().map(|age| age.as_secs() > 60 * 60 * 6).unwrap_or(false)
            })
            .unwrap_or(false);

        if stale {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_input_path_is_refused() {
        assert!(validate_input("   ").is_err());
    }

    #[test]
    fn a_missing_file_is_refused() {
        assert!(validate_input("C:/definitely/not/here.mp4").is_err());
    }

    #[test]
    fn a_directory_is_refused_as_input() {
        let dir = std::env::temp_dir();
        let result = validate_input(&dir.to_string_lossy());
        assert!(matches!(result, Err(AppError::InvalidInput(_))));
    }

    #[test]
    fn an_output_without_an_extension_is_refused() {
        let dir = std::env::temp_dir();
        let destination = dir.join("result");
        let result = validate_output(&destination.to_string_lossy(), Path::new("C:/in.mp4"));
        assert!(matches!(result, Err(AppError::InvalidInput(_))));
    }

    #[test]
    fn writing_over_the_source_is_refused() {
        let dir = dunce::canonicalize(std::env::temp_dir()).unwrap();
        let source = dir.join("snipjoin-guard-test.mp4");
        std::fs::write(&source, b"x").unwrap();

        let result = validate_output(&source.to_string_lossy(), &source);
        std::fs::remove_file(&source).ok();

        assert!(
            matches!(result, Err(AppError::InvalidInput(message)) if message.contains("destroy")),
            "exporting over the input would truncate the file being read"
        );
    }

    #[test]
    fn a_different_name_in_the_same_folder_is_allowed() {
        let dir = dunce::canonicalize(std::env::temp_dir()).unwrap();
        let source = dir.join("snipjoin-source-test.mp4");
        let destination = dir.join("snipjoin-result-test.mp4");

        let result = validate_output(&destination.to_string_lossy(), &source);
        assert!(result.is_ok(), "{result:?}");
    }

    #[test]
    fn a_destination_in_a_missing_folder_is_refused() {
        let result = validate_output("C:/no/such/folder/out.mp4", Path::new("C:/in.mp4"));
        assert!(matches!(result, Err(AppError::InvalidInput(_))));
    }
}
