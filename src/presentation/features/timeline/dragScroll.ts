import { create } from 'zustand'

interface DragScrollState {
  /**
   * How many pointer gestures are running that the view should follow.
   *
   * A count rather than a flag: a second gesture cannot start before the first
   * ends on the same pointer, but a stray `pointercancel` arriving after a
   * clean end would otherwise switch the view off underneath a live drag.
   */
  running: number
  begin: () => void
  end: () => void
}

/**
 * Which gestures make the timeline follow the pointer to the edge of the view.
 *
 * Its own store rather than state in the dock, because the gestures live in
 * three different components — a block's handle, a block's edges, and the
 * selection rails — and all three need to say the same thing to the one element
 * that can scroll. Nothing renders from it beyond that, and it outlives no
 * gesture, so it has no business in the editor's store or its undo history.
 *
 * Without this, an edge dragged to the side of the window simply stops: the
 * pointer has run out of screen, and a block sitting at the far right of a long
 * timeline could not be made any longer at all.
 */
export const useDragScroll = create<DragScrollState>((set) => ({
  running: 0,
  begin: () => set((state) => ({ running: state.running + 1 })),
  end: () => set((state) => ({ running: Math.max(0, state.running - 1) })),
}))

/** True while any such gesture is running, as a primitive a selector can compare. */
export const selectFollowing = (state: DragScrollState): boolean => state.running > 0

/** Starts and stops one gesture without subscribing the caller to the store. */
export const beginDragScroll = (): void => useDragScroll.getState().begin()
export const endDragScroll = (): void => useDragScroll.getState().end()
