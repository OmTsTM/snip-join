import { motion, useReducedMotion } from 'motion/react'

/** Frame pitch, in pixels. Everything else is derived from it. */
const PITCH = 30
const TOTAL_FRAMES = 13
const CUT_FROM = 5
const CUT_TO = 9
const CUT_WIDTH = (CUT_TO - CUT_FROM) * PITCH

/** One full cycle: mark, lift, close, hold, reset. */
const CYCLE = 5.2

/**
 * Shared keyframe times for every moving part.
 *
 * One timeline rather than six independent ones, because the parts have to agree
 * about what moment it is. In particular the reset at `0.92` happens while the
 * lifted piece is still transparent: restoring its position and the tail's at
 * different moments is what made the loop flash a raised piece over an already
 * closed strip.
 *
 *   0.00  whole                0.55  ends meet
 *   0.22  stretch marked       0.85  hold on the joined strip
 *   0.38  stretch lifted out   0.92  everything resets, unseen
 */
const BEAT = [0, 0.22, 0.38, 0.55, 0.85, 0.92, 1]

/**
 * Picture content, in desaturated film stock tones rather than saturated colour.
 *
 * Light enough to read as images against the dark frame border, spread across
 * enough hues to say "different frames", and low enough in chroma not to compete
 * with the headline underneath.
 */
const STOCK = ['#4A5560', '#5C5347', '#3F5566', '#6A5744', '#44605E', '#565065', '#4F5A4A']

/**
 * The product, shown rather than described.
 *
 * A strip of film, a marked stretch, the stretch lifting away, the ends closing
 * up. That loop is the whole application, and it answers the only question a
 * first-time viewer has before any copy does. It is the one loud element on this
 * screen; everything around it stays quiet.
 *
 * With reduced motion the finished state is drawn instead, so the idea still
 * lands without anything moving.
 */
export function SnipDemo() {
  const reduced = useReducedMotion()
  const frames = Array.from({ length: TOTAL_FRAMES }, (_, index) => index)

  if (reduced) {
    const joined = [...frames.slice(0, CUT_FROM), ...frames.slice(CUT_TO)]
    return (
      <div className="relative flex h-[104px] items-center justify-center" aria-hidden="true">
        <div className="relative flex">
          <Strip frames={joined} />
          <span
            className="absolute inset-y-0 w-px bg-dusk-lift/80"
            style={{ left: CUT_FROM * PITCH }}
          />
        </div>
      </div>
    )
  }

  const timing = { duration: CYCLE, times: BEAT, repeat: Number.POSITIVE_INFINITY }
  const glide = { ...timing, ease: [0.22, 1, 0.36, 1] as const }

  return (
    <div className="relative flex h-[104px] items-center justify-center" aria-hidden="true">
      {/* The whole assembly drifts right as the tail comes left, so the strip
          stays visually centred instead of sliding off to one side. */}
      <motion.div
        className="relative flex"
        style={{ width: TOTAL_FRAMES * PITCH }}
        animate={{ x: [0, 0, 0, CUT_WIDTH / 2, CUT_WIDTH / 2, 0, 0] }}
        transition={glide}
      >
        <Strip frames={frames.slice(0, CUT_FROM)} />

        {/* The marked stretch lifts out and fades. It drops back into place at
            0.92, while still invisible, so the reset is never seen. */}
        <motion.div
          className="flex"
          animate={{
            y: [0, 0, -42, -42, -42, 0, 0],
            opacity: [1, 1, 0, 0, 0, 0, 1],
          }}
          transition={{ ...timing, ease: 'easeInOut' }}
        >
          <Strip frames={frames.slice(CUT_FROM, CUT_TO)} marked />
        </motion.div>

        {/* The tail slides left to meet the head, holds, then returns unseen. */}
        <motion.div
          className="flex"
          animate={{ x: [0, 0, 0, -CUT_WIDTH, -CUT_WIDTH, 0, 0] }}
          transition={glide}
        >
          <Strip frames={frames.slice(CUT_TO)} />
        </motion.div>

        {/* The marking bracket: orange, because orange is cutting. */}
        <motion.div
          className="pointer-events-none absolute -inset-y-[9px] border-x-2 border-snip"
          style={{ left: CUT_FROM * PITCH, width: CUT_WIDTH }}
          animate={{ opacity: [0, 1, 1, 0, 0, 0, 0] }}
          transition={{ ...timing, ease: 'easeInOut' }}
        >
          <span className="absolute -top-[5px] left-1/2 h-[7px] w-[7px] -translate-x-1/2 rotate-45 bg-snip" />
          <span className="absolute -bottom-[5px] left-1/2 h-[7px] w-[7px] -translate-x-1/2 rotate-45 bg-snip" />
        </motion.div>

        {/* The seam, lit in dusk at the moment the ends meet. */}
        <motion.div
          className="pointer-events-none absolute -inset-y-[4px] w-[2px] bg-dusk-lift"
          style={{ left: CUT_FROM * PITCH - 1 }}
          animate={{
            opacity: [0, 0, 0, 1, 0.3, 0, 0],
            scaleY: [0.5, 0.5, 0.5, 1, 1, 0.5, 0.5],
          }}
          transition={{ ...timing, ease: 'easeOut' }}
        />
      </motion.div>
    </div>
  )
}

function Strip({ frames, marked }: { readonly frames: number[]; readonly marked?: boolean | undefined }) {
  return (
    <div className="flex">
      {frames.map((index) => (
        <Frame key={index} index={index} marked={marked} />
      ))}
    </div>
  )
}

/**
 * One frame of film: a perforation, a picture area, a perforation.
 *
 * Drawing the real anatomy rather than a plain rectangle is what makes the row
 * read as film at a glance instead of as a progress bar with segments.
 */
function Frame({ index, marked }: { readonly index: number; readonly marked?: boolean | undefined }) {
  const picture = STOCK[index % STOCK.length]

  return (
    <div
      className="relative h-[68px] shrink-0 border-r border-black/60 bg-[#0E1114]"
      style={{ width: PITCH }}
    >
      <span className="absolute left-1/2 top-[4px] h-[5px] w-[11px] -translate-x-1/2 rounded-[1.5px] bg-[#20262B]" />
      <span className="absolute bottom-[4px] left-1/2 h-[5px] w-[11px] -translate-x-1/2 rounded-[1.5px] bg-[#20262B]" />

      <span
        className="absolute inset-x-[3px] top-[13px] bottom-[13px] rounded-[1px]"
        style={{
          background: marked ? 'color-mix(in oklab, #f9811e 42%, #4A5560)' : picture,
        }}
      />
    </div>
  )
}
