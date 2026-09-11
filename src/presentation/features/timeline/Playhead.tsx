import { useEditor } from '@presentation/state/editorStore'

import { timeToPixels } from './geometry'

/**
 * The current position marker.
 *
 * Subscribed to the playhead alone so the clock re-renders this one element
 * rather than the timeline around it. Paper coloured, not orange: the playhead
 * reports where you are, it does not cut anything.
 */
export function Playhead({
  pixelsPerSecond,
  height,
}: {
  readonly pixelsPerSecond: number
  readonly height: number
}) {
  const playhead = useEditor((state) => state.playhead)
  const left = timeToPixels(playhead, pixelsPerSecond)

  return (
    <div
      className="pointer-events-none absolute top-0 z-40"
      style={{ left, height, transform: 'translateX(-0.5px)' }}
      aria-hidden="true"
    >
      <span className="absolute inset-y-0 left-0 w-px bg-paper" />
      <span className="absolute -left-[5px] top-0 h-[9px] w-[11px] rounded-b-[2px] bg-paper" />
    </div>
  )
}
