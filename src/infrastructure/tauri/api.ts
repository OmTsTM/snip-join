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
  readonly duration: number
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

export const api = {
  openMedia: (path: string) => call<MediaSourceInfo>('open_media', { path }),

  closeMedia: () => call<void>('close_media'),

  capabilities: () => call<Capabilities>('encoder_capabilities'),

  preparePreview: (jobId: string) => call<PreviewSource>('prepare_preview', { jobId }),

  generateThumbnails: (count: number, token: string) =>
    call<void>('generate_thumbnails', { count, token }),

  suggestOutputPath: (extension?: string) =>
    call<string>('suggest_output_path', { extension: extension ?? null }),

  exportTimeline: (request: {
    jobId: string
    outputPath: string
    clips: readonly ClipPayload[]
    spec: ExportSpec
  }) => call<ExportOutcome>('export_timeline', { request }),

  cancelJob: (jobId: string) => call<void>('cancel_job', { jobId }),

  initialFile: () => call<string | null>('initial_file'),

  keyframes: () => call<KeyframeReport>('keyframe_positions'),
} as const

/** Event topics, matching `src-tauri/src/interface/events.rs`. */
export const EVENTS = {
  exportProgress: 'snipjoin://export-progress',
  proxyProgress: 'snipjoin://proxy-progress',
  thumbnailReady: 'snipjoin://thumbnail-ready',
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
