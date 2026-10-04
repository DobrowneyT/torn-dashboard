// Consented key pool over the per-faction member_secrets table. Keys are
// AES-256-GCM encrypted at rest with a server-held secret and never leave
// the server process; the pool only ever reads the faction's own database
// (it is constructed with that DB's pool and nothing else).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type pg from 'pg'
import { DISCLOSURE_VERSIONS, PURPOSE_VERSIONS, consentCovers } from '../consent.js'

export interface KeyPoolOptions {
  db: pg.Pool
  /** 32-byte hex string (server env), used for AES-256-GCM. */
  encryptionKey: string
}

export interface ClaimedKey {
  member_id: string
  key: string
}

/** A pooled key with the access facts we last recorded for it (#309). */
export interface PooledKey extends ClaimedKey {
  has_faction_access: boolean | null
  key_level: number | null
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
     *
     * `purpose` restricts the claim to keys whose owner has accepted a
     * disclosure covering it (#894).
     *
     * ⚠️ **Omitting it is the baseline and changes nothing.** Every existing
     * caller passes no purpose and claims exactly the keys it always did —
     * which is the point: a re-prompt must never stop the faction's data
     * collection while people get round to accepting it.
     */
    async claim(opts: { purpose?: string } = {}): Promise<ClaimedKey | null> {
      const required = opts.purpose ? PURPOSE_VERSIONS[opts.purpose] : null
      // ⚠️ The SQL cannot rank versions — the ordering lives in an array in
      // `consent.ts`, deliberately, because these ids do not compare as
      // strings. So the set of acceptable versions is computed here and passed
      // as a bound parameter.
      const acceptable = required === null || required === undefined
        ? null
        : DISCLOSURE_VERSIONS
            .filter((v) => consentCovers(v.id, opts.purpose))
            .map((v) => v.id)

      // A gated purpose no stored version can satisfy must claim NOTHING,
      // rather than falling through to an unfiltered claim.
      if (acceptable !== null && acceptable.length === 0) return null

      const res = await db.query(
        `UPDATE member_secrets SET last_claimed_at = clock_timestamp()
         WHERE member_id = (
           SELECT member_id FROM member_secrets
           WHERE disabled = false AND consent_at IS NOT NULL AND cpr_api_key IS NOT NULL
             AND has_faction_access IS NOT FALSE
             AND ($1::text[] IS NULL OR consent_version = ANY($1::text[]))
           ORDER BY last_claimed_at ASC NULLS FIRST
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING member_id, cpr_api_key`,
        [acceptable]
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

    /**
     * Keys whose owner opted into the calendar scope (#459).
     *
     * ⚠️ This is deliberately NOT `claim()`. `/user/calendar` returns the
     * CALLER's own start hour, so a rotating pooled key would report the key
     * owner's setting under someone else's name — every member showing the
     * same time, and nothing about that failure looks like a failure.
     *
     * ⚠️ And it does not filter on `has_faction_access`: this is a `/user`
     * call, so a key without faction access answers it perfectly well. Reusing
     * `listKeys()` would have silently skipped every recruit.
     */
    async listCalendarScopedKeys(): Promise<ClaimedKey[]> {
      const res = await db.query(
        `SELECT member_id, cpr_api_key FROM member_secrets
         WHERE disabled = false AND cpr_api_key IS NOT NULL
           AND consent_at IS NOT NULL
           AND calendar_scope_at IS NOT NULL
         ORDER BY member_id`
      )
      return res.rows.map((r) => ({ member_id: r.member_id, key: decrypt(r.cpr_api_key) }))
    },

    /**
     * Every enabled + consented key, INCLUDING the ones currently flagged
     * without faction access. `listKeys()` filters those out (they'd fail
     * faction calls), so it can't drive the hourly re-verification (#309),
     * which exists precisely to notice a recruit's key gaining faction access.
     */
    async listAllKeys(): Promise<PooledKey[]> {
      const res = await db.query(
        `SELECT member_id, cpr_api_key, has_faction_access, key_level FROM member_secrets
         WHERE disabled = false AND consent_at IS NOT NULL AND cpr_api_key IS NOT NULL
         ORDER BY member_id`
      )
      return res.rows.map((r) => ({
        member_id: r.member_id,
        key: decrypt(r.cpr_api_key),
        has_faction_access: r.has_faction_access,
        key_level: r.key_level,
      }))
    },

    /**
     * Refresh the access facts a key was enrolled with (#309): login records
     * them once, this keeps them honest between logins. A key that verifies
     * cleanly also clears any stale error text.
     */
    async setAccess(
      memberId: string,
      access: { hasFactionAccess: boolean; keyLevel?: number | null }
    ): Promise<void> {
      await db.query(
        `UPDATE member_secrets
         SET has_faction_access = $2, key_level = COALESCE($3, key_level),
             last_error = NULL, updated_at = now()
         WHERE member_id = $1`,
        [memberId, access.hasFactionAccess, access.keyLevel ?? null]
      )
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
