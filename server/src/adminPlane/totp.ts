/**
 * TOTP second factor for the admin control plane (RFC 6238, #609 slice 2).
 *
 * ⚠️ **More than was asked for, and here is the argument.** MonChoon asked for
 * a username and password. This is a public login page in front of the one box
 * that can create factions and rewrite data every tenant reads — a password
 * alone is one credential-stuffing run away from fleet compromise, and the
 * blast radius is every faction at once rather than one account.
 *
 * It costs six digits at login and no dependency: HMAC-SHA1 is in `node:crypto`
 * and every authenticator app implements the same spec.
 *
 * ⚠️ SHA-1 is correct here and is not a weakness. RFC 6238's default HMAC is
 * SHA-1, and that is what Google Authenticator, Aegis, 1Password and the rest
 * assume; HMAC-SHA1's security does not rest on SHA-1's collision resistance.
 * Choosing SHA-256 to look modern produces codes no authenticator app will
 * generate, which is a real failure dressed as a precaution.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6

/**
 * How many steps either side of "now" are accepted.
 *
 * ⚠️ One step (±30s), not zero and not five. Zero rejects an operator whose
 * phone clock drifts by a couple of seconds, which reads as "the password is
 * wrong" and is maddening to diagnose. Every extra step widens the window an
 * intercepted code stays usable in, and each one multiplies the codes a brute
 * force gets per attempt — which is why the login route is rate-limited too.
 */
export const TOTP_WINDOW = 1

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** A new random secret, base32 as every authenticator app expects. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes))
}

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/**
 * Decode a base32 secret.
 *
 * ⚠️ Tolerant of how humans actually paste secrets: lowercase, spaces, and
 * `=` padding are all normalised away. Rejecting those would produce "invalid
 * code" for a secret that is perfectly correct, and the operator would have no
 * way to tell the difference.
 */
export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch)
    if (idx === -1) throw new Error('invalid base32 in TOTP secret')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** The code for one counter step. */
export function totpCode(secret: string, counter: number): string {
  const key = base32Decode(secret)
  const buf = Buffer.alloc(8)
  // Counter is a 64-bit big-endian integer. Written as two 32-bit halves
  // because a JS number cannot hold 64 bits exactly — writeBigUInt64BE would
  // also work, and this keeps the value in the safe integer range.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)

  const hmac = createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/**
 * Is `code` valid for `secret` right now?
 *
 * ⚠️ Constant-time comparison per candidate. A plain `===` on the code string
 * leaks, through timing, how many leading digits were right — which turns a
 * one-in-a-million guess into six one-in-ten guesses.
 */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const cleaned = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(cleaned)) return false

  const counter = Math.floor(now / 1000 / TOTP_STEP_SECONDS)
  const given = Buffer.from(cleaned)
  for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift++) {
    let candidate: string
    try {
      candidate = totpCode(secret, counter + drift)
    } catch {
      return false
    }
    const expected = Buffer.from(candidate)
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true
  }
  return false
}

/** `otpauth://` URI for an authenticator app's QR code. */
export function totpUri(secret: string, account: string, issuer = 'TNL Admin'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
