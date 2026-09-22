import { open } from '@tauri-apps/plugin-dialog'
import { useCallback } from 'react'

import { NewProject as NewProjectIcon, Project } from '@presentation/components/Icons'
import { CHROME_CONTROL, CHROME_ICON } from '@presentation/features/chrome/controls'
import { useT } from '@presentation/i18n/I18nProvider'
import { useEditor } from '@presentation/state/editorStore'

/**
 * Extensions offered in the file picker.
 *
 * Generous on purpose: anything FFmpeg can demux can be opened, and a preview
 * copy is built automatically for whatever the web view cannot decode. The
 * picker keeps an "all files" entry too, so an unusual container is never
 * unreachable merely because it is missing from this list.
 */
export const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'f4v',
  'mpg', 'mpeg', 'm2v', 'ts', 'mts', 'm2ts', 'vob', 'ogv', 'ogg',
  '3gp', '3g2', 'asf', 'rm', 'rmvb', 'divx', 'mxf', 'dv', 'gif',
]

/**
 * Still images, offered as a filter of their own.
 *
 * A separate entry rather than more names in the list above: a still behaves
 * differently once it is on the timeline — it has no length of its own, so the
 * editor gives it one — and a picker that says so is the first place a user
 * finds that out.
 */
export const IMAGE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'jfif', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic',
]

/**
 * Opens the native picker and brings whatever was chosen into the project.
 *
 * Added, not opened in place. The editor holds a pool of files now, so
 * reaching for another one and losing the edit you had is never what was meant
 * — `addMedia` still opens it outright when nothing is loaded yet, which is the
 * only case where there is nothing to lose.
 */
export function useOpenVideo() {
  const addMedia = useEditor((state) => state.addMedia)

  return useCallback(async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: 'Video', extensions: VIDEO_EXTENSIONS },
        { name: 'Image', extensions: IMAGE_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    })

    if (typeof selected === 'string') await addMedia(selected)
  }, [addMedia])
}

/**
 * Puts the current project down and starts from nothing.
 *
 * Offered only while something is open, because from the welcome screen it is
 * what you are already looking at. The unsaved question is the same one the
 * close button asks — leaving an edit is leaving an edit, however it is spelled
 * — and it is asked by the caller, which is the only place that knows what
 * happens next.
 */
export function NewProject({ onStart }: { readonly onStart: () => void }) {
  const t = useT()

  return (
    <button
      type="button"
      onClick={onStart}
      title={t('project.new')}
      aria-label={t('project.new')}
      className={CHROME_CONTROL}
    >
      <NewProjectIcon size={CHROME_ICON} />
      {t('project.new')}
    </button>
  )
}

/**
 * Opens a saved project.
 *
 * Beside the one that brings in a file, because they are the same decision from
 * the user's side — "start from this" — and the only difference is whether the
 * thing being started from is a video or an edit that already exists.
 *
 * The picker is opened by the caller, for the same reason the new-project
 * button hands its work upwards: opening a project replaces the edit in this
 * window, and the question about losing an unsaved one belongs where the
 * dialog does.
 */
export function OpenProject({ onOpen }: { readonly onOpen: () => void }) {
  const t = useT()

  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('project.open')}
      aria-label={t('project.open')}
      className={CHROME_CONTROL}
    >
      <Project size={CHROME_ICON} />
      {t('project.open')}
    </button>
  )
}
