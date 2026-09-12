import { convertFileSrc } from '@tauri-apps/api/core'
import { create } from 'zustand'

import {
  amend,
  canRedo,
  canUndo,
  createHistory,
  record,
  redo as redoHistory,
  undo as undoHistory,
  type History,
} from '@application/history'
import type { ExportSpec } from '@domain/export'
import {
  parseProject,
  projectTimeline,
  serialiseProject,
  toProject,
  type Project,
} from '@domain/project'
import { nearestKeyframe } from '@domain/lossless'
import {
  clampDockHeight,
  MIN_DOCK_HEIGHT,
} from '@presentation/features/timeline/dockSize'
import { clamp, snapToFrame, span, type Span } from '@domain/time'
import {
  appendMedium,
  blockAt,
  coveredSpan,
  mediaAt,
  createTimeline,
  duplicateBlock as duplicateBlockIn,
  findBlock,
  insertClip,
  isolateSpan,
  mediaOrder,
  keptDuration,
  moveBlock as moveBlockIn,
  removeBlock as removeBlockIn,
  removeSpan,
  setMode as setModeIn,
  shiftBlock as shiftBlockIn,
  splitAt,
  totalDuration,
  trimBlock as trimBlockIn,
  withBlocks,
  type Block,
  type BlockId,
  type Clip,
  type Timeline,
  type TimelineMode,
} from '@domain/timeline'
import {
  api,
  BackendError,
  EVENTS,
  subscribe,
  type Capabilities,
  type ExportOutcome,
  type MediaSourceInfo,
  type ThumbnailPayload,
} from '@infrastructure/tauri/api'

/** How many filmstrip frames to sample across the whole source. */
const THUMBNAIL_COUNT = 80

/**
 * How close a cut has to come to a cut point before it is pulled onto it, in
 * pixels.
 *
 * A distance, not "the nearest one wherever it is". Some files carry almost no
 * cut points at all — an animated GIF has exactly one, at the start — and
 * against a list like that an unbounded snap drags *every* cut back to the same
 * instant: a trimmed edge collapses to nothing the moment it is touched, and a
 * selection can only ever cover the whole block. Measured in pixels, so it
 * behaves the same at every zoom, and generous enough that footage with cut
 * points every few seconds still snaps onto them the way it always did.
 *
 * What is given up is exactness on sparse footage, and the export dialog
 * already says so: it reports how far a copy would move each cut, or that a
 * copy is off the table entirely.
 */
const SNAP_PIXELS = 12

export interface Thumbnail {
  readonly at: number
  readonly dataUrl: string
}

export interface AppError {
  readonly code: string
  readonly message: string
}

export type Phase = 'empty' | 'opening' | 'preparing' | 'ready'

export interface ExportJob {
  readonly jobId: string
  readonly progress: number
  readonly destination: string
}

interface EditorState {
  phase: Phase
  /**
   * Every file the project has open, in the order they were added.
   *
   * The first one is the project's own: it decides the output format and is
   * what a destination is suggested beside.
   */
  media: readonly MediaSourceInfo[]
  source: MediaSourceInfo | null
  /** Asset URL each medium's preview loads, keyed by path. */
  previewUrls: Readonly<Record<string, string>>
  /** Which media are being previewed through a generated proxy. */
  proxies: Readonly<Record<string, boolean>>
  proxyProgress: number
  capabilities: Capabilities | null

  history: History<Timeline>
  selection: Span | null
  playhead: number
  playing: boolean
  /** Preview loudness, 0 to 1. Remembered between sessions. */
  volume: number
  muted: boolean
  /** Timeline scale, in pixels per second. */
  pixelsPerSecond: number
  /** Filmstrip frames per medium, keyed by path. */
  thumbnails: Readonly<Record<string, readonly Thumbnail[]>>
  /**
   * How many media are still having their frames read.
   *
   * A count rather than a flag because two files can be read at once, and the
   * first to finish must not clear the second's veil. Completion comes from the
   * command settling rather than from counting frames against what was asked
   * for: a frame that cannot be decoded is skipped on purpose, so a strip can
   * legitimately come up short and the veil would never lift.
   */
  pendingFrames: number

  /**
   * Positions a stream copy can cut at, per medium, keyed by path.
   *
   * Per medium rather than one list: they are positions *in a file*, so a single
   * list cannot describe a timeline reading from several. Snapping against the
   * first file's list beyond its own length pulled every cut on a later file
   * back into the first one, which made the newer media impossible to select on.
   *
   * Held here rather than derived because reading them costs a process launch,
   * and because both the timeline and the export dialog need the same answer.
   */
  keyframes: Readonly<Record<string, readonly number[]>>
  keyframesTruncated: Readonly<Record<string, boolean>>

  /**
   * Whether cuts are pulled onto the nearest cut point.
   *
   * On by default because the default export copies the streams, and a copy can
   * only begin on a cut point. With this off a cut can be placed on any frame,
   * which only a re-encoding export can honour.
   */
  snapToCutPoints: boolean

  /**
   * Whether a drag that reaches the side of the window scrolls the timeline.
   *
   * Off by default. It is the difference between a long block being reachable
   * and not, but it also means the view moves on its own while you are holding
   * something — and a view that moves when you did not ask it to is worse than
   * one that makes you zoom out, so it is offered rather than imposed.
   */
  edgeScroll: boolean

