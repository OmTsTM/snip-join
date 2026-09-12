import { describe, expect, it } from 'vitest'

import { overlaps, span } from './time'
import {
  appendMedium,
  blockAt,
  blockEnd,
  blockSpan,
  coveredSpan,
  createTimeline,
  duplicateBlock,
  gaps,
  isContiguous,
  insertClip,
  isolateSpan,
  keptDuration,
  mediaAt,
  mediaOrder,
  moveBlock,
  removeBlock,
  removeSpan,
  setMode,
  shiftBlock,
  sourceAt,
  spansMultipleMedia,
  splitAt,
  totalDuration,
  trimBlock,
  withBlocks,
  type Timeline,
} from './timeline'

/** A one-minute clip, whole, with holes closed. */
const fresh = (mode: 'join' | 'gap' = 'join') => createTimeline(MEDIA, 60, mode)

/** The one file most of these tests work with. */
const MEDIA = 'a.mp4'

const layout = (timeline: Timeline) =>
  timeline.blocks.map((block) => ({
    start: Number(block.start.toFixed(3)),
    source: [Number(block.source.start.toFixed(3)), Number(block.source.end.toFixed(3))],
  }))

describe('a freshly opened video', () => {
  it('is a single block covering everything', () => {
    const timeline = fresh()
    expect(timeline.blocks).toHaveLength(1)
    expect(totalDuration(timeline)).toBe(60)
    expect(isContiguous(timeline)).toBe(true)
  })
})

describe('removing a stretch with the ends joined', () => {
  it('closes the hole and shortens the result', () => {
    const timeline = removeSpan(fresh('join'), span(20, 30))

    expect(layout(timeline)).toEqual([
      { start: 0, source: [0, 20] },
      { start: 20, source: [30, 60] },
    ])
    expect(totalDuration(timeline)).toBe(50)
    expect(isContiguous(timeline)).toBe(true)
  })

  it('numbers the pieces in the order they play', () => {
    const timeline = removeSpan(removeSpan(fresh('join'), span(40, 45)), span(10, 15))
    expect(timeline.blocks.map((b) => b.start)).toEqual([0, 10, 35])
  })

  it('drops a block that is removed entirely', () => {
    const split = splitAt(fresh('join'), 30)
    const timeline = removeSpan(split, span(0, 30))

    expect(timeline.blocks).toHaveLength(1)
    expect(layout(timeline)).toEqual([{ start: 0, source: [30, 60] }])
  })
})

describe('removing a stretch with the hole left in place', () => {
  it('leaves a hole and keeps the original length', () => {
    const timeline = removeSpan(fresh('gap'), span(20, 30))

    expect(layout(timeline)).toEqual([
      { start: 0, source: [0, 20] },
      { start: 30, source: [30, 60] },
    ])
    expect(totalDuration(timeline)).toBe(60)
    expect(gaps(timeline)).toEqual([{ start: 20, end: 30 }])
  })

  it('leaves a hole on each side when the middle is taken twice', () => {
    const timeline = removeSpan(removeSpan(fresh('gap'), span(10, 20)), span(35, 45))

    expect(gaps(timeline)).toEqual([
      { start: 10, end: 20 },
      { start: 35, end: 45 },
    ])
  })

  it('reports nothing under the playhead inside a hole', () => {
    const timeline = removeSpan(fresh('gap'), span(20, 30))
    expect(sourceAt(timeline, 25)).toBeNull()
    expect(blockAt(timeline, 25)).toBeNull()
    expect(sourceAt(timeline, 35)).toBe(35)
  })
})

describe('switching between joining and leaving holes', () => {
  it('closes existing holes when joining is turned on', () => {
    const withHole = removeSpan(fresh('gap'), span(20, 30))
    const joined = setMode(withHole, 'join')

    expect(isContiguous(joined)).toBe(true)
    expect(totalDuration(joined)).toBe(50)
  })

  it('keeps the current layout when joining is turned off', () => {
    const joined = removeSpan(fresh('join'), span(20, 30))
    const relaxed = setMode(joined, 'gap')

    expect(layout(relaxed)).toEqual(layout(joined))
    expect(gaps(relaxed)).toHaveLength(0)
  })
})

