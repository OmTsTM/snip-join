import { AnimatePresence, motion } from 'motion/react'
import { useEffect, type ReactNode } from 'react'

import { Button } from './primitives'

interface ConfirmDialogProps {
  readonly open: boolean
  readonly title: string
  readonly body: ReactNode
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/**
 * A yes-or-no question, asked in the middle of the window.
 *
 * Deliberately not a toast or an inline control: it interrupts because the
 * answer changes the timeline, and because the alternative — acting on a single
 * click and offering an undo afterwards — is how a file ends up on the end of
 * someone's edit without them noticing.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCancel()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        onConfirm()
      }
    }

    // Capture, so the editor's own Escape and Space bindings do not also fire
    // while a question is on screen.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel, onConfirm, open])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) onCancel()
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/75 p-6 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 4 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="w-full max-w-[380px] overflow-hidden rounded-2xl border border-line-bright bg-panel shadow-[0_40px_100px_-30px_rgba(0,0,0,0.9)]"
          >
            <div className="px-5 pb-4 pt-5">
              <h2 className="font-display text-[15px] font-semibold tracking-tight text-paper">
                {title}
              </h2>
              <div className="mt-2 text-[12.5px] leading-snug text-muted">{body}</div>
            </div>

            <div className="flex gap-2 border-t border-line px-5 py-3">
              <Button size="sm" tone="quiet" full title={cancelLabel} onClick={onCancel}>
                {cancelLabel}
              </Button>
              <Button size="sm" tone="paper" full title={confirmLabel} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
