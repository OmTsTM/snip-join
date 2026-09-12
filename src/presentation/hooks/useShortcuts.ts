import { useEffect } from 'react'

import { selectActiveBlock, useEditor } from '@presentation/state/editorStore'

/** True when the key event came from somewhere the user is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

/**
 * Editor keyboard shortcuts.
 *
 * Bound on the window rather than on a focused element so they work wherever the
 * pointer happens to be, which is how every editor behaves and what makes
 * marking an in point while watching feel immediate. Anything typed into a field
 * is left alone.
 */
export function useShortcuts(options: {
  readonly onExport: () => void
  readonly onShowShortcuts: () => void
}) {
  const { onExport, onShowShortcuts } = options

  useEffect(() => {
    function handle(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return

      const store = useEditor.getState()
      const modifier = event.ctrlKey || event.metaKey

      /**
       * The block the clipboard and Delete act on.
       *
       * The chosen one if there is one, and otherwise whatever is under the
       * playhead: pressing a key right after scrubbing should do the obvious
       * thing rather than nothing at all.
       */
      const block = selectActiveBlock(store)

      if (modifier) {
        switch (event.key.toLowerCase()) {
          case 'z':
            event.preventDefault()
            // Shift turns undo into redo, the convention on every platform.
            if (event.shiftKey) store.redo()
            else store.undo()
            return
          case 'y':
            event.preventDefault()
            store.redo()
            return
          case 'a':
            event.preventDefault()
            store.selectAll()
            return
          case 'c':
            event.preventDefault()
            if (block) store.copyBlock(block.id)
            return
          case 'x':
            event.preventDefault()
            if (block) store.cutBlock(block.id)
            return
          case 'v':
            event.preventDefault()
            store.pasteAtPlayhead()
            return
          case 'e':
            event.preventDefault()
            onExport()
            return
          default:
            return
        }
      }

      // Alt with an arrow reorders instead of stepping, which is the keyboard's
      // answer to dragging a block by a twenty-pixel handle.
      if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        if (block) store.shiftBlock(block.id, event.key === 'ArrowRight' ? 1 : -1)
        return
      }

      switch (event.key) {
        // The conventional key for "what can I press here".
        case '?':
          event.preventDefault()
          onShowShortcuts()
          break
        case ' ':
          event.preventDefault()
          store.togglePlay()
          break
        case 'i':
        case 'I':
          event.preventDefault()
          store.markIn()
          break
        case 'o':
        case 'O':
          event.preventDefault()
          store.markOut()
          break
        case 's':
        case 'S':
          event.preventDefault()
          store.splitAtPlayhead()
          break
        case 'Delete':
        case 'Backspace':
          event.preventDefault()
          // Rails first: they are the louder of the two selections and the one
          // the user just drew. Without them Delete falls to the chosen block,
          // which is the only way the keyboard can reach a block at all.
          if (store.selection) store.removeSelection()
          else if (store.selectedBlock) store.deleteBlock(store.selectedBlock)
          break
        case 'Escape':
          event.preventDefault()
          store.setSelection(null)
          store.selectBlock(null)
          break
        case 'ArrowLeft':
          event.preventDefault()
          if (event.shiftKey) store.seek(store.playhead - 1)
          else store.stepFrame(-1)
          break
        case 'ArrowRight':
          event.preventDefault()
          if (event.shiftKey) store.seek(store.playhead + 1)
          else store.stepFrame(1)
          break
        case 'Home':
          event.preventDefault()
          store.seek(0)
          break
        case 'End':
          event.preventDefault()
          store.seek(Number.MAX_SAFE_INTEGER)
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [onExport, onShowShortcuts])
}
