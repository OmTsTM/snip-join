import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback } from 'react'

import { ArrowOut } from '@presentation/components/Icons'
import { cx } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'

/**
 * The only outbound address the application ever asks for. The capability in
 * `src-tauri/capabilities/default.json` is scoped to exactly this URL, so the
 * renderer cannot be talked into opening anything else.
 */
const AUTHOR_URL = 'https://ko-fi.com/omtstm'

/**
 * A credit line that admits to being a link.
 *
 * Underlined and blue at rest rather than only on hover: a control that looks
 * like body text until the pointer finds it is a control most people never
 * find. The arrow says the destination is outside the application, and arrives
 * on hover so the line stays quiet while nobody is looking at it.
 *
 * Dusk, not orange. Orange is the colour of cutting, and this removes nothing.
 */
export function AuthorLink({ className }: { readonly className?: string }) {
  const t = useT()

  const open = useCallback(() => {
    // A machine with no browser association is not worth an error toast over a
    // credit line, so the failure is swallowed.
    void openUrl(AUTHOR_URL).catch(() => {})
  }, [])

  return (
    <button
      type="button"
      onClick={open}
      title={AUTHOR_URL}
      className={cx(
        'group inline-flex items-center gap-1 rounded-[4px] text-[11px] tracking-wide',
        'text-dusk-lift transition-colors duration-150 hover:text-dusk-bright',
        className,
      )}
    >
      <span className="underline decoration-dusk-lift/45 underline-offset-[3px] transition-[text-decoration-color] duration-150 group-hover:decoration-dusk-bright">
        {t('about.author')}
      </span>

      {/* Heavier than the set's 1.6: at eleven pixels the default stroke
          antialiases down to a grey smudge and loses the blue. */}
      <ArrowOut
        size={11}
        strokeWidth={2.1}
        className={cx(
          '-translate-x-0.5 opacity-0',
          'transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]',
          'group-hover:translate-x-0 group-hover:opacity-100',
        )}
      />
    </button>
  )
}
