import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'

import { Check, Chevron, Close, Panels } from '@presentation/components/Icons'
import { cx } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import type { MessageKey } from '@infrastructure/i18n'

import { PANELS, usePanels, type PanelId } from './panels'

/**
 * One panel of the inspector column.
 *
 * Each panel stands on its own: it folds to its title with the chevron and
 * leaves the column with the cross, and both are remembered. A panel that has
 * left comes back from the menu beside the export button, so putting one away
 * is never a decision that has to be regretted.
 *
 * The heading is the fold control too, because a title bar is what people
 * press to fold a panel, and the chevron alone is a small target.
 */
export function InspectorPanel({
  id,
  title,
  aside,
  children,
}: {
  readonly id: PanelId
  readonly title: string
  /** Controls that belong to the panel, drawn in its heading. */
  readonly aside?: ReactNode
  readonly children: ReactNode
}) {
  const t = useT()
  const hidden = usePanels((state) => state.hidden.includes(id))
  const collapsed = usePanels((state) => state.collapsed.includes(id))
  const setCollapsed = usePanels((state) => state.setCollapsed)
  const setHidden = usePanels((state) => state.setHidden)

  if (hidden) return null

  return (
    <section className="panel flex shrink-0 flex-col">
      <header className="flex shrink-0 items-center gap-1 py-2 pl-2 pr-2">
        <button
          type="button"
          onClick={() => setCollapsed(id, !collapsed)}
          title={collapsed ? t('panels.expand') : t('panels.collapse')}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-1 pr-2 text-left transition-colors duration-150 hover:bg-raised/60"
        >
          <Chevron
            size={14}
            className={cx(
              'shrink-0 text-faint transition-transform duration-200',
              collapsed && '-rotate-90',
            )}
          />
          <h2 className="eyebrow truncate">{title}</h2>
        </button>

        {!collapsed && aside}

        <button
          type="button"
          onClick={() => setHidden(id, true)}
          title={t('panels.hide')}
          aria-label={t('panels.hide')}
          className="shrink-0 rounded-md p-1.5 text-faint transition-colors duration-150 hover:bg-raised hover:text-paper"
        >
          <Close size={12} />
        </button>
      </header>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

/**
 * The way back for a panel that was put away.
 *
 * Built like the skin and language pickers in the title bar: opens on hover
 * and on keyboard focus, one row per panel, a tick beside the ones on show.
 */
export function PanelsMenu() {
  const t = useT()
  const hidden = usePanels((state) => state.hidden)
  const setHidden = usePanels((state) => state.setHidden)

  return (
    <div className="group relative shrink-0">
      <button
        type="button"
        title={t('panels.label')}
        aria-label={t('panels.label')}
        className={cx(
          'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line-bright bg-control text-muted',
          'transition-colors duration-150 hover:bg-raised-hi hover:text-paper',
        )}
      >
        <Panels size={15} />
      </button>

      <div className="invisible absolute right-0 top-full z-40 w-44 translate-y-1 rounded-lg border border-line bg-panel p-1 opacity-0 shadow-2xl transition-[opacity,visibility] duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        {PANELS.map((id) => {
          const shown = !hidden.includes(id)
          return (
            <button
              key={id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={shown}
              onClick={() => setHidden(id, shown)}
              className={cx(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors duration-150',
                shown ? 'text-paper hover:bg-raised' : 'text-muted hover:bg-raised hover:text-paper',
              )}
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {shown && <Check size={12} strokeWidth={2.6} />}
              </span>
              {t(`${id}.title` as MessageKey)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