  /**
   * Height of the timeline dock in pixels.
   *
   * Lives in the store rather than in a component because the divider, the dock
   * and every block on it have to agree on one number, and because it outlives
   * the video that happens to be open.
   */
  timelineHeight: number

  /**
   * The block the user last pointed at, if any.
   *
   * A second kind of selection, and deliberately not the same one as the rails:
   * the rails mark a stretch of *time* to take out, this marks a *piece* to act
   * on. Delete, copy, cut and the block menu all read this, which is what lets
   * the keyboard reach a block at all.
   */
  selectedBlock: BlockId | null

  /**
   * The piece a copy or a cut put aside, ready to be pasted.
   *
   * A clip rather than a block: a block carries a position on the timeline, and
   * the position a paste lands at is the playhead's, not the one it was copied
   * from. Held outside the undo history, which records the timeline and not what
   * the user happens to be holding.
   */
  clipboard: Clip | null

  /**
   * Files the project names that could not be opened.
   *
   * Kept beside the pool rather than inside it: a missing file has no duration,
   * no streams and no preview, so it is not a `MediaSourceInfo` and pretending
   * otherwise would put zeroes into every calculation that touches it.
   */
  missingMedia: readonly string[]

  /**
   * Where this project lives on disk, once it has been saved anywhere.
   *
   * Null means it has never been saved, which is the only case where saving has
   * to ask a question first.
   */
  projectPath: string | null

  /**
   * What the last save wrote, so "has anything changed" can be answered without
   * serialising the whole project on every render.
   *
   * The two references are compared, not their contents: the store replaces the
   * timeline and the media array wholesale on every edit, so identity says
   * exactly as much as a deep comparison would and costs nothing.
   */
  savedMark: { readonly timeline: Timeline; readonly media: readonly MediaSourceInfo[] } | null

  exportJob: ExportJob | null
  lastExport: ExportOutcome | null
  error: AppError | null

  /**
   * Identifies the file currently open.
   *
   * Opening a video starts several independent asynchronous jobs. Any of them
   * can finish after the user has already opened a different file, so every
   * result is checked against this before it is applied.
   */
  mediaToken: string

  openFile: (path: string) => Promise<void>
  /** Adds a file, appended to the end unless a position is given. */
  addMedia: (path: string, at?: number) => Promise<void>
  removeMedium: (mediaId: string) => Promise<void>
  closeFile: () => Promise<void>

  setSelection: (selection: Span | null) => void
  /**
   * Pulls an instant onto the nearest cut point while snapping is on.
   *
   * `blockId` names the block the instant belongs to when the caller already
   * knows — a trim reaches outside the block's current range, so looking up what
   * sits under the instant would answer with the neighbour.
   */
  snapToCutPoint: (at: number, blockId?: BlockId) => number
  setSnapToCutPoints: (enabled: boolean) => void
  setEdgeScroll: (enabled: boolean) => void
  setTimelineHeight: (height: number) => void
  markIn: () => void
  markOut: () => void
  selectAll: () => void
  removeSelection: () => void
  liftSelection: () => void

  setMode: (mode: TimelineMode) => void
  splitAtPlayhead: () => void
  beginGesture: () => void
  moveBlock: (id: BlockId, start: number) => void
  trimBlock: (id: BlockId, edge: 'start' | 'end', at: number) => void
  deleteBlock: (id: BlockId) => void

  selectBlock: (id: BlockId | null) => void
  /** Moves a block one place along the running order. */
  shiftBlock: (id: BlockId, direction: 1 | -1) => void
  duplicateBlock: (id: BlockId) => void
  copyBlock: (id: BlockId) => void
  cutBlock: (id: BlockId) => void
  pasteAtPlayhead: () => void

  saveProject: (path?: string) => Promise<boolean>
  openProject: (path: string) => Promise<void>
  /** Points a missing medium at the file it moved to. */
  locateMedium: (missing: string, found: string) => Promise<void>
  /** Drops a missing medium, and every block that reads from it. */
  dropMissingMedium: (missing: string) => void

  undo: () => void
  redo: () => void

  seek: (at: number) => void
  setPlaying: (playing: boolean) => void
  togglePlay: () => void
  setVolume: (value: number) => void
  toggleMuted: () => void
  stepFrame: (direction: 1 | -1) => void
  setPixelsPerSecond: (value: number) => void

  runExport: (spec: ExportSpec, destination: string) => Promise<void>
  cancelExport: () => Promise<void>

  reportError: (error: unknown) => void
  dismissError: () => void
}

const DOCK_HEIGHT_KEY = 'snipjoin.timelineHeight'
const RECENTS_KEY = 'snipjoin.recentProjects'

/** How many recent projects the welcome screen offers. */
const MAX_RECENTS = 6

export interface RecentProject {
  readonly path: string
  /** Milliseconds since the epoch, so the list can be ordered by when. */
  readonly at: number
}

/**
 * The projects most recently opened or saved.
 *
 * In the web view's own storage rather than a file of its own: it is a
 * convenience that belongs to this installation, it is worthless to anyone
 * else, and losing it costs nothing. Anything unusable in there is treated as an
 * empty list rather than propagating into the welcome screen.
 */
