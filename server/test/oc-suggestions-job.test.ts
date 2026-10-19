// #1022 / #1023 — the producer job end to end against real Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { storeSnapshot, SNAPSHOT_CRIMES, SNAPSHOT_MEMBERS } from '../src/tornSnapshots.js'
import { ocSuggestionsJob } from '../src/scraper/jobs/ocSuggestionsJob.js'

let stack: TestStack
const NOW = Math.floor(Date.now() / 1000)
const deps = () => ({ db: stack.db }) as any

const crimes = () => [
  { id: 11, name: 'Pet Project', difficulty: 1, status: 'Recruiting', ready_at: NOW + 3600, slots: [
    { position_info: { label: 'Kidnapper' }, user: { id: 8101, joined_at: NOW - 300 } },
    { position_info: { label: 'Muscle' }, user: null }] },
  { id: 12, name: 'Blast from the Past', difficulty: 7, status: 'Recruiting', ready_at: NOW + 3600, slots: [
    { position_info: { label: 'Hacker' }, user: null }] },
]

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO members (member_id, member_name, tier, is_current) VALUES
    ('8101', 'Alice', 3, true), ('8102', 'Dee', 3, true) ON CONFLICT (member_id) DO NOTHING`)
  await stack.db.query(`INSERT INTO member_cpr_v2 (member_id, crime_name, position_label, cpr_value) VALUES
    ('8101', 'Blast from the Past', 'Hacker', 74)`)
  await stack.db.query(`INSERT INTO faction_settings (key, value) VALUES ('cpr_requirements', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ 'Blast from the Past': { positions: { Hacker: 70 } } })])
}, 60000)

afterAll(async () => { await stack?.close() })

beforeEach(async () => {
  await stack.db.query('DELETE FROM oc_suggestions')
  await stack.db.query('DELETE FROM torn_live_snapshots')
  await storeSnapshot(stack.db, SNAPSHOT_CRIMES, crimes())
  await storeSnapshot(stack.db, SNAPSHOT_MEMBERS, [{ id: 8101, name: 'Alice', status: { state: 'Okay' } },
    { id: 8102, name: 'Dee', status: { state: 'Okay' } }])
})

const open = async () => (await stack.db.query(
  `SELECT key, kind, status, body FROM oc_suggestions ORDER BY key`)).rows

describe('oc-suggestions job', () => {
  it('raises "joined too low" and "not in an OC" from the stored data', async () => {
    const res = await ocSuggestionsJob(deps())
    expect(res.details).toMatchObject({ too_low: { live: 1 }, idle: { live: 1 } })
    const rows = await open()
    expect(rows.map((r: any) => `${r.key}:${r.status}`)).toEqual(['idle:8102:open', 'too_low:8101:11:open'])
    expect(rows[1].body).toContain('CPR 74, clears the bar of 70')
  })

  it('a member moving up resolves their suggestion', async () => {
    await ocSuggestionsJob(deps())
    const moved = crimes()
    moved[0].slots[0].user = null
    moved[1].slots[0].user = { id: 8101, joined_at: NOW }
    await storeSnapshot(stack.db, SNAPSHOT_CRIMES, moved)
    await ocSuggestionsJob(deps())
    expect((await open()).find((r: any) => r.key === 'too_low:8101:11')).toMatchObject({ status: 'resolved' })
  })

  it('does nothing on a stale crimes snapshot rather than expiring everything', async () => {
    await ocSuggestionsJob(deps())
    await stack.db.query(`UPDATE torn_live_snapshots SET fetched_at = now() - interval '10 minutes' WHERE kind = 'faction_crimes_available'`)
    const res = await ocSuggestionsJob(deps())
    expect(res.details).toMatchObject({ skipped: expect.stringContaining('stale') })
    expect((await open()).every((r: any) => r.status === 'open')).toBe(true)
  })
})
