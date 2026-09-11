import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useCallback, useEffect, useState } from 'react'

import { Export as ExportIcon } from '@presentation/components/Icons'
import { Button } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { ExportDialog } from '@presentation/features/export/ExportDialog'
import { ShortcutsDialog } from '@presentation/features/chrome/ShortcutsDialog'
import { TitleBar } from '@presentation/features/chrome/TitleBar'
import { BlockList } from '@presentation/features/inspector/BlockList'
import { SelectionPanel } from '@presentation/features/inspector/SelectionPanel'
import { Preview } from '@presentation/features/stage/Preview'
import { Transport } from '@presentation/features/stage/Transport'
import { DockResizer } from '@presentation/features/timeline/DockResizer'
import { TimelineDock } from '@presentation/features/timeline/TimelineDock'
import { Welcome } from '@presentation/features/welcome/Welcome'
import { useShortcuts } from '@presentation/hooks/useShortcuts'
import { api } from '@infrastructure/tauri/api'
import { connectBackendEvents, useEditor } from '@presentation/state/editorStore'

import { ErrorToast } from './ErrorToast'

export function App() {
  const t = useT()
  const phase = useEditor((state) => state.phase)
  const openFile = useEditor((state) => state.openFile)

  const [dropActive, setDropActive] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const showExport = useCallback(() => setExportOpen(true), [])
  const showShortcuts = useCallback(() => setShortcutsOpen((open) => !open), [])
  useShortcuts({ onExport: showExport, onShowShortcuts: showShortcuts })

  // One subscription for the whole application, torn down on unmount so a hot
  // reload cannot stack duplicate listeners.
  useEffect(() => connectBackendEvents(), [])

  // The editor window is created hidden. Reporting in after the first paint is
  // what makes it appear — two frames of margin, because a layout effect runs
  // before the browser has put anything on screen and the window would show
  // blank. The backend decides how much longer the splash is owed.
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void api.finishStartup().catch(() => {
          // The deadline in the backend shows the window regardless.
        })
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  // Shrinking the window can leave the dock taller than the stage can spare, so
  // the stored height is re-clamped against the new size.
  useEffect(() => {
    const settle = () => {
      const { timelineHeight, setTimelineHeight } = useEditor.getState()
      setTimelineHeight(timelineHeight)
    }
    window.addEventListener('resize', settle)
    return () => window.removeEventListener('resize', settle)
  }, [])

  // A file the application was launched with, from "Open with" or a shortcut.
  useEffect(() => {
    void api
      .initialFile()
      .then((path) => {
        if (path) void openFile(path)
      })
      .catch(() => undefined)
  }, [openFile])

  // Files dropped anywhere on the window open, which is the fastest path in and
  // the one people try first.
  useEffect(() => {
    let detach: (() => void) | null = null
    let cancelled = false

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'over') {
          setDropActive(true)
          return
        }

        setDropActive(false)

        if (event.payload.type === 'drop') {
          // Only the first file is taken: this editor works on one video, and
          // silently ignoring the rest is clearer than opening an arbitrary one.
          const [first] = event.payload.paths
          if (first) void openFile(first)
        }
      })
      .then((unlisten) => {
        if (cancelled) unlisten()
        else detach = unlisten
      })

    return () => {
      cancelled = true
      detach?.()
    }
  }, [openFile])

  const editing = phase !== 'empty'

  return (
    <div className="app-ground flex h-full flex-col">
      <TitleBar onShowShortcuts={showShortcuts} />

      {editing ? (
        <main className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <section className="flex min-w-0 flex-1 flex-col">
              <Preview />
              <Transport />
            </section>

            <aside className="flex w-[312px] shrink-0 flex-col border-l border-line bg-ink/40">
              {/* Scrolls as one column. A short stage must cost the user scroll
                  distance, never a control they can no longer reach. */}
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
                <SelectionPanel />
                <BlockList />
              </div>

              {/* Pinned: the export button is where the whole panel leads. */}
              <div className="shrink-0 border-t border-line p-3">
                <Button
                  tone="paper"
                  size="lg"
                  full
                  onClick={showExport}
                  icon={<ExportIcon size={16} />}
                >
                  {t('export.open')}
                </Button>
              </div>
            </aside>
          </div>

          <DockResizer />
          <TimelineDock />
        </main>
      ) : (
        <Welcome dropActive={dropActive} />
      )}

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ErrorToast />
    </div>
  )
}
