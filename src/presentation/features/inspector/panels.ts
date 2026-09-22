import { create } from 'zustand'

/**
 * The panels of the inspector column, in the order they are stacked.
 */
export const PANELS = ['selection', 'media', 'blocks'] as const
export type PanelId = (typeof PANELS)[number]

const PANELS_KEY = 'snipjoin.panels'

interface StoredPanels {
  readonly hidden: readonly PanelId[]
  readonly collapsed: readonly PanelId[]
  /** Whether the column is out at all. Closed, the stage has the window. */
  readonly open: boolean
}

function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && (PANELS as readonly string[]).includes(value)
}

/** Out, and nothing folded: what a fresh install looks like. */
const FRESH: StoredPanels = { hidden: [], collapsed: [], open: true }

function readStored(): StoredPanels {
  try {
    const raw = window.localStorage.getItem(PANELS_KEY)
    if (!raw) return FRESH
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return FRESH
    const record = parsed as Record<string, unknown>
    const list = (value: unknown): PanelId[] =>
      Array.isArray(value) ? value.filter(isPanelId) : []
    return {
      hidden: list(record.hidden),
      collapsed: list(record.collapsed),
      // Absent in what an earlier version wrote, and the column was always
      // out then, so that is what the absence means.
      open: record.open !== false,
    }
  } catch {
    return FRESH
  }
}

function store(state: StoredPanels): void {
  const { hidden, collapsed, open } = state
  try {
    window.localStorage.setItem(PANELS_KEY, JSON.stringify({ hidden, collapsed, open }))
  } catch {
    // The arrangement still holds for this session.
  }
}

interface PanelsState extends StoredPanels {
  /** Folds a panel to its title, or opens it again. */
  setCollapsed: (id: PanelId, collapsed: boolean) => void
  /** Takes a panel out of the column, or puts it back. */
  setHidden: (id: PanelId, hidden: boolean) => void
  /** Slides the whole column out of the way, or back. */
  setOpen: (open: boolean) => void
}

/**
 * Which panels are on show, and which are folded.
 *
 * Its own store, like the skin: this is about the window rather than the
 * edit, it outlives every file, and it has no place in the undo history. Two
 * lists rather than one state per panel, so a panel that is put away and then
 * brought back comes back the way it was left — folded or open.
 */
export const usePanels = create<PanelsState>((set, get) => ({
  ...readStored(),

  setCollapsed(id, collapsed) {
    const current = get().collapsed
    const next = collapsed
      ? current.includes(id)
        ? current
        : [...current, id]
      : current.filter((entry) => entry !== id)
    if (next === current) return
    set({ collapsed: next })
    store({ ...get(), collapsed: next })
  },

  setHidden(id, hidden) {
    const current = get().hidden
    const next = hidden
      ? current.includes(id)
        ? current
        : [...current, id]
      : current.filter((entry) => entry !== id)
    if (next === current) return
    set({ hidden: next })
    store({ ...get(), hidden: next })
  },

  setOpen(open) {
    if (get().open === open) return
    set({ open })
    store({ ...get(), open })
  },
}))
