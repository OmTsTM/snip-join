import { clamp, contains, duration, EPSILON, intersect, isEmpty, overlaps, span, type Span } from './time'

/** Opaque identifier so a block id cannot be mixed up with any other string. */
export type BlockId = string & { readonly __brand: 'BlockId' }

/**
 * One surviving piece of a medium.
 *
 * `mediaId` says which file it comes from, `source` is the stretch of that file
 * this block shows, and `start` is where that stretch sits on the edited
 * timeline. Keeping them independent is the whole trick: moving a block changes
 * only `start`, and nothing is copied, re-read or re-encoded until export.
 */
export interface Block {
  readonly id: BlockId
  /** The file this piece reads from, which is its path. */
  readonly mediaId: string
  readonly source: Span
  readonly start: number
}

/**
 * What happens to the rest of the video when a piece is taken out.
 *
 * `join` closes the hole so the result runs without interruption. `gap` leaves
 * the hole where it was, which becomes black and silence on export.
 */
export type TimelineMode = 'join' | 'gap'

export interface Timeline {
  /** Always sorted by `start` and never overlapping. */
  readonly blocks: readonly Block[]
  readonly mode: TimelineMode
}

let counter = 0

/** Ids are per-session and never persisted, so a counter is enough. */
export function nextBlockId(): BlockId {
  counter += 1
  return `b${counter}` as BlockId
}

export function blockEnd(block: Block): number {
  return block.start + duration(block.source)
}

export function blockSpan(block: Block): Span {
  return span(block.start, blockEnd(block))
}

/** A freshly opened video: one block covering the whole thing. */
export function createTimeline(
  mediaId: string,
  sourceDuration: number,
  mode: TimelineMode = 'join',
): Timeline {
  return {
    blocks: [{ id: nextBlockId(), mediaId, source: span(0, sourceDuration), start: 0 }],
    mode,
  }
}

/**
 * Adds a whole medium after everything already on the timeline.
 *
 * Appending rather than placing: where it ends up is the user's business, and
 * every gesture that moves a block already exists.
 */
export function appendMedium(
  timeline: Timeline,
  mediaId: string,
  sourceDuration: number,
): Timeline {
  const block: Block = {
    id: nextBlockId(),
    mediaId,
    source: span(0, sourceDuration),
    start: totalDuration(timeline),
  }
  return settle(timeline, [...timeline.blocks, block])
}

/**
 * Whether the timeline reads from more than one file.
 *
 * This is what makes a stream copy impossible: packets from two encodings
 * cannot be concatenated however alike the two files look.
 */
export function spansMultipleMedia(timeline: Timeline): boolean {
  const first = timeline.blocks[0]?.mediaId
  return timeline.blocks.some((block) => block.mediaId !== first)
}

/**
 * Replaces the whole block list, restoring the invariants.
 *
 * The one way to hand `settle` an arbitrary list from outside this module.
 * Dropping every block of a removed medium is the case it exists for.
 */
export function withBlocks(timeline: Timeline, blocks: readonly Block[]): Timeline {
  return settle(timeline, blocks)
}

/**
 * Which medium plays at a position.
 *
 * Inside a hole it answers with the medium of the piece before it rather than
 * nothing. The alternative unmounts the video element every time the playhead
 * crosses a hole, which reloads the file and costs a visible stall on the far
 * side; the curtain over the picture is what says there is nothing there.
 */
export function mediaAt(timeline: Timeline, at: number): string | null {
  const here = blockAt(timeline, at)
  if (here) return here.mediaId

  let previous: Block | null = null
  for (const block of timeline.blocks) {
    if (block.start <= at) previous = block
  }
  return (previous ?? timeline.blocks[0])?.mediaId ?? null
}

/** Every medium the timeline uses, in the order the blocks first reach for it. */
export function mediaOrder(timeline: Timeline): string[] {
  const seen: string[] = []
  for (const block of timeline.blocks) {
    if (!seen.includes(block.mediaId)) seen.push(block.mediaId)
  }
  return seen
}

export function totalDuration(timeline: Timeline): number {
  return timeline.blocks.reduce((longest, block) => Math.max(longest, blockEnd(block)), 0)
}

export function blockAt(timeline: Timeline, at: number): Block | null {
  return timeline.blocks.find((block) => contains(blockSpan(block), at)) ?? null
}

export function findBlock(timeline: Timeline, id: BlockId): Block | null {
  return timeline.blocks.find((block) => block.id === id) ?? null
}

/**
 * Maps a position on the edited timeline back to a position in the source file.
 *
 * Returns `null` inside a hole, which is what tells the player to show black
 * rather than seek somewhere arbitrary.
 */
export function sourceAt(timeline: Timeline, at: number): number | null {
  const block = blockAt(timeline, at)
  if (!block) return null
  return block.source.start + (at - block.start)
}

