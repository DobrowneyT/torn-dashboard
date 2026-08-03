// Consented key pool over the per-faction member_secrets table. Keys are
// AES-256-GCM encrypted at rest with a server-held secret and never leave
// the server process; the pool only ever reads the faction's own database
// (it is constructed with that DB's pool and nothing else).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type pg from 'pg'

export interface KeyPoolOptions {
  db: pg.Pool
  /** 32-byte hex string (server env), used for AES-256-GCM. */
  encryptionKey: string
}

export interface ClaimedKey {
  member_id: string
  key: string
}

export interface KeyMeta {
  keyLevel?: number
  consentVersion?: string
  memberRank?: string
  hasFactionAccess?: boolean
}

/** Shown whenever a server-side Torn call finds no consented key to claim. */
export const EMPTY_POOL_MESSAGE =
  'No pooled Torn key available yet — a faction member logging in enrolls ' +
  'their key (then run members-sync from Global Admin to fill the roster).'

/**
 * One-shot claim for request-scoped server-side Torn calls (#98): returns
 * null when the pool is unconfigured (no at-rest secret) or empty.
 */
export async function claimPooledKey(
  db: pg.Pool,
  encryptionKey?: string
): Promise<ClaimedKey | null> {
  if (!encryptionKey) return null
  try {
    return await createKeyPool({ db, encryptionKey }).claim()
  } catch {
    return null
  }
}

export function createKeyPool({ db, encryptionKey }: KeyPoolOptions) {
  const secret = Buffer.from(encryptionKey, 'hex')
  if (secret.length !== 32) throw new Error('encryptionKey must be 32 bytes of hex')

  function encrypt(plain: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secret, iv)
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  }

  function decrypt(stored: Buffer): string {
    const iv = stored.subarray(0, 12)
    const tag = stored.subarray(12, 28)
    const ciphertext = stored.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', secret, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }

  return {
    /** Store (or replace) a member's consented key. */
    async store(memberId: string, plainKey: string, meta: KeyMeta = {}): Promise<void> {
      const fingerprint = createHash('sha256').update(plainKey).digest('hex').slice(0, 16)
      // Last-4 hint (#264): shown to the key's owner as ••••<hint>, never the full key.
      const keyHint = plainKey.slice(-4)
      await db.query(
        `INSERT INTO member_secrets
           (member_id, cpr_api_key, key_level, has_faction_access, member_rank,
            consent_at, consent_version, key_fingerprint, key_hint, disabled, last_error, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, false, NULL, now())
         ON CONFLICT (member_id) DO UPDATE SET
           cpr_api_key = EXCLUDED.cpr_api_key, key_level = EXCLUDED.key_level,
           has_faction_access = EXCLUDED.has_faction_access, member_rank = EXCLUDED.member_rank,
           consent_at = now(), consent_version = EXCLUDED.consent_version,
           key_fingerprint = EXCLUDED.key_fingerprint, key_hint = EXCLUDED.key_hint,
           disabled = false, last_error = NULL, updated_at = now()`,
        [memberId, encrypt(plainKey), meta.keyLevel ?? null, meta.hasFactionAccess ?? null,
         meta.memberRank ?? null, meta.consentVersion ?? null, fingerprint, keyHint]
      )
    },

    /**
     * Claim the least-recently-claimed enabled + consented key. Keys flagged
     * without faction API access are skipped (they'd fail faction calls with
     * Torn error 7). Safe under parallel claimers (SKIP LOCKED); returns null
     * when the pool is empty.
     */
    async claim(): Promise<ClaimedKey | null> {
      const res = await db.query(
        `UPDATE member_secrets SET last_claimed_at = clock_timestamp()
         WHERE member_id = (
           SELECT member_id FROM member_secrets
           WHERE disabled = false AND consent_at IS NOT NULL AND cpr_api_key IS NOT NULL
             AND has_faction_access IS NOT FALSE
           ORDER BY last_claimed_at ASC NULLS FIRST
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING member_id, cpr_api_key`
      )
      if (res.rows.length === 0) return null
      return { member_id: res.rows[0].member_id, key: decrypt(res.rows[0].cpr_api_key) }
    },

    /**
     * Every enabled + consented key with its owner, decrypted for in-process
     * use (the CPR scan hits Torn once per member with that member's key).
     */
    async listKeys(): Promise<ClaimedKey[]> {
      const res = await db.query(
        `SELECT member_id, cpr_api_key FROM member_secrets
         WHERE disabled = false AND consent_at IS NOT NULL AND cpr_api_key IS NOT NULL
           AND has_faction_access IS NOT FALSE
         ORDER BY member_id`
      )
      return res.rows.map((r) => ({ member_id: r.member_id, key: decrypt(r.cpr_api_key) }))
    },

    /** Take a key out of rotation (bad key, revoked consent, Torn error). */
    async disable(memberId: string, reason: string): Promise<void> {
      await db.query(
        `UPDATE member_secrets SET disabled = true, last_error = $2, updated_at = now()
         WHERE member_id = $1`,
        [memberId, reason]
      )
    },
  }
}
