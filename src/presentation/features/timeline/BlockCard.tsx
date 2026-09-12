import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { duration as spanDuration, formatTimecode, snapTo } from '@domain/time'
import { snapCandidates, type Block, type Timeline } from '@domain/timeline'
import { ContextMenu, MENU_SEPARATOR, type MenuEntry } from '@presentation/components/ContextMenu'
import {
  Copy,
  Duplicate,
  MoveLeft,
  MoveRight,
  Paste,
  Scissors,
  Split,
  Trash,
} from '@presentation/components/Icons'
import { cx } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { useEditor, type Thumbnail } from '@presentation/state/editorStore'

import { beginDragScroll, endDragScroll } from './dragScroll'
import { Filmstrip } from './Filmstrip'
import { pixelsToTime, timeToPixels } from './geometry'

/**
 * Height of the grab handle, in pixels.
 *
 * It does not grow with the dock: it is a grip, and one that grew would take the
 * picture with it. Twenty was too mean to aim at, though — it is the only way to
 * pick a block up with a pointer, and a target a fifth of an inch tall asks the
 * user to be precise about something they should not have to think about. The
 * floor of the dock still leaves a filmstrip of forty-two pixels under it.
 */
export const HANDLE_HEIGHT = 28

/** How close a drag must come to an edge before it snaps, in pixels. */
const SNAP_PIXELS = 8

/**
 * Narrowest a block may be drawn, in pixels.
 *
 * A hairline rather than a usable target, on purpose. A floor wide enough to
 * grab is a floor that lies about where the block ends, and several short
 * blocks side by side each get drawn over the next — indistinguishable from the
 * overlap the timeline promises cannot happen, and exactly what a run of stills
 * looked like. It existed because a still reported a fortieth of a second and
 * came out two pixels wide; a still has a real length now, so the reason for it
 * is gone. A genuinely short piece is reached by zooming in.
 */
const MIN_BLOCK_WIDTH = 2

interface BlockCardProps {
  readonly block: Block
  readonly index: number
  readonly timeline: Timeline
  readonly pixelsPerSecond: number
  /**
   * How much material the block's own medium holds.
   *
   * Its own, not the project's first file: this decides whether an edge is torn
   * or clean, and comparing a second file's block against the first file's
   * length draws the mark on the wrong seams.
   */
  readonly mediumDuration: number
  readonly thumbnails: readonly Thumbnail[]
  /** Full height of the card, which the dock divider controls. */
  readonly height: number
  readonly dragging: boolean
  readonly selected: boolean
  readonly onDragStateChange: (id: string | null) => void
}

/**
 * One piece of the video on the timeline.
 *
 * Three separate gestures live on this card and they must never be ambiguous:
 * the handle moves the block, the edges trim it, and the body is left alone so a
 * drag across it marks a selection like any other part of the track. Separating
 * them by region rather than by modifier key is what makes the timeline usable
 * without instructions.
 */
