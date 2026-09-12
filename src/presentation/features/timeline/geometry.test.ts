import { describe, expect, it } from 'vitest'

import {
  canvasWidth,
  fitScale,
  pixelsToTime,
  tickInterval,
  timeToPixels,
  TIMELINE_PADDING,
  TIMELINE_TRAIL,
  visibleTicks,
  zoomAround,
} from './geometry'

describe('ruler intervals', () => {
  it('coarsens as the view zooms out', () => {
    expect(tickInterval(200)).toBeLessThan(tickInterval(20))
    expect(tickInterval(2)).toBeGreaterThan(tickInterval(40))
  })

  it('always leaves room for a label', () => {
    for (const scale of [1, 4, 17, 60, 250, 800]) {
      expect(tickInterval(scale) * scale).toBeGreaterThanOrEqual(74)
    }
  })

  it('only uses intervals people count in', () => {
    const readable = new Set([0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200])
    for (const scale of [0.5, 3, 25, 90, 400]) {
      expect(readable.has(tickInterval(scale))).toBe(true)
    }
  })
})

describe('tick generation', () => {
  it('covers only the visible window, not the whole video', () => {
    const ticks = visibleTicks(40, 0, 800, 36_000)
    expect(ticks.length).toBeLessThan(200)
    expect(ticks.every((tick) => tick.at <= 36_000)).toBe(true)
  })

  it('follows the scroll position', () => {
    const early = visibleTicks(40, 0, 800, 600)
    const later = visibleTicks(40, 4000, 800, 600)

    expect(early[0]!.at).toBeLessThan(10)
    expect(later[0]!.at).toBeGreaterThan(90)
  })

  it('never produces a tick before zero or past the end', () => {
    const ticks = visibleTicks(40, 0, 2000, 12)
    expect(ticks.every((tick) => tick.at >= 0 && tick.at <= 12 + 1e-6)).toBe(true)
  })

  it('marks major ticks despite floating point accumulation', () => {
    const ticks = visibleTicks(80, 0, 900, 60)
    const majors = ticks.filter((tick) => tick.major).map((tick) => Math.round(tick.at * 100) / 100)

    expect(majors.length).toBeGreaterThan(2)
    const interval = tickInterval(80)
    for (const at of majors) {
      expect(Math.abs(at / interval - Math.round(at / interval))).toBeLessThan(1e-6)
    }
  })

  it('returns nothing for a degenerate view', () => {
    expect(visibleTicks(0, 0, 800, 60)).toEqual([])
    expect(visibleTicks(40, 0, 800, 0)).toEqual([])
  })
})

describe('converting between time and pixels', () => {
  it('round-trips', () => {
    for (const at of [0, 1.5, 42, 3600]) {
      expect(pixelsToTime(timeToPixels(at, 37), 37)).toBeCloseTo(at, 9)
    }
  })

  it('places time zero after the leading padding', () => {
    expect(timeToPixels(0, 40)).toBe(TIMELINE_PADDING)
  })

  it('never reports a negative time', () => {
    expect(pixelsToTime(-500, 40)).toBe(0)
  })
})

describe('fitting and zooming', () => {
  /**
   * Fitting means the canvas is exactly the viewport: the video, the padding at
   * each end, and the trailing room a drag needs to reach into. Anything wider
   * would put a scrollbar under a timeline that is entirely on screen; anything
   * narrower would waste width the footage could have had.
   */
  it('fits the whole video, its padding and its trailing room, inside the viewport', () => {
    const scale = fitScale(120, 1000)

    expect(canvasWidth(120, scale)).toBeCloseTo(1000, 6)
    expect(timeToPixels(120, scale)).toBeCloseTo(1000 - TIMELINE_PADDING - TIMELINE_TRAIL, 6)
  })

  /**
   * There has to be somewhere past the last block to drag into. Without it an
   * edge at the far right cannot be extended at all: the pointer runs out of
   * window and the scrollable width ends at the same instant the edge does.
   */
  it('keeps room past the end of the footage at every scale', () => {
    for (const scale of [0.5, 8, 40, 200]) {
      // The trailing room plus the padding on that side, which is empty canvas
      // just the same.
      expect(canvasWidth(120, scale) - timeToPixels(120, scale)).toBe(
        TIMELINE_PADDING + TIMELINE_TRAIL,
      )
    }
    expect(canvasWidth(0, 40)).toBe(TIMELINE_PADDING * 2 + TIMELINE_TRAIL)
  })

  it('falls back to a usable scale for an empty timeline', () => {
    expect(fitScale(0, 1000)).toBeGreaterThan(0)
    expect(fitScale(120, 0)).toBeGreaterThan(0)
  })

  it('keeps the frame under the pointer in place while zooming', () => {
    const scale = 40
    const scrollLeft = 800
    const anchor = 300

    const timeUnderPointer = pixelsToTime(scrollLeft + anchor, scale)
    const nextScroll = zoomAround(scale, 80, scrollLeft, anchor)
    const timeAfter = pixelsToTime(nextScroll + anchor, 80)

    expect(timeAfter).toBeCloseTo(timeUnderPointer, 9)
  })

  it('never scrolls before the start when zooming out at the head', () => {
    expect(zoomAround(80, 10, 0, 40)).toBeGreaterThanOrEqual(0)
  })
})
