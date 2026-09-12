import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'

import { formatDuration, span } from '@domain/time'
import { gaps as timelineGaps } from '@domain/timeline'
import { Fit, Magnet, Redo, Split, Undo, ZoomIn, ZoomOut } from '@presentation/components/Icons'
import { IconButton } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import {
  selectCanRedo,
  selectCanUndo,
  selectDuration,
  selectKept,
  selectTimeline,
  useEditor,
} from '@presentation/state/editorStore'

import { BlockCard } from './BlockCard'
import { CutPoints } from './CutPoints'
import { blockHeightFor, canvasHeightFor, TOOLBAR_HEIGHT, TRACK_GAP } from './dockSize'
import { fitScale, pixelsToTime, timeToPixels, TIMELINE_PADDING, zoomAround } from './geometry'
import { Playhead } from './Playhead'
import { Ruler, RULER_HEIGHT } from './Ruler'
import { SelectionRails } from './SelectionRails'
import { StripLoading } from './StripLoading'
import type { Thumbnail } from '@presentation/state/editorStore'

/** Vertical offset of the block track inside the canvas. */
const TRACK_TOP = RULER_HEIGHT + TRACK_GAP

/** Movement, in pixels, before a press is treated as a drag rather than a click. */
const DRAG_THRESHOLD = 3

/**
 * One shared empty list.
 *
 * A fresh `[]` per render for a medium whose frames have not landed yet would
 * be a new reference every time, which defeats the memo on the block card and
 * re-renders every strip on the timeline sixty times a second.
 */
const EMPTY_FRAMES: readonly Thumbnail[] = []

