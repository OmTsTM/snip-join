import { beforeEach, describe, expect, it, vi } from 'vitest'

import { span } from '@domain/time'
import { blockEnd } from '@domain/timeline'
import type { MediaSourceInfo } from '@infrastructure/tauri/api'

/**
 * The editing gestures that reach past a single block: the clipboard, the block
 * selection, and what a removal is allowed to act on.
 *
 * Driven through the store rather than the window, because every one of these
 * is a decision the store makes and the interface only reports.
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

/**
 * Two files with cut points nowhere near each other, which is what makes the
 * regression visible: `a.mp4` has none past 40 seconds, so a snap that reached
 * for the first file's list would drag every position on `b.mp4` back to 40.
 */
const KEYFRAMES: Record<string, readonly number[]> = {
  'a.mp4': [0, 10, 20, 30, 40],
  'b.mp4': [0, 5, 10, 15],
}

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
      keyframes: async (path: string) => ({
        positions: KEYFRAMES[path] ?? [],
        truncated: false,
      }),
      suggestOutputPath: async () => 'out.mp4',
      exportTimeline: async () => ({ path: 'out.mp4', duration: 0, bytes: 0 }),
      cancelJob: async () => undefined,
      initialFile: async () => null,
      finishStartup: async () => undefined,
    },
  }
})

const { useEditor, selectCanExport } = await import('./editorStore')

/**
 * Cut points arrive from a promise the store does not await, so the tests that
 * care about them wait for the microtasks it queues to drain.
 */
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

describe('the clipboard', () => {
  beforeEach(async () => {
    await useEditor.getState().closeFile()
    await openReady('a.mp4')
  })

  it('pastes what was copied at the playhead, splitting what was there', () => {
    const store = useEditor.getState()
    store.copyBlock(store.history.present.blocks[0]!.id)
    store.seek(20)
    useEditor.getState().pasteAtPlayhead()

    const blocks = useEditor.getState().history.present.blocks
    expect(blocks).toHaveLength(3)
    expect(blocks[1]!.start).toBe(20)
    expect(blocks[1]!.source).toEqual(span(0, 60))
    expect(blockEnd(blocks[1]!)).toBe(80)
  })

  it('leaves the piece behind after a cut, so it can be put somewhere else', () => {
    useEditor.getState().splitAtPlayhead()
    useEditor.getState().seek(30)
    useEditor.getState().splitAtPlayhead()

    const second = useEditor.getState().history.present.blocks[1]!
    useEditor.getState().cutBlock(second.id)

    expect(useEditor.getState().history.present.blocks).toHaveLength(1)
    expect(useEditor.getState().clipboard?.source).toEqual(second.source)

    useEditor.getState().seek(0)
    useEditor.getState().pasteAtPlayhead()

    const blocks = useEditor.getState().history.present.blocks
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.source).toEqual(second.source)
  })

  /**
   * An empty timeline is a legitimate state, not a wall. The media pool still
   * holds the files, so clearing the track is how you start over without
   * closing what you opened — and the clipboard still holds what was cut.
   */
  it('cuts the last block and leaves the timeline empty', () => {
    const only = useEditor.getState().history.present.blocks[0]!
    useEditor.getState().cutBlock(only.id)

    expect(useEditor.getState().history.present.blocks).toHaveLength(0)
    expect(selectCanExport(useEditor.getState())).toBe(false)
    expect(useEditor.getState().clipboard?.source).toEqual(only.source)

    useEditor.getState().pasteAtPlayhead()
    expect(useEditor.getState().history.present.blocks).toHaveLength(1)
    expect(selectCanExport(useEditor.getState())).toBe(true)
  })

  it('drops a piece whose file has left the project', async () => {
    await addReady('b.mp4')
    const fromB = useEditor.getState().history.present.blocks.find((b) => b.mediaId === 'b.mp4')!
    useEditor.getState().copyBlock(fromB.id)

    await useEditor.getState().removeMedium('b.mp4')
    expect(useEditor.getState().clipboard).toBeNull()

    const before = useEditor.getState().history.present.blocks.length
    useEditor.getState().pasteAtPlayhead()
    expect(useEditor.getState().history.present.blocks).toHaveLength(before)
  })
})

describe('removing what the rails cover', () => {
  beforeEach(async () => {
    await useEditor.getState().closeFile()
    await openReady('a.mp4')
    useEditor.getState().setMode('gap')
    useEditor.getState().setSelection(span(20, 30))
    useEditor.getState().removeSelection()
  })

  /**
   * A hole holds nothing. Cutting an absence takes nothing out, so the store
   * refuses rather than recording an edit that changes not one frame.
   */
  it('refuses a selection that covers only a hole', () => {
    const before = useEditor.getState().history.present
    useEditor.getState().setSelection(span(22, 28))
    useEditor.getState().removeSelection()

    expect(useEditor.getState().history.present).toBe(before)
  })

  it('still removes the footage when the rails overlap a hole', () => {
    useEditor.getState().setSelection(span(25, 35))
    useEditor.getState().removeSelection()

    const blocks = useEditor.getState().history.present.blocks
    expect(blocks.map((block) => [block.source.start, block.source.end])).toEqual([
      [0, 20],
      [35, 60],
    ])
  })

  it('refuses to lift a hole out as a block of its own', () => {
    const before = useEditor.getState().history.present
    useEditor.getState().setSelection(span(22, 28))
    useEditor.getState().liftSelection()

    expect(useEditor.getState().history.present).toBe(before)
  })
})

