import { open } from '@tauri-apps/plugin-dialog'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'

import { formatTimecode } from '@domain/time'
import { mediaOrder } from '@domain/timeline'
import { ConfirmDialog } from '@presentation/components/ConfirmDialog'
import { Folder, Image, Trash } from '@presentation/components/Icons'
import { cx, IconButton } from '@presentation/components/primitives'
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '@presentation/features/chrome/OpenAnother'
import { useT } from '@presentation/i18n/I18nProvider'
import { selectTimeline, useEditor } from '@presentation/state/editorStore'

import { useMediaDrag, type MediaDragSource } from './mediaDrag'

/** Movement, in pixels, before a press on a row becomes a drag onto the track. */
const DRAG_THRESHOLD = 4

/**
 * The files this project draws on.
 *
 * A pool rather than a single source. Two ways out of it, and the difference is
 * the whole point: a click asks whether to put the file on the end, because a
 * single click should never silently lengthen an edit; a press and drag carries
 * it onto the timeline and drops it exactly where the pointer is.
 *
 * The first file cannot be removed. It decides the output format every other
 * piece is normalised onto, and losing it halfway through an edit would silently
 * change what the export produces.
 */
export function MediaPool() {
  const t = useT()
  const media = useEditor((state) => state.media)
  const timeline = useEditor(selectTimeline)
  const addMedia = useEditor((state) => state.addMedia)
  const removeMedium = useEditor((state) => state.removeMedium)

  const [asking, setAsking] = useState<MediaDragSource | null>(null)

  const choose = useCallback(async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: 'Video', extensions: VIDEO_EXTENSIONS },
        { name: 'Image', extensions: IMAGE_EXTENSIONS },
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

      <ul className="max-h-[200px] min-h-0 space-y-1 overflow-y-auto px-2 pb-1">
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

                  <MediaRow
                    source={{
                      path: medium.path,
                      fileName: medium.fileName,
                      duration: medium.duration,
                      kind: medium.kind,
                    }}
                    onTimeline={onTimeline}
                    onAsk={setAsking}
                  />

                  <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100">
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

      <p className="px-4 pb-3 pt-1 text-[11px] leading-snug text-faint">{t('media.hint')}</p>

      <ConfirmDialog
        open={asking !== null}
        title={t('media.appendTitle')}
        body={t('media.appendBody', { name: asking?.fileName ?? '' })}
        confirmLabel={t('media.appendConfirm')}
        cancelLabel={t('media.appendCancel')}
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          const chosen = asking
          setAsking(null)
          if (chosen) void addMedia(chosen.path)
        }}
      />

      <MediaDragGhost />
    </section>
  )
}

/**
 * One file in the pool, and the gesture that gets it onto the timeline.
 *
 * A press that never travels is a click and asks the question; a press that
 * travels becomes a drag and places the file wherever it is let go. Deciding
 * between the two by distance rather than by two separate controls is what lets
 * the row stay one row.
 */
function MediaRow({
  source,
  onTimeline,
  onAsk,
}: {
  readonly source: MediaDragSource
  readonly onTimeline: boolean
  readonly onAsk: (source: MediaDragSource) => void
}) {
  const t = useT()
  const addMedia = useEditor((state) => state.addMedia)

  // Gesture bookkeeping, in refs: it is read on every pointer move and nothing
  // renders from it.
  const origin = useRef({ x: 0, y: 0 })
  const dragging = useRef(false)
  // Whether this gesture is one we started. A right button never opens the
  // question: it was never a press on this control in the first place.
  const pressed = useRef(false)

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    origin.current = { x: event.clientX, y: event.clientY }
    dragging.current = false
    pressed.current = true
  }, [])

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return

      const travelled =
        Math.abs(event.clientX - origin.current.x) + Math.abs(event.clientY - origin.current.y)

      if (!dragging.current) {
        if (travelled < DRAG_THRESHOLD) return
        dragging.current = true
        useMediaDrag.getState().begin(source, event.clientX, event.clientY)
        return
      }

      useMediaDrag.getState().moveTo(event.clientX, event.clientY)
    },
    [source],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!pressed.current) return
      pressed.current = false

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      if (!dragging.current) {
        onAsk(source)
        return
      }

      dragging.current = false
      // The timeline writes the target as the pointer crosses it, so letting go
      // anywhere else simply drops the file rather than placing it somewhere
      // arbitrary.
      const { target, end } = useMediaDrag.getState()
      end()
      if (target !== null) void addMedia(source.path, target)
    },
    [addMedia, onAsk, source],
  )

  const onPointerCancel = useCallback(() => {
    dragging.current = false
    pressed.current = false
    useMediaDrag.getState().end()
  }, [])

  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      className="flex min-w-0 flex-1 cursor-grab flex-col items-start text-left active:cursor-grabbing"
      title={`${source.path}\n${t('media.hint')}`}
    >
      <span className={cx('w-full truncate text-[12px]', onTimeline ? 'text-paper' : 'text-faint')}>
        {source.fileName}
      </span>
      <span className="flex items-center gap-1.5 text-faint">
        <span className="timecode text-[10.5px]">
          {formatTimecode(source.duration, { frames: false })}
        </span>
        {/* A still's number is a starting length, not the file's own. One word
            inline, because the row has to stay one row; the sentence that says
            it can be stretched at all is the tooltip. */}
        {source.kind === 'still' && (
          <span
            className="inline-flex items-center gap-1 text-[10.5px] text-dusk-lift"
            title={t('media.still')}
          >
            <Image size={11} />
            {t('media.stillTag')}
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * The card that follows the pointer while a file is being carried.
 *
 * Rendered into `document.body`: the pool scrolls and the inspector column
 * clips, so a ghost drawn in place would disappear the moment it left the row
 * it came from — which is the entire journey.
 */
function MediaDragGhost() {
  const source = useMediaDrag((state) => state.source)
  const x = useMediaDrag((state) => state.x)
  const y = useMediaDrag((state) => state.y)
  const overTimeline = useMediaDrag((state) => state.target !== null)

  if (!source) return null

  return createPortal(
    <div
      // Offset from the pointer rather than centred on it, so the card never
      // covers the drop position it is about to name.
      style={{ left: x + 14, top: y + 10 }}
      className={cx(
        'pointer-events-none fixed z-[70] max-w-[220px] truncate rounded-lg border px-2.5 py-1.5',
        'text-[11.5px] shadow-[0_16px_40px_-16px_rgba(0,0,0,0.9)]',
        overTimeline
          ? 'border-dusk-lift bg-dusk-lift/25 text-paper'
          : 'border-line-bright bg-panel text-muted',
      )}
    >
      {source.fileName}
    </div>,
    document.body,
  )
}
