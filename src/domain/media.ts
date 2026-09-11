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
