/**
 * How tall the timeline dock is allowed to be.
 *
 * The dock starts at its smallest and only grows: the default is the size the
 * editor was designed around, and shrinking below it would clip the block
 * handles. Growing trades preview area for a taller filmstrip, which is what
 * someone scrubbing for an exact moment actually wants.
 */

/** Toolbar strip above the ruler. */
export const TOOLBAR_HEIGHT = 40
/** The time ruler, which sits at the top of the scrolling canvas. */
export const RULER_HEIGHT = 22
/** Gap between the ruler and the top of the block track. */
export const TRACK_GAP = 10
/** Breathing room under the block track. */
export const TRACK_BOTTOM = 16

/** Shortest a block may be: the handle plus a readable strip of picture. */
export const MIN_BLOCK_HEIGHT = 70
/**
 * Tallest a block may be.
 *
 * Past this the filmstrip stops telling you more and the preview has been
 * starved for no gain, so the limit is on the useful range rather than on what
 * the window could physically fit.
 */
export const MAX_BLOCK_HEIGHT = 320

/**
 * Space the stage must keep.
 *
 * Enough for a 16:9 preview and the transport row underneath. Without this the
 * dock could be dragged over the picture on a short window, which is not a trade
 * the user is trying to make.
 */
export const MIN_STAGE_HEIGHT = 260

/** Height of the title bar, which is outside both the stage and the dock. */
const TITLE_BAR_HEIGHT = 40

/**
 * Everything in the dock that is not the block track itself.
 *
 * The ruler belongs here. Leaving it out makes the track overflow the canvas by
 * exactly its height and puts the floor below the size the editor was laid out
 * for, which is the opposite of what the divider is supposed to guarantee.
 */
const CHROME = TOOLBAR_HEIGHT + RULER_HEIGHT + TRACK_GAP + TRACK_BOTTOM

/** Dock height that leaves the block track at its smallest. */
export const MIN_DOCK_HEIGHT = CHROME + MIN_BLOCK_HEIGHT
/** Dock height that leaves the block track at its tallest. */
export const MAX_DOCK_HEIGHT = CHROME + MAX_BLOCK_HEIGHT

/**
 * Largest dock the window can afford.
 *
 * Two limits apply and the smaller wins: the useful range of the filmstrip, and
 * whatever is left after the stage takes its minimum. On a short window the
 * second one binds, which is why the dock stops growing before it reaches its
 * nominal maximum.
 */
export function maxDockHeight(windowHeight: number): number {
  const afterStage = windowHeight - TITLE_BAR_HEIGHT - MIN_STAGE_HEIGHT
  return Math.max(MIN_DOCK_HEIGHT, Math.min(MAX_DOCK_HEIGHT, afterStage))
}

/** Clamps a requested dock height into what is allowed right now. */
export function clampDockHeight(desired: number, windowHeight: number): number {
  if (!Number.isFinite(desired)) return MIN_DOCK_HEIGHT
  return Math.round(Math.min(Math.max(desired, MIN_DOCK_HEIGHT), maxDockHeight(windowHeight)))
}

/** Block height implied by a dock height. */
export function blockHeightFor(dockHeight: number): number {
  return Math.max(MIN_BLOCK_HEIGHT, dockHeight - CHROME)
}

/** Canvas height implied by a dock height: everything below the toolbar. */
export function canvasHeightFor(dockHeight: number): number {
  return Math.max(0, dockHeight - TOOLBAR_HEIGHT)
}
