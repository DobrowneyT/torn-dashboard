// Torn-key login: verify against the Torn key-info endpoint (24h cached by
// key hash, raw keys never stored), resolve roles from the faction database,
// mint the API-signed 4h session JWT with the established claim shape.
import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import type pg from 'pg'
import { createKeyPool } from './scraper/keyPool.js'

export const ROLES = ['admin', 'leadership', 'warlead', 'ocmanager', 'visitor'] as const
export type Role = (typeof ROLES)[number]

const AUTH_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SESSION_TTL_SECONDS = 4 * 60 * 60

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
  | { ok: true; userId: string; tornFactionId: string | null; accessLevel: number; keyHash: string; fromCache: boolean }
  | { ok: false; status: number; error: string }
> {
  const keyHash = sha256hex(apiKey)
  const cached = await deps.db.query(
    'SELECT user_id FROM war_room_auth_cache WHERE key_hash = $1 AND expires_at > now()',
    [keyHash]
  )
  if (cached.rows.length > 0) {
    // Cached hits skip the membership/level re-check until the 24h TTL lapses,
    // mirroring the existing edge-function semantics.
    return { ok: true, userId: cached.rows[0].user_id, tornFactionId: null, accessLevel: REQUIRED_KEY_LEVEL, keyHash, fromCache: true }
  }

  let data: any
  try {
    const url = new URL('/v2/key/info', deps.tornBaseUrl)
    url.searchParams.set('key', apiKey)
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

  return { ok: true, userId, tornFactionId, accessLevel, keyHash, fromCache: false }
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
  const isMember = verified.tornFactionId === config.torn_faction_id
  if (!verified.fromCache && !isMember && roles.length === 0) {
    return { ok: false, status: 403, error: 'Not a faction member' }
  }

  // Key-pool enrollment: the login disclosure covers pool consent, so a
  // faction member's key joins the rotation on login (visitors never — their
  // logins persist no key material at all). Best-effort: a missing roster
  // row (fresh DB) or any other failure must never block the login.
  if (deps.keyEncryptionKey && isMember && !roles.includes('visitor')) {
    try {
      const pool = createKeyPool({ db: deps.db, encryptionKey: deps.keyEncryptionKey })
      await pool.store(verified.userId, apiKey, {
        keyLevel: verified.accessLevel,
        hasFactionAccess: true,
        consentVersion: 'login-v1',
      })
    } catch {
      // FK onto members (roster not synced yet) or transient DB issue.
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

  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + SESSION_TTL_SECONDS
  const token = await new SignJWT({
    aud: 'authenticated',
    role: 'authenticated',
    torn_user_id: verified.userId,
    faction_id: config.torn_faction_id,
    is_leadership: roles.includes('leadership'),
    is_admin: roles.includes('admin'),
    is_warlead: roles.includes('warlead'),
    is_ocmanager: roles.includes('ocmanager'),
    is_visitor: roles.includes('visitor'),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(`torn-${verified.userId}`)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(deps.jwtSecret))

  return { ok: true, token, expiresAt, userId: verified.userId, roles }
}

export async function verifySessionToken(jwtSecret: string, token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret), {
      audience: 'authenticated',
    })
    return payload as SessionClaims
  } catch {
    return null
  }
}
