import { en, type Catalogue, type MessageKey } from './en'
import { es } from './es'
import { ptBR } from './ptBR'
import { zh } from './zh'

export type { MessageKey } from './en'

export const LOCALES = ['en', 'pt-BR', 'es', 'zh'] as const
export type Locale = (typeof LOCALES)[number]

const CATALOGUES: Record<Locale, Catalogue> = {
  en,
  'pt-BR': ptBR,
  es,
  zh,
}

/** Names are written in their own language, which is how people find theirs. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  'pt-BR': 'Português',
  es: 'Español',
  zh: '中文',
}

const STORAGE_KEY = 'snipjoin.locale'

/**
 * Picks the starting language from the operating system, falling back to
 * English.
 *
 * Matching is done on the language subtag so `pt-PT` and `es-MX` land on the
 * closest catalogue rather than dropping to English, and every Chinese variant
 * resolves to the one Chinese catalogue that exists.
 */
export function detectLocale(preferred: readonly string[] = navigator.languages ?? []): Locale {
  const stored = readStoredLocale()
  if (stored) return stored

  const candidates = preferred.length > 0 ? preferred : [navigator.language ?? 'en']

  for (const tag of candidates) {
    const normalised = tag.toLowerCase()

    if (normalised === 'pt-br' || normalised.startsWith('pt')) return 'pt-BR'
    if (normalised.startsWith('es')) return 'es'
    if (normalised.startsWith('zh')) return 'zh'
    if (normalised.startsWith('en')) return 'en'
  }

  return 'en'
}

function readStoredLocale(): Locale | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return LOCALES.includes(value as Locale) ? (value as Locale) : null
  } catch {
    // Storage can be unavailable; a missing preference is not an error.
    return null
  }
}

export function storeLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // The choice still applies for this session.
  }
}

export function catalogue(locale: Locale): Catalogue {
  return CATALOGUES[locale] ?? en
}

/**
 * Builds a translator for one locale.
 *
 * Substitution is a plain replace rather than a format library: the catalogues
 * only ever interpolate already-formatted strings, so there is no pluralisation
 * or number formatting to get wrong here.
 */
export function translator(locale: Locale) {
  const messages = catalogue(locale)

  return function translate(key: MessageKey, values?: Readonly<Record<string, string | number>>): string {
    const template = messages[key] ?? en[key] ?? key
    if (!values) return template

    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in values ? String(values[name]) : match,
    )
  }
}

export type Translate = ReturnType<typeof translator>
