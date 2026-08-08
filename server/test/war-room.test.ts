// War-room read path (slice #71): combined delta/snapshot REST endpoint,
// authenticated WebSocket hub, and the war-gated in-process ticker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'

let stack: TestStack
const tokens: Record<string, string> = {}
const US = Number(TEST_FACTION.tornFactionId)
const ENEMY = 90001

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

async function get(path: string, as = 'member') {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${tokens[as]}` },
  })
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  stack = await startTestStack()
  await loginAs('member', '1300', [])

  // Seed one enemy row, one dib, config, chain.
  await stack.db.query(`
    INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, level, state)
    VALUES (90100, ${ENEMY}, 'EnemyOne', 50, '{"status": {"state": "Okay"}}')
  `)
  await stack.db.query(`
    INSERT INTO war_room_dibs_v2 (target_id, claimed_by, claimed_name) VALUES (90100, 1300, 'Member')
  `)
  await stack.db.query(`
    INSERT INTO war_room_config_v2 (id, enabled, faction_id, faction_name) VALUES (1, false, ${ENEMY}, 'Enemies')
  `)
  await stack.db.query(`
    INSERT INTO war_room_chain_v2 (id, current, max) VALUES (1, 15, 25)
  `)
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('GET /api/war-room/delta', () => {
  it('returns full snapshots of all four channels with a server watermark', async () => {
    const { status, body } = await get('/api/war-room/delta')
    expect(status).toBe(200)
    expect(body.state.rows).toHaveLength(1)
    expect(body.state.rows[0]).toMatchObject({ member_id: 90100, member_name: 'EnemyOne' })
    expect(body.dibs.rows[0]).toMatchObject({ target_id: 90100, claimed_by: 1300 })
    expect(body.config.rows[0]).toMatchObject({ enabled: false, faction_id: ENEMY })
    expect(body.chain.rows[0]).toMatchObject({ current: 15, max: 25 })
    expect(body.server_now).toBeTruthy()
  })

  it('returns only rows that changed after `since`, including tombstones', async () => {
    const first = await get('/api/war-room/delta')
    const since = encodeURIComponent(first.body.server_now)

    const idle = await get(`/api/war-room/delta?since=${since}`)
    expect(idle.body.state.rows).toHaveLength(0)
    expect(idle.body.dibs.rows).toHaveLength(0)

    await stack.db.query(
      `UPDATE war_room_state_v2 SET state = '{"status": {"state": "Hospital"}}', updated_at = now()
       WHERE member_id = 90100`
    )
    await stack.db.query(
      `UPDATE war_room_dibs_v2 SET deleted_at = now(), updated_at = now() WHERE target_id = 90100`
    )

    const delta = await get(`/api/war-room/delta?since=${since}`)
    expect(delta.body.state.rows).toHaveLength(1)
    expect(delta.body.state.rows[0].state).toEqual({ status: { state: 'Hospital' } })
    // The released dib arrives as a tombstone, not a disappearance.
    expect(delta.body.dibs.rows).toHaveLength(1)
    expect(delta.body.dibs.rows[0].deleted_at).toBeTruthy()

    expect((await fetch(`${stack.baseUrl}/api/war-room/delta`)).status).toBe(401)
  })
})

function wsConnect(token?: string): Promise<{ ws: WebSocket; messages: any[]; next: (pred?: (m: any) => boolean) => Promise<any> }> {
  const url = `${stack.baseUrl.replace('http', 'ws')}/api/war-room/ws${token ? `?token=${token}` : ''}`
  const ws = new WebSocket(url)
  const messages: any[] = []
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = []
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data))
    messages.push(msg)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg)
        waiters.splice(i, 1)
      }
    }
  })
  const next = (pred: (m: any) => boolean = () => true) =>
    new Promise<any>((resolve, reject) => {
      const existing = messages.find(pred)
      if (existing) return resolve(existing)
      waiters.push({ pred, resolve })
      setTimeout(() => reject(new Error('ws message timeout')), 5000)
    })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, messages, next }))
    ws.on('error', reject)
  })
}

describe('war-room WebSocket hub', () => {
  it('authenticated clients get a snapshot on connect and every broadcast after', async () => {
    const a = await wsConnect(tokens.member)
    const b = await wsConnect(tokens.member)

    const snapA = await a.next((m) => m.type === 'snapshot')
    expect(snapA.state.rows).toHaveLength(1)
    expect(snapA.chain.rows[0]).toMatchObject({ current: 15 })
    await b.next((m) => m.type === 'snapshot')

    expect(stack.warRoomHub!.clientCount()).toBe(2)

    // A delta broadcast reaches both clients.
    stack.warRoomHub!.broadcast('state', [{ member_id: 90100, state: { status: { state: 'Okay' } } }], '2026-07-09T12:00:00Z')
    const deltaA = await a.next((m) => m.type === 'delta')
    const deltaB = await b.next((m) => m.type === 'delta')
    expect(deltaA.channel).toBe('state')
    expect(deltaA.rows[0].member_id).toBe(90100)
    expect(deltaB.rows[0].member_id).toBe(90100)

    a.ws.close()
    b.ws.close()
  })

  it('rejects unauthenticated sockets', async () => {
    const closed = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${stack.baseUrl.replace('http', 'ws')}/api/war-room/ws`)
      ws.on('close', (code) => resolve(code))
      ws.on('error', reject)
      setTimeout(() => reject(new Error('no close')), 5000)
    })
    expect(closed).toBe(4401)
  })

  it('load check: dozens of clients all receive one broadcast', async () => {
    const clients = await Promise.all(Array.from({ length: 30 }, () => wsConnect(tokens.member)))
    await Promise.all(clients.map((c) => c.next((m) => m.type === 'snapshot')))

    stack.warRoomHub!.broadcast('chain', [{ id: 1, current: 99 }], '2026-07-09T12:01:00Z')
    const frames = await Promise.all(clients.map((c) => c.next((m) => m.type === 'delta' && m.channel === 'chain')))
    expect(frames).toHaveLength(30)
    expect(frames.every((f) => f.rows[0].current === 99)).toBe(true)

    for (const c of clients) c.ws.close()
  })
})

