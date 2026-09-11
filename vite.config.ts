import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const host = process.env['TAURI_DEV_HOST']

const read = (path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as {
    version: string
  }

// The version the window shows is the one the bundle carries, so it cannot
// disagree with the installer. Two files declare it and nothing else keeps them
// in step, so the build refuses rather than shipping a window labelled 1.0.0
// from an installer labelled 1.1.0.
const appVersion = read('./src-tauri/tauri.conf.json').version
const packageVersion = read('./package.json').version
if (appVersion !== packageVersion) {
  throw new Error(
    `version mismatch: tauri.conf.json says ${appVersion}, package.json says ${packageVersion}`,
  )
}

// Vite is the renderer-side bundler only; the Rust side is built by the Tauri CLI.
export default defineConfig({
  plugins: [react(), tailwindcss()],

  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },

  resolve: {
    alias: {
      '@domain': fileURLToPath(new URL('./src/domain', import.meta.url)),
      '@application': fileURLToPath(new URL('./src/application', import.meta.url)),
      '@infrastructure': fileURLToPath(new URL('./src/infrastructure', import.meta.url)),
      '@presentation': fileURLToPath(new URL('./src/presentation', import.meta.url)),
    },
  },

  // Tauri expects a fixed port and fails the build rather than silently moving on.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // The Rust crate has its own watcher; watching it here would thrash the dev server.
      ignored: ['**/src-tauri/**'],
    },
  },

  build: {
    rollupOptions: {
      // The splash is a second page rather than a React route: it has to be on
      // screen before the editor's bundle has finished parsing, which a route
      // inside that bundle cannot be.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        splash: fileURLToPath(new URL('./splash.html', import.meta.url)),
      },
    },

    // WebView2 on Windows tracks Chromium, so we can target a modern baseline.
    target: 'esnext',
    minify: process.env['TAURI_ENV_DEBUG'] ? false : 'esbuild',
    sourcemap: !!process.env['TAURI_ENV_DEBUG'],
    chunkSizeWarningLimit: 1200,
  },
})
