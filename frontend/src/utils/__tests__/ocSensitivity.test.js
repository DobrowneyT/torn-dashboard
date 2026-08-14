// #441 — which roles drive success, and which drive payout.
//
// The whole point is that these are TWO different things, and the roles that
// differ between them are the interesting ones.
import { describe, expect, it } from 'vitest'
import {
  roleSensitivity, classifyRole, crimeSensitivity, goodEndings,
  ROLE_CLASS_LABELS, PROBE_DELTA,
} from '../ocSensitivity'

// A crime whose endings pay very differently — the spread a router steers.
const SCENARIO = {
  name: 'Break the Bank',
  roles: [
    { position_id: 'P1', role_name: 'Robber' },
    { position_id: 'P2', role_name: 'Muscle 1' },
    { position_id: 'P3', role_name: 'Muscle 2' },
  ],
  endings: [
    { ending_key: 'goodEnding1', kind: 'good', resolved: true, money_avg: 400_000_000, observations: 5000 },
    { ending_key: 'goodEnding2', kind: 'good', resolved: true, money_avg: 100_000_000, observations: 5000 },
  ],
}

const resp = (success, g1, g2) => ({
  successChance: success,
  failureChance: 1 - success,
  goodEnding1: g1,
  goodEnding2: g2,
})

describe('goodEndings', () => {
  it('picks out only the good-ending probabilities', () => {
    const g = goodEndings({ successChance: 0.9, goodEnding1: 0.8, badEnding1: 0.1 })
    expect(g).toEqual({ goodEnding1: 0.8 })
  })
})

describe('roleSensitivity', () => {
  it('measures a GATE: success moves, the ending mix does not', () => {
    // +10 CPR lifts success 0.70 → 0.80 while the split between endings stays
    // proportionally the same.
    const base = resp(0.70, 0.35, 0.35)
    const bumped = resp(0.80, 0.40, 0.40)
    const s = roleSensitivity(SCENARIO, base, bumped)
    expect(s.dSuccess).toBeCloseTo(0.01)     // 10 points over 10 CPR
    expect(s.dValue).toBeGreaterThan(0)      // more success is still more money
  })

  it('measures a ROUTER: success barely moves, value moves a lot', () => {
    // ⚠️ The case MonChoon called out. Success is flat at 0.80, but probability
    // shifts from the $100M ending to the $400M one.
    const base = resp(0.80, 0.10, 0.70)
    const bumped = resp(0.80, 0.70, 0.10)
    const s = roleSensitivity(SCENARIO, base, bumped)
    expect(s.dSuccess).toBeCloseTo(0)
    expect(s.dValue).toBeGreaterThan(10_000_000)
  })

  it('⚠️ refuses a value delta when the two sides priced different endings', () => {
    // A role that shifts probability onto an UNPRICED ending would otherwise
    // look like it destroys value, when in fact we cannot see where the value
    // went. Null is the honest answer.
    const partial = {
      ...SCENARIO,
      endings: [SCENARIO.endings[0]],   // only goodEnding1 priced
    }
    const base = resp(0.8, 0.8, 0)      // all mass on the priced ending
    const bumped = resp(0.8, 0.1, 0.7)  // mass moved onto the unpriced one
    const s = roleSensitivity(partial, base, bumped)
    expect(s.dSuccess).toBeCloseTo(0)
    expect(s.dValue).toBeNull()
  })

  it('reports a null value delta, not zero, for an unpriced crime', () => {
    // "We cannot measure this role's payout effect" must never render as "this
    // role does not affect payouts".
    const unpriced = {
      ...SCENARIO,
      endings: [{ ending_key: 'goodEnding1', kind: 'good', resolved: true, money_avg: null }],
    }
    const s = roleSensitivity(unpriced, resp(0.7, 0.7, 0), resp(0.8, 0.8, 0))
    expect(s.dValue).toBeNull()
    expect(s.priced).toBe(false)
    expect(s.dSuccess).toBeCloseTo(0.01)
  })

  it('returns null without both probes', () => {
    expect(roleSensitivity(SCENARIO, null, resp(0.8, 0.4, 0.4))).toBeNull()
    expect(roleSensitivity(SCENARIO, resp(0.8, 0.4, 0.4), null)).toBeNull()
  })

  it('refuses a zero step rather than dividing by it', () => {
    expect(roleSensitivity(SCENARIO, resp(0.7, 0.7, 0), resp(0.8, 0.8, 0), 0)).toBeNull()
  })
})

describe('classifyRole', () => {
  const maxima = { success: 0.01, value: 20_000_000 }

  it('names a gate, a router and a role that does both', () => {
    expect(classifyRole({ dSuccess: 0.01, dValue: 100, priced: true }, maxima)).toBe('gate')
    expect(classifyRole({ dSuccess: 0.0001, dValue: 20_000_000, priced: true }, maxima)).toBe('router')
    expect(classifyRole({ dSuccess: 0.01, dValue: 20_000_000, priced: true }, maxima)).toBe('both')
  })

  it('calls a role minor only when both effects were actually measured', () => {
    expect(classifyRole({ dSuccess: 0.0001, dValue: 100, priced: true }, maxima)).toBe('minor')
  })

  it('⚠️ does not call an UNMEASURED role minor', () => {
    // "Barely matters" and "we did not measure it" would both invite putting
    // your weakest member there. Only one of them justifies it.
    expect(classifyRole({ dSuccess: 0.0001, dValue: null, priced: false }, maxima)).toBe('unknown')
    expect(classifyRole(null, maxima)).toBe('unknown')
    expect(ROLE_CLASS_LABELS.unknown).toMatch(/not measured/i)
  })

  it('judges relative to the crime, so a cheap crime is not all-minor', () => {
    // A fixed money threshold would classify every role in a low-paying crime
    // as negligible. These deltas are tiny in absolute terms but one clearly
    // dominates the others.
    const small = { success: 0.001, value: 50_000 }
    expect(classifyRole({ dSuccess: 0.001, dValue: 50_000, priced: true }, small)).toBe('both')
  })
})

describe('crimeSensitivity', () => {
  it('classifies every role against the crime\'s own maxima', () => {
    const byRole = {
      // Gate: big success move, ending mix unchanged.
      P1: { base: resp(0.60, 0.30, 0.30), bumped: resp(0.90, 0.45, 0.45) },
      // Router: success flat, mass moves to the rich ending.
      P2: { base: resp(0.80, 0.10, 0.70), bumped: resp(0.80, 0.70, 0.10) },
      // Barely anything.
      P3: { base: resp(0.80, 0.40, 0.40), bumped: resp(0.801, 0.401, 0.40) },
    }
    const rows = crimeSensitivity(SCENARIO, byRole)
    const byId = Object.fromEntries(rows.map((r) => [r.positionId, r]))
    expect(byId.P1.kind).toBe('both')
    expect(byId.P2.kind).toBe('router')
    expect(byId.P3.kind).toBe('minor')
  })

  it('marks roles with no probe as unknown rather than minor', () => {
    const rows = crimeSensitivity(SCENARIO, {})
    expect(rows.every((r) => r.kind === 'unknown')).toBe(true)
    expect(rows.every((r) => r.dSuccess === null)).toBe(true)
  })

  it('uses a sane default step', () => {
    expect(PROBE_DELTA).toBeGreaterThan(0)
    expect(PROBE_DELTA).toBeLessThanOrEqual(25)
  })
})
