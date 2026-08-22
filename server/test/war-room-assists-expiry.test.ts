// Assist-request auto-expiry (#523). Unlike war-room-dibs-expiry.test.ts this
// drives snapshotAssistedStatus/sweepAssistsExpiry directly against real
// templated Postgres rather than through the full ticker — the module has no
// dependency on the Torn fixture or the key pool, only on the two tables it
// reads and writes, so the lighter seam is the honest one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { snapshotAssistedStatus, sweepAssistsExpiry, ASSIST_EXPIRY_SECONDS } from '../src/warRoomAssistsExpiry.js'

let stack: TestStack
const TARGET = 90940
const REQUESTER = 1900

async function setTargetStatus(status: Record<string, unknown> | null) {
  await stack.db.query(
    `INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, level, state)
     VALUES ($1, 90941, 'Foe', 50, $2)
     ON CONFLICT (member_id) DO UPDATE SET state = EXCLUDED.state, deleted_at = NULL, updated_at = now()`,
    [TARGET, JSON.stringify({ status })]
  )
}

async function seedAssist(kind = 'smoke', autoExpireInSec: number | null = ASSIST_EXPIRY_SECONDS) {
  await stack.db.query(`DELETE FROM war_room_assists_v2 WHERE target_id = ${TARGET}`)
  await stack.db.query(
    `INSERT INTO war_room_assists_v2 (target_id, requester_id, requester_name, kind, auto_expire_at)
     VALUES ($1, $2, 'Requester', $3,
       CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(secs => $4::int) END)`,
    [TARGET, REQUESTER, kind, autoExpireInSec]
  )
}

beforeAll(async () => {
  stack = await startTestStack()
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('assist-request auto-expiry', () => {
  it('leaves a fresh assist alone: unexpired deadline, target still Okay', async () => {
    await setTargetStatus({ state: 'Okay', until: null })
    await seedAssist()
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Okay', until: null })
    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired).toHaveLength(0)
    const row = await stack.db.query(`SELECT deleted_at FROM war_room_assists_v2 WHERE target_id = ${TARGET}`)
    expect(row.rows[0].deleted_at).toBeNull()
  })

  it('drops the assist the instant the target goes into hospital — the fight ended', async () => {
    await setTargetStatus({ state: 'Okay', until: null })
    await seedAssist()
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Hospital', until: 1_800_000_000 })

    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired.some((r: any) => Number(r.target_id) === TARGET)).toBe(true)
    const row = await stack.db.query(`SELECT deleted_at FROM war_room_assists_v2 WHERE target_id = ${TARGET}`)
    expect(row.rows[0].deleted_at).toBeTruthy()
  })

  it('does not treat an assist raised while already hospitalised as a fresh fight-end', async () => {
    // Two consecutive ticks both see Hospital — no transition, so the
    // short-timeout backstop is what governs this row, not the fight-end rule.
    await setTargetStatus({ state: 'Hospital', until: 1_800_000_000 })
    await seedAssist()
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Hospital', until: 1_800_000_100 })

    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired).toHaveLength(0)
    const row = await stack.db.query(`SELECT deleted_at FROM war_room_assists_v2 WHERE target_id = ${TARGET}`)
    expect(row.rows[0].deleted_at).toBeNull()
  })

  it('drops the assist once the short timeout lapses, regardless of target status', async () => {
    await setTargetStatus({ state: 'Okay', until: null })
    await seedAssist('help', -1) // already-lapsed deadline
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Okay', until: null })

    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired.some((r: any) => Number(r.target_id) === TARGET && r.kind === 'help')).toBe(true)
  })

  it('leaves an assist with no deadline (NULL auto_expire_at) alone on the timeout path', async () => {
    await setTargetStatus({ state: 'Okay', until: null })
    await seedAssist('tear', null)
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Okay', until: null })

    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired).toHaveLength(0)
  })
})