describe('splitting', () => {
  it('turns one block into two that still play back to back', () => {
    const timeline = splitAt(fresh('join'), 25)

    expect(layout(timeline)).toEqual([
      { start: 0, source: [0, 25] },
      { start: 25, source: [25, 60] },
    ])
    expect(totalDuration(timeline)).toBe(60)
  })

  it('refuses to make a zero-length piece at an existing seam', () => {
    const once = splitAt(fresh('join'), 25)
    expect(splitAt(once, 25).blocks).toHaveLength(2)
    expect(splitAt(once, 0).blocks).toHaveLength(2)
  })
})

describe('lifting a stretch out so it can be moved', () => {
  it('makes the stretch its own block without deleting anything', () => {
    const { timeline, isolated } = isolateSpan(fresh('join'), span(20, 30))

    expect(timeline.blocks).toHaveLength(3)
    expect(totalDuration(timeline)).toBe(60)
    expect(isolated).not.toBeNull()

    const lifted = timeline.blocks.find((b) => b.id === isolated)
    expect(lifted?.source).toEqual({ start: 20, end: 30 })
  })

  it('lets the lifted piece be dragged to the front', () => {
    const { timeline, isolated } = isolateSpan(fresh('join'), span(20, 30))
    const moved = moveBlock(timeline, isolated!, 0)

    expect(moved.blocks[0]?.source).toEqual({ start: 20, end: 30 })
    expect(totalDuration(moved)).toBe(60)
    expect(isContiguous(moved)).toBe(true)
  })
})

describe('moving a block with the ends joined', () => {
  it('reorders the running order instead of leaving a hole', () => {
    const timeline = splitAt(splitAt(fresh('join'), 20), 40)
    const last = timeline.blocks[2]!

    const moved = moveBlock(timeline, last.id, 0)

    expect(moved.blocks.map((b) => b.source.start)).toEqual([40, 0, 20])
    expect(isContiguous(moved)).toBe(true)
    expect(totalDuration(moved)).toBe(60)
  })

  it('keeps the total length no matter where a block is dropped', () => {
    const timeline = splitAt(splitAt(fresh('join'), 20), 40)
    for (const target of [-10, 0, 5, 25, 55, 200]) {
      const moved = moveBlock(timeline, timeline.blocks[0]!.id, target)
      expect(totalDuration(moved)).toBe(60)
      expect(moved.blocks).toHaveLength(3)
    }
  })
})

describe('moving a block with holes allowed', () => {
  it('lands exactly where it was dropped', () => {
    const timeline = removeSpan(fresh('gap'), span(10, 60))
    const moved = moveBlock(timeline, timeline.blocks[0]!.id, 25)

    expect(moved.blocks[0]?.start).toBe(25)
    expect(gaps(moved)).toEqual([{ start: 0, end: 25 }])
  })

  it('never lets two blocks overlap', () => {
    const timeline = removeSpan(fresh('gap'), span(20, 30))
    const second = timeline.blocks[1]!

    // Dropped on top of the first block, which occupies 0 to 20.
    const moved = moveBlock(timeline, second.id, 5)
    const moving = moved.blocks.find((b) => b.id === second.id)!

    expect(moving.start).toBeGreaterThanOrEqual(20 - 1e-6)
    expect(moved.blocks.every((b, i) => i === 0 || b.start >= blockEnd(moved.blocks[i - 1]!) - 1e-6)).toBe(true)
  })

  it('cannot be dragged before the start', () => {
    const timeline = removeSpan(fresh('gap'), span(0, 10))
    const moved = moveBlock(timeline, timeline.blocks[0]!.id, -50)
    expect(moved.blocks[0]?.start).toBe(0)
  })
})

