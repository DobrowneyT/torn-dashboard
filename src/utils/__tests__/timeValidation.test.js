import { describe, it, expect } from 'vitest'
import { validateNoOverlappingCrimes } from '../payoutCalculations.js'

const DAY = 86400

function makeCrime(crimeId, { status = 'Successful', executedAt, slots }) {
  return {
    [crimeId]: {
      crime_id: crimeId,
      name: 'Test Crime',
      status,
      executed_at: executedAt,
      created_at: executedAt - DAY,
      slots,
    },
  }
}

function makeSlot(userId, joinedAt) {
  return {
    position: 'Muscle',
    user: { id: userId, joined_at: joinedAt },
  }
}

describe('validateNoOverlappingCrimes', () => {
  it('returns valid for empty crimes', () => {
    const result = validateNoOverlappingCrimes({ crimes: {} })
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('returns valid when a member is in sequential non-overlapping crimes', () => {
    const crimes = {
      crimes: {
        ...makeCrime('c1', {
          executedAt: 200,
          slots: [makeSlot(1, 100)],
        }),
        ...makeCrime('c2', {
          executedAt: 400,
          slots: [makeSlot(1, 200)], // Starts when c1 ended
        }),
      },
    }

    const result = validateNoOverlappingCrimes(crimes)
    expect(result.valid).toBe(true)
  })

  it('detects overlap when a member is in two crimes at the same time', () => {
    const crimes = {
      crimes: {
        ...makeCrime('c1', {
          executedAt: 300,
          slots: [makeSlot(1, 100)], // 100-300
        }),
        ...makeCrime('c2', {
          executedAt: 400,
          slots: [makeSlot(1, 200)], // 200-400, overlaps with c1 (200-300)
        }),
      },
    }

    const result = validateNoOverlappingCrimes(crimes)
    expect(result.valid).toBe(false)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('Member 1')
  })

  it('does not flag different members in overlapping crimes', () => {
    const crimes = {
      crimes: {
        ...makeCrime('c1', {
          executedAt: 300,
          slots: [makeSlot(1, 100)],
        }),
        ...makeCrime('c2', {
          executedAt: 400,
          slots: [makeSlot(2, 200)], // Different member
        }),
      },
    }

    const result = validateNoOverlappingCrimes(crimes)
    expect(result.valid).toBe(true)
  })

  it('handles single crime with single member', () => {
    const crimes = {
      crimes: {
        ...makeCrime('c1', {
          executedAt: 300,
          slots: [makeSlot(1, 100)],
        }),
      },
    }

    const result = validateNoOverlappingCrimes(crimes)
    expect(result.valid).toBe(true)
  })

  it('handles null/undefined crimesData gracefully', () => {
    expect(validateNoOverlappingCrimes(null).valid).toBe(true)
    expect(validateNoOverlappingCrimes({}).valid).toBe(true)
  })
})
