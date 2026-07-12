// War-room dibs auto-expiry (#106 + #107). The 1 Hz ticker watches each
// live-dibbed target's hospital status across ticks and releases claims the
// holder clearly isn't going to convert:
//   #107 — the target's hospital-until time increases (a merc/other hit put
//          them back in for longer) → drop the dibs this tick.
//   #106 — the target leaves hospital (Hospital→Okay) → schedule a release
//          ~30s out; if still held when the window lapses, drop it.
// Every auto-release rides the dibs channel exactly like a manual release.
//
// Seam: drive ticker.tick() against real templated Postgres + the Torn
// fixture; assert on war_room_dibs_v2 tombstones and the 'dibs' WS broadcast.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'

let stack: TestStack
const US = Number(TEST_FACTION.tornFactionId)
const ENEMY = 90040
const HOLDER = '1700'

function tickerDeps(extra: Record<string, unknown> = {}) {
  const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
  return { db: stack.db, pool, hub: stack.warRoomHub!, tornBaseUrl: stack.tornBaseUrl, ...extra }
}

// One enemy member the fixture returns with a controllable status.
function enemyPayload(status: Record<string, unknown>) {
  return {
    members: [{
      id: Number(TARGET), name: 'Foe', level: 55, position: 'Soldier',
      last_action: { status: 'Idle', timestamp: 1752200000 },
      status, is_revivable: false,
    }],
  }
}
const TARGET = 90140

// A live dib on TARGET held by HOLDER, with the target's stored status set to
// `prev` — the "previous observation" the next tick diffs against.
async function seedDib(prevStatus: Record<string, unknown>) {
  await stack.db.query(`DELETE FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`)
  await stack.db.query(
    `INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, level, state)
     VALUES (${TARGET}, ${ENEMY}, 'Foe', 55, $1)
     ON CONFLICT (member_id) DO UPDATE SET state = EXCLUDED.state, deleted_at = NULL, updated_at = now()`,
    [JSON.stringify({ status: prevStatus })]
  )
  await stack.db.query(
    `INSERT INTO war_room_dibs_v2 (target_id, claimed_by, claimed_name) VALUES (${TARGET}, ${HOLDER}, 'Holder')`
  )
}

function wsConnect(token: string): Promise<{ ws: WebSocket; messages: any[]; next: (pred?: (m: any) => boolean) => Promise<any> }> {
  const url = `${stack.baseUrl.replace('http', 'ws')}/api/war-room/ws?token=${token}`
  const ws = new WebSocket(url)
  const messages: any[] = []
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = []
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data))
    messages.push(msg)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1) }
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

