import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MediaSourceInfo } from '@infrastructure/tauri/api'

/**
 * Saving a project and opening it again.
 *
 * Driven through the store because the round trip is where the two halves have
 * to agree: what the file records, and what the editor rebuilds from it. A
 * project that reopens with the right blocks and no picture is still broken, and
 * only a test that goes all the way round would notice.
 */

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
    audio: null,
    playability: 'native',
  }
}

const DURATIONS: Record<string, number> = { 'a.mp4': 60, 'b.mp4': 20 }

/** The disk, as far as these tests are concerned. */
const written = new Map<string, string>()

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}))

vi.mock('@infrastructure/tauri/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/tauri/api')>()
  return {
    ...actual,
    api: {
      openMedia: async (path: string) => info(path, DURATIONS[path] ?? 10),
      closeMedia: async () => undefined,
      forgetMedia: async () => undefined,
      capabilities: async () => {
        throw new Error('not needed')
      },
      preparePreview: async (path: string) => ({ path: `${path}.preview`, isProxy: false }),
      generateThumbnails: async () => undefined,
      keyframes: async () => ({ positions: [], truncated: false }),
      suggestOutputPath: async () => 'out.mp4',
      exportTimeline: async () => ({ path: 'out.mp4', duration: 0, bytes: 0 }),
      cancelJob: async () => undefined,
      initialFile: async () => null,
      finishStartup: async () => undefined,
      saveProject: async (path: string, contents: string) => {
        written.set(path, contents)
        return path
      },
      loadProject: async (path: string) => {
        const contents = written.get(path)
        if (!contents) throw new Error(`${path} is not there`)
        return contents
      },
      mediaExists: async () => true,
    },
  }
})

const { useEditor, selectPreviewUrl } = await import('./editorStore')

/** Previews that are not awaited still land in a microtask or two. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('opening a project that was saved', () => {
  beforeEach(async () => {
    written.clear()
    await useEditor.getState().closeFile()
  })

  it('brings the picture back with the edit', async () => {
    await useEditor.getState().openFile('a.mp4')
    useEditor.getState().seek(20)
    useEditor.getState().splitAtPlayhead()
    expect(await useEditor.getState().saveProject('edit.snipjoin')).toBe(true)

    await useEditor.getState().closeFile()
    await useEditor.getState().openProject('edit.snipjoin')

    const state = useEditor.getState()
    expect(state.phase).toBe('ready')
    expect(state.history.present.blocks).toHaveLength(2)
    expect(selectPreviewUrl(state)).toBe('asset://a.mp4.preview')
  })

  /**
   * The regression this was written for: only the first medium was prepared, so
   * a project drawing on two files reopened with a picture at the start and a
   * blank player from the moment the playhead reached the second one.
   */
  it('prepares every medium, not only the first', async () => {
    await useEditor.getState().openFile('a.mp4')
    await useEditor.getState().addMedia('b.mp4')
    expect(await useEditor.getState().saveProject('two.snipjoin')).toBe(true)

    await useEditor.getState().closeFile()
    await useEditor.getState().openProject('two.snipjoin')
    await settle()

    // On the second medium's block, which is where the blank player was.
    useEditor.getState().seek(70)
    expect(selectPreviewUrl(useEditor.getState())).toBe('asset://b.mp4.preview')
  })

  it('remembers where the project was saved, so the next save asks nothing', async () => {
    await useEditor.getState().openFile('a.mp4')
    await useEditor.getState().saveProject('edit.snipjoin')
    await useEditor.getState().closeFile()
    await useEditor.getState().openProject('edit.snipjoin')

    expect(useEditor.getState().projectPath).toBe('edit.snipjoin')
    useEditor.getState().seek(10)
    useEditor.getState().splitAtPlayhead()
    expect(await useEditor.getState().saveProject()).toBe(true)
  })
})
