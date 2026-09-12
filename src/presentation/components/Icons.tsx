import type { SVGProps } from 'react'

/**
 * Hand-drawn icon set.
 *
 * Written out rather than pulled from a library so the scissors matches the one
 * in the logo, and so the whole set shares a single 1.6 stroke weight at 24
 * units. An icon pack would bring a different geometry and a dependency for
 * roughly two hundred lines of markup.
 */

type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number }

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** The brand action. Blades open to the lower right, as in the logo. */
export const Scissors = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="6" cy="6.5" r="2.5" />
    <circle cx="6" cy="17.5" r="2.5" />
    <path d="M8.2 8.1 20 19" />
    <path d="M8.2 15.9 20 5" />
  </Icon>
)

/** Two pieces meeting at a seam: the counterpart to the scissors. */
export const Join = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 8.5h6a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H3" />
    <path d="M21 8.5h-6a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h6" />
    <path d="M12 4v16" strokeDasharray="2 3" />
  </Icon>
)

/** A hole left where a piece was taken out. */
export const Hole = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 8.5h5v7H3" />
    <path d="M21 8.5h-5v7h5" />
    <path d="M10 6.5 14 17.5" strokeDasharray="2 2.5" />
  </Icon>
)

export const Play = (props: IconProps) => (
  <Icon {...props}>
    <path d="M7 4.8 19 12 7 19.2z" fill="currentColor" strokeWidth={1.2} />
  </Icon>
)

export const Pause = (props: IconProps) => (
  <Icon {...props}>
    <rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" strokeWidth={0} />
    <rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" strokeWidth={0} />
  </Icon>
)

export const StepBack = (props: IconProps) => (
  <Icon {...props}>
    <path d="M17 5.5 9 12l8 6.5z" fill="currentColor" strokeWidth={1.2} />
    <path d="M6 5v14" />
  </Icon>
)

export const StepForward = (props: IconProps) => (
  <Icon {...props}>
    <path d="M7 5.5 15 12l-8 6.5z" fill="currentColor" strokeWidth={1.2} />
    <path d="M18 5v14" />
  </Icon>
)

export const Split = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3v18" strokeDasharray="3 2.5" />
    <path d="M4 7h5v10H4z" />
    <path d="M20 7h-5v10h5z" />
  </Icon>
)

export const Undo = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 9h10a5 5 0 0 1 0 10h-4" />
    <path d="M7.5 5.5 4 9l3.5 3.5" />
  </Icon>
)

export const Redo = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 9H10a5 5 0 0 0 0 10h4" />
    <path d="M16.5 5.5 20 9l-3.5 3.5" />
  </Icon>
)

export const ZoomIn = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5 21 21M10.5 7.5v6M7.5 10.5h6" />
  </Icon>
)

export const ZoomOut = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5 21 21M7.5 10.5h6" />
  </Icon>
)

export const Fit = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
    <path d="M8.5 12h7" />
  </Icon>
)

export const Export = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 15V4" />
    <path d="M8.5 7.5 12 4l3.5 3.5" />
    <path d="M4.5 14v4a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4" />
  </Icon>
)

export const Folder = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 7.5a2 2 0 0 1 2-2h3.6l1.8 2.2H19a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Icon>
)

export const Trash = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 6.5h15" />
    <path d="M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7" />
    <path d="M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5" />
  </Icon>
)

export const Close = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
)

export const Check = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12.5 9.5 17 19 7" />
  </Icon>
)

/** Adding one more of something. */
export const Plus = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5.5v13" />
    <path d="M5.5 12h13" />
  </Icon>
)

/** Leaving the application. Only the credit line uses it. */
export const ArrowOut = (props: IconProps) => (
  <Icon {...props}>
    <path d="M7.5 16.5 16.5 7.5" />
    <path d="M9 7.5h7.5V15" />
  </Icon>
)

/** Sound on. The cone and two arcs, at the same stroke weight as the rest. */
export const Speaker = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" />
    <path d="M16 9.2a4 4 0 0 1 0 5.6" />
    <path d="M18.6 6.6a7.6 7.6 0 0 1 0 10.8" />
  </Icon>
)

/** Sound off. The same cone, so the two read as one control changing state. */
export const SpeakerOff = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" />
    <path d="M16.5 10 21 14.5" />
    <path d="M21 10l-4.5 4.5" />
  </Icon>
)

export const Alert = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4.5 21 19.5H3z" />
    <path d="M12 10v4M12 17h.01" />
  </Icon>
)

export const Sparkle = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3.5 13.9 9 19.5 11 13.9 13 12 18.5 10.1 13 4.5 11 10.1 9z" />
    <path d="M18.5 4v3M20 5.5h-3" />
  </Icon>
)

export const Globe = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.6 9.5h16.8M3.6 14.5h16.8" />
    <path d="M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.3-3.3-8.5s1.1-6.1 3.3-8.5z" />
  </Icon>
)

/** A magnet: cuts being pulled onto the positions a copy can use. */
export const Magnet = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 4v7a7 7 0 0 0 14 0V4" />
    <path d="M5 10h5M14 10h5" />
    <path d="M5 4h5v6H5zM14 4h5v6h-5z" />
  </Icon>
)

export const Minimize = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14" />
  </Icon>
)

export const Maximize = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />
  </Icon>
)

export const Keyboard = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.5" y="6.5" width="19" height="11" rx="2" />
    <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M6.5 13.5h.01M17 13.5h.01M9.5 13.5h5" />
  </Icon>
)

/** Two sheets, one behind the other: the block menu's copy. */
export const Copy = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
  </Icon>
)

/** A sheet coming off a clipboard: the block menu's paste. */
export const Paste = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 4.5H7a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-2" />
    <rect x="9" y="2.8" width="6" height="3.4" rx="1.2" />
    <path d="M8.5 12.5h7" />
    <path d="M8.5 16h4.5" />
  </Icon>
)

/** One more of the same piece, placed beside it. */
export const Duplicate = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="7" width="8" height="10" rx="1.6" />
    <rect x="13" y="7" width="8" height="10" rx="1.6" />
    <path d="M17 10.5v3" />
    <path d="M15.5 12h3" />
  </Icon>
)

/** A block trading places with the one before it. */
export const MoveLeft = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10 7.5 5.5 12 10 16.5" />
    <path d="M5.5 12H14" />
    <path d="M18.5 5.5v13" />
  </Icon>
)

/** A block trading places with the one after it. */
export const MoveRight = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 7.5 18.5 12 14 16.5" />
    <path d="M18.5 12H10" />
    <path d="M5.5 5.5v13" />
  </Icon>
)

/** A single frame: the mark for a still in the media pool. */
export const Image = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4.5 16.5 9.5 12l4 3.5 3-2.5 3.5 3" />
  </Icon>
)

/** A view that follows a drag to the side of the window. */
export const EdgeScroll = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 5.5v13" />
    <path d="M19.5 5.5v13" />
    <path d="M9 9.5 6.5 12 9 14.5" />
    <path d="M15 9.5 17.5 12 15 14.5" />
    <path d="M11 12h2" />
  </Icon>
)
