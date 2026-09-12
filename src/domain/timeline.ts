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

/**
 * The part of a range that actually sits on surviving material.
 *
 * Rails can be dragged across a hole, and a hole holds nothing: removing one is
 * removing an absence. Narrowing the range to the material underneath it is what
 * lets a removal report — and act on — what it will really take out, and what
 * lets the interface refuse the gesture when the answer is nothing at all.
 */
export function coveredSpan(timeline: Timeline, range: Span): Span | null {
  if (isEmpty(range)) return null

  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY

  for (const block of timeline.blocks) {
    const cut = intersect(blockSpan(block), range)
    if (!cut) continue
    start = Math.min(start, cut.start)
    end = Math.max(end, cut.end)
  }

  return end - start > EPSILON ? span(start, end) : null
}

/** The piece a clipboard holds: which file, and which stretch of it. */
export interface Clip {
  readonly mediaId: string
  readonly source: Span
}

/**
 * Puts a piece on the timeline at a position, without disturbing the rest.
 *
 * The two modes disagree about what "at a position" means, in the same way they
 * disagree about a drag. With holes closed the position picks a place in the
 * running order, so the block underneath is split first and the piece lands in
 * the seam that leaves — which is what makes a paste land at the playhead rather
 * than at the nearest block boundary. With holes allowed the position is
 * literal, so the piece goes to the nearest stretch of timeline that is free.
 */
export function insertClip(
  timeline: Timeline,
  clip: Clip,
  at: number,
): { timeline: Timeline; inserted: BlockId | null } {
  if (isEmpty(clip.source)) return { timeline, inserted: null }

  const id = nextBlockId()
  const wanted = Math.max(0, at)

  if (timeline.mode === 'join') {
    const seamed = splitAt(timeline, wanted)
    const blocks = [...seamed.blocks]
    const index = blocks.findIndex((block) => block.start >= wanted - EPSILON)
    blocks.splice(index === -1 ? blocks.length : index, 0, {
      id,
      mediaId: clip.mediaId,
      source: clip.source,
      start: wanted,
    })
    return { timeline: settle(seamed, blocks), inserted: id }
  }

  // Parked past everything first, then moved: `moveBlock` already knows how to
  // find the nearest free stretch, and doing it here a second time is how the
  // two would drift apart.
  const parked: Block = {
    id,
    mediaId: clip.mediaId,
    source: clip.source,
    start: totalDuration(timeline),
  }
  const parkedTimeline = settle(timeline, [...timeline.blocks, parked])
  return { timeline: moveBlock(parkedTimeline, id, wanted), inserted: id }
}

/** Puts a second copy of a block directly after it. */
export function duplicateBlock(
  timeline: Timeline,
  id: BlockId,
): { timeline: Timeline; inserted: BlockId | null } {
  const block = findBlock(timeline, id)
  if (!block) return { timeline, inserted: null }
  return insertClip(timeline, { mediaId: block.mediaId, source: block.source }, blockEnd(block))
}

/**
 * Moves a block to a place in the running order.
 *
 * What the block list's own drag produces: there the pieces are a list and a
 * list has indices, where on the timeline they are a length of film and have
 * positions. The two modes disagree about which of those is real, so this says
 * both — with the ends joined the index *is* the answer, and with holes allowed
 * the arrangement is kept and only its occupants change places: the first start
 * and every gap between neighbours survive, so reordering a list cannot quietly
 * close a hole the user put there.
 */
export function reorderBlock(timeline: Timeline, id: BlockId, toIndex: number): Timeline {
  const ordered = sorted(timeline.blocks)
  const from = ordered.findIndex((block) => block.id === id)
  if (from === -1) return timeline

  const to = Math.max(0, Math.min(Math.round(toIndex), ordered.length - 1))
  if (to === from) return timeline

  const next = [...ordered]
  const [lifted] = next.splice(from, 1)
  next.splice(to, 0, lifted!)

  if (timeline.mode === 'join') return settle(timeline, next)

  const holes = ordered
    .slice(1)
    .map((block, index) => Math.max(0, block.start - blockEnd(ordered[index]!)))

  let cursor = ordered[0]!.start
  const placed = next.map((block, index) => {
    const at = cursor
    cursor = at + duration(block.source) + (holes[index] ?? 0)
    return { ...block, start: at }
  })

  return settle(timeline, placed)
}

/**
 * Swaps a block with the one beside it.
 *
 * The keyboard counterpart to dragging, and the reason reordering does not
 * depend on hitting a twenty-pixel handle. With holes closed this is a move in
 * the running order and nothing else. With holes allowed the position is the
 * user's, so the pair trades places inside the stretch the two of them already
 * occupied: the outer bounds and the hole between them are both preserved,
 * which is what keeps the swap from disturbing anything further along.
 */
export function shiftBlock(timeline: Timeline, id: BlockId, direction: 1 | -1): Timeline {
  const ordered = sorted(timeline.blocks)
  const index = ordered.findIndex((block) => block.id === id)
  if (index === -1) return timeline

  const partnerIndex = index + direction
  const moving = ordered[index]
  const partner = ordered[partnerIndex]
  if (!moving || !partner) return timeline

  if (timeline.mode === 'join') {
    const blocks = [...timeline.blocks]
    const from = blocks.findIndex((block) => block.id === id)
    const to = from + direction
    if (to < 0 || to >= blocks.length) return timeline
    const [lifted] = blocks.splice(from, 1)
    blocks.splice(to, 0, lifted!)
    return settle(timeline, blocks)
  }

  const [earlier, later] = direction === 1 ? [moving, partner] : [partner, moving]
  const between = later.start - blockEnd(earlier)
  const laterStart = earlier.start
  const earlierStart = laterStart + duration(later.source) + between

  return settle(
    timeline,
    timeline.blocks.map((block) => {
      if (block.id === earlier.id) return { ...block, start: earlierStart }
      if (block.id === later.id) return { ...block, start: laterStart }
      return block
    }),
  )
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
 * How far each edge of a block may be dragged before it reaches a neighbour.
 *
 * Only a real limit with holes allowed. There a block keeps the position the
 * user gave it and nothing reflows out of the way, so an edge dragged past the
 * block beside it lands *on top* of it — two pieces claiming the same instant,
 * which is not a timeline any export can describe, and which the interface drew
 * as one block sitting over another. With the ends joined there is nothing to
 * collide with: the reflow moves everything along.
 */
function trimBounds(timeline: Timeline, block: Block): Span {
  if (timeline.mode === 'join') {
    return span(0, Number.POSITIVE_INFINITY)
  }

  let lower = 0
  let upper = Number.POSITIVE_INFINITY

  for (const other of timeline.blocks) {
    if (other.id === block.id) continue
    // Judged against the edge that is not moving, so a neighbour that already
    // overlaps cannot make its own side unreachable.
    if (blockEnd(other) <= block.start + EPSILON) lower = Math.max(lower, blockEnd(other))
    if (other.start >= blockEnd(block) - EPSILON) upper = Math.min(upper, other.start)
  }

  return span(lower, upper)
}

/**
 * Trims one edge of a block without moving the other.
 *
 * Trimming reveals or hides source material, so the source range changes rather
 * than the block sliding along the timeline. The edge stops where the next
 * block begins: see `trimBounds`.
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
  const bounds = trimBounds(timeline, block)
  const wanted = clamp(at, bounds.start, bounds.end)

  if (edge === 'start') {
    const offset = wanted - block.start
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
    block.source.start + (wanted - block.start),
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
