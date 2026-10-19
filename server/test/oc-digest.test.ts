// #1024 — the on-request digest and report, and the feed toggle.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { deriveTenantToken } from '../src/fleetMetricsAuth.js'
import { chainWatchScope } from '../../db/chainWatchTokenLib.mjs'
import { storeSnapshot, SNAPSHOT_CRIMES, SNAPSHOT_MEMBERS } from '../src/tornSnapshots.js'
import { ocSuggestionsJob } from '../src/scraper/jobs/ocSuggestionsJob.js'

const TOKEN = deriveTenantToken('chain-watch-secret-for-tests', chainWatchScope(TEST_FACTION.slug))
let stack: TestStack
const NOW = Math.floor(Date.now() / 1000)

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${stack.baseUrl}/api/internal/oc-watch${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  stack = await startTestStack(undefined, {}, { chainWatchToken: TOKEN })
  await stack.db.query(`INSERT INTO members (member_id, member_name, tier, is_current) VALUES
    ('9101','Ann',3,true),('9102','Ben',3,true),('9103','Cat',3,true),('9104','Dan',3,true)
    ON CONFLICT (member_id) DO NOTHING`)
  await stack.db.query(`INSERT INTO faction_settings (key, value) VALUES ('cpr_requirements', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ 'Break the Bank': { positions: { Robber: 60 } } })])
  await stack.db.query(`INSERT INTO member_cpr_v2 (member_id, crime_name, position_label, cpr_value) VALUES
    ('9103', 'Break the Bank', 'Robber', 75), ('9104', 'Break the Bank', 'Robber', 40),
    ('9102', 'Blast from the Past', 'Muscle', 90)`)
}, 60000)
afterAll(async () => { await stack?.close() })
beforeEach(async () => {
  await stack.db.query('DELETE FROM oc_suggestions')
  await stack.db.query(`DELETE FROM faction_settings WHERE key = 'oc_feed_kinds'`)
  await storeSnapshot(stack.db, SNAPSHOT_CRIMES, [
    { id: 1, name: 'Break the Bank', difficulty: 8, status: 'Recruiting', slots: [
      { position_info: { id: 'P1', label: 'Robber' }, user: null },
      { position_info: { id: 'P2', label: 'Muscle #1' }, user: { id: 9101, joined_at: NOW - 60, progress: 10 } }] },
  ])
  await storeSnapshot(stack.db, SNAPSHOT_MEMBERS, [9101, 9102, 9103, 9104].map((id) => ({ id, name: String(id), status: { state: 'Okay' } })))
})

describe('/oc digest', () => {
  it('counts supply per level and says when qualified members outnumber open seats', async () => {
    const { body } = await call('GET', '/digest')
    expect(body.members).toEqual({ current: 4, seated: 1, idle: 3 })
    expect(body.levels).toEqual([{ difficulty: 8, crimes: 1, open: 1, seated: 1, idle_qualified: 1 }])
    expect(body.start_next).toEqual([])        // one qualified (Cat), one seat
    expect(body.scope).toBeNull()
  })
})

describe('/oc report', () => {
  it('scores finished crews against their best arrangement, and names a failure\'s weakest heavy seat', async () => {
    await stack.db.query(`DELETE FROM crimes; DELETE FROM crime_slots`)
    await stack.db.query(`INSERT INTO crimes (crime_id, name, difficulty, status, executed_at) VALUES
      ('c1', 'Blast from the Past', 7, 'Failure', $1)`, [NOW - 3600])
    // Muscle (P5, the heaviest) held by Ann at 50; Ben, who reads 90 at Muscle, sat in Picklock #2 (P6).
    const seats = [['Picklock', 'P1', 1, 70, '9201'], ['Hacker', 'P2', 1, 70, '9202'], ['Engineer', 'P3', 1, 70, '9203'],
      ['Bomber', 'P4', 1, 70, '9204'], ['Muscle', 'P5', 1, 50, '9101'], ['Picklock', 'P6', 2, 60, '9102']]
    for (const [pos, pid, num, cpr, uid] of seats) {
      await stack.db.query(`INSERT INTO crime_slots (crime_id, position, position_id, position_number, checkpoint_pass_rate, user_id, user_name)
        VALUES ('c1', $1, $2, $3, $4, $5, $5)`, [pos, pid, num, cpr, uid])
    }
    await stack.db.query(`INSERT INTO member_cpr_v2 (member_id, crime_name, position_label, cpr_value) VALUES
      ('9101', 'Blast from the Past', 'Picklock #2', 55) ON CONFLICT DO NOTHING`)
    const { body } = await call('GET', '/report?days=7')
    expect(body).toMatchObject({ days: 7, finished: 1, failed: 1, analysed: 1, could_have_seated_better: 1 })
    expect(body.biggest_gaps[0].moves).toEqual(['9101: Muscle → Picklock #2', '9102: Picklock #2 → Muscle'])
    expect(body.failures[0].weakest).toMatchObject({ label: 'Muscle', member_id: '9101', cpr: 50 })
    expect(body.average_efficiency).toBeLessThan(100)
  })
})

describe('/oc feed', () => {
  it('a kind switched off is not produced, and what it had open closes as "Turned off"', async () => {
    await ocSuggestionsJob({ db: stack.db } as any)
    expect((await stack.db.query(`SELECT count(*)::int AS n FROM oc_suggestions WHERE kind = 'idle' AND status = 'open'`)).rows[0].n).toBeGreaterThan(0)
    const r = await call('POST', '/feed-kinds', { kind: 'idle', enabled: false })
    expect(r.body.kinds).toEqual({ swap: true, too_low: true, idle: false })
    await ocSuggestionsJob({ db: stack.db } as any)
    const rows = (await stack.db.query(`SELECT status, close_reason FROM oc_suggestions WHERE kind = 'idle'`)).rows
    expect(rows.every((x: any) => x.status === 'expired' && x.close_reason === 'Turned off')).toBe(true)
    expect((await call('POST', '/feed-kinds', { kind: 'all', enabled: true })).body.kinds.idle).toBe(true)
    expect((await call('POST', '/feed-kinds', { kind: 'nope', enabled: true })).status).toBe(400)
  })
})
