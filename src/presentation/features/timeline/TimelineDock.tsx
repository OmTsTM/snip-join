import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'

import { formatDuration, span } from '@domain/time'
import { blockAt, gaps as timelineGaps } from '@domain/timeline'
import { EdgeScroll, Fit, Magnet, Redo, Split, Undo, ZoomIn, ZoomOut } from '@presentation/components/Icons'
import { IconButton } from '@presentation/components/primitives'
import { selectDragging, useMediaDrag } from '@presentation/features/inspector/mediaDrag'
import { useT } from '@presentation/i18n/I18nProvider'
import {
  selectCanRedo,
  selectCanUndo,
  selectDuration,
  selectHasCutPoints,
  selectKept,
  selectTimeline,
  useEditor,
} from '@presentation/state/editorStore'

import { BlockCard } from './BlockCard'
import { CutPoints } from './CutPoints'
import { blockHeightFor, canvasHeightFor, TOOLBAR_HEIGHT, TRACK_GAP } from './dockSize'
import { beginDragScroll, endDragScroll, selectFollowing, useDragScroll } from './dragScroll'
import { canvasWidth as canvasWidthFor, fitScale, pixelsToTime, timeToPixels, zoomAround } from './geometry'
import { Playhead } from './Playhead'
import { Ruler, RULER_HEIGHT } from './Ruler'
import { SelectionRails } from './SelectionRails'
import { StripLoading } from './StripLoading'
import type { Thumbnail } from '@presentation/state/editorStore'

/** Vertical offset of the block track inside the canvas. */
const TRACK_TOP = RULER_HEIGHT + TRACK_GAP

/** Movement, in pixels, before a press is treated as a drag rather than a click. */
const DRAG_THRESHOLD = 3

/** How close a drag has to come to an edge before the view starts following. */
const EDGE_BAND = 56

