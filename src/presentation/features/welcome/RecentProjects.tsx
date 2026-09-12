import { useCallback, useState } from 'react'

import { projectName } from '@domain/project'
import { Close, Project } from '@presentation/components/Icons'
import { cx } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { forgetRecentProject, readRecentProjects, useEditor } from '@presentation/state/editorStore'

/**
 * The way back into what you were working on.
 *
 * Only here, on the welcome screen: this is the one moment the application has
 * nothing else to say, and a list of edits is a better answer to "what now" than
 * a button that starts from nothing. It stays out of the editor entirely, where
 * the answer to that question is already on screen.
 *
 * A project that no longer opens can be dropped from the list in place. Nothing
 * checks the paths up front — that would mean a filesystem call per entry before
 * the first frame is drawn, to grey out something the user was probably not
 * about to click.
 */
export function RecentProjects() {
  const t = useT()
  const openProject = useEditor((state) => state.openProject)
  const [recents, setRecents] = useState(readRecentProjects)

  const forget = useCallback((path: string) => {
    forgetRecentProject(path)
    setRecents(readRecentProjects())
  }, [])

  if (recents.length === 0) return null

  return (
    <section className="mt-9 w-full max-w-[420px]">
      <h2 className="eyebrow mb-2 text-center">{t('project.recent')}</h2>

      <ul className="overflow-hidden rounded-xl border border-line bg-panel/70">
        {recents.map((entry, index) => (
          <li
            key={entry.path}
            className={cx('group flex items-center', index > 0 && 'border-t border-line/70')}
          >
            <button
              type="button"
              onClick={() => void openProject(entry.path)}
              title={entry.path}
              className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-raised/60"
            >
              <Project size={14} className="shrink-0 text-dusk-lift" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-paper">
                  {projectName(entry.path)}
                </span>
                <span className="block truncate text-[10.5px] text-faint">{entry.path}</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => forget(entry.path)}
              title={t('project.forget')}
              aria-label={t('project.forget')}
              className="mr-2 shrink-0 rounded-md p-1.5 text-faint opacity-0 transition-[opacity,color] duration-150 hover:text-paper focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Close size={13} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
