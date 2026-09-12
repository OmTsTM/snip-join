use std::path::{Path, PathBuf};

use crate::application::error::{AppError, AppResult};

/// Extension a project is written with.
///
/// Its own rather than a bare `.json`: the file is not a document anyone edits
/// by hand, and a distinct extension is what lets the picker offer projects
/// without offering every JSON file on the disk.
pub const PROJECT_EXTENSION: &str = "snipjoin";

/// Largest project accepted on read.
///
/// A project is a list of paths and a list of numbers, so a real one is a few
/// kilobytes and a very large edit is a few hundred. Anything past this is not a
/// project, and reading it into memory before finding that out is the mistake
/// worth refusing.
const MAX_PROJECT_BYTES: u64 = 8 * 1024 * 1024;

/// Validates a path a project is about to be written to.
///
/// Deliberately not `paths::validate_output`: that one refuses to overwrite any
/// file the export is reading, which is exactly right for a video and exactly
/// wrong here — saving over the project you have open is the ordinary case.
pub fn validate_project_destination(raw: &str) -> AppResult<PathBuf> {
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
    if path.is_dir() {
        return Err(AppError::InvalidInput("that is a folder, not a file".into()));
    }
    if !has_project_extension(&path) {
        return Err(AppError::InvalidInput(format!(
            "a project is saved as a .{PROJECT_EXTENSION} file"
        )));
    }

    Ok(path)
}

/// Validates a path a project is about to be read from.
pub fn validate_project_source(raw: &str) -> AppResult<PathBuf> {
    if raw.trim().is_empty() {
        return Err(AppError::InvalidInput("no file was given".into()));
    }

    let path = dunce::canonicalize(Path::new(raw))
        .map_err(|e| AppError::UnreadableFile(format!("{raw}: {e}")))?;

    let metadata = std::fs::metadata(&path)
        .map_err(|e| AppError::UnreadableFile(format!("{}: {e}", path.display())))?;

    if !metadata.is_file() {
        return Err(AppError::InvalidInput("that is a folder, not a project".into()));
    }
    if metadata.len() > MAX_PROJECT_BYTES {
        return Err(AppError::InvalidInput("that file is too large to be a project".into()));
    }
    if !has_project_extension(&path) {
        return Err(AppError::InvalidInput(format!("a project is a .{PROJECT_EXTENSION} file")));
    }

    Ok(path)
}

fn has_project_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(PROJECT_EXTENSION))
}

/// Writes a project, replacing whatever was there.
///
/// Written beside the destination and renamed over it, so a crash or a full disk
/// halfway through leaves the previous save intact rather than a truncated file
/// where someone's edit used to be. That matters more here than anywhere else in
/// the application: this is the only file that cannot be produced again.
pub fn write_project(path: &Path, contents: &str) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("that destination has no folder".into()))?;

    let temporary = parent.join(format!(
        ".{}.saving",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("project")
    ));

    std::fs::write(&temporary, contents)
        .map_err(|e| AppError::Internal(format!("the project could not be written: {e}")))?;

    if let Err(e) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(AppError::Internal(format!("the project could not be saved: {e}")));
    }

    Ok(())
}

pub fn read_project(path: &Path) -> AppResult<String> {
    std::fs::read_to_string(path)
        .map_err(|e| AppError::UnreadableFile(format!("{}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_project_files_are_accepted_as_destinations() {
        let dir = std::env::temp_dir();
        let good = dir.join("edit.snipjoin");
        let shouting = dir.join("edit.SNIPJOIN");
        let wrong = dir.join("edit.json");

        assert!(validate_project_destination(&good.to_string_lossy()).is_ok());
        assert!(
            validate_project_destination(&shouting.to_string_lossy()).is_ok(),
            "an extension typed in capitals is the same extension"
        );
        assert!(validate_project_destination(&wrong.to_string_lossy()).is_err());
    }

    #[test]
    fn a_destination_in_a_folder_that_does_not_exist_is_refused() {
        let missing = std::env::temp_dir().join("no-such-folder-here").join("edit.snipjoin");
        assert!(validate_project_destination(&missing.to_string_lossy()).is_err());
    }

    #[test]
    fn an_empty_destination_is_refused() {
        assert!(validate_project_destination("   ").is_err());
        assert!(validate_project_source("").is_err());
    }

    /// The previous save is the thing being replaced, so a failure halfway
    /// through must not be able to destroy it.
    #[test]
    fn a_save_replaces_the_file_only_once_it_is_whole() {
        let path = std::env::temp_dir().join("snipjoin-save-test.snipjoin");
        let _ = std::fs::remove_file(&path);

        write_project(&path, "{\"first\":true}").unwrap();
        assert_eq!(read_project(&path).unwrap(), "{\"first\":true}");

        write_project(&path, "{\"second\":true}").unwrap();
        assert_eq!(read_project(&path).unwrap(), "{\"second\":true}");

        // The scratch file it wrote through is not left behind.
        let leftover = path.with_file_name(".snipjoin-save-test.snipjoin.saving");
        assert!(!leftover.exists());

        let _ = std::fs::remove_file(&path);
    }
}