describe('war-room ticker', () => {
  let tornHitsBefore = 0
  const memberPayload = (status: string, extra: any = {}) => ({
    members: [
      {
        id: 90100, name: 'EnemyOne', level: 50, position: 'Soldier',
        last_action: { status: 'Online', timestamp: 1752000000 },
        status: { state: status, description: null, until: null },
        is_revivable: true,
        ...extra,
      },
    ],
  })

  function tickerDeps() {
    const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
    return { db: stack.db, pool, hub: stack.warRoomHub!, tornBaseUrl: stack.tornBaseUrl }
  }

  beforeAll(async () => {
    await stack.db.query(`
      INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('1300', 'Member', 3, true)
      ON CONFLICT (member_id) DO NOTHING
    `)
    const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
    await pool.store('1300', 'TICKERKEY1300AAA', { consentVersion: 'v2' })

    // Managed war 700, active window (started an hour ago, no end).
    await stack.db.query(`
      INSERT INTO ranked_wars (id, start_at, end_at, opponent_id, opponent_name)
      VALUES (700, ${Math.floor(Date.now() / 1000) - 3600}, NULL, ${ENEMY}, 'Enemies')
    `)
    await stack.db.query(`
      UPDATE war_room_config_v2 SET managed_war_id = 700, updated_at = now() WHERE id = 1
    `)

    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => memberPayload('Okay'))
    stack.torn.setHandler(`/v2/faction/${US}/members`, () => ({
      members: [{
        id: 1300, name: 'Member', level: 40, position: 'Soldier',
        last_action: { status: 'Online', timestamp: 1752000100 },
        status: { state: 'Okay', description: null, until: null }, is_revivable: false,
      }],
    }))
  })

  it('does nothing while the war room is disabled', async () => {
    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    const ticker = createWarRoomTicker(tickerDeps())
    tornHitsBefore = stack.torn.hits()
    await ticker.tick()
    expect(stack.torn.hits()).toBe(tornHitsBefore)
  })

  it('fetches, diffs, persists, and broadcasts when enabled with an active war', async () => {
    await stack.db.query(`UPDATE war_room_config_v2 SET enabled = true, updated_at = now() WHERE id = 1`)
    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    const ticker = createWarRoomTicker(tickerDeps())

    const client = await wsConnect(tokens.member)
    await client.next((m) => m.type === 'snapshot')

    await ticker.tick()
    const delta = await client.next((m) => m.type === 'delta' && m.channel === 'state')
    const enemy = delta.rows.find((r: any) => r.member_id === 90100)
    expect(enemy.state.status.state).toBe('Okay')
    expect(enemy.state.last_action.timestamp).toBe(1752000000)
    // Our own members ride the same channel (faction_id disambiguates).
    const ours = await stack.db.query(`SELECT * FROM war_room_state_v2 WHERE member_id = 1300`)
    expect(ours.rows[0].faction_id).toBe(US)

    // Idle tick: nothing changed upstream → no state broadcast.
    const framesBefore = client.messages.filter((m) => m.type === 'delta' && m.channel === 'state').length
    await ticker.tick()
    await new Promise((r) => setTimeout(r, 150))
    expect(client.messages.filter((m) => m.type === 'delta' && m.channel === 'state').length).toBe(framesBefore)

    // A status flip broadcasts exactly the changed member.
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => memberPayload('Hospital'))
    await ticker.tick()
    const flip = await client.next(
      (m) => m.type === 'delta' && m.channel === 'state' && m.rows.some((r: any) => r.state?.status?.state === 'Hospital')
    )
    expect(flip.rows).toHaveLength(1)

    // A member who vanishes from the roster arrives as a tombstone.
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => ({ members: [] }))
    await ticker.tick()
    const tombstone = await client.next(
      (m) => m.type === 'delta' && m.channel === 'state' && m.rows.some((r: any) => r.deleted_at)
    )
    expect(tombstone.rows[0].member_id).toBe(90100)

    client.ws.close()
  })

  it('keeps polling an auto-managed session outside its war window (#345)', async () => {
    // The war window used to gate polling, so an ENABLED room went dark before
    // a scheduled war and after one ended — for days, behind a LIVE badge.
    // `enabled` is now the only gate: if leadership switched it on, it polls.
    await stack.db.query(`UPDATE ranked_wars SET end_at = ${Math.floor(Date.now() / 1000) - 60} WHERE id = 700`)
    await stack.db.query(`UPDATE war_room_config_v2 SET auto_managed = true, updated_at = now() WHERE id = 1`)
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => memberPayload('Okay'))
    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    const ticker = createWarRoomTicker(tickerDeps())
    const before = stack.torn.hits()
    await ticker.tick()
    expect(stack.torn.hits()).toBeGreaterThan(before)
  })

  it('does nothing at all once the war room is disabled', async () => {
    // The remaining gate, and the one a leader actually controls.
    await stack.db.query(`UPDATE war_room_config_v2 SET enabled = false, updated_at = now() WHERE id = 1`)
    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    const ticker = createWarRoomTicker(tickerDeps())
    const before = stack.torn.hits()
    await ticker.tick()
    expect(stack.torn.hits()).toBe(before)
    await stack.db.query(`UPDATE war_room_config_v2 SET enabled = true, updated_at = now() WHERE id = 1`)
  })

  it('a manual session keeps polling despite a stale managed_war_id (#100)', async () => {
    // The leader's Save & Fetch (auto_managed=false) must not be gated by
    // whatever war the lifecycle automation managed last — that stale id
    // silently froze manual sessions.
    await stack.db.query(`UPDATE war_room_config_v2 SET auto_managed = false, updated_at = now() WHERE id = 1`)
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => memberPayload('Okay'))
    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    const ticker = createWarRoomTicker(tickerDeps())
    const before = stack.torn.hits()
    await ticker.tick()
    expect(stack.torn.hits()).toBeGreaterThan(before)
  })
})
