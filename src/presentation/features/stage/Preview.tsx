import { AnimatePresence, motion } from 'motion/react'
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'

import { aspectRatio } from '@domain/media'
import { sourceAt } from '@domain/timeline'
import { Hole } from '@presentation/components/Icons'
import { ProgressBar } from '@presentation/components/primitives'
import { usePlayback } from '@presentation/hooks/usePlayback'
import { useT } from '@presentation/i18n/I18nProvider'
import {
  selectActiveMedia,
  selectIsProxy,
  selectPreviewUrl,
  selectTimeline,
  useEditor,
} from '@presentation/state/editorStore'

export function Preview() {
  const t = useT()
  const video = useRef<HTMLVideoElement>(null)

  const previewUrl = useEditor(selectPreviewUrl)
  const source = useEditor((state) => state.source)
  const media = useEditor((state) => state.media)
  const activeMedia = useEditor(selectActiveMedia)
  const isProxy = useEditor(selectIsProxy)
  const phase = useEditor((state) => state.phase)
  const proxyProgress = useEditor((state) => state.proxyProgress)

  usePlayback(video)

  /**
   * The shape of the picture actually on screen, not of the project's first
   * file.
   *
   * They are usually the same file and often the same shape, and when they are
   * not the frame was drawn to the wrong one: a portrait clip in a project that
   * opened with a landscape file sat pillarboxed inside a wide black box. The
   * frame is what the eye reads as the edge of the video, so it follows what is
   * being shown. `source` remains the fallback, since it is what decides the
   * output format and is the only thing there is before a block is under the
   * playhead.
   *
   * Derived in a memo rather than in a selector: it is an object, and a selector
   * that builds one on every call never compares equal to itself.
   */
  const ratio = useMemo(() => {
    const showing = activeMedia ? media.find((medium) => medium.path === activeMedia) : undefined
    return aspectRatio((showing ?? source)?.video ?? null)
  }, [activeMedia, media, source])
  const preparing = phase === 'preparing'

  const area = useRef<HTMLDivElement>(null)
  const size = useFittedSize(area, ratio)

  return (
    <div className="flex min-h-0 flex-1 p-6">
      <div ref={area} className="relative min-h-0 min-w-0 flex-1">
        <div
          className="absolute left-1/2 top-1/2 overflow-hidden rounded-xl border border-line bg-ink-deep shadow-[0_30px_70px_-40px_rgba(0,0,0,0.95)]"
          style={{
            width: size?.width ?? 0,
            height: size?.height ?? 0,
            // Laid over the measured area rather than inside it, so the frame's
            // own size can never feed back into the size it was measured from.
            transform: 'translate(-50%, -50%)',
            visibility: size ? 'visible' : 'hidden',
          }}
        >
          {previewUrl && (
            <video
              ref={video}
              src={previewUrl}
              preload="auto"
              playsInline
              // Controls are deliberately absent: the transport below is the
              // only one, so there is never a second playhead disagreeing with
              // the timeline.
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
    </div>
  )
}

/**
 * The largest box of a given shape that fits the space there is.
 *
 * Measured rather than guessed. This used to be a stylesheet calculation with
 * the height of everything else on screen written into it as a number, which was
 * true on the day it was written and wrong from the first time a band moved: the
 * frame was then capped by a height it no longer had, kept the width it had
 * already taken, and stopped matching the picture's shape - so the video sat
 * letterboxed inside its own frame, with the border floating out around it.
 * Nothing here has to be revisited when the layout changes.
 */
function useFittedSize(
  area: RefObject<HTMLDivElement | null>,
  ratio: number,
): { readonly width: number; readonly height: number } | null {
  const [space, setSpace] = useState<{ width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    const node = area.current
    if (!node) return

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (!box) return
      setSpace((previous) => {
        // Sub-pixel churn is filtered out: the observer reports fractions, and
        // re-rendering on a hundredth of a pixel is work for nothing.
        if (
          previous &&
          Math.abs(previous.width - box.width) < 0.5 &&
          Math.abs(previous.height - box.height) < 0.5
        ) {
          return previous
        }
        return { width: box.width, height: box.height }
      })
    })

    observer.observe(node)
    return () => observer.disconnect()
  }, [area])

  if (!space || space.width < 1 || space.height < 1) return null

  const wide = space.width / space.height > ratio
  const width = wide ? space.height * ratio : space.width
  const height = wide ? space.height : space.width / ratio

  // Floored so the frame's border is never the half pixel that overflows the
  // area and puts a scrollbar on the stage.
  return { width: Math.floor(width), height: Math.floor(height) }
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
