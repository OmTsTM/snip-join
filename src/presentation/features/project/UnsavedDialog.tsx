import { AnimatePresence, motion } from 'motion/react'
import { useEffect } from 'react'

import { Button } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'

/**
 * What is about to happen to the unsaved work.
 *
 * Leaving loses it; exporting does not. The same three answers mean different
 * things in each case, and a dialog that says "closing" while somebody presses
 * Export is a dialog nobody reads twice.
 */
export type UnsavedReason = 'leaving' | 'exporting'

interface UnsavedDialogProps {
  readonly open: boolean
  readonly reason: UnsavedReason
  readonly onSave: () => void
  readonly onDiscard: () => void
  readonly onCancel: () => void
}

/**
 * The question asked before unsaved work would be lost.
 *
 * Three answers rather than two, and the third is not a nicety: "close without
 * saving" and "do not close" are different decisions, and a dialog that offers
 * only one of them makes the other reachable solely by getting the first one
 * wrong. Discarding is the quiet one — it is the answer that destroys something.
 */
export function UnsavedDialog({
  open,
  reason,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedDialogProps) {
  const t = useT()
  const exporting = reason === 'exporting'

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
        onSave()
      }
    }

    // Capture, so the editor's own bindings do not also fire while a question
    // about losing work is on screen.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel, onSave, open])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          className="fixed inset-0 z-[55] flex items-center justify-center bg-ink-deep/80 p-6 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 4 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label={t(exporting ? 'project.unsavedTitleExport' : 'project.unsavedTitle')}
            className="w-full max-w-[420px] overflow-hidden rounded-2xl border border-line-bright bg-panel shadow-[0_40px_100px_-30px_rgba(0,0,0,0.9)]"
          >
            <div className="px-5 pb-4 pt-5">
              <h2 className="font-display text-[15px] font-semibold tracking-tight text-paper">
                {t(exporting ? 'project.unsavedTitleExport' : 'project.unsavedTitle')}
              </h2>
              <p className="mt-2 text-[12.5px] leading-snug text-muted">
                {t(exporting ? 'project.unsavedBodyExport' : 'project.unsavedBody')}
              </p>
            </div>

            <div className="flex items-center gap-2 border-t border-line px-5 py-3">
              <Button
                size="sm"
                tone={exporting ? 'quiet' : 'danger'}
                title={t(exporting ? 'hint.discardExport' : 'hint.discard')}
                onClick={onDiscard}
              >
                {t(exporting ? 'project.discardExport' : 'project.discard')}
              </Button>
              <div className="flex-1" />
              <Button size="sm" tone="quiet" title={t('hint.keepEditing')} onClick={onCancel}>
                {t('project.keepEditing')}
              </Button>
              <Button size="sm" tone="paper" title={t('hint.saveProject')} onClick={onSave}>
                {t('project.save')}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
