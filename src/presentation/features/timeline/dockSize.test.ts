import { describe, expect, it } from 'vitest'

import {
  blockHeightFor,
  canvasHeightFor,
  clampDockHeight,
  MAX_BLOCK_HEIGHT,
  MAX_DOCK_HEIGHT,
  MIN_BLOCK_HEIGHT,
  MIN_DOCK_HEIGHT,
  MIN_STAGE_HEIGHT,
  maxDockHeight,
  RULER_HEIGHT,
  SCROLLBAR_HEIGHT,
  TOOLBAR_HEIGHT,
  TRACK_BOTTOM,
  TRACK_GAP,
} from './dockSize'

/** The window the editor opens at. */
const TALL = 900
/** The shortest window the app allows. */
const SHORT = 660

describe('the dock never shrinks below its designed size', () => {
  it('refuses anything under the default', () => {
    expect(clampDockHeight(0, TALL)).toBe(MIN_DOCK_HEIGHT)
    expect(clampDockHeight(-500, TALL)).toBe(MIN_DOCK_HEIGHT)
    expect(clampDockHeight(MIN_DOCK_HEIGHT - 1, TALL)).toBe(MIN_DOCK_HEIGHT)
  })

  it('leaves the block track at its designed height there', () => {
    expect(blockHeightFor(MIN_DOCK_HEIGHT)).toBe(MIN_BLOCK_HEIGHT)
  })

  it('falls back to the default for any value that is not a real number', () => {
    // Infinity is treated like NaN rather than like "as tall as possible": both
    // mean a caller computed something wrong, and the safe answer is the size
    // the editor was designed around.
    expect(clampDockHeight(Number.NaN, TALL)).toBe(MIN_DOCK_HEIGHT)
    expect(clampDockHeight(Number.POSITIVE_INFINITY, TALL)).toBe(MIN_DOCK_HEIGHT)
    expect(clampDockHeight(Number.NEGATIVE_INFINITY, TALL)).toBe(MIN_DOCK_HEIGHT)
  })
})

describe('the dock grows to a useful limit and stops', () => {
  it('caps at the tallest useful filmstrip on a roomy window', () => {
    expect(clampDockHeight(5000, TALL)).toBe(MAX_DOCK_HEIGHT)
    expect(blockHeightFor(MAX_DOCK_HEIGHT)).toBe(MAX_BLOCK_HEIGHT)
  })

  it('passes a value inside the range straight through', () => {
    const middle = Math.round((MIN_DOCK_HEIGHT + MAX_DOCK_HEIGHT) / 2)
    expect(clampDockHeight(middle, TALL)).toBe(middle)
  })

  it('rounds to whole pixels', () => {
    expect(clampDockHeight(MIN_DOCK_HEIGHT + 10.6, TALL)).toBe(MIN_DOCK_HEIGHT + 11)
  })
})

describe('the stage always keeps room for the picture', () => {
  it('stops the dock earlier on a short window', () => {
    expect(maxDockHeight(SHORT)).toBeLessThan(MAX_DOCK_HEIGHT)
    expect(clampDockHeight(5000, SHORT)).toBe(maxDockHeight(SHORT))
  })

  it('never leaves the stage below its minimum', () => {
    for (const height of [SHORT, 720, TALL, 1080, 1440]) {
      const dock = clampDockHeight(5000, height)
      const stage = height - 40 - dock
      expect(stage, `stage was ${stage}px on a ${height}px window`).toBeGreaterThanOrEqual(
        MIN_STAGE_HEIGHT - 1,
      )
    }
  })

  it('still allows the default dock on an absurdly short window', () => {
    // The window cannot actually get this small, but the limit must not invert.
    expect(maxDockHeight(200)).toBe(MIN_DOCK_HEIGHT)
    expect(clampDockHeight(300, 200)).toBe(MIN_DOCK_HEIGHT)
  })
})

describe('derived sizes stay consistent', () => {
  it('splits the dock into a toolbar and a canvas', () => {
    expect(canvasHeightFor(MIN_DOCK_HEIGHT)).toBe(MIN_DOCK_HEIGHT - TOOLBAR_HEIGHT)
  })

  it('grows the block track by exactly what the dock gained', () => {
    const grown = MIN_DOCK_HEIGHT + 90
    expect(blockHeightFor(grown) - blockHeightFor(MIN_DOCK_HEIGHT)).toBe(90)
    expect(canvasHeightFor(grown) - canvasHeightFor(MIN_DOCK_HEIGHT)).toBe(90)
  })
})

describe('the block track always fits inside the canvas', () => {
  /** Where the track starts inside the scrolling canvas. */
  const trackTop = RULER_HEIGHT + TRACK_GAP

  /**
   * This is the invariant that broke: the chrome total left the ruler out, so
   * the track ran past the bottom of the canvas by exactly the ruler's height at
   * every size, and the floor sat below the layout the editor was built around.
   */
  it('leaves the intended margin underneath at every allowed height', () => {
    for (let dock = MIN_DOCK_HEIGHT; dock <= MAX_DOCK_HEIGHT; dock += 1) {
      const bottom = trackTop + blockHeightFor(dock)
      const canvas = canvasHeightFor(dock)

      expect(bottom, `track overflowed the canvas at dock height ${dock}`).toBeLessThanOrEqual(
        canvas,
      )
      expect(canvas - bottom, `wrong bottom margin at dock height ${dock}`).toBe(TRACK_BOTTOM)
    }
  })

  /**
   * The horizontal scrollbar is drawn inside the canvas, out of the margin
   * under the track. Making it taller than that margin is how the bar starts
   * overlapping the filmstrip at every dock height at once.
   */
  it('leaves room for the scrollbar inside that margin', () => {
    expect(SCROLLBAR_HEIGHT).toBeLessThan(TRACK_BOTTOM)
  })

  it('starts at exactly the height the editor was laid out with', () => {
    // 40 toolbar + 22 ruler + 10 gap + 70 block + 16 bottom.
    expect(MIN_DOCK_HEIGHT).toBe(158)
    expect(canvasHeightFor(MIN_DOCK_HEIGHT)).toBe(118)
  })
})
