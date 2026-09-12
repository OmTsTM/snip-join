# Snip Join — working notes

Desktop video editor with one job: take a stretch out of a video, then either
join what is left or leave a hole where the cut was. Blocks on the timeline can
be reordered and moved.

## Non-negotiable conventions

**Every comment, doc comment, identifier, commit message and test name is
written in English, in technical prose.** No Portuguese anywhere in the source,
including `//`, `///`, `/** */`, `#`, and JSDoc. User-facing strings are the only
exception: those live in `src/infrastructure/i18n/` and are translated into
English, Brazilian Portuguese, Spanish and Simplified Chinese.

Comments explain *why*, not *what*. A comment restating the line below it is
noise; a comment recording a constraint, a trade-off, or a defect that was
avoided is the reason the line looks the way it does.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | Tauri 2 | ~10 MB binary, system WebView2, capability-based security |
| Backend | Rust 2021, Tokio | Memory safety and RAII cleanup for child processes |
| Renderer | React 19 + TypeScript | Strict mode, no `any`, `exactOptionalPropertyTypes` |
| Styling | Tailwind CSS 4 | CSS-first `@theme`, tokens sampled from the logo |
| State | Zustand | One store, narrow selectors so 60 Hz playhead updates stay cheap |
| Motion | Motion (Framer) | Springs on layout, honours `prefers-reduced-motion` |
| Media | FFmpeg / FFprobe | Located at run time, never invoked through a shell |

## Architecture

Dependencies point inward only. The same four layers exist on both sides.

```
src-tauri/src/                          src/
  domain/        editing rules,           domain/        timeline, blocks,
                 no FFmpeg, no Tauri                     time, export vocabulary
  application/   use cases and the        application/   undo stack
                 pure export planner
  infrastructure/ FFmpeg adapters,        infrastructure/ IPC client, i18n
                 paths, process runner
  interface/     Tauri commands, DTOs     presentation/  React, hooks, store
```

Rules that hold:

- `domain/` imports nothing from the other layers and is fully unit tested
  without a process, a window, or a file on disk.
- Every routing decision for an export is made in `application/export_plan.rs`,
  which is pure: it returns an ordered list of commands. The executor only walks
  the list. That is why "does a hole force a re-encode?" is a unit test rather
  than something you observe by running an export.
- `interface/` commands are thin. If a command contains a decision, it belongs in
  a use case.

## The two concepts everything hangs on

**Block.** A surviving piece of the source. `source` says which stretch of the
original file it shows; `start` says where it sits on the edited timeline. They
are independent, which is what lets a block be dragged without touching media.

**Mode.** `join` closes holes; `gap` keeps them. Which field is authoritative
depends on the mode, and getting it backwards silently undoes reorders:

- `join`: array order wins, `start` is derived by reflowing. Never sort by
  `start` here.
- `gap`: `start` wins, the array is sorted by it.

Both funnel through `settle()` in `src/domain/timeline.ts`. Add operations there.

**Two selections, and they are not the same.** `selection` is a stretch of
*time* marked by the orange rails — what a removal takes out. `selectedBlock` is
a *piece*, the one the block menu, the clipboard and `Delete` act on, drawn with
a pale ring because it removes nothing. `Delete` prefers the rails and falls back
to the block, which is the only way the keyboard can reach a block at all.

A click on the track drops the rails **only when it lands outside them**.
Clearing them unconditionally made "mark the start, move the playhead, mark the
end" impossible: moving the playhead is what you do between the two, and it threw
away the mark you had just set.

**A still is a third kind of thing.** `MediaKind::Still` — an image, or any
single-frame file. It has no length of its own, so the editor gives it one
(`STILL_DEFAULT_SECONDS`) and it stretches to `STILL_MAX_SECONDS`, which is also
the length its preview copy is built at so scrubbing cannot run past the picture.

**An empty timeline is legal.** Deleting the last block is how you start over
without closing the file; the media pool still holds everything. What it is not
is exportable, which `selectCanExport` gates.

## Skins

