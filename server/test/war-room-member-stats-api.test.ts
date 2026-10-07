// Live member energy/cooldowns end-to-end (#336): the war-lead gate on the
// read path, and the sweep's persistence behaviour against a real database.
//
// The gate is the reason this data lives in its own table and its own delta
// channel. Hiding the columns in the UI would still ship every member's energy
// and drug state to every browser, because the hub serialises one frame and
// fans it out — so these tests assert the SERVER withholds it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { sweepMemberStats, pruneMemberStats } from '../src/warRoomMemberStats.js'

let stack: TestStack
const tokens: Record<string, string> = {}

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

async function delta(as: string) {
  const res = await fetch(`${stack.baseUrl}/api/war-room/delta`, {
    headers: { authorization: `Bearer ${tokens[as]}` },
  })
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, tier, is_current) VALUES
       ('1700', 'Lead', 2, true), ('1701', 'Grunt', 2, true),
       ('1702', 'Boss', 2, true), ('1703', 'Guest', 2, true)`
  )
  await loginAs('warlead', '1700', ['warlead'])
  await loginAs('member', '1701', [])
  await loginAs('leadership', '1702', ['leadership'])
    // ⚠️ Was a `visitor` until #922 removed that role (2026-10-06). A plain
  // member is the faithful replacement: every assertion below says "this
  // actor must be refused", which is still true and still worth proving.
await loginAs('member', '1703', [])

  // One member's live stats, as the sweep would have written them.
  await stack.db.query(
    `INSERT INTO war_room_member_stats_v2
       (member_id, energy_current, energy_maximum, cooldown_drug, cooldown_medical, cooldown_booster, fetched_at)
     VALUES (1700, 120, 150, 40000, 0, 3600, now())`
  )
})

afterAll(async () => { await stack?.close() })

describe('GET /api/war-room/delta — war-lead gate on live member stats', () => {
  it('gives a war lead the member stats rows', async () => {
    const { status, body } = await delta('warlead')
    expect(status).toBe(200)
    expect(body.memberstats.rows).toHaveLength(1)
    expect(body.memberstats.rows[0]).toMatchObject({
      member_id: 1700, energy_current: 120, cooldown_drug: 40000,
    })
  })

  it('gives leadership the member stats rows', async () => {
    const { body } = await delta('leadership')
    expect(body.memberstats.rows).toHaveLength(1)
  })

  it('withholds them from an ordinary member', async () => {
    // The whole point: an authenticated non-lead gets a well-formed response
    // with the channel EMPTY, not a 403 and not the data.
    const { status, body } = await delta('member')
    expect(status).toBe(200)
    expect(body.memberstats.rows).toEqual([])
    // …while still receiving the public channels, so the board works for them.
    expect(body).toHaveProperty('state')
    expect(body).toHaveProperty('chain')
  })

  it('withholds them from a visitor even though visitors see the war room', async () => {
    const { body } = await delta('member')
    expect(body.memberstats.rows).toEqual([])
  })

  it('leaks nothing about member stats anywhere else in a non-lead response', async () => {
    // Guards against a future change that filters the channel but leaves the
    // numbers reachable through some other key in the same payload.
    const { body } = await delta('member')
    expect(JSON.stringify(body)).not.toContain('40000')
  })

  it('rejects an unauthenticated caller outright', async () => {
    const res = await fetch(`${stack.baseUrl}/api/war-room/delta`)
    expect(res.status).toBe(401)
  })
})

describe('sweepMemberStats', () => {
  const okClient = {
    async fetch(_path: string, key: string) {
      if (key === 'BADKEY') throw new Error('Incorrect key')
      return {
        energy: { current: 55, maximum: 150 },
        cooldowns: { drug: 900, medical: 120, booster: 7200 },
      }
    },
  }

  it('upserts a row per member and returns the changed rows', async () => {
    const changed = await sweepMemberStats(stack.db, okClient, [
      { member_id: '1701', key: 'GOODKEY1701AAAA' },
    ])
    expect(changed).toHaveLength(1)
    const res = await stack.db.query(
      'SELECT * FROM war_room_member_stats_v2 WHERE member_id = 1701'
    )
    expect(res.rows[0]).toMatchObject({
      energy_current: 55, energy_maximum: 150,
      cooldown_drug: 900, cooldown_medical: 120, cooldown_booster: 7200,
      last_error: null,
    })
  })

  it('records a failing key without losing the rest of the sweep', async () => {
    // One revoked key must not cost every other member their stats.
    const changed = await sweepMemberStats(stack.db, okClient, [
      { member_id: '1702', key: 'BADKEY' },
      { member_id: '1703', key: 'GOODKEY1703AAAA' },
    ])
    expect(changed).toHaveLength(2)
    const bad = await stack.db.query('SELECT * FROM war_room_member_stats_v2 WHERE member_id = 1702')
    expect(bad.rows[0].last_error).toContain('Incorrect key')
    expect(bad.rows[0].energy_current).toBeNull()
    // fetched_at still advances — otherwise a roster of broken keys would
    // re-sweep on every tick forever.
    expect(bad.rows[0].fetched_at).not.toBeNull()

    const good = await stack.db.query('SELECT * FROM war_room_member_stats_v2 WHERE member_id = 1703')
    expect(good.rows[0].energy_current).toBe(55)
  })

  it('clears a previous error once the key works again', async () => {
    await sweepMemberStats(stack.db, okClient, [{ member_id: '1702', key: 'GOODKEY1702AAAA' }])
    const res = await stack.db.query('SELECT * FROM war_room_member_stats_v2 WHERE member_id = 1702')
    expect(res.rows[0].last_error).toBeNull()
    expect(res.rows[0].energy_current).toBe(55)
  })
})

describe('pruneMemberStats', () => {
  it('drops rows for members who are no longer enrolled', async () => {
    // A departed member's last-known energy must not linger on the board.
    await pruneMemberStats(stack.db, ['1700', '1701'])
    const res = await stack.db.query('SELECT member_id FROM war_room_member_stats_v2 ORDER BY member_id')
    expect(res.rows.map((r: any) => String(r.member_id))).toEqual(['1700', '1701'])
  })
})

describe('PUT /api/war-room/config — member stats cadence', () => {
  async function put(payload: unknown, as = 'warlead') {
    const res = await fetch(`${stack.baseUrl}/api/war-room/config`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tokens[as]}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  it('stores 0 as off rather than clamping it up to the floor', async () => {
    const { status } = await put({ member_stats_poll_interval_sec: 0 })
    expect(status).toBe(200)
    const res = await stack.db.query('SELECT member_stats_poll_interval_sec FROM war_room_config_v2 WHERE id = 1')
    expect(res.rows[0].member_stats_poll_interval_sec).toBe(0)
  })

  it('floors an enabled cadence at 30s through the endpoint', async () => {
    await put({ member_stats_poll_interval_sec: 5 })
    const res = await stack.db.query('SELECT member_stats_poll_interval_sec FROM war_room_config_v2 WHERE id = 1')
    expect(res.rows[0].member_stats_poll_interval_sec).toBe(30)
  })

  it('defaults to off so the feature costs nothing until switched on', async () => {
    const res = await stack.db.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'war_room_config_v2'
          AND column_name = 'member_stats_poll_interval_sec'`
    )
    expect(res.rows[0].column_default).toContain('0')
  })
})

describe('key pool consent', () => {
  it('sweeps only keys that are enrolled and enabled', async () => {
    // listKeys() is the consent boundary: a member who never consented, or
    // whose key was disabled, is simply not in the list the sweep walks.
    const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
    await pool.store('1701', 'STATSKEY1701AAAA', { consentVersion: 'v2' })
    await stack.db.query('UPDATE member_secrets SET disabled = true WHERE member_id = $1', ['1701'])
    const keys = await pool.listKeys()
    expect(keys.map((k) => k.member_id)).not.toContain('1701')
  })
})
