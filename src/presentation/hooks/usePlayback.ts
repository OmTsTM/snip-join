import { useEffect, type RefObject } from 'react'

import { sourceAt, totalDuration } from '@domain/timeline'
import { selectTimeline, useEditor } from '@presentation/state/editorStore'

/**
 * How far the video element may drift from the timeline clock before it is
 * corrected, in seconds.
 *
 * Both advance at the same rate, so during normal playback the difference stays
 * far below this. The threshold exists to distinguish real drift from the
 * ordinary lag between a frame being decoded and the clock being read; seeking
 * on every small difference would stutter the picture continuously.
 */
const DRIFT_TOLERANCE = 0.34

/** A paused seek should be exact, since the user is looking for a frame. */
const SEEK_TOLERANCE = 0.02

/**
 * Drives a video element from the edited timeline.
 *
 * The timeline clock is the source of truth, not the video element. That
 * inversion is what makes holes work at all: inside a hole there is nothing to
 * play, so the element is paused while the clock keeps running, and the picture
 * goes black for exactly as long as the hole lasts.
 */
export function usePlayback(video: RefObject<HTMLVideoElement | null>) {
  const playing = useEditor((state) => state.playing)
  const playhead = useEditor((state) => state.playhead)
  const timeline = useEditor(selectTimeline)
  const rate = 1

  // The clock. Reads the latest state directly rather than through the closure,
  // so an edit made mid-playback takes effect on the very next frame.
  useEffect(() => {
    if (!playing) return

    let frame = 0
    let previous = performance.now()

    const step = (now: number) => {
      const elapsed = Math.min((now - previous) / 1000, 0.25) * rate
      previous = now

      const state = useEditor.getState()
      const total = totalDuration(state.history.present)
      const next = state.playhead + elapsed

      if (next >= total) {
        useEditor.setState({ playhead: total, playing: false })
        return
      }

      useEditor.setState({ playhead: next })
      frame = requestAnimationFrame(step)
    }

    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [playing, rate])

  // Follows the clock with the element: seek where a block says to, and stay
  // paused and silent wherever the timeline holds nothing.
  useEffect(() => {
    const element = video.current
    if (!element) return

    const target = sourceAt(timeline, playhead)

    if (target === null) {
      if (!element.paused) element.pause()
      return
    }

    const tolerance = playing ? DRIFT_TOLERANCE : SEEK_TOLERANCE
    if (Math.abs(element.currentTime - target) > tolerance) {
      element.currentTime = target
    }

    if (playing && element.paused) {
      // Rejection is expected while the element is still loading; the next frame
      // tries again, so there is nothing to recover here.
      void element.play().catch(() => undefined)
    } else if (!playing && !element.paused) {
      element.pause()
    }
  }, [video, timeline, playhead, playing])

  // Leaving the editor, or losing the source, must not leave audio playing.
  useEffect(() => {
    const element = video.current
    return () => {
      element?.pause()
    }
  }, [video])
}