export function readRecentProjects(): readonly RecentProject[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (entry): entry is RecentProject =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as RecentProject).path === 'string' &&
          typeof (entry as RecentProject).at === 'number',
      )
      .slice(0, MAX_RECENTS)
  } catch {
    return []
  }
}

/** Puts a project at the top of the list, without listing it twice. */
function rememberProject(path: string): void {
  try {
    const rest = readRecentProjects().filter((entry) => entry.path !== path)
    const next = [{ path, at: Date.now() }, ...rest].slice(0, MAX_RECENTS)
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch {
    // The project is still open; only the shortcut back to it is lost.
  }
}

/** Drops a project from the list, for one that is no longer on disk. */
export function forgetRecentProject(path: string): void {
  try {
    const rest = readRecentProjects().filter((entry) => entry.path !== path)
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(rest))
  } catch {
    // Nothing to do: the list is a convenience.
  }
}
const EDGE_SCROLL_KEY = 'snipjoin.edgeScroll'
const VOLUME_KEY = 'snipjoin.volume'
const MUTED_KEY = 'snipjoin.muted'

/**
 * Reads the remembered dock height.
 *
 * Storage can be unavailable or hold anything at all, so an unusable value falls
 * back to the default rather than propagating into a layout calculation.
 */
function readStoredDockHeight(): number {
  try {
    const stored = Number(window.localStorage.getItem(DOCK_HEIGHT_KEY))
    return clampDockHeight(stored, window.innerHeight)
  } catch {
    return MIN_DOCK_HEIGHT
  }
}

function storeDockHeight(height: number): void {
  try {
    window.localStorage.setItem(DOCK_HEIGHT_KEY, String(height))
  } catch {
    // The choice still applies for this session.
  }
}

/**
 * Reads the remembered loudness.
 *
 * Anything unusable falls back to full volume: a stored value that has been
 * corrupted should not leave a user wondering why the preview is silent.
 */
function readStoredVolume(): number {
  try {
    // `Number(null)` is 0, so converting before the null check is what makes a
    // first run silent: nothing stored has to mean full volume, not none.
    const stored = window.localStorage.getItem(VOLUME_KEY)
    if (stored === null) return 1
    const value = Number(stored)
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1
  } catch {
    return 1
  }
}

function readStoredMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTED_KEY) === 'true'
  } catch {
    return false
  }
}

/** Reads the remembered edge-scroll choice. Anything unusable means off. */
function readStoredEdgeScroll(): boolean {
  try {
    return window.localStorage.getItem(EDGE_SCROLL_KEY) === 'true'
  } catch {
    return false
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The choice still applies for this session.
  }
}

/**
 * Builds and registers the preview for one medium.
 *
 * Proxy generation is the slow part of opening a file, which is why the first
 * one is awaited before the editor calls itself ready. A file added later is
 * not waited for: the timeline works without its picture.
 */
async function loadPreview(source: MediaSourceInfo, token: string): Promise<void> {
  try {
    const preview = await api.preparePreview(source.path, token)
    if (useEditor.getState().mediaToken !== token) return
    useEditor.setState((state) => ({
      previewUrls: { ...state.previewUrls, [source.path]: convertFileSrc(preview.path) },
      proxies: { ...state.proxies, [source.path]: preview.isProxy },
    }))
  } catch {
    // A preview that cannot be built leaves the picture black; the edit itself
    // is unaffected, and the export reads the original file either way.
  }
}

/**
 * Reads one medium's cut points in the background.
 *
 * Not awaited: the timeline works without them and simply gains snapping when
 * they land. Every medium gets its own read, because a cut point is a position
 * inside a file and there is no such thing as a shared list.
 */
function loadKeyframes(source: MediaSourceInfo, token: string): void {
  void api
    .keyframes(source.path)
    .then((report) => {
      if (useEditor.getState().mediaToken !== token) return
      useEditor.setState((state) => ({
        keyframes: { ...state.keyframes, [source.path]: report.positions },
        keyframesTruncated: { ...state.keyframesTruncated, [source.path]: report.truncated },
      }))
    })
    .catch(() => undefined)
}

/** Starts filling one medium's filmstrip. The frames arrive as events. */
function loadFrames(source: MediaSourceInfo, token: string): void {
  useEditor.setState((state) => ({ pendingFrames: state.pendingFrames + 1 }))
  void api
    .generateThumbnails(source.path, THUMBNAIL_COUNT, token)
    .catch(() => undefined)
    .finally(() => {
      useEditor.setState((state) => ({
        pendingFrames: Math.max(0, state.pendingFrames - 1),
      }))
    })
}

/** The timeline before anything is open, so selectors never see null. */
const EMPTY_TIMELINE = createTimeline('', 0, 'join')

/**
 * Guards a gesture so a continuous drag collapses into one undo step.
 *
 * Kept outside the store because it is transient interaction bookkeeping, not
 * application state: nothing renders from it and putting it in the store would
 * re-render the whole editor on every pointer move.
 */
let gestureOpen = false

