import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const host = process.env['TAURI_DEV_HOST']

// Vite is the renderer-side bundler only; the Rust side is built by the Tauri CLI.
export default defineConfig({
  plugins: [react(), tailwindcss()],

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
    // WebView2 on Windows tracks Chromium, so we can target a modern baseline.
    target: 'esnext',
    minify: process.env['TAURI_ENV_DEBUG'] ? false : 'esbuild',
    sourcemap: !!process.env['TAURI_ENV_DEBUG'],
    chunkSizeWarningLimit: 1200,
  },
})
