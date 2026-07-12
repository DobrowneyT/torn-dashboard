// Per-faction operator secrets (#105): spy-provider API keys and friends.
// Same AES-256-GCM at-rest scheme as the member key pool (iv | tag | data,
// KEY_ENCRYPTION_KEY); reads expose only a configured-flag and a last-4
// hint — no endpoint returns the plaintext.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type pg from 'pg'

/** The secrets the admin surface may manage. */
export const SECRET_NAMES = ['tornstats_api_key', 'bsp_api_key'] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export interface SecretStoreOptions {
  db: pg.Pool
  /** 32-byte hex string (KEY_ENCRYPTION_KEY). */
  encryptionKey: string
}

export function createSecretStore({ db, encryptionKey }: SecretStoreOptions) {
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
    async set(name: SecretName, value: string): Promise<void> {
      await db.query(
        `INSERT INTO faction_secrets (name, value_enc, hint, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (name) DO UPDATE SET
           value_enc = EXCLUDED.value_enc, hint = EXCLUDED.hint, updated_at = now()`,
        [name, encrypt(value), value.slice(-4)]
      )
    },

    /** Plaintext for in-process use only. Null when unset. */
    async get(name: SecretName): Promise<string | null> {
      const res = await db.query('SELECT value_enc FROM faction_secrets WHERE name = $1', [name])
      if (res.rows.length === 0) return null
      try {
        return decrypt(res.rows[0].value_enc)
      } catch {
        return null
      }
    },

    /** Metadata for the admin UI — every managed name, configured or not. */
    async list(): Promise<Array<{ name: SecretName; configured: boolean; hint: string | null; updated_at: string | null }>> {
      const res = await db.query('SELECT name, hint, updated_at FROM faction_secrets')
      const byName = new Map(res.rows.map((r) => [r.name, r]))
      return SECRET_NAMES.map((name) => {
        const row = byName.get(name)
        return {
          name,
          configured: !!row,
          hint: row?.hint ?? null,
          updated_at: row?.updated_at ?? null,
        }
      })
    },
  }
}
