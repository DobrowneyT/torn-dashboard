// Faction identity for the SPA. In API mode it comes from /api/bootstrap
// (faction_config — per tenant, editable in Leadership → Settings); the
// config.js strings are the legacy Supabase-mode fallback only.
//
// AuthContext awaits loadFactionIdentity() during its initial loading gate,
// so by the time any view renders the synchronous getters are safe.
import { useEffect, useState } from 'react'
import { config } from '../config'
import { API_MODE, apiBootstrap } from './apiClient'

const fallback = {
  id: String(config.faction.id),
  name: config.faction.name,
  tag: config.faction.tag,
  displayName: config.faction.name,
  branding: {},
}

let cached = null
let inflight = null

export async function loadFactionIdentity() {
  if (!API_MODE) return fallback
  if (cached) return cached
  inflight ??= apiBootstrap(null)
    .then((boot) => {
      if (boot.ok && boot.faction) {
        cached = {
          id: String(boot.faction.torn_faction_id ?? ''),
          name: boot.faction.display_name,
          tag: boot.faction.branding?.tag || (boot.faction.slug || '').toUpperCase(),
          displayName: boot.faction.display_name,
          branding: boot.faction.branding || {},
          // Distinguishes a genuine per-tenant bootstrap from `fallback`
          // (legacy Supabase-mode / not-yet-loaded) — see apiKeyTitleFor.
          resolved: true,
        }
      } else {
        cached = fallback
      }
      return cached
    })
    .catch(() => (cached = fallback))
  return inflight
}

/** Synchronous access — valid once the auth loading gate has passed. */
export function getFactionIdentity() {
  return cached ?? fallback
}

/** Our Torn faction id as a number (bigint columns compare numerically). */
export function getFactionId() {
  return Number(getFactionIdentity().id)
}

// Torn API key title/comment (#131): brand it with the tenant's own faction
// once identity has genuinely resolved from the API-mode bootstrap; the
// static config.apiKey.title is only correct as a legacy-mode / pre-load
// fallback (main's Forge-only Supabase site).
export function apiKeyTitleFor(identity) {
  return identity.resolved ? `${identity.displayName}-Dashboard` : config.apiKey.title
}

export function getApiKeyTitle() {
  return apiKeyTitleFor(getFactionIdentity())
}

// Shared default favicon (frontend/public/torn-dashboard-favicon.ico), used
// by every tenant that hasn't set its own via Leadership -> Settings ->
// branding.favicon (already editable there; this is what applies it).
export const DEFAULT_FAVICON = '/torn-dashboard-favicon.ico'

export function faviconHrefFor(identity) {
  return identity.branding?.favicon || DEFAULT_FAVICON
}

export function useFactionIdentity() {
  const [identity, setIdentity] = useState(getFactionIdentity())
  useEffect(() => {
    let on = true
    loadFactionIdentity().then((i) => { if (on) setIdentity(i) })
    return () => { on = false }
  }, [])
  return identity
}