Three: `dusk` (the default, and the one the editor was designed around), `slate`
and `paper`. A skin is a block of custom properties on `:root[data-theme=…]`;
the default writes no attribute at all, so a fresh install renders the palette
in `@theme` with nothing overridden.

The palette names are **roles**, not colours. `ink` is always the ground and
`paper` is always what is written on it — which in the light skin means `ink` is
nearly white and `paper` is nearly black. Anything that reads them as the colours
they are named after breaks the moment a second skin exists.

Two things do not move with the skin:

- **The scissors orange.** `--color-snip` is the logo's `#F9811E` in every skin,
  because orange means cutting and a skin does not get to decide what cutting
  looks like. Only `--color-snip-ink` moves, and only so that orange used as
  *text* survives a pale ground — `text-snip` is for a fill, `text-snip-ink` for
  something to be read.
- **The splash.** It is a two and a half second brand moment with its own inline
  stylesheet, and it stays the window at dusk.

Two roles exist because a dark skin and a pale one need opposite answers:

- **`control`** is the surface a floating control stands on — the transport's
  play button. `raised` cannot do this job: it is lighter than the ground in a
  dark skin and darker than it in a pale one, so painting a button with it turns
  the button into a dent the moment the lights come up.
- **`alarm`** is losing work, which is not the same as cutting. Orange is
  deliberate and undoable; this is the answer that throws something away, and it
  is the red the window's close button already answers to. `alarm-ink` is the
  readable version, since the same red is not legible on both grounds.

`--shadow-stage` is the video frame's drop shadow, and it is a token for the
same reason: it is the only shadow on screen big enough to be read as depth, and
the black one the dark skin wants puts the transport in a pit on a pale ground —
the picture floats and everything under it looks a storey lower.

The title bar's controls are `text-muted`, never `text-faint`: they are the only
controls on screen with no panel behind them, sitting on the darkest band the
interface has, and `faint` left them at about three to one against it. They all
share one class from `features/chrome/controls.ts`, because the strip is read as
a row before it is read as five separate things: mixed paddings and two icon
sizes are what made it look shuffled.

## Colour rule

The palette is sampled from `logo.png`, not invented: `#F9811E` is the scissors,
`#F4E6D6` is the "Join" lettering, `#1B406B` is the window at dusk, `#090A0B` is
the matte.

**Orange means cutting and nothing else.** Selection rails, the Remove button,
torn edges, the "removed" counter. Everything that joins, keeps or results is
paper or dusk: the join switch, holes on the timeline, the Export button. An
orange Export button would make "delete this" and "produce the file" read as the
same kind of action.

## Cutting without re-encoding

The `Copy` export mode is a pure stream copy: no decoding, no encoding, no
processor or graphics work. It is the default and the reason the app is usable on
a weak machine.

A copy can only begin on a keyframe, so the honest version of that feature needs
three things, all of which exist:

- `infrastructure/ffmpeg/keyframes.rs` lists them by reading **packets**, not
  frames. Packets are demuxed without decoding, so a two-hour file answers in
  seconds; `-show_frames` would decode every keyframe and take minutes.
- The timeline draws them and snaps selection edges, block trims and rail drags
  onto them within 8 pixels. Snapping *both* edges matters: a segment that starts
  on a keyframe decodes cleanly, and one that ends just before the next keyframe
  leaves no partial group of pictures to smear at the seam.
- `src/domain/lossless.ts` reports whether the current edit is exact, and the
  export dialog says so. The first block's start and the last block's end are
  exempt: they are the untouched ends of the video and need no keyframe.

Cut points are positions **inside a file**, so the store keeps them per medium
and `snapToCutPoint` carries an instant into the block's own source coordinates
before snapping and back afterwards. Snapping in timeline coordinates against one
shared list is the defect that made every added file unselectable: past the first
file's length, every cut was dragged back into it.

All-intra footage (ProRes, DNxHD, MJPEG) makes every frame a cut point. The list
is capped at 20 000 and the `truncated` flag says "cut anywhere" instead of
plotting a grey wash.

## The dock divider

`features/timeline/dockSize.ts` owns every vertical size in the dock, and both
the layout and the limits are derived from it. The rules:

