#!/usr/bin/env node
/**
 * Two defects in the message catalogues that no compiler can see.
 *
 * The key sets are already safe: every locale is typed as `Catalogue`, so a
 * missing or misspelled key fails `tsc`. These two do not fail anything.
 *
 * 1. A placeholder translated along with the sentence. `{width}` rendered as
 *    `{largura}` never substitutes, so one language shows a literal brace to
 *    the user while the other three look fine.
 *
 * 2. A key nothing asks for. Dead entries have to be translated, reviewed and
 *    carried by every locale for as long as they sit there. Thirty of them had
 *    accumulated before the first audit found them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const I18N_DIR = join(ROOT, 'src', 'infrastructure', 'i18n')
const SRC_DIR = join(ROOT, 'src')
const CATALOGUES = { en: 'en.ts', 'pt-BR': 'ptBR.ts', es: 'es.ts', zh: 'zh.ts' }

/** Reads one catalogue as a key-to-message map. */
function readCatalogue(file) {
  const text = readFileSync(join(I18N_DIR, file), 'utf8')
  const entries = new Map()
  // Messages are single-quoted and may contain escaped quotes; the key is the
  // only thing before the colon, which is what makes this parseable without a
  // TypeScript parser.
  const pattern = /^\s*'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gm
  for (const match of text.matchAll(pattern)) {
    entries.set(match[1], match[2] ?? match[3] ?? '')
  }
  return entries
}

function placeholders(message) {
  return new Set([...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
}

function sourceFiles(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path))
    } else if (['.ts', '.tsx'].includes(extname(name)) && !path.startsWith(I18N_DIR)) {
      found.push(path)
    }
  }
  return found
}

const catalogues = Object.fromEntries(
  Object.entries(CATALOGUES).map(([locale, file]) => [locale, readCatalogue(file)]),
)
const en = catalogues.en
const problems = []

if (en.size === 0) problems.push('en.ts parsed to zero keys, so this check proves nothing')

// --- placeholders -----------------------------------------------------------

for (const [locale, catalogue] of Object.entries(catalogues)) {
  if (locale === 'en') continue
  for (const [key, message] of catalogue) {
    const expected = placeholders(en.get(key) ?? '')
    const actual = placeholders(message)
    const missing = [...expected].filter((name) => !actual.has(name))
    const unexpected = [...actual].filter((name) => !expected.has(name))
    if (missing.length > 0 || unexpected.length > 0) {
      const parts = []
      if (missing.length > 0) parts.push(`missing {${missing.join('} {')}}`)
      if (unexpected.length > 0) parts.push(`unknown {${unexpected.join('} {')}}`)
      problems.push(`${locale} '${key}': ${parts.join(', ')}`)
    }
  }
}

// --- dead keys --------------------------------------------------------------

const code = sourceFiles(SRC_DIR)
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')

// A key reaches `t()` two ways: written out, or assembled from a prefix and a
// value decided at run time. Both count as a use, and the second one is why a
// plain search for the literal reports false positives.
const literals = new Set([...code.matchAll(/'([a-zA-Z][\w.]*)'/g)].map((m) => m[1]))
const prefixes = [...code.matchAll(/`([a-zA-Z][\w.]*\.)\$\{/g)].map((m) => m[1])

const unused = [...en.keys()].filter(
  (key) => !literals.has(key) && !prefixes.some((prefix) => key.startsWith(prefix)),
)
for (const key of unused) problems.push(`'${key}' is in the catalogue but nothing asks for it`)

// --- report -----------------------------------------------------------------

if (problems.length > 0) {
  console.error(`${problems.length} problem(s) in the message catalogues:\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(
  `${en.size} keys x ${Object.keys(CATALOGUES).length} locales: placeholders agree, none unused`,
)