export const useEditor = create<EditorState>((set, get) => ({
  phase: 'empty',
  media: [],
  source: null,
  previewUrls: {},
  proxies: {},
  proxyProgress: 0,
  capabilities: null,

  history: createHistory(EMPTY_TIMELINE),
  selection: null,
  playhead: 0,
  playing: false,
  volume: readStoredVolume(),
  muted: readStoredMuted(),
  pixelsPerSecond: 40,
  thumbnails: {},
  pendingFrames: 0,
  keyframes: {},
  keyframesTruncated: {},
  snapToCutPoints: true,
  edgeScroll: readStoredEdgeScroll(),
  timelineHeight: readStoredDockHeight(),

  selectedBlock: null,
  clipboard: null,
  missingMedia: [],
  projectPath: null,
  savedMark: null,

  exportJob: null,
  lastExport: null,
  error: null,
  mediaToken: '',

  async openFile(path) {
    const token = crypto.randomUUID()
    set({
      phase: 'opening',
      error: null,
      media: [],
      previewUrls: {},
      proxies: {},
      thumbnails: {},
      lastExport: null,
      selectedBlock: null,
      missingMedia: [],
      projectPath: null,
      savedMark: null,
      mediaToken: token,
    })

    try {
      const source = await api.openMedia(path)
      if (get().mediaToken !== token) return

      set({
        media: [source],
        source,
        phase: 'preparing',
        history: createHistory(createTimeline(source.path, source.duration, 'join')),
        selection: null,
        keyframes: {},
        keyframesTruncated: {},
        playhead: 0,
        playing: false,
        proxyProgress: 0,
      })

      // Capabilities are cached backend-side, so asking again is nearly free and
      // keeps the export dialog honest if this is the first file of the session.
      void api
        .capabilities()
        .then((capabilities) => set({ capabilities }))
        .catch(() => undefined)

      await loadPreview(source, token)
      if (get().mediaToken !== token) return
      set({ phase: 'ready' })

      loadFrames(source, token)
      loadKeyframes(source, token)
    } catch (error) {
      if (get().mediaToken !== token) return
      set({ phase: 'empty', source: null, media: [] })
      get().reportError(error)
    }
  },

  /**
   * Adds another file to the project and puts a block of it on the timeline.
   *
   * Appended by default, because where a whole file belongs is the user's
   * business. `at` is what a drag out of the media pool passes: a drop says
   * exactly where it goes, so there is no reason to make the user move it
   * afterwards.
   */
  async addMedia(path, at) {
    const { mediaToken: token, phase } = get()
    if (phase === 'empty') {
      await get().openFile(path)
      return
    }

    try {
      const source = await api.openMedia(path)
      if (get().mediaToken !== token) return

      // The same file twice is a reasonable thing to want — the same shot used
      // at the start and again at the end — so it earns a second block without
      // a second entry in the pool or a second read of its frames.
      const known = get().media.some((medium) => medium.path === source.path)

      set((state) => {
        const timeline = state.history.present
        const placed =
          at === undefined
            ? appendMedium(timeline, source.path, source.duration)
            : insertClip(timeline, { mediaId: source.path, source: span(0, source.duration) }, at)
                .timeline

        return {
          media: known ? state.media : [...state.media, source],
          history: record(state.history, placed),
        }
      })

      if (known) return

      await loadPreview(source, token)
      loadFrames(source, token)
      loadKeyframes(source, token)
    } catch (error) {
      if (get().mediaToken !== token) return
      get().reportError(error)
    }
  },

  /**
   * Drops a file and everything on the timeline that reads from it.
   *
   * The first medium cannot be dropped: it decides the output format, and
   * losing it halfway through an edit would silently change what every other
   * piece is normalised to.
   */
  async removeMedium(mediaId) {
    const { media, history } = get()
    if (media[0]?.path === mediaId) return

    const blocks = history.present.blocks.filter((block) => block.mediaId !== mediaId)
    set((state) => {
      const previewUrls = { ...state.previewUrls }
      const proxies = { ...state.proxies }
      const thumbnails = { ...state.thumbnails }
      const keyframes = { ...state.keyframes }
      const keyframesTruncated = { ...state.keyframesTruncated }
      delete previewUrls[mediaId]
      delete proxies[mediaId]
      delete thumbnails[mediaId]
      delete keyframes[mediaId]
      delete keyframesTruncated[mediaId]

      return {
        media: state.media.filter((medium) => medium.path !== mediaId),
        previewUrls,
        proxies,
        thumbnails,
        keyframes,
        keyframesTruncated,
        selectedBlock: null,
        // A piece of a file the project no longer holds must not stay on the
        // clipboard: pasting it would name a medium the export cannot read.
        clipboard: state.clipboard?.mediaId === mediaId ? null : state.clipboard,
        history: record(state.history, withBlocks(state.history.present, blocks)),
      }
    })

    await api.forgetMedia(mediaId).catch(() => undefined)
  },

  async closeFile() {
    await api.closeMedia().catch(() => undefined)
    set({
      phase: 'empty',
      media: [],
      source: null,
      previewUrls: {},
      proxies: {},
      proxyProgress: 0,
      history: createHistory(EMPTY_TIMELINE),
      selection: null,
      playhead: 0,
      playing: false,
      thumbnails: {},
      pendingFrames: 0,
      keyframes: {},
      keyframesTruncated: {},
      selectedBlock: null,
      clipboard: null,
      missingMedia: [],
      projectPath: null,
      savedMark: null,
      exportJob: null,
      lastExport: null,
      mediaToken: '',
    })
  },

  snapToCutPoint(at, blockId) {
    const { snapToCutPoints, keyframes, keyframesTruncated, history, pixelsPerSecond } = get()
    if (!snapToCutPoints) return at

    // Cut points are positions inside a file, and the timeline has been reflowed
    // and reordered since that file was opened, so the instant is carried into
    // the block's own source coordinates, snapped there, and carried back.
    // Snapping in timeline coordinates aimed at a position in the first file:
    // past its length every cut on a later medium was dragged back into it,
    // which made the newer media impossible to mark a selection on at all.
    const block = blockId
      ? findBlock(history.present, blockId)
      : blockAt(history.present, at)
    if (!block) return at

    // Footage with more cut points than were listed can be cut anywhere, so
    // there is nothing to be pulled onto — and the list that came back is only
    // the first of them, which would drag every later cut backwards.
    if (keyframesTruncated[block.mediaId]) return at

    const positions = keyframes[block.mediaId]
    if (!positions || positions.length === 0) return at

    const inSource = block.source.start + (at - block.start)
    const snapped = nearestKeyframe(positions, inSource)
    if (snapped === null) return at

    // Out of reach: the cut stays where it was put. This is the whole of what
    // keeps a file with one cut point from collapsing every edit onto it.
    const reach = SNAP_PIXELS / Math.max(pixelsPerSecond, 1e-6)
    if (Math.abs(snapped - inSource) > reach) return at

    return block.start + (snapped - block.source.start)
  },

  setSnapToCutPoints(enabled) {
    set({ snapToCutPoints: enabled })
  },

  setEdgeScroll(enabled) {
    set({ edgeScroll: enabled })
    remember(EDGE_SCROLL_KEY, String(enabled))
  },

  setTimelineHeight(height) {
    // Clamped here rather than at the call sites, so a drag, an arrow key and a
    // window resize all obey the same limits.
    const clamped = clampDockHeight(height, window.innerHeight)
    if (clamped === get().timelineHeight) return

    set({ timelineHeight: clamped })
    storeDockHeight(clamped)
  },

  setSelection(selection) {
    if (!selection) {
      set({ selection: null })
      return
    }

    const total = totalDuration(get().history.present)
    const start = clamp(Math.min(selection.start, selection.end), 0, total)
    const end = clamp(Math.max(selection.start, selection.end), 0, total)
    set({ selection: end - start < 1e-3 ? null : span(start, end) })
  },

  markIn() {
    const { playhead, selection } = get()
    const end = selection && selection.end > playhead ? selection.end : totalDuration(get().history.present)
    get().setSelection(span(playhead, end))
  },

  markOut() {
    const { playhead, selection } = get()
    const start = selection && selection.start < playhead ? selection.start : 0
    get().setSelection(span(start, playhead))
  },

  selectAll() {
    get().setSelection(span(0, totalDuration(get().history.present)))
  },

  removeSelection() {
    const { selection, history } = get()
    if (!selection) return

    // Narrowed to the material underneath first. The rails can be dragged
    // across a hole, and a hole holds nothing: a range that covers only one is
    // an absence, and cutting an absence is not an edit. Anything that survives
    // the narrowing is removed, so a range that merely *overlaps* a hole still
    // works and takes out exactly the footage it was covering.
    const covered = coveredSpan(history.present, selection)
    if (!covered) return

    // Removing everything is allowed: the media pool still holds the files, so
    // an empty timeline is a fresh start rather than a dead end. What it is not
    // is exportable, which the Export button says for itself.
    const next = removeSpan(history.present, covered)
    const total = totalDuration(next)
    set({
      history: record(history, next),
      selection: null,
      selectedBlock: null,
      playhead: clamp(covered.start, 0, total),
    })
  },

  liftSelection() {
    const { selection, history } = get()
    if (!selection) return

    // Lifting an empty hole would make a block out of nothing, for the same
    // reason removing one takes nothing out.
    const covered = coveredSpan(history.present, selection)
    if (!covered) return

    const { timeline, isolated } = isolateSpan(history.present, covered)
    set({ history: record(history, timeline), selection: null, selectedBlock: isolated })
  },

  setMode(mode) {
    const { history } = get()
    const next = setModeIn(history.present, mode)
    if (next === history.present) return
    set({ history: record(history, next), playhead: clamp(get().playhead, 0, totalDuration(next)) })
  },

  splitAtPlayhead() {
    const { history, playhead } = get()
    const next = splitAt(history.present, playhead)
    if (next === history.present) return
    set({ history: record(history, next) })
  },

  beginGesture() {
    gestureOpen = false
  },

  moveBlock(id, start) {
    const { history } = get()
    const next = moveBlockIn(history.present, id, start)
    if (next === history.present) return

    // The first move of a gesture opens an undo step; the rest amend it.
    set({ history: gestureOpen ? amend(history, next) : record(history, next) })
    gestureOpen = true
  },

  trimBlock(id, edge, at) {
    const { history, media } = get()

    // The block's own medium, not the project's first one. Trimming clamps
    // against how much material there is, and a second file is rarely the same
    // length as the first — a still is not even the same kind of thing, since
    // its one frame stretches to whatever the preview copy covers.
    const block = findBlock(history.present, id)
    if (!block) return
    const medium = media.find((candidate) => candidate.path === block.mediaId)
    if (!medium) return

    const next = trimBlockIn(history.present, id, edge, at, medium.maxDuration)
    if (next === history.present) return

    set({ history: gestureOpen ? amend(history, next) : record(history, next) })
    gestureOpen = true
  },

  deleteBlock(id) {
    const { history } = get()
    // `settle` rebuilds the list either way, so an identity check would never
    // catch a delete that removed nothing. Asking whether the block is there is
    // what keeps a stale id out of the undo history.
    if (!findBlock(history.present, id)) return

    const next = removeBlockIn(history.present, id)

    set({
      history: record(history, next),
      selectedBlock: get().selectedBlock === id ? null : get().selectedBlock,
      playhead: clamp(get().playhead, 0, totalDuration(next)),
    })
  },

  selectBlock(id) {
    if (get().selectedBlock === id) return
    set({ selectedBlock: id })
  },

  shiftBlock(id, direction) {
    const { history } = get()
    const next = shiftBlockIn(history.present, id, direction)
    if (next === history.present) return
    set({ history: record(history, next), selectedBlock: id })
  },

  duplicateBlock(id) {
    const { history } = get()
    const { timeline, inserted } = duplicateBlockIn(history.present, id)
    if (timeline === history.present) return
    set({ history: record(history, timeline), selectedBlock: inserted })
  },

  copyBlock(id) {
    const block = findBlock(get().history.present, id)
    if (!block) return
    set({ clipboard: { mediaId: block.mediaId, source: block.source }, selectedBlock: id })
  },

  cutBlock(id) {
    get().copyBlock(id)
    get().deleteBlock(id)
  },

  /**
   * Puts whatever was copied or cut back on the timeline, at the playhead.
   *
   * The playhead rather than where it came from: a paste is a placement, and the
   * position the user is looking at is the one they mean.
   */
  pasteAtPlayhead() {
    const { clipboard, history, playhead, media } = get()
    if (!clipboard) return

    // A file dropped from the project between the copy and the paste would put a
    // block on the timeline that no export could read.
    if (!media.some((medium) => medium.path === clipboard.mediaId)) {
      set({ clipboard: null })
      return
    }

    const { timeline, inserted } = insertClip(history.present, clipboard, playhead)
    if (timeline === history.present) return

    set({ history: record(history, timeline), selection: null, selectedBlock: inserted })
  },

  /**
   * Writes the project, asking where only the first time.
   *
   * Returns whether anything was written, because the close prompt has to know
   * the difference between "saved" and "the picker was dismissed" — closing on
   * the second would throw away the work the question was asked about.
   */
  async saveProject(path) {
    const { media, history, projectPath } = get()
    if (media.length === 0) return false

    const destination = path ?? projectPath
    if (!destination) return false

    const project = toProject(
      media.map((medium) => medium.path),
      history.present,
    )

    try {
      const written = await api.saveProject(destination, serialiseProject(project))
      set({
        projectPath: written,
        savedMark: { timeline: history.present, media },
      })
      rememberProject(written)
      return true
    } catch (error) {
      get().reportError(error)
      return false
    }
  },

  /**
   * Opens a saved project, in place of whatever was open.
   *
   * Each medium is re-probed rather than trusted from the file: the files it
   * names may have moved, changed or gone, and everything the editor needs about
   * them — their length, their streams, whether they can be previewed — is a
   * property of the file today rather than of the day it was saved. A medium
   * that cannot be read keeps its place in the pool and is marked missing, so
   * the edit is still there to be repaired.
   */
  async openProject(path) {
    const token = crypto.randomUUID()
    set({
      phase: 'opening',
      error: null,
      media: [],
      previewUrls: {},
      proxies: {},
      thumbnails: {},
      keyframes: {},
      keyframesTruncated: {},
      lastExport: null,
      selection: null,
      selectedBlock: null,
      clipboard: null,
      playhead: 0,
      playing: false,
      proxyProgress: 0,
      projectPath: null,
      savedMark: null,
      mediaToken: token,
    })

    let project: Project
    try {
      project = parseProject(await api.loadProject(path))
    } catch (error) {
      set({ phase: 'empty' })
      get().reportError(error)
      return
    }

    const opened: MediaSourceInfo[] = []
    const missing: string[] = []
    for (const medium of project.media) {
      try {
        opened.push(await api.openMedia(medium))
      } catch {
        missing.push(medium)
      }
    }
    if (get().mediaToken !== token) return

    if (opened.length === 0) {
      set({ phase: 'empty' })
      get().reportError(new Error('none of the files this project uses could be opened'))
      return
    }

    // The blocks of a missing medium are kept, not dropped. Dropping them
    // would quietly rewrite the edit to match an accident — a file moved on
    // disk — and leave nothing to repair once the file is found again. They sit
    // there unreadable, the pool says which file is gone, and the export refuses
    // until it is either found or removed on purpose.
    const restored = projectTimeline(project)
    const timeline = withBlocks(restored, restored.blocks)
    const source = opened[0]!

    set({
      media: opened,
      missingMedia: missing,
      source,
      phase: 'preparing',
      history: createHistory(timeline),
      projectPath: path,
      savedMark: { timeline, media: opened },
    })
    rememberProject(path)

    void api
      .capabilities()
      .then((capabilities) => set({ capabilities }))
      .catch(() => undefined)

    await loadPreview(source, token)
    if (get().mediaToken !== token) return
    set({ phase: 'ready' })

    for (const medium of opened) {
      loadFrames(medium, token)
      loadKeyframes(medium, token)
    }
  },

  /**
   * Points a missing medium at the file it moved to.
   *
   * Every block that read from the old path is rewritten to the new one, so the
   * edit survives the file having been moved or renamed — which is the whole
   * reason a project stores paths and re-reads them rather than storing the
   * media itself.
   */
  async locateMedium(missingPath, found) {
    const token = get().mediaToken

    let source: MediaSourceInfo
    try {
      source = await api.openMedia(found)
    } catch (error) {
      get().reportError(error)
      return
    }
    if (get().mediaToken !== token) return

    set((state) => {
      const blocks = state.history.present.blocks.map((block) =>
        block.mediaId === missingPath ? { ...block, mediaId: source.path } : block,
      )

      return {
        media: state.media.some((medium) => medium.path === source.path)
          ? state.media
          : [...state.media, source],
        missingMedia: state.missingMedia.filter((path) => path !== missingPath),
        history: record(state.history, withBlocks(state.history.present, blocks)),
      }
    })

    await loadPreview(source, token)
    loadFrames(source, token)
    loadKeyframes(source, token)
  },

  dropMissingMedium(missingPath) {
    set((state) => ({
      missingMedia: state.missingMedia.filter((path) => path !== missingPath),
      history: record(
        state.history,
        withBlocks(
          state.history.present,
          state.history.present.blocks.filter((block) => block.mediaId !== missingPath),
        ),
      ),
    }))
  },

  undo() {
    if (!canUndo(get().history)) return
    const history = undoHistory(get().history)
    set({
      history,
      playhead: clamp(get().playhead, 0, totalDuration(history.present)),
      selection: null,
      selectedBlock: null,
    })
  },

  redo() {
    if (!canRedo(get().history)) return
    const history = redoHistory(get().history)
    set({
      history,
      playhead: clamp(get().playhead, 0, totalDuration(history.present)),
      selection: null,
      selectedBlock: null,
    })
  },

  seek(at) {
    set({ playhead: clamp(at, 0, totalDuration(get().history.present)) })
  },

  setPlaying(playing) {
    set({ playing })
  },

  togglePlay() {
    const { playing, playhead, history } = get()
    const total = totalDuration(history.present)
    // Pressing play at the very end restarts rather than doing nothing.
    if (!playing && playhead >= total - 1e-3) {
      set({ playhead: 0, playing: true })
      return
    }
    set({ playing: !playing })
  },

  setVolume(value) {
    const clamped = clamp(value, 0, 1)
    // Moving the slider off zero is how anyone expects to come back from
    // silence, so it lifts the mute rather than leaving a slider that does
    // nothing.
    const muted = clamped === 0 ? get().muted : false
    set({ volume: clamped, muted })
    remember(VOLUME_KEY, String(clamped))
    remember(MUTED_KEY, String(muted))
  },

  toggleMuted() {
    const muted = !get().muted
    set({ muted })
    remember(MUTED_KEY, String(muted))
  },

  stepFrame(direction) {
    const { source, playhead, history } = get()
    const frameRate = source?.video?.frameRate ?? 30
    const step = frameRate > 0.1 ? 1 / frameRate : 1 / 30
    const total = totalDuration(history.present)

    set({
      playing: false,
      playhead: clamp(snapToFrame(playhead + step * direction, frameRate), 0, total),
    })
  },

  setPixelsPerSecond(value) {
    set({ pixelsPerSecond: clamp(value, 2, 800) })
  },

  async runExport(spec, destination) {
    const { history, source, missingMedia } = get()
    // A timeline naming a file that is not there would fail at the first frame
    // with a message about a path rather than about the edit.
    if (!source || history.present.blocks.length === 0 || missingMedia.length > 0) return

    const jobId = crypto.randomUUID()

    // The table and the indices are built together, so a clip can never name a
    // file the request did not list.
    const media = mediaOrder(history.present)
    const clips = history.present.blocks.map((block) => ({
      media: Math.max(0, media.indexOf(block.mediaId)),
      sourceStart: block.source.start,
      sourceEnd: block.source.end,
      timelineStart: block.start,
    }))

    set({ exportJob: { jobId, progress: 0, destination }, error: null, lastExport: null })

    try {
      const outcome = await api.exportTimeline({
        jobId,
        outputPath: destination,
        media,
        clips,
        spec,
      })
      set({ exportJob: null, lastExport: outcome })
    } catch (error) {
      set({ exportJob: null })
      // A cancellation is a decision, not a failure, so it raises no alert.
      if (error instanceof BackendError && error.code === 'cancelled') return
      get().reportError(error)
    }
  },

  async cancelExport() {
    const job = get().exportJob
    if (!job) return
    await api.cancelJob(job.jobId).catch(() => undefined)
  },

  reportError(error) {
    if (error instanceof BackendError) {
      set({ error: { code: error.code, message: error.message } })
      return
    }
    set({
      error: {
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
      },
    })
  },

  dismissError() {
    set({ error: null })
  },
}))

