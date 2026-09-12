/**
 * The splash window's only script.
 *
 * Most of what it does is fill in text the page cannot know statically: the
 * version comes from the build, and the two sentences come from the same
 * catalogues the editor uses, in the same language the editor will start in.
 *
 * The one thing it can ask the backend for is opening the credit line's
 * address. `capabilities/splash.json` grants this window that command and
 * nothing else, scoped to exactly that one URL — the window still cannot reach
 * a file, a dialog or another site, and it never decides when it goes away.
 */
import { openUrl } from '@tauri-apps/plugin-opener'

import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/geist-mono'

import { detectLocale, translator } from '@infrastructure/i18n'
import tile from '@presentation/assets/brand-tile.png'

/**
 * The only outbound address the application ever asks for, and the same one the
 * editor's credit line opens. Kept identical to `AuthorLink.tsx` on purpose: the
 * capability files scope both to this exact URL, so a second address here would
 * be refused rather than opened.
 */
const AUTHOR_URL = 'https://ko-fi.com/omtstm'

const t = translator(detectLocale())

const mark = document.getElementById('mark')
if (mark instanceof HTMLImageElement) mark.src = tile

const set = (id: string, text: string) => {
  const node = document.getElementById(id)
  if (node) node.textContent = text
}

set('version', __APP_VERSION__)
set('tagline', t('splash.tagline'))
set('by', t('about.author'))

const by = document.getElementById('by')
if (by) {
  by.setAttribute('title', AUTHOR_URL)
  by.addEventListener('click', () => {
    // A machine with no browser association is not worth an error over a credit
    // line — and this window has no way to show one anyway.
    void openUrl(AUTHOR_URL).catch(() => {})
  })
}
