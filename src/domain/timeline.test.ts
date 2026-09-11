import { describe, expect, it } from 'vitest'

import { span } from './time'
import {
  blockAt,
  blockEnd,
  createTimeline,
  gaps,
  isContiguous,
  isolateSpan,
  keptDuration,
  moveBlock,
  removeBlock,
  removeSpan,
  setMode,
  sourceAt,
  splitAt,
  totalDuration,
  trimBlock,
  type Timeline,
} from './timeline'

/** A one-minute clip, whole, with holes closed. */
const fresh = (mode: 'join' | 'gap' = 'join') => createTimeline(60, mode)

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