/**
 * Starts listening for backend events.
 *
 * Called once from the application root; the returned function detaches every
 * listener, so a hot reload during development cannot stack duplicates.
 */
export function connectBackendEvents(): () => void {
  const unsubscribers = [
    subscribe<ThumbnailPayload>(EVENTS.thumbnailReady, (payload) => {
      useEditor.setState((state) => {
        // A frame extracted for a file that has since been closed must not land
        // in the filmstrip of the one that replaced it.
        if (payload.token !== state.mediaToken) return {}

        // Frames arrive out of order across the worker window, so each strip
        // is kept sorted by position rather than by arrival.
        const existing = state.thumbnails[payload.media] ?? []
        const next = [...existing, { at: payload.at, dataUrl: payload.dataUrl }]
        next.sort((a, b) => a.at - b.at)
        return { thumbnails: { ...state.thumbnails, [payload.media]: next } }
      })
    }),

    subscribe<{ jobId: string; progress: number }>(EVENTS.proxyProgress, (payload) => {
      useEditor.setState({ proxyProgress: payload.progress })
    }),

    subscribe<{ jobId: string; progress: number }>(EVENTS.exportProgress, (payload) => {
      useEditor.setState((state) =>
        state.exportJob && state.exportJob.jobId === payload.jobId
          ? { exportJob: { ...state.exportJob, progress: payload.progress } }
          : {},
      )
    }),
  ]

  return () => unsubscribers.forEach((detach) => detach())
}

