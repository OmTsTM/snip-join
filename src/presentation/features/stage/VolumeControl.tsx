import { Speaker, SpeakerOff } from '@presentation/components/Icons'
import { IconButton } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { useEditor } from '@presentation/state/editorStore'

/**
 * Loudness for the preview.
 *
 * A native range input rather than a rebuilt slider: it arrives with keyboard
 * handling, a focus ring and the right accessibility role, and the only part
 * worth replacing is how it looks. The fill is a gradient stop driven by the
 * value, because Chromium exposes no filled-track part to style.
 *
 * Dusk, not orange: this changes nothing about the edit.
 */
export function VolumeControl() {
  const t = useT()
  const volume = useEditor((state) => state.volume)
  const muted = useEditor((state) => state.muted)
  const setVolume = useEditor((state) => state.setVolume)
  const toggleMuted = useEditor((state) => state.toggleMuted)

  const audible = muted ? 0 : volume
  const percent = `${Math.round(audible * 100)}%`

  return (
    <div className="flex items-center gap-1.5">
      <IconButton
        label={muted ? t('transport.unmute') : t('transport.mute')}
        onClick={toggleMuted}
      >
        {muted || volume === 0 ? <SpeakerOff size={16} /> : <Speaker size={16} />}
      </IconButton>

      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={audible}
        onChange={(event) => setVolume(Number(event.target.value))}
        aria-label={t('transport.volume')}
        title={t('transport.volume')}
        className="volume w-[74px]"
        style={{ '--fill': percent } as React.CSSProperties}
      />
    </div>
  )
}
