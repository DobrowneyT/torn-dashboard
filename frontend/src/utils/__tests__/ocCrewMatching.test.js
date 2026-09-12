// #689 — how many disjoint crews can we ACTUALLY field?
//
// ⚠️ The first test is the whole reason this module exists. Per-role headcounts
// say "7 people can fill every role, so we can run 7 crimes". If it is the SAME
// seven people clearing every bar, we can run ONE. A per-role bound can be wrong
// by 5x on real data, and always in the optimistic direction.
import { describe, expect, it } from 'vitest'
import { maxDisjointCrews } from '../ocCrewMatching'

/** `{ P1: [[memberId, cpr], ...] }` → the readings shape the API serves. */
const readings = (spec) =>
  Object.fromEntries(
    Object.entries(spec).map(([pos, rows]) => [
      pos,
      rows.map(([member_id, cpr]) => ({ member_id: String(member_id), member_name: `M${member_id}`, cpr })),
    ])
  )

const ALL = (positions, cpr) => Object.fromEntries(positions.map((p) => [p, cpr]))

describe('maxDisjointCrews', () => {
  it('⚠️ returns 1 when the same people clear every role, not the per-role count', () => {
    // Three roles, three members, every member eligible for every role. The
    // per-role headcount is 3 for all three roles — which reads as "3 crews".
    // The truth is one crew, because a member cannot be in two crimes at once.
    const r = readings({
      P1: [[1, 90], [2, 90], [3, 90]],
      P2: [[1, 90], [2, 90], [3, 90]],
      P3: [[1, 90], [2, 90], [3, 90]],
    })
    const out = maxDisjointCrews(r, ALL(['P1', 'P2', 'P3'], 80))
    expect(out.perRoleEligible).toEqual({ P1: 3, P2: 3, P3: 3 })
    expect(out.k).toBe(1)
    expect(out.crews).toHaveLength(1)
  })

  it('scales with genuinely disjoint pools', () => {
    const r = readings({
      P1: [[1, 90], [4, 90]],
      P2: [[2, 90], [5, 90]],
      P3: [[3, 90], [6, 90]],
    })
    const out = maxDisjointCrews(r, ALL(['P1', 'P2', 'P3'], 80))
    expect(out.k).toBe(2)
    const used = out.crews.flatMap((c) => Object.values(c))
    expect(new Set(used).size).toBe(6)
  })

  it('⚠️ uses a member for exactly one role, even when they qualify for three', () => {
    // Member 1 is the only person who can do P2 and P3. They can only be in one
    // seat, so no crew is fieldable at all.
    const r = readings({
      P1: [[1, 90], [2, 90]],
      P2: [[1, 90]],
      P3: [[1, 90]],
    })
    const out = maxDisjointCrews(r, ALL(['P1', 'P2', 'P3'], 80))
    expect(out.k).toBe(0)
    expect(out.crews).toEqual([])
    // And it says WHICH roles ran out, so slice 5 can relax the right threshold.
    expect(out.limitingRoles.sort()).toEqual(['P2', 'P3'])
  })

  it('⚠️ a member with no reading for a role is excluded, not passed', () => {
    // Absent is not zero (#351) — but it is not a pass either, and treating it
    // as one would inflate k on exactly the roles we have measured least.
    const r = readings({
      P1: [[1, 90], [2, 90]],
      P2: [[1, 90]],            // member 2 has never been observed in P2
    })
    const out = maxDisjointCrews(r, ALL(['P1', 'P2'], 80))
    expect(out.k).toBe(1)
    expect(out.perRoleEligible.P2).toBe(1)
    expect(out.perRoleWithoutReading.P2).toBe(1)
    expect(out.perRoleBelowBar.P2).toBe(0)
  })

  it('separates "below the bar" from "never observed"', () => {
    const r = readings({
      P1: [[1, 90], [2, 40], [3, 90]],
      P2: [[1, 90], [2, 90], [3, 90]],
    })
    const out = maxDisjointCrews(r, ALL(['P1', 'P2'], 80))
    expect(out.perRoleBelowBar.P1).toBe(1)
    expect(out.perRoleWithoutReading.P1).toBe(0)
  })

  it('⚠️ is deterministic — the same inputs give the same crews', () => {
    // A leader comparing two runs must not see churn that is not real.
    const r = readings({
      P1: [[5, 90], [1, 90], [3, 90]],
      P2: [[3, 90], [5, 90], [1, 90]],
      P3: [[1, 90], [3, 90], [5, 90]],
    })
    const a = maxDisjointCrews(r, ALL(['P1', 'P2', 'P3'], 80))
    const b = maxDisjointCrews(r, ALL(['P1', 'P2', 'P3'], 80))
    expect(a.crews).toEqual(b.crews)
    expect(a.k).toBe(1)
  })

  it('respects the CPR bar per role, not a single global number', () => {
    const r = readings({
      P1: [[1, 70], [2, 90]],
      P2: [[1, 70], [2, 90]],
    })
    // P1 asks 60 (both clear), P2 asks 85 (only member 2).
    const out = maxDisjointCrews(r, { P1: 60, P2: 85 })
    expect(out.k).toBe(1)
    expect(out.crews[0]).toEqual({ P1: '1', P2: '2' })
  })

  it('returns 0 with no readings at all rather than throwing', () => {
    const out = maxDisjointCrews({}, { P1: 80 })
    expect(out.k).toBe(0)
    expect(out.crews).toEqual([])
  })

  it('honours maxK so a caller can stop early', () => {
    const r = readings({
      P1: [[1, 90], [2, 90], [3, 90]],
      P2: [[4, 90], [5, 90], [6, 90]],
    })
    expect(maxDisjointCrews(r, ALL(['P1', 'P2'], 80)).k).toBe(3)
    expect(maxDisjointCrews(r, ALL(['P1', 'P2'], 80), { maxK: 2 }).k).toBe(2)
  })

  it('ignores a null or unparseable CPR the way the rest of the app does', () => {
    const r = readings({
      P1: [[1, null], [2, 90]],
      P2: [[1, 90], [2, 90]],
    })
    const out = maxDisjointCrews(r, ALL(['P1', 'P2'], 80))
    expect(out.perRoleEligible.P1).toBe(1)
    expect(out.k).toBe(1)
    expect(out.crews[0]).toEqual({ P1: '2', P2: '1' })
  })
})