/** The holes on the timeline, in order. */
export function gaps(timeline: Timeline): Span[] {
  const result: Span[] = []
  let cursor = 0

  for (const block of timeline.blocks) {
    if (block.start - cursor > EPSILON) result.push(span(cursor, block.start))
    cursor = Math.max(cursor, blockEnd(block))
  }

  return result
}

export function isContiguous(timeline: Timeline): boolean {
  return gaps(timeline).length === 0
}

/** Every instant a drag should be attracted to: block edges and the start. */
export function snapCandidates(timeline: Timeline, exclude?: BlockId): number[] {
  const candidates = [0]
  for (const block of timeline.blocks) {
    if (block.id === exclude) continue
    candidates.push(block.start, blockEnd(block))
  }
  return candidates
}

function sorted(blocks: readonly Block[]): Block[] {
  return [...blocks].sort((a, b) => a.start - b.start)
}

/**
 * Lays blocks end to end, closing every hole.
 *
 * Order is preserved, so this is a re-flow rather than a re-sort: a block the
 * user dragged to third place stays third.
 */
function relayout(blocks: readonly Block[]): Block[] {
  let cursor = 0
  return blocks.map((block) => {
    const placed = { ...block, start: cursor }
    cursor += duration(block.source)
    return placed
  })
}

/**
 * Restores the invariants after any edit: sorted, and reflowed when the mode
 * says holes are not allowed.
 *
 * Every operation funnels through here so the rules live in one place instead of
 * being re-derived at each call site.
 */
function settle(timeline: Timeline, blocks: readonly Block[]): Timeline {
  const kept = blocks.filter((block) => !isEmpty(block.source))

  // Which field is authoritative depends on the mode, and getting this backwards
  // silently undoes every reorder. With holes closed, `start` is derived from the
  // running order, so the array order wins and sorting by `start` would restore
  // the order a drag just changed. With holes allowed, `start` is what the user
  // set directly, so it is the array order that has to follow.
  return timeline.mode === 'join'
    ? { ...timeline, blocks: relayout(kept) }
    : { ...timeline, blocks: sorted(kept) }
}

export function setMode(timeline: Timeline, mode: TimelineMode): Timeline {
  if (timeline.mode === mode) return timeline
  // Switching to `join` closes the existing holes; switching to `gap` leaves the
  // current layout alone, so holes only appear from the next removal onward.
  return settle({ ...timeline, mode }, timeline.blocks)
}

/**
 * Cuts a block in two at a position on the timeline.
 *
 * Returns the block untouched when the cut lands on one of its own edges: a
 * zero-length piece is not a block, it is a rounding error.
 */
function splitBlock(block: Block, at: number): Block[] {
  const offset = at - block.start
  if (offset <= EPSILON || offset >= duration(block.source) - EPSILON) return [block]

  const cutPoint = block.source.start + offset
  return [
    { ...block, source: span(block.source.start, cutPoint) },
    { id: nextBlockId(), mediaId: block.mediaId, source: span(cutPoint, block.source.end), start: at },
  ]
}

/** Splits whatever block sits under `at`, so the cut becomes a real seam. */
export function splitAt(timeline: Timeline, at: number): Timeline {
  const target = blockAt(timeline, at)
  if (!target) return timeline

  const blocks = timeline.blocks.flatMap((block) =>
    block.id === target.id ? splitBlock(block, at) : [block],
  )
  return settle(timeline, blocks)
}

/**
 * Takes a stretch out of the timeline.
 *
 * In `join` mode what is left closes up into one continuous run. In `gap` mode
 * the surviving pieces stay where they are and the stretch becomes a hole.
 */
export function removeSpan(timeline: Timeline, range: Span): Timeline {
  if (isEmpty(range)) return timeline

  const blocks: Block[] = []

  for (const block of timeline.blocks) {
    const bounds = blockSpan(block)
    const cut = intersect(bounds, range)

    if (!cut) {
      blocks.push(block)
      continue
    }

    // The head that survives before the cut.
    if (cut.start - bounds.start > EPSILON) {
      blocks.push({
        ...block,
        source: span(block.source.start, block.source.start + (cut.start - bounds.start)),
      })
    }

    // The tail that survives after it, which keeps its own identity so an undo
    // and a redo do not renumber the whole timeline.
    if (bounds.end - cut.end > EPSILON) {
      blocks.push({
        id: nextBlockId(),
        mediaId: block.mediaId,
        source: span(block.source.start + (cut.end - bounds.start), block.source.end),
        start: cut.end,
      })
    }
  }

  return settle(timeline, blocks)
}

/**
 * Turns a stretch into a block of its own without removing anything.
 *
 * This is what makes a piece movable: once it is its own block it can be
 * dragged anywhere on the timeline, which is the difference between deleting a
 * section and relocating it.
 */
