import { memo, useMemo } from 'react'

import type { Span } from '@domain/time'
import type { Thumbnail } from '@presentation/state/editorStore'

/**
 * Tile width as a multiple of the strip height.
 *
 * Tracking the height keeps each tile roughly frame-shaped as the dock grows: a
 * taller strip shows fewer, larger frames rather than the same thin slivers
 * stretched vertically. The default strip height reproduces the original 56px.
 */
const TILE_ASPECT = 1.12

/**
 * Finds the frame closest to a position in the source.
 *
 * Binary search rather than a scan: a long video contributes many frames and
 * this runs once per visible tile on every zoom change.
 */
function nearest(thumbnails: readonly Thumbnail[], at: number): Thumbnail | null {
  if (thumbnails.length === 0) return null

  let low = 0
  let high = thumbnails.length - 1

  while (low < high) {
    const middle = (low + high) >> 1
    if (thumbnails[middle]!.at < at) low = middle + 1
    else high = middle
  }

  const candidate = thumbnails[low]!
  const previous = thumbnails[low - 1]
  if (previous && Math.abs(previous.at - at) < Math.abs(candidate.at - at)) return previous
  return candidate
}

interface FilmstripProps {
  readonly source: Span
  readonly width: number
  readonly height: number
  readonly thumbnails: readonly Thumbnail[]
}

/**
 * The picture content of a block.
 *
 * Frames are sampled across the whole source once, so a block that was trimmed
 * or moved still shows the right part of the video without regenerating
 * anything: only which frames are picked changes.
 */
export const Filmstrip = memo(function Filmstrip({
  source,
  width,
  height,
  thumbnails,
}: FilmstripProps) {
  const tiles = useMemo(() => {
    const length = source.end - source.start
    if (width <= 0 || length <= 0) return []

    const tileWidth = Math.max(32, height * TILE_ASPECT)
    const count = Math.max(1, Math.round(width / tileWidth))
    const exact = width / count

    return Array.from({ length: count }, (_, index) => {
      const at = source.start + ((index + 0.5) / count) * length
      return { key: index, at, width: exact, frame: nearest(thumbnails, at) }
    })
  }, [source.start, source.end, width, height, thumbnails])

  return (
    <div className="pointer-events-none absolute inset-0 flex overflow-hidden">
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className="relative h-full shrink-0 overflow-hidden bg-raised"
          style={{ width: tile.width }}
        >
          {tile.frame && (
            <img
              src={tile.frame.dataUrl}
              alt=""
              draggable={false}
              className="h-full w-full object-cover opacity-90"
            />
          )}
        </div>
      ))}
    </div>
  )
})
