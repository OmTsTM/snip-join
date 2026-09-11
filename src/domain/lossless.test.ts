import { describe, expect, it } from 'vitest'

import { isOnKeyframe, keyframeAtOrBefore, losslessAccuracy, nearestKeyframe } from './lossless'
import { span } from './time'
import { createTimeline, nextBlockId, removeSpan, type Block } from './timeline'

/** A keyframe every two seconds, which is what most encoders produce. */
const KEYS = Array.from({ length: 31 }, (_, i) => i * 2)

const block = (sourceStart: number, sourceEnd: number, start = 0): Block => ({
  id: nextBlockId(),
  source: span(sourceStart, sourceEnd),
  start,
})

describe('finding the cut point a copy would really use', () => {
  it('returns the keyframe at or before the request', () => {
    expect(keyframeAtOrBefore(KEYS, 5)).toBe(4)
    expect(keyframeAtOrBefore(KEYS, 6)).toBe(6)
    expect(keyframeAtOrBefore(KEYS, 0)).toBe(0)
  })

  it('has nothing to offer before the first keyframe', () => {
    expect(keyframeAtOrBefore([10, 20], 5)).toBeNull()
    expect(keyframeAtOrBefore([], 5)).toBeNull()
  })

  it('picks the closer neighbour in either direction', () => {
    expect(nearestKeyframe(KEYS, 4.9)).toBe(4)
    expect(nearestKeyframe(KEYS, 5.1)).toBe(6)
    expect(nearestKeyframe(KEYS, 61)).toBe(60)
    expect(nearestKeyframe([], 5)).toBeNull()
  })

  it('treats the start of the file as always cuttable', () => {
    expect(isOnKeyframe([], 0)).toBe(true)
    expect(isOnKeyframe([], 5)).toBe(false)
    expect(isOnKeyframe(KEYS, 8)).toBe(true)
    expect(isOnKeyframe(KEYS, 8.5)).toBe(false)
  })
})

describe('judging whether a copy would be faithful', () => {
  it('calls an untouched video exact', () => {
    const timeline = createTimeline(60)
    expect(losslessAccuracy(timeline.blocks, KEYS, 60).exact).toBe(true)
  })

  it('calls a cut on keyframes exact', () => {
    // Removing 10s to 20s, both of which are keyframes.
    const timeline = removeSpan(createTimeline(60), span(10, 20))
    const accuracy = losslessAccuracy(timeline.blocks, KEYS, 60)

    expect(accuracy.exact).toBe(true)
    expect(accuracy.worstShift).toBe(0)
  })

  it('reports how far a cut between keyframes would drift', () => {
    // 11s is not a keyframe; a copy would really resume at 10s.
    const timeline = removeSpan(createTimeline(60), span(5, 11))
    const accuracy = losslessAccuracy(timeline.blocks, KEYS, 60)

    expect(accuracy.exact).toBe(false)
    expect(accuracy.worstShift).toBeCloseTo(1, 6)
    expect(accuracy.offCount).toBeGreaterThan(0)
  })

  it('does not blame the untouched head and tail of the video', () => {
    // The first block starts at 0 and the last ends at the source duration;
    // neither needs a keyframe of its own.
    const timeline = removeSpan(createTimeline(60), span(20, 30))
    expect(losslessAccuracy(timeline.blocks, KEYS, 60).exact).toBe(true)
  })

  it('treats a source with no keyframe list as inexact once it is cut', () => {
    const timeline = removeSpan(createTimeline(60), span(10, 20))
    expect(losslessAccuracy(timeline.blocks, [], 60).exact).toBe(false)
  })

  it('takes the worst cut, not the average', () => {
    const blocks = [block(0, 5), block(5.5, 20), block(31, 60)]
    const accuracy = losslessAccuracy(blocks, KEYS, 60)

    // 5.5 drifts back to 4 (1.5s) and 31 drifts back to 30 (1s).
    expect(accuracy.worstShift).toBeCloseTo(1.5, 6)
  })
})
