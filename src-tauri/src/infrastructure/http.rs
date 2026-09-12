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

/// The whole reason, not the top of it.
///
/// `reqwest::Error` prints "error sending request for url (…)" and keeps the
/// part worth reading — "dns error: no such host", "the handshake failed", "an
/// attempt was made to access a socket in a way forbidden by its access
/// permissions" — in its source chain. Those three are a name server, a TLS
/// stack and a firewall, which are three different problems with three different
/// answers, and printing only the first line makes every one of them look the
/// same. Whoever ends up reading this message is the only person who can act on
/// it, so they get all of it.
fn because(error: &dyn std::error::Error) -> String {
    let mut reason = error.to_string();
    let mut source = error.source();

    while let Some(cause) = source {
        let text = cause.to_string();
        // Layers often restate the layer above them; saying it twice helps
        // nobody.
        if !reason.contains(&text) {
            reason.push_str(": ");
            reason.push_str(&text);
        }
        source = cause.source();
    }

    reason
}

/// Whether a request may follow a redirect, or is asking where one leads.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Redirects {
    Follow,
    Report,
}

fn client(
    connect: Duration,
    overall: Option<Duration>,
    redirects: Redirects,
    ignore_proxy: bool,
) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(connect)
        .redirect(match redirects {
            // GitHub answers an asset download with a redirect to its storage.
            // A handful is normal; an endless chain is not.
            Redirects::Follow => reqwest::redirect::Policy::limited(5),
            Redirects::Report => reqwest::redirect::Policy::none(),
        });

    if ignore_proxy {
        builder = builder.no_proxy();
    }

    if let Some(overall) = overall {
        builder = builder.timeout(overall);
    }

    builder.build().map_err(|error| AppError::NetworkFailed(because(&error)))
}

/// Makes a request, and tries again without the system's proxy if it fails.
///
/// A proxy that Windows still names and nothing answers on is one of the
/// commonest ways a machine loses the internet for one application at a time: a
/// VPN or a security suite sets one up on `127.0.0.1`, is uninstalled without
/// clearing the setting, and every program that reads that setting afterwards
/// gets "tunnel error … the target machine actively refused it" while the
/// browser, which was told to ignore it, carries on working. Going direct on the
/// second attempt costs one request and rescues every one of those machines.
///
/// The attempt also doubles as the retry that a name server which did not answer
/// the first time deserves.
///
/// The first failure is the one reported: it describes the path the machine was
/// configured to take, which is the part somebody can act on.
async fn reach(
    url: &str,
    accept: Option<&str>,
    connect: Duration,
    overall: Option<Duration>,
    redirects: Redirects,
) -> AppResult<reqwest::Response> {
    let send = |ignore_proxy: bool| async move {
        let client = client(connect, overall, redirects, ignore_proxy)?;
        let mut request = client.get(url);
        if let Some(accept) = accept {
            request = request.header("Accept", accept);
        }
        request.send().await.map_err(|error| AppError::NetworkFailed(because(&error)))
    };

    let reason = match send(false).await {
        Ok(response) => return Ok(response),
        Err(reason) => reason,
    };

    tokio::time::sleep(Duration::from_secs(1)).await;
    send(true).await.map_err(|_| reason)
}

/// Fetches a small JSON document, or nothing if the server says there is none.
///
/// The two are told apart on purpose. "There is no release yet" is an ordinary
/// state with an ordinary answer; "GitHub could not be reached" is a failure,
/// and reporting it as "you have the newest version" would be a lie told to
/// someone who asked a question the application never managed to ask.
pub async fn get_json(url: &str) -> AppResult<Option<Value>> {
    let response = reach(
        url,
        Some("application/vnd.github+json"),
        ASK_TIMEOUT,
        Some(ASK_TIMEOUT),
        Redirects::Follow,
    )
    .await?;

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

    response.json().await.map(Some).map_err(|error| AppError::NetworkFailed(because(&error)))
}

/// Fetches a small text document, such as a signature.
pub async fn get_text(url: &str) -> AppResult<String> {
    let response = reach(url, None, ASK_TIMEOUT, Some(ASK_TIMEOUT), Redirects::Follow).await?;

    let status = response.status();
    if !status.is_success() {
        return Err(AppError::NetworkFailed(format!("the server answered {status}")));
    }

    if response.content_length().is_some_and(|length| length > MAX_JSON_BYTES) {
        return Err(AppError::NetworkFailed("that reply is far too large".into()));
    }

    response.text().await.map_err(|error| AppError::NetworkFailed(because(&error)))
}

/// Where a URL sends a browser, without going there.
///
/// Used to ask the releases page which release is newest when the API host
/// cannot be reached at all.
pub async fn redirect_target(url: &str) -> AppResult<Option<String>> {
    // Reported rather than followed: the answer being asked for *is* the
    // redirect.
    let response = reach(url, None, ASK_TIMEOUT, Some(ASK_TIMEOUT), Redirects::Report).await?;

    Ok(response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string))
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
    let mut response = reach(url, None, CONNECT_TIMEOUT, None, Redirects::Follow).await?;

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
