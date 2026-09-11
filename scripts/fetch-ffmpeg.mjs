#!/usr/bin/env node
/**
 * Fetches the FFmpeg build that ships inside the application.
 *
 * Run before packaging. It resolves the newest *release-line* build rather than
 * a nightly, so every Snip Join release carries a current but stable FFmpeg, and
 * it skips the download when the copy on disk already matches.
 *
 * Why BtbN's shared GPL build:
 *   - shared, so ffmpeg.exe and ffprobe.exe do not each embed a private ~90 MB
 *     copy of the same libraries
 *   - GPL, so x264, x265 and SVT-AV1 are present
 *   - carries libplacebo and cas, which the GPU upscaling tiers need
 *   - published per release line (n9.0, n8.1, …) and rebuilt automatically, so
 *     "latest release" resolves without pinning a URL that goes stale
 *
 * Usage:
 *   node scripts/fetch-ffmpeg.mjs           # fetch if missing or outdated
 *   node scripts/fetch-ffmpeg.mjs --force   # fetch regardless
 *   node scripts/fetch-ffmpeg.mjs --check   # report only, never download
 */

import { execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN_DIR = join(ROOT, 'src-tauri', 'bin')
const VERSION_FILE = join(BIN_DIR, 'VERSION')
const RELEASES = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest'

/** Files taken out of the archive. `ffplay` is dropped: nothing calls it. */
const WANTED_EXES = ['ffmpeg.exe', 'ffprobe.exe']

const args = new Set(process.argv.slice(2))
const force = args.has('--force')
const checkOnly = args.has('--check')

function log(message) {
  process.stdout.write(`  ${message}\n`)
}

/**
 * Picks the newest release-line asset from the rolling `latest` tag.
 *
 * That tag holds one nightly (`master`) plus one build per maintained release
 * line. The nightly is deliberately ignored: a video editor should not ship a
 * different FFmpeg every day.
 */
function chooseAsset(assets) {
  const candidates = assets
    .filter((asset) => /^ffmpeg-n\d+\.\d+-latest-win64-gpl-shared-[\d.]+\.zip$/.test(asset.name))
    .map((asset) => {
      const [, major, minor] = /^ffmpeg-n(\d+)\.(\d+)-latest/.exec(asset.name)
      return { asset, rank: Number(major) * 1000 + Number(minor) }
    })
    .sort((a, b) => b.rank - a.rank)

  if (candidates.length === 0) {
    throw new Error('no release-line win64-gpl-shared build was published under the latest tag')
  }
  return candidates[0].asset
}

async function currentVersion() {
  try {
    return (await readFile(VERSION_FILE, 'utf8')).trim()
  } catch {
    return null
  }
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'snipjoin-build' },
    redirect: 'follow',
  })
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  let seen = 0
  let lastReport = 0

  const progress = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength
      const percent = total > 0 ? Math.floor((seen / total) * 100) : 0
      if (percent >= lastReport + 10) {
        lastReport = percent
        log(`${percent}%`)
      }
      controller.enqueue(chunk)
    },
  })

  await pipeline(response.body.pipeThrough(progress), createWriteStream(destination))
}

/**
 * Extracts the archive.
 *
 * Shelling out to the platform's own unzip keeps the build free of an
 * archive-handling dependency for a step that runs once per release.
 */
function extract(archive, into) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`],
      { stdio: 'inherit' },
    )
    return
  }
  execFileSync('unzip', ['-o', '-q', archive, '-d', into], { stdio: 'inherit' })
}

/** Copies the executables and shared libraries out of the extracted tree. */
async function collect(from, into) {
  const { copyFile } = await import('node:fs/promises')
  const taken = []

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      const isWanted = WANTED_EXES.includes(entry.name) || entry.name.endsWith('.dll')
      if (isWanted) {
        await copyFile(path, join(into, entry.name))
        taken.push(entry.name)
      }
    }
  }

  await walk(from)
  return taken
}

async function main() {
  const response = await fetch(RELEASES, { headers: { 'user-agent': 'snipjoin-build' } })
  if (!response.ok) {
    throw new Error(`could not reach the build index: ${response.status}`)
  }

  const asset = chooseAsset((await response.json()).assets ?? [])
  const wanted = asset.name.replace(/\.zip$/, '')
  const installed = await currentVersion()

  log(`available : ${wanted}`)
  log(`installed : ${installed ?? 'none'}`)

  const haveBinaries = WANTED_EXES.every((name) => existsSync(join(BIN_DIR, name)))

  if (checkOnly) {
    const state = !haveBinaries ? 'missing' : installed === wanted ? 'current' : 'outdated'
    log(`status    : ${state}`)
    process.exit(state === 'current' ? 0 : 1)
  }

  if (!force && haveBinaries && installed === wanted) {
    log('status    : already current, nothing to do')
    return
  }

  const scratch = join(ROOT, 'node_modules', '.ffmpeg-fetch')
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  await mkdir(BIN_DIR, { recursive: true })

  const archive = join(scratch, 'ffmpeg.zip')
  log(`fetching  : ${asset.browser_download_url}`)
  await download(asset.browser_download_url, archive)

  const size = (await stat(archive)).size
  log(`archive   : ${(size / 1024 / 1024).toFixed(1)} MB`)

  extract(archive, scratch)
  const taken = await collect(scratch, BIN_DIR)
  await rm(scratch, { recursive: true, force: true })

  // A build that cannot report its own version is not one to ship.
  const version = execFileSync(join(BIN_DIR, 'ffmpeg.exe'), ['-version'], { encoding: 'utf8' })
    .split('\n')[0]
    .trim()

  await writeFile(VERSION_FILE, `${wanted}\n`, 'utf8')

  log(`extracted : ${taken.length} files`)
  log(`verified  : ${version}`)
}

main().catch((error) => {
  process.stderr.write(`\nfetch-ffmpeg failed: ${error.message}\n`)
  process.exit(1)
})
