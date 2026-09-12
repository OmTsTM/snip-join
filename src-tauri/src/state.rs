use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::watch;

use crate::domain::media::MediaSource;

/// Process-wide editor state.
///
/// Only two things genuinely need to be shared: what has been probed, and the
/// set of cancellable jobs. Everything else about the edit lives in the
/// renderer and arrives with each request, which keeps the two sides from
/// drifting out of agreement about what the timeline looks like.
///
/// Media are keyed by path because a path already identifies a file uniquely
/// and is what the asset protocol is granted against. Inventing an id would add
/// a table to keep in step on both sides and buy nothing.
#[derive(Default)]
pub struct EditorState {
    media: Mutex<HashMap<String, MediaSource>>,
    /// The first file opened. It decides the output format, and it is the one a
    /// destination is suggested beside.
    primary: Mutex<Option<String>>,
    jobs: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl EditorState {
    /// Remembers a probed file. The first one to arrive becomes the primary.
    pub fn register(&self, source: MediaSource) {
        if let Ok(mut primary) = self.primary.lock() {
            primary.get_or_insert_with(|| source.path.clone());
        }
        if let Ok(mut media) = self.media.lock() {
            media.insert(source.path.clone(), source);
        }
    }

    pub fn media(&self, path: &str) -> Option<MediaSource> {
        self.media.lock().ok().and_then(|guard| guard.get(path).cloned())
    }

    pub fn primary(&self) -> Option<MediaSource> {
        let path = self.primary.lock().ok().and_then(|guard| guard.clone())?;
        self.media(&path)
    }

    /// Drops one file from the pool. The primary is only given up when the file
    /// being dropped is it, so removing a later addition cannot change which
    /// format the project exports in.
    pub fn forget(&self, path: &str) {
        if let Ok(mut media) = self.media.lock() {
            media.remove(path);
        }
        if let Ok(mut primary) = self.primary.lock() {
            if primary.as_deref() == Some(path) {
                *primary = None;
            }
        }
    }

    pub fn forget_all(&self) {
        if let Ok(mut media) = self.media.lock() {
            media.clear();
        }
        if let Ok(mut primary) = self.primary.lock() {
            *primary = None;
        }
    }

    /// Registers a job and hands back the receiver its worker should watch.
    ///
    /// Registering under an id the caller chose lets the renderer cancel a job it
    /// started without waiting for the call that started it to return.
    pub fn register_job(&self, id: &str) -> watch::Receiver<bool> {
        let (sender, receiver) = watch::channel(false);
        if let Ok(mut jobs) = self.jobs.lock() {
            // Replacing an entry cancels nothing by itself; the previous worker
            // holds its own receiver and finishes or is cancelled on its own.
            jobs.insert(id.to_string(), sender);
        }
        receiver
    }

    /// Signals a job to stop. Unknown ids are ignored: a job that already
    /// finished is indistinguishable from one that never existed, and both mean
    /// there is nothing left to cancel.
    pub fn cancel_job(&self, id: &str) {
        if let Ok(jobs) = self.jobs.lock() {
            if let Some(sender) = jobs.get(id) {
                let _ = sender.send(true);
            }
        }
    }

    /// Removes a finished job so its channel is not retained for the lifetime of
    /// the process.
    pub fn finish_job(&self, id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(id);
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(jobs) = self.jobs.lock() {
            for sender in jobs.values() {
                let _ = sender.send(true);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registered_job_can_be_cancelled() {
        let state = EditorState::default();
        let receiver = state.register_job("job-1");
        assert!(!*receiver.borrow());

        state.cancel_job("job-1");
        assert!(*receiver.borrow());
    }

    #[test]
    fn cancelling_an_unknown_job_is_harmless() {
        let state = EditorState::default();
        state.cancel_job("never-existed");
    }

    #[test]
    fn finished_jobs_are_not_retained() {
        let state = EditorState::default();
        let receiver = state.register_job("job-1");
        state.finish_job("job-1");
        state.cancel_job("job-1");

        assert!(!*receiver.borrow(), "a removed job must no longer be reachable for cancellation");
        assert!(state.jobs.lock().unwrap().is_empty());
    }

    #[test]
    fn cancel_all_stops_every_running_job() {
        let state = EditorState::default();
        let a = state.register_job("a");
        let b = state.register_job("b");

        state.cancel_all();

        assert!(*a.borrow());
        assert!(*b.borrow());
    }
}
