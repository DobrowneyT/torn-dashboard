import { describe, it, expect } from 'vitest'
import { checkRequirement } from '../../views/TierRequirementsView'

describe('checkRequirement', () => {
  it('returns "pass" when user CPR meets the requirement', () => {
    const req = { level: 8, role: 'Muscle', minCpr: 65 }
    const userCpr = { '8:Muscle': 72.5 }

    expect(checkRequirement(req, userCpr)).toBe('pass')
  })

  it('returns "pass" when user CPR exactly equals the requirement', () => {
    const req = { level: 7, role: 'Hacker', minCpr: 70 }
    const userCpr = { '7:Hacker': 70.0 }

    expect(checkRequirement(req, userCpr)).toBe('pass')
  })

  it('returns "fail" when user CPR is below the requirement', () => {
    const req = { level: 8, role: 'Imitator', minCpr: 70 }
    const userCpr = { '8:Imitator': 55.3 }

    expect(checkRequirement(req, userCpr)).toBe('fail')
  })

  it('returns "unknown" when user has no CPR data for that role/level', () => {
    const req = { level: 8, role: 'Thief', minCpr: 65 }
    const userCpr = { '7:Hacker': 80.0 }

    expect(checkRequirement(req, userCpr)).toBe('unknown')
  })

  it('returns "unknown" when userCpr is null (data not loaded)', () => {
    const req = { level: 6, role: 'Bomber', minCpr: 75 }

    expect(checkRequirement(req, null)).toBe('unknown')
  })

  it('returns "unknown" when userCpr is undefined', () => {
    const req = { level: 6, role: 'Bomber', minCpr: 75 }

    expect(checkRequirement(req, undefined)).toBe('unknown')
  })

  it('handles average tier requirements correctly', () => {
    const req = { level: 5, role: 'Average', minCpr: 75, isAverage: true }
    const userCpr = { '5:Average': 78.2 }

    expect(checkRequirement(req, userCpr)).toBe('pass')
  })

  it('returns "fail" for average requirement when below threshold', () => {
    const req = { level: 4, role: 'Average', minCpr: 75, isAverage: true }
    const userCpr = { '4:Average': 60.0 }

    expect(checkRequirement(req, userCpr)).toBe('fail')
  })

  it('handles CPR value of 0', () => {
    const req = { level: 7, role: 'Picklock', minCpr: 70 }
    const userCpr = { '7:Picklock': 0 }

    expect(checkRequirement(req, userCpr)).toBe('fail')
  })

  it('handles empty userCpr object (user has no CPR data at all)', () => {
    const req = { level: 8, role: 'Muscle', minCpr: 65 }
    const userCpr = {}

    expect(checkRequirement(req, userCpr)).toBe('unknown')
  })
})
