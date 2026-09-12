import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { ExportSpec, UpscaleAlgorithm, EncoderBackend, ExportMode } from '@domain/export'

/**
 * The only place the renderer talks to the backend.
 *
 * Every command is wrapped in a typed function so the rest of the application
 * never handles a raw command name or an untyped payload, and so a backend
 * rename breaks the build in one file rather than silently at run time.
 */

export interface VideoStreamInfo {
  readonly index: number
  readonly codec: string
  readonly codecLong: string
  readonly width: number
  readonly height: number
  readonly rotation: number
  readonly frameRate: number
  readonly pixelFormat: string
  readonly bitRate: number | null
  readonly colorPrimaries: string | null
  readonly colorTransfer: string | null
  readonly colorSpace: string | null
}

export interface AudioStreamInfo {
  readonly index: number
  readonly codec: string
  readonly codecLong: string
  readonly sampleRate: number
  readonly channels: number
  readonly channelLayout: string | null
  readonly bitRate: number | null
}

export interface MediaSourceInfo {
  readonly path: string
  readonly fileName: string
  readonly sizeBytes: number
  readonly container: string
  /** How long a block of this medium is when it first lands on the timeline. */
  readonly duration: number
  /**
   * The longest a block of this medium may be trimmed to.
   *
   * The same as `duration` for moving pictures. A still has no length of its
   * own, so this is how far its one frame may be stretched — and the length its
   * preview copy was built at, so scrubbing cannot run past the picture.
   */
  readonly maxDuration: number
  /** `still` is a single frame: an image, or a one-frame video file. */
  readonly kind: 'motion' | 'still'
  readonly video: VideoStreamInfo | null
  readonly audio: AudioStreamInfo | null
  readonly playability: 'native' | 'needsProxy'
}

export interface Capabilities {
  readonly encoders: readonly string[]
  readonly filters: readonly string[]
  readonly hardwareBackends: readonly EncoderBackend[]
  readonly upscalers: readonly UpscaleAlgorithm[]
}

export interface PreviewSource {
  readonly path: string
  readonly isProxy: boolean
}

export interface ExportOutcome {
  readonly outputPath: string
  readonly duration: number
  readonly sizeBytes: number
  readonly mode: ExportMode
}

export interface ClipPayload {
  /** Index into the request's media table. */
  readonly media: number
  readonly sourceStart: number
  readonly sourceEnd: number
  readonly timelineStart: number
}

export interface KeyframeReport {
  readonly positions: readonly number[]
  readonly truncated: boolean
}

export interface JobProgress {
  readonly jobId: string
  readonly progress: number
}

export interface ThumbnailPayload {
  readonly token: string
  /** The file the frame came from. Two can be read at once. */
  readonly media: string
  readonly index: number
  readonly at: number
  readonly dataUrl: string
}

/** A failure that crossed the IPC boundary, carrying a translatable code. */
export class BackendError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

/**
 * Normalises whatever a rejected command threw into a `BackendError`.
 *
 * Commands reject with the structured payload the Rust error serialises to, but
 * a transport failure rejects with a plain string, so both shapes are handled.
 */
function toBackendError(error: unknown): BackendError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const payload = error as { code: unknown; message: unknown }
    return new BackendError(String(payload.code), String(payload.message))
  }
  return new BackendError('internal', typeof error === 'string' ? error : 'Something went wrong.')
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw toBackendError(error)
  }
}

/** How this copy is replaced: by its installer, or by unzipping an archive. */
export type InstallKind = 'installer' | 'portable'

export interface UpdateRelease {
  readonly version: string
  readonly tag: string
  readonly assetName: string
  readonly assetUrl: string
  readonly assetSize: number
  /** Where the signature over that file is published. */
  readonly signatureUrl: string
}

/**
 * What the update check found.
 *
 * `newer` is absent whenever there is nothing to do — the newest release is the
 * one running, there are no releases yet, or the newest one carries nothing this
 * copy could install. The three are the same answer from where the user sits.
 */
