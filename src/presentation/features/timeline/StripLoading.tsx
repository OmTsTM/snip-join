import { AnimatePresence, motion } from 'motion/react'

import { cx } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import type { Phase } from '@presentation/state/editorStore'

/**
 * A veil over the block track while the file behind it is still being read.
 *
 * It covers two things at once, and deliberately so. The strip fills in tile
 * by tile, and a picture that keeps changing under the pointer reads as the
 * application struggling rather than as work finishing. More importantly a
 * cut made now is a cut into a file the editor has not finished reading, so
 * the veil takes the pointer as well as the eye: it sits above the blocks and
 * swallows the press instead of letting it start a selection.
 *
 * It says which of the two waits it is, because "preparing the project" and
 * "reading the frames" are different lengths of wait and the second one is
 * the one people watch.
 */
export function StripLoading({
  visible,
  phase,
}: {
  readonly visible: boolean
  readonly phase: Phase
}) {
  const t = useT()
  const preparing = phase === 'opening' || phase === 'preparing'

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          // Swallowed rather than ignored: the track below answers a press by
          // capturing the pointer for a selection drag, and a veil that let
          // that through would be a picture of a lock rather than a lock.
          onPointerDown={(event) => event.stopPropagation()}
          className={cx(
            'strip-loading absolute inset-0 z-30 flex cursor-wait items-center justify-center',
            'overflow-hidden rounded-[var(--radius-block)] bg-ink/55',
          )}
        >
          <span className="flex items-center gap-2 rounded-full border border-line bg-ink/80 px-3 py-1 text-[11px] tracking-wide text-muted backdrop-blur-sm">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-dusk-lift" />
            {preparing ? t('timeline.locked') : t('timeline.loadingFrames')}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
