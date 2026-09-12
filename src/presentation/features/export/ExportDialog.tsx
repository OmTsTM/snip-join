import { save } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  canCopyStreams,
  estimateSeconds,
  fastSpec,
  resolveScale,
  type ExportMode,
  type ExportSpec,
  type QualityTarget,
  type RestorationLevel,
  type UpscaleAlgorithm,
  type VideoCodec,
} from '@domain/export'
import { losslessAccuracy } from '@domain/lossless'
import { displaySize, formatBytes, pixelCount, sourceExtension } from '@domain/media'
import { formatDuration, formatTimecode } from '@domain/time'
import { isContiguous, spansMultipleMedia } from '@domain/timeline'
import { Check, Close, Export as ExportIcon, Folder, Sparkle } from '@presentation/components/Icons'
import {
  Button,
  Checkbox,
  cx,
  Field,
  IconButton,
  ProgressBar,
  Segmented,
} from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { selectDuration, selectTimeline, useEditor } from '@presentation/state/editorStore'
import type { MessageKey } from '@infrastructure/i18n'
import { api } from '@infrastructure/tauri/api'

interface ExportDialogProps {
  readonly open: boolean
  readonly onClose: () => void
}

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const t = useT()

  const source = useEditor((state) => state.source)
  const timeline = useEditor(selectTimeline)
  const outputDuration = useEditor(selectDuration)
  const capabilities = useEditor((state) => state.capabilities)
  const job = useEditor((state) => state.exportJob)
  const lastExport = useEditor((state) => state.lastExport)
  const runExport = useEditor((state) => state.runExport)
  const cancelExport = useEditor((state) => state.cancelExport)

  const [spec, setSpec] = useState<ExportSpec>(fastSpec)
  const [destination, setDestination] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const hasGaps = !isContiguous(timeline)
  const spansMedia = spansMultipleMedia(timeline)
  // A still is one packet looped into a stretch of video, which no stream copy
  // can do. Said here rather than discovered when the title card turns out to
  // last a single frame.
  const usesStill = useEditor((state) =>
    state.media.some(
      (medium) =>
        medium.kind === 'still' &&
        state.history.present.blocks.some((block) => block.mediaId === medium.path),
    ),
  )
  const copyImpossible = hasGaps || spansMedia || usesStill
  const copyPossible = canCopyStreams(spec, hasGaps, spansMedia, usesStill)

  // Ask the backend where to put the result the first time the dialog opens for
  // a given file, rather than guessing a path in the renderer.
  useEffect(() => {
    if (!open || !source) return
    let cancelled = false

    void api
      .suggestOutputPath(sourceExtension(source))
      .then((path) => {
        if (!cancelled) setDestination((current) => current || path)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [open, source])

  // A hole cannot be copied, so the mode is corrected as soon as one exists. The
  // backend enforces this too; doing it here means the dialog never shows a
  // promise it cannot keep.
  useEffect(() => {
    if (copyImpossible && spec.mode === 'fast') {
      setSpec((current) => ({ ...current, mode: 'precise' }))
    }
  }, [copyImpossible, spec.mode])

  const chooseDestination = useCallback(async () => {
    if (!source) return
    const extension = destination.split('.').pop() ?? sourceExtension(source)

    const picked = await save({
      ...(destination ? { defaultPath: destination } : {}),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    })
    if (picked) setDestination(picked)
  }, [destination, source])

  const video = source?.video ?? null
  const sourceSize = video ? displaySize(video) : { width: 1920, height: 1080 }
  const outputSize = resolveScale(spec.scale, sourceSize.width, sourceSize.height)
  const ratio = (outputSize.width * outputSize.height) / Math.max(1, pixelCount(video))

  const estimate = useMemo(
    () => estimateSeconds(spec, outputDuration, ratio),
    [spec, outputDuration, ratio],
  )

  const upscalers = capabilities?.upscalers ?? ['none', 'lanczos']
  const running = job !== null

  const start = useCallback(() => {
    if (!destination) return
    void runExport(spec, destination)
  }, [destination, runExport, spec])

  const setMode = (mode: ExportMode) => {
    setSpec((current) => {
      // Leaving Enhanced drops the settings that only exist there, so switching
      // back and forth cannot leave an invisible upscale armed.
      if (mode !== 'enhanced') {
        return {
          ...current,
          mode,
          upscale: 'none',
          scale: { kind: 'source' },
          restoration: { denoise: 'off', sharpen: 'off', deband: false },
        }
      }
      return { ...current, mode }
    })
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/75 p-6 backdrop-blur-sm"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !running) onClose()
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 4 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label={t('export.title')}
            className="flex max-h-full w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-line-bright bg-panel shadow-[0_40px_100px_-30px_rgba(0,0,0,0.9)]"
          >
            <header className="flex shrink-0 items-start justify-between border-b border-line px-5 py-4">
              <div>
                <h2 className="font-display text-[17px] font-semibold tracking-tight text-paper">
                  {t('export.title')}
                </h2>
                <p className="mt-0.5 text-[12px] text-muted">{t('export.subtitle')}</p>
              </div>
              <IconButton label={t('error.dismiss')} onClick={onClose} disabled={running}>
                <Close size={15} />
              </IconButton>
            </header>

            {lastExport ? (
              <Completed
                onClose={() => {
                  useEditor.setState({ lastExport: null })
                  onClose()
                }}
              />
            ) : (
              <>
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
                  <Field label={t('export.mode')}>
                    <div className="grid grid-cols-3 gap-2">
                      {(['fast', 'precise', 'enhanced'] as const).map((mode) => (
                        <ModeCard
                          key={mode}
                          mode={mode}
                          selected={spec.mode === mode}
                          disabled={mode === 'fast' && copyImpossible}
                          onSelect={() => setMode(mode)}
                        />
                      ))}
                    </div>
                    {copyImpossible ? (
                      <p className="mt-2 text-[11.5px] leading-snug text-dusk-lift">
                        {hasGaps
                          ? t('export.mode.forced')
                          : spansMedia
                            ? t('export.mode.forcedByFiles')
                            : t('export.mode.forcedByStill')}
                      </p>
                    ) : (
                      spec.mode === 'fast' && <LosslessNote />
                    )}
                  </Field>

                  <div className="grid grid-cols-2 gap-4">
                    <Field label={t('export.quality')}>
                      <Segmented<QualityTarget>
                        ariaLabel={t('export.quality')}
                        value={spec.quality}
                        onChange={(quality) => setSpec((c) => ({ ...c, quality }))}
                        options={[
                          { value: 'matchSource', label: t('export.quality.matchSource') },
                          { value: 'high', label: t('export.quality.high') },
                          { value: 'compact', label: t('export.quality.compact') },
                        ]}
                      />
                    </Field>

                    <Field label={t('export.codec')}>
                      <Segmented<VideoCodec>
                        ariaLabel={t('export.codec')}
                        value={spec.codec}
                        onChange={(codec) => setSpec((c) => ({ ...c, codec }))}
                        options={[
                          { value: 'h264', label: t('export.codec.h264'), note: t('export.codec.h264.note') },
                          { value: 'hevc', label: t('export.codec.hevc'), note: t('export.codec.hevc.note') },
                          { value: 'av1', label: t('export.codec.av1'), note: t('export.codec.av1.note') },
                        ]}
                      />
                    </Field>
                  </div>

                  <AnimatePresence initial={false}>
                    {spec.mode === 'enhanced' && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-4 rounded-xl border border-line bg-ink/40 p-4">
                          <Field
                            label={t('export.upscale')}
                            hint={
                              upscalers.includes('placebo')
                                ? undefined
                                : t('export.upscale.unavailable')
                            }
                          >
                            <Segmented<UpscaleAlgorithm>
                              ariaLabel={t('export.upscale')}
                              value={spec.upscale}
                              onChange={(upscale) =>
                                setSpec((c) => ({
                                  ...c,
                                  upscale,
                                  scale:
                                    upscale === 'none'
                                      ? { kind: 'source' }
                                      : c.scale.kind === 'source'
                                        ? { kind: 'multiplier', factor: 2 }
                                        : c.scale,
                                }))
                              }
                              options={[
                                { value: 'none', label: t('export.upscale.none') },
                                { value: 'lanczos', label: t('export.upscale.lanczos'), note: t('export.upscale.lanczos.note') },
                                {
                                  value: 'placebo',
                                  label: t('export.upscale.placebo'),
                                  note: t('export.upscale.placebo.note'),
                                  disabled: !upscalers.includes('placebo'),
                                },
                                {
                                  value: 'detail',
                                  label: t('export.upscale.detail'),
                                  note: t('export.upscale.detail.note'),
                                  disabled: !upscalers.includes('detail'),
                                },
                              ]}
                            />
                          </Field>

                          {spec.upscale !== 'none' && (
                            <Field
                              label={t('export.scale')}
                              hint={t('export.scale.result', outputSize)}
                            >
                              <Segmented
                                ariaLabel={t('export.scale')}
                                value={
                                  spec.scale.kind === 'multiplier' ? String(spec.scale.factor) : '1'
                                }
                                onChange={(value) =>
                                  setSpec((c) => ({
                                    ...c,
                                    scale: { kind: 'multiplier', factor: Number(value) },
                                  }))
                                }
                                options={[
                                  { value: '1.5', label: '1.5x' },
                                  { value: '2', label: '2x' },
                                  { value: '3', label: '3x' },
                                  { value: '4', label: '4x' },
                                ]}
                              />
                            </Field>
                          )}

                          <div className="grid grid-cols-2 gap-4">
                            <Field label={t('export.restoration.denoise')}>
                              <Segmented<RestorationLevel>
                                ariaLabel={t('export.restoration.denoise')}
                                value={spec.restoration.denoise}
                                onChange={(denoise) =>
                                  setSpec((c) => ({ ...c, restoration: { ...c.restoration, denoise } }))
                                }
                                options={LEVELS.map((level) => ({
                                  value: level,
                                  label: t(`export.level.${level}` as MessageKey),
                                }))}
                              />
                            </Field>

                            <Field label={t('export.restoration.sharpen')}>
                              <Segmented<RestorationLevel>
                                ariaLabel={t('export.restoration.sharpen')}
                                value={spec.restoration.sharpen}
                                onChange={(sharpen) =>
                                  setSpec((c) => ({ ...c, restoration: { ...c.restoration, sharpen } }))
                                }
                                options={LEVELS.map((level) => ({
                                  value: level,
                                  label: t(`export.level.${level}` as MessageKey),
                                }))}
                              />
                            </Field>
                          </div>

                          <Checkbox
                            checked={spec.restoration.deband}
                            onChange={(deband) =>
                              setSpec((c) => ({ ...c, restoration: { ...c.restoration, deband } }))
                            }
                            label={t('export.restoration.deband')}
                            note={t('export.restoration.debandNote')}
                          />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <Field label={t('export.destination')}>
                    <div className="flex items-center gap-2">
                      <div
                        className="min-w-0 flex-1 truncate rounded-lg border border-line bg-ink/60 px-3 py-2 text-[12px] text-muted"
                        title={destination}
                      >
                        {destination || '—'}
                      </div>
                      <Button
                        size="sm"
                        tone="neutral"
                        title={t('hint.destination')}
                        onClick={() => void chooseDestination()}
                        icon={<Folder size={14} />}
                      >
                        {t('export.chooseDestination')}
                      </Button>
                    </div>
                  </Field>

                  <button
                    type="button"
                    onClick={() => setShowAdvanced((value) => !value)}
                    className="text-[11.5px] text-faint transition-colors duration-150 hover:text-muted"
                  >
                    {t('export.advanced')}
                  </button>

                  {showAdvanced && (
                    <Field label={t('export.audio')}>
                      <Segmented
                        ariaLabel={t('export.audio')}
                        value={spec.audio}
                        onChange={(audio) => setSpec((c) => ({ ...c, audio: audio as ExportSpec['audio'] }))}
                        options={[
                          { value: 'copy', label: t('export.audio.copy') },
                          { value: 'reEncode', label: t('export.audio.reEncode') },
                          { value: 'remove', label: t('export.audio.remove') },
                        ]}
                      />
                    </Field>
                  )}
                </div>

                <footer className="shrink-0 border-t border-line px-5 py-4">
                  {running ? (
                    <div className="space-y-3">
                      <div className="flex items-baseline justify-between text-[12px]">
                        <span className="text-paper">{t('export.running')}</span>
                        <span className="timecode text-muted">{Math.round(job.progress * 100)}%</span>
                      </div>
                      <ProgressBar value={job.progress} />
                      <Button
                        tone="quiet"
                        size="sm"
                        full
                        title={t('hint.cancelExport')}
                        onClick={() => void cancelExport()}
                      >
                        {t('export.cancel')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4">
                      <div className="min-w-0 flex-1 text-[11.5px] leading-snug text-faint">
                        <div className="text-muted">
                          {t('export.summary.length', { duration: formatTimecode(outputDuration, { frames: false }) })}
                          {' · '}
                          {t('export.summary.blocks', { count: timeline.blocks.length })}
                        </div>
                        <div className={copyPossible ? 'text-faint' : 'text-dusk-lift'}>
                          {t('export.estimate', { time: formatDuration(estimate) })}
                        </div>
                      </div>

                      <Button
                        tone="paper"
                        size="lg"
                        onClick={start}
                        disabled={!destination}
                        title={t('hint.startExport')}
                        icon={<ExportIcon size={16} />}
                      >
                        {t('export.start')}
                      </Button>
                    </div>
                  )}
                </footer>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const LEVELS: readonly RestorationLevel[] = ['off', 'light', 'medium', 'strong']

/**
 * Tells the truth about where a stream copy will actually cut.
 *
 * A copy can only begin on a cut point, so a selection placed between two of
 * them silently drags the result backwards. The editor snaps to them, which makes
 * this line usually read "exact" — and when it does not, saying so beats letting
 * the user discover a second of unwanted footage in the finished file.
 */
function LosslessNote() {
  const t = useT()
  const blocks = useEditor((state) => state.history.present.blocks)
  // Only ever rendered for a copy, which rules out a timeline drawing on more
  // than one file, so every block here reads from the first medium and its list
  // is the only one that could apply.
  const keyframes = useEditor((state) => state.keyframes[state.source?.path ?? ''])
  const truncated = useEditor(
    (state) => state.keyframesTruncated[state.source?.path ?? ''] ?? false,
  )
  const sourceDuration = useEditor((state) => state.source?.duration ?? 0)
  const hasVideo = useEditor((state) => state.source?.video != null)

  // Derived here rather than in a selector: the result is a fresh object, and a
  // selector returning one would re-render without end.
  const accuracy = useMemo(
    () => losslessAccuracy(blocks, keyframes ?? [], sourceDuration),
    [blocks, keyframes, sourceDuration],
  )

  if (!hasVideo) return null

  if (truncated) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-dusk-lift">
        <Check size={13} strokeWidth={2.4} />
        {t('export.lossless.anywhere')}
      </p>
    )
  }

  if (!keyframes || keyframes.length === 0) {
    return <p className="mt-2 text-[11.5px] text-faint">{t('export.lossless.reading')}</p>
  }

  if (accuracy.exact) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-dusk-lift">
        <Check size={13} strokeWidth={2.4} />
        {t('export.lossless.exact')}
      </p>
    )
  }

  return (
    <p className="mt-2 text-[11.5px] leading-snug text-snip-ink">
      {t('export.lossless.shift', { shift: formatDuration(Math.max(1, Math.round(accuracy.worstShift))) })}
    </p>
  )
}

function ModeCard({
  mode,
  selected,
  disabled,
  onSelect,
}: {
  readonly mode: ExportMode
  readonly selected: boolean
  readonly disabled?: boolean
  readonly onSelect: () => void
}) {
  const t = useT()

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      title={t(`export.mode.${mode}.detail` as MessageKey)}
      className={cx(
        'rounded-xl border p-3 text-left transition-[border-color,background-color] duration-150',
        'disabled:pointer-events-none disabled:opacity-35',
        selected ? 'border-snip bg-snip/10' : 'border-line bg-ink/40 hover:border-line-bright',
      )}
    >
      <div className="flex items-center gap-1.5">
        {mode === 'enhanced' && <Sparkle size={12} className={selected ? 'text-snip-ink' : 'text-faint'} />}
        <span className={cx('text-[12.5px] font-semibold', selected ? 'text-snip-ink' : 'text-paper')}>
          {t(`export.mode.${mode}` as MessageKey)}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-faint">
        {t(`export.mode.${mode}.summary` as MessageKey)}
      </p>
    </button>
  )
}

function Completed({ onClose }: { readonly onClose: () => void }) {
  const t = useT()
  const outcome = useEditor((state) => state.lastExport)
  if (!outcome) return null

  const name = outcome.outputPath.split(/[\\/]/).pop() ?? outcome.outputPath

  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-dusk-lift/15 text-dusk-lift">
        <Check size={24} strokeWidth={2.2} />
      </span>

      <div>
        <p className="font-display text-[17px] font-semibold text-paper">{t('export.done')}</p>
        <p className="mt-1 text-[12px] text-muted">
          {t('export.doneDetail', {
            name,
            duration: formatTimecode(outcome.duration, { frames: false }),
            size: formatBytes(outcome.sizeBytes),
          })}
        </p>
      </div>

      <div className="mt-1 flex gap-2">
        <Button
          tone="neutral"
          size="md"
          title={t('hint.reveal')}
          onClick={() => void revealItemInDir(outcome.outputPath).catch(() => undefined)}
          icon={<Folder size={15} />}
        >
          {t('export.reveal')}
        </Button>
        <Button tone="paper" size="md" title={t('hint.dismissExport')} onClick={onClose}>
          {t('export.dismiss')}
        </Button>
      </div>
    </div>
  )
}
