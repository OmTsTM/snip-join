/**
 * The shape every control in the title bar is cut to.
 *
 * One class rather than a copy per button, because the strip is read as a row
 * before it is read as five separate things: mixed paddings and two icon sizes
 * are what made it look shuffled — an icon-only button 28 pixels wide sets its
 * glyph 7 pixels in, a labelled one sets it 8, and the 12 pixel gap between them
 * then measured differently everywhere. Same height, same padding, same icon
 * size, and the whitespace between any two of them is the same by construction.
 *
 * `muted`, not `faint`. These are the only controls on screen with no panel
 * behind them, sitting on the darkest band the interface has, and `faint` left
 * them at about three to one against it — legible if you already knew they were
 * there. It is a role rather than a colour, so every skin lifts them by its own
 * lights rather than by this one's.
 */
export const CHROME_TEXT = 'text-muted transition-colors duration-150 hover:bg-raised hover:text-paper'

export const CHROME_CONTROL =
  `no-drag inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] ${CHROME_TEXT}`

/** Every glyph in the strip is drawn at this size, for the same reason. */
export const CHROME_ICON = 14
