import { AnimatePresence, motion } from 'motion/react'

import { Button } from '@presentation/components/primitives'
import { Folder } from '@presentation/components/Icons'
import { AuthorLink } from '@presentation/features/chrome/AuthorLink'
import { useOpenVideo } from '@presentation/features/chrome/OpenAnother'
import { useT } from '@presentation/i18n/I18nProvider'
import { useEditor } from '@presentation/state/editorStore'

import { RecentProjects } from './RecentProjects'
import { SnipDemo } from './SnipDemo'

export function Welcome({ dropActive }: { readonly dropActive: boolean }) {
  const t = useT()
  const phase = useEditor((state) => state.phase)
  const opening = phase === 'opening'
  const choose = useOpenVideo()

  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden px-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="flex w-full max-w-[560px] flex-col items-center text-center"
      >
        <SnipDemo />

        <h1 className="mt-9 font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.025em] text-paper">
          {t('welcome.title')}
        </h1>

        <p className="mt-3 max-w-[400px] text-[13.5px] leading-relaxed text-muted">
          {t('welcome.subtitle')}
        </p>

        <Button
          tone="snip"
          size="lg"
          className="mt-8"
          onClick={() => void choose()}
          disabled={opening}
          icon={<Folder size={17} />}
        >
          {opening ? t('welcome.opening') : t('welcome.choose')}
        </Button>

        <p className="mt-6 text-[11.5px] tracking-wide text-faint">{t('welcome.formats')}</p>

        <RecentProjects />

        {/* Only on the welcome screen and in the shortcut sheet: a credit that
            is reachable but never sits beside anything being edited. */}
        <AuthorLink className="mt-7" />
      </motion.div>

      {/* The drop target is the whole window, so the cue covers it rather than
          sitting inside a small dashed box the pointer has to find. */}
      <AnimatePresence>
        {dropActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="pointer-events-none absolute inset-4 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-snip bg-ink/85 backdrop-blur-sm"
          >
            <span className="font-display text-[20px] font-semibold text-snip">
              {t('welcome.dropNow')}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