export interface UpdateReport {
  readonly current: string
  readonly kind: InstallKind
  readonly newer: UpdateRelease | null
}

export interface UpdateProgress {
  readonly received: number
  readonly total: number
}

export const api = {
  openMedia: (path: string) => call<MediaSourceInfo>('open_media', { path }),

  closeMedia: () => call<void>('close_media'),

  /** Drops one file from the pool, leaving the rest of the project alone. */
  forgetMedia: (path: string) => call<void>('forget_media', { path }),

  capabilities: () => call<Capabilities>('encoder_capabilities'),

  preparePreview: (path: string, jobId: string) =>
    call<PreviewSource>('prepare_preview', { path, jobId }),

  generateThumbnails: (path: string, count: number, token: string) =>
    call<void>('generate_thumbnails', { path, count, token }),

  suggestOutputPath: (extension?: string) =>
    call<string>('suggest_output_path', { extension: extension ?? null }),

  exportTimeline: (request: {
    jobId: string
    outputPath: string
    /** Every file the timeline reads from, in the order the clips index it. */
    media: readonly string[]
    clips: readonly ClipPayload[]
    spec: ExportSpec
  }) => call<ExportOutcome>('export_timeline', { request }),

  cancelJob: (jobId: string) => call<void>('cancel_job', { jobId }),

  initialFile: () => call<string | null>('initial_file'),

  /** Reports that the editor has painted, so the splash can be swapped for it. */
  finishStartup: () => call<void>('finish_startup'),

  keyframes: (path: string) => call<KeyframeReport>('keyframe_positions', { path }),

  /**
   * Writes a project file and answers with the path it actually landed at.
   *
   * The renderer has no filesystem capability of its own, so every byte it wants
   * on disk goes through the backend — which is also where the path is checked.
   */
  saveProject: (path: string, contents: string) =>
    call<string>('save_project', { path, contents }),

  loadProject: (path: string) => call<string>('load_project', { path }),

  /** Whether a path still points at a readable file. */
  mediaExists: (path: string) => call<boolean>('media_exists', { path }),

  /**
   * Asks GitHub whether a newer Snip Join has been published.
   *
   * The renderer has no HTTP capability, which is the point: the request is made
   * by the backend, to one address, and only when this is called.
   */
  checkForUpdate: () => call<UpdateReport>('check_for_update'),

  /**
   * Fetches the update into the downloads folder, answering with its path.
   *
   * It only gets a path if the signature over its bytes checks out against the
   * key built into the binary; an update that fails that is deleted, not
   * offered.
   */
  downloadUpdate: (url: string, name: string, signatureUrl: string) =>
    call<string>('download_update', { url, name, signatureUrl }),

  /**
   * Hands the downloaded file over: runs the installer and closes Snip Join, or
   * shows the archive in Explorer for a portable copy.
   */
  applyUpdate: (path: string, version: string) =>
    call<void>('apply_update', { path, version }),
} as const

/** Event topics, matching `src-tauri/src/interface/events.rs`. */
export const EVENTS = {
  exportProgress: 'snipjoin://export-progress',
  proxyProgress: 'snipjoin://proxy-progress',
  thumbnailReady: 'snipjoin://thumbnail-ready',
  updateProgress: 'snipjoin://update-progress',
} as const

/**
 * Subscribes to a backend event.
 *
 * Returns the unsubscribe function synchronously usable in a cleanup, and
 * unsubscribes immediately if the caller already cleaned up before the
 * subscription finished registering. Without that guard a component that
 * unmounts quickly leaks a listener for the lifetime of the window.
 */
export function subscribe<T>(topic: string, handler: (payload: T) => void): () => void {
  let cancelled = false
  let unlisten: UnlistenFn | null = null

  void listen<T>(topic, (event) => handler(event.payload)).then((fn) => {
    if (cancelled) {
      fn()
      return
    }
    unlisten = fn
  })

  return () => {
    cancelled = true
    unlisten?.()
    unlisten = null
  }
}
