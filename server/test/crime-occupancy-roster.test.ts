// #1019 — the OC board's roster stays fresh even when activity-sample is off.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'
import { crimeOccupancyJob } from '../src/scraper/jobs/crimeOccupancy.js'

let stack: TestStack
const ENCRYPTION_KEY = 'd'.repeat(64)
const KEY = 'OCCUPANCYKEY0001'
let memberCalls = 0

const deps = () => ({
  db: stack.db,
  pool: createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY }),
  client: createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 200, perMs: 1000 } }),
  encryptionKey: ENCRYPTION_KEY,
}) as any

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO members (member_id, member_name, is_current) VALUES ('6001', 'Keyholder', true)`)
  const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
  await pool.store('6001', KEY, { consentVersion: 'v2' })
  stack.torn.addKey(KEY, { id: '6001', factionId: TEST_FACTION.tornFactionId })
  stack.torn.setFactionCrimes({ crimes: [{ id: 1, name: 'Pet Project', status: 'Recruiting', slots: [] }] })
  stack.torn.setHandler('/v2/faction/members', () => {
    memberCalls++
    return { members: [{ id: 6001, name: 'Keyholder', status: { state: 'Hospital', until: 1_900_000_000 } }] }
  })
})

afterAll(async () => { await stack?.close() })

beforeEach(async () => {
  memberCalls = 0
  await stack.db.query('DELETE FROM torn_live_snapshots')
})

describe('crime-occupancy keeps the OC board\'s roster fresh', () => {
  it('stores the crimes, and fetches the roster when none is stored', async () => {
    const res = await crimeOccupancyJob(deps())
    expect(res.details).toMatchObject({ roster_refreshed: true })
    const kinds = (await stack.db.query('SELECT kind FROM torn_live_snapshots ORDER BY kind')).rows.map((r: any) => r.kind)
    expect(kinds).toEqual(['faction_crimes_available', 'faction_members'])
    expect(memberCalls).toBe(1)
  })

  it('spends nothing while the stored roster is fresh — a running activity-sample costs no extra call', async () => {
    await crimeOccupancyJob(deps())
    const second = await crimeOccupancyJob(deps())
    expect(second.details).toMatchObject({ roster_refreshed: false })
    expect(memberCalls).toBe(1)
  })

  it('refreshes it once it is older than five minutes', async () => {
    await crimeOccupancyJob(deps())
    await stack.db.query(`UPDATE torn_live_snapshots SET fetched_at = now() - interval '6 minutes' WHERE kind = 'faction_members'`)
    expect((await crimeOccupancyJob(deps())).details).toMatchObject({ roster_refreshed: true })
    expect(memberCalls).toBe(2)
  })

  it('a roster failure never fails the occupancy poll', async () => {
    stack.torn.setHandler('/v2/faction/members', () => ({ error: { code: 5, error: 'Too many requests' } }))
    const res = await crimeOccupancyJob(deps())
    expect(res.details).toMatchObject({ roster_refreshed: false, crimes_seen: 1 })
  })
})