export function TimelineDock() {
  const t = useT()

  const scroller = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [draggingBlock, setDraggingBlock] = useState<string | null>(null)

  const timeline = useEditor(selectTimeline)
  const duration = useEditor(selectDuration)
  const kept = useEditor(selectKept)
  const sourceDuration = useEditor((state) => state.source?.duration ?? 0)
  const thumbnails = useEditor((state) => state.thumbnails)
  const keyframes = useEditor((state) => state.keyframes)
  const snapToCutPoint = useEditor((state) => state.snapToCutPoint)
  const phase = useEditor((state) => state.phase)
  const pendingFrames = useEditor((state) => state.pendingFrames)
  // Covered from the moment a file is being prepared until the last frame has
  // landed, which is the whole stretch where the strip is visibly changing.
  const stripLoading = phase !== 'empty' && (phase !== 'ready' || pendingFrames > 0)
  const snapToCutPoints = useEditor((state) => state.snapToCutPoints)
  const setSnapToCutPoints = useEditor((state) => state.setSnapToCutPoints)
  const dockHeight = useEditor((state) => state.timelineHeight)

  // Everything vertical is derived from the one number the divider controls, so
  // the toolbar, the ruler, the track and each block cannot drift apart.
  const canvasHeight = canvasHeightFor(dockHeight)
  const blockHeight = blockHeightFor(dockHeight)
  const pixelsPerSecond = useEditor((state) => state.pixelsPerSecond)
  const setPixelsPerSecond = useEditor((state) => state.setPixelsPerSecond)
  const seek = useEditor((state) => state.seek)
  const setSelection = useEditor((state) => state.setSelection)
  const splitAtPlayhead = useEditor((state) => state.splitAtPlayhead)
  const undo = useEditor((state) => state.undo)
  const redo = useEditor((state) => state.redo)
  const canUndo = useEditor(selectCanUndo)
  const canRedo = useEditor(selectCanRedo)

  const canvasWidth = TIMELINE_PADDING * 2 + duration * pixelsPerSecond
  const gaps = timelineGaps(timeline)

  // Track the viewport so ticks and the fit control know how much room there is.
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setViewportWidth(entry.contentRect.width)
    })
    observer.observe(element)
    setViewportWidth(element.clientWidth)

    return () => observer.disconnect()
  }, [])

  const fit = useCallback(() => {
    if (viewportWidth > 0 && duration > 0) setPixelsPerSecond(fitScale(duration, viewportWidth))
  }, [duration, setPixelsPerSecond, viewportWidth])

  // A newly opened video starts fitted, which is the only scale that shows what
  // you just opened. Later edits leave the user's zoom alone.
  const fittedFor = useRef<number>(0)
  useEffect(() => {
    if (sourceDuration > 0 && viewportWidth > 0 && fittedFor.current !== sourceDuration) {
      fittedFor.current = sourceDuration
      setPixelsPerSecond(fitScale(sourceDuration, viewportWidth))
    }
  }, [setPixelsPerSecond, sourceDuration, viewportWidth])

  const zoomBy = useCallback(
    (factor: number, anchorOffset?: number) => {
      const element = scroller.current
      const current = useEditor.getState().pixelsPerSecond
      const next = Math.min(Math.max(current * factor, 0.5), 800)
      if (next === current) return

      setPixelsPerSecond(next)

      if (element) {
        const anchor = anchorOffset ?? element.clientWidth / 2
        element.scrollLeft = zoomAround(current, next, element.scrollLeft, anchor)
      }
    },
    [setPixelsPerSecond],
  )

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const element = scroller.current
      if (!element) return

      if (event.ctrlKey || event.metaKey) {
        // Zoom around the pointer rather than the centre, so the frame being
        // inspected stays put.
        const anchor = event.clientX - element.getBoundingClientRect().left
        zoomBy(event.deltaY < 0 ? 1.18 : 1 / 1.18, anchor)
        return
      }

      // A vertical wheel scrolls the timeline sideways, which is what a wheel
      // means on a horizontal surface.
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      element.scrollLeft += delta
    },
    [zoomBy],
  )

  /** Scrubbing on the ruler, and marking a selection on the track. */
  const startTrackGesture = useCallback(
    (mode: 'scrub' | 'select') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      const canvas = event.currentTarget.closest('[data-timeline-canvas]') as HTMLElement | null
      if (!canvas) return

      const canvasLeft = canvas.getBoundingClientRect().left
      const originX = event.clientX
      // Snapping the anchor as well as the moving edge means a selection dragged
      // between two cut points is exact at both ends, which is what makes the
      // copy clean rather than merely close.
      const rawOrigin = pixelsToTime(event.clientX - canvasLeft, pixelsPerSecond)
      const originTime = mode === 'select' ? snapToCutPoint(rawOrigin) : rawOrigin

      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)

      if (mode === 'scrub') seek(originTime)
      let dragged = false

      const onMove = (pointer: PointerEvent) => {
        const at = pixelsToTime(pointer.clientX - canvasLeft, pixelsPerSecond)

        if (!dragged && Math.abs(pointer.clientX - originX) < DRAG_THRESHOLD) return
        dragged = true

        if (mode === 'scrub') seek(at)
        else setSelection(span(originTime, snapToCutPoint(at)))
      }

      const onUp = () => {
        // A press that never moved is a click: it moves the playhead and drops
        // any selection, which is what clicking an empty area should do.
        if (!dragged && mode === 'select') {
          seek(originTime)
          setSelection(null)
        }
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
      }

      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onUp)
    },
    [pixelsPerSecond, seek, setSelection, snapToCutPoint],
  )

  const removed = Math.max(0, sourceDuration - kept)

  return (
    <section
      className="flex shrink-0 flex-col bg-panel"
      style={{ height: dockHeight }}
    >
      <header
        className="flex shrink-0 items-center gap-1 px-3"
        style={{ height: TOOLBAR_HEIGHT }}
      >
        <IconButton label={t('history.undo')} onClick={undo} disabled={!canUndo}>
          <Undo size={15} />
        </IconButton>
        <IconButton label={t('history.redo')} onClick={redo} disabled={!canRedo}>
          <Redo size={15} />
        </IconButton>

        <span className="mx-1.5 h-4 w-px bg-line" />

        <IconButton label={t('blocks.split')} onClick={splitAtPlayhead}>
          <Split size={15} />
        </IconButton>

        <span className="mx-1.5 h-4 w-px bg-line" />

        {/* On by default: the default export copies the streams, and a copy can
            only begin on a cut point. Turning it off trades an instant export
            for the ability to cut on any frame. */}
        <IconButton
          label={t('timeline.snapCuts')}
          active={snapToCutPoints}
          onClick={() => setSnapToCutPoints(!snapToCutPoints)}
          disabled={keyframes.length === 0}
        >
          <Magnet size={15} />
        </IconButton>

        <div className="flex-1" />

        <div className="mr-2 flex items-center gap-3 text-[11px] text-faint">
          <span>{t('timeline.kept', { kept: formatDuration(kept), total: formatDuration(sourceDuration) })}</span>
          {removed > 0.05 && (
            <span className="text-snip">{t('timeline.removed', { removed: formatDuration(removed) })}</span>
          )}
        </div>

        <IconButton label={t('timeline.zoomOut')} onClick={() => zoomBy(1 / 1.4)}>
          <ZoomOut size={15} />
        </IconButton>
        <IconButton label={t('timeline.fit')} onClick={fit}>
          <Fit size={15} />
        </IconButton>
        <IconButton label={t('timeline.zoomIn')} onClick={() => zoomBy(1.4)}>
          <ZoomIn size={15} />
        </IconButton>
      </header>

      <div
        ref={scroller}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        onWheel={onWheel}
        className="relative overflow-x-auto overflow-y-hidden overscroll-x-none"
        style={{ height: canvasHeight }}
      >
        <div
          data-timeline-canvas
          className="relative"
          style={{ width: canvasWidth, height: canvasHeight }}
        >
          <Ruler
            pixelsPerSecond={pixelsPerSecond}
            scrollLeft={scrollLeft}
            viewportWidth={viewportWidth}
            duration={duration}
          />

          {/* Scrub strip. Sits over the ruler so the whole label area is
              draggable, which is where people reach for a playhead. */}
          <div
            onPointerDown={startTrackGesture('scrub')}
            className="absolute inset-x-0 top-0 cursor-ew-resize"
            style={{ height: RULER_HEIGHT }}
          />

          <div
            onPointerDown={startTrackGesture('select')}
            className="absolute inset-x-0"
            style={{ top: TRACK_TOP, height: blockHeight }}
          >
            <div className="absolute inset-0 rounded-[var(--radius-block)] bg-ink/60" />

            {/* Holes. Dusk hatching, because a hole is a finished result rather
                than a pending cut. */}
            {gaps.map((gap) => (
              <div
                key={`${gap.start}-${gap.end}`}
                title={t('blocks.hole')}
                className="hatched absolute top-0 rounded-[3px] border border-dashed border-dusk-lift/30 bg-dusk/20"
                style={{
                  left: timeToPixels(gap.start, pixelsPerSecond),
                  width: Math.max(1, (gap.end - gap.start) * pixelsPerSecond),
                  height: blockHeight,
                }}
              />
            ))}

            {timeline.blocks.map((block, index) => (
              <BlockCard
                key={block.id}
                block={block}
                index={index}
                timeline={timeline}
                pixelsPerSecond={pixelsPerSecond}
                sourceDuration={sourceDuration}
                thumbnails={thumbnails[block.mediaId] ?? EMPTY_FRAMES}
                height={blockHeight}
                dragging={draggingBlock === block.id}
                onDragStateChange={setDraggingBlock}
              />
            ))}

            <StripLoading visible={stripLoading} />
          </div>

          <CutPoints
            keyframes={keyframes}
            pixelsPerSecond={pixelsPerSecond}
            scrollLeft={scrollLeft}
            viewportWidth={viewportWidth}
            trackTop={TRACK_TOP}
          />

          <SelectionRails pixelsPerSecond={pixelsPerSecond} height={canvasHeight} />
          <Playhead pixelsPerSecond={pixelsPerSecond} height={canvasHeight} />
        </div>
      </div>
    </section>
  )
}
