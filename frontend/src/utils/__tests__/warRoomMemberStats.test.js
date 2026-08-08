// Live energy + cooldown display for our own members (#336).
import { describe, it, expect } from 'vitest'
import {
  OVERDOSE_DRUG_CD_SEC,
  indexMemberStats, remainingCooldown, formatCooldown,
  overdosedByDrugCooldown, formatEnergy, energyTone, statsAgeSeconds, hasStatsError,
} from '../warRoomMemberStats'
// The pre-existing hospital-status overdose flag (#199), imported here to pin
// the relationship between the two detectors rather than describe it in prose.
import { isOverdosed as statusOverdosed } from '../memberNotes'

const T0 = Date.parse('2026-08-08T12:00:00Z')
const at = (iso) => iso

describe('indexMemberStats', () => {
  it('indexes rows by member id as strings', () => {
    // Row ids arrive as numbers from the bigint column but member_id on the
    // roster rows is compared as a string all over the view.
    const idx = indexMemberStats([{ member_id: 1700, energy_current: 10 }])
    expect(idx['1700'].energy_current).toBe(10)
  })

  it('tolerates an empty or absent delta', () => {
    expect(indexMemberStats([])).toEqual({})
    expect(indexMemberStats()).toEqual({})
    expect(indexMemberStats([null, { energy_current: 1 }])).toEqual({})
  })
})

describe('remainingCooldown', () => {
  it('ages a stored reading down by the time since it was fetched', () => {
    // The core of the module: Torn gives seconds-at-fetch-time, not a
    // timestamp, so a stored 3600 is already stale when it renders.
    expect(remainingCooldown(3600, at('2026-08-08T11:55:00Z'), T0)).toBe(3300)
  })

  it('never goes negative once a cooldown has elapsed', () => {
    expect(remainingCooldown(60, at('2026-08-08T11:00:00Z'), T0)).toBe(0)
  })

  it('returns null when there is no reading at all', () => {
    // "Unknown" and "ready" must not render the same — a war lead reading
    // "Ready" off a member whose key failed would plan around a fiction.
    expect(remainingCooldown(null, at('2026-08-08T11:59:00Z'), T0)).toBeNull()
    expect(remainingCooldown(undefined, null, T0)).toBeNull()
  })

  it('falls back to the raw reading when fetched_at is unusable', () => {
    expect(remainingCooldown(900, null, T0)).toBe(900)
    expect(remainingCooldown(900, 'not-a-date', T0)).toBe(900)
  })
})

describe('formatCooldown', () => {
  it('distinguishes unknown from ready', () => {
    expect(formatCooldown(null)).toBe('—')
    expect(formatCooldown(0)).toBe('Ready')
  })

  it('formats seconds, minutes and hours compactly', () => {
    expect(formatCooldown(45)).toBe('45s')
    expect(formatCooldown(600)).toBe('10m')
    expect(formatCooldown(3600)).toBe('1h')
    expect(formatCooldown(7500)).toBe('2h 5m')
  })
})

describe('overdosedByDrugCooldown', () => {
  it('flags a drug cooldown longer than any normal dose', () => {
    expect(OVERDOSE_DRUG_CD_SEC).toBe(36_000)
    expect(overdosedByDrugCooldown({ cooldown_drug: 40_000 })).toBe(true)
  })

  it('does not flag a normal xanax cooldown', () => {
    // A xanax leaves 6-8h; 10h is the unambiguous line.
    expect(overdosedByDrugCooldown({ cooldown_drug: 8 * 3600 })).toBe(false)
    expect(overdosedByDrugCooldown({ cooldown_drug: 36_000 })).toBe(false)
  })

  it('is false when there is no reading', () => {
    expect(overdosedByDrugCooldown(null)).toBe(false)
    expect(overdosedByDrugCooldown({})).toBe(false)
    expect(overdosedByDrugCooldown({ cooldown_drug: null })).toBe(false)
  })

  it('stays true off the stored reading even as the cooldown burns down', () => {
    // An overdose is a fact about the dose taken, not about how much cooldown
    // happens to be left when someone looks at the board.
    const stats = { cooldown_drug: 40_000, fetched_at: at('2026-08-08T10:00:00Z') }
    expect(overdosedByDrugCooldown(stats)).toBe(true)
  })

  it('catches an overdose the hospital-status flag (#199) can no longer see', () => {
    // The two detectors cover different windows and this is the gap this one
    // exists to fill: released from hospital, so status_details no longer says
    // "Overdosed", but still sitting on a crippling drug cooldown.
    const released = { member_id: 1, status_state: 'Okay', status_details: '' }
    expect(statusOverdosed(released)).toBe(false)
    expect(overdosedByDrugCooldown({ cooldown_drug: 40_000 })).toBe(true)
  })
})

describe('formatEnergy', () => {
  it('renders current over maximum', () => {
    expect(formatEnergy({ energy_current: 87, energy_maximum: 150 })).toBe('87/150')
  })

  it('renders a dash when there is no reading', () => {
    expect(formatEnergy(null)).toBe('—')
    expect(formatEnergy({})).toBe('—')
  })

  it('renders 0 energy rather than treating it as missing', () => {
    // 0/150 is a real and tactically important state; a falsiness check here
    // would blank exactly the member you most need to see.
    expect(formatEnergy({ energy_current: 0, energy_maximum: 150 })).toBe('0/150')
  })
})

describe('energyTone', () => {
  it('bands energy by fraction of maximum', () => {
    expect(energyTone({ energy_current: 150, energy_maximum: 150 })).toBe('high')
    expect(energyTone({ energy_current: 75, energy_maximum: 150 })).toBe('mid')
    expect(energyTone({ energy_current: 10, energy_maximum: 150 })).toBe('low')
  })

  it('reports unknown rather than guessing a band', () => {
    expect(energyTone(null)).toBe('unknown')
    expect(energyTone({ energy_current: 10 })).toBe('unknown')
    expect(energyTone({ energy_current: 10, energy_maximum: 0 })).toBe('unknown')
  })
})

describe('statsAgeSeconds', () => {
  it('reports how stale a reading is', () => {
    // Our roster polls at a 30s floor while the enemy board runs at 1 Hz, so
    // the UI must be able to say "this is 40s old" rather than imply live.
    expect(statsAgeSeconds({ fetched_at: at('2026-08-08T11:59:20Z') }, T0)).toBe(40)
  })

  it('is null when never fetched', () => {
    expect(statsAgeSeconds({}, T0)).toBeNull()
    expect(statsAgeSeconds(null, T0)).toBeNull()
  })
})

describe('hasStatsError', () => {
  it('reports a failed key so the cell can say why it is blank', () => {
    expect(hasStatsError({ last_error: 'Incorrect key' })).toBe(true)
    expect(hasStatsError({ last_error: null })).toBe(false)
    expect(hasStatsError(null)).toBe(false)
  })
})
