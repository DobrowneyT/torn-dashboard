// Torn-key login: verify against the Torn key-info endpoint (24h cached by
// key hash, raw keys never stored), resolve roles from the faction database,
// mint the API-signed 4h session JWT with the established claim shape.
import { TORN_API_COMMENT } from './tornComment.js'
import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import type pg from 'pg'
import { createKeyPool } from './scraper/keyPool.js'

export const ROLES = ['admin', 'leadership', 'warlead', 'ocmanager', 'visitor'] as const
export type Role = (typeof ROLES)[number]

const AUTH_CACHE_TTL_MS = 24 * 60 * 60 * 1000
// Remember-me sessions (#119): the token LIVES 30 days but only ACTS for 24h
// from its last verification — protected surfaces reject older ones, and the
// SPA silently exchanges a stale token via POST /api/auth/refresh, which
// re-checks the member server-side. Login once; kicked members still lose
// access within a day; raw keys never persist in the browser.
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const SESSION_FRESH_SECONDS = 24 * 60 * 60

export interface AuthDeps {
  db: pg.Pool
  tornBaseUrl: string
  jwtSecret: string
  /** When set, member logins enroll their key into the consented pool. */
  keyEncryptionKey?: string
}

export interface SessionClaims extends JWTPayload {
  torn_user_id: string
  faction_id: string
  is_leadership: boolean
  is_admin: boolean
  is_warlead: boolean
  is_ocmanager: boolean
  is_visitor: boolean
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: number; userId: string; roles: Role[] }
  | { ok: false; status: number; error: string }

function sha256hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function fetchRoles(db: pg.Pool, userId: string): Promise<Role[]> {
  const res = await db.query('SELECT role FROM role_assignments WHERE torn_user_id = $1', [userId])
  return res.rows.map((r) => r.role as Role)
}

export async function factionIdentity(db: pg.Pool) {
  const res = await db.query(
    'SELECT slug, display_name, torn_faction_id::text AS torn_faction_id, branding, features FROM faction_config'
  )
  if (res.rows.length === 0) throw new Error('faction_config is empty — run db/new-faction.mjs')
  return res.rows[0] as {
    slug: string
    display_name: string
    torn_faction_id: string
    branding: Record<string, unknown>
    features: Record<string, unknown>
  }
}

/** The roles a session carries, derived from its claim booleans. */
export function rolesFromClaims(claims: SessionClaims): Role[] {
  const map: Record<Role, boolean> = {
    admin: claims.is_admin,
    leadership: claims.is_leadership,
    warlead: claims.is_warlead,
    ocmanager: claims.is_ocmanager,
    visitor: claims.is_visitor,
  }
  return ROLES.filter((r) => map[r])
}

// Torn error codes that mean "try again later", not "bad key" — the same set
// the edge functions treat as transient.
const TRANSIENT_TORN_CODES = new Set([5, 8, 9, 17])
const REQUIRED_KEY_LEVEL = 3 // Limited Access

/** Resolve a Torn API key to a user id: cache first, then the Torn API.
 *  Does NOT write the cache — the caller decides (visitors must leave no trace). */
async function verifyTornKey(deps: AuthDeps, apiKey: string): Promise<
  | { ok: true; userId: string; tornFactionId: string | null; accessLevel: number; hasFactionAccess: boolean; keyHash: string; fromCache: boolean }
  | { ok: false; status: number; error: string }
