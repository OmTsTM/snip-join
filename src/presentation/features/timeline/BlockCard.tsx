import { memo, useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'

import { duration as spanDuration, formatTimecode, snapTo } from '@domain/time'
import { snapCandidates, type Block, type Timeline } from '@domain/timeline'
import { cx } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { useEditor, type Thumbnail } from '@presentation/state/editorStore'

import { Filmstrip } from './Filmstrip'
import { pixelsToTime, timeToPixels } from './geometry'

/** Height of the grab handle, in pixels. It does not grow with the dock: it is
 *  a grip, and a taller one would only take room from the picture. */
export const HANDLE_HEIGHT = 20

/** How close a drag must come to an edge before it snaps, in pixels. */
const SNAP_PIXELS = 8

interface BlockCardProps {
  readonly block: Block
  readonly index: number
  readonly timeline: Timeline
  readonly pixelsPerSecond: number
  readonly sourceDuration: number
  readonly thumbnails: readonly Thumbnail[]
  /** Full height of the card, which the dock divider controls. */
  readonly height: number
  readonly dragging: boolean
  readonly onDragStateChange: (id: string | null) => void
}

/**
 * One piece of the video on the timeline.
 *
 * Three separate gestures live on this card and they must never be ambiguous:
 * the handle moves the block, the edges trim it, and the body is left alone so a
 * drag across it marks a selection like any other part of the track. Separating
 * them by region rather than by modifier key is what makes the timeline usable
 * without instructions.
 */
export const BlockCard = memo(function BlockCard({
  block,
  index,
  timeline,
  pixelsPerSecond,
  sourceDuration,
  thumbnails,
  height,
  dragging,
  onDragStateChange,
}: BlockCardProps) {
  const stripHeight = Math.max(1, height - HANDLE_HEIGHT)
  const t = useT()
  const moveBlock = useEditor((state) => state.moveBlock)
  const trimBlock = useEditor((state) => state.trimBlock)
  const beginGesture = useEditor((state) => state.beginGesture)
  const snapToCutPoint = useEditor((state) => state.snapToCutPoint)

  const left = timeToPixels(block.start, pixelsPerSecond)
  const width = Math.max(2, spanDuration(block.source) * pixelsPerSecond)

  // Grab offset is kept in a ref: it is read on every pointer move and changing
  // it must never trigger a render.
  const grabOffset = useRef(0)

  const startMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()

      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)

      const canvas = target.closest('[data-timeline-canvas]') as HTMLElement | null
      if (!canvas) return

      const canvasLeft = canvas.getBoundingClientRect().left
      grabOffset.current = event.clientX - canvasLeft - left
      beginGesture()
      onDragStateChange(block.id)
    },
    [beginGesture, block.id, left, onDragStateChange],
  )

  const move = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return

      const canvas = event.currentTarget.closest('[data-timeline-canvas]') as HTMLElement | null
      if (!canvas) return

      const canvasLeft = canvas.getBoundingClientRect().left
      const offset = event.clientX - canvasLeft - grabOffset.current
      const desired = pixelsToTime(offset, pixelsPerSecond)

      // Snapping is applied in time, using a pixel threshold, so it feels the
      // same at every zoom level rather than getting stickier as you zoom out.
      const snapped = snapTo(
        desired,
        snapCandidates(timeline, block.id),
        SNAP_PIXELS / pixelsPerSecond,
      )

      moveBlock(block.id, Math.max(0, snapped))
    },
    [block.id, dragging, moveBlock, pixelsPerSecond, timeline],
  )

  const endMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      onDragStateChange(null)
    },
    [onDragStateChange],
  )

  const startTrim = useCallback(
    (edge: 'start' | 'end') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()

      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      beginGesture()

      const canvas = target.closest('[data-timeline-canvas]') as HTMLElement | null
      if (!canvas) return
      const canvasLeft = canvas.getBoundingClientRect().left

      const onMove = (pointer: PointerEvent) => {
        const raw = pixelsToTime(pointer.clientX - canvasLeft, pixelsPerSecond)
        // A trimmed edge becomes an export boundary, so it snaps to cut points
        // for the same reason the selection rails do.
        const at = snapToCutPoint(raw)
        trimBlock(block.id, edge, at)
      }

      const onUp = () => {
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
      }

      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onUp)
    },
    [beginGesture, block.id, pixelsPerSecond, snapToCutPoint, trimBlock],
  )

  // A clean edge means the original boundary of the video; a torn edge means a
  // cut the user made. Showing the difference is what lets someone tell at a
  // glance which seams are theirs.
  const tornStart = block.source.start > 1e-3
  const tornEnd = block.source.end < sourceDuration - 1e-3

  return (
    <div
      className={cx(
        'group absolute top-0 select-none',
        dragging ? 'z-20' : 'z-10',
      )}
      style={{
        left,
        width,
        height,
        transition: dragging ? 'none' : 'left 260ms cubic-bezier(0.22,1,0.36,1), width 200ms cubic-bezier(0.22,1,0.36,1)',
      }}
    >
      <div
        className={cx(
          'relative h-full overflow-hidden rounded-[var(--radius-block)] border',
          dragging
            ? 'border-snip shadow-[0_18px_40px_-18px_rgba(249,129,30,0.75)]'
            : 'border-line-bright group-hover:border-faint',
        )}
      >
        {/* The grab handle. Knurled so it reads as something to hold. */}
        <div
          onPointerDown={startMove}
          onPointerMove={move}
          onPointerUp={endMove}
          onPointerCancel={endMove}
          title={`${t('blocks.drag')} · ${formatTimecode(spanDuration(block.source))}`}
          className={cx(
            'knurl relative flex items-center gap-1.5 px-1.5',
            'cursor-grab active:cursor-grabbing',
            dragging ? 'bg-snip text-ink' : 'bg-raised-hi text-paper',
          )}
          style={{ height: HANDLE_HEIGHT }}
        >
          <span
            className={cx(
              'timecode flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] px-1 text-[9.5px] font-bold leading-none',
              dragging ? 'bg-ink text-snip' : 'bg-ink text-paper',
            )}
          >
            {index + 1}
          </span>

          {width > 96 && (
            <span className="timecode truncate text-[9.5px] opacity-70">
              {formatTimecode(block.start, { frames: false })}
            </span>
          )}
        </div>

        <div className="relative" style={{ height: stripHeight }}>
          <Filmstrip source={block.source} width={width} height={stripHeight} thumbnails={thumbnails} />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent to-ink/35" />
        </div>

        {tornStart && <TornEdge side="left" />}
        {tornEnd && <TornEdge side="right" />}
      </div>

      {/* Trim targets sit just inside each edge, wide enough to hit without
          overlapping the handle above them. */}
      <div
        onPointerDown={startTrim('start')}
        title={t('blocks.trimStart')}
        className="absolute left-0 w-[7px] cursor-ew-resize"
        style={{ top: HANDLE_HEIGHT, height: stripHeight }}
      >
        <span className="absolute inset-y-2 left-[2px] w-[2px] rounded-full bg-paper/0 transition-colors duration-150 group-hover:bg-paper/45" />
      </div>
      <div
        onPointerDown={startTrim('end')}
        title={t('blocks.trimEnd')}
        className="absolute right-0 w-[7px] cursor-ew-resize"
        style={{ top: HANDLE_HEIGHT, height: stripHeight }}
      >
        <span className="absolute inset-y-2 right-[2px] w-[2px] rounded-full bg-paper/0 transition-colors duration-150 group-hover:bg-paper/45" />
      </div>
    </div>
  )
})

/**
 * The zigzag left where the strip was cut.
 *
 * Drawn as a repeating gradient rather than an image so it stays crisp at any
 * height and costs nothing to render.
 */
function TornEdge({ side }: { readonly side: 'left' | 'right' }) {
  return (
    <span
      aria-hidden="true"
      className={cx('pointer-events-none absolute inset-y-0 w-[5px]', side === 'left' ? 'left-0' : 'right-0')}
      style={{
        background: `repeating-linear-gradient(${side === 'left' ? '135deg' : '45deg'}, var(--color-snip) 0 1.5px, transparent 1.5px 5px)`,
        opacity: 0.55,
      }}
    />
  )
}