describe('trimming a block edge', () => {
  it('reveals more source without moving the far edge', () => {
    const timeline = removeSpan(fresh('gap'), span(0, 20))
    const block = timeline.blocks[0]!

    const trimmed = trimBlock(timeline, block.id, 'end', 40, 60)
    const result = trimmed.blocks[0]!

    expect(result.start).toBe(20)
    expect(result.source).toEqual({ start: 20, end: 40 })
  })

  it('cannot be trimmed past the other edge', () => {
    const timeline = fresh('gap')
    const block = timeline.blocks[0]!

    const collapsed = trimBlock(timeline, block.id, 'end', -5, 60)
    expect(blockEnd(collapsed.blocks[0]!)).toBeGreaterThan(collapsed.blocks[0]!.start)
  })

  it('cannot trim beyond the end of the source', () => {
    const timeline = fresh('gap')
    const trimmed = trimBlock(timeline, timeline.blocks[0]!.id, 'end', 500, 60)
    expect(trimmed.blocks[0]?.source.end).toBe(60)
  })
})

describe('deleting a block outright', () => {
  it('closes up behind it when the ends are joined', () => {
    const timeline = splitAt(splitAt(fresh('join'), 20), 40)
    const without = removeBlock(timeline, timeline.blocks[1]!.id)

    expect(without.blocks).toHaveLength(2)
    expect(totalDuration(without)).toBe(40)
    expect(isContiguous(without)).toBe(true)
  })

  it('leaves a hole when holes are allowed', () => {
    const timeline = splitAt(splitAt(fresh('gap'), 20), 40)
    const without = removeBlock(timeline, timeline.blocks[1]!.id)

    expect(gaps(without)).toEqual([{ start: 20, end: 40 }])
    expect(totalDuration(without)).toBe(60)
  })
})

describe('how much of the original survives', () => {
  it('adds up the source each block still covers', () => {
    const timeline = removeSpan(removeSpan(fresh('join'), span(10, 20)), span(30, 35))
    expect(keptDuration(timeline)).toBe(45)
  })

  it('ignores holes, which hold no source at all', () => {
    const timeline = removeSpan(fresh('gap'), span(20, 30))
    expect(keptDuration(timeline)).toBe(50)
    expect(totalDuration(timeline)).toBe(60)
  })
})

describe('several media on one timeline', () => {
  const SECOND = 'b.mp4'

  it('appends a whole medium after everything already there', () => {
    const timeline = appendMedium(fresh(), SECOND, 20)

    expect(timeline.blocks).toHaveLength(2)
    expect(timeline.blocks[1]!.mediaId).toBe(SECOND)
    expect(timeline.blocks[1]!.start).toBe(60)
    expect(totalDuration(timeline)).toBe(80)
  })

  it('reports one file as one file', () => {
    expect(spansMultipleMedia(fresh())).toBe(false)
    expect(mediaOrder(fresh())).toEqual([MEDIA])
  })

  it('reports a second file, in the order it is first reached for', () => {
    const timeline = appendMedium(fresh(), SECOND, 20)

    expect(spansMultipleMedia(timeline)).toBe(true)
    expect(mediaOrder(timeline)).toEqual([MEDIA, SECOND])
  })

  it('names the same file once however many blocks read from it', () => {
    const timeline = appendMedium(appendMedium(fresh(), SECOND, 20), MEDIA, 60)

    expect(timeline.blocks).toHaveLength(3)
    expect(mediaOrder(timeline)).toEqual([MEDIA, SECOND])
  })

  it('keeps the medium when a block is split', () => {
    const timeline = splitAt(appendMedium(fresh(), SECOND, 20), 70)

    expect(timeline.blocks.map((block) => block.mediaId)).toEqual([MEDIA, SECOND, SECOND])
  })

  it('keeps the medium when a stretch is removed from the middle', () => {
    const timeline = removeSpan(appendMedium(fresh(), SECOND, 20), span(65, 70))

    expect(timeline.blocks.map((block) => block.mediaId)).toEqual([MEDIA, SECOND, SECOND])
  })

  it('drops every block of a medium that is removed', () => {
    const timeline = appendMedium(fresh(), SECOND, 20)
    const left = withBlocks(
      timeline,
      timeline.blocks.filter((block) => block.mediaId !== SECOND),
    )

    expect(left.blocks).toHaveLength(1)
    expect(spansMultipleMedia(left)).toBe(false)
  })

  /**
   * Answering with nothing inside a hole unmounts the video element, which
   * reloads the file and stalls on the far side of the hole.
   */
  it('answers with the piece before it when the playhead is in a hole', () => {
    const withHole = removeSpan(setMode(fresh(), 'gap'), span(20, 30))

    expect(mediaAt(withHole, 10)).toBe(MEDIA)
    expect(mediaAt(withHole, 25)).toBe(MEDIA)
  })
})

