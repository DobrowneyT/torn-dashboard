// Readiness healthcheck (#76 / slice 18). Distinct from the liveness probe
// (`/api/health`, "the process is up") — `/api/health/ready` reports what an
// uptime monitor and an operator actually need per faction: live DB
// connectivity and whether the background scheduler + war-room ticker are
// armed. DB down ⇒ 503 so the monitor alerts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { startTestStack, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { buildServer } from '../src/app.js'

let stack: TestStack

beforeAll(async () => {
  stack = await startTestStack()
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('GET /api/health/ready — readiness', () => {
  it('reports DB up and names the faction when the database answers', async () => {
    const res = await fetch(`${stack.baseUrl}/api/health/ready`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ status: 'ok', db: 'up' })
    // The harness does not arm background work, so both read disarmed.
    expect(body.scheduler).toBe('disarmed')
    expect(body.ticker).toBe('disarmed')
  })

  it('returns 503 degraded when the database is unreachable', async () => {
    const app = await buildServer({
      factionSlug: 'downtenant',
      db: new pg.Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 50 }),
      tornBaseUrl: 'http://127.0.0.1:9',
      jwtSecret: 'irrelevant',
      keyEncryptionKey: TEST_KEY_ENCRYPTION_KEY,
    })
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ status: 'degraded', faction: 'downtenant', db: 'down' })
    await app.close()
  })

  it('reflects the armed scheduler/ticker once the caller flips the health flags', async () => {
    // main.ts hands buildServer a mutable flags object and flips it true after
    // startScrapers()/ticker.start(); the endpoint reads the live values.
    const health = { scheduler: false, ticker: false }
    const app = await buildServer({
      factionSlug: 'forge',
      db: stack.db,
      tornBaseUrl: stack.tornBaseUrl,
      jwtSecret: 'irrelevant',
      keyEncryptionKey: TEST_KEY_ENCRYPTION_KEY,
      health,
    })
    expect((await app.inject({ url: '/api/health/ready' })).json()).toMatchObject({
      scheduler: 'disarmed', ticker: 'disarmed',
    })
    health.scheduler = true
    health.ticker = true
    expect((await app.inject({ url: '/api/health/ready' })).json()).toMatchObject({
      db: 'up', scheduler: 'armed', ticker: 'armed',
    })
    await app.close()
  })

  it('reports not_configured (still 200) in dashboards-only mode with no database', async () => {
    const app = await buildServer({ factionSlug: 'nodb' })
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', faction: 'nodb', db: 'not_configured' })
    await app.close()
  })
})
