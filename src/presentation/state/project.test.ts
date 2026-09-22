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

/** Media that have gone missing between a save and the open that follows. */
const gone = new Set<string>()

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}))

vi.mock('@infrastructure/tauri/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/tauri/api')>()
  return {
    ...actual,
    api: {
      openMedia: async (path: string) => {
        if (gone.has(path)) throw new Error(`${path} is not there`)
        return info(path, DURATIONS[path] ?? 10)
      },
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

const { useEditor, selectCanExport, selectDirty, selectPreviewUrl } = await import('./editorStore')

/** Previews that are not awaited still land in a microtask or two. */
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

describe('opening a project that was saved', () => {
  beforeEach(async () => {
    written.clear()
    await useEditor.getState().closeFile()
  })

  it('brings the picture back with the edit', async () => {
    await openReady('a.mp4')
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
    await openReady('a.mp4')
    await addReady('b.mp4')
    expect(await useEditor.getState().saveProject('two.snipjoin')).toBe(true)

    await useEditor.getState().closeFile()
    await useEditor.getState().openProject('two.snipjoin')
    await settle()

    // On the second medium's block, which is where the blank player was.
    useEditor.getState().seek(70)
    expect(selectPreviewUrl(useEditor.getState())).toBe('asset://b.mp4.preview')
  })

  it('remembers where the project was saved, so the next save asks nothing', async () => {
    await openReady('a.mp4')
    await useEditor.getState().saveProject('edit.snipjoin')
    await useEditor.getState().closeFile()
    await useEditor.getState().openProject('edit.snipjoin')

    expect(useEditor.getState().projectPath).toBe('edit.snipjoin')
    useEditor.getState().seek(10)
    useEditor.getState().splitAtPlayhead()
    expect(await useEditor.getState().saveProject()).toBe(true)
  })
})

describe('opening a project whose files have moved', () => {
  beforeEach(async () => {
    written.clear()
    gone.clear()
    await useEditor.getState().closeFile()
  })

  /**
   * The ordinary shape of a broken project: one video, and it moved. Refusing
   * to open it left an error about a path and nothing to repair. Now the edit
   * opens with its blocks kept, the pool names the file that is gone, and
   * saying where it went brings the picture back.
   */
  it('opens with every file missing rather than refusing', async () => {
    await openReady('a.mp4')
    useEditor.getState().seek(20)
    useEditor.getState().splitAtPlayhead()
    expect(await useEditor.getState().saveProject('moved.snipjoin')).toBe(true)
    await useEditor.getState().closeFile()

    gone.add('a.mp4')
    await useEditor.getState().openProject('moved.snipjoin')

    const state = useEditor.getState()
    expect(state.phase).toBe('ready')
    expect(state.source).toBeNull()
    expect(state.missingMedia).toEqual(['a.mp4'])
    expect(state.history.present.blocks).toHaveLength(2)
    expect(selectCanExport(state)).toBe(false)

    gone.clear()
    await useEditor.getState().locateMedium('a.mp4', 'a.mp4')
    await settle()

    const repaired = useEditor.getState()
    expect(repaired.source?.path).toBe('a.mp4')
    expect(repaired.missingMedia).toEqual([])
    expect(repaired.history.present.blocks).toHaveLength(2)
    expect(selectCanExport(repaired)).toBe(true)
    expect(selectPreviewUrl(repaired)).toBe('asset://a.mp4.preview')
  })
})

describe('what counts as unsaved work', () => {
  beforeEach(async () => {
    written.clear()
    gone.clear()
    await useEditor.getState().closeFile()
  })

  /**
   * The save button wears a dot while there is something to write, and it wore
   * one the moment a video finished opening — before a single cut had been
   * made. A file nobody has touched is the file that is already on disk.
   */
  it('does not call a freshly opened video unsaved', async () => {
    await openReady('a.mp4')

    expect(useEditor.getState().phase).toBe('ready')
    expect(selectDirty(useEditor.getState())).toBe(false)
  })

  it('calls it unsaved from the first edit, and clean again once written', async () => {
    await openReady('a.mp4')
    useEditor.getState().seek(20)
    useEditor.getState().splitAtPlayhead()
    expect(selectDirty(useEditor.getState())).toBe(true)

    expect(await useEditor.getState().saveProject('edit.snipjoin')).toBe(true)
    expect(selectDirty(useEditor.getState())).toBe(false)
  })

  /** A second file is a change to the project, whatever was done to it. */
  it('calls adding a file unsaved', async () => {
    await openReady('a.mp4')
    expect(selectDirty(useEditor.getState())).toBe(false)

    await addReady('b.mp4')
    expect(selectDirty(useEditor.getState())).toBe(true)
  })

  it('does not call a reopened project unsaved either', async () => {
    await openReady('a.mp4')
    useEditor.getState().seek(20)
    useEditor.getState().splitAtPlayhead()
    await useEditor.getState().saveProject('edit.snipjoin')
    await useEditor.getState().closeFile()

    await useEditor.getState().openProject('edit.snipjoin')
    await settle()

    expect(selectDirty(useEditor.getState())).toBe(false)
  })

  it('has nothing to lose with nothing open', () => {
    expect(selectDirty(useEditor.getState())).toBe(false)
  })
})
