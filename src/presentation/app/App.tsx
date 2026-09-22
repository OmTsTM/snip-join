import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Chevron, Export as ExportIcon, Save as SaveIcon } from '@presentation/components/Icons'
import { Button, cx } from '@presentation/components/primitives'
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
import { useOpenVideo } from '@presentation/features/chrome/OpenAnother'
import { Welcome } from '@presentation/features/welcome/Welcome'
import { PanelsMenu } from '@presentation/features/inspector/InspectorPanel'
import { usePanels } from '@presentation/features/inspector/panels'
import { UnsavedDialog } from '@presentation/features/project/UnsavedDialog'
import { AUTOSAVE_INTERVAL_MS, useProjectActions } from '@presentation/features/project/useProject'
import { useShortcuts } from '@presentation/hooks/useShortcuts'
import { api } from '@infrastructure/tauri/api'
import {
  connectBackendEvents,
  selectCanExport,
  selectDirty,
  useEditor,
} from '@presentation/state/editorStore'

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
  const [askingToSave, setAskingToSave] = useState(false)

  const dirty = useEditor(selectDirty)
  const projectPath = useEditor((state) => state.projectPath)
  const { saveNow, openExisting } = useProjectActions()
  const chooseVideo = useOpenVideo()

  const inspectorOpen = usePanels((state) => state.open)
  const setInspectorOpen = usePanels((state) => state.setOpen)

  /**
   * Asks about unsaved work, and answers whether it is all right to go ahead.
   *
   * One question with two callers, which is the whole reason it is shaped like
   * this: the window closing, and an update about to replace the application
   * underneath it. Both are moments where the state in this window stops
   * existing, and only one of them used to ask — installing an update took the
   * process down with `exit`, which fires no close event and so asked nothing.
   *
   * The answer arrives from a dialog, so it is a promise: the resolver is held
   * until one of the three buttons is pressed.
   */
  const answer = useRef<((proceed: boolean) => void) | null>(null)

  const askAboutUnsavedWork = useCallback((): Promise<boolean> => {
    const state = useEditor.getState()
    if (!selectDirty(state)) return Promise.resolve(true)

    setAskingToSave(true)
    return new Promise<boolean>((resolve) => {
      answer.current = resolve
    })
  }, [])

  const settle = useCallback((proceed: boolean) => {
    setAskingToSave(false)
    answer.current?.(proceed)
    answer.current = null
  }, [])

  // Guarded here rather than only on the button, so the keyboard cannot reach
  // the dialog for a timeline that would produce no file.
  const showExport = useCallback(() => {
    const state = useEditor.getState()
    if (state.history.present.blocks.length === 0) return

    // A project that already has a file on disk is written before the dialog
    // opens, and quietly: an export is the moment the edit is worth keeping,
    // and a question about saving is one more thing between the user and the
    // file they asked for. A project that has never been saved is left alone.
    // Choosing a name and a place on their behalf is not what they asked for
    // either, and the export does not need one.
    if (state.projectPath && selectDirty(state)) void state.saveProject()
    setExportOpen(true)
  }, [])
  const showShortcuts = useCallback(() => setShortcutsOpen((open) => !open), [])

  // Asking the window to close, rather than closing anything here: the handler
  // below is the one place that knows what closing means, and the keyboard
  // should not learn it a second time.
  const requestClose = useCallback(() => void getCurrentWindow().close(), [])

  /**
   * Opens a saved project in place of this one, asking first.
   *
   * Opening another project loses the edit in this window exactly as closing
   * it does, so it is the same question. It used to be asked on the way out
   * and on the way to a *new* project, but not here, which made "open a
   * project" the one door out of an unsaved edit that swallowed it silently.
   */
  const openAnotherProject = useCallback(
    () =>
      askAboutUnsavedWork().then((proceed) => {
        if (proceed) return openExisting()
        return undefined
      }),
    [askAboutUnsavedWork, openExisting],
  )

  useShortcuts({
    onExport: showExport,
    onShowShortcuts: showShortcuts,
    onOpenVideo: () => void chooseVideo(),
    onOpenProject: () => void openAnotherProject(),
    onClose: requestClose,
  })

  // One subscription for the whole application, torn down on unmount so a hot
  // reload cannot stack duplicate listeners.
  useEffect(() => connectBackendEvents(), [])

  /**
   * Writes a project that is already on disk, every so often.
   *
   * Only one that has been saved before: a project with no path has never been
   * given a name or a place, and choosing one on the user's behalf while they
   * are editing is not a rescue. What this covers is the power going out — the
   * most that can be lost is the last half minute of cuts.
   */
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => {
    if (!projectPath) return

    const timer = window.setInterval(() => {
      if (dirtyRef.current) void useEditor.getState().saveProject()
    }, AUTOSAVE_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [projectPath])

  /**
   * Puts the editor down and goes back to the front door.
   *
   * Closing the editor is not quitting. One window does two jobs here — the
   * welcome screen with its list of recent projects, and the project itself —
   * and the close button means "I am done with this one", which almost always
   * comes just before opening another. Leaving the application running is what
   * turns that into one click instead of a relaunch and a splash screen.
   */
  const leaveProject = useCallback(() => {
    setExportOpen(false)
    void useEditor.getState().closeFile()
  }, [])


  /**
   * Stands between unsaved work and the editor being put down.
   *
   * Tauri asks before it closes, which is the only chance there is: the state
   * lives in this window either way. The answer comes back asynchronously, so
   * the close is always refused while a project is open and the departure is
   * made afterwards by hand. With nothing open the request is left alone and the
   * application really does quit — the welcome screen holds no work, so there is
   * nothing there to ask about.
   */
  useEffect(() => {
    let detach: (() => void) | null = null
    let cancelled = false

    void getCurrentWindow()
      .onCloseRequested((event) => {
        // Whether the editor is open, not whether it holds anything: a blank
        // project is one somebody started on purpose, and closing it should put
        // them back at the front door like closing any other. Only from there
        // does a close mean quit.
        if (useEditor.getState().phase === 'empty') return
        event.preventDefault()
        void askAboutUnsavedWork().then((proceed) => {
          if (proceed) leaveProject()
        })
      })
      .then((unlisten) => {
        if (cancelled) unlisten()
        else detach = unlisten
      })

    return () => {
      cancelled = true
      detach?.()
    }
  }, [askAboutUnsavedWork, leaveProject])

  /**
   * Leaves the current project for a blank one.
   *
   * Which is the welcome screen: a project with nothing in it is the front door,
   * and there is no second kind of empty. The question about unsaved work is the
   * one the close button asks, for the same reason and with the same three
   * answers.
   */
  const startNewProject = useCallback(() => {
    void askAboutUnsavedWork().then((proceed) => {
      if (!proceed) return
      setExportOpen(false)
      void useEditor.getState().newProject()
    })
  }, [askAboutUnsavedWork])

  const saveThenProceed = useCallback(() => {
    void saveNow().then((written) => {
      // A dismissed picker is not a save, and going ahead on it would throw away
      // the work the question was asked about.
      if (written) settle(true)
      else setAskingToSave(false)
    })
  }, [saveNow, settle])

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
      <TitleBar
        onShowShortcuts={showShortcuts}
        onBeforeReplace={askAboutUnsavedWork}
        onNewProject={startNewProject}
        onOpenProject={openAnotherProject}
      />

      {editing ? (
        <main className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <section className="flex min-w-0 flex-1 flex-col">
              <Preview />
              <Transport />
            </section>

            {/*
              The drawer's handle, and the only way back once the column is
              away. A full-height strip rather than a button in a corner: it
              is the edge of the panel, so the edge is what you press, and it
              stays exactly where it was whichever side of the gesture you are
              on. It carries the border the column used to draw, so the stage
              keeps a hard edge either way.
            */}
            <button
              type="button"
              onClick={() => setInspectorOpen(!inspectorOpen)}
              title={inspectorOpen ? t('panels.hideColumn') : t('panels.showColumn')}
              aria-label={inspectorOpen ? t('panels.hideColumn') : t('panels.showColumn')}
              aria-expanded={inspectorOpen}
              className="group flex w-4 shrink-0 items-center justify-center border-l border-line bg-ink/40 transition-colors duration-150 hover:bg-raised"
            >
              <Chevron
                size={13}
                className={cx(
                  'text-faint transition-[transform,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
                  'group-hover:text-paper motion-reduce:transition-none',
                  inspectorOpen ? '-rotate-90' : 'rotate-90',
                )}
              />
            </button>

            {/*
              Width rather than display, so the column slides instead of
              blinking out, and the stage's `ResizeObserver` refits the picture
              as it travels. `inert` while it is away, or the keyboard would
              still walk into controls nobody can see.
            */}
            <aside
              inert={!inspectorOpen}
              className={cx(
                'flex shrink-0 flex-col overflow-hidden bg-ink/40',
                'transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                inspectorOpen ? 'w-[312px]' : 'w-0',
              )}
            >
              <div className="flex h-full w-[312px] flex-col">
                {/*
                  Pinned at the top rather than under the panel.

                  It is still the control the whole column leads to, but at
                  the bottom it cost every list above it a row's height — on
                  an ordinary window the media and the blocks were both a
                  scroll away, so a project drawing on several files did not
                  look like one. Up here it is reachable at any window size
                  and the two lists start higher.
                */}
                {/* Saving beside exporting, and narrower: they are the two
                    ways work leaves this window, but only one of them is what
                    you do before you walk away from it. */}
                <div className="flex shrink-0 items-center gap-2 border-b border-line p-3">
                  <Button
                    tone="neutral"
                    size="md"
                    disabled={!canExport}
                    title={dirty ? t('project.unsaved') : t('project.saved')}
                    onClick={() => void saveNow()}
                    icon={<SaveIcon size={15} />}
                    className="relative"
                  >
                    {t('project.save')}
                    {dirty && (
                      <span
                        aria-hidden="true"
                        className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-dusk-lift"
                      />
                    )}
                  </Button>

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

                  {/* Which panels the column shows. A panel put away with its
                      own button comes back from here. */}
                  <PanelsMenu />
                </div>

                {/* Scrolls as one column. A short stage must cost the user
                    scroll distance, never a control they can no longer
                    reach. */}
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
                  <SelectionPanel />
                  <MediaPool />
                  <BlockList />
                </div>
              </div>
            </aside>
          </div>

          <DockResizer />
          <TimelineDock />
        </main>
      ) : (
        <Welcome dropActive={dropActive} />
      )}

      <UnsavedDialog
        open={askingToSave}
        onSave={saveThenProceed}
        onDiscard={() => settle(true)}
        onCancel={() => settle(false)}
      />

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ErrorToast />
    </div>
  )
}