/** Fastest the view scrolls itself, in pixels per frame. */
const EDGE_SPEED = 22

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
  const surface = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [draggingBlock, setDraggingBlock] = useState<string | null>(null)
  const carrying = useMediaDrag(selectDragging)

  const timeline = useEditor(selectTimeline)
  const duration = useEditor(selectDuration)
  const kept = useEditor(selectKept)
  const sourceDuration = useEditor((state) => state.source?.duration ?? 0)
  const media = useEditor((state) => state.media)
  const thumbnails = useEditor((state) => state.thumbnails)
  const keyframes = useEditor((state) => state.keyframes)
  const snapToCutPoint = useEditor((state) => state.snapToCutPoint)
  const selectBlock = useEditor((state) => state.selectBlock)
  const selectedBlock = useEditor((state) => state.selectedBlock)
  const hasCutPoints = useEditor(selectHasCutPoints)
  const phase = useEditor((state) => state.phase)
  const pendingFrames = useEditor((state) => state.pendingFrames)
  // Covered from the moment a file is being prepared until the last frame has
  // landed, which is the whole stretch where the strip is visibly changing.
  const stripLoading = phase !== 'empty' && (phase !== 'ready' || pendingFrames > 0)
  const snapToCutPoints = useEditor((state) => state.snapToCutPoints)
  const setSnapToCutPoints = useEditor((state) => state.setSnapToCutPoints)
  const edgeScroll = useEditor((state) => state.edgeScroll)
  const setEdgeScroll = useEditor((state) => state.setEdgeScroll)
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

  const canvasWidth = canvasWidthFor(duration, pixelsPerSecond)
  const gaps = timelineGaps(timeline)

  // How much material each file holds, which decides whether a block's edges
  // are torn or clean. Built here rather than selected, because a selector
  // returning a fresh map on every call would re-render without end.
  const mediumDurations = useMemo(() => {
    const table: Record<string, number> = {}
    for (const medium of media) table[medium.path] = medium.maxDuration
    return table
  }, [media])

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

  /**
   * Where a file carried out of the media pool would land.
   *
   * Tracked here because this is the only part of the application that knows
   * the timeline's scale and scroll offset. The pool reads the answer when the
   * pointer comes up; letting go anywhere else drops the file rather than
   * placing it somewhere arbitrary.
   */
  useEffect(() => {
    if (!carrying) return

    const onMove = (event: PointerEvent) => {
      const viewport = scroller.current
      const track = surface.current
      if (!viewport || !track) return

      const bounds = viewport.getBoundingClientRect()
      const over =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom

      useMediaDrag
        .getState()
        .setTarget(
          over
            ? pixelsToTime(event.clientX - track.getBoundingClientRect().left, pixelsPerSecond)
            : null,
        )
    }

    window.addEventListener('pointermove', onMove)
    return () => {
      window.removeEventListener('pointermove', onMove)
      useMediaDrag.getState().setTarget(null)
    }
  }, [carrying, pixelsPerSecond])

  /**
   * Follows a drag that reaches the edge of the view.
   *
   * Without this, reordering across a long block means zooming out first: the
   * drop lands after every block whose midpoint the dragged one has passed, and
   * the midpoint of a five minute block is far off screen at any zoom that still
   * shows the frames. Scrolling under the pointer is what puts the far side of a
   * big block within reach.
   *
   * This only moves the view. Whatever is being carried recomputes itself from
   * the scroll it causes — the block card listens for it, and the media drop
   * target is recomputed on the next frame here.
   */
  /**
   * Whether the view should be following the pointer right now.
   *
   * A block being carried always counts, switch or no switch: the block has to
   * reach where it is going, and running out of window in the middle of placing
   * it leaves the user with no way to finish the gesture at all. The switch
   * governs the rest — trimming an edge, dragging a rail, carrying a file out of
   * the pool — where the view moving on its own is a convenience rather than the
   * difference between possible and impossible.
   */
  const following = useDragScroll(selectFollowing)
  const carryingAnything = draggingBlock !== null || (edgeScroll && (carrying || following))
  useEffect(() => {
    if (!carryingAnything) return

    let pointerX: number | null = null
    let frame = 0

    const follow = (event: PointerEvent) => {
      pointerX = event.clientX
    }

    const step = () => {
      frame = requestAnimationFrame(step)

      const viewport = scroller.current
      const canvas = surface.current
      if (!viewport || !canvas || pointerX === null) return

      const bounds = viewport.getBoundingClientRect()
      // Squared, so the view creeps at the edge of the band and races at the
      // very edge of the window rather than lurching the moment you enter it.
      const urgency = (over: number) => Math.min(1, over / EDGE_BAND) ** 2

      const before = viewport.scrollLeft
      if (pointerX < bounds.left + EDGE_BAND) {
        viewport.scrollLeft -= EDGE_SPEED * urgency(bounds.left + EDGE_BAND - pointerX)
      } else if (pointerX > bounds.right - EDGE_BAND) {
        viewport.scrollLeft += EDGE_SPEED * urgency(pointerX - (bounds.right - EDGE_BAND))
      }
      if (viewport.scrollLeft === before) return

      if (carrying) {
        useMediaDrag
          .getState()
          .setTarget(pixelsToTime(pointerX - canvas.getBoundingClientRect().left, pixelsPerSecond))
      }
    }

    window.addEventListener('pointermove', follow)
    frame = requestAnimationFrame(step)

    return () => {
      window.removeEventListener('pointermove', follow)
      cancelAnimationFrame(frame)
    }
  }, [carrying, carryingAnything, pixelsPerSecond])

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
      const viewport = canvas?.parentElement
      if (!canvas || !viewport) return

      // Read fresh on every move rather than captured once: the dock scrolls
      // itself when a drag reaches the edge of the window, and a cached left
      // edge would pull the mark backwards as the view travelled.
      const canvasLeft = () => canvas.getBoundingClientRect().left
      const originX = event.clientX
      // Snapping the anchor as well as the moving edge means a selection dragged
      // between two cut points is exact at both ends, which is what makes the
      // copy clean rather than merely close.
      const rawOrigin = pixelsToTime(event.clientX - canvasLeft(), pixelsPerSecond)
      const originTime = mode === 'select' ? snapToCutPoint(rawOrigin) : rawOrigin

      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      beginDragScroll()

      if (mode === 'scrub') seek(originTime)
      let dragged = false
      let pointerX = event.clientX

      const apply = () => {
        const at = pixelsToTime(pointerX - canvasLeft(), pixelsPerSecond)
        if (mode === 'scrub') seek(at)
        else setSelection(span(originTime, snapToCutPoint(at)))
      }

      const onScroll = () => {
        if (dragged) apply()
      }

      const onMove = (pointer: PointerEvent) => {
        pointerX = pointer.clientX

        if (!dragged && Math.abs(pointer.clientX - originX) < DRAG_THRESHOLD) return
        dragged = true

        apply()
      }

      const onUp = () => {
        // A press that never moved is a click: it moves the playhead and chooses
        // whichever block it landed on — nothing, on an empty stretch of track.
        // Hit-tested on the unsnapped instant, because snapping can pull the
        // position a frame past a seam and answer with the neighbour.
        //
        // It drops the rails only when it lands *outside* them. Clearing them
        // unconditionally is what made "mark the start here, move the playhead,
        // mark the end here" impossible: moving the playhead is exactly what you
        // do between the two, and it threw away the mark you had just set.
        // Clicking away from the marked stretch still means "start over".
        if (!dragged && mode === 'select') {
          const marked = useEditor.getState().selection
          const inside =
            marked !== null && rawOrigin >= marked.start && rawOrigin <= marked.end

          seek(originTime)
          if (!inside) setSelection(null)
          selectBlock(blockAt(timeline, rawOrigin)?.id ?? null)
        }
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
        viewport.removeEventListener('scroll', onScroll)
        endDragScroll()
      }

      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onUp)
      viewport.addEventListener('scroll', onScroll)
    },
    [pixelsPerSecond, seek, selectBlock, setSelection, snapToCutPoint, timeline],
  )

  // Only meaningful against a single source that has a length of its own. With
  // several files there is no "the original" to have removed anything from, and
  // the subtraction produced things like "7m 47s of 40s kept"; with a still
  // there is no total either, since its length is whatever the user makes it.
  const singleSource = useEditor(
    (state) => state.media.length === 1 && state.media[0]?.kind !== 'still',
  )
  const removed = singleSource ? Math.max(0, sourceDuration - kept) : 0
  const empty = timeline.blocks.length === 0

  return (
    <section
      className="relative flex shrink-0 flex-col bg-panel"
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
          disabled={!hasCutPoints}
        >
          <Magnet size={15} />
        </IconButton>

        {/* Off by default: a view that travels on its own while you are holding
            something is worse than one that makes you zoom out first. */}
        <IconButton
          label={t('timeline.edgeScroll')}
          active={edgeScroll}
          onClick={() => setEdgeScroll(!edgeScroll)}
        >
          <EdgeScroll size={15} />
        </IconButton>

        <div className="flex-1" />

        <div className="mr-2 flex items-center gap-3 text-[11px] text-faint">
          <span>
            {singleSource
              ? t('timeline.kept', {
                  kept: formatDuration(kept),
                  total: formatDuration(sourceDuration),
                })
              : t('timeline.length', { length: formatDuration(kept) })}
          </span>
          {removed > 0.05 && (
            <span className="text-snip-ink">{t('timeline.removed', { removed: formatDuration(removed) })}</span>
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

      {/*
        An empty track is a real state — deleting the last block is how you start
        over without closing the file — so it explains itself rather than looking
        broken.

        Placed over the dock rather than inside the canvas: with nothing on it
        the canvas is as wide as its own padding, and a message inside it wrapped
        into a thirty-pixel column.
      */}
      {empty && !stripLoading && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex items-center justify-center px-6"
          style={{ top: TOOLBAR_HEIGHT }}
        >
          <p className="text-[12px] text-faint">{t('timeline.empty')}</p>
        </div>
      )}

      <div
        ref={scroller}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        onWheel={onWheel}
        className="timeline-scroll relative overflow-x-auto overflow-y-hidden overscroll-x-none"
        style={{ height: canvasHeight }}
      >
        <div
          ref={surface}
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
                mediumDuration={mediumDurations[block.mediaId] ?? sourceDuration}
                thumbnails={thumbnails[block.mediaId] ?? EMPTY_FRAMES}
                height={blockHeight}
                dragging={draggingBlock === block.id}
                selected={selectedBlock === block.id}
                onDragStateChange={setDraggingBlock}
              />
            ))}

            <StripLoading visible={stripLoading} />
          </div>

          <CutPoints
            blocks={timeline.blocks}
            keyframes={keyframes}
            pixelsPerSecond={pixelsPerSecond}
            scrollLeft={scrollLeft}
            viewportWidth={viewportWidth}
            trackTop={TRACK_TOP}
          />

          <SelectionRails pixelsPerSecond={pixelsPerSecond} height={canvasHeight} />
          <Playhead pixelsPerSecond={pixelsPerSecond} height={canvasHeight} />
          <DropTarget pixelsPerSecond={pixelsPerSecond} height={canvasHeight} />
        </div>
      </div>
    </section>
  )
}

/**
 * Where a file carried out of the media pool is about to land.
 *
 * Dusk rather than orange: this adds material, and orange is the colour of
 * taking it away. Its own component so the sixty-hertz position it follows
 * re-renders one line instead of the whole dock.
 */
function DropTarget({
  pixelsPerSecond,
  height,
}: {
  readonly pixelsPerSecond: number
  readonly height: number
}) {
  const target = useMediaDrag((state) => state.target)
  if (target === null) return null

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-0 z-40"
      style={{ left: timeToPixels(target, pixelsPerSecond) - 1, height }}
    >
      <span className="absolute inset-y-0 left-0 w-[2px] bg-dusk-bright" />
      <span className="absolute -top-[1px] -left-[4px] h-[9px] w-[9px] rotate-45 bg-dusk-bright" />
    </div>
  )
}
