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
- **Never write the export over the source.** `paths::validate_output` refuses
  it; FFmpeg would truncate the file it is reading.

## Security posture

- The renderer has **no** filesystem, shell or HTTP capability. See
  `src-tauri/capabilities/default.json`.
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
cd src-tauri && cargo test              # 119 unit + 8 end-to-end
cd src-tauri && cargo clippy --all-targets
cd src-tauri && cargo fmt --all         # rustfmt.toml sits at the repo root
pnpm ffmpeg:fetch       # download the FFmpeg that gets bundled
pnpm ffmpeg:check       # report whether the local copy is current
pnpm app:build          # fetch + NSIS and MSI installers
pnpm app:portable       # fetch + build + portable zip
```

All of the above run in `.github/workflows/ci.yml`, split so the renderer job
stays on Linux and only the FFmpeg and WebView2 work needs a Windows runner.
Pushing a `v*` tag builds and drafts a release.

The end-to-end tests drive real FFmpeg: they generate a colour-banded fixture,
run an export, and assert on the resulting file's duration, colours at given
timestamps, and that a hole is genuinely black and silent. Add a test there for
anything that changes what comes out.

## Icons

`src-tauri/icon-source.png` is the logo with the badge cropped to its orange ring
and everything outside it made transparent, which is what keeps the taskbar icon
from reading as a black square. Regenerate the set with
`pnpm tauri icon src-tauri/icon-source.png`.

## Requirements

Nothing: FFmpeg ships inside. The search order is the registered resource
directory, then `bin/` beside the executable, then the executable's own folder,
then PATH — so a development checkout without `pnpm ffmpeg:fetch` still works off
a system FFmpeg. Windows 10/11 with WebView2.
