import { describe, expect, it } from 'vitest'

import { amend, canRedo, canUndo, createHistory, HISTORY_LIMIT, record, redo, undo } from './history'

describe('the undo stack', () => {
  it('starts with nothing to undo or redo', () => {
    const history = createHistory('a')
    expect(canUndo(history)).toBe(false)
    expect(canRedo(history)).toBe(false)
    expect(history.present).toBe('a')
  })

  it('steps backward and forward through recorded states', () => {
    let history = record(record(createHistory('a'), 'b'), 'c')
    expect(history.present).toBe('c')

    history = undo(history)
    expect(history.present).toBe('b')

    history = undo(history)
    expect(history.present).toBe('a')
    expect(canUndo(history)).toBe(false)

    history = redo(history)
    expect(history.present).toBe('b')
  })

  it('drops the abandoned branch once you act after undoing', () => {
    let history = record(record(createHistory('a'), 'b'), 'c')
    history = undo(history)
    history = record(history, 'd')

    expect(canRedo(history)).toBe(false)
    expect(history.present).toBe('d')
    expect(undo(history).present).toBe('b')
  })

  it('ignores a recording that changes nothing', () => {
    const history = createHistory('a')
    expect(record(history, 'a')).toBe(history)
  })

  it('amends without adding a step, so one drag is one undo', () => {
    let history = record(createHistory('a'), 'b')
    history = amend(history, 'b1')
    history = amend(history, 'b2')

    expect(history.present).toBe('b2')
    expect(undo(history).present).toBe('a')
  })

  it('caps how far back it reaches so memory stays flat', () => {
    let history = createHistory(0)
    for (let step = 1; step <= HISTORY_LIMIT + 25; step += 1) {
      history = record(history, step)
    }

    expect(history.past).toHaveLength(HISTORY_LIMIT)
    expect(history.present).toBe(HISTORY_LIMIT + 25)
    expect(history.past[0]).toBe(25)
  })

  it('is a no-op at either end', () => {
    const history = createHistory('a')
    expect(undo(history)).toBe(history)
    expect(redo(history)).toBe(history)
  })
})
