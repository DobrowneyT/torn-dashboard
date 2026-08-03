// Client for the self-hosted per-faction API (dashboard-migration.md).
//
// API mode is baked at build time: the docker/nginx build sets
// VITE_API_MODE=true, so the same bundle served by the new stack talks to
// /api/* on its own origin. GitHub Pages / local `npm run dev` builds leave
// the flag unset and keep the Supabase path untouched.
export const API_MODE = import.meta.env.VITE_API_MODE === 'true'

const TOKEN_STORAGE_KEY = 'apiSession'

export function getApiSession() {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY)
    if (!raw) return null
    const session = JSON.parse(raw)
    if (!session.token || !session.expires_at) return null
    return session
  } catch {
    return null
  }
}

export function storeApiSession(session) {
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(session))
}

export function clearApiSession() {
  localStorage.removeItem(TOKEN_STORAGE_KEY)
}

/** True while the stored session token is still comfortably valid. */
export function apiSessionValid(session = getApiSession()) {
  return !!session && session.expires_at * 1000 > Date.now() + 60_000
}

/** POST /api/auth/login → { token, expires_at } | { error } */
export async function apiLogin(apiKey) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, status: res.status, error: body.error ?? `Login failed (${res.status})` }
  return { ok: true, ...body }
}

/**
 * Silent session renewal (#119). Sessions live 30 days but only act for 24h
 * from their last verification; this swaps the stored token for a fresh one
 * (the server re-checks roster/roles — kicked members get a 403 here).
 * `transient: true` marks network failures, which callers must NOT treat as
 * a revoked session.
 */
export async function apiRefresh() {
  const session = getApiSession()
  if (!session) return { ok: false, status: 401, error: 'No session' }
  let res
  try {
    res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
    })
  } catch {
    return { ok: false, transient: true, error: 'Network error during session refresh' }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, status: res.status, error: body.error ?? `Refresh failed (${res.status})` }
  storeApiSession({ token: body.token, expires_at: body.expires_at })
  return { ok: true, ...body }
}

// One shared request path: on a 401 (the 24h freshness gate), silently refresh
// once and retry, so an open tab never bounces the user to the login screen
// while their 30-day session is still good.
async function authorizedFetch(path, init = {}) {
  const attempt = () => {
    const session = getApiSession()
    return fetch(path, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(session ? { authorization: `Bearer ${session.token}` } : {}),
      },
    })
  }
  let res = await attempt()
  if (res.status === 401 && (await apiRefresh()).ok) res = await attempt()
  return res
}

/** Authorized GET against the faction API. Throws with the server's error message. */
export async function apiGet(path) {
  const res = await authorizedFetch(path)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `API error ${res.status}`)
  }
  return res.json()
}

/** Authorized POST against the faction API. Throws with the server's error message. */
export async function apiPost(path, payload) {
  const res = await authorizedFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `API error ${res.status}`)
  return body
}

/** Authorized PUT against the faction API. Throws with the server's error message. */
export async function apiPut(path, payload) {
  const res = await authorizedFetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `API error ${res.status}`)
  return body
}

/** Authorized DELETE against the faction API. Throws with the server's error message. */
export async function apiDelete(path) {
  const res = await authorizedFetch(path, { method: 'DELETE' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `API error ${res.status}`)
  return body
}

/** GET /api/bootstrap — faction identity + (when authed) the caller's roles. */
export async function apiBootstrap(token = getApiSession()?.token) {
  const res = await fetch('/api/bootstrap', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) return { ok: false, status: res.status }
  return { ok: true, ...(await res.json()) }
}
