import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from '@presentation/app/App'
import { I18nProvider } from '@presentation/i18n/I18nProvider'
import '@presentation/styles/app.css'

const container = document.getElementById('root')
if (!container) throw new Error('the root element is missing from index.html')

// The window is chromeless, so the browser context menu would be the only piece
// of non-application interface on screen. Developer tools remain reachable from
// the debug build's own shortcut.
window.addEventListener('contextmenu', (event) => event.preventDefault())

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
