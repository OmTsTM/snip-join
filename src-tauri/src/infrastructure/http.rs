//! The only place this application reaches the network.
//!
//! One module, two calls, and a hard rule that the address always comes from
//! `application::update`, which checks it against the project's own release
//! downloads before anything is fetched. Nothing else in Snip Join makes a
//! request: media is read from disk, FFmpeg is a local process, and the renderer
//! has no HTTP capability at all.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::application::error::{AppError, AppResult};

/// GitHub refuses a request without one, and an honest one is worth sending.
const USER_AGENT: &str = concat!("SnipJoin/", env!("CARGO_PKG_VERSION"));

/// Asking whether there is an update must never hang the button.
const ASK_TIMEOUT: Duration = Duration::from_secs(20);

/// A download has no overall deadline — a large file on a slow line is not an
/// error — but a stalled connection is, so the timeout is on the connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Largest reply accepted when asking about releases.
///
/// The document is a few kilobytes. This is here so that a wrong turn cannot
/// stream gigabytes into memory before anyone notices.
const MAX_JSON_BYTES: u64 = 1024 * 1024;

/// Largest file accepted on download. The installer is tens of megabytes.
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

fn client(connect: Duration, overall: Option<Duration>) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(connect)
        // GitHub answers an asset download with a redirect to its storage. A
        // handful is normal; an endless chain is not.
        .redirect(reqwest::redirect::Policy::limited(5));

    if let Some(overall) = overall {
        builder = builder.timeout(overall);
    }

    builder.build().map_err(|error| AppError::NetworkFailed(error.to_string()))
}

/// Fetches a small JSON document, or nothing if the server says there is none.
///
/// The two are told apart on purpose. "There is no release yet" is an ordinary
/// state with an ordinary answer; "GitHub could not be reached" is a failure,
/// and reporting it as "you have the newest version" would be a lie told to
/// someone who asked a question the application never managed to ask.
pub async fn get_json(url: &str) -> AppResult<Option<Value>> {
    let client = client(ASK_TIMEOUT, Some(ASK_TIMEOUT))?;

    let response = match ask(&client, url).await {
        Ok(response) => response,
        // One more try, a second later. A name that did not resolve, a
        // connection that was refused while a laptop finished waking its
        // adapter, a captive portal answering the first request of the
        // morning: none of those are worth telling somebody the update check
        // failed over, and all of them are gone by the second attempt.
        Err(_) => {
            tokio::time::sleep(Duration::from_secs(1)).await;
            ask(&client, url).await.map_err(|error| AppError::NetworkFailed(error.to_string()))?
        }
    };

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(AppError::NetworkFailed(format!("the server answered {status}")));
    }

    if response.content_length().is_some_and(|length| length > MAX_JSON_BYTES) {
        return Err(AppError::NetworkFailed("that reply is far too large".into()));
    }

    response.json().await.map(Some).map_err(|error| AppError::NetworkFailed(error.to_string()))
}

async fn ask(client: &reqwest::Client, url: &str) -> Result<reqwest::Response, reqwest::Error> {
    client.get(url).header("Accept", "application/vnd.github+json").send().await
}

/// Fetches a small text document, such as a signature.
pub async fn get_text(url: &str) -> AppResult<String> {
    let response = client(ASK_TIMEOUT, Some(ASK_TIMEOUT))?
        .get(url)
        .send()
        .await
        .map_err(|error| AppError::NetworkFailed(error.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(AppError::NetworkFailed(format!("the server answered {status}")));
    }

    if response.content_length().is_some_and(|length| length > MAX_JSON_BYTES) {
        return Err(AppError::NetworkFailed("that reply is far too large".into()));
    }

    response.text().await.map_err(|error| AppError::NetworkFailed(error.to_string()))
}

/// Downloads a file to exactly the path given, reporting progress as it goes.
///
/// The caller passes a scratch name and moves the file into place itself, once
/// it is satisfied with what arrived. Nothing here decides that a download is
/// finished business: a half a file — or a whole one nobody signed — that
/// carries the name of a real one is the thing a user double-clicks.
pub async fn download(
    url: &str,
    into: &Path,
    mut on_progress: impl FnMut(u64, u64),
) -> AppResult<PathBuf> {
    let mut response = client(CONNECT_TIMEOUT, None)?
        .get(url)
        .send()
        .await
        .map_err(|error| AppError::NetworkFailed(error.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(AppError::NetworkFailed(format!("the server answered {status}")));
    }

    let total = response.content_length().unwrap_or(0);
    if total > MAX_DOWNLOAD_BYTES {
        return Err(AppError::NetworkFailed("that file is far larger than an update".into()));
    }

    if let Some(parent) = into.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let mut file = tokio::fs::File::create(into).await?;
    let mut received: u64 = 0;

    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                // The half-written file goes with the failure: leaving it would
                // mean a later attempt has to decide whether it is a resumable
                // download or rubbish, and it is always rubbish.
                drop(file);
                let _ = tokio::fs::remove_file(into).await;
                return Err(AppError::NetworkFailed(error.to_string()));
            }
        };

        received += chunk.len() as u64;
        if received > MAX_DOWNLOAD_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(into).await;
            return Err(AppError::NetworkFailed("that file is far larger than an update".into()));
        }

        file.write_all(&chunk).await?;
        on_progress(received, total.max(received));
    }

    file.flush().await?;
    drop(file);

    Ok(into.to_path_buf())
}
