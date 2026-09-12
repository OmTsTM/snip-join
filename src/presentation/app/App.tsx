import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useCallback, useEffect, useState } from 'react'

import { Export as ExportIcon } from '@presentation/components/Icons'
import { Button } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { ExportDialog } from '@presentation/features/export/ExportDialog'
import { ShortcutsDialog } from '@presentation/features/chrome/ShortcutsDialog'
import { TitleBar } from '@presentation/features/chrome/TitleBar'
import { BlockList } from '@presentation/features/inspector/BlockList'
import { MediaPool } from '@presentation/features/inspector/MediaPool'
import { SelectionPanel } from '@presentation/features/inspector/SelectionPanel'
import { Preview } from '@presentation/features/stage/Preview'
import { Transport } from '@presentation/features/stage/Transport'
import { DockResizer } from '@presentation/features/timeline/DockResizer'
import { TimelineDock } from '@presentation/features/timeline/TimelineDock'
import { Welcome } from '@presentation/features/welcome/Welcome'
import { useShortcuts } from '@presentation/hooks/useShortcuts'
import { api } from '@infrastructure/tauri/api'
import { connectBackendEvents, selectCanExport, useEditor } from '@presentation/state/editorStore'

import { ErrorToast } from './ErrorToast'

export function App() {
  const t = useT()
  const phase = useEditor((state) => state.phase)
  const openFile = useEditor((state) => state.openFile)
  const addMedia = useEditor((state) => state.addMedia)
  const canExport = useEditor(selectCanExport)

  const [dropActive, setDropActive] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // Guarded here rather than only on the button, so the keyboard cannot reach
  // the dialog for a timeline that would produce no file.
  const showExport = useCallback(() => {
    if (useEditor.getState().history.present.blocks.length > 0) setExportOpen(true)
  }, [])
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
          // Only the first file is taken: opening an arbitrary one of several is
          // worse than taking the one the pointer was over.
          //
          // Added to the project rather than opened in its place, matching the
          // title bar: dropping a second file onto an edit means "and this one
          // too", never "throw that away". `addMedia` opens it outright when
          // nothing is loaded yet.
          const [first] = event.payload.paths
          if (first) void addMedia(first)
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
  }, [addMedia])

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
              {/*
                Pinned at the top rather than under the panel.

                It is still the control the whole column leads to, but at the
                bottom it cost every list above it a row's height — on an
                ordinary window the media and the blocks were both a scroll away,
                so a project drawing on several files did not look like one. Up
                here it is reachable at any window size and the two lists start
                higher.
              */}
              <div className="shrink-0 border-b border-line p-3">
                <Button
                  tone="paper"
                  size="md"
                  full
                  disabled={!canExport}
                  title={canExport ? undefined : t('export.nothing')}
                  onClick={showExport}
                  icon={<ExportIcon size={15} />}
                >
                  {t('export.open')}
                </Button>
              </div>

              {/* Scrolls as one column. A short stage must cost the user scroll
                  distance, never a control they can no longer reach. */}
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
                <SelectionPanel />
                <MediaPool />
                <BlockList />
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