// -- Selectors ---------------------------------------------------------------
// Derived values are computed here rather than in components so the same
// definition is used everywhere and nothing drifts.

export const selectTimeline = (state: EditorState): Timeline => state.history.present
export const selectDuration = (state: EditorState): number => totalDuration(state.history.present)
export const selectKept = (state: EditorState): number => keptDuration(state.history.present)
export const selectCanUndo = (state: EditorState): boolean => canUndo(state.history)
export const selectCanRedo = (state: EditorState): boolean => canRedo(state.history)
export const selectBlockAtPlayhead = (state: EditorState): Block | null =>
  blockAt(state.history.present, state.playhead)

/**
 * The block the keyboard and the block menu act on.
 *
 * Falls back to whatever sits under the playhead, so pressing Delete right after
 * scrubbing does the obvious thing instead of nothing at all.
 */
export const selectActiveBlock = (state: EditorState): Block | null => {
  const chosen = state.selectedBlock
    ? findBlock(state.history.present, state.selectedBlock)
    : null
  return chosen ?? blockAt(state.history.present, state.playhead)
}

/**
 * Whether the rails are over anything that can actually be taken out.
 *
 * False for a selection that covers only a hole, which is what disables the
 * Remove button rather than letting it record an edit that changes nothing.
 */
export const selectSelectionCovers = (state: EditorState): boolean =>
  state.selection !== null && coveredSpan(state.history.present, state.selection) !== null