- The floor is the height the editor was laid out with (158px). It never goes
  lower; the block handles were sized for that track height.
- The ceiling is the taller of two limits, whichever binds first: a useful
  filmstrip (320px of block, so 408px of dock) or whatever is left once the stage
  keeps `MIN_STAGE_HEIGHT`. On a short window the second one wins.
- `CHROME` must include **every** band that is not the block track — toolbar,
  ruler, gap, bottom margin. Leaving the ruler out made the track overflow the
  canvas by exactly its height at every size *and* put the floor 22px below the
  designed layout. `dockSize.test.ts` walks all allowed heights and asserts the
  margin underneath, so that cannot come back.
- The horizontal scrollbar is drawn **inside** that bottom margin, not below it:
  the scrolling element's own box is the canvas. `SCROLLBAR_HEIGHT` therefore has
  to stay under `TRACK_BOTTOM`, which the same test asserts, and `.timeline-scroll`
  in `app.css` has to agree with it.

The height is remembered in `localStorage` and re-clamped on every window resize,
since shrinking the window can leave a stored height the stage can no longer
spare.

Growing the dock shrinks the stage row, which the inspector column shares. That
column scrolls and pins its export button rather than clipping: a short stage may
cost scroll distance, never a control.

## Bundled FFmpeg

`scripts/fetch-ffmpeg.mjs` downloads the build that ships in the installer. It
resolves the newest *release line* from BtbN's rolling `latest` tag (n9.0, n8.1,
…) rather than the `master` nightly, so each Snip Join release carries a current
but stable FFmpeg without anyone editing a pinned URL.

The shared GPL build is used on purpose: shared so `ffmpeg.exe` and `ffprobe.exe`
do not each embed a private ~90 MB copy of the same libraries, GPL for x264/x265/
SVT-AV1, and it carries `libplacebo` and `cas` for the GPU upscaling tiers.

`pnpm app:build` runs the fetch first. `src-tauri/bin/` is build output and is
not committed. The binaries land at `<install>/bin/`, which `locator.rs` searches
before PATH, so a user's own outdated FFmpeg cannot change what the app does.

## Portable mode

A `portable.txt` file beside the executable switches it on; the portable archive
ships one, the installer does not. `infrastructure/portable.rs` then redirects
the scratch space and the web view's own storage into `data/` next to the
executable, so nothing reaches the user's profile or the registry.
`apply_environment()` must run before the web view is created: the user-data
folder is read once, at creation, and ignored afterwards. A copy on read-only
media falls back to the ordinary locations rather than failing every write.

## Things that will bite you

- **A complex filter graph does not auto-rotate.** FFmpeg applies the display
  matrix for `-vf` but not for `-filter_complex`, so rotation is baked in by hand
  in `filtergraph.rs` and the stale metadata is reset with `-metadata:s:v:0
  rotate=0`. Skip either half and phone clips export sideways.
- **`concat` corrupts silently on mismatched inputs.** Every segment is forced to
  the same size, pixel format, sample aspect and frame rate before joining.
- **A stream copy cannot draw a hole.** `ExportSpec::reconciled()` promotes the
  mode when the timeline has one. The dialog shows this rather than letting the
  backend do it quietly.
- **A listed encoder is not a working encoder.** Every FFmpeg build bundled
  here carries `h264_nvenc`, so `-encoders` reports it on a machine with no
  NVIDIA card and the export dies at the first frame with `Cannot load
  nvcuda.dll`. `capabilities.rs` opens each hardware encoder on one throwaway
  frame at startup, concurrently, and `resolve_encoder` picks only from what
  actually opened. This also covered the scrubbing proxy, which asks for `Auto`
  too.
- **`libplacebo` needs a live Vulkan device**, not just the compiled-in filter.
  `capabilities.rs` renders one throwaway frame through it at startup and hides
  the GPU upscalers if that fails. Its `antiringing` option applies only to
  non-EWA kernels and is refused by some builds — do not pass it.
- **NNEDI is not available.** The filter requires an external `nnedi3_weights.bin`
  that ships with nothing. The third upscaling tier is libplacebo plus `cas`.
