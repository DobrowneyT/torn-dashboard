// Client for the self-hosted per-faction API (dashboard-migration.md).
// Every deployment talks to /api/* on its own origin — the legacy Supabase
// path was removed at the production cutover (#135).

const TOKEN_STORAGE_KEY = 'apiSession'

/**
 * An API failure carrying more than its sentence.
 *
 * ⚠️ Callers used to have to match on the message to tell "that slot was just
 * taken" (a normal race, refresh and move on) from a real failure, and a
 * structured refusal body — the hours blocking a day-trim, say — was thrown
 * away entirely. `status` and `body` ride along; `message` is unchanged.
 */
function apiError(res, body) {
  const err = new Error(body?.error ?? `API error ${res.status}`)
  err.status = res.status
  err.body = body
  return err
}

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

/**
 * Authorized request returning the raw Response.
 *
 * The JSON helpers below consume the body; a CSV export (#517) must NOT — it
 * streams hundreds of thousands of rows and reads them chunk by chunk. Exposed
 * so that path still gets the shared 401-refresh-and-retry behaviour rather
 * than reimplementing it with a bare fetch.
 */
export function apiFetch(path, init) {
  return authorizedFetch(path, init)
}

/** Authorized GET against the faction API. Throws with the server's error message. */
export async function apiGet(path) {
  const res = await authorizedFetch(path)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw apiError(res, body)
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
  if (!res.ok) throw apiError(res, body)
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
  if (!res.ok) throw apiError(res, body)
  return body
}

/** Authorized DELETE against the faction API. Throws with the server's error message. */
export async function apiDelete(path, payload) {
  const res = await authorizedFetch(path, {
    method: 'DELETE',
    ...(payload !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw apiError(res, body)
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
