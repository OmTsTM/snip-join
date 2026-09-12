import { AnimatePresence, motion } from 'motion/react'

import { useT } from '@presentation/i18n/I18nProvider'

/**
 * A veil over the block track while its frames are still being read.
 *
 * Without it the strip fills in tile by tile and the picture under the pointer
 * keeps changing, which reads as the application struggling rather than as
 * work finishing. It never takes the pointer: the editor is usable the moment
 * the preview is ready, and covering the timeline would take that away to fix
 * an appearance.
 */
export function StripLoading({ visible }: { readonly visible: boolean }) {
  const t = useT()

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="strip-loading pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden rounded-[var(--radius-block)] bg-ink/55"
        >
          <span className="flex items-center gap-2 rounded-full border border-line bg-ink/80 px-3 py-1 text-[11px] tracking-wide text-muted backdrop-blur-sm">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-dusk-lift" />
            {t('timeline.loadingFrames')}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
