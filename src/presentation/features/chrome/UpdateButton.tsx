import { openUrl } from '@tauri-apps/plugin-opener'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { formatBytes } from '@domain/media'
import { api, EVENTS, subscribe, type UpdateProgress, type UpdateRelease, type UpdateReport } from '@infrastructure/tauri/api'
import { Download } from '@presentation/components/Icons'
import { Button, ProgressBar } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'
import { useEditor } from '@presentation/state/editorStore'

import { CHROME_CONTROL, CHROME_ICON } from './controls'

/**
 * Where "what changed" leads.
 *
 * A constant, not the address the release document carried: that document comes
 * off the network, and a URL from it handed to a browser is an open redirect
 * with extra steps. The capability in `src-tauri/capabilities/default.json` is
 * scoped to this exact address, so the renderer could not open another one even
 * if it tried.
 */
const RELEASES_URL = 'https://github.com/OmTsTM/snip-join/releases'

/**
 * Where the update has got to.
 *
 * Modelled as one value rather than four booleans because the states exclude
 * each other: a check that is still running cannot also have a file waiting, and
 * the dialog should never have to decide which of two truths to draw.
 */
type Stage =
  | { readonly kind: 'checking' }
  | { readonly kind: 'report'; readonly report: UpdateReport }
  | {
      readonly kind: 'downloading'
      readonly report: UpdateReport
      readonly release: UpdateRelease
      readonly received: number
      readonly total: number
    }
  | {
      readonly kind: 'ready'
      readonly report: UpdateReport
      readonly release: UpdateRelease
      readonly path: string
    }

/**
 * Asking whether there is a newer Snip Join.
 *
 * A button rather than something that happens on its own: the application makes
 * no network request until this is pressed, at startup or otherwise, and an
 * editor that quietly phones home is not what anyone installed. The cost is that
 * nobody is told about a release they do not go looking for, which is the right
 * side to err on for a tool that works perfectly well as it is.
 */
export function UpdateButton({
  onBeforeReplace,
}: {
  readonly onBeforeReplace: () => Promise<boolean>
}) {
  const t = useT()
  const reportError = useEditor((state) => state.reportError)
  const [stage, setStage] = useState<Stage | null>(null)

  // Read inside the async flows to decide whether their result still matters:
  // the dialog can be closed while a check or a download is in flight.
  const openRef = useRef(false)
  openRef.current = stage !== null

  const check = useCallback(() => {
    setStage({ kind: 'checking' })
    void api
      .checkForUpdate()
      .then((report) => {
        if (openRef.current) setStage({ kind: 'report', report })
      })
      .catch((error: unknown) => {
        setStage(null)
        reportError(error)
      })
  }, [reportError])

  const download = useCallback(
    (report: UpdateReport, release: UpdateRelease) => {
      setStage({
        kind: 'downloading',
        report,
        release,
        received: 0,
        total: release.assetSize,
      })

      void api
        .downloadUpdate(release.assetUrl, release.assetName, release.signatureUrl)
        .then((path) => {
          if (openRef.current) setStage({ kind: 'ready', report, release, path })
        })
        .catch((error: unknown) => {
          if (openRef.current) setStage({ kind: 'report', report })
          reportError(error)
        })
    },
    [reportError],
  )

  // Only while something is being fetched: the topic is quiet otherwise, and a
  // listener that outlives the dialog would hold a stale setter.
  const downloading = stage?.kind === 'downloading'
  useEffect(() => {
    if (!downloading) return

    return subscribe<UpdateProgress>(EVENTS.updateProgress, (progress) => {
      setStage((current) =>
        current?.kind === 'downloading'
          ? { ...current, received: progress.received, total: progress.total || current.total }
          : current,
      )
    })
  }, [downloading])

  const apply = useCallback(
    (path: string, version: string) => {
      // Asked first, because applying an update ends this process: the installer
      // needs the application gone before it can replace its files, and a
      // portable copy is swapped and relaunched. Neither goes through the
      // window's close event, so neither would otherwise ask.
      void onBeforeReplace().then((proceed) => {
        if (!proceed) return

        // Nothing to set afterwards on the paths that take the application down
        // with them; revealing a portable archive leaves the dialog done.
        void api
          .applyUpdate(path, version)
          .then(() => setStage(null))
          .catch((error: unknown) => reportError(error))
      })
    },
    [onBeforeReplace, reportError],
  )

  return (
    <>
      <button
        type="button"
        onClick={check}
        title={t('update.label')}
        aria-label={t('update.label')}
        className={CHROME_CONTROL}
      >
        <Download size={CHROME_ICON} />
      </button>

      <UpdateDialog
        stage={stage}
        onClose={() => setStage(null)}
        onDownload={download}
        onApply={apply}
      />
    </>
  )
}

