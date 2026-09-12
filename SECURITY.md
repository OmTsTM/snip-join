# Security

Snip Join opens files it did not create, runs an external program over them, and
writes the result somewhere the user chose. This document states what it does
and does not grant itself, how those limits are enforced, and how to report a
failure of them.

## Reporting a vulnerability

Open a [security advisory](../../security/advisories/new) rather than a public
issue. Include the version, what you observed, and what you expected.

## The renderer holds no privilege of its own

The web view has **no filesystem, shell or HTTP capability**. Every media
operation crosses into Rust as a typed command, so a defect in the interface —
or anything injected into it — has no primitive to build on.
`src-tauri/capabilities/default.json` is the whole grant, and it is short by
design:

| Granted | For |
|---|---|
| `core:window:*` | Dragging, minimising, maximising and closing the custom title bar |
| `core:event:default` | Progress and state events from the backend |
| `dialog:allow-open`, `allow-save`, `allow-message` | The native file pickers |
| `opener:allow-reveal-item-in-dir` | Showing a finished export in Explorer |

| `opener:allow-open-url` | Two addresses, listed one by one: the project page and its releases |

There is no `fs:`, no `shell:`, no `http:` permission. A grant stops being
listed the moment its last caller is deleted, which is why
`core:webview:allow-internal-toggle-devtools` is no longer there.

The update check is a Rust command for this reason: the window can ask whether
there is a newer version, and it still cannot make a request of its own.

## The asset protocol starts with nothing

The web view cannot read a file merely because the user owns it. The asset
scope begins **empty**; opening a video calls `allow_file` on exactly that one
path, and the same happens for a generated preview copy. Nothing else on disk is
reachable by the renderer, including other files in the same folder.

## FFmpeg is never handed a shell

Every invocation is an argument vector, not a command string. A file named
`clip"; del *.*; ".mp4` is passed as one argument and is inert — there is no
shell to interpret it, and no code path that builds a command line by
concatenation.

The binary itself is resolved, never searched for loosely: the registered
resource directory first, then `bin/` beside the executable, then the
executable's own folder, then PATH. A user's own outdated or substituted FFmpeg
earlier in PATH cannot change what the application runs.

## The export cannot destroy its source

`paths::validate_output` refuses a destination that resolves to the input file,
comparing canonically so `C:\a\..\a\clip.mp4` is recognised as the same file.
FFmpeg opens the output for writing before it finishes reading the input, so
without this the operation truncates the very recording it was asked to edit.
`writing_over_the_source_is_refused` fails the build if the guard is removed.

## Everything over IPC is untrusted

The only sender is this application's own renderer, and it is validated anyway:
time values must be finite and ordered, clip counts are capped (`MAX_CLIPS`),
and paths are checked before they reach a process. A bug in the window should
cost a rejected command, not a malformed FFmpeg invocation.

## Portable mode writes nothing outside its folder

A `portable.txt` beside the executable redirects the scratch space **and the web
view's own storage** into `data/` next to it, so a portable copy touches neither
the user profile nor the registry. `apply_environment()` runs before the web
view is created, because the user-data folder is read once at creation and
ignored afterwards. On read-only media it falls back to the ordinary locations
rather than failing every write.

## Dependencies

`cargo audit` runs in CI and fails the build on any advisory that is not a
warning. At the time of writing there are **no known vulnerabilities** across
the 501 crates in the tree. Seven warnings are present, all transitive through
Tauri and none reachable from this program:

- Six `unmaintained` notices — `proc-macro-error` and five `unic-*` crates,
  which are build-time macro and Unicode tables, not present at run time.
- One `unsound` notice in `glib` 0.18 — part of the GTK backend Tauri uses on
  Linux, which is not compiled into a Windows build.

## The network, in full

Snip Join collects nothing, reports nothing, and contacts nothing on its own.
There is no telemetry, no crash reporting, no check at startup. Two things in
the whole project reach the internet, and this is all of them:

- **The update button, when pressed.** It requests
  `https://api.github.com/repos/OmTsTM/snip-join/releases/latest`, and — only if
  the user then presses download — one file from
  `https://github.com/OmTsTM/snip-join/releases/download/…`. That prefix is
  checked in `application/update.rs` before a byte is fetched: the addresses
  arrive in a JSON document from the network, so they are untrusted input, and
  without the check a tampered reply could point the download at any host and
  have the application offer to run what came back. The name of the file is used
  only as a file name, its last component and nothing else. The page behind
  "what changed" is a constant in this repository, not an address out of that
  document.
- **`scripts/fetch-ffmpeg.mjs`**, which downloads the FFmpeg build that gets
  packaged. A developer and CI step; the installed application never runs it.

**Every update is signed, and the signature is checked before it is offered.**
Releases are signed in CI with a minisign key whose private half exists only as a
repository secret; the public half is compiled into the application. The
downloaded file lands under a scratch name, its signature is verified against
those bytes, and only then is it given its real name — a file that fails is
deleted, not offered. TLS decides who you are talking to; this decides what you
were given, which is the part TLS cannot help with once a release page, a mirror
or a cache is in the way.

An installed copy runs the downloaded installer, which puts its own window and
its own UAC prompt on screen. A portable copy is replaced in place: the archive
is unpacked to a temporary folder, checked for the shape of a Snip Join copy,
and a copy of the *new* executable is started with `--finish-update` to do the
swap once this process has exited — the folder's `data` directory is left
untouched, and the outgoing executable is renamed rather than deleted. Nothing
is executed without the user pressing "install", and no script is written to
disk to make any of it happen.

Unpacking treats the archive as hostile: an entry naming a path outside the
folder it is being written to is refused outright, which is what stops a crafted
zip from writing into Windows.

## Scope

Snip Join edits files the user opens on their own machine, with the two network
accesses above and no others.
