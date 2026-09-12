import { openUrl } from '@tauri-apps/plugin-opener'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback } from 'react'

import brandMark from '@presentation/assets/brand-mark.png'
import { Close, Globe, Keyboard, Maximize, Minimize, Palette } from '@presentation/components/Icons'
import { cx } from '@presentation/components/primitives'
import { useI18n } from '@presentation/i18n/I18nProvider'
import { LOCALES, LOCALE_NAMES, type Locale } from '@infrastructure/i18n'
import { SKINS, useSkin, type Skin } from './skins'
import { selectDuration, useEditor } from '@presentation/state/editorStore'
import { displaySize } from '@domain/media'
import { OpenAnother, OpenProject } from './OpenAnother'
import { formatTimecode } from '@domain/time'

/**
 * The window's own chrome.
 *
 * Native decorations are off so the title bar can carry the file identity and
 * the language control, which would otherwise need a menu bar this application
 * has no other use for.
 */
/**
 * Where the mark in the title bar leads.
 *
 * The capability in `src-tauri/capabilities/default.json` is scoped to this
 * address and the credit line's, so the renderer cannot be talked into opening
 * a third.
 */
const PROJECT_URL = 'https://github.com/OmTsTM/snip-join'

/**
 * The class every control in the title bar is written in.
 *
 * `muted`, not `faint`. These are the only controls on screen with no panel
 * behind them, sitting on the darkest band the interface has, and `faint` left
 * them at about three to one against it — legible if you already knew they were
 * there. It is a role rather than a colour, so every skin lifts them by its own
 * lights rather than by this one's.
 */
const CHROME_TEXT = 'text-muted transition-colors duration-150 hover:bg-raised hover:text-paper'

export function TitleBar({ onShowShortcuts }: { readonly onShowShortcuts: () => void }) {
  const { t, locale, setLocale } = useI18n()
  const skin = useSkin((state) => state.skin)
  const setSkin = useSkin((state) => state.setSkin)
  const source = useEditor((state) => state.source)
  const duration = useEditor(selectDuration)

  // A machine with no browser association is not worth an error toast over a
  // link nobody has to press.
  const openProject = useCallback(() => void openUrl(PROJECT_URL).catch(() => {}), [])

  const minimize = useCallback(() => void getCurrentWindow().minimize(), [])
  const toggleMaximize = useCallback(() => void getCurrentWindow().toggleMaximize(), [])
  const close = useCallback(() => void getCurrentWindow().close(), [])

  const video = source?.video

  return (
    <header
      data-tauri-drag-region
      className="relative z-30 flex h-10 shrink-0 items-center gap-3 border-b border-line bg-ink-deep/80 pl-3 pr-0 backdrop-blur"
    >
      {/* The mark and the name are one control: the project's own page. `no-drag`
          because the header is the window's drag region, which would otherwise
          swallow the press. */}
      <button
        type="button"
        onClick={openProject}
        title={PROJECT_URL}
        aria-label={t('about.project')}
        className={cx(
          'no-drag group flex shrink-0 items-center gap-3 rounded-md py-0.5 pr-1',
          'transition-opacity duration-150 hover:opacity-100',
        )}
      >
        <img src={brandMark} alt="" width={20} height={20} className="shrink-0 rounded-[5px]" />

        <span className="font-display text-[13px] font-semibold tracking-tight text-paper">
          <span className="text-snip-ink">Snip</span>Join
        </span>
      </button>

      <span className="timecode pointer-events-none -ml-1.5 shrink-0 text-[10px] text-faint">
        {__APP_VERSION__}
      </span>

      {source && (
        <div
          data-tauri-drag-region
          className="pointer-events-none flex min-w-0 flex-1 items-center gap-2.5 pl-2 text-[12px]"
        >
          <span className="h-3 w-px shrink-0 bg-line-bright" />
          <span className="truncate text-muted" title={source.path}>
            {source.fileName}
          </span>
          {video && video.width > 0 && (
            <span className="shrink-0 text-faint">
              {t('source.resolution', displaySize(video))}
            </span>
          )}
          <span className="timecode shrink-0 text-faint">{formatTimecode(duration, { frames: false })}</span>
          {!source.audio && <span className="shrink-0 text-faint">{t('source.noAudio')}</span>}
        </div>
      )}

      {!source && <div data-tauri-drag-region className="flex-1" />}

      {/* Opening a project is offered whether or not anything is loaded: it is
          the way back into work, and the welcome screen is exactly where that
          is wanted. Adding a file is only meaningful once there is a project to
          add it to. */}
      <OpenProject />
      {source && <OpenAnother />}

      <button
        type="button"
        onClick={onShowShortcuts}
        title={t('shortcuts.show')}
        aria-label={t('shortcuts.show')}
        className={cx('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md', CHROME_TEXT)}
      >
        <Keyboard size={14} />
      </button>

      <SkinPicker current={skin} onPick={setSkin} label={t('skin.label')} />
      <LanguagePicker current={locale} onPick={setLocale} label={t('language.label')} />

      <div className="flex h-full shrink-0">
        <WindowButton label={t('window.minimize')} onClick={minimize}>
          <Minimize size={14} />
        </WindowButton>
        <WindowButton label={t('window.maximize')} onClick={toggleMaximize}>
          <Maximize size={12} />
        </WindowButton>
        <WindowButton label={t('window.close')} onClick={close} danger>
          <Close size={14} />
        </WindowButton>
      </div>
    </header>
  )
}