- **`CREATE_NO_WINDOW` is mandatory on Windows.** One process per filmstrip frame
  means a visible console strobe without it.
- **A zustand selector must return a reference-stable value.** State is read
  through `useSyncExternalStore`, which compares snapshots by identity, so a
  selector that derives a fresh object or array on every call never compares
  equal: React re-renders forever and the window goes **blank with no visible
  error**. Derived collections belong in a `useMemo` inside the component, over
  inputs that only change when the edit does.
  `src/presentation/state/selectors.test.ts` guards this.
- **The editor window is created hidden.** It is shown by `finish_startup`,
  which the renderer calls after its first paint; until then the splash window
  is all there is. Break that call and the application starts with no window at
  all — `interface/splash.rs` carries a twelve second deadline that shows it
  anyway, which is a backstop and not a design. The splash's progress bar and
  the `MINIMUM` in that module describe the same 2600ms and have to move
  together.
- **The bundle identifier is the installer's upgrade identity.** Windows keys
  the uninstall entry and the web view's data folder off
  `tauri.conf.json identifier`, so changing it after a release makes the next
  installer sit beside the old copy instead of replacing it, and resets
  whatever `localStorage` held — the chosen language and the dock height. It
  moved from `com.snipjoin.app` to `br.matteus.snipjoin` before the first
  release, which was the last free moment; it does not move again.
- **Never write the export over the source.** `paths::validate_output` refuses
  it; FFmpeg would truncate the file it is reading.
- **A still needs `-loop 1` *and* `-t`.** One packet, so the graph's `trim` runs
  out after a single frame and a five second title card exports as a blink.
  `-t` is what ends the loop: an infinite input keeps the graph running after
  every other segment has finished. The bound is the furthest into the still any
  clip reaches plus a frame, because `trim` reads the timestamp before its end.
  A still also cannot be stream copied, which `export_plan` folds into the same
  reconciliation as a hole.
- **A container lies about a still's length.** A PNG reports a fortieth of a
  second, which is why one used to land on the timeline two pixels wide. `probe`
  replaces it rather than layering on top of it, and detects a still two ways:
  the container name (`png_pipe` and friends) or a one-frame video track. Sound
  rules it out outright — an animated GIF has to stay moving pictures.
- **A portal is still a React child of whatever rendered it.** The block menu
  is portalled into `document.body` so the scrolling canvas cannot clip it, but
  its events still bubble through the React tree back into the timeline — which
  answers a press by capturing the pointer for a selection drag. The capture
  retargets the `pointerup`, no `click` is ever delivered, and every entry in
  the menu silently does nothing. `ContextMenu` stops propagation on its own
  pointer events; the capture-phase listener that dismisses it checks
  containment instead.
- **The canvas keeps empty room past the last block.** `TIMELINE_TRAIL`. Without
  it the canvas stops exactly where the footage does, so a block at the far
  right cannot be made any longer: the pointer runs out of window and there is
  nothing further along to scroll to either. `fitScale` subtracts it, so fitting
  still leaves no scrollbar.
- **Every gesture that can reach the edge of the view has to say so.**
  `dragScroll.ts` is what the dock watches to start following the pointer, and
  each gesture reads the canvas rect on every move rather than caching it — the
  view moving under a stationary pointer fires no `pointermove`, so each one
  also replays itself on `scroll`. Miss either half and the gesture freezes, or
  runs backwards, the moment the view starts to travel. The following itself is
  off unless `edgeScroll` is on: a view that travels while you are holding
  something is worse than one that makes you zoom out, so it is offered in the
  toolbar rather than imposed.
- **A ref handed to a `motion` row does not reliably reach its node.** The block
  list finds the chosen row with a `data-` attribute and scrolls the inspector
  column by hand — `scrollIntoView` walked out to a list that does not overflow
  and stopped there, which moved nothing, because the list is normally below the
  fold in its entirety.
