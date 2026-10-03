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
import { sweepDibsExpiry } from '../src/warRoomDibsExpiry.js'

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

  // ── The farm-mode cycle (#376) ────────────────────────────────────────────
  //
  // Reported as "when the target is released from hosp, the dibs is stripped
  // and it appears it was never called". The countdown was armed once and
  // never disarmed: auto_expire_at was only ever SET (and only when null), so
  // after the target went back into hospital it kept a deadline that had
  // already lapsed. The next time they came out, the sweep saw
  // `auto_expire_at <= now() AND target is Okay` and dropped the claim on that
  // very tick — no window at all.
  //
  // Farm mode walks straight into this, because the loop IS
  // hospital → out → hit → hospital → out.

  for (const downstate of ['Hospital', 'Jail', 'Traveling', 'Abroad']) {
    it(`releases the claim when an Okay target goes to ${downstate}`, async () => {
      // MonChoon, 2026-10-03: *"once okay any state change off of okay should
      // release the dibs"*. The claim's only job is "this target is mine to
      // hit"; the moment they cannot be hit it has no job, and holding it
      // blocks everybody else. Jail and travel were added after hospital —
      // nobody converted there, but the target is just as unreachable.
      await seedDib({ state: 'Okay', until: null })

      stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: downstate, until: 1752209999 }))
      const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
      await createWarRoomTicker(tickerDeps()).tick()

      const dib = await stack.db.query(
        `SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`
      )
      expect(dib.rows).toHaveLength(0)
    })
  }

  it('⚠️ keeps the claim on Hospital→Okay — the reservation paying off', async () => {
    // ⚠️ The one transition that must NOT release, and the reason the rule is
    // `wasOkay && …` rather than "any state change". You claimed somebody
    // BECAUSE they were in hospital, so that you would have them when they
    // surface. Releasing here kills the claim at the exact moment it becomes
    // useful — a worse version of the bug this all started from.
    await seedDib({ state: 'Hospital', until: 1752200500 })
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Okay', until: null }))

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    await createWarRoomTicker(tickerDeps()).tick()

    const dib = await stack.db.query(
      `SELECT deleted_at, auto_expire_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`
    )
    expect(dib.rows[0].deleted_at).toBeNull()
    expect(dib.rows[0].auto_expire_at).toBeTruthy()   // the 30s window is armed
  })

  it('⚠️ a MISSING status reading is not a downstate — unknown is not down', async () => {
    // Load-bearing. Without the `typeof next?.state === 'string'` guard, a sync
    // hiccup that left rows with no status would read as "not Okay" for every
    // target at once and tombstone every live claim in a single tick.
    await seedDib({ state: 'Okay', until: null })

    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({}))
    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    await createWarRoomTicker(tickerDeps()).tick()

    const dib = await stack.db.query(
      `SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`
    )
    expect(dib.rows).toHaveLength(1)
  })

  it('⚠️ a spurious Okay flicker now COSTS the claim — the accepted trade', async () => {
    // ⚠️ BEHAVIOUR CHANGE, 2026-10-03, and the one real cost of dropping on
    // Okay→Hospital. A bad poll reading that shows Okay for one tick, then
    // Hospital again, is indistinguishable at the sweep from "they surfaced and
    // somebody hit them": `prev` is Okay either way, and the Okay reading
    // carries no `until` to compare against.
    //
    // Accepted deliberately, because the two errors are not symmetric:
    //   • flicker drops a claim → the holder re-claims, seconds later, on a
    //     target who is still in hospital so nobody else can take them either;
    //   • not dropping → claims sat for 33 MINUTES on forge mid-war, blocking
    //     the whole faction from targets their holder had already converted.
    //
    // Distinguishing the two needs the last hospital `until` remembered across
    // the Okay gap — a column on the claim, not a one-tick snapshot. Worth
    // doing if flicker turns out to bite in practice; not worth a migration
    // during a live war.
    //
    // Independent of #371, which fixed the flicker's effect on the DISPLAY.
    await seedDib({ state: 'Hospital', until: 1752200500 })
    let status: Record<string, unknown> = { state: 'Okay', until: null }
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload(status))

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    const ticker = createWarRoomTicker(tickerDeps())

    await ticker.tick()                                    // the spurious Okay
    status = { state: 'Hospital', until: 1752200500 }
    await ticker.tick()                                    // back to reality

    // Let the original deadline lapse, then bring them out for real.
    await stack.db.query(
      `UPDATE war_room_dibs_v2 SET auto_expire_at = now() - interval '5 seconds'
       WHERE target_id = ${TARGET} AND deleted_at IS NULL AND auto_expire_at IS NOT NULL`
    )
    status = { state: 'Okay', until: null }
    await ticker.tick()

    const dib = await stack.db.query(
      `SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`
    )
    expect(dib.rows[0].deleted_at).not.toBeNull()
  })

  it('#376 re-arming does not make a squatted claim immortal', async () => {
    // The guard on the fix: a holder who never converts must still lose the
    // claim. Re-arming only resets the window when the target's aliveness is
    // interrupted — a target who simply stays Okay runs one window to its end.
    await seedDib({ state: 'Hospital', until: 1752200500 })
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Okay', until: null }))

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    const ticker = createWarRoomTicker(tickerDeps())
    await ticker.tick()
    await stack.db.query(
      `UPDATE war_room_dibs_v2 SET auto_expire_at = now() - interval '1 second'
       WHERE target_id = ${TARGET} AND deleted_at IS NULL`
    )
    await ticker.tick()

    expect((await stack.db.query(
      `SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`
    )).rows[0].deleted_at).toBeTruthy()
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

  it('a re-claim inside the window carries no stale expiry — the fresh claim starts its own countdown', async () => {
    await seedDib({ state: 'Hospital', until: 1752200500 })
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Okay', until: null }))

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    const ticker = createWarRoomTicker(tickerDeps())
    await ticker.tick() // schedules a release on the current claim

    // The holder re-claims the same (now-Okay) target. The real write path
    // tombstones the scheduled row and inserts a fresh one — which, because the
    // target is alive, starts its OWN claim-timeout countdown (#159), never the
    // stale hospital-exit deadline.
    const reclaim = await fetch(`${stack.baseUrl}/api/war-room/dibs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target_id: TARGET }),
    })
    expect(reclaim.status).toBe(200)

    const fresh = await stack.db.query(
      `SELECT EXTRACT(EPOCH FROM (auto_expire_at - now())) AS secs
       FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`
    )
    expect(Number(fresh.rows[0].secs)).toBeGreaterThan(20)
    expect(Number(fresh.rows[0].secs)).toBeLessThanOrEqual(31)

    // A subsequent tick (target still Okay, window not yet lapsed) must not drop it.
    await ticker.tick()
    const dib = await stack.db.query(
      `SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`
    )
    expect(dib.rows).toHaveLength(1)
  })
})

// #159 — a dib on an already-alive target auto-releases N seconds after the
// claim if the holder still hasn't killed them. Seam: the real claim write
// path (which reads the target's stored status + the configurable window) plus
// the same per-tick sweep the #106/#107 rules ride.
describe('war-room dibs claim-timeout (#159)', () => {
  // Seed only the target's stored status (no dib) so the claim endpoint reads it.
  async function seedTargetStatus(status: Record<string, unknown>) {
    await stack.db.query(`DELETE FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`)
    await stack.db.query(
      `INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, level, state)
       VALUES (${TARGET}, ${ENEMY}, 'Foe', 55, $1)
       ON CONFLICT (member_id) DO UPDATE SET state = EXCLUDED.state, deleted_at = NULL, updated_at = now()`,
      [JSON.stringify({ status })]
    )
  }
  async function claim() {
    return fetch(`${stack.baseUrl}/api/war-room/dibs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target_id: TARGET }),
    })
  }

  it('claiming an alive (Okay) target starts the auto-drop countdown', async () => {
    await stack.db.query(`UPDATE war_room_config_v2 SET dibs_expiry_seconds = 30 WHERE id = 1`)
    await seedTargetStatus({ state: 'Okay', until: null })

    expect((await claim()).status).toBe(200)

    const dib = await stack.db.query(
      `SELECT deleted_at, EXTRACT(EPOCH FROM (auto_expire_at - now())) AS secs
       FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`
    )
    expect(dib.rows[0].deleted_at).toBeNull()
    expect(Number(dib.rows[0].secs)).toBeGreaterThan(20)
    expect(Number(dib.rows[0].secs)).toBeLessThanOrEqual(31)
  })

  it('honours the configurable window (a shorter dibs_expiry_seconds)', async () => {
    await stack.db.query(`UPDATE war_room_config_v2 SET dibs_expiry_seconds = 10 WHERE id = 1`)
    await seedTargetStatus({ state: 'Okay', until: null })

    expect((await claim()).status).toBe(200)

    const dib = await stack.db.query(
      `SELECT EXTRACT(EPOCH FROM (auto_expire_at - now())) AS secs
       FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`
    )
    expect(Number(dib.rows[0].secs)).toBeGreaterThan(5)
    expect(Number(dib.rows[0].secs)).toBeLessThanOrEqual(11)
    await stack.db.query(`UPDATE war_room_config_v2 SET dibs_expiry_seconds = 30 WHERE id = 1`)
  })

  it('claiming a target still in hospital sets no claim-time expiry (the exit window governs)', async () => {
    await seedTargetStatus({ state: 'Hospital', until: 1752209999 })

    expect((await claim()).status).toBe(200)

    const dib = await stack.db.query(
      `SELECT auto_expire_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`
    )
    expect(dib.rows[0].auto_expire_at).toBeNull()
  })

  it('drops the claim once the window lapses if the target is still alive, broadcasting the release', async () => {
    await seedTargetStatus({ state: 'Okay', until: null })
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Okay', until: null }))
    expect((await claim()).status).toBe(200)

    const client = await wsConnect(token)
    await client.next((m) => m.type === 'snapshot')

    // Advance the clock past the claim window.
    await stack.db.query(
      `UPDATE war_room_dibs_v2 SET auto_expire_at = now() - interval '1 second' WHERE target_id = ${TARGET} AND deleted_at IS NULL`
    )

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    await createWarRoomTicker(tickerDeps()).tick()

    const dib = await stack.db.query(`SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET}`)
    expect(dib.rows[0].deleted_at).toBeTruthy()
    const frame = await client.next(
      (m) => m.type === 'delta' && m.channel === 'dibs' && m.rows.some((r: any) => Number(r.target_id) === TARGET && r.deleted_at)
    )
    expect(frame.rows.some((r: any) => Number(r.target_id) === TARGET)).toBe(true)
    client.ws.close()
  })

  it('⚠️ RELEASES when the target goes down — a converted claim is spent', async () => {
    // ⚠️ This REVERSES the original #159 rule, which kept the claim when the
    // holder converted so they could farm the same target. MonChoon, mid-war
    // 2026-10-03: that made every successful hit a permanent reservation.
    //
    // The loop it created: out of hospital → #106 arms 30s → holder hits →
    // back to hospital → #376 disarms the countdown → claim held → repeat.
    // Nothing in the sweep ever released it. Observed live on forge: 20 of 22
    // claims parked on hospitalised targets, most naming the holder in
    // "Attacked by", the oldest held 33 minutes.
    await seedTargetStatus({ state: 'Okay', until: null })
    expect((await claim()).status).toBe(200)

    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Hospital', until: 1752209999 }))

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    await createWarRoomTicker(tickerDeps()).tick()

    const dib = await stack.db.query(`SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`)
    expect(dib.rows).toHaveLength(0)
  })

  it('releases on a hit regardless of who landed it', async () => {
    // The claim's job is done either way: the target is down. Whether the
    // holder converted or somebody else sniped them changes nothing about
    // whether the claim should still be blocking the target.
    await seedTargetStatus({ state: 'Okay', until: null })
    expect((await claim()).status).toBe(200)
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () =>
      enemyPayload({ state: 'Hospital', until: 1752209999, details: 'Attacked by SomebodyElse' }))

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    await createWarRoomTicker(tickerDeps()).tick()

    const dib = await stack.db.query(`SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`)
    expect(dib.rows).toHaveLength(0)
  })

  it('⚠️ the full war loop: hospital → out → hit → hospital frees the target', async () => {
    // The sequence from the report, end to end. Before the fix this ended with
    // the claim still held and the countdown disarmed, so the next hospital
    // exit re-armed it and the holder kept the target indefinitely.
    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')

    // 1. Claimed while the target is in hospital — a reservation, no countdown.
    await seedTargetStatus({ state: 'Hospital', until: 1752200000 })
    expect((await claim()).status).toBe(200)

    // 2. They surface. #106 arms the window; the claim survives.
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Okay', until: null }))
    await createWarRoomTicker(tickerDeps()).tick()
    let dib = await stack.db.query(`SELECT auto_expire_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`)
    expect(dib.rows).toHaveLength(1)
    expect(dib.rows[0].auto_expire_at).not.toBeNull()

    // 3. The holder hits them. The claim is spent — target is free again.
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Hospital', until: 1752209999 }))
    await createWarRoomTicker(tickerDeps()).tick()
    dib = await stack.db.query(`SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = ${TARGET} AND deleted_at IS NULL`)
    expect(dib.rows).toHaveLength(0)
  })
})

