// Header layout preview (#394 follow-up).
//
// Renders the REAL Header component — not a copy — so what you see cannot drift
// from what ships. The only substitution is auth: `useAuth` is aliased to a stub
// so the header renders without a session or a backend.
//
//   npm run preview:header      → http://localhost:3001/preview/
//
// Nothing here is part of the production build: `npm run build` still uses
// vite.config.js and never sees this file or the preview/ directory.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

function appVersion() {
  try {
    return readFileSync(resolve(here, '..', 'VERSION'), 'utf8').trim() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Matches the `../contexts/AuthContext` / `./contexts/AuthContext`
      // specifiers used across the app. The stub deliberately does not import
      // the real module, so there is no cycle.
      { find: /(?:\.\.?\/)+contexts\/AuthContext$/, replacement: resolve(here, 'preview/stubs/AuthContext.jsx') },
    ],
  },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion()),
  },
  server: {
    port: 3001,
    open: '/preview/',
  },
})
