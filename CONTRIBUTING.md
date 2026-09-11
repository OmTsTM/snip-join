# Contributing

Snip Join decides which parts of somebody's footage survive. A defect here does
not produce a wrong pixel; it produces an export that is missing the moment the
user was keeping, and the source it came from may be the only copy. The rules
below exist for that reason.

## The invariant

> Which field is authoritative depends on the mode, and getting it backwards
> silently undoes the user's work.

A **block** is a surviving piece of the source. `source` says which stretch of
the original file it shows; `start` says where it sits on the edited timeline.
They are independent, which is what lets a block be dragged without touching
media — and it is also what makes the two modes incompatible:

| Mode | Authoritative | Derived |
|---|---|---|
| `join` | array order | `start`, by reflowing from zero |
| `gap` | `start` | array order, by sorting on it |

Sorting by `start` in `join` mode discards a reorder the user just made, and the
timeline still looks plausible afterwards, which is why this is stated before
anything else. Every operation funnels through `settle()` in
`src/domain/timeline.ts`. Add operations there rather than mutating a block list
in a component.

## Layering

The same four layers exist on both sides, and dependencies point inward only.

```
src-tauri/src/                        src/
  domain/          editing rules,       domain/          timeline, blocks,
                   no FFmpeg, no Tauri                   time, export vocabulary
  application/     use cases, the       application/     undo stack
                   pure export planner
  infrastructure/  FFmpeg adapters,     infrastructure/  IPC client, i18n
                   paths, processes
  interface/       commands, DTOs       presentation/    React, hooks, store
```

- `domain/` imports nothing from the other layers and is unit tested without a
  process, a window, or a file on disk.
- **Every routing decision for an export is made in
  `application/export_plan.rs`, which is pure**: it returns an ordered list of
  commands, and the executor only walks the list. That is why "does a hole force
  a re-encode?" is a unit test rather than something you observe by running an
  export and waiting four minutes.
- `interface/` commands are thin. If a command contains a decision, the decision
  belongs in a use case.

## Language

**Every comment, doc comment, identifier, commit message and test name is
written in English**, in technical prose — `//`, `///`, `/** */`, `#` and JSDoc
alike.

User-facing strings are the only exception. They live in
`src/infrastructure/i18n/` as four flat dictionaries — English, Brazilian
Portuguese, Spanish and Simplified Chinese — and the English catalogue defines
the key type, so a locale missing a key fails `tsc` rather than falling back
silently at run time.

Two things the type checker cannot see, both covered by
`node scripts/check-i18n.mjs` in CI:

- **A placeholder translated along with its sentence.** `{width}` written as
  `{largura}` never substitutes; one language's users see a literal brace and
  nothing fails.
- **A key nothing asks for.** Dead entries are translated, reviewed and carried
  by every locale for as long as they sit there. Thirty had accumulated before
  the first audit.

## Comments

Comments explain **why**, not what. A comment restating the line below it is
noise. A comment recording a constraint, a trade-off, or a defect that was
avoided is the reason the line looks the way it does:

```rust
// FFmpeg applies the display matrix for -vf but not for -filter_complex, so
// rotation is baked in by hand here. Skip it and phone clips export sideways.
```

## Colour

The palette is sampled from `logo.png`, not invented: `#F9811E` is the scissors,
`#F4E6D6` is the "Join" lettering, `#1B406B` is the window at dusk, `#090A0B` is
the matte.

**Orange means cutting and nothing else** — selection rails, the Remove button,
torn edges, the removed counter. Everything that joins, keeps or produces is
paper or dusk, including the Export button. An orange Export button would make
"delete this" and "produce the file" read as the same kind of action.

## Before opening a pull request

```powershell
pnpm typecheck
pnpm test
pnpm i18n:check
cd src-tauri; cargo fmt --all; cargo clippy --all-targets -- -D warnings; cargo test
```

All of them run in CI and all of them must be clean. `cargo test` includes the
end-to-end suite, which needs a real FFmpeg: `pnpm ffmpeg:fetch` puts the
bundled one in `src-tauri/bin`, and adding that directory to PATH is what the
test binary finds, since it runs from under `target` where the locator's bundled
directories do not apply.

## Tests

Name a test after the property it defends, not the function it calls:
`removing_the_middle_without_joining_leaves_a_black_silent_hole` says what broke
if it fails.

**Anything that changes what comes out of an export needs an end-to-end test.**
`src-tauri/tests/export_pipeline.rs` generates a colour-banded fixture, runs a
real export, and asserts on the resulting file — its duration, its colours at
given timestamps, and that a hole is genuinely black and silent. An argument
list can be perfectly well formed and still produce a video of the wrong length.

## Traps that have already cost a day

- **A zustand selector must return a reference-stable value.** State is read
  through `useSyncExternalStore`, which compares snapshots by identity, so a
  selector deriving a fresh object or array on every call never compares equal:
  React re-renders forever and the window goes blank with no visible error.
  Derived collections belong in a `useMemo` inside the component.
  `src/presentation/state/selectors.test.ts` guards this.
- **A stream copy cannot draw a hole.** `ExportSpec::reconciled()` promotes the
  mode when the timeline has one, and the dialog shows the promotion rather than
  letting the backend do it quietly.
- **`concat` corrupts silently on mismatched inputs.** Every segment is forced to
  the same size, pixel format, sample aspect and frame rate before joining.
- **A copy can only begin on a keyframe.** Keyframes are listed by reading
  packets, never frames — `-show_frames` decodes every one of them and turns a
  two-hour file from seconds into minutes.
- **`CREATE_NO_WINDOW` is mandatory.** One process per filmstrip frame means a
  visible console strobe without it.
- **Never write an export over its source.** `paths::validate_output` refuses it;
  FFmpeg would truncate the file it is reading.

[CLAUDE.md](CLAUDE.md) carries the full list and the reasoning behind the
architecture.
