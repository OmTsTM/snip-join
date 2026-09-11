import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'

import { cx } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { useEditor } from '@presentation/state/editorStore'

import { MIN_DOCK_HEIGHT } from './dockSize'

/** How much one arrow key moves the divider. */
const KEY_STEP = 24

/**
 * The divider between the picture and the timeline.
 *
 * Dragging it up gives the filmstrip more room at the preview's expense, which
 * is the trade someone makes when they are hunting for an exact moment rather
 * than watching. It only ever grows from the default: the smaller size is what
 * the block handles were laid out for, and going under it would clip them.
 *
 * A double-click puts it back, and arrow keys move it, so the adjustment is not
 * pointer-only.
 */
export function DockResizer() {
  const t = useT()
  const height = useEditor((state) => state.timelineHeight)
  const setHeight = useEditor((state) => state.setTimelineHeight)

  // Drag origin, kept in a ref because it is read on every pointer move and
  // changing it must never cause a render.
  const origin = useRef({ y: 0, height: 0 })

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()

      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      origin.current = { y: event.clientY, height }

      const onMove = (pointer: PointerEvent) => {
        // Dragging up is negative on screen but taller for the dock.
        setHeight(origin.current.height - (pointer.clientY - origin.current.y))
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
    [height, setHeight],
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHeight(height + KEY_STEP)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHeight(height - KEY_STEP)
      } else if (event.key === 'Home' || event.key === 'Escape') {
        event.preventDefault()
        setHeight(MIN_DOCK_HEIGHT)
      }
    },
    [height, setHeight],
  )

  const atMinimum = height <= MIN_DOCK_HEIGHT + 1

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('timeline.resize')}
      title={t('timeline.resize')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setHeight(MIN_DOCK_HEIGHT)}
      className={cx(
        'group relative z-20 h-[7px] shrink-0 cursor-ns-resize',
        'border-t border-line bg-panel transition-colors duration-150 hover:border-line-bright',
      )}
    >
      {/* A short grip, visible enough to invite a drag without becoming another
          piece of furniture on a surface that is already dense. */}
      <span
        className={cx(
          'pointer-events-none absolute left-1/2 top-[2px] h-[3px] w-[46px] -translate-x-1/2 rounded-full',
          'transition-colors duration-150',
          atMinimum ? 'bg-line-bright' : 'bg-faint',
          'group-hover:bg-muted group-focus-visible:bg-snip',
        )}
      />
    </div>
  )
}
