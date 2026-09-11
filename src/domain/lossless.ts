import { EPSILON } from './time'
import type { Block } from './timeline'

/**
 * Cutting without re-encoding.
 *
 * A stream copy cannot start in the middle of a group of pictures: the frames
 * there are described relative to a keyframe, so without it they cannot be
 * decoded. Two consequences drive everything in this module:
 *
 *   - a segment must *start* on a keyframe, or the copy silently begins earlier
 *     than asked and brings back material the user removed;
 *   - a segment should *end* just before one, or its final frames reference a
 *     keyframe that is no longer in the file and smear at the seam.
 *
 * Snapping both edges to keyframes is what turns "roughly where you asked" into
 * "exactly where you asked, and clean", at no processing cost at all.
 */

/** How close a cut has to be to a keyframe to count as landing on it. */
const ON_KEYFRAME = 0.002

/** The keyframe at or before `at`, which is where a copy will really start. */
export function keyframeAtOrBefore(keyframes: readonly number[], at: number): number | null {
  if (keyframes.length === 0) return null

  let low = 0
  let high = keyframes.length

  while (low < high) {
    const middle = (low + high) >> 1
    if (keyframes[middle]! <= at + EPSILON) low = middle + 1
    else high = middle
  }

  return low > 0 ? keyframes[low - 1]! : null
}

/** The nearest keyframe in either direction, or `null` when there are none. */
export function nearestKeyframe(keyframes: readonly number[], at: number): number | null {
  if (keyframes.length === 0) return null

  const before = keyframeAtOrBefore(keyframes, at)
  const afterIndex = keyframes.findIndex((k) => k > at + EPSILON)
  const after = afterIndex === -1 ? null : keyframes[afterIndex]!

  if (before === null) return after
  if (after === null) return before
  return at - before <= after - at ? before : after
}

export function isOnKeyframe(keyframes: readonly number[], at: number): boolean {
  // Position zero is always the start of the file, so it is always a valid cut
  // even for a source whose keyframe list could not be read.
  if (Math.abs(at) < ON_KEYFRAME) return true
  const nearest = nearestKeyframe(keyframes, at)
  return nearest !== null && Math.abs(nearest - at) < ON_KEYFRAME
}

export interface LosslessAccuracy {
  /** True when every cut lands on a keyframe, so a copy is exact. */
  readonly exact: boolean
  /** Largest distance, in seconds, that a cut would be dragged by a copy. */
  readonly worstShift: number
  /** How many cut points are not on a keyframe. */
  readonly offCount: number
}

/**
 * Reports how faithful a stream copy of these blocks would be.
 *
 * Only interior cuts are judged. A block that begins at the very start of the
 * source needs no keyframe, and one that runs to the very end has nothing after
 * it to smear into, so counting either as inaccurate would tell the user their
 * untouched video is about to be approximated.
 */
export function losslessAccuracy(
  blocks: readonly Block[],
  keyframes: readonly number[],
  sourceDuration: number,
): LosslessAccuracy {
  let worstShift = 0
  let offCount = 0

  for (const block of blocks) {
    const isFirstFrame = block.source.start < ON_KEYFRAME
    if (!isFirstFrame) {
      const start = keyframeAtOrBefore(keyframes, block.source.start)
      const shift = start === null ? block.source.start : block.source.start - start
      if (shift > ON_KEYFRAME) {
        offCount += 1
        worstShift = Math.max(worstShift, shift)
      }
    }

    const end = block.source.end
    const isLastFrame = end > sourceDuration - ON_KEYFRAME
    if (!isLastFrame && !isOnKeyframe(keyframes, end)) {
      offCount += 1
      // An end that misses a keyframe does not move the cut; it leaves a partial
      // group of pictures, so the cost is a brief smear rather than a shift.
      // Reported through the count, not the shift.
    }
  }

  return { exact: offCount === 0, worstShift, offCount }
}

export { ON_KEYFRAME }
