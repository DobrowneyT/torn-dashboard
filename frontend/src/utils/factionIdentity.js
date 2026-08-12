// Faction identity for the SPA. It comes from /api/bootstrap (faction_config —
// per tenant, editable in Leadership → Settings); the config.js strings are the
// pre-bootstrap fallback only.
//
// AuthContext awaits loadFactionIdentity() during its initial loading gate,
// so by the time any view renders the synchronous getters are safe.
import { useEffect, useState } from 'react'
import { config } from '../config'
import { apiBootstrap } from './apiClient'

const fallback = {
  id: String(config.faction.id),
  name: config.faction.name,
  tag: config.faction.tag,
  displayName: config.faction.name,
  // No slug: the fallback is Forge's identity, and labelling another tenant's
  // bug report "forge" would send triage to the wrong deployment. Absent beats
  // wrong — callers gate on isFactionIdentityResolved() (#394).
  slug: '',
  branding: {},
}

let cached = null
let inflight = null

export async function loadFactionIdentity() {
  if (cached) return cached
  inflight ??= apiBootstrap(null)
    .then((boot) => {
      if (boot.ok && boot.faction) {
        cached = {
          id: String(boot.faction.torn_faction_id ?? ''),
          name: boot.faction.display_name,
          tag: boot.faction.branding?.tag || (boot.faction.slug || '').toUpperCase(),
          displayName: boot.faction.display_name,
          // The tenant slug, which the bootstrap has always sent but we only
          // consumed to derive `tag`. It is what identifies WHICH of the five
          // deployments a bug report came from (#394).
          slug: boot.faction.slug || '',
          branding: boot.faction.branding || {},
          // Distinguishes a genuine per-tenant bootstrap from `fallback`
          // (not-yet-loaded / bootstrap failure) — see apiKeyTitleFor.
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

/**
 * Synchronous access — valid once the auth loading gate has passed.
 *
 * ⚠️ Never capture the result at MODULE SCOPE. This is the #393 trap, and it
 * has now cost two production bugs (#249, then #393) with the same symptom.
 *
 * The fallback below is Forge's id. That makes an early read *silently correct
 * on Forge and silently wrong on every other tenant* — the worst possible
 * failure shape, because the faction we develop and test against is the one
 * that cannot reveal it. #249 replaced the hardcoded literals with calls to
 * this function; two of those calls landed at module scope, where they
 * returned the fallback, which was the same literal. The bug was relocated,
 * not removed.
 *
 * Read it inside a component, a hook, or a function body — anywhere that runs
 * after the auth gate. It is a cached property read, so per-use is free.
 */
export function getFactionIdentity() {
  // Dev-only: surface a read that happened before bootstrap resolved. Stripped
  // from production builds, and deliberately a warning rather than a throw —
  // the fallback legitimately serves the login screen and the API-key title
  // during the loading gate, so failing hard here would blank the app.
  if (import.meta.env?.DEV && cached === null) {
    console.warn(
      '[factionIdentity] read before /api/bootstrap resolved — falling back to ' +
      `faction ${fallback.id} (Forge). If this value is being stored, it will be ` +
      'wrong for every other tenant. Read identity at use time, not at module scope. (#393)'
    )
  }
  return cached ?? fallback
}

/**
 * Has identity genuinely resolved for this tenant?
 *
 * For call sites that would rather show nothing than show Forge's data. The
 * `resolved` flag distinguishes a real bootstrap from the fallback.
 */
export function isFactionIdentityResolved() {
  return cached?.resolved === true
}

/** Our Torn faction id as a number (bigint columns compare numerically). */
export function getFactionId() {
  return Number(getFactionIdentity().id)
}

// Torn API key title/comment (#131): brand it with the tenant's own faction
// once identity has genuinely resolved from the bootstrap; the static
// config.apiKey.title is only correct as a pre-load fallback.
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

// The header logo (#178). Unlike the favicon there is no shared default — an
// unset logo renders nothing (the header falls back to the text title alone),
// so this returns null rather than a placeholder. A served `/api/branding/logo`
// path or an external URL both work as an <img src>.
export function logoSrcFor(identity) {
  return identity.branding?.logo || null
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
