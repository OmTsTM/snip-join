import { span } from './time'
import { nextBlockId, type Block, type Timeline, type TimelineMode } from './timeline'

/**
 * What a saved project holds, and what it deliberately does not.
 *
 * Paths and cuts. Not the frames, not the preview copies, not the cut points —
 * everything that can be read again from the files is read again, so a project
 * stays a few kilobytes and never goes stale against the media it names. What it
 * cannot recover is the edit itself, which is exactly what it stores.
 *
 * Block ids are left out on purpose. They are per-session counters with no
 * meaning outside the run that made them; reopening a project mints fresh ones
 * and nothing downstream can tell.
 */
export interface Project {
  /**
   * The shape this file was written in.
   *
   * A number rather than the application's version: what matters when reading
   * is whether the fields are the ones expected, and the two move for different
   * reasons. A file from the future is refused rather than guessed at.
   */
  readonly version: number
  /** Every file the project draws on, in the order the pool held them. */
  readonly media: readonly string[]
  readonly mode: TimelineMode
  readonly blocks: readonly ProjectBlock[]
}

export interface ProjectBlock {
  /** Index into `media`, so a path is written once however many blocks use it. */
  readonly media: number
  readonly sourceStart: number
  readonly sourceEnd: number
  readonly start: number
}

/** The only shape this build writes. */
export const PROJECT_VERSION = 1

export const PROJECT_EXTENSION = 'snipjoin'

/** Flattens the editor's state into the file's shape. */
export function toProject(media: readonly string[], timeline: Timeline): Project {
  return {
    version: PROJECT_VERSION,
    media: [...media],
    mode: timeline.mode,
    blocks: timeline.blocks.map((block) => ({
      media: Math.max(0, media.indexOf(block.mediaId)),
      sourceStart: block.source.start,
      sourceEnd: block.source.end,
      start: block.start,
    })),
  }
}

export function serialiseProject(project: Project): string {
  // Indented: a project is small, and a file someone can read when something has
  // gone wrong is worth more than the bytes it saves.
  return `${JSON.stringify(project, null, 2)}\n`
}

/**
 * Reads a project back, refusing anything it cannot honour.
 *
 * Every field is treated as untrusted: this file was last touched by a text
 * editor as easily as by this application, and a malformed block reaching the
 * timeline is a crash in a place with no way to explain itself.
 */
export function parseProject(text: string): Project {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('that file is not a Snip Join project')
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('that file is not a Snip Join project')
  }

  const record = raw as Record<string, unknown>
  const version = typeof record.version === 'number' ? record.version : 0

  if (version < 1) throw new Error('that file is not a Snip Join project')
  if (version > PROJECT_VERSION) {
    throw new Error('that project was saved by a newer version of Snip Join')
  }

  const media = Array.isArray(record.media)
    ? record.media.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
  if (media.length === 0) throw new Error('that project names no files')

  const mode: TimelineMode = record.mode === 'gap' ? 'gap' : 'join'

  const blocks = (Array.isArray(record.blocks) ? record.blocks : [])
    .map((entry) => readBlock(entry, media.length))
    .filter((block): block is ProjectBlock => block !== null)

  return { version: PROJECT_VERSION, media, mode, blocks }
}

function readBlock(entry: unknown, mediaCount: number): ProjectBlock | null {
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>

  const media = finite(record.media)
  const sourceStart = finite(record.sourceStart)
  const sourceEnd = finite(record.sourceEnd)
  const start = finite(record.start)

  if (media === null || sourceStart === null || sourceEnd === null || start === null) return null
  // A block naming a file the project did not list has nothing to read from, and
  // a zero-length one is a rounding error rather than a piece of video.
  if (media < 0 || media >= mediaCount) return null
  if (sourceStart < 0 || sourceEnd <= sourceStart || start < 0) return null

  return { media: Math.floor(media), sourceStart, sourceEnd, start }
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Rebuilds a timeline from a project.
 *
 * `settle` is not applied here: the caller owns that, because it is also what
 * decides whether a medium that has gone missing takes its blocks with it.
 */
export function projectTimeline(project: Project): Timeline {
  const blocks: Block[] = project.blocks.map((block) => ({
    id: nextBlockId(),
    mediaId: project.media[block.media] ?? '',
    source: span(block.sourceStart, block.sourceEnd),
    start: block.start,
  }))

  return { blocks, mode: project.mode }
}

/** The name a project is shown under: its file name, without the extension. */
export function projectName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path
  return file.replace(new RegExp(`\\.${PROJECT_EXTENSION}$`, 'i'), '')
}
