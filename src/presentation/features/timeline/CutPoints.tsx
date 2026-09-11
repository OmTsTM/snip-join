import { memo, useMemo } from 'react'

import { timeToPixels } from './geometry'

/**
 * Minimum spacing between drawn marks, in pixels.
 *
 * Below this the marks merge into a grey wash that says nothing. Footage dense
 * enough to hit it can be cut anywhere anyway, which the dock reports in words
 * instead.
 */
const MIN_SPACING = 5

interface CutPointsProps {
  readonly keyframes: readonly number[]
  readonly pixelsPerSecond: number
  readonly scrollLeft: number
  readonly viewportWidth: number
  /** Vertical offset of the block track, which the marks sit directly above. */
  readonly trackTop: number
}

/**
 * The positions a copy can cut at.
 *
 * Drawn quietly, in paper rather than orange: these are not cuts, they are where
 * cuts are allowed to land. Showing them is what turns keyframe snapping from
 * unexplained magnetism into something the user can see and aim at.
 */
export const CutPoints = memo(function CutPoints({
  keyframes,
  pixelsPerSecond,
  scrollLeft,
  viewportWidth,
  trackTop,
}: CutPointsProps) {
  const visible = useMemo(() => {
    if (keyframes.length < 2) return []

    // Only what is on screen: a two-hour recording holds thousands of these and
    // the ones outside the viewport cost render time for nothing.
    const from = (scrollLeft - 40) / pixelsPerSecond
    const to = (scrollLeft + viewportWidth + 40) / pixelsPerSecond

    const marks: number[] = []
    let lastPixel = Number.NEGATIVE_INFINITY

    for (const at of keyframes) {
      if (at < from) continue
      if (at > to) break

      const pixel = at * pixelsPerSecond
      if (pixel - lastPixel < MIN_SPACING) continue
      lastPixel = pixel
      marks.push(at)
    }

    return marks
  }, [keyframes, pixelsPerSecond, scrollLeft, viewportWidth])

  if (visible.length === 0) return null

  // Seated just above the blocks rather than on the ruler: up there they would
  // be read as another kind of time marking instead of as places a cut can land.
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20"
      style={{ top: trackTop - 7, height: 6 }}
    >
      {visible.map((at) => (
        <span
          key={at}
          className="absolute bottom-0 w-px bg-paper/35"
          style={{ left: timeToPixels(at, pixelsPerSecond), height: 5 }}
        />
      ))}
    </div>
  )
})
