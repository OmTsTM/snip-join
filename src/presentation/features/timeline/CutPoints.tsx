import { memo, useMemo } from 'react'

import { blockEnd, type Block } from '@domain/timeline'

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
  /** The timeline's blocks, in order, which the marks are read through. */
  readonly blocks: readonly Block[]
  /** Cut points per medium, keyed by path, exactly as the store holds them. */
  readonly keyframes: Readonly<Record<string, readonly number[]>>
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
 *
 * Read through the blocks rather than plotted straight onto the timeline. A cut
 * point is a position inside a file, and the timeline has been trimmed,
 * reordered and reflowed since that file was opened, so the two coordinate
 * systems stopped agreeing at the first edit. Mapping each block's own stretch
 * of its own medium is what keeps the marks under the frames they describe —
 * and it is the only way a timeline drawing on several files can show any at
 * all.
 */
export const CutPoints = memo(function CutPoints({
  blocks,
  keyframes,
  pixelsPerSecond,
  scrollLeft,
  viewportWidth,
  trackTop,
}: CutPointsProps) {
  const visible = useMemo(() => {
    // Only what is on screen: a two-hour recording holds thousands of these and
    // the ones outside the viewport cost render time for nothing.
    const from = (scrollLeft - 40) / pixelsPerSecond
    const to = (scrollLeft + viewportWidth + 40) / pixelsPerSecond

    const marks: number[] = []
    let lastPixel = Number.NEGATIVE_INFINITY

    for (const block of blocks) {
      const positions = keyframes[block.mediaId]
      if (!positions || positions.length < 2) continue
      if (blockEnd(block) < from || block.start > to) continue

      for (const source of positions) {
        if (source < block.source.start) continue
        if (source > block.source.end) break

        const at = block.start + (source - block.source.start)
        if (at < from) continue
        if (at > to) break

        const pixel = at * pixelsPerSecond
        if (pixel - lastPixel < MIN_SPACING) continue
        lastPixel = pixel
        marks.push(at)
      }
    }

    return marks
  }, [blocks, keyframes, pixelsPerSecond, scrollLeft, viewportWidth])

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
