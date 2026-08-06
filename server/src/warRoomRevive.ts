// Revive-request payload shaping and outbound-target validation (#308).
//
// Pure helpers, separated from the route in warRoomWrites.ts so the payload
// contract each revive service expects is readable in one place — the shapes
// are dictated by third parties (UHC/WTF/Nuke) and are easy to break silently.
//
// Ported from the retired Supabase edge function `war-room-fetch`
// (`revive_request`), whose sendJsonRequest / sendNukeRequest / resolveUserCountry
// this mirrors.

/**
 * Torn hospital-description adjectives → the title-cased country names Nuke
 * expects. Anything unmatched is "Torn" (the standard hospital, and the
 * not-in-state case). Kept in sync with the frontend copy in
 * frontend/src/utils/warRoomApiV2.js.
 */
const HOSPITAL_COUNTRY_ADJECTIVES: Array<[RegExp, string]> = [
  [/\bMexican\b/i, 'Mexico'],
  [/\bCaymanian\b/i, 'Cayman Islands'],
  [/\bCanadian\b/i, 'Canada'],
  [/\bHawaiian\b/i, 'Hawaii'],
  [/\bBritish\b/i, 'United Kingdom'],
  [/\bArgentinian\b/i, 'Argentina'],
  [/\bSwiss\b/i, 'Switzerland'],
  [/\bJapanese\b/i, 'Japan'],
  [/\bChinese\b/i, 'China'],
  [/\bEmirati\b/i, 'UAE'],
  [/\bSouth African\b/i, 'South Africa'],
]

export function resolveCountryFromDescription(description: string | null | undefined): string {
  if (!description) return 'Torn'
  for (const [pattern, country] of HOSPITAL_COUNTRY_ADJECTIVES) {
    if (pattern.test(description)) return country
  }
  return 'Torn'
}

export interface ReviveIdentity {
  userID: number
  userName: string
  factionName: string
}

/**
 * UHC/WTF body. Services disagree on the key naming the requesting channel —
 * UHC reads `source`, WTF reads `requestChannel` — so the leader picks it
 * per-service in Manage Services and it arrives as `sourceKey`.
 */
export function buildJsonPayload(
  { userID, userName, factionName }: ReviveIdentity,
  { source, sourceKey }: { source?: string; sourceKey?: string }
): Record<string, unknown> {
  const key = (typeof sourceKey === 'string' && sourceKey.trim()) || 'source'
  return { userID, userName, factionName, [key]: source ?? '' }
}

/**
 * Nuke form fields. Mirrors the Tampermonkey userscript exactly:
 * `torn_player_name` is "Name [id]", and `app_info` labels us in their logs.
 */
export function buildNukeFields(
  { userID, userName }: ReviveIdentity,
  { source, country }: { source?: string; country: string }
): Record<string, string> {
  return {
    torn_player_id: String(userID),
    torn_player_name: userName ? `${userName} [${userID}]` : String(userID),
    torn_player_country: country || 'Torn',
    app_info: source || 'TNL War Room',
  }
}

const PRIVATE_V4 = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
]

/**
 * Is this hostname inside the trust boundary?
 *
 * Literal-address check only — it does NOT resolve DNS, so a hostname pointing
 * at a private address still passes. That is a deliberate limit: full
 * protection needs resolve-then-pin-the-socket, which fetch() will not give us.
 * This blocks the direct, obvious reach (and a copy-pasted internal URL);
 * treat it as defence in depth, not a complete SSRF control.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true
  if (host.startsWith('::ffff:')) return isPrivateHost(host.slice('::ffff:'.length))
  return PRIVATE_V4.some((re) => re.test(host))
}

export interface TargetCheck {
  ok: boolean
  /** Operator-facing reason; safe to return to the caller. */
  error?: string
  url?: URL
}

/**
 * Validate a client-supplied revive-service URL before the server opens a
 * connection to it.
 *
 * This endpoint is a *client-controlled outbound request* running inside the
 * compose network, next to Postgres and every tenant's API — so an unchecked
 * `url` is a reachability primitive into the private network. Hence the scheme
 * allow-list and the private-address refusal.
 *
 * WAR_ROOM_REVIVE_ALLOW_PRIVATE_HOSTS=1 opens the private check for tests (the
 * fake service runs on loopback). Never set it in production.
 */
export function checkReviveTarget(raw: unknown): TargetCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'url required' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'url must be a valid absolute URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'url must be http(s)' }
  }
  if (process.env.WAR_ROOM_REVIVE_ALLOW_PRIVATE_HOSTS !== '1' && isPrivateHost(url.hostname)) {
    return { ok: false, error: 'url must be a public revive service' }
  }
  return { ok: true, url }
}
