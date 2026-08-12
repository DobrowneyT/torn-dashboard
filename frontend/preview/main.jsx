// Header layout preview — see vite.preview.config.js.
//
// Renders the REAL Header at three widths so spacing can be judged without
// deploying. Built to choose the version chip's placement (#394); kept because
// the alternative is a PR-and-look loop for every header tweak.
import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../src/contexts/ThemeContext'
import Header from '../src/components/Header'
import '../src/index.css'

// Answer /api/bootstrap locally so faction identity resolves to a real-looking
// tenant (and therefore a real slug) with no backend running. Everything else
// falls through to the network and fails harmlessly.
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? '')
  if (url.includes('/api/bootstrap')) {
    return new Response(JSON.stringify({
      ok: true,
      faction: {
        torn_faction_id: 6731,
        display_name: 'TNL Forge',
        slug: 'tnl',
        branding: { tag: 'TNL' },
      },
    }), { headers: { 'content-type': 'application/json' } })
  }
  return realFetch(input, init)
}

function Frame({ label, width, children }) {
  return (
    <div style={{ marginBottom: '2rem' }}>
      <p className="px-3 py-1 text-xs font-mono text-gray-500 dark:text-gray-400">{label}</p>
      <div style={{ width, maxWidth: '100%', border: '1px dashed #94a3b8', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

function Preview() {
  // Toggle a fake newer version to inspect the stale (amber) state without
  // waiting for a real deploy.
  const [stale, setStale] = useState(false)
  const serving = stale ? '9.9.9' : null

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 p-6">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold mb-1 text-gray-900 dark:text-gray-100">
          Header layout preview
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          The real <code>Header</code> component. Auth is stubbed; nothing else is.
        </p>

        <label className="inline-flex items-center gap-2 mb-8 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={stale} onChange={(e) => setStale(e.target.checked)} />
          Simulate a newer version being deployed (amber state)
        </label>

        <Frame label="desktop" width="100%">
          <Header servingVersion={serving} canViewAs />
        </Frame>

        <Frame label="tablet — 768px" width="768px">
          <Header servingVersion={serving} canViewAs />
        </Frame>

        <Frame label="phone — 390px. The chip hides below sm; it lives in the ☰ menu instead." width="390px">
          <Header servingVersion={serving} canViewAs />
        </Frame>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MemoryRouter>
      <ThemeProvider>
        <Preview />
      </ThemeProvider>
    </MemoryRouter>
  </React.StrictMode>,
)
