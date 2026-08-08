// Travel departure latch (#330). Torn gives no arrival time for a traveller —
// `status.until` is null — so the ETA is derived, and deriving it needs the one
// thing the API never reports: when they took off. The roster sync latches the
// moment it OBSERVES the transition into Traveling.
//
// The rules that matter, and why each one is here:
//   • a member first seen already airborne gets NULL (we missed the departure)
//   • a witnessed take-off gets stamped
//   • a stamp survives every subsequent poll while they stay airborne
//   • landing clears it
//   • a transition seen after a long blind spell is NOT trusted — that is the
//     case that would produce a confidently wrong arrival time
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { syncWarRoomMemberStates } from '../src/warRoomTicker.js'

let stack: TestStack
const OUR = Number(TEST_FACTION.tornFactionId)
const ENEMY = 90077
const MEMBER = 5501

let enemyMembers: any[] = []

const client = {
  async fetch(path: string) {
    if (path.includes(`/faction/${ENEMY}/members`)) return { members: enemyMembers }
    return { members: [] }
  },
}

function member(status: Record<string, unknown>) {
  return {
    id: MEMBER,
    name: 'Flyer',
    level: 50,
    position: 'Member',
    status,
    is_revivable: false,
    has_early_discharge: false,
    is_in_oc: false,
    is_on_wall: false,
    revive_setting: 'No one',
  }
}

const OKAY = { description: 'Okay', details: null, state: 'Okay', until: null }
const FLYING = {
  description: 'Traveling from Torn to Switzerland',
  details: null,
  state: 'Traveling',
  until: null,
  plane_image_type: 'airliner',
}
const ABROAD = { description: 'In Switzerland', details: null, state: 'Abroad', until: null }

async function sync() {
  return syncWarRoomMemberStates(stack.db, client as any, 'KEY', ENEMY, OUR)
}

// The API serves timestamptz as text (see parseDbTime, #140), so this comes
// back as a string rather than a Date.
async function departedAt(): Promise<string | null> {
  const res = await stack.db.query(
    'SELECT travel_departed_at FROM war_room_state_v2 WHERE member_id = $1', [MEMBER]
  )
  return res.rows[0]?.travel_departed_at ?? null
}

/**
 * Seconds between the stored departure stamp and now.
 *
 * Postgres renders the offset as a bare "-05", which Date.parse rejects
 * outright — the same trap that made spy ages show a dash in #140. Pad it to
 * "-05:00" before parsing.
 */
function ageOf(stamp: string | null): number {
  const iso = String(stamp).replace(/([+-]\d{2})$/, '$1:00')
  return (Date.now() - Date.parse(iso)) / 1000
}

/**
 * Backdate our last look at this member, simulating a gap in polling.
 *
 * The trigger has to come off first: `touch_updated_at_state_v2` is a BEFORE
 * UPDATE that forces updated_at = now() on every write, so a plain UPDATE here
 * is silently reverted and the test would pass for the wrong reason. (That
 * trigger is also why the freshness guard is sound in production — updated_at
 * genuinely is the last time we wrote this row.)
 */
async function ageLastLook(seconds: number) {
  await stack.db.query('ALTER TABLE war_room_state_v2 DISABLE TRIGGER touch_updated_at_state_v2')
  try {
    await stack.db.query(
      `UPDATE war_room_state_v2 SET updated_at = now() - ($2 || ' seconds')::interval
        WHERE member_id = $1`, [MEMBER, String(seconds)]
    )
  } finally {
    await stack.db.query('ALTER TABLE war_room_state_v2 ENABLE TRIGGER touch_updated_at_state_v2')
  }
}

beforeAll(async () => { stack = await startTestStack() })
afterAll(async () => { await stack?.close() })

async function reset(initial: Record<string, unknown>) {
  await stack.db.query('DELETE FROM war_room_state_v2 WHERE member_id = $1', [MEMBER])
  enemyMembers = [member(initial)]
  await sync()
}

describe('travel departure latch (#330)', () => {
  it('leaves it NULL for a member first seen already airborne', async () => {
    // We have no idea when they left, and a guess here becomes a wrong ETA on
    // screen. Absent beats wrong.
    await reset(FLYING)
    expect(await departedAt()).toBeNull()
  })

  it('stamps a take-off we actually witnessed', async () => {
    await reset(OKAY)
    expect(await departedAt()).toBeNull()

    enemyMembers = [member(FLYING)]
    await sync()
    const stamped = await departedAt()
    expect(stamped).not.toBeNull()
    expect(Math.abs(ageOf(stamped))).toBeLessThan(5)
  })

  it('keeps the same stamp across later polls while they stay airborne', async () => {
    // The upsert only fires when the state changes, but the value must survive
    // the polls that do touch the row — otherwise the countdown restarts.
    await reset(OKAY)
    enemyMembers = [member(FLYING)]
    await sync()
    const first = await departedAt()

    // A change that is not a landing: same flight, activity moved on.
    enemyMembers = [{ ...member(FLYING), level: 51 }]
    await sync()
    expect(await departedAt()).toBe(first)
  })

  it('clears the stamp on landing', async () => {
    await reset(OKAY)
    enemyMembers = [member(FLYING)]
    await sync()
    expect(await departedAt()).not.toBeNull()

    enemyMembers = [member(ABROAD)]
    await sync()
    expect(await departedAt()).toBeNull()
  })

  it('re-stamps the return leg', async () => {
    // Abroad → Traveling is a fresh departure, and the return takes as long as
    // the outbound, so it needs its own clock.
    await reset(ABROAD)
    enemyMembers = [member({ ...FLYING, description: 'Traveling from Switzerland to Torn' })]
    await sync()
    expect(await departedAt()).not.toBeNull()
  })

  it('refuses to trust a transition seen after a long blind spell', async () => {
    // THE case this guard exists for. War room disabled, roster cadence 0, or
    // the process restarted: the first tick back sees a member who "just"
    // became Traveling when they actually left hours ago. Stamping now() would
    // put a confidently wrong landing time on the board and a lead would wait
    // on it.
    await reset(OKAY)
    await ageLastLook(600)

    enemyMembers = [member(FLYING)]
    await sync()
    expect(await departedAt()).toBeNull()
  })

  it('still trusts a transition inside the freshness window', async () => {
    // The guard must not reject ordinary polling. Even a 60s roster cadence —
    // the slowest allowed — sits well inside the 120s allowance.
    await reset(OKAY)
    await ageLastLook(60)

    enemyMembers = [member(FLYING)]
    await sync()
    expect(await departedAt()).not.toBeNull()
  })

  it('stores the aircraft type, so the method is known without extra calls', async () => {
    // plane_image_type rides along in the faction-members payload we already
    // poll; this pins that we are not dropping it on the way into the jsonb.
    await reset(OKAY)
    enemyMembers = [member(FLYING)]
    await sync()
    const res = await stack.db.query(
      `SELECT state->'status'->>'plane_image_type' AS plane FROM war_room_state_v2 WHERE member_id = $1`,
      [MEMBER]
    )
    expect(res.rows[0].plane).toBe('airliner')
  })

  it('returns the stamp on the broadcast row, not just in the table', async () => {
    // The delta protocol ships whole rows; if the column were missing from the
    // RETURNING set the board would never see it.
    await reset(OKAY)
    enemyMembers = [member(FLYING)]
    const changed = await sync()
    const row: any = changed.find((r: any) => Number(r.member_id) === MEMBER)
    expect(row.travel_departed_at).toBeTruthy()
  })
})