/**
 * Whether anything has changed since the last save.
 *
 * Identity, not contents: the store replaces the timeline and the media array
 * wholesale on every edit, so this says exactly as much as a deep comparison
 * would and costs nothing on a render. Never saved and nothing open is not
 * unsaved work — there is nothing to lose.
 */
export const selectDirty = (state: EditorState): boolean => {
  if (state.media.length === 0) return false
  if (!state.savedMark) return true
  return state.savedMark.timeline !== state.history.present || state.savedMark.media !== state.media
}

/**
 * Whether there is anything to export.
 *
 * An empty timeline is a legitimate state — deleting the last block is how you
 * start over without closing the file — but it is not a file, so every route to
 * the export dialog reads this.
 */
export const selectCanExport = (state: EditorState): boolean =>
  state.history.present.blocks.length > 0 && state.missingMedia.length === 0

/** Whether any medium in the project has reported its cut points yet. */
export const selectHasCutPoints = (state: EditorState): boolean =>
  Object.values(state.keyframes).some((positions) => positions.length > 0)

/**
 * The file the preview should be showing, and what it should load for it.
 *
 * All three return primitives, which is what makes them safe to derive on
 * every call: identity comparison on a string or a boolean is comparison by
 * value.
 */
export const selectActiveMedia = (state: EditorState): string | null =>
  mediaAt(state.history.present, state.playhead)

export const selectPreviewUrl = (state: EditorState): string | null => {
  const media = selectActiveMedia(state)
  return media === null ? null : (state.previewUrls[media] ?? null)
}

export const selectIsProxy = (state: EditorState): boolean => {
  const media = selectActiveMedia(state)
  return media === null ? false : (state.proxies[media] ?? false)
}

/**
 * Selectors must return a value that is reference-stable between renders.
 *
 * Zustand reads state through `useSyncExternalStore`, which compares snapshots
 * by identity. A selector that derives a fresh object or array every call never
 * compares equal, so React re-renders forever and the window goes blank. Derived
 * collections are therefore computed in the component with `useMemo` over stable
 * inputs, not selected here.
 */
