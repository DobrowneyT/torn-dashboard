// Live energy + cooldown parsing for our own members (#336).
//
// The Torn call itself is a per-member own-key loop in the ticker; the parsing
// and the overdose derivation are pure, so they unit-test here. The DB writes
// and the war-lead gate are asserted in war-room-member-stats-api.test.ts
// against a real database.
import { describe, it, expect } from 'vitest'
import {
  parseMemberStats,
  isOverdosed,
  OVERDOSE_DRUG_CD_SEC,
  memberStatsPollDue,
} from '../src/warRoomMemberStats.js'

// A realistic /v2/user?selections=bars,cooldowns body.
const body = {
  energy: { current: 87, maximum: 150, increment: 5, interval: 900, ticktime: 120, fulltime: 11340 },
  nerve: { current: 20, maximum: 50 },
  happy: { current: 4000, maximum: 5000 },
  life: { current: 5000, maximum: 5000 },
  cooldowns: { drug: 1800, medical: 0, booster: 43200 },
}

describe('parseMemberStats', () => {
  it('pulls energy and all three cooldowns from a bars+cooldowns response', () => {
    expect(parseMemberStats(body)).toEqual({
      energy_current: 87,
      energy_maximum: 150,
      cooldown_drug: 1800,
      cooldown_medical: 0,
      cooldown_booster: 43200,
    })
  })

  it('ignores the nerve/happy/life bars that ride along in the same response', () => {
    // We ask for `bars` (one call) but only surface energy — nerve and happy
    // are personal data with no war-room use, so they are never stored.
    const parsed = parseMemberStats(body) as unknown as Record<string, unknown>
    for (const k of Object.keys(parsed)) {
      expect(k).not.toMatch(/nerve|happy|life/)
    }
  })

  it('returns nulls rather than throwing when a section is missing', () => {
    // A key that lost access mid-cycle can return a partial body; the poller
    // must degrade to "unknown" instead of killing the tick for everyone else.
    expect(parseMemberStats({})).toEqual({
      energy_current: null,
      energy_maximum: null,
      cooldown_drug: null,
      cooldown_medical: null,
      cooldown_booster: null,
    })
    expect(parseMemberStats({ energy: { current: 12 } })).toMatchObject({
      energy_current: 12,
      energy_maximum: null,
      cooldown_drug: null,
    })
  })

  it('rejects non-numeric junk in a numeric slot', () => {
    expect(parseMemberStats({ energy: { current: 'lots' }, cooldowns: { drug: null } }))
      .toMatchObject({ energy_current: null, cooldown_drug: null })
  })

  it('does not carry the revive/job-perk fields YATA collects', () => {
    // Explicitly out of scope: outside revivers are hired, so a teammate's
    // revive ability has no bearing on war planning.
    const withPerks = { ...body, job_perks: ['+ Ability to revive'] }
    expect(parseMemberStats(withPerks)).not.toHaveProperty('revive')
  })
})

describe('isOverdosed', () => {
  it('flags a drug cooldown longer than any normal dose', () => {
    // A xanax leaves 6-8h of drug CD, so anything past 10h means an overdose.
    expect(OVERDOSE_DRUG_CD_SEC).toBe(36_000)
    expect(isOverdosed(36_001)).toBe(true)
    expect(isOverdosed(200_000)).toBe(true)
  })

  it('does not flag a normal xanax cooldown', () => {
    expect(isOverdosed(8 * 3600)).toBe(false)   // fresh xanax, top of range
    expect(isOverdosed(10 * 3600)).toBe(false)  // exactly at the threshold
    expect(isOverdosed(1800)).toBe(false)
  })

  it('is false, not null, when there is no cooldown data', () => {
    // The column renders a boolean badge; null would render as "overdosed"
    // under a truthiness check somewhere downstream.
    expect(isOverdosed(null)).toBe(false)
    expect(isOverdosed(undefined)).toBe(false)
    expect(isOverdosed(0)).toBe(false)
  })
})

describe('memberStatsPollDue', () => {
  const now = 1_700_000_000_000

  it('never polls when the cadence is 0 (disabled)', () => {
    // The off switch has to win regardless of how stale the data is, otherwise
    // "disabled" would still fire one call per member on the first tick.
    expect(memberStatsPollDue(null, 0, now)).toBe(false)
    expect(memberStatsPollDue(now / 1000 - 99999, 0, now)).toBe(false)
  })

  it('polls immediately when enabled and never fetched', () => {
    expect(memberStatsPollDue(null, 30, now)).toBe(true)
    expect(memberStatsPollDue(undefined, 30, now)).toBe(true)
  })

  it('waits out the configured interval', () => {
    expect(memberStatsPollDue(now / 1000 - 29, 30, now)).toBe(false)
    expect(memberStatsPollDue(now / 1000 - 30, 30, now)).toBe(true)
    expect(memberStatsPollDue(now / 1000 - 31, 30, now)).toBe(true)
  })

  it('enforces the 30s floor even if a smaller cadence reached the DB', () => {
    // Belt-and-braces with clampConfigValue: a row written before this
    // migration, or edited directly in psql, must not poll every second.
    expect(memberStatsPollDue(now / 1000 - 5, 1, now)).toBe(false)
    expect(memberStatsPollDue(now / 1000 - 31, 1, now)).toBe(true)
  })
})
