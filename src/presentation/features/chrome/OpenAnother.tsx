import { open } from '@tauri-apps/plugin-dialog'
import { useCallback } from 'react'

import { Folder } from '@presentation/components/Icons'
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

/** Opens the native picker and loads whatever was chosen. */
export function useOpenVideo() {
  const openFile = useEditor((state) => state.openFile)

  return useCallback(async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: 'Video', extensions: VIDEO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    })

    if (typeof selected === 'string') await openFile(selected)
  }, [openFile])
}

/**
 * Swaps the open video for another one.
 *
 * Lives in the title bar because the editor has no menu bar, and without it the
 * only way to work on a second clip would be to restart the application.
 */
export function OpenAnother() {
  const t = useT()
  const choose = useOpenVideo()

  return (
    <button
      type="button"
      onClick={() => void choose()}
      title={t('source.open')}
      aria-label={t('source.open')}
      className="no-drag inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-faint transition-colors duration-150 hover:bg-raised hover:text-paper"
    >
      <Folder size={13} />
      {t('source.open')}
    </button>
  )
}