export function isolateSpan(timeline: Timeline, range: Span): { timeline: Timeline; isolated: BlockId | null } {
  if (isEmpty(range)) return { timeline, isolated: null }

  let blocks: Block[] = [...timeline.blocks]
  for (const at of [range.start, range.end]) {
    const target = blocks.find((block) => contains(blockSpan(block), at))
    if (!target) continue
    blocks = blocks.flatMap((block) => (block.id === target.id ? splitBlock(block, at) : [block]))
  }

  const settled = settle(timeline, blocks)
  // After a reflow the positions have moved, so the isolated block is found by
  // the source range it covers rather than by where it used to sit.
  const isolated =
    settled.blocks.find(
      (block) =>
        overlaps(blockSpan(block), range) &&
        Math.abs(duration(block.source) - (range.end - range.start)) < 0.05,
    ) ?? null

  return { timeline: settled, isolated: isolated?.id ?? null }
}

export function removeBlock(timeline: Timeline, id: BlockId): Timeline {
  return settle(
    timeline,
    timeline.blocks.filter((block) => block.id !== id),
  )
}

/**
 * The stretches of timeline not occupied by any block other than `exclude`.
 *
 * The last interval is open-ended: a block can always be dragged past the end of
 * everything else.
 */
function freeIntervals(timeline: Timeline, exclude: BlockId): Span[] {
  const occupied = sorted(timeline.blocks.filter((block) => block.id !== exclude)).map(blockSpan)
  const free: Span[] = []
  let cursor = 0

  for (const range of occupied) {
    if (range.start - cursor > EPSILON) free.push(span(cursor, range.start))
    cursor = Math.max(cursor, range.end)
  }
  free.push(span(cursor, Number.POSITIVE_INFINITY))

  return free
}

/**
 * Moves a block to a new position.
 *
 * The two modes mean genuinely different things here. With holes allowed, the
 * block goes exactly where it was dropped, limited to a stretch that is actually
 * free. With holes closed, position has no independent meaning, so the drop
 * decides a new place in the running order instead.
 */
export function moveBlock(timeline: Timeline, id: BlockId, desiredStart: number): Timeline {
  const moving = findBlock(timeline, id)
  if (!moving) return timeline

  const length = duration(moving.source)

  if (timeline.mode === 'join') {
    const others = timeline.blocks.filter((block) => block.id !== id)

    // The drop lands after every block whose midpoint the dragged block's left
    // edge has passed. The left edge is the reference rather than the centre
    // because it is the edge the pointer is aligned with, and because a centre
    // ties exactly with the first midpoint when a block is dropped at the very
    // start, which would refuse to move anything to the front.
    let index = 0
    let cursor = 0
    for (const block of others) {
      const blockLength = duration(block.source)
      if (desiredStart <= cursor + blockLength / 2) break
      cursor += blockLength
      index += 1
    }

    const reordered = [...others]
    reordered.splice(index, 0, moving)
    return settle(timeline, reordered)
  }

  // Holes allowed: land in the free stretch nearest to where it was dropped.
  const wanted = Math.max(0, desiredStart)
  const candidates = freeIntervals(timeline, id).filter((free) => duration(free) >= length - EPSILON)
  if (candidates.length === 0) return timeline

  let best = candidates[0]!
  let bestDistance = Number.POSITIVE_INFINITY
  for (const free of candidates) {
    const clamped = clamp(wanted, free.start, Math.max(free.start, free.end - length))
    const distance = Math.abs(clamped - wanted)
    if (distance < bestDistance) {
      best = free
      bestDistance = distance
    }
  }

  const start = clamp(wanted, best.start, Math.max(best.start, best.end - length))
  return settle(
    timeline,
    timeline.blocks.map((block) => (block.id === id ? { ...block, start } : block)),
  )
}

/**
 * Trims one edge of a block without moving the other.
 *
 * Trimming reveals or hides source material, so the source range changes rather
 * than the block sliding along the timeline.
 */
export function trimBlock(
  timeline: Timeline,
  id: BlockId,
  edge: 'start' | 'end',
  at: number,
  sourceDuration: number,
): Timeline {
  const block = findBlock(timeline, id)
  if (!block) return timeline

  const minimum = 1 / 60

  if (edge === 'start') {
    const offset = at - block.start
    const nextSourceStart = clamp(
      block.source.start + offset,
      0,
      block.source.end - minimum,
    )
    const delta = nextSourceStart - block.source.start
    return settle(
      timeline,
      timeline.blocks.map((candidate) =>
        candidate.id === id
          ? {
              ...candidate,
              source: span(nextSourceStart, candidate.source.end),
              start: candidate.start + delta,
            }
          : candidate,
      ),
    )
  }

  const nextSourceEnd = clamp(
    block.source.start + (at - block.start),
    block.source.start + minimum,
    sourceDuration,
  )
  return settle(
    timeline,
    timeline.blocks.map((candidate) =>
      candidate.id === id
        ? { ...candidate, source: span(candidate.source.start, nextSourceEnd) }
        : candidate,
    ),
  )
}

/** How much of the original is still on the timeline. */
export function keptDuration(timeline: Timeline): number {
  return timeline.blocks.reduce((total, block) => total + duration(block.source), 0)
}
