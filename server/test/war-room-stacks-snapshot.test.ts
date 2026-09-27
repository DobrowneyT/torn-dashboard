// Pre-war stacks snapshot (#480). war_room_member_stats_v2 has no history —
// this is the only place "energy right before the war" survives past the
// next sweep. Seam: captureStacksSnapshotIfDue against a real embedded
// Postgres (the due-window and idempotency logic all lives in SQL).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { captureStacksSnapshotIfDue } from '../src/warRoomStacksSnapshot.js'

let stack: TestStack

beforeAll(async () => {
  stack = await startTestStack()
})

afterAll(async () => {
  await stack?.close()
})

beforeEach(async () => {
  await stack.db.query('DELETE FROM war_stacks_snapshot')
  await stack.db.query('DELETE FROM war_room_member_stats_v2')
  await stack.db.query('DELETE FROM war_room_config_v2')
  await stack.db.query('DELETE FROM ranked_wars')
  await stack.db.query("DELETE FROM members WHERE member_id LIKE '19%'")
})

async function seedWar(startAt: number) {
  await stack.db.query(
    `INSERT INTO ranked_wars (id, start_at, opponent_id, opponent_name) VALUES (900, $1, 9001, 'Stack Foes')`,
    [startAt]
  )
}

// matchedAgo is a Postgres interval literal (e.g. "2 hours") applied as
// `now() - interval matchedAgo` — kept as a raw expression rather than a bound
// param so the comparison happens entirely in SQL (see warRoomStacksSnapshot.ts
// for why: a JS-side Date parse of Postgres's own timestamptz text output is
// the exact bug #480 hit in warLifecycle.ts).
async function seedConfig(opts: {
  enabled?: boolean
  autoManaged?: boolean
  matchedAgo?: string
} = {}) {
  const { enabled = true, autoManaged = true, matchedAgo = '2 hours' } = opts
  await stack.db.query('INSERT INTO war_room_config_v2 (id) VALUES (1) ON CONFLICT (id) DO NOTHING')
  await stack.db.query(
    `UPDATE war_room_config_v2
        SET enabled = $1, auto_managed = $2, managed_war_id = 900,
            matched_detected_at = now() - interval '${matchedAgo}'
      WHERE id = 1`,
    [enabled, autoManaged]
  )
}