describe('what a selection actually covers', () => {
  /** Two ten-second pieces with a ten-second hole between them. */
  const holed = () => removeSpan(createTimeline(MEDIA, 30, 'gap'), span(10, 20))

  it('narrows a range to the material under it', () => {
    expect(coveredSpan(holed(), span(5, 25))).toEqual(span(5, 25))
    expect(coveredSpan(holed(), span(5, 15))).toEqual(span(5, 10))
    expect(coveredSpan(holed(), span(15, 25))).toEqual(span(20, 25))
  })

  /**
   * The rails can be dragged across a hole, and a hole holds nothing. Removing
   * one is removing an absence, which is what this answer lets the interface
   * refuse rather than record an edit that changes nothing.
   */
  it('reports nothing for a range entirely inside a hole', () => {
    expect(coveredSpan(holed(), span(12, 18))).toBeNull()
  })

  it('reports nothing for a range past the end', () => {
    expect(coveredSpan(fresh(), span(80, 90))).toBeNull()
  })
})

describe('putting a piece back on the timeline', () => {
  it('lands at the playhead, splitting what was there, with the ends joined', () => {
    const { timeline, inserted } = insertClip(
      fresh('join'),
      { mediaId: 'b.mp4', source: span(0, 5) },
      20,
    )

    expect(layout(timeline)).toEqual([
      { start: 0, source: [0, 20] },
      { start: 20, source: [0, 5] },
      { start: 25, source: [20, 60] },
    ])
    expect(inserted).not.toBeNull()
    expect(totalDuration(timeline)).toBe(65)
  })

  it('lands in a hole when holes are allowed', () => {
    const holed = removeSpan(createTimeline(MEDIA, 30, 'gap'), span(10, 20))
    const { timeline } = insertClip(holed, { mediaId: 'b.mp4', source: span(0, 4) }, 12)

    expect(layout(timeline)).toEqual([
      { start: 0, source: [0, 10] },
      { start: 12, source: [0, 4] },
      { start: 20, source: [20, 30] },
    ])
  })

  it('never lets a pasted piece overlap what is already there', () => {
    const timeline = createTimeline(MEDIA, 30, 'gap')
    const { timeline: next } = insertClip(timeline, { mediaId: 'b.mp4', source: span(0, 4) }, 10)

    expect(next.blocks).toHaveLength(2)
    expect(next.blocks[1]!.start).toBe(30)
  })

  it('puts a duplicate directly after the block it came from', () => {
    const { timeline } = duplicateBlock(fresh('join'), fresh('join').blocks[0]!.id)
    // The ids differ per call, so this one duplicates a block of its own.
    expect(timeline.blocks).toHaveLength(1)

    const original = fresh('join')
    const { timeline: doubled } = duplicateBlock(original, original.blocks[0]!.id)
    expect(layout(doubled)).toEqual([
      { start: 0, source: [0, 60] },
      { start: 60, source: [0, 60] },
    ])
  })
})