function UpdateDialog({
  stage,
  onClose,
  onDownload,
  onApply,
}: {
  readonly stage: Stage | null
  readonly onClose: () => void
  readonly onDownload: (report: UpdateReport, release: UpdateRelease) => void
  readonly onApply: (path: string, version: string) => void
}) {
  const t = useT()

  useEffect(() => {
    if (!stage) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, stage])

  /*
    Portalled into the body, and it has to be.

    This dialog is rendered from inside the title bar, and the title bar carries
    a `backdrop-blur` — which makes it the containing block for anything `fixed`
    inside it. Left where it was declared, a dialog that asks to cover the window
    covered the forty pixels of the header instead, and arrived clipped by the
    top of the screen.
  */
  return createPortal(
    <AnimatePresence>
      {stage && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) onClose()
          }}
          className="fixed inset-0 z-[55] flex items-center justify-center bg-ink-deep/80 p-6 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 4 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label={t('update.title')}
            className="w-full max-w-[420px] overflow-hidden rounded-2xl border border-line-bright bg-panel shadow-[0_40px_100px_-30px_rgba(0,0,0,0.9)]"
          >
            <div className="px-5 pb-4 pt-5">
              <h2 className="font-display text-[15px] font-semibold tracking-tight text-paper">
                {t('update.title')}
              </h2>
              <Body stage={stage} />
            </div>

            <div className="flex items-center gap-2 border-t border-line px-5 py-3">
              <Actions stage={stage} onClose={onClose} onDownload={onDownload} onApply={onApply} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Body({ stage }: { readonly stage: Stage }) {
  const t = useT()

  if (stage.kind === 'checking') {
    return <p className="mt-2 text-[12.5px] leading-snug text-muted">{t('update.checking')}</p>
  }

  if (stage.kind === 'report' && !stage.report.newer) {
    return (
      <p className="mt-2 text-[12.5px] leading-snug text-muted">
        {t('update.upToDate', { version: stage.report.current })}
      </p>
    )
  }

  const release = stage.kind === 'report' ? stage.report.newer! : stage.release
  const portable = stage.report.kind === 'portable'

  return (
    <div className="mt-2 space-y-2">
      <p className="text-[12.5px] leading-snug text-paper">
        {t('update.available', { version: release.version })}
      </p>
      <p className="text-[11.5px] leading-snug text-faint">
        {t('update.running', { version: stage.report.current })}{' '}
        {portable ? t('update.portableNote') : t('update.installNote')}
      </p>

      {stage.kind === 'downloading' && (
        <div className="space-y-1.5 pt-1">
          <ProgressBar value={stage.total > 0 ? stage.received / stage.total : 0} tone="dusk" />
          <p className="timecode text-[10.5px] text-faint">
            {formatBytes(stage.received)} / {formatBytes(stage.total)}
          </p>
        </div>
      )}

      {stage.kind === 'ready' && (
        <p className="text-[11.5px] leading-snug text-faint">{stage.path}</p>
      )}
    </div>
  )
}

function Actions({
  stage,
  onClose,
  onDownload,
  onApply,
}: {
  readonly stage: Stage
  readonly onClose: () => void
  readonly onDownload: (report: UpdateReport, release: UpdateRelease) => void
  readonly onApply: (path: string, version: string) => void
}) {
  const t = useT()

  const somethingNew =
    stage.kind === 'report' ? stage.report.newer !== null : stage.kind !== 'checking'

  return (
    <>
      {somethingNew && (
        <button
          type="button"
          // A machine with no browser association is not worth an error toast
          // over a link nobody has to press.
          onClick={() => void openUrl(RELEASES_URL).catch(() => {})}
          title={t('hint.updateNotes')}
          className="text-[12px] text-muted underline decoration-line-bright underline-offset-2 transition-colors duration-150 hover:text-paper"
        >
          {t('update.notes')}
        </button>
      )}

      <div className="flex-1" />

      <Button size="sm" tone="quiet" title={t('hint.updateClose')} onClick={onClose}>
        {t('update.close')}
      </Button>

      {stage.kind === 'report' && stage.report.newer && (
        <Button
          size="sm"
          tone="paper"
          title={t('hint.updateDownload')}
          onClick={() => onDownload(stage.report, stage.report.newer!)}
        >
          {stage.report.newer.assetSize > 0
            ? t('update.download', { size: formatBytes(stage.report.newer.assetSize) })
            : t('update.downloadPlain')}
        </Button>
      )}

      {stage.kind === 'downloading' && (
        <Button size="sm" tone="paper" title={t('hint.updateWait')} disabled>
          {t('update.downloading')}
        </Button>
      )}

      {stage.kind === 'ready' && (
        <Button
          size="sm"
          tone="paper"
          title={
            stage.report.kind === 'portable'
              ? t('update.portableNote')
              : t('update.installNote')
          }
          onClick={() => onApply(stage.path, stage.release.version)}
        >
          {t('update.install')}
        </Button>
      )}
    </>
  )
}
