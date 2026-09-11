#!/usr/bin/env node
/**
 * Assembles the portable edition.
 *
 * Everything the application needs sits in one folder that can be copied to a
 * stick and run with no installer, no registry entry, and nothing written to the
 * user's profile. The `portable.txt` marker is what switches that on: the Rust
 * side looks for it beside the executable and redirects caches and the web
 * view's storage into `data/` next to it.
 *
 * Run after `tauri build`, or use `pnpm app:portable`, which does both.
 */

import { execFileSync } from 'node:child_process'
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = join(ROOT, 'src-tauri', 'target', 'release')
const FFMPEG_BIN = join(ROOT, 'src-tauri', 'bin')
const STAGE = join(RELEASE, 'portable', 'Snip Join')
const OUT_DIR = join(RELEASE, 'bundle', 'portable')

const MARKER = `Snip Join — portable edition

This file is what makes the copy portable. While it is here, Snip Join keeps
everything it writes in the "data" folder beside the executable: the preview
cache, scratch space for exports, and its own settings. Nothing is written to
your user profile and nothing is added to the registry.

Delete this file and Snip Join behaves like an installed copy, using the normal
Windows locations instead.

The "bin" folder holds FFmpeg. Keep it next to SnipJoin.exe.
`

function log(message) {
  process.stdout.write(`  ${message}\n`)
}

async function directorySize(directory) {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    total += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size
  }
  return total
}

async function main() {
  const exe = join(RELEASE, 'snipjoin.exe')
  if (!existsSync(exe)) {
    throw new Error('src-tauri/target/release/snipjoin.exe is missing; run `pnpm tauri build` first')
  }
  if (!existsSync(join(FFMPEG_BIN, 'ffmpeg.exe'))) {
    throw new Error('src-tauri/bin/ffmpeg.exe is missing; run `pnpm ffmpeg:fetch` first')
  }

  await rm(join(RELEASE, 'portable'), { recursive: true, force: true })
  await mkdir(STAGE, { recursive: true })
  await mkdir(OUT_DIR, { recursive: true })

  // The executable keeps its installed name so shortcuts and "Open with" entries
  // made against one copy still resolve against another.
  await cp(exe, join(STAGE, 'SnipJoin.exe'))
  await cp(FFMPEG_BIN, join(STAGE, 'bin'), { recursive: true })
  await writeFile(join(STAGE, 'portable.txt'), MARKER, 'utf8')

  const size = await directorySize(STAGE)
  log(`staged    : ${(size / 1024 / 1024).toFixed(0)} MB`)

  const { version } = JSON.parse(
    await (await import('node:fs/promises')).readFile(join(ROOT, 'package.json'), 'utf8'),
  )
  const archive = join(OUT_DIR, `Snip Join_${version}_x64_portable.zip`)
  await rm(archive, { force: true })

  log('compressing…')
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${STAGE}' -DestinationPath '${archive}' -CompressionLevel Optimal -Force`,
      ],
      { stdio: 'inherit' },
    )
  } else {
    execFileSync('zip', ['-qr', archive, 'Snip Join'], { cwd: dirname(STAGE), stdio: 'inherit' })
  }

  const packed = (await stat(archive)).size
  log(`archive   : ${(packed / 1024 / 1024).toFixed(0)} MB`)
  log(`written   : ${archive}`)
}

main().catch((error) => {
  process.stderr.write(`\nbuild-portable failed: ${error.message}\n`)
  process.exit(1)
})
