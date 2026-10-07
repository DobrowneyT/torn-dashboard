// Server-side revive proxy (#308) — POST /api/war-room/revive.
//
// Browsers cannot POST cross-origin to revive services (CORS), so the server
// forwards the call. Black-box at the HTTP seam with a REAL fake revive
// service on loopback as the outbound target, so the assertions are on the
// bytes that actually left the process rather than on a stubbed fetch.
//
// Replaces the retired Supabase `war-room-fetch` `revive_request` action.
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
const tokens: Record<string, string> = {}

/** What the fake revive service saw on its last request. */
interface Captured {
  method: string
  contentType: string | undefined
  raw: string
}
let captured: Captured[] = []
let service: Server
let serviceUrl: string
/** Response the fake service replies with; per-test overridable. */
let serviceReply = { status: 200, body: JSON.stringify({ queued: true }) }

async function loginAs(name: string, id: string, roles: string[]) {
  const key = `${name.toUpperCase().padEnd(13, 'K')}${id.slice(0, 3)}`
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  for (const role of roles) {
    await stack.db.query('INSERT INTO role_assignments (torn_user_id, role) VALUES ($1, $2)', [id, role])
  }
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  tokens[name] = ((await res.json()) as any).token
}

async function revive(payload: unknown, as: string | null = 'member') {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (as) headers.authorization = `Bearer ${tokens[as]}`
  const res = await fetch(`${stack.baseUrl}/api/war-room/revive`, {
    method: 'POST', headers, body: JSON.stringify(payload),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  // The proxy refuses private/loopback targets by default (SSRF guard); the
  // fake service necessarily lives on loopback, so the guard is opened here.
  process.env.WAR_ROOM_REVIVE_ALLOW_PRIVATE_HOSTS = '1'

  service = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        contentType: req.headers['content-type'],
        raw,
      })
      res.writeHead(serviceReply.status, { 'content-type': 'application/json' })
      res.end(serviceReply.body)
    })
  })
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
  serviceUrl = `http://127.0.0.1:${(service.address() as any).port}/revive`

  stack = await startTestStack()
  await stack.db.query(
    `INSERT INTO members (member_id, member_name) VALUES ($1, $2), ($3, $4)
     ON CONFLICT (member_id) DO NOTHING`,
    ['2250591', 'MonChoon', '3058543', 'Gank']
  )
  await loginAs('member', '2250591', [])
  // ⚠️ A second actor (a `visitor`) logged in here to prove the proxy refused
  // read-only roles. #922 removed that role, and the route's only guard WAS
  // that check — it is `requireAuth()` now — so there is no second actor left to
  // distinguish. Gank stays on the roster above; nothing logs in as them.
})

afterAll(async () => {
  delete process.env.WAR_ROOM_REVIVE_ALLOW_PRIVATE_HOSTS
  await new Promise<void>((resolve) => service.close(() => resolve()))
  await stack?.close()
})

describe('POST /api/war-room/revive — JSON preset (UHC/WTF)', () => {
  it('sends the service the documented JSON body and returns the proxy shape', async () => {
    captured = []
    const res = await revive({
      url: serviceUrl,
      factionName: 'TNL Forge',
      source: 'TNL',
      preset: 'json',
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].contentType).toContain('application/json')
    // Identity comes from the SESSION, not the request body — a member cannot
    // ask the pool to revive somebody else under their name.
    expect(JSON.parse(captured[0].raw)).toEqual({
      userID: 2250591,
      userName: 'MonChoon',
      factionName: 'TNL Forge',
      source: 'TNL',
    })

    expect(res.body).toEqual({
      ok: true,
      status: 200,
      body: { queued: true },
      sentPayload: {
        userID: 2250591, userName: 'MonChoon', factionName: 'TNL Forge', source: 'TNL',
      },
      url: serviceUrl,
    })
  })

  it('honours a per-service sourceKey (WTF uses requestChannel)', async () => {
    captured = []
    await revive({ url: serviceUrl, factionName: 'TNL Forge', source: 'TNL', sourceKey: 'requestChannel', preset: 'json' })
    const sent = JSON.parse(captured[0].raw)
    expect(sent.requestChannel).toBe('TNL')
    expect(sent).not.toHaveProperty('source')
  })

  it('defaults the preset to json when none is given', async () => {
    captured = []
    await revive({ url: serviceUrl, factionName: 'TNL Forge', source: 'TNL' })
    expect(captured[0].contentType).toContain('application/json')
    expect(JSON.parse(captured[0].raw).source).toBe('TNL')
  })

  it('reports a non-2xx service response as ok:false without failing the call', async () => {
    captured = []
    serviceReply = { status: 429, body: JSON.stringify({ error: 'slow down' }) }
    const res = await revive({ url: serviceUrl, factionName: 'TNL Forge', source: 'TNL' })
    serviceReply = { status: 200, body: JSON.stringify({ queued: true }) }

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.status).toBe(429)
    expect(res.body.body).toEqual({ error: 'slow down' })
  })

  it('wraps a non-JSON service response rather than throwing', async () => {
    captured = []
    serviceReply = { status: 200, body: 'thanks, queued' }
    const res = await revive({ url: serviceUrl, factionName: 'TNL Forge', source: 'TNL' })
    serviceReply = { status: 200, body: JSON.stringify({ queued: true }) }

    expect(res.body.ok).toBe(true)
    expect(res.body.body).toEqual({ raw: 'thanks, queued' })
  })
})

