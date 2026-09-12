import { create } from 'zustand'

/**
 * The skins the interface can wear.
 *
 * Named for what they are made of rather than for how bright they are: the
 * palette these fill comes from the logo, and `dusk` is the window at dusk that
 * the mark itself sits in. The order is the order they are offered in, darkest
 * first, which is also the order they were built in.
 */
export const SKINS = ['dusk', 'slate', 'paper'] as const
export type Skin = (typeof SKINS)[number]

const SKIN_KEY = 'snipjoin.skin'

/** The one the editor was designed around, and what an unset choice means. */
const DEFAULT_SKIN: Skin = 'dusk'

function readStoredSkin(): Skin {
  try {
    const stored = window.localStorage.getItem(SKIN_KEY)
    return SKINS.includes(stored as Skin) ? (stored as Skin) : DEFAULT_SKIN
  } catch {
    return DEFAULT_SKIN
  }
}

interface SkinState {
  skin: Skin
  setSkin: (skin: Skin) => void
}

/**
 * Which skin is worn, and the attribute that puts it on.
 *
 * Its own store rather than a corner of the editor's: it outlives every file,
 * belongs to the installation rather than to the edit, and has no business in
 * the undo history. The whole of applying it is one attribute on the root
 * element — every colour in the interface is a variable the skins redefine, so
 * nothing else has to know a skin exists.
 */
export const useSkin = create<SkinState>((set) => ({
  skin: readStoredSkin(),
  setSkin: (skin) => {
    set({ skin })
    applySkin(skin)
    try {
      window.localStorage.setItem(SKIN_KEY, skin)
    } catch {
      // The choice still applies for this session.
    }
  },
}))

/**
 * Puts a skin on the document.
 *
 * The default one writes no attribute at all, so the palette in `@theme` is what
 * a fresh install renders with and nothing has to be overridden to get there.
 */
export function applySkin(skin: Skin): void {
  const root = document.documentElement
  if (skin === DEFAULT_SKIN) root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', skin)
}

/** Applied before the first paint, so a chosen skin never flashes the default. */
applySkin(readStoredSkin())
