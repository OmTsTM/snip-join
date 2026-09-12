import { create } from 'zustand'

/** The file being carried out of the pool. */
export interface MediaDragSource {
  readonly path: string
  readonly fileName: string
  readonly duration: number
  /** `still` is a single frame, whose length on the timeline is the user's. */
  readonly kind: 'motion' | 'still'
}

interface MediaDragState {
  /** Null whenever nothing is being carried. */
  source: MediaDragSource | null
  /** Pointer position, in client coordinates, for the ghost under the cursor. */
  x: number
  y: number
  /**
   * Where on the timeline the drop would land, or null while the pointer is
   * anywhere else.
   *
   * The timeline writes this, because it is the only part of the application
   * that knows its own scroll offset and scale. The pool reads it when the
   * pointer comes up, which is what turns a drag into a placement.
   */
  target: number | null

  begin: (source: MediaDragSource, x: number, y: number) => void
  moveTo: (x: number, y: number) => void
  setTarget: (at: number | null) => void
  end: () => void
}

/**
 * A drag from the media pool onto the timeline.
 *
 * Its own store rather than a corner of the editor's. This changes sixty times
 * a second while a file is in flight, and every component reading the editor
 * store would re-render along with it — the filmstrip included, which is the
 * most expensive thing on screen. Nothing here outlives the gesture, so none of
 * it belongs in the undo history either.
 */
export const useMediaDrag = create<MediaDragState>((set) => ({
  source: null,
  x: 0,
  y: 0,
  target: null,

  begin(source, x, y) {
    set({ source, x, y, target: null })
  },

  moveTo(x, y) {
    set({ x, y })
  },

  setTarget(at) {
    set({ target: at })
  },

  end() {
    set({ source: null, target: null })
  },
}))

/** True while a file is being carried, as a primitive a selector can compare. */
export const selectDragging = (state: MediaDragState): boolean => state.source !== null