function WindowButton({
  label,
  onClick,
  danger,
  children,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly danger?: boolean
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cx(
        'inline-flex h-full w-11 items-center justify-center text-muted transition-colors duration-150',
        danger ? 'hover:bg-[#c0392b] hover:text-white' : 'hover:bg-raised hover:text-paper',
      )}
    >
      {children}
    </button>
  )
}

function LanguagePicker({
  current,
  onPick,
  label,
}: {
  readonly current: Locale
  readonly onPick: (locale: Locale) => void
  readonly label: string
}) {
  return (
    <div className="group relative mr-1 shrink-0">
      <button
        type="button"
        title={label}
        aria-label={label}
        className={cx('inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px]', CHROME_TEXT)}
      >
        <Globe size={13} />
        {LOCALE_NAMES[current]}
      </button>

      {/* Opens on hover and on keyboard focus, so it is reachable without a
          pointer even though it has no click-to-open state. */}
      <div className="invisible absolute right-0 top-full z-40 w-36 translate-y-1 rounded-lg border border-line bg-panel p-1 opacity-0 shadow-2xl transition-[opacity,visibility] duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        {LOCALES.map((locale) => (
          <button
            key={locale}
            type="button"
            onClick={() => onPick(locale)}
            className={cx(
              'block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors duration-150',
              locale === current ? 'bg-raised-hi text-paper' : 'text-muted hover:bg-raised hover:text-paper',
            )}
          >
            {LOCALE_NAMES[locale]}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Which skin the interface wears.
 *
 * Beside the language for a reason: both are choices about the window rather
 * than about the edit, both outlive every file, and neither belongs anywhere
 * near the timeline. Built the same way, so one is not a second thing to learn.
 */
function SkinPicker({
  current,
  onPick,
  label,
}: {
  readonly current: Skin
  readonly onPick: (skin: Skin) => void
  readonly label: string
}) {
  const t = useI18n().t

  return (
    <div className="group relative shrink-0">
      <button
        type="button"
        title={label}
        aria-label={label}
        className={cx('inline-flex h-7 w-7 items-center justify-center rounded-md', CHROME_TEXT)}
      >
        <Palette size={14} />
      </button>

      <div className="invisible absolute right-0 top-full z-40 w-36 translate-y-1 rounded-lg border border-line bg-panel p-1 opacity-0 shadow-2xl transition-[opacity,visibility] duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        {SKINS.map((skin) => (
          <button
            key={skin}
            type="button"
            onClick={() => onPick(skin)}
            className={cx(
              'block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors duration-150',
              skin === current
                ? 'bg-raised-hi text-paper'
                : 'text-muted hover:bg-raised hover:text-paper',
            )}
          >
            {t(`skin.${skin}`)}
          </button>
        ))}
      </div>
    </div>
  )
}
