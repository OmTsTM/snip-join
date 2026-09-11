import { formatTimecode } from '@domain/time'
import { Fit, Pause, Play, StepBack, StepForward } from '@presentation/components/Icons'
import { cx, IconButton } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { selectDuration, useEditor } from '@presentation/state/editorStore'

export function Transport() {
  const t = useT()
  const playing = useEditor((state) => state.playing)
  const togglePlay = useEditor((state) => state.togglePlay)
  const stepFrame = useEditor((state) => state.stepFrame)
  const seek = useEditor((state) => state.seek)
  const duration = useEditor(selectDuration)

  return (
    <div className="flex shrink-0 items-center justify-center gap-5 px-6 pb-5">
      <Readout />

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
            'border border-line-bright bg-raised-hi text-paper',
            'transition-[background-color,transform] duration-150 hover:bg-line-bright active:scale-95',
          )}
        >
          {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
        </button>

        <IconButton label={t('transport.nextFrame')} onClick={() => stepFrame(1)}>
          <StepForward size={16} />
        </IconButton>
      </div>

      <div className="timecode w-[132px] text-right text-[12px] text-faint">
        <button
          type="button"
          onClick={() => seek(duration)}
          title={t('transport.toEnd')}
          className="transition-colors duration-150 hover:text-muted"
        >
          {formatTimecode(duration)}
        </button>
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
    <div className="timecode w-[132px] text-[15px] font-medium tabular-nums text-paper">
      {formatTimecode(playhead)}
    </div>
  )
}
