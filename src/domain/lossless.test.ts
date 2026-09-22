import { describe, expect, it } from 'vitest'

import {
  isOnKeyframe,
  keyframeAtOrBefore,
  losslessAccuracy,
  nearestKeyframe,
  smartCutReport,
} from './lossless'
import { span } from './time'
import { createTimeline, nextBlockId, removeSpan, type Block } from './timeline'

/** A keyframe every two seconds, which is what most encoders produce. */
const KEYS = Array.from({ length: 31 }, (_, i) => i * 2)

const block = (sourceStart: number, sourceEnd: number, start = 0): Block => ({
  id: nextBlockId(),
  mediaId: 'a.mp4',
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
    const timeline = createTimeline('a.mp4', 60)
    expect(losslessAccuracy(timeline.blocks, KEYS, 60).exact).toBe(true)
  })

  it('calls a cut on keyframes exact', () => {
    // Removing 10s to 20s, both of which are keyframes.
    const timeline = removeSpan(createTimeline('a.mp4', 60), span(10, 20))
    const accuracy = losslessAccuracy(timeline.blocks, KEYS, 60)

    expect(accuracy.exact).toBe(true)
    expect(accuracy.worstShift).toBe(0)
  })

  it('reports how far a cut between keyframes would drift', () => {
    // 11s is not a keyframe; a copy would really resume at 10s.
    const timeline = removeSpan(createTimeline('a.mp4', 60), span(5, 11))
    const accuracy = losslessAccuracy(timeline.blocks, KEYS, 60)

    expect(accuracy.exact).toBe(false)
    expect(accuracy.worstShift).toBeCloseTo(1, 6)
    expect(accuracy.offCount).toBeGreaterThan(0)
  })

  it('does not blame the untouched head and tail of the video', () => {
    // The first block starts at 0 and the last ends at the source duration;
    // neither needs a keyframe of its own.
    const timeline = removeSpan(createTimeline('a.mp4', 60), span(20, 30))
    expect(losslessAccuracy(timeline.blocks, KEYS, 60).exact).toBe(true)
  })

  it('treats a source with no keyframe list as inexact once it is cut', () => {
    const timeline = removeSpan(createTimeline('a.mp4', 60), span(10, 20))
    expect(losslessAccuracy(timeline.blocks, [], 60).exact).toBe(false)
  })

  it('takes the worst cut, not the average', () => {
    const blocks = [block(0, 5), block(5.5, 20), block(31, 60)]
    const accuracy = losslessAccuracy(blocks, KEYS, 60)

    // 5.5 drifts back to 4 (1.5s) and 31 drifts back to 30 (1s).
    expect(accuracy.worstShift).toBeCloseTo(1.5, 6)
  })
})

describe('estimating what a copy re-encodes beside the cuts', () => {
  it('re-encodes nothing for an untouched video or a cut on keyframes', () => {
    const untouched = createTimeline('a.mp4', 60)
    expect(smartCutReport(untouched.blocks, KEYS, 60).reEncoded).toBe(0)

    const snapped = removeSpan(createTimeline('a.mp4', 60), span(10, 20))
    expect(smartCutReport(snapped.blocks, KEYS, 60)).toEqual({ reEncoded: 0, pieces: 0 })
  })

  it('counts the frames from a cut to the keyframe on the copied side', () => {
    // Removing 5s to 11s: the first block ends at 5, one second past the
    // keyframe at 4; the second starts at 11, one second before the one at 12.
    const timeline = removeSpan(createTimeline('a.mp4', 60), span(5, 11))
    const report = smartCutReport(timeline.blocks, KEYS, 60)

    expect(report.reEncoded).toBeCloseTo(2, 6)
    expect(report.pieces).toBe(2)
  })

  it('re-encodes a block whole when no keyframe falls inside it', () => {
    const report = smartCutReport([block(4.5, 5.5)], KEYS, 60)
    expect(report.reEncoded).toBeCloseTo(1, 6)
    expect(report.pieces).toBe(1)
  })

  it('needs no keyframe at the start of the file or at its end', () => {
    const timeline = removeSpan(createTimeline('a.mp4', 60), span(20, 30))
    expect(smartCutReport(timeline.blocks, KEYS, 60).reEncoded).toBe(0)

    // The last block ends at 59, which is off a keyframe but not at the end.
    const trimmed = [block(0, 20), block(30, 59)]
    expect(smartCutReport(trimmed, KEYS, 60).reEncoded).toBeCloseTo(1, 6)
  })
})
