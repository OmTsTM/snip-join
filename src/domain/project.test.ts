import { describe, expect, it } from 'vitest'

import {
  parseProject,
  projectName,
  projectTimeline,
  PROJECT_VERSION,
  serialiseProject,
  toProject,
} from './project'
import { span } from './time'
import { createTimeline, removeSpan, setMode, splitAt, type Timeline } from './timeline'

const MEDIA = ['a.mp4', 'b.mp4']

const edited = (): Timeline => {
  const timeline = removeSpan(splitAt(createTimeline('a.mp4', 60), 20), span(30, 40))
  return setMode(timeline, 'gap')
}

const layout = (timeline: Timeline) =>
  timeline.blocks.map((block) => ({
    media: block.mediaId,
    start: Number(block.start.toFixed(3)),
    source: [Number(block.source.start.toFixed(3)), Number(block.source.end.toFixed(3))],
  }))

describe('a project written and read back', () => {
  it('comes back as the same timeline', () => {
    const before = edited()
    const project = toProject(MEDIA, before)
    const after = projectTimeline(parseProject(serialiseProject(project)))

    expect(layout(after)).toEqual(layout(before))
    expect(after.mode).toBe(before.mode)
  })

  /**
   * Ids are per-session counters with no meaning outside the run that made
   * them, so they are not written down and reopening mints fresh ones.
   */
  it('does not carry block ids across', () => {
    const before = edited()
    const text = serialiseProject(toProject(MEDIA, before))

    expect(text).not.toContain(before.blocks[0]!.id)
    expect(projectTimeline(parseProject(text)).blocks[0]!.id).not.toBe(before.blocks[0]!.id)
  })

  it('writes each path once however many blocks read from it', () => {
    const project = toProject(MEDIA, edited())
    expect(project.media).toEqual(MEDIA)
    expect(project.blocks.every((block) => block.media === 0)).toBe(true)
  })
})

describe('reading a project that cannot be trusted', () => {
  it('refuses something that is not a project at all', () => {
    expect(() => parseProject('not json')).toThrow()
    expect(() => parseProject('[]')).toThrow()
    expect(() => parseProject('{"version":0}')).toThrow()
  })

  /** A file from a newer build may mean things this one does not know. */
  it('refuses a shape from the future', () => {
    expect(() => parseProject(`{"version":${PROJECT_VERSION + 1},"media":["a.mp4"]}`)).toThrow()
  })

  it('refuses a project that names no files', () => {
    expect(() => parseProject('{"version":1,"media":[],"blocks":[]}')).toThrow()
  })

  /**
   * A block naming a file the project did not list has nothing to read from,
   * and one with no length is a rounding error rather than a piece of video.
   * Either reaching the timeline is a crash somewhere with no way to explain
   * itself, so they are dropped at the boundary.
   */
  it('drops blocks it cannot honour and keeps the rest', () => {
    const timeline = projectTimeline(
      parseProject(
        JSON.stringify({
          version: 1,
          media: ['a.mp4'],
          mode: 'join',
          blocks: [
            { media: 0, sourceStart: 0, sourceEnd: 10, start: 0 },
            { media: 7, sourceStart: 0, sourceEnd: 10, start: 10 },
            { media: 0, sourceStart: 5, sourceEnd: 5, start: 20 },
            { media: 0, sourceStart: -1, sourceEnd: 10, start: 30 },
            { media: 0, sourceStart: 0, sourceEnd: Number.NaN, start: 40 },
            'nonsense',
            { media: 0, sourceStart: 20, sourceEnd: 30, start: 50 },
          ],
        }),
      ),
    )

    expect(layout(timeline)).toEqual([
      { media: 'a.mp4', start: 0, source: [0, 10] },
      { media: 'a.mp4', start: 50, source: [20, 30] },
    ])
  })

  it('falls back to joining when the mode is missing or unknown', () => {
    const text = '{"version":1,"media":["a.mp4"],"blocks":[]}'
    expect(parseProject(text).mode).toBe('join')
    expect(parseProject('{"version":1,"media":["a.mp4"],"mode":"sideways"}').mode).toBe('join')
  })
})

describe('what a project is called', () => {
  it('is its file name without the extension', () => {
    expect(projectName('C:/edits/holiday.snipjoin')).toBe('holiday')
    expect(projectName('C:\\edits\\holiday.SNIPJOIN')).toBe('holiday')
    expect(projectName('holiday.snipjoin')).toBe('holiday')
  })
})