- **Snapping to cut points is bounded by a distance.** `SNAP_PIXELS` in the
  store. Some files carry almost none — an animated GIF has exactly one, at the
  start — and pulling onto "the nearest one, wherever it is" dragged every edit
  onto that instant: a trimmed edge collapsed the moment it was touched, and a
  selection could only ever cover the whole block. Measured in pixels so it
  behaves the same at every zoom. Footage whose list came back `truncated` is
  never snapped at all: it can be cut anywhere, and the list is only its first
  twenty thousand points.
- **The grab handle is the only way to pick a block up with a pointer.** The
  body is deliberately inert — a drag across it marks a selection like anywhere
  else on the track — so `HANDLE_HEIGHT` is the entire target, and at twenty
  pixels it was asking for precision about something nobody should have to think
  about. It is 28, which the dock's floor still affords a filmstrip under.
- **A block's drawn width must not have a usable floor.** A floor wide enough to
  grab is a floor that lies about where the block ends, and several short blocks
  side by side each get drawn over the next — indistinguishable from an overlap.
  `MIN_BLOCK_WIDTH` is a hairline for that reason. It was once 26px because a
  still reported a fortieth of a second; a still has a real length now.
- **A dragged block follows the pointer, and the lift has to earn it.** A block
  lands in a *slot*, and slots are as wide as the blocks that hold them, so a
  card pinned to its slot cannot also be under the hand moving it — pinning it
  made a drag across two blocks feel like it had stopped, the card sitting half
  a neighbour ahead and waiting for the next threshold. So it floats; what makes
  that read as *held* rather than as an overlap is the lift being unmistakable
  (`translateY(-11px) scale(0.93)`, a heavy shadow) and the slot it will drop
  into being outlined underneath. A timid lift is worse than none: it looks
  exactly like the bug.
- **The whole drag has to be heard on the window, not just the release.**
  Pointer capture is meant to deliver every move to the element that was
  pressed, and it does not survive this card: the block is re-ordered in a keyed
  list as it travels, so its node is moved in the document and Chromium drops
  the capture. What is left works only while the pointer happens to stay over
  the handle — which is exactly what a purely sideways drag does, the card
  following underneath it — so the defect looked like "moving the pointer down
  jams the drag" and hid for a round. `BlockCard` listens for `pointermove`,
  `pointerup` and `pointercancel` on `window` for as long as a drag is running,
  and reads its placement function through a ref so the subscription is not torn
  down and rebuilt sixty times a second.
- **A trim must not be animated.** The width is the block's length and the
  pointer is setting it, so a transition means the drawn edge lags the drag by
  its own duration: on a fast shrink the card is still wide while the filmstrip
  inside it has been laid out for the narrow result, which is the black band
  that looked like a picture failing to load.
- **Nothing else enforces "never overlapping" in `gap` mode.** `settle` only
  sorts there — the reflow that makes overlap impossible with the ends joined
  does not run. Every operation therefore has to keep the invariant itself:
  `moveBlock` places into a free interval, `insertClip` goes through it, and
  `trimBlock` stops each edge at the neighbour (`trimBounds`). Trimming was the
  one that did not, and it drew one block sitting on top of another.
- **Reordering across a long block needs the view to follow.** The drop lands
  after every block whose midpoint the dragged one has passed, and a five minute
  block's midpoint is off screen at any zoom that still shows frames — so without
  edge scrolling the only way to swap a short block past a long one is to zoom
  out first. `TimelineDock` scrolls; `BlockCard` replays its placement on the
  resulting `scroll` event, because the canvas moving under a stationary pointer
  fires no `pointermove` of its own.

- **The preview frame is measured, never calculated from the layout.** It was
  once capped by `calc((100vh - 300px) * ratio)`, with the height of everything
  else on screen written in as a number: true the day it was written and wrong
  from the first time a band moved, after which the frame kept a width its
  height no longer allowed, stopped matching the picture's shape, and drew the
  video letterboxed inside its own border. A `ResizeObserver` on the area and
  the largest box of that shape that fits it. The shape follows the medium under
  the playhead, not the project's first file.

## Projects

A `.snipjoin` file is paths and cuts, nothing else. Everything that can be read
again from the media is read again on open, so a project is a few kilobytes and
cannot go stale against the files it names. Block ids are left out: they are
per-session counters with no meaning outside the run that minted them.