describe('swapping a block with the one beside it', () => {
  const three = () => splitAt(splitAt(fresh('join'), 20), 40)

  it('changes the running order when the ends are joined', () => {
    const timeline = three()
    const second = timeline.blocks[1]!.id
    const swapped = shiftBlock(timeline, second, -1)

    expect(layout(swapped)).toEqual([
      { start: 0, source: [20, 40] },
      { start: 20, source: [0, 20] },
      { start: 40, source: [40, 60] },
    ])
  })

  it('refuses to move the first block further left', () => {
    const timeline = three()
    expect(shiftBlock(timeline, timeline.blocks[0]!.id, -1)).toBe(timeline)
  })

  /**
   * With holes allowed the position is the user's, so a swap has to leave the
   * pair's outer bounds and the hole between them exactly where they were.
   */
  it('trades places inside the stretch the pair already occupied', () => {
    const timeline = removeSpan(setMode(three(), 'gap'), span(20, 25))
    const swapped = shiftBlock(timeline, timeline.blocks[0]!.id, 1)

    expect(layout(swapped)).toEqual([
      { start: 0, source: [25, 40] },
      { start: 20, source: [0, 20] },
      { start: 40, source: [40, 60] },
    ])
    expect(totalDuration(swapped)).toBe(totalDuration(timeline))
  })
})

describe('no two blocks ever claim the same instant', () => {
  /** Every pair of blocks, checked for an overlap the invariant forbids. */
  const overlapping = (timeline: Timeline) =>
    timeline.blocks.some((block, index) =>
      timeline.blocks.slice(index + 1).some((other) => overlaps(blockSpan(block), blockSpan(other))),
    )

  /** Two ten-second pieces with a ten-second hole between them. */
  const holed = () => removeSpan(createTimeline(MEDIA, 30, 'gap'), span(10, 20))

  /**
   * With holes allowed nothing reflows out of the way, so an edge dragged past
   * the block beside it used to land on top of it — which the timeline drew as
   * one block over another, and which no export could describe.
   */
  it('stops a trimmed end where the next block begins', () => {
    const start = holed()
    const trimmed = trimBlock(start, start.blocks[0]!.id, 'end', 26, 30)

    expect(overlapping(trimmed)).toBe(false)
    expect(layout(trimmed)).toEqual([
      { start: 0, source: [0, 20] },
      { start: 20, source: [20, 30] },
    ])
  })

  it('stops a trimmed start where the previous block ends', () => {
    const start = holed()
    const trimmed = trimBlock(start, start.blocks[1]!.id, 'start', 4, 30)

    expect(overlapping(trimmed)).toBe(false)
    // Pulled back only as far as the piece before it, which ends at ten.
    expect(trimmed.blocks[1]!.start).toBeCloseTo(10, 6)
  })

  it('lets an edge reach the neighbour exactly, and no further', () => {
    const start = holed()
    const trimmed = trimBlock(start, start.blocks[0]!.id, 'end', 20, 30)

    expect(overlapping(trimmed)).toBe(false)
    expect(blockEnd(trimmed.blocks[0]!)).toBeCloseTo(20, 6)
  })

  /** With the ends joined the reflow moves everything along, so there is
   *  nothing to collide with and a trim is free to grow. */
  it('leaves a trim unbounded when holes are closed', () => {
    const timeline = splitAt(fresh('join'), 20)
    const trimmed = trimBlock(timeline, timeline.blocks[0]!.id, 'end', 45, 60)

    expect(overlapping(trimmed)).toBe(false)
    expect(layout(trimmed)).toEqual([
      { start: 0, source: [0, 45] },
      { start: 45, source: [20, 60] },
    ])
  })

  it('holds across a move, a paste and a swap', () => {
    let timeline = holed()
    timeline = insertClip(timeline, { mediaId: 'b.mp4', source: span(0, 6) }, 12).timeline
    timeline = moveBlock(timeline, timeline.blocks[0]!.id, 14)
    timeline = shiftBlock(timeline, timeline.blocks[1]!.id, 1)

    expect(overlapping(timeline)).toBe(false)
  })
})
