import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react'

import {
  detectLocale,
  storeLocale,
  translator,
  type Locale,
  type MessageKey,
} from '@infrastructure/i18n'

interface I18nValue {
  readonly locale: Locale
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
  readonly setLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale())

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    storeLocale(next)
    document.documentElement.lang = next
  }, [])

  const value = useMemo<I18nValue>(
    () => ({ locale, t: translator(locale), setLocale }),
    [locale, setLocale],
  )

  return <I18nContext value={value}>{children}</I18nContext>
}

export function useI18n(): I18nValue {
  const value = use(I18nContext)
  if (!value) throw new Error('useI18n must be used inside an I18nProvider')
  return value
}

/** Shorthand for components that only need to translate. */
export function useT() {
  return useI18n().t
}
