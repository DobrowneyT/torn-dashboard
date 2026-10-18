// #997 — a dibs claim stores the FF the holder's page showed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let token: string
const ENEMY = 90060
let target = 90600

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('1901', 'Gekents', 3, true)
     ON CONFLICT (member_id) DO NOTHING`)
  stack.torn.addKey('FFDIBSKEY1901AAA', { id: '1901', factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'FFDIBSKEY1901AAA' }),
  })
  token = ((await res.json()) as any).token
  await stack.db.query(
    `INSERT INTO war_room_config_v2 (id, enabled, faction_id, faction_name, auto_managed, dibs_expiry_seconds)
     VALUES (1, true, ${ENEMY}, 'Foes', false, 30)
     ON CONFLICT (id) DO UPDATE SET enabled = true, faction_id = ${ENEMY}, auto_managed = false`)
}, 60000)
afterAll(async () => { await stack?.close() })

async function claim(body: Record<string, unknown>) {
  const id = target++
  const res = await fetch(`${stack.baseUrl}/api/war-room/dibs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ target_id: id, ...body }),
  })
  expect(res.status).toBe(200)
  return (await stack.db.query(
    `SELECT ff_shown::float8 AS ff, ff_shown_estimated AS est FROM war_room_dibs_v2 WHERE target_id = $1`, [id])).rows[0]
}

describe('dibs claim — FF shown (#997)', () => {
  it('stores the true FF the holder saw, and whether it was an estimate', async () => {
    expect(await claim({ ff_shown: 1.5, ff_estimated: true })).toEqual({ ff: 1.5, est: true })
    expect(await claim({ ff_shown: 4.27, ff_estimated: false })).toEqual({ ff: 4.27, est: false })
  })

  it('⚠️ stores null — never a guess — when the page sent nothing', async () => {
    expect(await claim({})).toEqual({ ff: null, est: null })
  })

  it('refuses nonsense rather than storing it against a member', async () => {
    expect(await claim({ ff_shown: 'abc' })).toEqual({ ff: null, est: null })
    expect(await claim({ ff_shown: 0.2 })).toEqual({ ff: null, est: null })
    expect(await claim({ ff_shown: 1e9 })).toEqual({ ff: null, est: null })
  })
})
