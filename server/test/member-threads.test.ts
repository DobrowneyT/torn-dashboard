// What to queue into a member's Discord thread, and — far more importantly —
// what NOT to queue (#942).
//
// ⚠️ **The failure this file exists to prevent is a wrong permanent record.**
// Every row planned here becomes a message in a forum thread carrying one
// member's name, read by leadership. A duplicate join note says somebody
// joined twice; a backfilled one invents a date; a note for a member with no
// thread goes nowhere and is silently lost.
import { describe, expect, it } from 'vitest'
import {
  planThreadWork, OUTBOX_KINDS, stintSubject,
} from '../src/memberThreads.js'

/** Epoch ms, because that is what the planner compares. */
const T = (iso: string) => Date.parse(iso)

const INSTALL = T('2026-10-11T00:00:00Z')

const stint = (over: Partial<any> = {}) => ({
  id: 1, member_id: '873341', member_name: 'Goosey',
  joined_at: T('2026-10-12T10:00:00Z'), left_at: null, ...over,
})

const plan = (over: Partial<any> = {}) =>
  planThreadWork({ stints: [], installedAt: INSTALL, queued: new Set(), ...over })

describe('planThreadWork — joins', () => {
  it('queues a join note for a stint that started after install', () => {
    const work = plan({ stints: [stint()] })
    expect(work).toHaveLength(1)
    expect(work[0]).toMatchObject({
      member_id: '873341', kind: OUTBOX_KINDS.joined, subject: stintSubject(1),
    })
  })

  /**
   * ⚠️ THE no-backfill rule. MonChoon: *"dont worry about backfilling we can
   * start posting membership status starting now."* The roster at install is
   * ~94 people whose real join dates nobody recorded — stints are only observed
   * from #284 onward. Queuing them would write an invented date into a
   * permanent record, and create 94 threads in one burst.
   */
  it('⚠️ queues nothing for a stint that predates install', () => {
    expect(plan({ stints: [stint({ joined_at: T('2026-09-01T00:00:00Z') })] })).toEqual([])
  })

  it('treats a stint starting exactly at install as pre-existing', () => {
    // The boundary belongs to the past: install is the moment we started
    // watching, not the first moment we claim to know about.
    expect(plan({ stints: [stint({ joined_at: INSTALL })] })).toEqual([])
  })

  /**
   * ⚠️ Idempotency. The sweep runs on a timer; without this every pass queues
   * another join note and the member's log reads like they joined hourly.
   */
  it('does not re-queue something already queued', () => {
    const queued = new Set([`873341|${OUTBOX_KINDS.joined}|${stintSubject(1)}`])
    expect(plan({ stints: [stint()], queued })).toEqual([])
  })

  it('carries the name as it was at queue time', () => {
    // ⚠️ Resolved now, not at post time: a rename between queueing and draining
    // would otherwise put the new name on a note about the old membership.
    const work = plan({ stints: [stint({ member_name: 'Gooseyyy' })] })
    expect(work[0].payload).toMatchObject({ member_name: 'Gooseyyy' })
  })
})

describe('planThreadWork — leaves', () => {
  const left = (over: Partial<any> = {}) => stint({
    joined_at: T('2026-10-12T10:00:00Z'), left_at: T('2026-10-20T10:00:00Z'), ...over,
  })

  it('queues a leave note when a stint closes after install', () => {
    const work = plan({ stints: [left()] })
    const kinds = work.map((w) => w.kind)
    expect(kinds).toContain(OUTBOX_KINDS.left)
  })

  it('queues BOTH notes for a stint that opened and closed between sweeps', () => {
    // A short-lived member is still a complete story, and the log should read
    // in order rather than skipping the arrival.
    const work = plan({ stints: [left()] })
    expect(work.map((w) => w.kind)).toEqual([OUTBOX_KINDS.joined, OUTBOX_KINDS.left])
  })

  /**
   * ⚠️ Somebody who joined BEFORE we started watching and leaves after. There
   * is no join note to pair it with, but the departure is still real and still
   * worth logging — and it is the one case where the no-backfill rule and the
   * "log what happens" rule pull against each other.
   */
  it('queues a leave for a pre-install member, without inventing a join', () => {
    const work = plan({ stints: [left({ joined_at: T('2026-09-01T00:00:00Z') })] })
    expect(work.map((w) => w.kind)).toEqual([OUTBOX_KINDS.left])
  })

  it('does not re-queue a leave already queued', () => {
    const queued = new Set([
      `873341|${OUTBOX_KINDS.joined}|${stintSubject(1)}`,
      `873341|${OUTBOX_KINDS.left}|${stintSubject(1)}`,
    ])
    expect(plan({ stints: [left()], queued })).toEqual([])
  })
})

