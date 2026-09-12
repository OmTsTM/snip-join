/** Left padding inside the timeline canvas, so time zero is not flush against
 *  the window edge and the playhead at zero is still grabbable. */
export const TIMELINE_PADDING = 16

/**
 * Empty canvas kept past the end of the last block.
 *
 * Somewhere to drag into. Without it the canvas stops exactly where the footage
 * does, so a block at the far right of a long timeline cannot be made longer:
 * the pointer runs out of window, and there is nothing further along to scroll
 * to either, because the scrollable width ends at the same instant the edge
 * being dragged does. `fitScale` accounts for it, so fitting still leaves no
 * scrollbar.
 */
export const TIMELINE_TRAIL = 120

/**
 * Intervals a ruler is allowed to use, in seconds.
 *
 * Restricted to values people actually count in. An automatically derived
 * interval lands on things like 3.2 seconds, which is unreadable as a scale even
 * though it spaces the ticks evenly.
 */
const NICE_INTERVALS = [
  0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800, 3600, 7200,
]

/** Smallest gap between labelled ticks, in pixels. */
const MIN_LABEL_SPACING = 74

export interface Tick {
  readonly at: number
  readonly major: boolean
}

/** Chooses the coarsest interval whose labels still fit without colliding. */
export function tickInterval(pixelsPerSecond: number): number {
  for (const interval of NICE_INTERVALS) {
    if (interval * pixelsPerSecond >= MIN_LABEL_SPACING) return interval
  }
  return NICE_INTERVALS[NICE_INTERVALS.length - 1]!
}

/**
 * Ticks covering the visible window only.
 *
 * Generating ticks for the whole timeline would mean tens of thousands of nodes
 * on a long recording at high zoom, all of them off screen. Only the visible
 * range is built, so the cost is bounded by the window rather than by the video.
 */
export function visibleTicks(
  pixelsPerSecond: number,
  scrollLeft: number,
  viewportWidth: number,
  duration: number,
): Tick[] {
  if (pixelsPerSecond <= 0 || duration <= 0) return []

  const major = tickInterval(pixelsPerSecond)
  const minor = major / 5

  const from = Math.max(0, (scrollLeft - TIMELINE_PADDING) / pixelsPerSecond)
  const to = Math.min(duration, (scrollLeft + viewportWidth - TIMELINE_PADDING) / pixelsPerSecond)

  const ticks: Tick[] = []
  const first = Math.floor(from / minor) * minor

  for (let at = first; at <= to + minor; at += minor) {
    if (at < -1e-9 || at > duration + 1e-9) continue
    // Floating point accumulation drifts, so a tick is "major" when it is within
    // a hair of a multiple rather than exactly on one.
    const remainder = Math.abs(at / major - Math.round(at / major))
    ticks.push({ at: Math.max(0, at), major: remainder < 1e-6 })
  }

  return ticks
}

/** Converts a position on the timeline to a pixel offset inside the canvas. */
export function timeToPixels(at: number, pixelsPerSecond: number): number {
  return TIMELINE_PADDING + at * pixelsPerSecond
}

/** Converts a pixel offset inside the canvas back to a position in seconds. */
export function pixelsToTime(offset: number, pixelsPerSecond: number): number {
  if (pixelsPerSecond <= 0) return 0
  return Math.max(0, (offset - TIMELINE_PADDING) / pixelsPerSecond)
}

/** The width the canvas takes for a timeline of this length. */
export function canvasWidth(duration: number, pixelsPerSecond: number): number {
  return TIMELINE_PADDING * 2 + Math.max(0, duration) * pixelsPerSecond + TIMELINE_TRAIL
}

/**
 * The scale at which a whole video fits the available width.
 *
 * The trailing room is subtracted along with the padding, so a fitted timeline
 * fills the viewport exactly and no scrollbar appears for space that holds
 * nothing.
 */
export function fitScale(duration: number, viewportWidth: number): number {
  if (duration <= 0 || viewportWidth <= 0) return 40
  const usable = viewportWidth - TIMELINE_PADDING * 2 - TIMELINE_TRAIL
  return Math.max(0.5, usable / duration)
}

/**
 * Zooms around a fixed point, so the frame under the pointer stays under the
 * pointer.
 *
 * Anchoring is what separates a zoom that feels like a magnifying glass from one
 * that throws the user somewhere else in the video on every step.
 */
export function zoomAround(
  currentScale: number,
  nextScale: number,
  scrollLeft: number,
  anchorOffsetInViewport: number,
): number {
  const anchorTime = pixelsToTime(scrollLeft + anchorOffsetInViewport, currentScale)
  return Math.max(0, timeToPixels(anchorTime, nextScale) - anchorOffsetInViewport)
}
