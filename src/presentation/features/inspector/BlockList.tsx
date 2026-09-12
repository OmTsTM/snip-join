import { AnimatePresence, Reorder, useDragControls } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { duration as spanDuration, formatTimecode } from '@domain/time'
import { blockEnd, type Block, type BlockId } from '@domain/timeline'
import { Grip, Trash } from '@presentation/components/Icons'
import { cx } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { selectTimeline, useEditor } from '@presentation/state/editorStore'

/**
 * The running order, as a list.
 *
 * The timeline shows where blocks sit; this shows what order they play in and
 * which part of the original each one came from. That second fact is invisible
 * on the timeline once blocks have been reordered, and it is what tells the user
 * which piece is which.
 *
 * Two states are drawn here and they are not the same thing: a row is *playing*
 * when the playhead is inside it, and *chosen* when it is the block the
 * keyboard, the clipboard and the block menu act on. Clicking a row does both.
 *
 * The order can also be changed here, by dragging a row up or down. Reordering
 * on the timeline means finding room in a horizontal strip; reordering a list
 * means dropping a row between two others, and for "play this piece third
 * instead of first" the list is the direct way to say it.
 */
export function BlockList() {
  const t = useT()
  const timeline = useEditor(selectTimeline)
  const seek = useEditor((state) => state.seek)
  const deleteBlock = useEditor((state) => state.deleteBlock)
  const selectBlock = useEditor((state) => state.selectBlock)
  const reorderBlock = useEditor((state) => state.reorderBlock)
  const selectedBlock = useEditor((state) => state.selectedBlock)
  const playhead = useEditor((state) => state.playhead)

  const count = timeline.blocks.length

  /**
   * The order while a row is being carried, or nothing when none is.
   *
   * A drag has to rearrange the list under the hand at every step, and the
   * timeline must not be rewritten that many times: the edit is one decision —
   * where the row was let go — and one entry in the undo history. So the drag
   * runs against this copy and the store hears about it once, on release.
   */
  const [carried, setCarried] = useState<readonly BlockId[] | null>(null)

  const rows = useMemo(() => {
    if (!carried) return timeline.blocks
    const byId = new Map(timeline.blocks.map((block) => [block.id, block]))
    // A block can vanish mid-drag (an undo elsewhere, a delete), and a stale id
    // here would render nothing at all rather than the rest of the list.
    const kept = carried.map((id) => byId.get(id)).filter((block): block is Block => !!block)
    return kept.length === timeline.blocks.length ? kept : timeline.blocks
  }, [carried, timeline.blocks])

  const order = useMemo(() => rows.map((block) => block.id), [rows])

  /**
   * Brings the whole panel into view, with the chosen row inside it.
   *
   * The list is the only place each piece's source range is written down, and on
   * an ordinary window it is below the fold — so choosing a block on the
   * timeline told you nothing unless you went looking. Scrolling the row just
   * far enough was not enough either: it arrived alone at the bottom edge with
   * its heading and its neighbours still out of sight, which is not "showing you
   * the blocks". The panel is framed instead, and the row nudged into view
   * within it only if the panel is too tall to fit.
   */
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!selectedBlock) return

    // Found in the document rather than through a ref: the rows are motion
    // components, and a ref handed to one does not reliably reach the node it
    // renders.
    const row = document.querySelector<HTMLElement>(`[data-block-row="${selectedBlock}"]`)
    const section = panel.current
    if (!row || !section) return

    // The column, found by hand: `scrollIntoView` walks out to the row's own
    // list, which usually does not overflow, and stops there having moved
    // nothing at all.
    let scroller = section.parentElement
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement
    }
    if (!scroller) return

    const box = scroller.getBoundingClientRect()
    const sectionBox = section.getBoundingClientRect()

    // A gap above, so the panel arrives with its heading clear of the edge
    // rather than flush against it.
    const gap = 12
    if (sectionBox.top < box.top + gap || sectionBox.bottom > box.bottom) {
      scroller.scrollTop += Math.min(
        sectionBox.top - box.top - gap,
        Math.max(0, sectionBox.bottom - box.bottom + gap),
      )
    }

    // Only now, and only if the panel could not fit whole.
    const rowBox = row.getBoundingClientRect()
    const after = scroller.getBoundingClientRect()
    if (rowBox.top < after.top) scroller.scrollTop += rowBox.top - after.top - gap
    else if (rowBox.bottom > after.bottom) scroller.scrollTop += rowBox.bottom - after.bottom + gap
  }, [selectedBlock])

  const drop = (id: BlockId) => {
    const settled = carried
    setCarried(null)
    if (!settled) return
    const to = settled.indexOf(id)
    if (to !== -1) reorderBlock(id, to)
  }

  return (
    <section ref={panel} className="panel flex shrink-0 flex-col">
      <header className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
        <h2 className="eyebrow">{t('blocks.title')}</h2>
        <span className="text-[11px] text-faint">
          {count === 1 ? t('blocks.one') : t('blocks.many', { count })}
        </span>
      </header>

      <Reorder.Group
        as="ol"
        axis="y"
        values={order}
        onReorder={setCarried}
        className="max-h-[260px] min-h-0 space-y-1 overflow-y-auto px-2 pb-2"
      >
        <AnimatePresence initial={false}>
          {rows.map((block, index) => (
            <BlockRow
              key={block.id}
              block={block}
              index={index}
              count={count}
              playing={playhead >= block.start && playhead < blockEnd(block)}
              chosen={selectedBlock === block.id}
              onChoose={() => {
                seek(block.start)
                selectBlock(block.id)
              }}
              onDelete={() => deleteBlock(block.id)}
              onDrop={() => drop(block.id)}
            />
          ))}
        </AnimatePresence>
      </Reorder.Group>
    </section>
  )
}

