/**
 * Export vocabulary, mirroring the Rust definitions one for one.
 *
 * These shapes cross the IPC boundary, so any change here has a matching change
 * in `src-tauri/src/domain/export.rs`. They are written by hand rather than
 * generated to keep the build free of a codegen step, and the Rust side
 * reconciles whatever arrives, so a mismatch degrades into a refused request
 * rather than a wrong file.
 */

export type ExportMode = 'fast' | 'precise' | 'enhanced'

export type UpscaleAlgorithm = 'none' | 'lanczos' | 'placebo' | 'detail'

export type ScaleTarget =
  | { readonly kind: 'source' }
  | { readonly kind: 'multiplier'; readonly factor: number }
  | { readonly kind: 'absolute'; readonly width: number; readonly height: number }

export type RestorationLevel = 'off' | 'light' | 'medium' | 'strong'

export interface Restoration {
  readonly denoise: RestorationLevel
  readonly sharpen: RestorationLevel
  readonly deband: boolean
}

export type VideoCodec = 'h264' | 'hevc' | 'av1'

export type EncoderBackend = 'auto' | 'nvenc' | 'quickSync' | 'amf' | 'software'

export type QualityTarget = 'matchSource' | 'maximum' | 'high' | 'balanced' | 'compact'

export type AudioHandling = 'copy' | 'reEncode' | 'remove'

export interface ExportSpec {
  readonly mode: ExportMode
  readonly codec: VideoCodec
  readonly backend: EncoderBackend
  readonly quality: QualityTarget
  readonly upscale: UpscaleAlgorithm
  readonly scale: ScaleTarget
  readonly restoration: Restoration
  readonly audio: AudioHandling
  readonly frameRate: number | null
}

export const NO_RESTORATION: Restoration = {
  denoise: 'off',
  sharpen: 'off',
  deband: false,
}

/** The default: copy the streams through untouched. */
export function fastSpec(): ExportSpec {
  return {
    mode: 'fast',
    codec: 'h264',
    backend: 'auto',
    quality: 'matchSource',
    upscale: 'none',
    scale: { kind: 'source' },
    restoration: NO_RESTORATION,
    audio: 'copy',
    frameRate: null,
  }
}

/**
 * Whether a stream copy can honour this edit.
 *
 * A hole has to be drawn, and nothing can be drawn into a copied stream, so the
 * presence of one decides the mode regardless of what was selected. Surfacing
 * this in the interface is better than letting the backend promote the mode
 * silently and leaving the user wondering why a copy took four minutes.
 */
export function canCopyStreams(
  spec: ExportSpec,
  hasGaps: boolean,
  spansMedia: boolean,
): boolean {
  // Two files cannot be copied into one stream however alike their encodings
  // look, which puts a second file in the same category as a hole.
  return !hasGaps && !spansMedia && spec.upscale === 'none' && isRestorationOff(spec.restoration)
}

export function isRestorationOff(restoration: Restoration): boolean {
  return restoration.denoise === 'off' && restoration.sharpen === 'off' && !restoration.deband
}

/** Resolves a scale target against a source size, rounding to even dimensions. */
export function resolveScale(
  scale: ScaleTarget,
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number } {
  const even = (value: number) => Math.max(16, Math.min(15360, Math.round(value))) & ~1

  switch (scale.kind) {
    case 'source':
      return { width: even(sourceWidth), height: even(sourceHeight) }
    case 'multiplier': {
      const factor = Math.min(Math.max(scale.factor, 0.25), 8)
      return { width: even(sourceWidth * factor), height: even(sourceHeight * factor) }
    }
    case 'absolute':
      return { width: even(scale.width), height: even(scale.height) }
  }
}

/**
 * Very rough time estimate, in seconds, for a progress expectation rather than a
 * promise.
 *
 * Encoding speed depends on the machine, the codec and the footage, so this only
 * has to get the order of magnitude right: seconds for a copy, minutes for a
 * re-encode, longer for an upscale. It is presented as an approximation in the
 * interface for exactly that reason.
 */
export function estimateSeconds(spec: ExportSpec, outputDuration: number, pixelRatio: number): number {
  if (spec.mode === 'fast') return Math.max(1, outputDuration * 0.02)

  const base = outputDuration * 0.12
  const scaleCost = spec.upscale === 'none' ? 1 : Math.max(1, pixelRatio) * upscaleCost(spec.upscale)
  const restorationCost = isRestorationOff(spec.restoration) ? 1 : 1.6

  return Math.max(2, base * scaleCost * restorationCost)
}

function upscaleCost(upscale: UpscaleAlgorithm): number {
  switch (upscale) {
    case 'none':
      return 1
    case 'lanczos':
      return 1.4
    case 'placebo':
      return 1.2
    case 'detail':
      return 1.8
  }
}
