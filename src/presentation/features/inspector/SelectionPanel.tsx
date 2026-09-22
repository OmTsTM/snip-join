import { motion } from 'motion/react'

import { duration as spanDuration, formatTimecode } from '@domain/time'
import { Scissors } from '@presentation/components/Icons'
import { Button, cx, Switch } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import {
  selectLocked,
  selectSelectionCovers,
  selectTimeline,
  useEditor,
} from '@presentation/state/editorStore'

import { InspectorPanel } from './InspectorPanel'

/**
 * What the rails have marked, and the two things that can be done with it.
 *
 * Deliberately terse. This panel once explained itself in three paragraphs,
 * and the explanations were what people had to scroll past to reach the
 * buttons. Everything it used to say is still there as a tooltip on the
 * control it was about. The two marks — start here, end here — live on the
 * timeline's own toolbar now, beside the playhead they act on.
 */
export function SelectionPanel() {
  const t = useT()

  const selection = useEditor((state) => state.selection)
  // False when the rails sit over nothing but a hole. A hole holds no material,
  // so a removal there takes nothing out and a lift makes a block out of
  // nothing: both are refused, and the buttons say so rather than recording an
  // edit that changes not one frame of the result.
  const covers = useEditor(selectSelectionCovers)
  const timeline = useEditor(selectTimeline)
  const locked = useEditor(selectLocked)
  const setMode = useEditor((state) => state.setMode)
  const removeSelection = useEditor((state) => state.removeSelection)
  const liftSelection = useEditor((state) => state.liftSelection)
  const setSelection = useEditor((state) => state.setSelection)

  const joining = timeline.mode === 'join'

  return (
    <InspectorPanel
      id="selection"
      title={t('selection.title')}
      aside={
        selection && (
          <button
            type="button"
            onClick={() => setSelection(null)}
            title={t('hint.clearSelection')}
            className="shrink-0 px-1 text-[11px] text-faint transition-colors duration-150 hover:text-paper"
          >
            {t('selection.clear')}
          </button>
        )
      }
    >
      <div className="flex flex-col gap-3 px-3 pb-3">
        {/* Nothing stands in for an empty selection. The panel used to carry a
            sentence telling you to drag across the timeline, which is the one
            thing anybody works out on their own, and it was in the way every
            time afterwards. */}
        {selection && (
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
        )}

        {selection && !covers && (
          <p className="px-0.5 text-[11px] leading-snug text-faint">{t('selection.onlyHole')}</p>
        )}

        {/* The join switch, directly above the two actions it changes the
            meaning of. What each setting does to the file is the tooltip. */}
        <div
          className="rounded-lg border border-line bg-ink/40 px-3 py-2"
          title={joining ? t('join.on') : t('join.off')}
        >
          <Switch
            checked={joining}
            onChange={(checked) => setMode(checked ? 'join' : 'gap')}
            label={t('join.label')}
            disabled={locked}
          />
        </div>

        {/* One under the other, both the full width of the panel. Side by side
            the second one had whatever room the first left it, which in
            Portuguese was not enough for its own label — it arrived cut off,
            and a button nobody can read is a button nobody presses. The word
            is short now and the sentence explaining it is the tooltip. */}
        <div className="space-y-2">
          <Button
            tone="snip"
            size="md"
            full
            disabled={!covers || locked}
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
            disabled={!covers || locked}
            title={t('selection.liftHint')}
            onClick={liftSelection}
          >
            {t('selection.lift')}
          </Button>
        </div>
      </div>
    </InspectorPanel>
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
