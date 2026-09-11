/**
 * The splash window's only script.
 *
 * Everything it does is fill in text the page cannot know statically: the
 * version comes from the build, and the two sentences come from the same
 * catalogues the editor uses, in the same language the editor will start in.
 * There is no IPC here — the splash window is granted no capability at all, and
 * the backend decides when it goes away.
 */
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/geist-mono'

import { detectLocale, translator } from '@infrastructure/i18n'
import tile from '@presentation/assets/brand-tile.png'

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
