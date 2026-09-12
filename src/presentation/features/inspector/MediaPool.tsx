import { open } from '@tauri-apps/plugin-dialog'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback } from 'react'

import { formatTimecode } from '@domain/time'
import { mediaOrder } from '@domain/timeline'
import { Folder, Plus, Trash } from '@presentation/components/Icons'
import { cx, IconButton } from '@presentation/components/primitives'
import { VIDEO_EXTENSIONS } from '@presentation/features/chrome/OpenAnother'
import { useT } from '@presentation/i18n/I18nProvider'
import { selectTimeline, useEditor } from '@presentation/state/editorStore'

/**
 * The files this project draws on.
 *
 * A pool rather than a single source: adding a file puts the whole of it after
 * everything already on the timeline, and from there it is an ordinary block —
 * dragged, trimmed and reordered by the gestures that already exist. Nothing
 * here places anything, which is why there is no drop target to learn.
 *
 * The first file cannot be removed. It decides the output format every other
 * piece is normalised onto, and losing it halfway through an edit would
 * silently change what the export produces.
 */
export function MediaPool() {
  const t = useT()
  const media = useEditor((state) => state.media)
  const timeline = useEditor(selectTimeline)
  const addMedia = useEditor((state) => state.addMedia)
  const removeMedium = useEditor((state) => state.removeMedium)
  const seek = useEditor((state) => state.seek)

  const choose = useCallback(async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: 'Video', extensions: VIDEO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    })

    if (typeof selected === 'string') await addMedia(selected)
  }, [addMedia])

  if (media.length === 0) return null

  const used = mediaOrder(timeline)

  return (
    <section className="panel flex shrink-0 flex-col">
      <header className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
        <h2 className="eyebrow">{t('media.title')}</h2>
        <IconButton label={t('media.add')} onClick={() => void choose()}>
          <Folder size={14} />
        </IconButton>
      </header>

      <ul className="max-h-[200px] min-h-0 space-y-1 overflow-y-auto px-2 pb-2">
        <AnimatePresence initial={false}>
          {media.map((medium, index) => {
            const first = index === 0
            // A file can sit in the pool with nothing on the timeline reading
            // from it, after every block of it has been deleted.
            const onTimeline = used.includes(medium.path)

            return (
              <motion.li
                key={medium.path}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="group flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors duration-150 hover:bg-raised/60">
                  <span
                    className={cx(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-[10px] font-semibold',
                      first ? 'bg-dusk-lift/25 text-dusk-lift' : 'bg-raised text-muted',
                    )}
                    title={first ? t('media.first') : undefined}
                  >
                    {index + 1}
                  </span>

                  <button
                    type="button"
                    onClick={() => {
                      const block = timeline.blocks.find((b) => b.mediaId === medium.path)
                      if (block) seek(block.start)
                    }}
                    className="flex min-w-0 flex-1 flex-col items-start text-left"
                    title={medium.path}
                  >
                    <span
                      className={cx(
                        'w-full truncate text-[12px]',
                        onTimeline ? 'text-paper' : 'text-faint',
                      )}
                    >
                      {medium.fileName}
                    </span>
                    <span className="timecode text-[10.5px] text-faint">
                      {formatTimecode(medium.duration, { frames: false })}
                    </span>
                  </button>

                  <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    <IconButton
                      label={t('media.append')}
                      onClick={() => void addMedia(medium.path)}
                    >
                      <Plus size={14} />
                    </IconButton>
                    {!first && (
                      <IconButton
                        label={t('media.remove')}
                        onClick={() => void removeMedium(medium.path)}
                      >
                        <Trash size={14} />
                      </IconButton>
                    )}
                  </span>
                </div>
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
    </section>
  )
}