let token: string

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, tier, is_current) VALUES ($1, 'Holder', 3, true)`,
    [HOLDER]
  )
  const key = `HOLDERKEYAAAA${HOLDER.slice(0, 3)}`
  stack.torn.addKey(key, { id: HOLDER, factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  token = ((await res.json()) as any).token

  const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
  await pool.store(HOLDER, 'DIBSEXPKEY1700AA', { consentVersion: 'v2' })

  // A manual session (auto_managed=false) polls regardless of any war window.
  await stack.db.query(
    `INSERT INTO war_room_config_v2 (id, enabled, faction_id, faction_name, auto_managed)
     VALUES (1, true, ${ENEMY}, 'Foes', false)`
  )
  // Our own roster: one member, unaffected by the enemy-target logic.
  stack.torn.setHandler(`/v2/faction/${US}/members`, () => ({
    members: [{
      id: Number(HOLDER), name: 'Holder', level: 40, position: 'Soldier',
      last_action: { status: 'Online', timestamp: 1752200100 },
      status: { state: 'Okay', until: null }, is_revivable: false,
    }],
  }))
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('war-room dibs auto-expiry', () => {
  it('#107 drops a held dib when the target’s hospital-until time increases between ticks', async () => {
    // Previously observed in hospital until T; now the fixture reports a
    // longer stay (someone hit them the holder didn't) → the window came and
    // went; the claim is just blocking the queue.
    await seedDib({ state: 'Hospital', until: 1752200500 })
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Hospital', until: 1752209999 }))

    const client = await wsConnect(token)
    await client.next((m) => m.type === 'snapshot')

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    await createWarRoomTicker(tickerDeps()).tick()

    // The dib is tombstoned…
    const dib = await stack.db.query(`SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`)
    expect(dib.rows[0].deleted_at).toBeTruthy()
    // …and the release rode the dibs channel so every client updates live.
    const frame = await client.next(
      (m) => m.type === 'delta' && m.channel === 'dibs' && m.rows.some((r: any) => Number(r.target_id) === TARGET && r.deleted_at)
    )
    expect(frame.rows.some((r: any) => Number(r.target_id) === TARGET)).toBe(true)

    client.ws.close()
  })

  it('#107 leaves the dib alone on a normal hospital countdown (until ticking down)', async () => {
    // Same target still in hospital, but the release time is closer, not
    // further — the ordinary countdown, not a fresh hit. Must not drop.
    await seedDib({ state: 'Hospital', until: 1752209999 })
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Hospital', until: 1752200500 }))

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    await createWarRoomTicker(tickerDeps()).tick()

    const dib = await stack.db.query(`SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`)
    expect(dib.rows[0].deleted_at).toBeNull()
  })

  it('#106 schedules a release ~30s out when the target leaves hospital, but does not drop it that tick', async () => {
    await seedDib({ state: 'Hospital', until: 1752200500 })
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Okay', until: null }))

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    await createWarRoomTicker(tickerDeps()).tick()

    // Still held this tick — the window is running, not lapsed…
    const dib = await stack.db.query(
      `SELECT deleted_at, auto_expire_at, EXTRACT(EPOCH FROM (auto_expire_at - now())) AS secs
       FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`
    )
    expect(dib.rows[0].deleted_at).toBeNull()
    // …with a deadline roughly the window out (default 30s).
    expect(dib.rows[0].auto_expire_at).toBeTruthy()
    expect(Number(dib.rows[0].secs)).toBeGreaterThan(20)
    expect(Number(dib.rows[0].secs)).toBeLessThanOrEqual(31)
  })

  it('#106 drops the dib on a later tick once the scheduled window has lapsed, broadcasting the release', async () => {
    await seedDib({ state: 'Hospital', until: 1752200500 })
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Okay', until: null }))

    const client = await wsConnect(token)
    await client.next((m) => m.type === 'snapshot')

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    const ticker = createWarRoomTicker(tickerDeps())
    await ticker.tick() // observes Hospital→Okay, schedules the window
    expect((await stack.db.query(`SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`)).rows[0].deleted_at).toBeNull()

    // Advance the clock: the scheduled window has now lapsed.
    await stack.db.query(
      `UPDATE war_room_dibs_v2 SET auto_expire_at = now() - interval '1 second' WHERE target_id = ${TARGET} AND deleted_at IS NULL`
    )
    await ticker.tick() // target still Okay; the sweep fires

    const dib = await stack.db.query(`SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`)
    expect(dib.rows[0].deleted_at).toBeTruthy()
    const frame = await client.next(
      (m) => m.type === 'delta' && m.channel === 'dibs' && m.rows.some((r: any) => Number(r.target_id) === TARGET && r.deleted_at)
    )
    expect(frame.rows.some((r: any) => Number(r.target_id) === TARGET)).toBe(true)

    client.ws.close()
  })

  it('never touches a dib on a target that was never in hospital (Okay→Okay)', async () => {
    await seedDib({ state: 'Okay', until: null })
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Okay', until: null }))

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    await createWarRoomTicker(tickerDeps()).tick()

    const dib = await stack.db.query(
      `SELECT deleted_at, auto_expire_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`
    )
    expect(dib.rows[0].deleted_at).toBeNull()
    expect(dib.rows[0].auto_expire_at).toBeNull()
  })

  it('a re-claim inside the window carries no stale expiry — the fresh claim behaves normally', async () => {
    await seedDib({ state: 'Hospital', until: 1752200500 })
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Okay', until: null }))

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    const ticker = createWarRoomTicker(tickerDeps())
    await ticker.tick() // schedules a release on the current claim

    // The holder re-claims the same target (the real write path tombstones the
    // scheduled row and inserts a fresh one with no auto_expire_at).
    const reclaim = await fetch(`${stack.baseUrl}/api/war-room/dibs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target_id: TARGET }),
    })
    expect(reclaim.status).toBe(200)

    const fresh = await stack.db.query(
      `SELECT auto_expire_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`
    )
    expect(fresh.rows[0].auto_expire_at).toBeNull()

    // A subsequent tick (target still Okay, no new transition) must not drop it.
    await ticker.tick()
    const dib = await stack.db.query(
      `SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`
    )
    expect(dib.rows).toHaveLength(1)
  })
})