export const BlockCard = memo(function BlockCard({
  block,
  index,
  timeline,
  pixelsPerSecond,
  mediumDuration,
  thumbnails,
  height,
  dragging,
  selected,
  onDragStateChange,
}: BlockCardProps) {
  const stripHeight = Math.max(1, height - HANDLE_HEIGHT)
  const t = useT()
  const moveBlock = useEditor((state) => state.moveBlock)
  const trimBlock = useEditor((state) => state.trimBlock)
  const beginGesture = useEditor((state) => state.beginGesture)
  const snapToCutPoint = useEditor((state) => state.snapToCutPoint)
  const selectBlock = useEditor((state) => state.selectBlock)
  const setSelection = useEditor((state) => state.setSelection)

  const settledLeft = timeToPixels(block.start, pixelsPerSecond)
  const width = Math.max(MIN_BLOCK_WIDTH, spanDuration(block.source) * pixelsPerSecond)

  /**
   * Where the card is drawn while it is in hand.
   *
   * It follows the pointer, and it has to: with the ends joined the block lands
   * in a *slot*, and slots are as wide as the blocks that hold them, so a card
   * pinned to its slot cannot also be under the hand moving it. Pinning it made
   * a drag across two blocks feel like it had stopped — the card sat half a
   * neighbour ahead of the pointer and waited for the next threshold.
   *
   * What made that look like an overlap was the lift being too timid to read as
   * one. Raised and inset now, with the slot it will drop into outlined
   * underneath, so the card is plainly above the row rather than in it.
   *
   * With holes allowed the position is literal and `start` already tracks the
   * pointer, so there is nothing to hold separately.
   */
  const [dragLeft, setDragLeft] = useState<number | null>(null)
  const floating = dragging && dragLeft !== null && timeline.mode === 'join'
  const left = floating ? dragLeft : settledLeft

  /**
   * A trim must not be animated.
   *
   * The width is the block's length, and the length is what the pointer is
   * setting: a transition means the drawn edge lags behind the drag by its own
   * duration. On a fast shrink the card is still wide while the filmstrip inside
   * it has already been laid out for the narrow result, which leaves the black
   * band that made the picture look like it had failed to load.
   */
  const [trimming, setTrimming] = useState(false)

  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)

  // Grab offset is kept in a ref: it is read on every pointer move and changing
  // it must never trigger a render.
  const grabOffset = useRef(0)
  /**
   * Where the pointer last was, so the drag can be replayed without one.
   *
   * The dock scrolls itself when a drag reaches the edge of the view, and that
   * moves the canvas out from under a pointer that has not moved. Replaying the
   * placement against the new scroll is what keeps the block following the
   * pointer instead of freezing the moment the view starts to travel.
   */
  const lastPointerX = useRef(0)
  const card = useRef<HTMLDivElement>(null)

  /**
   * Places the block for a pointer at `clientX`.
   *
   * Split out from the pointer handler because two different things ask for it:
   * the pointer moving, and the canvas moving under a still pointer.
   */
  const placeAt = useCallback(
    (clientX: number, canvas: HTMLElement) => {
      const canvasLeft = canvas.getBoundingClientRect().left
      const offset = clientX - canvasLeft - grabOffset.current
      const desired = pixelsToTime(offset, pixelsPerSecond)

      // Snapping is applied in time, using a pixel threshold, so it feels the
      // same at every zoom level rather than getting stickier as you zoom out.
      const snapped = snapTo(
        desired,
        snapCandidates(timeline, block.id),
        SNAP_PIXELS / pixelsPerSecond,
      )
      const at = Math.max(0, snapped)
      setDragLeft(timeToPixels(at, pixelsPerSecond))
      moveBlock(block.id, at)
    },
    [block.id, moveBlock, pixelsPerSecond, timeline],
  )

  const startMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()

      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)

      const canvas = target.closest('[data-timeline-canvas]') as HTMLElement | null
      if (!canvas) return

      const canvasLeft = canvas.getBoundingClientRect().left
      grabOffset.current = event.clientX - canvasLeft - settledLeft
      lastPointerX.current = event.clientX
      // Reaching for a block is choosing it, whether or not the drag goes
      // anywhere: letting go without moving still leaves it selected.
      selectBlock(block.id)
      beginDragScroll()
      // The rails mark instants on the timeline, and reordering moves the
      // footage out from under them: a stretch marked before the drag is over
      // different material afterwards. Dropping them is the only honest answer,
      // and leaving them behind made the block look like it was still about to
      // be cut while it was being carried.
      setSelection(null)
      beginGesture()
      setDragLeft(settledLeft)
      onDragStateChange(block.id)
    },
    [beginGesture, block.id, settledLeft, onDragStateChange, selectBlock, setSelection],
  )

  /**
   * Read through a ref so the subscription below does not have to be rebuilt.
   *
   * `placeAt` is a new function on every move — it closes over the timeline, and
   * the timeline is what the move just changed. Listing it as a dependency would
   * tear down and re-attach a window listener sixty times a second.
   */
  const place = useRef(placeAt)
  place.current = placeAt

  /**
   * The whole of the drag, listened for on the window.
   *
   * Not on the handle. Pointer capture is supposed to keep the moves coming back
   * to the element that was pressed wherever the pointer goes, and it does not
   * survive this card: the block is re-ordered in a keyed list as it travels, so
   * its node is moved in the document and Chromium drops the capture. What was
   * left worked only while the pointer happened to stay over the handle itself —
   * which is what a purely sideways drag does, the card following underneath it.
   * Move the pointer twenty pixels down onto the filmstrip and the events went to
   * an element with no handler, so the block stopped following and appeared to
   * jam. The window hears every move regardless of what is underneath, so there
   * is nothing left to lose.
   *
   * The scroll is listened for in the same place: the dock scrolls itself when a
   * drag reaches the edge of the view, which moves the canvas out from under a
   * pointer that has not moved, and replaying the last position is what keeps the
   * block with the pointer instead of freezing as the view travels.
   */
  useEffect(() => {
    if (!dragging) return

    const canvas = card.current?.closest('[data-timeline-canvas]') as HTMLElement | null
    const viewport = canvas?.parentElement
    if (!canvas || !viewport) return

    const onMove = (event: PointerEvent) => {
      lastPointerX.current = event.clientX
      place.current(event.clientX, canvas)
    }
    const onScroll = () => place.current(lastPointerX.current, canvas)

    window.addEventListener('pointermove', onMove)
    viewport.addEventListener('scroll', onScroll)
    return () => {
      window.removeEventListener('pointermove', onMove)
      viewport.removeEventListener('scroll', onScroll)
    }
  }, [dragging])

  const finishMove = useCallback(() => {
    // Cleared with the drag flag, so the card goes from the pointer's position
    // to its settled slot with the transition switched back on — the glide that
    // shows where it landed.
    setDragLeft(null)
    onDragStateChange(null)
    endDragScroll()
  }, [onDragStateChange])

  const endMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      finishMove()
    },
    [finishMove],
  )

  /**
   * The release, guaranteed.
   *
   * Pointer capture is supposed to deliver the release to the handle whatever it
   * is over, and it does not always survive the card being transformed out from
   * under the pointer mid-drag. Losing it leaves the block held: still lifted,
   * still following, with no way to put it down. The window always hears the
   * release, so this is what actually ends the gesture; the handler on the
   * handle stays because it is the one that releases the capture.
   */
  useEffect(() => {
    if (!dragging) return

    window.addEventListener('pointerup', finishMove)
    window.addEventListener('pointercancel', finishMove)
    return () => {
      window.removeEventListener('pointerup', finishMove)
      window.removeEventListener('pointercancel', finishMove)
    }
  }, [dragging, finishMove])

  const startTrim = useCallback(
    (edge: 'start' | 'end') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()

      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      selectBlock(block.id)
      beginGesture()
      beginDragScroll()
      setTrimming(true)

      const canvas = target.closest('[data-timeline-canvas]') as HTMLElement | null
      const viewport = canvas?.parentElement
      if (!canvas || !viewport) {
        endDragScroll()
        setTrimming(false)
        return
      }

      let pointerX = event.clientX

      const apply = () => {
        // The canvas rect is read on every move rather than captured once: the
        // dock scrolls itself when a trim reaches the edge of the window, and a
        // cached left edge would make the block shrink as the view travelled.
        const raw = pixelsToTime(pointerX - canvas.getBoundingClientRect().left, pixelsPerSecond)
        // A trimmed edge becomes an export boundary, so it snaps to cut points
        // for the same reason the selection rails do. Named explicitly, because
        // a trim reaches outside the block's current range and asking what sits
        // under the instant would answer with the neighbour.
        trimBlock(block.id, edge, snapToCutPoint(raw, block.id))
      }

      const onMove = (pointer: PointerEvent) => {
        pointerX = pointer.clientX
        apply()
      }

      // Replayed whenever the view scrolls out from under a still pointer, which
      // is the whole of what makes an edge at the far right reachable.
      const onScroll = () => apply()

      const onUp = () => {
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
        viewport.removeEventListener('scroll', onScroll)
        endDragScroll()
        setTrimming(false)
      }

      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onUp)
      viewport.addEventListener('scroll', onScroll)
    },
    [beginGesture, block.id, pixelsPerSecond, selectBlock, snapToCutPoint, trimBlock],
  )

  const openMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      // Before anything else: the window suppresses the browser's own menu in a
      // listener of its own, and stopping propagation here would keep the event
      // from ever reaching it.
      event.preventDefault()
      event.stopPropagation()
      selectBlock(block.id)
      setMenuAt({ x: event.clientX, y: event.clientY })
    },
    [block.id, selectBlock],
  )

  // A clean edge means the original boundary of the video; a torn edge means a
  // cut the user made. Showing the difference is what lets someone tell at a
  // glance which seams are theirs.
  const tornStart = block.source.start > 1e-3
  const tornEnd = block.source.end < mediumDuration - 1e-3

  const glide = 'left 200ms cubic-bezier(0.22,1,0.36,1), width 180ms cubic-bezier(0.22,1,0.36,1)'
  const lift = 'transform 140ms cubic-bezier(0.22,1,0.36,1)'

  return (
    <>
      {/*
        The slot the block will drop into, outlined where it will land.

        With the ends joined there can be no holes, so the space a carried block
        leaves behind would otherwise read as one — the mode says it is
        impossible and the timeline would appear to show it anyway. This says
        "reserved", and it is the only thing on screen that tells you where the
        drop goes while the card is under your hand.
      */}
      {floating && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 z-[5] rounded-[var(--radius-block)] border border-dashed border-paper/45 bg-paper/[0.06]"
          style={{ left: settledLeft, width, height, transition: glide }}
        />
      )}

      <div
        ref={card}
        className={cx(
          'group absolute top-0 select-none',
          dragging ? 'z-30' : selected ? 'z-[15]' : 'z-10',
        )}
        onContextMenu={openMenu}
        style={{
          left,
          width,
          height,
          // Raised and inset far enough to read as held above the row rather
          // than sitting in it: the block underneath shows along every edge.
          transform: floating ? 'translateY(-11px) scale(0.93)' : undefined,
          transition: dragging || trimming ? lift : `${glide}, ${lift}`,
        }}
      >
      <div
        className={cx(
          'relative h-full overflow-hidden rounded-[var(--radius-block)] border',
          'transition-[border-color,box-shadow] duration-150',
          dragging
            ? 'border-snip shadow-[0_22px_48px_-14px_rgba(0,0,0,0.95),0_0_0_1px_rgba(249,129,30,0.55)]'
            : selected
              // Paper, not orange. Orange is the colour of cutting, and choosing
              // a block removes nothing — it says which piece the keyboard, the
              // menu and the clipboard are about to act on. A ring outside the
              // border rather than a thicker border, so the card does not change
              // size the moment it is picked.
              ? 'border-paper shadow-[0_0_0_1.5px_var(--color-paper),0_16px_36px_-18px_rgba(244,230,214,0.5)]'
              : 'border-line-bright group-hover:border-faint',
        )}
      >
        {/* The grab handle. Knurled so it reads as something to hold. */}
        <div
          onPointerDown={startMove}
          onPointerUp={endMove}
          onPointerCancel={endMove}
          title={`${t('blocks.drag')} · ${formatTimecode(spanDuration(block.source))}`}
          className={cx(
            'knurl relative flex touch-none items-center gap-1.5 px-1.5',
            'cursor-grab active:cursor-grabbing',
            dragging
              ? 'bg-snip text-ink'
              : selected
                ? 'bg-paper text-ink'
                : 'bg-raised-hi text-paper',
          )}
          style={{ height: HANDLE_HEIGHT }}
        >
          <span
            className={cx(
              'timecode flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] px-1 text-[9.5px] font-bold leading-none',
              dragging ? 'bg-ink text-snip' : 'bg-ink text-paper',
            )}
          >
            {index + 1}
          </span>

          {width > 96 && (
            <span className="timecode truncate text-[9.5px] opacity-70">
              {formatTimecode(block.start, { frames: false })}
            </span>
          )}
        </div>

        <div className="relative" style={{ height: stripHeight }}>
          <Filmstrip source={block.source} width={width} height={stripHeight} thumbnails={thumbnails} />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent to-ink/35" />
        </div>

        {tornStart && <TornEdge side="left" />}
        {tornEnd && <TornEdge side="right" />}
      </div>

      {/* Trim targets sit just inside each edge, wide enough to hit without
          overlapping the handle above them. */}
      <div
        onPointerDown={startTrim('start')}
        title={t('blocks.trimStart')}
        className="absolute left-0 w-[7px] cursor-ew-resize"
        style={{ top: HANDLE_HEIGHT, height: stripHeight }}
      >
        <span className="absolute inset-y-2 left-[2px] w-[2px] rounded-full bg-paper/0 transition-colors duration-150 group-hover:bg-paper/45" />
      </div>
      <div
        onPointerDown={startTrim('end')}
        title={t('blocks.trimEnd')}
        className="absolute right-0 w-[7px] cursor-ew-resize"
        style={{ top: HANDLE_HEIGHT, height: stripHeight }}
      >
        <span className="absolute inset-y-2 right-[2px] w-[2px] rounded-full bg-paper/0 transition-colors duration-150 group-hover:bg-paper/45" />
      </div>

        {menuAt && (
          <BlockMenu block={block} index={index} at={menuAt} onClose={() => setMenuAt(null)} />
        )}
      </div>
    </>
  )
})