- The renderer has no filesystem capability, so `save_project` / `load_project`
  are commands. The write goes through a scratch file and a rename — this is the
  one file the application produces that cannot be produced again.
- **A missing medium keeps its blocks.** Dropping them would rewrite someone's
  edit to match an accident on disk and leave nothing to repair. The pool lists
  the file as missing, the export refuses, and the user chooses: say where it
  went, or remove it and its blocks on purpose.
- **`onCloseRequested` needs `core:window:allow-destroy`.** The JS helper works
  by preventing the close and calling `destroy()` itself when the handler does
  not object — so without that permission, attaching a close handler stops the
  window closing *at all*, silently, including from the title bar.
- Autosave only writes a project that already has a path. Choosing a name and a
  place on the user's behalf while they are editing is not a rescue.
- **Opening a project prepares every medium, not only the first.** A project is
  the one place several files arrive at once, and the preview is what the player
  reads: with only the first prepared, a project whose blocks all came from the
  second file reopened with the edit intact and a blank player. The first is
  awaited because `ready` means "there is something to watch"; the rest follow
  behind it. `state/project.test.ts` drives the round trip.
- **Closing the editor is not quitting.** One window does two jobs — the welcome
  screen with its recent projects, and the edit — and the close button means "I
  am done with this one", which is usually the moment before opening another.
  With nothing open the close request is left alone and the application really
  does quit. `Ctrl`+`W` asks the window to close rather than deciding for
  itself, so it lands in the same place.
- **In development, an HMR update to the store can leave a stale close handler.**
  The old module's listener holds the old store, which reads as "nothing open",
  so it does not object and the window is destroyed — the application appears to
  quit instead of returning to the welcome screen. It cannot happen in a build,
  where nothing is ever re-evaluated; restart `pnpm app:dev` before believing
  it.

## Updating

One button, and nothing that happens on its own. `application/update.rs` asks
`/releases/latest`, compares the tag with the running version through
`domain/version.rs`, and picks the file that replaces *this* kind of copy: the
`.exe` for an installed one, the `_portable.zip` for a portable one. Offering the
wrong one would leave two Snip Joins on the machine, one of them in the registry.

- **The renderer still has no HTTP capability.** `infrastructure/http.rs` is the
  only place in the application that touches the network, and it is reached from
  two commands.
- **A download address out of a JSON document is untrusted input.** Every URL is
  checked against the project's own release downloads before a byte is fetched;
  without that, a tampered reply could have the application download anything
  from anywhere and then offer to run it. GitHub redirects to its asset storage
  and the client follows, so the guard is on where the chain begins — the part
  the reply cannot move.
- **Every release is signed and every update is verified.** Minisign, the same
  scheme Tauri's own updater uses: the bundler signs the installer, the release
  job signs the portable archive with the same key, and `verify_signature` checks
  the bytes against the public key compiled into `application/update.rs` before
  the download is given its real name. The private half is the
  `TAURI_SIGNING_PRIVATE_KEY` repository secret and exists nowhere else — **lose
  it and no copy already in the wild will accept another update**, because they
  all carry that public key. A release with no `.sig` beside an asset is not an
  update at all: `compare` refuses it, and the release job fails rather than
  publish one.
- **A portable copy replaces itself; the new version does the work.** Windows
  will not overwrite a running executable, so the archive is unpacked to a
  temporary folder, a copy of the *new* executable is started with
  `--finish-update <payload> <install>`, and this process exits. The finisher
  renames the old executable to `.old` — allowed while it runs, which is the
  whole trick — copies the new files over (never `data/`, which belongs to the
  user), and starts what it installed. `lib.rs` reads that argument before
  anything else, including the web view: that start is not an editor. No script
  is ever written.
- **The swap can finish before the old copy has.** Renaming does not need the
  old process gone, so the finisher could relaunch while it is still exiting —
  and the two would fight over the web view's storage under `data/`, which shows
  up as a second window that never appears. Deleting the `.old` file is the wait:
  Windows refuses to delete a running executable and allows it the moment the
  process ends, so the one call both asks the question and tidies up.
