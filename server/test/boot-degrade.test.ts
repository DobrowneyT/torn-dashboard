// A misconfigured KEY_ENCRYPTION_KEY (wrong length, corrupted .env line)
// must degrade the API — key-pool surfaces answer 503 — never crash it at
// build time. Regression: a corrupted env glued 18 extra chars onto the key
// and every faction API crash-looped into nginx 502s (2026-07-11).
import { describe, expect, it } from 'vitest'
import pg from 'pg'
import { buildServer } from '../src/app.js'

describe('buildServer with a malformed key-at-rest secret', () => {
  it('still builds and serves; scraper triggers degrade instead of crashing boot', async () => {
    // The pool is never queried during buildServer — only at request time —
    // so a non-connecting pool exercises the full route wiring.
    const app = await buildServer({
      factionSlug: 'degraded',
      db: new pg.Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 50 }),
      tornBaseUrl: 'http://127.0.0.1:9',
      jwtSecret: 'irrelevant',
      keyEncryptionKey: 'not-64-hex-chars',
    })
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().faction).toBe('degraded')
    await app.close()
  })
})