/**
 * Everything that can be done to one block, in one place.
 *
 * A separate component so the entries — and the store reads they need — are
 * built only while the menu is actually open, rather than on every frame of a
 * sixty-hertz drag.
 */
function BlockMenu({
  block,
  index,
  at,
  onClose,
}: {
  readonly block: Block
  readonly index: number
  readonly at: { readonly x: number; readonly y: number }
  readonly onClose: () => void
}) {
  const t = useT()
  const timeline = useEditor((state) => state.history.present)
  const hasClipboard = useEditor((state) => state.clipboard !== null)
  const copyBlock = useEditor((state) => state.copyBlock)
  const cutBlock = useEditor((state) => state.cutBlock)
  const pasteAtPlayhead = useEditor((state) => state.pasteAtPlayhead)
  const duplicateBlock = useEditor((state) => state.duplicateBlock)
  const splitAtPlayhead = useEditor((state) => state.splitAtPlayhead)
  const shiftBlock = useEditor((state) => state.shiftBlock)
  const deleteBlock = useEditor((state) => state.deleteBlock)

  const last = timeline.blocks.length - 1
  const only = timeline.blocks.length <= 1

  const entries: MenuEntry[] = [
    {
      id: 'copy',
      label: t('blocks.copy'),
      shortcut: 'Ctrl C',
      icon: <Copy size={14} />,
      onSelect: () => copyBlock(block.id),
    },
    {
      id: 'cut',
      label: t('blocks.cut'),
      shortcut: 'Ctrl X',
      icon: <Scissors size={14} />,
      disabled: only,
      onSelect: () => cutBlock(block.id),
    },
    {
      id: 'paste',
      label: t('blocks.paste'),
      shortcut: 'Ctrl V',
      icon: <Paste size={14} />,
      disabled: !hasClipboard,
      onSelect: pasteAtPlayhead,
    },
    MENU_SEPARATOR,
    {
      id: 'duplicate',
      label: t('blocks.duplicate'),
      icon: <Duplicate size={14} />,
      onSelect: () => duplicateBlock(block.id),
    },
    {
      id: 'split',
      label: t('blocks.split'),
      shortcut: 'S',
      icon: <Split size={14} />,
      onSelect: splitAtPlayhead,
    },
    MENU_SEPARATOR,
    {
      id: 'earlier',
      label: t('blocks.moveEarlier'),
      shortcut: 'Alt ←',
      icon: <MoveLeft size={14} />,
      disabled: index === 0,
      onSelect: () => shiftBlock(block.id, -1),
    },
    {
      id: 'later',
      label: t('blocks.moveLater'),
      shortcut: 'Alt →',
      icon: <MoveRight size={14} />,
      disabled: index === last,
      onSelect: () => shiftBlock(block.id, 1),
    },
    MENU_SEPARATOR,
    {
      id: 'delete',
      label: t('blocks.delete'),
      shortcut: 'Del',
      icon: <Trash size={14} />,
      tone: 'snip',
      disabled: only,
      onSelect: () => deleteBlock(block.id),
    },
  ]

  return <ContextMenu at={at} entries={entries} onClose={onClose} />
}

/**
 * The zigzag left where the strip was cut.
 *
 * Drawn as a repeating gradient rather than an image so it stays crisp at any
 * height and costs nothing to render.
 */
function TornEdge({ side }: { readonly side: 'left' | 'right' }) {
  return (
    <span
      aria-hidden="true"
      className={cx('pointer-events-none absolute inset-y-0 w-[5px]', side === 'left' ? 'left-0' : 'right-0')}
      style={{
        background: `repeating-linear-gradient(${side === 'left' ? '135deg' : '45deg'}, var(--color-snip) 0 1.5px, transparent 1.5px 5px)`,
        opacity: 0.55,
      }}
    />
  )
}