- **Unpacking treats the archive as hostile.** `enclosed_name` refuses `..` and
  absolute paths; without it a crafted zip writes wherever it likes. There is a
  test for exactly that.
- **`app.exit` fires no close event.** Applying an update ends the process
  without going through `onCloseRequested`, so it asked nothing about unsaved
  work until `askAboutUnsavedWork` was lifted out of the close handler and given
  to both callers. Anything else that ends the process has to ask too.
- A repository with no releases answers 404, which is reported as "nothing to
  do". So is a release carrying nothing this copy could install — the button
  must never offer an update it would then refuse to fetch.

## Security posture

- The renderer has **no** filesystem, shell or HTTP capability. See
  `src-tauri/capabilities/default.json`. The update check is a command, for
  exactly that reason.
- The splash window has a capability file of its own, granting it exactly one
  command: opening the credit line's address, scoped to that single URL. It is
  separate rather than a second entry in the editor's `windows` list, because
  sharing that list would hand the splash dialogs, window chrome and the asset
  protocol as well.
- The asset protocol scope starts empty. Opening a file grants access to exactly
  that one path, so nothing else on disk is reachable by the web view.
- FFmpeg is spawned with an argument vector, never a shell string. A file name
  containing quotes, semicolons or ampersands is inert.
- Everything arriving over IPC is validated as untrusted input, including clip
  counts and time values, even though the only sender is this app's renderer.

## Commands

```bash
pnpm install
pnpm app:dev            # Vite + Tauri, hot reload on both sides
pnpm app:dev -- -- path/to/video.mp4   # open a file at launch

pnpm typecheck          # tsc, strict
pnpm test               # renderer unit tests
pnpm i18n:check         # placeholder parity across locales, and dead keys
cd src-tauri && cargo test              # 132 unit + 13 end-to-end
cd src-tauri && cargo clippy --all-targets
cd src-tauri && cargo fmt --all         # rustfmt.toml sits at the repo root
pnpm ffmpeg:fetch       # download the FFmpeg that gets bundled
pnpm ffmpeg:check       # report whether the local copy is current
pnpm app:build          # fetch + the NSIS installer
pnpm app:portable       # fetch + build + portable zip
```

All of the above run in `.github/workflows/ci.yml`, split so the renderer job
stays on Linux and only the FFmpeg and WebView2 work needs a Windows runner.
Pushing a `v*` tag builds and drafts a release.

The end-to-end tests drive real FFmpeg: they generate a colour-banded fixture,
run an export, and assert on the resulting file's duration, colours at given
timestamps, and that a hole is genuinely black and silent. Add a test there for
anything that changes what comes out.

## Artwork

`logo.png` is the only source. Everything else is rendered from it, so the
window, the taskbar and the README cannot drift apart:

```bash
pnpm icons        # logo.png -> src-tauri/icon-source.png + the title bar mark
pnpm tauri icon src-tauri/icon-source.png    # -> src-tauri/icons/
pnpm banner       # -> docs/banner.png
pnpm support      # -> docs/support.png, the card over the README's Ko-fi section
```

All three generators need `pip install pillow fonttools brotli`; the banner and
the support card read the brand woff2 files out of `node_modules` and convert
them in memory, because Pillow cannot open woff2.

`make-icon-source.py` cuts the tile out of the logo and makes everything outside
it transparent. That matters: the logo is artwork on a matte with a drop shadow,
and handing the whole canvas to `tauri icon` is what makes a taskbar icon read as
a black square. The crop bounds and the corner radius in that file were measured
off the rim highlight on the tile's edge, so re-run it rather than adjusting the
numbers by eye if the artwork changes.

The screenshots in `docs/` are real captures of a release build, driven by
keyboard and mouse, with a generated clip in the product's own palette as the
footage. Nothing there is a mock-up.

## Requirements

Nothing: FFmpeg ships inside. The search order is the registered resource
directory, then `bin/` beside the executable, then the executable's own folder,
then PATH — so a development checkout without `pnpm ffmpeg:fetch` still works off
a system FFmpeg. Windows 10/11 with WebView2.
