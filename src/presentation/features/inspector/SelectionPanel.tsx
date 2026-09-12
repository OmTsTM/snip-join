import { motion } from 'motion/react'

import { duration as spanDuration } from '@domain/time'
import { Hole, Join, MarkEnd, MarkStart, Scissors } from '@presentation/components/Icons'
import { Button, cx, Switch } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { selectSelectionCovers, selectTimeline, useEditor } from '@presentation/state/editorStore'
import { formatTimecode } from '@domain/time'

export function SelectionPanel() {
  const t = useT()

  const selection = useEditor((state) => state.selection)
  // False when the rails sit over nothing but a hole. A hole holds no material,
  // so a removal there takes nothing out and a lift makes a block out of
  // nothing: both are refused, and the buttons say so rather than recording an
  // edit that changes not one frame of the result.
  const covers = useEditor(selectSelectionCovers)
  const timeline = useEditor(selectTimeline)
  const setMode = useEditor((state) => state.setMode)
  const removeSelection = useEditor((state) => state.removeSelection)
  const liftSelection = useEditor((state) => state.liftSelection)
  const setSelection = useEditor((state) => state.setSelection)
  const markIn = useEditor((state) => state.markIn)
  const markOut = useEditor((state) => state.markOut)

  const joining = timeline.mode === 'join'

  return (
    <section className="panel flex shrink-0 flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <h2 className="eyebrow">{t('selection.title')}</h2>
        {selection && (
          <button
            type="button"
            onClick={() => setSelection(null)}
            title={t('hint.clearSelection')}
            className="text-[11px] text-faint transition-colors duration-150 hover:text-paper"
          >
            {t('selection.clear')}
          </button>
        )}
      </header>

      {selection ? (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line"
        >
          <Readout label={t('selection.in')} value={formatTimecode(selection.start)} accent />
          <Readout label={t('selection.out')} value={formatTimecode(selection.end)} accent />
          <Readout label={t('selection.length')} value={formatTimecode(spanDuration(selection))} />
        </motion.div>
      ) : (
        <div className="rounded-lg border border-dashed border-line bg-ink/40 px-3 py-4 text-center">
          <p className="text-[12px] leading-snug text-muted">{t('selection.empty')}</p>
          <p className="mt-1.5 text-[11px] text-faint">{t('selection.emptyHint')}</p>
        </div>
      )}

      {selection && !covers && (
        <p className="-mt-2 px-0.5 text-[11px] leading-snug text-faint">
          {t('selection.onlyHole')}
        </p>
      )}

      {/*
        Always here, never only while nothing is marked.

        Marking the start creates a selection, which used to hide these two —
        so the only way back to "mark the end here" was to click the timeline to
        move the playhead, and that cleared the start you had just set. The
        buttons going away were half of that; the timeline click was the other
        half, and it now keeps a selection it lands inside.
      */}
      {/*
        Drawn as buttons, because that is what they are. As quiet text they read
        as a caption to the panel above them — two labels somebody had left
        lying there — and the pair that sets a selection from the keyboard's
        side is not something to have to guess is clickable.
      */}
      <div className="flex gap-2">
        <Button
          size="sm"
          tone="neutral"
          full
          icon={<MarkStart size={14} />}
          title={t('hint.markIn')}
          onClick={markIn}
        >
          {t('selection.setIn')}
        </Button>
        <Button
          size="sm"
          tone="neutral"
          full
          icon={<MarkEnd size={14} />}
          title={t('hint.markOut')}
          onClick={markOut}
        >
          {t('selection.setOut')}
        </Button>
      </div>

      {/*
        The join switch. It sits directly above the two actions it changes the
        meaning of, and its description swaps with its state, because the two
        settings produce genuinely different files.
      */}
      <div className="rounded-lg border border-line bg-ink/40 p-3">
        <Switch
          checked={joining}
          onChange={(checked) => setMode(checked ? 'join' : 'gap')}
          label={t('join.label')}
          description={joining ? t('join.on') : t('join.off')}
        />

        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 text-[11px] text-faint">
          {joining ? (
            <Join size={14} className="shrink-0 text-dusk-lift" />
          ) : (
            <Hole size={14} className="shrink-0 text-dusk-lift" />
          )}
          <span>{joining ? t('blocks.reorderHint') : t('blocks.moveHint')}</span>
        </div>
      </div>

      <div className="space-y-2">
        <Button
          tone="snip"
          size="md"
          full
          disabled={!covers}
          onClick={removeSelection}
          title={t('hint.remove')}
          icon={<Scissors size={15} />}
        >
          {t('selection.remove')}
        </Button>

        <Button
          tone="neutral"
          size="md"
          full
          disabled={!covers}
          title={t('selection.liftHint')}
          onClick={liftSelection}
        >
          {t('selection.lift')}
        </Button>

        <p className="px-0.5 text-[11px] leading-snug text-faint">{t('selection.liftHint')}</p>
      </div>
    </section>
  )
}

function Readout({
  label,
  value,
  accent,
}: {
  readonly label: string
  readonly value: string
  readonly accent?: boolean
}) {
  return (
    <div className="bg-panel px-2 py-2 text-center">
      <div className="eyebrow mb-1 text-[9px]">{label}</div>
      <div
        className={cx(
          'timecode text-[11.5px] font-medium',
          accent ? 'text-snip-ink' : 'text-paper',
        )}
      >
        {value}
      </div>
    </div>
  )
}
