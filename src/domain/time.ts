/**
 * Tolerance for comparing two timeline instants.
 *
 * Media timestamps are floating point seconds, so exact equality never holds
 * after arithmetic. One microsecond sits far below a single frame at any
 * realistic frame rate.
 */
export const EPSILON = 1e-6

/** A half-open interval on a timeline, in seconds. */
export interface Span {
  readonly start: number
  readonly end: number
}

export function span(start: number, end: number): Span {
  return { start, end }
}

export function duration(value: Span): number {
  return value.end - value.start
}

export function isEmpty(value: Span): boolean {
  return duration(value) <= EPSILON
}

export function contains(value: Span, at: number): boolean {
  return at >= value.start - EPSILON && at < value.end - EPSILON
}

export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end - EPSILON && b.start < a.end - EPSILON
}

export function intersect(a: Span, b: Span): Span | null {
  const result = span(Math.max(a.start, b.start), Math.min(a.end, b.end))
  return isEmpty(result) ? null : result
}

export function clamp(value: number, lower: number, upper: number): number {
  if (Number.isNaN(value)) return lower
  return Math.min(Math.max(value, lower), upper)
}

/** Rounds to whole frames so a cut always lands on a real frame boundary. */
export function snapToFrame(seconds: number, frameRate: number): number {
  if (!Number.isFinite(frameRate) || frameRate <= 0) return seconds
  return Math.round(seconds * frameRate) / frameRate
}

/**
 * Formats as `H:MM:SS.mmm`, dropping the hour on shorter clips.
 *
 * Hiding a leading `00:` keeps the common case readable; most clips people trim
 * are minutes long, and a permanent zeroed hour field is noise.
 */
export function formatTimecode(seconds: number, options: { readonly frames?: boolean } = {}): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const totalMs = Math.round(safe * 1000)
  const ms = totalMs % 1000
  const totalSeconds = Math.floor(totalMs / 1000)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)

  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  const body = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`

  return options.frames === false ? body : `${body}.${pad(ms, 3)}`
}

/** Compact duration for labels, such as `2m 42s` or `1h 04m`. */
export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const total = Math.round(safe)
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const s = total % 60

  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/**
 * Pulls a value onto the nearest candidate within `threshold`.
 *
 * This is what makes dragging feel deliberate rather than approximate: a block
 * dropped near a seam lands exactly on it instead of a few milliseconds off,
 * which would leave a sliver of black nobody asked for.
 */
export function snapTo(value: number, candidates: readonly number[], threshold: number): number {
  let best = value
  let bestDistance = threshold

  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }

  return best
}
