import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fastSpec } from '@domain/export'
import type { MediaSourceInfo } from '@infrastructure/tauri/api'

/**
 * The store's side of a timeline that draws on several files.
 *
 * Driven through the store rather than through the window because the only
 * other way in is a native file picker, which no test can open. What matters
 * here is the wiring the picker would have exercised: a second file becomes a
 * block at the end, its frames and preview are fetched under its own key, and
 * the export request names every file exactly once with the clips indexing it.
 */

const opened: string[] = []
const previewed: string[] = []
const framed: string[] = []
const forgotten: string[] = []
let lastExportRequest: unknown = null

function info(path: string, duration: number): MediaSourceInfo {
  return {
    path,
    fileName: path,
    sizeBytes: 1_000_000,
    container: 'mp4',
    duration,
    maxDuration: duration,
    kind: 'motion',
    video: {
      index: 0,
      codec: 'h264',
      codecLong: 'H.264',
      width: 1920,
      height: 1080,
      rotation: 0,
      frameRate: 30,
      pixelFormat: 'yuv420p',
      bitRate: null,
      colorPrimaries: null,
      colorTransfer: null,
      colorSpace: null,
    },
    audio: {
      index: 1,
      codec: 'aac',
      codecLong: 'AAC',
      sampleRate: 48_000,
      channels: 2,
      channelLayout: 'stereo',
      bitRate: null,
    },
    playability: 'native',
  }
}

const DURATIONS: Record<string, number> = { 'a.mp4': 60, 'b.mp4': 20 }

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}))

vi.mock('@infrastructure/tauri/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/tauri/api')>()
  return {
    ...actual,
    api: {
      openMedia: async (path: string) => {
        opened.push(path)
        return info(path, DURATIONS[path] ?? 10)
      },
      closeMedia: async () => undefined,
      forgetMedia: async (path: string) => {
        forgotten.push(path)
      },
      capabilities: async () => {
        throw new Error('not needed')
      },
      preparePreview: async (path: string) => {
        previewed.push(path)
        return { path: `${path}.preview`, isProxy: false }
      },
      generateThumbnails: async (path: string) => {
        framed.push(path)
      },
      keyframes: async () => ({ positions: [], truncated: false }),
      suggestOutputPath: async () => 'out.mp4',
      exportTimeline: async (request: unknown) => {
        lastExportRequest = request
        return { path: 'out.mp4', duration: 0, bytes: 0 }
      },
      cancelJob: async () => undefined,
      initialFile: async () => null,
      finishStartup: async () => undefined,
    },
  }
})

const { useEditor } = await import('./editorStore')

/** Frames and previews land in a task or two that the store does not await. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Opens a file and waits until the timeline will accept an edit.
 *
 * Cutting is refused while the frames are still arriving, so a test that
 * edits the moment `openFile` resolves is testing the lock rather than the
 * edit it meant to. The wait is what a user does by watching the strip fill.
 */
async function openReady(path: string): Promise<void> {
  await useEditor.getState().openFile(path)
  await settle()
}

/** The same, for a file added to a project that is already open. */
async function addReady(path: string, at?: number): Promise<void> {
  await useEditor.getState().addMedia(path, at)
  await settle()
}

describe('a timeline that draws on several files', () => {
  beforeEach(async () => {
    opened.length = 0
    previewed.length = 0
    framed.length = 0
    forgotten.length = 0
    lastExportRequest = null
    await useEditor.getState().closeFile()
  })

  it('opens the first file as the whole timeline', async () => {
    await openReady('a.mp4')
    const state = useEditor.getState()

    expect(state.media.map((m) => m.path)).toEqual(['a.mp4'])
    expect(state.history.present.blocks).toHaveLength(1)
    expect(state.previewUrls['a.mp4']).toBe('asset://a.mp4.preview')
  })

  it('puts a second file after everything already there', async () => {
    await openReady('a.mp4')
    await addReady('b.mp4')

    const { media, history } = useEditor.getState()
    expect(media.map((m) => m.path)).toEqual(['a.mp4', 'b.mp4'])
    expect(history.present.blocks).toHaveLength(2)
    expect(history.present.blocks[1]!.mediaId).toBe('b.mp4')
    expect(history.present.blocks[1]!.start).toBe(60)
  })

  it('reads the preview and the frames of each file under its own key', async () => {
    await openReady('a.mp4')
    await addReady('b.mp4')

    expect(previewed).toEqual(['a.mp4', 'b.mp4'])
    expect(framed).toEqual(['a.mp4', 'b.mp4'])
    expect(useEditor.getState().previewUrls['b.mp4']).toBe('asset://b.mp4.preview')
  })

  /**
   * The same shot at the start and again at the end is a reasonable thing to
   * want, and it must not read the file twice or list it twice.
   */
  it('gives the same file a second block without a second entry', async () => {
    await openReady('a.mp4')
    await addReady('a.mp4')

    const { media, history } = useEditor.getState()
    expect(media).toHaveLength(1)
    expect(history.present.blocks).toHaveLength(2)
    expect(previewed).toEqual(['a.mp4'])
  })

  it('names every file once in the export, with the clips indexing it', async () => {
    await openReady('a.mp4')
    await addReady('b.mp4')
    await addReady('a.mp4')

    // The spec is not what this test is about; the default one will do.
    await useEditor.getState().runExport(fastSpec(), 'out.mp4')

    const request = lastExportRequest as {
      media: string[]
      clips: Array<{ media: number }>
    }
    expect(request.media).toEqual(['a.mp4', 'b.mp4'])
    expect(request.clips.map((clip) => clip.media)).toEqual([0, 1, 0])
  })

  it('drops every block of a file that is removed', async () => {
    await openReady('a.mp4')
    await addReady('b.mp4')
    await useEditor.getState().removeMedium('b.mp4')

    const { media, history } = useEditor.getState()
    expect(media.map((m) => m.path)).toEqual(['a.mp4'])
    expect(history.present.blocks).toHaveLength(1)
    expect(forgotten).toEqual(['b.mp4'])
  })

  /**
   * The first file decides the format everything else is normalised onto.
   * Losing it halfway through an edit would silently change the result.
   */
  it('refuses to remove the first file', async () => {
    await openReady('a.mp4')
    await addReady('b.mp4')
    await useEditor.getState().removeMedium('a.mp4')

    expect(useEditor.getState().media.map((m) => m.path)).toEqual(['a.mp4', 'b.mp4'])
    expect(forgotten).toEqual([])
  })
})
