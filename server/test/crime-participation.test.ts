// #168 — per-(crime, member) participation log. Seam: run
// updateCrimeParticipation against real templated Postgres and assert the
// segment transitions (open on join, close on leave, complete on execute,
// left-early when the crime executes without a member).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { updateCrimeParticipation, type ParticipationCrime } from '../src/scraper/jobs/crimeParticipation.js'

let stack: TestStack

async function run(crime: ParticipationCrime) {
  const c = await stack.db.connect()
  try { await updateCrimeParticipation(c, crime) } finally { c.release() }
}

async function seg(crimeId: string, memberId: string) {
  const r = await stack.db.query(
    'SELECT joined_at, left_at, completed FROM crime_participation_v2 WHERE crime_id = $1 AND member_id = $2',
    [crimeId, memberId]
  )
  return r.rows[0] ?? null
}

const slot = (id: number, joined: number) => ({ user: { id, joined_at: joined } })

beforeAll(async () => { stack = await startTestStack() }, 30000)
afterAll(async () => { await stack?.close() })

describe('crime participation log (#168)', () => {
  it('opens a segment for a current occupant, with the exact joined_at', async () => {
    await run({ id: 5001, status: 'Recruiting', slots: [slot(900, 1000)] })
    expect(await seg('5001', '900')).toMatchObject({ joined_at: 1000, left_at: null, completed: false })
  })

  it('keeps the segment open across an unchanged re-sync (idempotent)', async () => {
    await run({ id: 5001, status: 'Planning', slots: [slot(900, 1000)] })
    expect(await seg('5001', '900')).toMatchObject({ joined_at: 1000, left_at: null, completed: false })
  })

  it('closes the segment as left-early when the member leaves before execution', async () => {
    // 900 is gone while the crime is still in progress.
    await run({ id: 5001, status: 'Planning', slots: [] })
    const s = await seg('5001', '900')
    expect(s.completed).toBe(false)
    expect(Number(s.left_at)).toBeGreaterThan(0) // stamped ~now
  })

  it('marks a segment completed when the crime executes with the member present', async () => {
    await run({ id: 5002, status: 'Recruiting', slots: [slot(901, 2000)] })
    await run({ id: 5002, status: 'Executed', executed_at: 2500, slots: [slot(901, 2000)] })
    expect(await seg('5002', '901')).toMatchObject({ joined_at: 2000, left_at: 2500, completed: true })
  })

  it('banks left-early time when the crime executes WITHOUT a member who was in it', async () => {
    // 902 and 903 both join; the crime executes with only 903.
    await run({ id: 5003, status: 'Recruiting', slots: [slot(902, 3000), slot(903, 3000)] })
    await run({ id: 5003, status: 'Executed', executed_at: 3500, slots: [slot(903, 3000)] })

    // 903 completed it…
    expect(await seg('5003', '903')).toMatchObject({ left_at: 3500, completed: true })
    // …902 left before it executed → banked, not completed, bounded at execution.
    expect(await seg('5003', '902')).toMatchObject({ left_at: 3500, completed: false })
  })

  it('does not reopen or double-count a member who already left', async () => {
    // A later sync of the resolved crime must not resurrect 902's open segment.
    await run({ id: 5003, status: 'Executed', executed_at: 3500, slots: [slot(903, 3000)] })
    const rows = await stack.db.query('SELECT count(*)::int AS n FROM crime_participation_v2 WHERE crime_id = $1', ['5003'])
    expect(rows.rows[0].n).toBe(2) // still exactly 902 + 903
    expect(await seg('5003', '902')).toMatchObject({ completed: false, left_at: 3500 })
  })
})
