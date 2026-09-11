import { memo, useMemo } from 'react'

import { formatTimecode } from '@domain/time'

import { RULER_HEIGHT } from './dockSize'
import { timeToPixels, visibleTicks } from './geometry'

export { RULER_HEIGHT }

interface RulerProps {
  readonly pixelsPerSecond: number
  readonly scrollLeft: number
  readonly viewportWidth: number
  readonly duration: number
}

export const Ruler = memo(function Ruler({
  pixelsPerSecond,
  scrollLeft,
  viewportWidth,
  duration,
}: RulerProps) {
  const ticks = useMemo(
    () => visibleTicks(pixelsPerSecond, scrollLeft, viewportWidth, duration),
    [pixelsPerSecond, scrollLeft, viewportWidth, duration],
  )

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 border-b border-line"
      style={{ height: RULER_HEIGHT }}
    >
      {ticks.map((tick) => (
        <div
          key={tick.at}
          className="absolute bottom-0"
          style={{ left: timeToPixels(tick.at, pixelsPerSecond) }}
        >
          <span
            className="absolute bottom-0 w-px bg-line-bright"
            style={{ height: tick.major ? 9 : 4 }}
          />
          {tick.major && (
            <span className="timecode absolute bottom-[11px] left-[3px] whitespace-nowrap text-[9.5px] leading-none text-faint">
              {formatTimecode(tick.at, { frames: false })}
            </span>
          )}
        </div>
      ))}
    </div>
  )
})
