import { motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { cx } from './primitives'

export interface MenuItem {
  readonly id: string
  readonly label: string
  /** Printed on the right, untranslated: these are the keys on the keyboard. */
  readonly shortcut?: string
  readonly icon?: ReactNode
  /** Orange for the one entry that removes something, and nothing else. */
  readonly tone?: 'snip'
  readonly disabled?: boolean
  readonly onSelect: () => void
}

/** A rule between two groups of entries. */
export const MENU_SEPARATOR = 'separator' as const
export type MenuEntry = MenuItem | typeof MENU_SEPARATOR

interface ContextMenuProps {
  /** Where the pointer was, in client coordinates. */
  readonly at: { readonly x: number; readonly y: number }
  readonly entries: readonly MenuEntry[]
  readonly onClose: () => void
}

/** Distance kept from the window edge when the menu has to be nudged inward. */
const EDGE_MARGIN = 8

/**
 * The menu a right-click opens.
 *
 * Rendered into `document.body` rather than inside the element it belongs to:
 * the timeline canvas clips its overflow and scrolls sideways, so a menu drawn
 * in place would be cut off by the track it was opened on and would slide away
 * under the pointer.
 *
 * It closes on anything that means the user has moved on — a press elsewhere,
 * Escape, a scroll, the window losing focus — because a menu that survives the
 * gesture that opened it is a menu that gets left behind.
 */
export function ContextMenu({ at, entries, onClose }: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(at)

  // Measured after the first paint and nudged inward: a menu opened near the
  // bottom right of the window would otherwise hang off the screen with its last
  // entries unreachable.
  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return

    const { width, height } = element.getBoundingClientRect()
    setPosition({
      x: Math.max(EDGE_MARGIN, Math.min(at.x, window.innerWidth - width - EDGE_MARGIN)),
      y: Math.max(EDGE_MARGIN, Math.min(at.y, window.innerHeight - height - EDGE_MARGIN)),
    })
  }, [at])

  useEffect(() => {
    /**
     * A press inside the menu is the user choosing an entry, not leaving.
     *
     * This listener runs in the capture phase, which is before React's handlers
     * anywhere in the tree, so without the containment check the menu would be
     * gone by the time the click it was dismissed by could be delivered — every
     * entry would be unreachable.
     */
    const onPress = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node)) return
      onClose()
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      // Stopped here so the editor's own Escape does not also clear the
      // selection the user was about to act on.
      event.stopPropagation()
      onClose()
    }

    const dismiss = () => onClose()

    // Capture, so a press on the timeline closes the menu before the track
    // gesture underneath it starts marking a new selection.
    window.addEventListener('pointerdown', onPress, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    window.addEventListener('wheel', dismiss, { passive: true })

    return () => {
      window.removeEventListener('pointerdown', onPress, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('wheel', dismiss)
    }
  }, [onClose])

  return createPortal(
    <motion.div
      ref={menu}
      role="menu"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
      style={{ left: position.x, top: position.y, transformOrigin: 'top left' }}
      /*
       * The menu keeps its own presses, in the React tree as well as the DOM.
       *
       * A portal is still a child of whatever rendered it as far as React's
       * events are concerned, so a press on an entry bubbles back into the
       * timeline — which answers it by capturing the pointer for a selection
       * drag. The capture retargets the `pointerup`, no `click` is ever
       * delivered, and every entry in this menu does nothing at all.
       */
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      className={cx(
        'fixed z-[60] min-w-[200px] overflow-hidden rounded-xl border border-line-bright',
        'bg-panel/95 py-1.5 shadow-[0_24px_60px_-18px_rgba(0,0,0,0.9)] backdrop-blur-md',
      )}
    >
      {entries.map((entry, index) =>
        entry === MENU_SEPARATOR ? (
          <span key={`rule-${index}`} className="my-1.5 block h-px bg-line" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              entry.onSelect()
              onClose()
            }}
            className={cx(
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px]',
              'transition-colors duration-100 disabled:pointer-events-none disabled:opacity-30',
              entry.tone === 'snip'
                ? 'text-muted hover:bg-snip/15 hover:text-snip'
                : 'text-muted hover:bg-raised hover:text-paper',
            )}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">{entry.icon}</span>
            <span className="flex-1 truncate">{entry.label}</span>
            {entry.shortcut && (
              <span className="timecode shrink-0 text-[10.5px] text-faint">{entry.shortcut}</span>
            )}
          </button>
        ),
      )}
    </motion.div>,
    document.body,
  )
}
