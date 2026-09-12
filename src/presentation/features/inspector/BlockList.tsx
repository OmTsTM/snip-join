import { AnimatePresence, motion } from 'motion/react'
import { useEffect } from 'react'

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
   * Brings the chosen block into view.
   *
   * The list is the only place the source range of each piece is written down,
   * and on an ordinary window most of it is below the fold — so choosing a block
   * on the timeline told you nothing unless you went looking. `nearest` rather
   * than `center`: a row already on screen should not make the list jump.
   */
  useEffect(() => {
    // Found in the document rather than through a ref: these rows are motion
    // components, and a ref handed to one does not reliably reach the node it
    // renders.
    const row = selectedBlock
      ? document.querySelector<HTMLElement>(`[data-block-row="${selectedBlock}"]`)
      : null
    if (!row) return

    // The column is found and scrolled by hand rather than left to
    // `scrollIntoView`. The row sits in a list of its own that usually does not
    // overflow, and asking the browser to walk two ancestors out to the column
    // moved nothing at all — which is the only case that matters, because the
    // list is normally entirely below the fold.
    let scroller = row.parentElement
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement
    }
    if (!scroller) return

    const rowBox = row.getBoundingClientRect()
    const box = scroller.getBoundingClientRect()
    if (rowBox.top >= box.top && rowBox.bottom <= box.bottom) return

    // A row's height of margin, so the chosen one never sits flush against the
    // edge it was scrolled to and its neighbours stay readable.
    const margin = rowBox.height
    scroller.scrollTop +=
      rowBox.top < box.top
        ? rowBox.top - box.top - margin
        : rowBox.bottom - box.bottom + margin
  }, [selectedBlock])

  return (
    <section className="panel flex shrink-0 flex-col">
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
                    className="shrink-0 rounded-md p-1.5 text-faint opacity-0 transition-[opacity,color] duration-150 hover:text-snip focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none"
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