> {
  const keyHash = sha256hex(apiKey)
  const cached = await deps.db.query(
    'SELECT user_id FROM war_room_auth_cache WHERE key_hash = $1 AND expires_at > now()',
    [keyHash]
  )
  if (cached.rows.length > 0) {
    // Cached hits skip the membership/level re-check until the 24h TTL lapses,
    // mirroring the existing edge-function semantics. (A cache row only exists
    // for a login that already passed the faction-access gate.)
    return { ok: true, userId: cached.rows[0].user_id, tornFactionId: null, accessLevel: REQUIRED_KEY_LEVEL, hasFactionAccess: true, keyHash, fromCache: true }
  }

  let data: any
  try {
    const url = new URL('/v2/key/info', deps.tornBaseUrl)
    url.searchParams.set('key', apiKey)
    url.searchParams.set('comment', TORN_API_COMMENT)
    const resp = await fetch(url)
    if (!resp.ok) return { ok: false, status: 502, error: 'Failed to verify API key' }
    data = await resp.json()
  } catch {
    return { ok: false, status: 502, error: 'Failed to verify API key' }
  }
  if (data.error) {
    if (TRANSIENT_TORN_CODES.has(Number(data.error.code))) {
      return { ok: false, status: 503, error: 'Torn API is temporarily unavailable — please try again shortly' }
    }
    return { ok: false, status: 401, error: `Torn API error: ${data.error.error}` }
  }

  const userId = String(data.info.user.id)
  // faction_id is a flat property on user in /v2/key/info (not nested).
  const tornFactionId = data.info.user.faction_id == null ? null : String(data.info.user.faction_id)
  const accessLevel = Number(data.info.access?.level ?? 0)
  // access.faction is true when the key is permitted to make faction-scoped
  // calls. A key without it passes the level check but returns Torn error 7 on
  // every faction selection, so we gate + record it at login.
  const hasFactionAccess = data.info.access?.faction === true

  return { ok: true, userId, tornFactionId, accessLevel, hasFactionAccess, keyHash, fromCache: false }
}

export async function loginWithTornKey(deps: AuthDeps, apiKey: string): Promise<LoginResult> {
  const verified = await verifyTornKey(deps, apiKey)
  if (!verified.ok) return { ok: false, status: verified.status, error: verified.error }

  const [config, roles] = await Promise.all([
    factionIdentity(deps.db),
    fetchRoles(deps.db, verified.userId),
  ])

  if (verified.accessLevel < REQUIRED_KEY_LEVEL) {
    return {
      ok: false,
      status: 403,
      error: 'This dashboard needs a Limited Access key. Generate one in Torn and log in with it.',
    }
  }

  // Membership: in the faction, or holding any DB-assigned role (visitors and
  // out-of-faction leaders enter through role_assignments, not hardcoded lists).
  // Cache-served logins never reached Torn, so tornFactionId is unknown there —
  // fall back to the roster (cache rows only exist for previously-passed logins).
  const isMember = verified.fromCache
    ? (await deps.db.query(
        'SELECT 1 FROM members WHERE member_id = $1 AND is_current', [verified.userId]
      )).rows.length > 0
    : verified.tornFactionId === config.torn_faction_id
  if (!verified.fromCache && !isMember && roles.length === 0) {
    return { ok: false, status: 403, error: 'Not a faction member' }
  }

  // A member's key joins the pool on login (visitors/out-of-faction never do).
  // Cache-served logins still enroll — a login predating enrollment left only a
  // cache row (see the cache-served enrollment test).
  const enrollsKey = isMember && !roles.includes('visitor')

  // Faction API access is leader-granted (a recruit in their first ~72h can't
  // have it), so we never bar login over it. The key is still enrolled — but
  // with its real has_faction_access value, and the pool excludes
  // has_faction_access = false from faction-scoped claims (see keyPool), so a
  // no-access key can never poison faction scrapers with Torn error 7. Key Pool
  // Health surfaces those keys with a yellow badge (#271).

  // Key-pool enrollment: the login disclosure covers pool consent, so a
  // faction member's key joins the rotation on login (visitors never — their
  // logins persist no key material at all). Best-effort: a failure must
  // never block the login.
  if (deps.keyEncryptionKey && enrollsKey) {
    try {
      const pool = createKeyPool({ db: deps.db, encryptionKey: deps.keyEncryptionKey })
      const meta = {
        keyLevel: verified.accessLevel,
        hasFactionAccess: verified.hasFactionAccess,
        consentVersion: 'login-v1',
      }
      try {
        await pool.store(verified.userId, apiKey, meta)
      } catch (err) {
        // FK onto members: the roster doesn't know them yet. On a brand-new
        // faction that's every member — and members-sync needs a pooled key
        // to fill the roster, so the first login must break that cycle:
        // stub the roster row (members-sync refreshes it) and enroll. Their
        // own in-flight key fetches their real name; fallback is the id.
        if ((err as { code?: string }).code !== '23503') throw err
        let name = `Member ${verified.userId}`
        try {
          const url = new URL('/v2/user/basic', deps.tornBaseUrl)
          url.searchParams.set('key', apiKey)
          url.searchParams.set('comment', TORN_API_COMMENT)
          const basic: any = await (await fetch(url)).json()
          if (typeof basic?.basic?.name === 'string') name = basic.basic.name
        } catch {
          // Torn hiccup — keep the id-based fallback.
        }
        await deps.db.query(
          `INSERT INTO members (member_id, member_name, is_current)
           VALUES ($1, $2, true) ON CONFLICT (member_id) DO NOTHING`,
          [verified.userId, name]
        )
        await pool.store(verified.userId, apiKey, meta)
      }
    } catch {
      // Transient DB issue — the next login retries.
    }
  }

  // Cache the verification — except for visitors, whose logins must persist
  // no key material at all (not even a key-derived hash).
  if (!verified.fromCache && !roles.includes('visitor')) {
    const expiresAt = new Date(Date.now() + AUTH_CACHE_TTL_MS).toISOString()
    await deps.db.query(
      `INSERT INTO war_room_auth_cache (key_hash, user_id, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (key_hash) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at`,
      [verified.keyHash, verified.userId, expiresAt]
    )
  }

  const { token, expiresAt } = await mintSessionToken(deps.jwtSecret, {
    userId: verified.userId,
    factionId: config.torn_faction_id,
    roles,
  })
  return { ok: true, token, expiresAt, userId: verified.userId, roles }
}

