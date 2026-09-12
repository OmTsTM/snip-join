import { useCallback, type PointerEvent as ReactPointerEvent } from 'react'

import { formatTimecode, span } from '@domain/time'
import { Scissors } from '@presentation/components/Icons'
import { cx } from '@presentation/components/primitives'
import { selectSelectionCovers, useEditor } from '@presentation/state/editorStore'

import { beginDragScroll, endDragScroll } from './dragScroll'
import { pixelsToTime, timeToPixels } from './geometry'

interface SelectionRailsProps {
  readonly pixelsPerSecond: number
  readonly height: number
}

/**
 * The two bars that mark what is about to be removed.
 *
 * They are the loudest thing on the timeline on purpose: this is the one
 * decision the whole application exists to make, and its edges have to be
 * unmistakable and directly grabbable. Orange throughout, since orange means
 * cutting and this is the pending cut.
 *
 * While snapping is on, both edges land on cut points, so a selection dragged
 * roughly into place still produces an exact copy.
 *
 * They go grey when the rails cover nothing but a hole. A hole holds no
 * material, so there is nothing there to take out, and the Remove button is
 * refusing at that moment — saying so on the timeline is what makes the refusal
 * legible instead of mysterious.
 */
export function SelectionRails({ pixelsPerSecond, height }: SelectionRailsProps) {
  const selection = useEditor((state) => state.selection)
  const setSelection = useEditor((state) => state.setSelection)
  const snapToCutPoint = useEditor((state) => state.snapToCutPoint)
  const covers = useEditor(selectSelectionCovers)

  const dragEdge = useCallback(
    (edge: 'start' | 'end') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !selection) return
      event.preventDefault()
      event.stopPropagation()

      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      beginDragScroll()

      const canvas = target.closest('[data-timeline-canvas]') as HTMLElement | null
      const viewport = canvas?.parentElement
      if (!canvas || !viewport) {
        endDragScroll()
        return
      }

      let pointerX = event.clientX

      const apply = () => {
        // The canvas rect is read on every move rather than captured once: the
        // dock scrolls itself when a rail reaches the edge of the window, and a
        // cached left edge would drag the mark backwards as the view travelled.
        const raw = pixelsToTime(pointerX - canvas.getBoundingClientRect().left, pixelsPerSecond)
        const at = snapToCutPoint(raw)
        const current = useEditor.getState().selection
        if (!current) return

        // The store normalises a reversed range, so dragging one edge past the
        // other flips the selection rather than collapsing it.
        setSelection(edge === 'start' ? span(at, current.end) : span(current.start, at))
      }

      const onMove = (pointer: PointerEvent) => {
        pointerX = pointer.clientX
        apply()
      }

      const onScroll = () => apply()

      const onUp = () => {
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
        viewport.removeEventListener('scroll', onScroll)
        endDragScroll()
      }

      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onUp)
      viewport.addEventListener('scroll', onScroll)
    },
    [pixelsPerSecond, selection, setSelection, snapToCutPoint],
  )

  if (!selection) return null

  const left = timeToPixels(selection.start, pixelsPerSecond)
  const right = timeToPixels(selection.end, pixelsPerSecond)

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30" style={{ height }}>
      {/* The doomed stretch, tinted rather than covered so the footage under it
          stays readable while it is being marked. */}
      <div
        className={cx('absolute top-0', covers ? 'bg-snip/14' : 'bg-faint/10')}
        style={{ left, width: Math.max(0, right - left), height }}
      >
        <div className={cx('absolute inset-x-0 top-0 h-px', covers ? 'bg-snip/45' : 'bg-faint/40')} />
        <div className={cx('absolute inset-x-0 bottom-0 h-px', covers ? 'bg-snip/45' : 'bg-faint/40')} />
      </div>

      <Rail
        position={left}
        side="start"
        live={covers}
        onPointerDown={dragEdge('start')}
        label={formatTimecode(selection.start)}
      />
      <Rail
        position={right}
        side="end"
        live={covers}
        onPointerDown={dragEdge('end')}
        label={formatTimecode(selection.end)}
      />
    </div>
  )
}

function Rail({
  position,
  side,
  live,
  onPointerDown,
  label,
}: {
  readonly position: number
  readonly side: 'start' | 'end'
  /** False when the rails cover no material, so nothing can be cut here. */
  readonly live: boolean
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  readonly label: string
}) {
  const bar = live ? 'bg-snip' : 'bg-faint'

  return (
    <div
      onPointerDown={onPointerDown}
      title={label}
      className="pointer-events-auto absolute top-0 h-full w-[15px] cursor-ew-resize"
      style={{ left: position - 7 }}
    >
      <span className={cx('absolute inset-y-0 left-[6px] w-[3px]', bar)} />

      {/* The head is the grab target and the reason the rail reads as a tool
          rather than as a line. */}
      <span
        className={cx(
          'absolute -top-[1px] flex h-[18px] w-[18px] items-center justify-center rounded-[4px] text-ink shadow-[0_2px_8px_rgba(0,0,0,0.55)]',
          bar,
          side === 'start' ? 'left-[6px] rounded-tl-none' : 'right-[6px] rounded-tr-none',
        )}
      >
        <Scissors size={11} strokeWidth={2} />
      </span>

      <span className={cx('absolute bottom-0 left-[4px] h-[7px] w-[7px] rotate-45', bar)} />
    </div>
  )
}
