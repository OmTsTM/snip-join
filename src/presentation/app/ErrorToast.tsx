import { AnimatePresence, motion } from 'motion/react'

import { Alert, Close } from '@presentation/components/Icons'
import { IconButton } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { useEditor } from '@presentation/state/editorStore'
import type { MessageKey } from '@infrastructure/i18n'

/** Error codes with a translated explanation of their own. */
const TRANSLATED_CODES = new Set([
  'ffmpegMissing',
  'unreadableFile',
  'unsupportedMedia',
  'probeFailed',
  'encodeFailed',
  'invalidInput',
  'internal',
])

/**
 * Reports a failure without interrupting.
 *
 * The translated line says what went wrong in the interface's own voice; the raw
 * message from the backend is kept underneath, because on an encoder failure
 * that line is the only thing that says which codec refused and why.
 */
export function ErrorToast() {
  const t = useT()
  const error = useEditor((state) => state.error)
  const dismiss = useEditor((state) => state.dismissError)

  return (
    <AnimatePresence>
      {error && (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          role="alert"
          className="fixed bottom-5 left-1/2 z-[60] w-[min(520px,calc(100vw-40px))] -translate-x-1/2"
        >
          <div className="flex items-start gap-3 rounded-xl border border-snip/40 bg-panel p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)]">
            <span className="mt-px shrink-0 text-snip-ink">
              <Alert size={17} />
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-paper">
                {TRANSLATED_CODES.has(error.code)
                  ? t(`error.${error.code}` as MessageKey)
                  : t('error.title')}
              </p>
              <p className="mt-1 break-words text-[11.5px] leading-snug text-faint">
                {error.message}
              </p>
            </div>

            <IconButton label={t('error.dismiss')} onClick={dismiss} className="shrink-0">
              <Close size={14} />
            </IconButton>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