describe('snapping to the cut points of the right file', () => {
  beforeEach(async () => {
    await useEditor.getState().closeFile()
    await openReady('a.mp4')
    // The store is a module singleton, so the setting outlives the file: stated
    // rather than assumed, or these read whatever the last test left behind.
    useEditor.getState().setSnapToCutPoints(true)
    // Snapping reaches a fixed number of pixels, so the scale is what turns that
    // into a distance in seconds. Twelve pixels per second makes the reach
    // exactly one second, which is what these are written against.
    useEditor.getState().setPixelsPerSecond(12)
    await settle()
  })

  it('reads each medium under its own key', () => {
    expect(useEditor.getState().keyframes['a.mp4']).toEqual(KEYFRAMES['a.mp4'])
  })

  /**
   * This is the defect the per-medium table exists for. With one shared list
   * every instant past the first file's last cut point was dragged back onto
   * it, so a selection could not be marked on a second file at all.
   */
  it('snaps a position on the second file to that file, not the first', async () => {
    await addReady('b.mp4')
    await settle()

    // 65.9 seconds along the timeline is 5.9 into `b.mp4`, whose nearest cut
    // point is 5 — which lands back at 65 on the timeline.
    expect(useEditor.getState().snapToCutPoint(65.9)).toBeCloseTo(65, 6)
  })

  /**
   * Some files carry almost no cut points — an animated GIF has exactly one, at
   * the start. Pulling onto the nearest one at any distance dragged every edit
   * back to that instant: a trimmed edge collapsed the moment it was touched,
   * and a selection could only ever cover the whole block.
   */
  it('leaves a cut alone when the nearest point is out of reach', () => {
    // 25 is nine seconds past the cut point at 20 and five short of the one at
    // 30, both far outside the reach.
    expect(useEditor.getState().snapToCutPoint(25)).toBe(25)
  })

  it('reaches a point that is close, and not one that is merely nearest', () => {
    expect(useEditor.getState().snapToCutPoint(20.4)).toBeCloseTo(20, 6)
    expect(useEditor.getState().snapToCutPoint(21.5)).toBe(21.5)
  })

  /** Footage that can be cut anywhere has nothing to be pulled onto, and the
   *  list that came back is only the first of its points. */
  it('never snaps a source whose cut points were truncated', () => {
    useEditor.setState((state) => ({
      keyframesTruncated: { ...state.keyframesTruncated, 'a.mp4': true },
    }))
    expect(useEditor.getState().snapToCutPoint(20.1)).toBe(20.1)
  })

  /**
   * Cut points are positions in a file and the timeline reflows on every edit,
   * so the two coordinate systems stop agreeing at the first cut.
   */
  it('snaps through the block, not through the raw timeline position', () => {
    useEditor.getState().setSelection(span(0, 15))
    useEditor.getState().removeSelection()

    // What is left starts at source 15 and sits at timeline 0, so timeline 4.5
    // is source 19.5, whose nearest cut point is 20 — timeline 5.
    expect(useEditor.getState().snapToCutPoint(4.5)).toBeCloseTo(5, 6)
  })

  it('leaves an instant alone when it is over a hole', () => {
    useEditor.getState().setMode('gap')
    useEditor.getState().setSelection(span(20, 30))
    useEditor.getState().removeSelection()

    expect(useEditor.getState().snapToCutPoint(25)).toBe(25)
  })
})

describe('the chosen block', () => {
  beforeEach(async () => {
    await useEditor.getState().closeFile()
    await openReady('a.mp4')
    useEditor.getState().seek(20)
    useEditor.getState().splitAtPlayhead()
  })

  it('swaps places with its neighbour without changing the total', () => {
    const [first, second] = useEditor.getState().history.present.blocks
    useEditor.getState().shiftBlock(second!.id, -1)

    const blocks = useEditor.getState().history.present.blocks
    expect(blocks[0]!.id).toBe(second!.id)
    expect(blocks[1]!.id).toBe(first!.id)
    expect(useEditor.getState().selectedBlock).toBe(second!.id)
  })

  it('is forgotten when it is deleted', () => {
    const second = useEditor.getState().history.present.blocks[1]!
    useEditor.getState().selectBlock(second.id)
    useEditor.getState().deleteBlock(second.id)

    expect(useEditor.getState().selectedBlock).toBeNull()
  })
})

describe('while the file behind the timeline is still being read', () => {
  /** Tries every gesture that would record an edit. */
  const attemptEverything = () => {
    const store = useEditor.getState()
    store.seek(20)
    store.splitAtPlayhead()
    store.setSelection(span(5, 10))
    store.removeSelection()
    store.liftSelection()
    store.setMode('gap')
    store.pasteAtPlayhead()
  }

  beforeEach(async () => {
    await useEditor.getState().closeFile()
    await openReady('a.mp4')
  })

  it('refuses every edit while the project is being prepared', () => {
    const before = useEditor.getState().history.present

    // The blocks are on screen before the media behind them have been read.
    useEditor.setState({ phase: 'preparing' })
    attemptEverything()
    expect(useEditor.getState().history.present).toBe(before)

    useEditor.setState({ phase: 'ready' })
    useEditor.getState().splitAtPlayhead()
    expect(useEditor.getState().history.present.blocks).toHaveLength(2)
  })

  /**
   * The gap the lock missed at first: the preview is ready long before the
   * filmstrip is, and for those seconds the track looked busy and still took
   * a cut.
   */
  it('refuses every edit while the frames are still arriving', () => {
    const before = useEditor.getState().history.present
    expect(useEditor.getState().phase).toBe('ready')

    useEditor.setState({ pendingFrames: 1 })
    attemptEverything()
    expect(useEditor.getState().history.present).toBe(before)

    useEditor.setState({ pendingFrames: 0 })
    useEditor.getState().splitAtPlayhead()
    expect(useEditor.getState().history.present.blocks).toHaveLength(2)
  })
})
