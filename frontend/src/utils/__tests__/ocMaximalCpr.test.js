// #691 — the maximal CPR vector: step 1 of the CPR algorithm (#688).
//
// The highest bar per role at which at least `n` members can still fill it,
// where `n` is the crime's role count. ⚠️ This is the CEILING of the search
// space, not the answer we publish — #692 descends from here.
import { describe, expect, it } from 'vitest'
import { maximalCprVector } from '../ocMaximalCpr'
import { maxDisjointCrews } from '../ocCrewMatching'

let nextId = 0
/**
 * `tiers` are [cpr, howMany] highest-first; the rest of `total` sits at `floor`.
 * Member ids are globally unique so a role's pool is independent of the others,
 * which is what step 1 assumes — it is a per-role question.
 */
const roleReadings = (total, tiers, floor = 50) => {
  const rows = []
  for (const [cpr, count] of tiers) {
    for (let i = 0; i < count; i += 1) rows.push({ member_id: String(++nextId), cpr })
  }
  while (rows.length < total) rows.push({ member_id: String(++nextId), cpr: floor })
  return rows
}

const POSITIONS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']

/**
 * Blast from the Past on forge, 2026-09-11 — the table from the algorithm
 * document, rebuilt so the solver has a known-good answer to hit.
 */
const BFTP = () => ({
  P1: roleReadings(92, [[90, 1], [87, 6]]),   // Picklock 1 — 7 @ 87, 1 @ 88
  P2: roleReadings(88, [[90, 4], [86, 3]]),   // Hacker     — 7 @ 86, 4 @ 87
  P3: roleReadings(92, [[90, 5], [85, 4]]),   // Engineer   — 9 @ 85, 5 @ 86
  P4: roleReadings(92, [[90, 1], [87, 6]]),   // Bomber     — 7 @ 87, 1 @ 88
  P5: roleReadings(91, [[90, 4], [86, 4]]),   // Muscle     — 8 @ 86, 4 @ 87
  P6: roleReadings(91, [[90, 1], [87, 6]]),   // Picklock 2 — 7 @ 87, 1 @ 88
})

describe('maximalCprVector — the Blast from the Past verification table', () => {
  it('reproduces the known-good answer', () => {
    const out = maximalCprVector(BFTP(), POSITIONS)
    expect(out.vector).toEqual({ P1: 87, P2: 86, P3: 85, P4: 87, P5: 86, P6: 87 })
    expect(Object.fromEntries(POSITIONS.map((p) => [p, out.roles[p].eligible])))
      .toEqual({ P1: 7, P2: 7, P3: 9, P4: 7, P5: 8, P6: 7 })
    expect(out.crewable).toBe(true)
  })

  it('⚠️ does not return 86 for Engineer — only 5 clear it, and the crime needs 6', () => {
    // The off-by-one this table exists to catch. MonChoon and I both had 86 in
    // an earlier pass; it is below the bar for a six-role crime.
    const readings = BFTP()
    const out = maximalCprVector(readings, POSITIONS)
    expect(out.vector.P3).toBe(85)
    expect(out.roles.P3.atNextPoint).toBe(5)
  })

  it('reports the cliff, because a threshold on a 7→1 drop is not the same object as one on a 9→5', () => {
    const out = maximalCprVector(BFTP(), POSITIONS)
    expect(out.roles.P1.cliff).toBe(6)   // 7 → 1
    expect(out.roles.P3.cliff).toBe(4)   // 9 → 5
    expect(out.roles.P2.cliff).toBe(3)   // 7 → 4
  })

  it('⚠️ keeps the per-role reading count, because the denominators genuinely differ', () => {
    // 92, 88, 92, 92, 91, 91 on the real roster. A role with four fewer
    // readings has a correspondingly softer number, and a member with no
    // reading is absent rather than failing (#351).
    const out = maximalCprVector(BFTP(), POSITIONS)
    expect(Object.fromEntries(POSITIONS.map((p) => [p, out.roles[p].readings])))
      .toEqual({ P1: 92, P2: 88, P3: 92, P4: 92, P5: 91, P6: 91 })
  })

  it('⚠️ its output is a valid input to the crew matcher', () => {
    // Step 1 exists to feed #692, which scores candidates with #689. If these
    // two disagree about shape the whole pipeline is broken, so pin it here.
    const readings = BFTP()
    const { vector } = maximalCprVector(readings, POSITIONS)
    const crews = maxDisjointCrews(readings, vector)
    expect(Object.keys(crews.crews[0]).sort()).toEqual([...POSITIONS].sort())

    // ⚠️ SEVEN, not one — and that is correct for this fixture, which gives
    // every role its own independent pool. Step 1 is a per-role question and
    // cannot see overlap; the identical vector against a shared roster collapses
    // to one crew (below). This is exactly why #689 exists and why step 1 is a
    // ceiling rather than an answer.
    expect(crews.k).toBe(7)
  })

  it('⚠️ the SAME maximal vector seats one crew when the roster overlaps', () => {
    // Same thresholds, same per-role headcounts — but now the seven people
    // clearing each bar are the same seven people. The per-role view is
    // identical and the truth is 7x smaller.
    const shared = Array.from({ length: 7 }, (_, i) => ({ member_id: `shared${i}`, cpr: 90 }))
    const overlapping = Object.fromEntries(POSITIONS.map((p) => [p, shared]))
    const { vector, roles } = maximalCprVector(overlapping, POSITIONS)

    expect(Object.values(roles).map((r) => r.eligible)).toEqual([7, 7, 7, 7, 7, 7])
    expect(maxDisjointCrews(overlapping, vector).k).toBe(1)
  })
})

