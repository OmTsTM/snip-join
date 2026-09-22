import type { MediaSourceInfo, VideoStreamInfo } from '@infrastructure/tauri/api'

/**
 * The size a viewer actually sees.
 *
 * Phone clips carry a rotation in the container rather than in the pixels, so
 * the stored width and height are the wrong way round for a portrait video.
 * Every piece of the interface that lays out a frame has to use this, not the
 * raw dimensions.
 */
export function displaySize(video: VideoStreamInfo): { width: number; height: number } {
  const quarterTurned = video.rotation === 90 || video.rotation === 270
  return quarterTurned
    ? { width: video.height, height: video.width }
    : { width: video.width, height: video.height }
}

export function aspectRatio(video: VideoStreamInfo | null): number {
  if (!video) return 16 / 9
  const { width, height } = displaySize(video)
  return width > 0 && height > 0 ? width / height : 16 / 9
}

/** Total pixels per frame, used to scale the export time estimate. */
export function pixelCount(video: VideoStreamInfo | null): number {
  if (!video) return 1920 * 1080
  const { width, height } = displaySize(video)
  return Math.max(1, width * height)
}

/** Byte size in the units people read file sizes in. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  const decimals = value >= 100 || exponent <= 1 ? 0 : 1
  return `${value.toFixed(decimals)} ${units[exponent]}`
}

/** The extension to default an export to, which is the source's own. */
export function sourceExtension(source: MediaSourceInfo): string {
  const match = /\.([a-z0-9]+)$/i.exec(source.fileName)
  return match?.[1]?.toLowerCase() ?? 'mp4'
}

/**
 * Containers whose index lets a seek land on exactly the keyframe asked for.
 * Mirrors `INDEXED_CONTAINERS` in `src-tauri/src/domain/media.rs`.
 */
const INDEXED_CONTAINERS = ['mp4', 'mov', 'm4v', '3gp', 'matroska', 'webm']

/**
 * Whether an export can copy this file's packets and re-encode only the frames
 * beside each cut.
 *
 * The same rule as `MediaSource::supports_smart_cut` on the Rust side, kept in
 * step by hand like the rest of the export vocabulary: the dialog has to know
 * what the planner will do before the planner runs, or it promises a copy the
 * backend then quietly turns into a re-encode.
 */
export function supportsSmartCut(source: MediaSourceInfo): boolean {
  if (source.kind === 'still' || !source.video) return false
  const codecOk = source.video.codec === 'h264' || source.video.codec === 'hevc'
  const containerOk = source.container
    .split(',')
    .map((name) => name.trim())
    .some((name) => INDEXED_CONTAINERS.includes(name))
  return codecOk && containerOk
}
