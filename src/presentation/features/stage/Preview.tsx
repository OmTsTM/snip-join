import { AnimatePresence, motion } from 'motion/react'
import { useRef } from 'react'

import { aspectRatio } from '@domain/media'
import { sourceAt } from '@domain/timeline'
import { Hole } from '@presentation/components/Icons'
import { ProgressBar } from '@presentation/components/primitives'
import { usePlayback } from '@presentation/hooks/usePlayback'
import { useT } from '@presentation/i18n/I18nProvider'
import { selectTimeline, useEditor } from '@presentation/state/editorStore'

export function Preview() {
  const t = useT()
  const video = useRef<HTMLVideoElement>(null)

  const previewUrl = useEditor((state) => state.previewUrl)
  const source = useEditor((state) => state.source)
  const isProxy = useEditor((state) => state.isProxy)
  const phase = useEditor((state) => state.phase)
  const proxyProgress = useEditor((state) => state.proxyProgress)

  usePlayback(video)

  const ratio = aspectRatio(source?.video ?? null)
  const preparing = phase === 'preparing'

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div
        className="relative max-h-full w-full overflow-hidden rounded-xl border border-line bg-ink-deep shadow-[0_30px_70px_-40px_rgba(0,0,0,0.95)]"
        style={{ aspectRatio: ratio, maxWidth: `calc((100vh - 300px) * ${ratio})` }}
      >
        {previewUrl && (
          <video
            ref={video}
            src={previewUrl}
            preload="auto"
            playsInline
            // Controls are deliberately absent: the transport below is the only
            // one, so there is never a second playhead disagreeing with the
            // timeline.
            className="h-full w-full bg-ink-deep object-contain"
          />
        )}

        <GapCurtain label={t('preview.hole')} note={t('preview.holeNote')} />

        {isProxy && !preparing && (
          <span
            title={t('preview.proxyTooltip')}
            className="absolute bottom-3 right-3 rounded-md border border-line-bright bg-ink/80 px-2 py-1 text-[10.5px] font-medium tracking-wide text-muted backdrop-blur"
          >
            {t('preview.proxyBadge')}
          </span>
        )}

        <AnimatePresence>
          {preparing && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink-deep/92 px-10 text-center backdrop-blur-sm"
            >
              <p className="font-display text-[16px] font-semibold text-paper">
                {t('preview.preparing')}
              </p>
              <div className="w-full max-w-[280px]">
                <ProgressBar value={proxyProgress} tone="dusk" />
              </div>
              <p className="max-w-[340px] text-[11.5px] leading-relaxed text-faint">
                {t('preview.preparingNote')}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/**
 * Covers the picture while the playhead sits in a hole.
 *
 * Subscribed narrowly to the playhead so only this component re-renders as the
 * clock advances, rather than the whole stage sixty times a second.
 */
function GapCurtain({ label, note }: { readonly label: string; readonly note: string }) {
  const playhead = useEditor((state) => state.playhead)
  const timeline = useEditor(selectTimeline)
  const inGap = sourceAt(timeline, playhead) === null && timeline.blocks.length > 0

  return (
    <AnimatePresence>
      {inGap && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black"
        >
          <Hole size={26} className="text-dusk-lift/70" />
          <span className="text-[12px] font-medium tracking-wide text-dusk-lift/90">{label}</span>
          <span className="text-[11px] text-faint">{note}</span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
