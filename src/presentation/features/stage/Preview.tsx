import { AnimatePresence, motion } from 'motion/react'
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'

import { aspectRatio } from '@domain/media'
import { clamp } from '@domain/time'
import { sourceAt } from '@domain/timeline'
import { Hole } from '@presentation/components/Icons'
import { cx, ProgressBar } from '@presentation/components/primitives'
import { usePlayback } from '@presentation/hooks/usePlayback'
import { useT } from '@presentation/i18n/I18nProvider'
import {
  selectActiveMedia,
  selectDuration,
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
  const togglePlay = useEditor((state) => state.togglePlay)

  const area = useRef<HTMLDivElement>(null)
  const size = useFittedSize(area, ratio)

  return (
    <div className="flex min-h-0 flex-1 p-6">
      <div ref={area} className="relative min-h-0 min-w-0 flex-1">
        <div
          // The picture is a player as well as a monitor: a click on it plays
          // or pauses, and the bar along its bottom edge walks through the
          // edit. Both move the same playhead the timeline shows, so there is
          // never a second position to disagree with the first.
          onClick={() => {
            if (!preparing && previewUrl) togglePlay()
          }}
          className="group/stage absolute left-1/2 top-1/2 overflow-hidden rounded-xl border border-line bg-ink-deep shadow-[var(--shadow-stage)]"
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

          {!preparing && previewUrl && <ScrubBar />}

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
 * The strip along the bottom of the picture that walks through the edit.
 *
 * Faint until the pointer is over the picture, like the bar of any player.
 * Pressing anywhere on it puts the playhead there, and dragging keeps it under
 * the pointer; the timeline below follows, because this moves the one clock
 * everything reads. Its own component, subscribed to the playhead, so the
 * sixty-hertz position re-renders a bar and not the stage.
 *
 * Paper, not orange: orange means cutting, and this cuts nothing.
 */
function ScrubBar() {
  const t = useT()
  const playhead = useEditor((state) => state.playhead)
  const duration = useEditor(selectDuration)
  const seek = useEditor((state) => state.seek)
  const track = useRef<HTMLDivElement>(null)

  const apply = useCallback(
    (clientX: number) => {
      const node = track.current
      if (!node || duration <= 0) return
      const box = node.getBoundingClientRect()
      if (box.width <= 0) return
      seek(clamp((clientX - box.left) / box.width, 0, 1) * duration)
    },
    [duration, seek],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      // The picture behind would take this as a click and pause; the bar
      // means a position, not a toggle.
      event.stopPropagation()
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      apply(event.clientX)
    },
    [apply],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
      apply(event.clientX)
    },
    [apply],
  )

  const fraction = duration > 0 ? clamp(playhead / duration, 0, 1) : 0

  return (
    <div
      onClick={(event) => event.stopPropagation()}
      className={cx(
        'absolute inset-x-0 bottom-0 z-20 flex items-end px-3 pb-2.5 pt-6',
        'bg-gradient-to-t from-ink-deep/70 to-transparent',
        'opacity-0 transition-opacity duration-200 group-hover/stage:opacity-100 focus-within:opacity-100',
      )}
    >
      <div
        ref={track}
        role="slider"
        aria-label={t('preview.scrub')}
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={playhead}
        tabIndex={0}
        title={t('preview.scrub')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        className="group/bar relative h-4 w-full cursor-pointer touch-none"
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-paper/25 transition-[height] duration-150 group-hover/bar:h-1.5">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-paper"
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-paper shadow-[0_1px_4px_rgba(0,0,0,0.6)] transition-transform duration-150 group-hover/bar:scale-110"
          style={{ left: `${fraction * 100}%` }}
        />
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
