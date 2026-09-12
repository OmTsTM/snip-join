import { formatTimecode } from '@domain/time'
import { Fit, Pause, Play, StepBack, StepForward } from '@presentation/components/Icons'
import { cx, IconButton } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { selectDuration, useEditor } from '@presentation/state/editorStore'

import { VolumeControl } from './VolumeControl'

export function Transport() {
  const t = useT()
  const playing = useEditor((state) => state.playing)
  const togglePlay = useEditor((state) => state.togglePlay)
  const stepFrame = useEditor((state) => state.stepFrame)
  const seek = useEditor((state) => state.seek)
  const duration = useEditor(selectDuration)

  return (
    /*
      Three columns rather than a centred row.

      The volume belongs beside the other things you reach for while watching,
      not pinned to the far corner of a window that can be two thousand pixels
      wide. Putting it in the row would have pushed the play button off the
      middle of the picture, which is the one thing this layout has to hold, so
      the sides are equal fractions and the controls sit in a column of their
      own: whatever either side carries, the centre stays centred.
    */
    <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 pb-5">
      <div className="flex justify-end">
        <Readout />
      </div>

      <div className="flex items-center gap-1">
        <IconButton label={t('transport.toStart')} onClick={() => seek(0)}>
          <Fit size={15} className="rotate-90" />
        </IconButton>

        <IconButton label={t('transport.previousFrame')} onClick={() => stepFrame(-1)}>
          <StepBack size={16} />
        </IconButton>

        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? t('transport.pause') : t('transport.play')}
          title={playing ? t('transport.pause') : t('transport.play')}
          className={cx(
            'mx-1 inline-flex h-11 w-11 items-center justify-center rounded-full',
            // `control`, not `raised`: this button has to read as standing on
            // the ground rather than pressed into it, and which direction that
            // is depends on whether the ground is dark or pale.
            'border border-line-bright bg-control text-paper',
            'transition-[background-color,transform] duration-150 hover:bg-line-bright active:scale-95',
          )}
        >
          {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
        </button>

        <IconButton label={t('transport.nextFrame')} onClick={() => stepFrame(1)}>
          <StepForward size={16} />
        </IconButton>
      </div>

      <div className="flex min-w-0 items-center gap-4">
        <div className="timecode text-[12px] text-faint">
          <button
            type="button"
            onClick={() => seek(duration)}
            title={t('transport.toEnd')}
            className="transition-colors duration-150 hover:text-muted"
          >
            {formatTimecode(duration)}
          </button>
        </div>

        <VolumeControl />
      </div>
    </div>
  )
}

/**
 * The current position.
 *
 * Isolated into its own component so the sixty-times-a-second clock update
 * re-renders one span of text instead of the entire transport row.
 */
function Readout() {
  const playhead = useEditor((state) => state.playhead)

  return (
    <div className="timecode text-[15px] font-medium tabular-nums text-paper">
      {formatTimecode(playhead)}
    </div>
  )
}
