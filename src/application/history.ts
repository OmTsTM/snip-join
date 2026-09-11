/**
 * A bounded undo stack over immutable snapshots.
 *
 * Snapshots rather than inverse commands: the timeline is a small immutable
 * value, so keeping whole copies costs almost nothing and removes an entire
 * class of bug where an undo and its redo drift apart. The cap keeps memory flat
 * no matter how long a session runs.
 */

export interface History<T> {
  readonly past: readonly T[]
  readonly present: T
  readonly future: readonly T[]
}

/** Deepest reachable undo. Beyond this the oldest state is dropped. */
export const HISTORY_LIMIT = 100

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] }
}

/**
 * Records a new state.
 *
 * Recording clears the redo branch, which is the standard contract: once you act
 * after undoing, the abandoned branch is gone.
 */
export function record<T>(history: History<T>, next: T): History<T> {
  if (Object.is(history.present, next)) return history

  const past = [...history.past, history.present]
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    present: next,
    future: [],
  }
}

/**
 * Replaces the current state without adding a step.
 *
 * Used for continuous gestures: a drag emits a state on every pointer move, and
 * recording each one would make a single drag take fifty undos to reverse. The
 * gesture records once when it starts, then amends until it ends.
 */
export function amend<T>(history: History<T>, next: T): History<T> {
  return { ...history, present: next }
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1]
  if (previous === undefined) return history

  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  }
}

export function redo<T>(history: History<T>): History<T> {
  const next = history.future[0]
  if (next === undefined) return history

  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  }
}
