// Enemy loadout observation retention (#528 Part 2): a real prune, not just a
// described window — hard-deletes past LOADOUT_RETENTION_DAYS. Job seam
// against the templated Postgres, same shape as feedback-prune.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { pruneLoadoutObservations } from '../src/warRoomLoadout.js'

let stack: TestStack

beforeAll(async () => {
  stack = await startTestStack()
}, 30000)

afterAll(async () => {
  await stack?.close()
})

async function seedObservation(targetId: number, observedAt: string) {
  const res = await stack.db.query(
    `INSERT INTO war_room_loadout_observations_v2
       (target_id, observed_by, observed_by_name, loadout, observed_at)
     VALUES ($1, 1, 'Scout', $2, $3) RETURNING id`,
    [targetId, JSON.stringify({ weapons: { primary: { name: 'AK-47' } }, armor: {} }), observedAt]
  )
  return res.rows[0].id as string
}

describe('pruneLoadoutObservations (#528 Part 2)', () => {
  it('deletes observations past the retention window and keeps recent ones', async () => {
    const recentId = await seedObservation(90400, new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString())
    const oldId = await seedObservation(90401, new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString())

    const result = await pruneLoadoutObservations(stack.db, 30)
    expect(result.pruned).toBeGreaterThanOrEqual(1)
    expect(result.retentionDays).toBe(30)

    const remaining = await stack.db.query(
      'SELECT id FROM war_room_loadout_observations_v2 WHERE id = ANY($1)',
      [[recentId, oldId]]
    )
    const ids = remaining.rows.map((r) => r.id)
    expect(ids).toContain(recentId)
    expect(ids).not.toContain(oldId)
  })

  it('defaults to LOADOUT_RETENTION_DAYS when no window is given', async () => {
    const { LOADOUT_RETENTION_DAYS } = await import('../src/warRoomLoadout.js')
    const result = await pruneLoadoutObservations(stack.db)
    expect(result.retentionDays).toBe(LOADOUT_RETENTION_DAYS)
  })
})
