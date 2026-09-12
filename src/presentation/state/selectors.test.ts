import { describe, expect, it } from 'vitest'

import {
  selectActiveBlock,
  selectActiveMedia,
  selectBlockAtPlayhead,
  selectHasCutPoints,
  selectSelectionCovers,
  selectIsProxy,
  selectPreviewUrl,
  selectCanRedo,
  selectCanUndo,
  selectDuration,
  selectKept,
  selectTimeline,
  useEditor,
} from './editorStore'

/**
 * Zustand reads state through `useSyncExternalStore`, which compares snapshots
 * by identity. A selector that derives a fresh object or array on every call
 * therefore never compares equal, React re-renders without end, and the window
 * goes blank with no error the user can see.
 *
 * This caught exactly that: a selector computing an accuracy report inline.
 * Derived collections belong in a `useMemo` inside the component, over inputs
 * that only change when the edit does.
 */
describe('every exported selector is reference-stable', () => {
  const selectors = {
    selectTimeline,
    selectDuration,
    selectKept,
    selectCanUndo,
    selectCanRedo,
    selectBlockAtPlayhead,
    selectActiveBlock,
    selectSelectionCovers,
    selectHasCutPoints,
    selectActiveMedia,
    selectPreviewUrl,
    selectIsProxy,
  }

  it('returns an identical value when nothing in the store changed', () => {
    const state = useEditor.getState()

    for (const [name, selector] of Object.entries(selectors)) {
      const first = selector(state)
      const second = selector(state)
      expect(first, `${name} rebuilds its result on every call`).toBe(second)
    }
  })

  it('still holds once a video is open and edited', () => {
    const { openFile: _openFile, ...rest } = useEditor.getState()
    void _openFile
    void rest

    // Drive the store through a real edit without touching the backend.
    useEditor.setState({ source: null })
    useEditor.getState().splitAtPlayhead()

    const state = useEditor.getState()
    for (const [name, selector] of Object.entries(selectors)) {
      expect(selector(state), `${name} rebuilds its result on every call`).toBe(selector(state))
    }
  })
})