/**
 * One row, which is also its own handle.
 *
 * Its own component because each row needs its own drag controls, and a hook
 * cannot be called inside a loop.
 *
 * The whole row picks up, not a grip beside the number. A grip is the honest
 * affordance and it stays drawn, but as the only target it was a twenty-pixel
 * square to aim at for a gesture whose whole point is that it is easier than the
 * timeline. Pressing anywhere but the delete button starts the drag, and a press
 * that goes nowhere is still a click: Motion only calls it a drag once the
 * pointer has actually travelled, so choosing a block is unaffected.
 */
function BlockRow({
  block,
  index,
  count,
  playing,
  chosen,
  onChoose,
  onDelete,
  onDrop,
}: {
  readonly block: Block
  readonly index: number
  readonly count: number
  readonly playing: boolean
  readonly chosen: boolean
  readonly onChoose: () => void
  readonly onDelete: () => void
  readonly onDrop: () => void
}) {
  const t = useT()
  const controls = useDragControls()
  const [carrying, setCarrying] = useState(false)

  /**
   * Whether the press that is ending was a drag.
   *
   * A click fires on release whether or not the pointer travelled in between,
   * so without this, letting go of a row you had just carried would also seek to
   * it. Read on the way out and reset on the way in.
   */
  const travelled = useRef(false)

  return (
    <Reorder.Item
      value={block.id}
      data-block-row={block.id}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => {
        travelled.current = true
        setCarrying(true)
      }}
      onDragEnd={() => {
        setCarrying(false)
        onDrop()
      }}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className={cx('relative', carrying && 'z-10')}
    >
      <div
        title={t('blocks.reorderRow')}
        onPointerDown={(event) => {
          travelled.current = false
          // Everything but the button that removes the row: a drag that began
          // on it would make deleting a block feel like a gamble.
          if ((event.target as HTMLElement).closest('[data-no-drag]')) return
          controls.start(event)
        }}
        className={cx(
          'group flex cursor-grab touch-none items-center gap-1.5 rounded-lg py-2 pl-1 pr-2 active:cursor-grabbing',
          'transition-[background-color,box-shadow] duration-150',
          playing ? 'bg-raised' : 'hover:bg-raised/60',
          // Paper, matching the ring the chosen block wears on the timeline: the
          // two are one selection shown in two places.
          chosen && 'shadow-[inset_0_0_0_1.5px_var(--color-paper)]',
          carrying && 'bg-raised-hi shadow-lg',
        )}
      >
        {/* The affordance, not the target: the row behind it is what carries. */}
        <span
          aria-hidden="true"
          className="shrink-0 p-1 text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        >
          <Grip size={14} />
        </span>

        <button
          type="button"
          onClick={() => {
            if (travelled.current) return
            onChoose()
          }}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          title={t('blocks.number', { number: index + 1 })}
        >
          <span
            className={cx(
              'timecode flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold',
              playing ? 'bg-snip text-ink' : 'border border-line-bright bg-ink text-muted',
            )}
          >
            {index + 1}
          </span>

          <span className="min-w-0 flex-1">
            <span className="timecode block text-[11.5px] text-paper">
              {formatTimecode(block.source.start, { frames: false })}
              <span className="mx-1 text-faint">–</span>
              {formatTimecode(block.source.end, { frames: false })}
            </span>
            <span className="block text-[10.5px] text-faint">
              {formatTimecode(spanDuration(block.source))}
            </span>
          </span>
        </button>

        <button
          type="button"
          data-no-drag
          onClick={onDelete}
          disabled={count <= 1}
          title={t('blocks.delete')}
          aria-label={t('blocks.delete')}
          className="shrink-0 rounded-md p-1.5 text-faint opacity-0 transition-[opacity,color] duration-150 hover:text-snip-ink focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none"
        >
          <Trash size={14} />
        </button>
      </div>
    </Reorder.Item>
  )
}