describe('maximalCprVector', () => {
  it('needs n members per role, where n is the ROLE COUNT not one', () => {
    // Three roles: the bar is the 3rd-highest reading, not the highest.
    const r = {
      P1: [{ member_id: 'a', cpr: 90 }, { member_id: 'b', cpr: 80 }, { member_id: 'c', cpr: 70 }],
      P2: [{ member_id: 'd', cpr: 90 }, { member_id: 'e', cpr: 80 }, { member_id: 'f', cpr: 70 }],
      P3: [{ member_id: 'g', cpr: 90 }, { member_id: 'h', cpr: 80 }, { member_id: 'i', cpr: 70 }],
    }
    expect(maximalCprVector(r, ['P1', 'P2', 'P3']).vector).toEqual({ P1: 70, P2: 70, P3: 70 })
  })

  it('⚠️ is not crewable when a role has fewer readings than the crime has roles', () => {
    // Not "the bar is zero" — we cannot field this crime at ANY bar, and the
    // reason is a role only two people have ever been observed in.
    const r = {
      P1: [{ member_id: 'a', cpr: 90 }, { member_id: 'b', cpr: 90 }, { member_id: 'c', cpr: 90 }],
      P2: [{ member_id: 'd', cpr: 90 }, { member_id: 'e', cpr: 90 }],
      P3: [{ member_id: 'f', cpr: 90 }, { member_id: 'g', cpr: 90 }, { member_id: 'h', cpr: 90 }],
    }
    const out = maximalCprVector(r, ['P1', 'P2', 'P3'])
    expect(out.crewable).toBe(false)
    expect(out.vector.P2).toBeNull()
    expect(out.limitingRoles).toEqual(['P2'])
    // ⚠️ The roles that ARE fine still report their ceiling — a blocked crime
    // should still say what the rest of the crew could sustain.
    expect(out.vector.P1).toBe(90)
  })

  it('⚠️ a null CPR is an absent reading, not a zero', () => {
    const r = {
      P1: [{ member_id: 'a', cpr: 90 }, { member_id: 'b', cpr: null }, { member_id: 'c', cpr: 88 }],
      P2: [{ member_id: 'd', cpr: 90 }, { member_id: 'e', cpr: 88 }],
    }
    const out = maximalCprVector(r, ['P1', 'P2'])
    // Two roles, so we need 2 per role. P1's usable readings are 90 and 88.
    expect(out.vector).toEqual({ P1: 88, P2: 88 })
    expect(out.roles.P1.readings).toBe(2)
    expect(out.crewable).toBe(true)
  })

  it('handles a crime we have no readings for at all', () => {
    const out = maximalCprVector({}, ['P1', 'P2'])
    expect(out.crewable).toBe(false)
    expect(out.vector).toEqual({ P1: null, P2: null })
    expect(out.limitingRoles).toEqual(['P1', 'P2'])
  })

  it('handles an empty role list without inventing a crime', () => {
    const out = maximalCprVector({ P1: [{ member_id: 'a', cpr: 90 }] }, [])
    expect(out.crewable).toBe(false)
    expect(out.vector).toEqual({})
  })

  it('a cliff of zero is a comfortable threshold, and is reported as such', () => {
    // Ten members all at 90 in a two-role crime: the bar is 90 and nothing is
    // lost by going one higher — because nobody is there either way.
    const many = Array.from({ length: 10 }, (_, i) => ({ member_id: `m${i}`, cpr: 90 }))
    const out = maximalCprVector({ P1: many, P2: many }, ['P1', 'P2'])
    expect(out.vector).toEqual({ P1: 90, P2: 90 })
    expect(out.roles.P1.cliff).toBe(10)
  })
})