describe('planThreadWork — rejoins', () => {
  /**
   * ⚠️ One running log per person. A rejoin is a SECOND stint for the same
   * member, and it must produce a second note in the SAME thread rather than a
   * second thread — which is why the subject is the stint, not the member.
   */
  it('queues a separate note per stint for a member who rejoined', () => {
    const work = plan({
      stints: [
        stint({ id: 1, joined_at: T('2026-10-12T10:00:00Z'), left_at: T('2026-10-13T10:00:00Z') }),
        stint({ id: 2, joined_at: T('2026-10-20T10:00:00Z') }),
      ],
    })
    expect(work).toHaveLength(3)   // join, leave, join
    expect(new Set(work.map((w) => w.subject)).size).toBe(2)
  })
})

describe('planThreadWork — shape', () => {
  it('returns nothing for an empty roster', () => {
    expect(plan()).toEqual([])
  })

  it('ignores a stint with no member id', () => {
    expect(plan({ stints: [stint({ member_id: null })] })).toEqual([])
  })

  /**
   * ⚠️ CHRONOLOGICAL, not joins-then-leaves.
   *
   * This test previously asserted the opposite — every join before every leave
   * — and that rule is wrong for exactly the case the feature exists to handle.
   * A batch holding a leave from an old stint and a join from a new one is a
   * REJOIN, and joins-first wrote "joined · joined · left" into the member's log
   * when what happened was join → leave → join. An integration test against
   * real rows caught what this unit test had enshrined.
   *
   * The drain posts in the order it receives, and this is a permanent log, so
   * the order is part of what it says.
   */
  it('⚠️ orders by when each event actually happened', () => {
    const work = plan({
      stints: [
        stint({ id: 1, joined_at: T('2026-10-12T10:00:00Z'), left_at: T('2026-10-13T10:00:00Z') }),
        stint({ id: 2, joined_at: T('2026-10-14T10:00:00Z') }),
      ],
    })
    expect(work.map((w) => w.kind)).toEqual([
      OUTBOX_KINDS.joined, OUTBOX_KINDS.left, OUTBOX_KINDS.joined,
    ])
  })

  it('interleaves two members by time rather than grouping by person', () => {
    const work = plan({
      stints: [
        stint({ id: 1, joined_at: T('2026-10-12T10:00:00Z'), left_at: T('2026-10-20T10:00:00Z') }),
        stint({ id: 2, member_id: '999', joined_at: T('2026-10-15T10:00:00Z') }),
      ],
    })
    expect(work.map((w) => `${w.member_id}:${w.kind}`)).toEqual([
      '873341:joined', '999:joined', '873341:left',
    ])
  })
})

// ⚠️ The note has to say WHEN, or the bot can only date it by when the sweep
// happened to run — the sweep's cadence rather than the event's, and a restart
// makes that arbitrarily wrong in a permanent log.
describe('the payload carries the moment it happened', () => {
  const stint = (over = {}) => ({
    id: 134, member_id: '3750187', member_name: 'Noellee',
    joined_at: 2_000, left_at: null, ...over,
  })

  it('a join note carries joined_at', () => {
    const [row] = planThreadWork({ stints: [stint()], installedAt: 1_000 })
    expect(row.payload.at).toBe(2_000)
  })

  it('a leave note carries left_at, NOT joined_at', () => {
    // They are different moments and the note is about the second one.
    const rows = planThreadWork({
      stints: [stint({ left_at: 5_000 })], installedAt: 1_000,
    })
    const left = rows.find((r) => r.kind === 'left')!
    expect(left.payload.at).toBe(5_000)
    const joined = rows.find((r) => r.kind === 'joined')!
    expect(joined.payload.at).toBe(2_000)
  })

  it('still carries the name resolved at queue time', () => {
    const [row] = planThreadWork({ stints: [stint()], installedAt: 1_000 })
    expect(row.payload.member_name).toBe('Noellee')
    expect(row.payload.stint_id).toBe(134)
  })
})
