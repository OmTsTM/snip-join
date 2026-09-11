use std::path::PathBuf;
use std::sync::OnceLock;

/// A file the application was asked to open at launch.
///
/// Populated once from the command line, which is how Windows passes a file when
/// the application is chosen from "Open with" or a file is dropped onto its
/// shortcut. Reading it through a command rather than pushing an event avoids a
/// race where the renderer has not finished mounting when the event fires.
static INITIAL_FILE: OnceLock<Option<String>> = OnceLock::new();

/// Extracts a file path from the process arguments.
///
/// Only the first non-flag argument is taken. Flags are skipped rather than
/// treated as paths so a future switch cannot be mistaken for a video, and the
/// path is required to exist, so a typo surfaces as the ordinary empty state
/// instead of an error dialog before the window has even appeared.
pub fn capture_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter()
        .skip(1)
        .find(|argument| !argument.starts_with('-') && !argument.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

pub fn remember(path: Option<String>) {
    let _ = INITIAL_FILE.set(path);
}

pub fn initial_file() -> Option<String> {
    INITIAL_FILE.get().cloned().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn the_executable_path_is_never_taken_as_the_file() {
        assert_eq!(capture_from_args(args(&["snipjoin.exe"])), None);
    }

    #[test]
    fn flags_are_skipped() {
        // A non-existent path still resolves to None, which is the point: the
        // flag must not be picked up even before the existence check.
        assert_eq!(capture_from_args(args(&["snipjoin.exe", "--verbose", "nope.mp4"])), None);
    }

    #[test]
    fn an_existing_file_is_returned() {
        let path = std::env::temp_dir().join("snipjoin-startup-test.mp4");
        std::fs::write(&path, b"x").unwrap();

        let captured = capture_from_args(args(&["snipjoin.exe", &path.to_string_lossy()]));
        std::fs::remove_file(&path).ok();

        assert!(captured.is_some());
    }

    #[test]
    fn a_missing_file_is_ignored() {
        assert_eq!(capture_from_args(args(&["snipjoin.exe", "C:/nowhere/missing.mp4"])), None);
    }
}
