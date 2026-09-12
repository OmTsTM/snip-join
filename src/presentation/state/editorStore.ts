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
import { nearestKeyframe } from '@domain/lossless'
import {
  clampDockHeight,
  MIN_DOCK_HEIGHT,
} from '@presentation/features/timeline/dockSize'
import { clamp, snapToFrame, span, type Span } from '@domain/time'
import {
  appendMedium,
  blockAt,
  mediaAt,
  createTimeline,
  isolateSpan,
  mediaOrder,
  keptDuration,
  moveBlock as moveBlockIn,
  removeBlock as removeBlockIn,
  removeSpan,
  setMode as setModeIn,
  splitAt,
  totalDuration,
  trimBlock as trimBlockIn,
  withBlocks,
  type BlockId,
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
   * Positions a stream copy can cut at, for the first medium.
   *
   * Only the first: a timeline reading from several files cannot be copied at
   * all, so cut points for the others would describe an export that is not on
   * offer. The export dialog says as much rather than showing positions that
   * cannot be honoured.
   *
   * Held here rather than derived because reading them costs a process launch,
   * and because both the timeline and the export dialog need the same answer.
   */
  keyframes: readonly number[]
  keyframesTruncated: boolean

  /**
   * Whether cuts are pulled onto the nearest cut point.
   *
   * On by default because the default export copies the streams, and a copy can
   * only begin on a cut point. With this off a cut can be placed on any frame,
   * which only a re-encoding export can honour.
   */
  snapToCutPoints: boolean

  /**
   * Height of the timeline dock in pixels.
   *
   * Lives in the store rather than in a component because the divider, the dock
   * and every block on it have to agree on one number, and because it outlives
   * the video that happens to be open.
   */
  timelineHeight: number

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
  addMedia: (path: string) => Promise<void>
  removeMedium: (mediaId: string) => Promise<void>
  closeFile: () => Promise<void>

  setSelection: (selection: Span | null) => void
  /** Pulls an instant onto the nearest cut point while snapping is on. */
  snapToCutPoint: (at: number) => number
  setSnapToCutPoints: (enabled: boolean) => void
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
  keyframes: [],
  keyframesTruncated: false,
  snapToCutPoints: true,
  timelineHeight: readStoredDockHeight(),

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
        keyframes: [],
        keyframesTruncated: false,
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

      // Cut points decide whether a copy is exact, so they are read as soon as
      // the editor is usable. Not awaited: the timeline works without them and
      // simply gains snapping when they land. Only for the first file: a
      // timeline spanning several cannot be copied at all.
      void api
        .keyframes(source.path)
        .then((report) => {
          if (get().mediaToken !== token) return
          set({ keyframes: report.positions, keyframesTruncated: report.truncated })
        })
        .catch(() => undefined)
    } catch (error) {
      if (get().mediaToken !== token) return
      set({ phase: 'empty', source: null, media: [] })
      get().reportError(error)
    }
  },

  /**
   * Adds another file and puts the whole of it after everything already there.
   *
   * Appended rather than placed: where it belongs is the user's business, and
   * every gesture for moving a block already exists.
   */
  async addMedia(path) {
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

      set((state) => ({
        media: known ? state.media : [...state.media, source],
        history: record(
          state.history,
          appendMedium(state.history.present, source.path, source.duration),
        ),
      }))

      if (known) return

        await loadPreview(source, token)
      loadFrames(source, token)
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
      delete previewUrls[mediaId]
      delete proxies[mediaId]
      delete thumbnails[mediaId]

      return {
        media: state.media.filter((medium) => medium.path !== mediaId),
        previewUrls,
        proxies,
        thumbnails,
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
      keyframes: [],
      keyframesTruncated: false,
      exportJob: null,
      lastExport: null,
      mediaToken: '',
    })
  },

  snapToCutPoint(at) {
    const { snapToCutPoints, keyframes } = get()
    if (!snapToCutPoints) return at

    // The nearest one, at any distance. A threshold would make snapping useless
    // on the very footage that needs it most: long groups of pictures put the
    // cut points far apart, and those are exactly the cuts that drift.
    return nearestKeyframe(keyframes, at) ?? at
  },

  setSnapToCutPoints(enabled) {
    set({ snapToCutPoints: enabled })
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

    const next = removeSpan(history.present, selection)
    // Everything removed would leave nothing to export, which is never what the
    // user meant by "remove this part".
    if (next.blocks.length === 0) return

    const total = totalDuration(next)
    set({
      history: record(history, next),
      selection: null,
      playhead: clamp(selection.start, 0, total),
    })
  },

  liftSelection() {
    const { selection, history } = get()
    if (!selection) return

    const { timeline } = isolateSpan(history.present, selection)
    set({ history: record(history, timeline), selection: null })
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
    const { history, source } = get()
    if (!source) return

    const next = trimBlockIn(history.present, id, edge, at, source.duration)
    if (next === history.present) return

    set({ history: gestureOpen ? amend(history, next) : record(history, next) })
    gestureOpen = true
  },

  deleteBlock(id) {
    const { history } = get()
    if (history.present.blocks.length <= 1) return

    const next = removeBlockIn(history.present, id)
    set({
      history: record(history, next),
      playhead: clamp(get().playhead, 0, totalDuration(next)),
    })
  },

  undo() {
    if (!canUndo(get().history)) return
    const history = undoHistory(get().history)
    set({ history, playhead: clamp(get().playhead, 0, totalDuration(history.present)), selection: null })
  },

  redo() {
    if (!canRedo(get().history)) return
    const history = redoHistory(get().history)
    set({ history, playhead: clamp(get().playhead, 0, totalDuration(history.present)), selection: null })
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
    const { history, source } = get()
    if (!source) return

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
export const selectBlockAtPlayhead = (state: EditorState) =>
  blockAt(state.history.present, state.playhead)

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
