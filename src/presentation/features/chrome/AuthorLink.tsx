import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback } from 'react'

import { cx } from '@presentation/components/primitives'
import { useT } from '@presentation/i18n/I18nProvider'

/**
 * The only outbound address the application ever asks for. The capability in
 * `src-tauri/capabilities/default.json` is scoped to exactly this URL, so the
 * renderer cannot be talked into opening anything else.
 */
const AUTHOR_URL = 'https://x.com/omtstm'

/**
 * A credit line, deliberately quiet.
 *
 * Paper on hover rather than orange: orange is the colour of cutting, and a
 * link to the author's page removes nothing.
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
        'rounded-[4px] text-[11px] tracking-wide text-faint underline-offset-[3px]',
        'transition-colors hover:text-paper hover:underline',
        className,
      )}
    >
      {t('about.author')}
    </button>
  )
}
