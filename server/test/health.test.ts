// Black-box test at the HTTP seam: boot the real per-faction API service on an
// ephemeral port and talk to it over real HTTP, exactly as nginx will.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/app.js'

describe('per-faction API service', () => {
  let baseUrl: string
  let close: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const app = await buildServer({ factionSlug: 'forge' })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const addr = app.server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no port')
    baseUrl = `http://127.0.0.1:${addr.port}`
    close = () => app.close()
  })

  afterAll(async () => {
    // Guarded so a failed beforeAll doesn't mask its error with a teardown one.
    await close?.()
  })

  it('reports healthy and names the faction it serves', async () => {
    const res = await fetch(`${baseUrl}/api/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ status: 'ok', faction: 'forge' })
    // Liveness carries the app version (source of truth: the repo-root VERSION
    // file). A real semver, never the 'unknown' fallback, when the file ships.
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
