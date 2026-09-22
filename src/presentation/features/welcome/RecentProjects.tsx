import { open } from '@tauri-apps/plugin-dialog'
import { useCallback, useState } from 'react'

import { PROJECT_EXTENSION, projectName } from '@domain/project'
import { Broken, Close, Locate, Project } from '@presentation/components/Icons'
import { cx, IconButton } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { forgetRecentProject, readRecentProjects, useEditor } from '@presentation/state/editorStore'
import { api } from '@infrastructure/tauri/api'

/**
 * The way back into what you were working on.
 *
 * Only here, on the welcome screen: this is the one moment the application has
 * nothing else to say, and a list of edits is a better answer to "what now" than
 * a button that starts from nothing. It stays out of the editor entirely, where
 * the answer to that question is already on screen.
 *
 * Nothing checks the paths up front — that would mean a filesystem call per
 * entry before the first frame is drawn, to grey out something the user was
 * probably not about to click. A project file that has moved is found out when
 * it is asked for, and the row then says so and offers the two ways out: point
 * at where it went, or take it off the list. That is the same pair the media
 * pool offers for a file the project names, and for the same reason: an error
 * about a path nobody can act on is not an answer.
 */
export function RecentProjects() {
  const t = useT()
  const openProject = useEditor((state) => state.openProject)
  const [recents, setRecents] = useState(readRecentProjects)
  const [missing, setMissing] = useState<readonly string[]>([])

  const forget = useCallback((path: string) => {
    forgetRecentProject(path)
    setRecents(readRecentProjects())
    setMissing((current) => current.filter((entry) => entry !== path))
  }, [])

  const pick = useCallback(
    async (path: string) => {
      const there = await api.fileExists(path).catch(() => true)
      if (there) {
        await openProject(path)
        return
      }
      setMissing((current) => (current.includes(path) ? current : [...current, path]))
    },
    [openProject],
  )

  /** Asks where the project went, and opens it from there. */
  const locate = useCallback(
    async (path: string) => {
      const chosen = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Snip Join project', extensions: [PROJECT_EXTENSION] }],
      })
      if (typeof chosen !== 'string') return

      // The old entry goes; opening the new one remembers it in its place.
      forgetRecentProject(path)
      await openProject(chosen)
    },
    [openProject],
  )

  if (recents.length === 0) return null

  return (
    <section className="mt-9 w-full max-w-[420px]">
      <h2 className="eyebrow mb-2 text-center">{t('project.recent')}</h2>

      <ul className="overflow-hidden rounded-xl border border-line bg-panel/70">
        {recents.map((entry, index) => {
          const gone = missing.includes(entry.path)

          return (
            <li
              key={entry.path}
              className={cx('group flex items-center', index > 0 && 'border-t border-line/70')}
            >
              <button
                type="button"
                onClick={() => void pick(entry.path)}
                title={gone ? t('project.missing') : entry.path}
                className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-raised/60"
              >
                {gone ? (
                  <Broken size={14} className="shrink-0 text-snip-ink" />
                ) : (
                  <Project size={14} className="shrink-0 text-dusk-lift" />
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className={cx(
                      'block truncate text-[12.5px]',
                      gone ? 'text-muted line-through decoration-snip/50' : 'text-paper',
                    )}
                  >
                    {projectName(entry.path)}
                  </span>
                  <span
                    className={cx(
                      'block truncate text-[10.5px]',
                      gone ? 'text-snip-ink' : 'text-faint',
                    )}
                  >
                    {gone ? t('project.missing') : entry.path}
                  </span>
                </span>
              </button>

              <span className="mr-2 flex shrink-0 items-center">
                {gone && (
                  <IconButton label={t('project.locate')} onClick={() => void locate(entry.path)}>
                    <Locate size={14} />
                  </IconButton>
                )}
                <button
                  type="button"
                  onClick={() => forget(entry.path)}
                  title={t('project.forget')}
                  aria-label={t('project.forget')}
                  className={cx(
                    'shrink-0 rounded-md p-1.5 text-faint transition-[opacity,color] duration-150 hover:text-paper focus-visible:opacity-100 group-hover:opacity-100',
                    gone ? 'opacity-100' : 'opacity-0',
                  )}
                >
                  <Close size={13} />
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