describe('auto-drop can be turned off entirely', () => {
  // ⚠️ 0 has to mean "claims stand until released or the target is
  // hospitalised". The danger in getting this wrong is not a no-op: clamping
  // 0 up to the 5s floor — which is what the bounds table did before — would
  // have dropped every dib five seconds after it was taken, mid-war, with no
  // indication why.

  it('⚠️ does not even query the database when the window is 0', async () => {
    // Asserted by making a query fatal. A sweep that returned [] only after
    // reading every live dib would still be wrong under load, and the early
    // return is the thing worth pinning.
    const exploding = {
      query: () => { throw new Error('sweepDibsExpiry must not query when auto-drop is off') },
    } as unknown as Parameters<typeof sweepDibsExpiry>[0]

    await expect(sweepDibsExpiry(exploding, new Map(), 0)).resolves.toEqual([])
    await expect(sweepDibsExpiry(exploding, new Map(), -1)).resolves.toEqual([])
  })
})

// #523: the ticker wiring itself (not just the sweepAssistsExpiry unit,
// covered in war-room-assists-expiry.test.ts) — same fixture, same TARGET, to
// confirm the roster-sync tick actually calls the assist sweep and broadcasts
// on the 'assist' channel, the way it already does for dibs above.
describe('assist-request sweep rides the same ticker tick as the dibs sweep', () => {
  it('drops a live assist on the tick that observes the target enter hospital', async () => {
    await stack.db.query(`DELETE FROM war_room_assist_counts_v2 WHERE target_id = ${TARGET}`)
    await stack.db.query(
      `INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, level, state)
       VALUES (${TARGET}, ${ENEMY}, 'Foe', 55, $1)
       ON CONFLICT (member_id) DO UPDATE SET state = EXCLUDED.state, deleted_at = NULL, updated_at = now()`,
      [JSON.stringify({ status: { state: 'Okay', until: null } })]
    )
    await stack.db.query(
      `INSERT INTO war_room_assist_counts_v2 (target_id, help_wanted, help_raised_at)
       VALUES (${TARGET}, 2, now())`
    )
    stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload({ state: 'Hospital', until: 1752209999 }))

    const client = await wsConnect(token)
    await client.next((m) => m.type === 'snapshot')

    const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
    await createWarRoomTicker(tickerDeps()).tick()

    // #617: an expired request is a count back at zero, not a tombstone.
    const row = await stack.db.query(`SELECT help_wanted FROM war_room_assist_counts_v2 WHERE target_id = ${TARGET}`)
    expect(Number(row.rows[0].help_wanted)).toBe(0)
    const frame = await client.next(
      (m) => m.type === 'delta' && m.channel === 'assist'
        && m.rows.some((r: any) => Number(r.target_id) === TARGET && Number(r.help_wanted) === 0)
    )
    expect(frame.rows.some((r: any) => Number(r.target_id) === TARGET)).toBe(true)

    client.ws.close()
  })
})