/** Mint the session JWT — shared by login and refresh so claims never drift. */
async function mintSessionToken(
  jwtSecret: string,
  { userId, factionId, roles }: { userId: string; factionId: string; roles: Role[] }
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + SESSION_TTL_SECONDS
  const token = await new SignJWT({
    aud: 'authenticated',
    role: 'authenticated',
    torn_user_id: userId,
    faction_id: factionId,
    is_leadership: roles.includes('leadership'),
    is_admin: roles.includes('admin'),
    is_warlead: roles.includes('warlead'),
    is_ocmanager: roles.includes('ocmanager'),
    is_visitor: roles.includes('visitor'),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(`torn-${userId}`)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(jwtSecret))
  return { token, expiresAt }
}

/**
 * Verify a session token. By default a token also has to be FRESH — issued or
 * refreshed within the last 24h — so a long-lived token can't keep acting
 * after its holder was kicked. Only the refresh endpoint passes allowStale
 * (it re-checks membership in the DB before minting a replacement).
 */
export async function verifySessionToken(
  jwtSecret: string,
  token: string,
  { allowStale = false } = {}
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret), {
      audience: 'authenticated',
    })
    const claims = payload as SessionClaims
    if (!allowStale) {
      const now = Math.floor(Date.now() / 1000)
      if (typeof claims.iat !== 'number' || claims.iat + SESSION_FRESH_SECONDS < now) return null
    }
    return claims
  } catch {
    return null
  }
}

export type RefreshResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; status: number; error: string }

/**
 * Exchange a signed, unexpired (possibly stale) token for a fresh one, after
 * re-checking the member server-side: still on the roster, or still holding a
 * DB role (visitors and out-of-faction leaders live there). Roles are re-read,
 * so grants and revocations land within 24h without a re-login. No key
 * material is involved anywhere in this path.
 */
export async function refreshSession(
  deps: Pick<AuthDeps, 'db' | 'jwtSecret'>,
  token: string
): Promise<RefreshResult> {
  const claims = await verifySessionToken(deps.jwtSecret, token, { allowStale: true })
  if (!claims) return { ok: false, status: 401, error: 'Session expired — please log in again' }

  const userId = claims.torn_user_id
  const [config, roles, roster] = await Promise.all([
    factionIdentity(deps.db),
    fetchRoles(deps.db, userId),
    deps.db.query('SELECT 1 FROM members WHERE member_id = $1 AND is_current', [userId]),
  ])
  if (roster.rows.length === 0 && roles.length === 0) {
    return { ok: false, status: 403, error: 'No longer a faction member' }
  }

  const { token: fresh, expiresAt } = await mintSessionToken(deps.jwtSecret, {
    userId,
    factionId: config.torn_faction_id,
    roles,
  })
  return { ok: true, token: fresh, expiresAt }
}