describe('POST /api/war-room/revive — Nuke preset', () => {
  it('sends form-urlencoded fields with the country resolved server-side', async () => {
    // Nuke wants the player's CURRENT country; the server owns war-room state,
    // so it resolves the adjective itself rather than trusting the client.
    await stack.db.query(
      `INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, state)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (member_id) DO UPDATE SET state = EXCLUDED.state, deleted_at = NULL`,
      ['2250591', TEST_FACTION.tornFactionId, 'MonChoon',
       JSON.stringify({ status: { description: 'In a Swiss hospital for 20 minutes' } })]
    )
    captured = []

    const res = await revive({ url: serviceUrl, source: 'TNL War Room', preset: 'nuke' })

    expect(res.status).toBe(200)
    expect(captured[0].contentType).toContain('application/x-www-form-urlencoded')
    const sent = Object.fromEntries(new URLSearchParams(captured[0].raw))
    expect(sent).toEqual({
      torn_player_id: '2250591',
      torn_player_name: 'MonChoon [2250591]',
      torn_player_country: 'Switzerland',
      app_info: 'TNL War Room',
    })
    expect(res.body.sentPayload).toEqual(sent)
  })

  it('falls back to Torn when the hospital description names no country', async () => {
    await stack.db.query(
      `UPDATE war_room_state_v2 SET state = $2 WHERE member_id = $1`,
      ['2250591', JSON.stringify({ status: { description: 'In hospital for 5 minutes' } })]
    )
    captured = []
    await revive({ url: serviceUrl, source: 'TNL War Room', preset: 'nuke' })
    expect(Object.fromEntries(new URLSearchParams(captured[0].raw)).torn_player_country).toBe('Torn')
  })

  it('falls back to Torn when the member has no live war-room state row', async () => {
    // A soft-deleted row is "not in state" — tombstones must not resurrect a
    // stale country.
    await stack.db.query(`UPDATE war_room_state_v2 SET deleted_at = now() WHERE member_id = $1`, ['2250591'])
    captured = []
    await revive({ url: serviceUrl, source: 'TNL War Room', preset: 'nuke' })
    expect(Object.fromEntries(new URLSearchParams(captured[0].raw)).torn_player_country).toBe('Torn')
    await stack.db.query(`UPDATE war_room_state_v2 SET deleted_at = NULL WHERE member_id = $1`, ['2250591'])
  })

  it('defaults app_info when the service carries no source label', async () => {
    captured = []
    await revive({ url: serviceUrl, preset: 'nuke' })
    expect(Object.fromEntries(new URLSearchParams(captured[0].raw)).app_info).toBe('TNL War Room')
  })
})

describe('POST /api/war-room/revive — auth and input guards', () => {
  it('rejects an unauthenticated caller', async () => {
    captured = []
    const res = await revive({ url: serviceUrl, source: 'TNL' }, null)
    expect(res.status).toBe(401)
    expect(captured).toHaveLength(0)
  })

  // ⚠️ A `rejects a visitor — the read-only role sends nothing outbound` case sat
  // here. The guard it tested was the visitor check itself, which was also this
  // route's only guard; #922 converted it to `requireAuth()`. The
  // unauthenticated case above still proves nothing goes outbound without a
  // session, which is the property that actually matters for an outbound proxy.

  it('requires a url', async () => {
    const res = await revive({ source: 'TNL' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/url/i)
  })

  it('rejects a non-http(s) scheme', async () => {
    // file:// / gopher: etc. would make the server read local resources.
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'not-a-url']) {
      const res = await revive({ url, source: 'TNL' })
      expect(res.status).toBe(400)
    }
  })

  it('refuses to proxy to a private-network address (SSRF guard)', async () => {
    // The proxy runs INSIDE the compose network beside Postgres and every
    // tenant API, so an arbitrary client-supplied URL is a reachability
    // primitive. Loopback is only allowed because this suite opts in.
    delete process.env.WAR_ROOM_REVIVE_ALLOW_PRIVATE_HOSTS
    captured = []
    for (const url of [
      'http://127.0.0.1:5432/',
      'http://localhost/api/health',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://[::1]/',
    ]) {
      const res = await revive({ url, source: 'TNL' })
      expect(res.status, `expected ${url} to be refused`).toBe(400)
    }
    expect(captured).toHaveLength(0)
    process.env.WAR_ROOM_REVIVE_ALLOW_PRIVATE_HOSTS = '1'
  })

  it('returns 502 when the service is unreachable', async () => {
    const dead = 'http://127.0.0.1:1/revive'
    const res = await revive({ url: dead, source: 'TNL' })
    expect(res.status).toBe(502)
    expect(res.body.error).toMatch(/revive request failed/i)
  })
})
