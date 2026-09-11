import { AnimatePresence, motion } from 'motion/react'

import { Close } from '@presentation/components/Icons'
import { IconButton } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import type { MessageKey } from '@infrastructure/i18n'

/**
 * Every shortcut, and the keys that trigger it.
 *
 * The key names are deliberately not translated: `Space`, `Ctrl` and `Delete`
 * are what is printed on the keyboard in front of the user, whatever language
 * the interface is in. Only the description changes.
 */
const SHORTCUTS: ReadonlyArray<{ keys: readonly string[]; label: MessageKey }> = [
  { keys: ['Space'], label: 'shortcuts.playPause' },
  { keys: ['←', '→'], label: 'shortcuts.frameStep' },
  { keys: ['I'], label: 'shortcuts.setIn' },
  { keys: ['O'], label: 'shortcuts.setOut' },
  { keys: ['Delete'], label: 'shortcuts.remove' },
  { keys: ['S'], label: 'shortcuts.split' },
  { keys: ['Ctrl', 'Z'], label: 'shortcuts.undo' },
  { keys: ['Ctrl', 'Y'], label: 'shortcuts.redo' },
  { keys: ['Ctrl', 'A'], label: 'selection.selectAll' },
  { keys: ['Ctrl', '+', 'scroll'], label: 'shortcuts.zoom' },
  { keys: ['Ctrl', 'E'], label: 'shortcuts.export' },
]

/**
 * The shortcut reference.
 *
 * The editor is faster from the keyboard than from the pointer, and without this
 * that was documented everywhere except inside the application itself.
 */
export function ShortcutsDialog({
  open,
  onClose,
}: {
  readonly open: boolean
  readonly onClose: () => void
}) {
  const t = useT()

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) onClose()
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
            aria-label={t('shortcuts.title')}
            className="w-full max-w-[420px] overflow-hidden rounded-2xl border border-line-bright bg-panel shadow-[0_40px_100px_-30px_rgba(0,0,0,0.9)]"
          >
            <header className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="font-display text-[16px] font-semibold tracking-tight text-paper">
                {t('shortcuts.title')}
              </h2>
              <IconButton label={t('error.dismiss')} onClick={onClose}>
                <Close size={15} />
              </IconButton>
            </header>

            <dl className="divide-y divide-line/60 px-5 py-2">
              {SHORTCUTS.map((shortcut) => (
                <div key={shortcut.label} className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="text-[12.5px] text-muted">{t(shortcut.label)}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {shortcut.keys.map((key) => (
                      <kbd
                        key={key}
                        className="timecode rounded-[5px] border border-line-bright bg-raised px-1.5 py-0.5 text-[10.5px] text-paper"
                      >
                        {key}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>

            <footer className="border-t border-line px-5 py-3 text-[11px] text-faint">
              {t('timeline.resize')}
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
