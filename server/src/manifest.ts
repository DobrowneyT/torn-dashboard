// Per-tenant PWA manifest (follow-up to #206). The static manifest baked into
// the SPA branded every tenant as "TNL Forge"; now each faction API serves its
// own manifest from its identity, so an installed app shows the tenant's name
// and — when a logo is set — the tenant's icon. nginx Host-routing means
// `<host>/api/manifest.webmanifest` hits that host's faction API.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { factionIdentity } from './auth.js'

// Neutral default tile shipped with the SPA (frontend/public/icons). Used by any
// tenant that hasn't uploaded a logo.
const DEFAULT_ICONS = [
  { src: '/icons/pwa-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/pwa-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
]
const DEFAULT_THEME = '#0f172a'

function shortNameFor(name: string, branding: Record<string, unknown>): string {
  const tag = branding?.tag
  if (typeof tag === 'string' && tag.trim()) return tag.trim().slice(0, 12)
  return (name || 'Dashboard').split(/\s+/)[0].slice(0, 12)
}

/**
 * Build the manifest object for a faction identity. Pure — unit-testable.
 * When the tenant has a `branding.logo`, we point the icons at it (declaring the
 * standard sizes so installers use it; the browser scales the actual image);
 * otherwise we fall back to the shared default tile.
 */
export function buildManifest(identity: {
  display_name: string
  branding?: Record<string, unknown> | null
}): Record<string, unknown> {
  const name = identity.display_name || 'Faction Dashboard'
  const branding = identity.branding || {}
  const logo = typeof branding.logo === 'string' && branding.logo ? branding.logo : null

  const icons = logo
    ? [
        { src: logo, sizes: '192x192', purpose: 'any' },
        { src: logo, sizes: '512x512', purpose: 'any' },
        { src: logo, sizes: '512x512', purpose: 'maskable' },
      ]
    : DEFAULT_ICONS

  const themeColor = typeof branding.theme_color === 'string' && branding.theme_color
    ? branding.theme_color
    : DEFAULT_THEME

  return {
    name,
    short_name: shortNameFor(name, branding),
    description: `${name} — faction management for Torn.`,
    id: '/',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: DEFAULT_THEME,
    theme_color: themeColor,
    icons,
  }
}

export function registerManifestRoute(app: FastifyInstance, db: pg.Pool) {
  // PUBLIC — the browser fetches the manifest with no Authorization header.
  app.get('/api/manifest.webmanifest', async (_req, reply) => {
    const identity = await factionIdentity(db)
    reply.header('Content-Type', 'application/manifest+json')
    reply.header('Cache-Control', 'public, max-age=300')
    return buildManifest(identity)
  })
}
