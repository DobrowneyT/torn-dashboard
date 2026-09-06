/**
 * Operator password hashing for the admin control plane (#609 slice 2).
 *
 * ⚠️ **`scrypt` from `node:crypto`, deliberately — not the `sha256hex` helper
 * already in `auth.ts`.** That one exists to fingerprint Torn API keys, where a
 * fast hash is the right tool. Reusing it for a password would be the classic
 * mistake: a fast hash makes offline brute force cheap, and this is the one
 * credential in the fleet whose compromise reaches every tenant.
 *
 * Why scrypt rather than argon2id, which is the modern first choice: argon2
 * needs a native build, and this container is the highest-value target in the
 * stack — every native dependency is another supply-chain surface and another
 * thing that can fail to compile on Alpine. scrypt is a memory-hard KDF built
 * into Node with no dependency at all, and at the parameters below it is
 * squarely inside OWASP's accepted range. The trade is deliberate.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer, salt: string | Buffer, keylen: number, options: object
) => Promise<Buffer>

/**
 * Work factors. N=2^17 with r=8 needs ~128 MiB per hash.
 *
 * ⚠️ `maxmem` must be raised alongside N. Node's default ceiling is 32 MiB, so
 * without this every hash throws `memory limit exceeded` — and it would throw
 * at *login*, long after the code looked fine in review.
 */
const PARAMS = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }
const KEYLEN = 32
const SALT_BYTES = 16

/**
 * Hash a password into a self-describing string.
 *
 * Format: `scrypt$N$r$p$salt_b64$hash_b64`. The parameters travel WITH the hash
 * so raising the work factor later does not invalidate every existing
 * credential — an old hash still verifies against the parameters it was made
 * with, which is what makes the upgrade path exist at all.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await scrypt(password, salt, KEYLEN, PARAMS)
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

/**
 * Verify a password against a stored hash.
 *
 * ⚠️ Constant-time comparison, and it returns `false` rather than throwing on a
 * malformed stored hash. A throw here would leak the difference between "bad
 * password" and "corrupt credential" through timing and error handling, and
 * would turn a mis-set environment variable into a 500 instead of a refusal.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const [, n, r, p, saltB64, hashB64] = parts
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    if (salt.length === 0 || expected.length === 0) return false

    const actual = await scrypt(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem,
    })
    // Lengths are equal by construction above, but timingSafeEqual throws on a
    // mismatch, so the guard stays.
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** Is this a hash this module produced? Used to reject a plaintext env value. */
export function looksHashed(value: string): boolean {
  return /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(value)
}
