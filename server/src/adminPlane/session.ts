/**
 * Admin sessions (#609 slice 2).
 *
 * ⚠️ **A SEPARATE secret from the tenant `JWT_SECRET`, and this is not
 * housekeeping.** Every tenant API is handed `JWT_SECRET` through compose. If
 * the control plane shared it, any tenant admin's session token — or anyone who
 * compromised any single tenant container — would hold a valid fleet
 * credential. The whole point of this box is that it is harder to reach than a
 * tenant; sharing the secret would silently make it exactly as easy.
 *
 * The audience claim is a second, independent guard: even given the same
 * secret, a tenant token would fail verification here because it was not minted
 * for this audience.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'

export const ADMIN_AUDIENCE = 'tnl-admin-plane'
export const ADMIN_ISSUER = 'tnl-admin'

/** Eight hours: long enough for an operator's session, short enough that a
 *  stolen token expires the same day. */
export const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60

export interface AdminClaims extends JWTPayload {
  sub: string
  /** Which surface minted this. A token minted on the local (tunnel-only)
   *  listener must not become a public-surface credential. */
  surface: 'public' | 'local'
}

export async function mintAdminSession(
  secret: string,
  username: string,
  surface: 'public' | 'local',
  ttlSeconds = ADMIN_SESSION_TTL_SECONDS
): Promise<string> {
  return new SignJWT({ surface })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(username)
    .setIssuer(ADMIN_ISSUER)
    .setAudience(ADMIN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret))
}

/** Verify a token, or null. Never throws — a bad token is an expected input. */
export async function verifyAdminSession(
  secret: string,
  token: string
): Promise<AdminClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: ADMIN_ISSUER,
      audience: ADMIN_AUDIENCE,
    })
    const claims = payload as AdminClaims
    if (typeof claims.sub !== 'string' || !claims.sub) return null
    if (claims.surface !== 'public' && claims.surface !== 'local') return null
    return claims
  } catch {
    return null
  }
}
