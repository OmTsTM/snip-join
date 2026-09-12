import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef } from 'react'

import { duration as spanDuration, formatTimecode } from '@domain/time'
import { blockEnd } from '@domain/timeline'
import { Trash } from '@presentation/components/Icons'
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
 */
export function BlockList() {
  const t = useT()
  const timeline = useEditor(selectTimeline)
  const seek = useEditor((state) => state.seek)
  const deleteBlock = useEditor((state) => state.deleteBlock)
  const selectBlock = useEditor((state) => state.selectBlock)
  const selectedBlock = useEditor((state) => state.selectedBlock)
  const playhead = useEditor((state) => state.playhead)

  const count = timeline.blocks.length

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

  return (
    <section ref={panel} className="panel flex shrink-0 flex-col">
      <header className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
        <h2 className="eyebrow">{t('blocks.title')}</h2>
        <span className="text-[11px] text-faint">
          {count === 1 ? t('blocks.one') : t('blocks.many', { count })}
        </span>
      </header>

      <ol className="max-h-[260px] min-h-0 space-y-1 overflow-y-auto px-2 pb-2">
        <AnimatePresence initial={false}>
          {timeline.blocks.map((block, index) => {
            const active = playhead >= block.start && playhead < blockEnd(block)
            const chosen = selectedBlock === block.id

            return (
              <motion.li
                key={block.id}
                data-block-row={block.id}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                <div
                  className={cx(
                    'group flex items-center gap-2.5 rounded-lg px-2 py-2',
                    'transition-[background-color,box-shadow] duration-150',
                    active ? 'bg-raised' : 'hover:bg-raised/60',
                    // Paper, matching the ring the chosen block wears on the
                    // timeline: the two are one selection shown in two places.
                    chosen && 'shadow-[inset_0_0_0_1.5px_var(--color-paper)]',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      seek(block.start)
                      selectBlock(block.id)
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    title={t('blocks.number', { number: index + 1 })}
                  >
                    <span
                      className={cx(
                        'timecode flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold',
                        active
                          ? 'bg-snip text-ink'
                          : 'border border-line-bright bg-ink text-muted',
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
                    onClick={() => deleteBlock(block.id)}
                    disabled={count <= 1}
                    title={t('blocks.delete')}
                    aria-label={t('blocks.delete')}
                    className="shrink-0 rounded-md p-1.5 text-faint opacity-0 transition-[opacity,color] duration-150 hover:text-snip-ink focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none"
                  >
                    <Trash size={14} />
                  </button>
                </div>
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ol>
    </section>
  )
}
