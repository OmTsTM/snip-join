import { open, save } from '@tauri-apps/plugin-dialog'
import { useCallback } from 'react'

import { PROJECT_EXTENSION, projectName } from '@domain/project'
import { useEditor } from '@presentation/state/editorStore'

/** How long a saved project may go unwritten while it is being edited. */
const AUTOSAVE_INTERVAL_MS = 30_000

export { AUTOSAVE_INTERVAL_MS }

/**
 * Saving and opening a project, with the pickers attached.
 *
 * The store owns what a project *is* and how it reaches the disk; this owns the
 * questions — where to put it the first time, which one to open — because a
 * native dialog is an interface concern and nothing in the store should ever
 * block on one.
 */
export function useProjectActions() {
  const saveProject = useEditor((state) => state.saveProject)
  const openProject = useEditor((state) => state.openProject)
  const projectPath = useEditor((state) => state.projectPath)
  const sourceName = useEditor((state) => state.source?.fileName ?? 'project')

  /**
   * Writes the project, asking where only when it has never been saved.
   *
   * Answers whether anything was written. The close prompt turns on that: a
   * dismissed picker is not a save, and closing on it would throw away the work
   * the question was asked about.
   */
  const saveNow = useCallback(
    async (askAnyway = false): Promise<boolean> => {
      if (projectPath && !askAnyway) return saveProject()

      const suggested = projectPath
        ? projectPath
        : `${sourceName.replace(/\.[^.]+$/, '')}.${PROJECT_EXTENSION}`

      const chosen = await save({
        defaultPath: suggested,
        filters: [{ name: 'Snip Join project', extensions: [PROJECT_EXTENSION] }],
      })

      if (typeof chosen !== 'string') return false
      return saveProject(chosen)
    },
    [projectPath, saveProject, sourceName],
  )

  const openExisting = useCallback(async () => {
    const chosen = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Snip Join project', extensions: [PROJECT_EXTENSION] }],
    })

    if (typeof chosen === 'string') await openProject(chosen)
  }, [openProject])

  return { saveNow, openExisting, projectPath, name: projectPath ? projectName(projectPath) : null }
}