describe('captureStacksSnapshotIfDue', () => {
  it('does nothing when the war start is not within the minute before it', async () => {
    await seedWar(Math.floor(Date.now() / 1000) + 3600) // 1h out
    await seedConfig()
    const result = await captureStacksSnapshotIfDue(stack.db)
    expect(result.captured).toBe(false)
    expect((await stack.db.query('SELECT count(*)::int n FROM war_stacks_snapshot')).rows[0].n).toBe(0)
  })

  it('does nothing once the war has actually started', async () => {
    await seedWar(Math.floor(Date.now() / 1000) - 30) // started 30s ago
    await seedConfig()
    const result = await captureStacksSnapshotIfDue(stack.db)
    expect(result.captured).toBe(false)
  })

  it('does nothing for a disabled or manually-configured room', async () => {
    await seedWar(Math.floor(Date.now() / 1000) + 30)
    await seedConfig({ enabled: false })
    expect((await captureStacksSnapshotIfDue(stack.db)).captured).toBe(false)

    await seedConfig({ enabled: true, autoManaged: false })
    expect((await captureStacksSnapshotIfDue(stack.db)).captured).toBe(false)
  })

  it('captures every current, non-fallen member, keeps unknown apart from zero, scopes the OD flag to this war, and is idempotent', async () => {
    await stack.db.query(`
      INSERT INTO members (member_id, member_name, tier, is_current, is_fallen) VALUES
        ('19001', 'Reader',   3, true, false),
        ('19002', 'NoKey',    3, true, false),
        ('19003', 'Leaver',   3, false, false),
        ('19004', 'Fallen',   3, true, true)
    `)
    // 19001: readable, currently overdosed since AFTER the war was matched.
    await stack.db.query(`
      INSERT INTO war_room_member_stats_v2 (member_id, energy_current, energy_maximum, overdose_until, last_error)
      VALUES (19001, 140, 150, now() + interval '5 hours', NULL)
    `)
    // 19002 has no war_room_member_stats_v2 row at all — no pooled key ever
    // returned a reading.
    await seedWar(Math.floor(Date.now() / 1000) + 30)
    await seedConfig({ matchedAgo: '2 hours' })

    const result = await captureStacksSnapshotIfDue(stack.db)
    expect(result).toMatchObject({ captured: true, warId: 900, rows: 2 })

    const rows = await stack.db.query(
      'SELECT * FROM war_stacks_snapshot WHERE war_id = 900 ORDER BY member_id'
    )
    expect(rows.rows).toHaveLength(2) // 19001, 19002; 19003 (left) and 19004 (fallen) excluded

    const byId = Object.fromEntries(rows.rows.map((r: any) => [String(r.member_id), r]))
    expect(byId['19001']).toMatchObject({
      energy_current: 140, energy_maximum: 150, has_reading: true, od_flagged_prewar: true,
    })
    // No pooled key / no reading at all: unknown, not zero — has_reading
    // false, energy columns null rather than 0 (a blank cell in a spreadsheet
    // reads as zero, which would be a different, wrong claim).
    expect(byId['19002']).toMatchObject({
      energy_current: null, energy_maximum: null, has_reading: false, od_flagged_prewar: false,
    })

    // Idempotent: running again is a no-op, does not duplicate or overwrite.
    const again = await captureStacksSnapshotIfDue(stack.db)
    expect(again.captured).toBe(false)
    expect((await stack.db.query('SELECT count(*)::int n FROM war_stacks_snapshot WHERE war_id = 900')).rows[0].n).toBe(2)
  })

  it('captures who was AWAKE, and keeps "not recorded" apart from "never active"', async () => {
    // ⚠️ war_room_state_v2 is overwritten in place on every sweep, so the
    // capture is the ONLY moment this can be preserved. Miss it and the answer
    // is gone for that war permanently — which is exactly why snapshots taken
    // before these columns existed can never be backfilled.
    const laEpoch = Math.floor(Date.now() / 1000) - 120
    await stack.db.query(`
      INSERT INTO members (member_id, member_name, tier, is_current, is_fallen) VALUES
        ('19010', 'Awake',   3, true, false),
        ('19011', 'NoState', 3, true, false)
    `)
    await stack.db.query(
      `INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, state)
       VALUES (19010, 1, 'Awake', $1::jsonb)`,
      [JSON.stringify({ last_action: { timestamp: laEpoch }, status: { state: 'Okay' } })],
    )
    // 19011 has no war_room_state_v2 row — the ticker never saw them.
    await seedWar(Math.floor(Date.now() / 1000) + 30)
    await seedConfig({ matchedAgo: '2 hours' })

    await captureStacksSnapshotIfDue(stack.db)
    const rows = await stack.db.query(
      'SELECT * FROM war_stacks_snapshot WHERE war_id = 900 ORDER BY member_id')
    const byId = Object.fromEntries(rows.rows.map((r: any) => [String(r.member_id), r]))

    // ⚠️ A NUMBER, not a string: db.ts parses int8 with `Number(v)`. Epoch
    // seconds sit far below MAX_SAFE_INTEGER, so nothing is lost — but the
    // consumer must not be written expecting a string.
    expect(byId['19010']).toMatchObject({ last_action_epoch: laEpoch, status_state: 'Okay' })
    // ⚠️ NULL, not 0. Zero is a valid epoch and would render as "active in
    // 1970"; null is the only honest way to say we never saw them.
    expect(byId['19011'].last_action_epoch).toBeNull()
    expect(byId['19011'].status_state).toBeNull()
  })

  it('does not flag an OD that cleared before this war was matched (permanent latch, war-scoped answer)', async () => {
    await stack.db.query(`
      INSERT INTO members (member_id, member_name, tier, is_current, is_fallen) VALUES ('19005', 'StaleOD', 3, true, false)
    `)
    // overdose_until is in the PAST relative to when this war was matched —
    // a leftover from a much earlier, unrelated OD. overdose_until never
    // clears back to null (it's a permanent latch, #357), so without scoping
    // against matched_detected_at this would false-positive on every war
    // from here on, regardless of how long ago it actually happened.
    await stack.db.query(`
      INSERT INTO war_room_member_stats_v2 (member_id, energy_current, energy_maximum, overdose_until, last_error)
      VALUES (19005, 100, 150, now() - interval '2 hours', NULL)
    `)
    await seedWar(Math.floor(Date.now() / 1000) + 30)
    await seedConfig({ matchedAgo: '10 minutes' }) // matched AFTER the stale OD's overdose_until

    await captureStacksSnapshotIfDue(stack.db)
    const row = await stack.db.query('SELECT od_flagged_prewar FROM war_stacks_snapshot WHERE war_id = 900 AND member_id = 19005')
    expect(row.rows[0].od_flagged_prewar).toBe(false)
  })
})
