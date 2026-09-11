import { useCallback, type PointerEvent as ReactPointerEvent } from 'react'

import { formatTimecode, span } from '@domain/time'
import { Scissors } from '@presentation/components/Icons'
import { cx } from '@presentation/components/primitives'
import { useEditor } from '@presentation/state/editorStore'

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
 */
export function SelectionRails({ pixelsPerSecond, height }: SelectionRailsProps) {
  const selection = useEditor((state) => state.selection)
  const setSelection = useEditor((state) => state.setSelection)
  const snapToCutPoint = useEditor((state) => state.snapToCutPoint)

  const dragEdge = useCallback(
    (edge: 'start' | 'end') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !selection) return
      event.preventDefault()
      event.stopPropagation()

      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)

      const canvas = target.closest('[data-timeline-canvas]') as HTMLElement | null
      if (!canvas) return
      const canvasLeft = canvas.getBoundingClientRect().left

      const onMove = (pointer: PointerEvent) => {
        const raw = pixelsToTime(pointer.clientX - canvasLeft, pixelsPerSecond)
        const at = snapToCutPoint(raw)
        const current = useEditor.getState().selection
        if (!current) return

        // The store normalises a reversed range, so dragging one edge past the
        // other flips the selection rather than collapsing it.
        setSelection(edge === 'start' ? span(at, current.end) : span(current.start, at))
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
        className="absolute top-0 bg-snip/14"
        style={{ left, width: Math.max(0, right - left), height }}
      >
        <div className="absolute inset-x-0 top-0 h-px bg-snip/45" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-snip/45" />
      </div>

      <Rail position={left} side="start" onPointerDown={dragEdge('start')} label={formatTimecode(selection.start)} />
      <Rail position={right} side="end" onPointerDown={dragEdge('end')} label={formatTimecode(selection.end)} />
    </div>
  )
}

function Rail({
  position,
  side,
  onPointerDown,
  label,
}: {
  readonly position: number
  readonly side: 'start' | 'end'
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  readonly label: string
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      title={label}
      className="pointer-events-auto absolute top-0 h-full w-[15px] cursor-ew-resize"
      style={{ left: position - 7 }}
    >
      <span className="absolute inset-y-0 left-[6px] w-[3px] bg-snip" />

      {/* The head is the grab target and the reason the rail reads as a tool
          rather than as a line. */}
      <span
        className={cx(
          'absolute -top-[1px] flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-snip text-ink shadow-[0_2px_8px_rgba(0,0,0,0.55)]',
          side === 'start' ? 'left-[6px] rounded-tl-none' : 'right-[6px] rounded-tr-none',
        )}
      >
        <Scissors size={11} strokeWidth={2} />
      </span>

      <span className="absolute bottom-0 left-[4px] h-[7px] w-[7px] rotate-45 bg-snip" />
    </div>
  )
}
