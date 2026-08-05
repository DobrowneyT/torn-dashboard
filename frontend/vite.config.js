import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// App version — single source of truth is the repo-root VERSION file. Read it at
// build time and expose as VITE_APP_VERSION so the footer matches /api/health and
// the changelog. Both the GitHub Pages build and the self-hosted container build
// (deploy/nginx.Dockerfile copies VERSION into the build context) pick it up this
// way; an explicit VITE_APP_VERSION in the env still wins for one-off overrides.
function appVersion() {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const v = readFileSync(resolve(here, '..', 'VERSION'), 'utf8').trim()
    if (v) return v
  } catch {
    // fall through to the safe default
  }
  return '0.0.0'
}

export default defineConfig({
  plugins: [react()],
  // Self-hosted stack serves the SPA at the domain root behind nginx.
  base: '/',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion()),
  },
  build: {
    outDir: 'dist',
  },
  server: {
    port: 3000,
    open: true,
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