// ⚠️ An augmenting-path search that looks right and is subtly wrong returns a
// number nobody can eyeball — every downstream threshold in #688 would inherit
// it silently. These two blocks are the check that it is actually correct.
describe('maxDisjointCrews against brute force', () => {
  /** Deterministic PRNG so a failure is reproducible from its seed alone. */
  const rng = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }

  /** Every injective slot→member assignment, checked exhaustively. */
  const bruteForceK = (positions, eligible, maxK) => {
    const fits = (k) => {
      const slots = []
      for (let c = 0; c < k; c += 1) for (const p of positions) slots.push(p)
      const used = new Set()
      const go = (i) => {
        if (i === slots.length) return true
        for (const m of eligible[slots[i]]) {
          if (used.has(m)) continue
          used.add(m)
          if (go(i + 1)) return true
          used.delete(m)
        }
        return false
      }
      return go(0)
    }
    let best = 0
    for (let k = 1; k <= maxK; k += 1) {
      if (!fits(k)) break
      best = k
    }
    return best
  }

  it('agrees with exhaustive search on 300 random rosters', () => {
    const rand = rng(20260911)
    for (let trial = 0; trial < 300; trial += 1) {
      const nRoles = 2 + Math.floor(rand() * 3)          // 2-4 roles
      const nMembers = 1 + Math.floor(rand() * 7)        // 1-7 members
      const positions = Array.from({ length: nRoles }, (_, i) => `P${i + 1}`)
      const spec = {}
      const eligible = {}
      for (const p of positions) {
        spec[p] = []
        eligible[p] = []
        for (let m = 1; m <= nMembers; m += 1) {
          // Roughly half the roster clears each bar, some absent entirely.
          const roll = rand()
          if (roll < 0.25) continue                       // never observed
          const cpr = roll < 0.6 ? 50 : 90                 // below / above the bar
          spec[p].push({ member_id: String(m), cpr })
          if (cpr >= 80) eligible[p].push(String(m))
        }
      }
      const mine = maxDisjointCrews(spec, ALL(positions, 80)).k
      const truth = bruteForceK(positions, eligible, nMembers)
      expect({ trial, k: mine }).toEqual({ trial, k: truth })
    }
  })

  it('never seats one member twice, across 300 random rosters', () => {
    const rand = rng(777)
    for (let trial = 0; trial < 300; trial += 1) {
      const nRoles = 2 + Math.floor(rand() * 4)
      const positions = Array.from({ length: nRoles }, (_, i) => `P${i + 1}`)
      const spec = {}
      for (const p of positions) {
        spec[p] = []
        for (let m = 1; m <= 9; m += 1) {
          if (rand() < 0.4) continue
          spec[p].push({ member_id: String(m), cpr: 90 })
        }
      }
      const out = maxDisjointCrews(spec, ALL(positions, 80))
      const seated = out.crews.flatMap((c) => Object.values(c))
      expect(new Set(seated).size).toBe(seated.length)
      // Every crew is complete — a partially-filled crew is not a crew.
      for (const crew of out.crews) expect(Object.keys(crew).sort()).toEqual([...positions].sort())
    }
  })
})

describe('the Blast from the Past shape', () => {
  it('⚠️ shows the gap a per-role headcount hides', () => {
    // Six roles, and on real data every one of them has 7-9 eligible members —
    // which reads as "seven crews". Here the same eight strong members are the
    // ones clearing every bar, so the roster seats ONE crew and one spare seat.
    const strong = [1, 2, 3, 4, 5, 6, 7, 8]
    const positions = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']
    const spec = Object.fromEntries(
      positions.map((p) => [p, strong.map((m) => ({ member_id: String(m), cpr: 90 }))])
    )
    const out = maxDisjointCrews(spec, ALL(positions, 85))

    // The number that misleads:
    expect(Object.values(out.perRoleEligible)).toEqual([8, 8, 8, 8, 8, 8])
    // The number that is true — 8 members, 6 seats a crew.
    expect(out.k).toBe(1)
  })

  it('finds the second crew once the pool genuinely deepens', () => {
    const positions = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']
    const pool = Array.from({ length: 12 }, (_, i) => ({ member_id: String(i + 1), cpr: 90 }))
    const spec = Object.fromEntries(positions.map((p) => [p, pool]))
    expect(maxDisjointCrews(spec, ALL(positions, 85)).k).toBe(2)
  })
})
