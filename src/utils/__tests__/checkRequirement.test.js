import { describe, it, expect } from 'vitest'
import { checkRequirement } from '../../views/TierRequirementsView'

describe('checkRequirement', () => {
  it('returns "pass" when user CPR meets the requirement', () => {
    const req = { crime: 'Break the Bank', role: 'Muscle #3', minCpr: 65 }
    const userCpr = { 'Break the Bank:Muscle #3': 72.5 }

    expect(checkRequirement(req, userCpr)).toBe('pass')
  })

  it('returns "pass" when user CPR exactly equals the requirement', () => {
    const req = { crime: 'Blast from the Past', role: 'Hacker', minCpr: 70 }
    const userCpr = { 'Blast from the Past:Hacker': 70.0 }

    expect(checkRequirement(req, userCpr)).toBe('pass')
  })

  it('returns "fail" when user CPR is below the requirement', () => {
    const req = { crime: 'Clinical Precision', role: 'Imitator', minCpr: 70 }
    const userCpr = { 'Clinical Precision:Imitator': 55.3 }

    expect(checkRequirement(req, userCpr)).toBe('fail')
  })

  it('returns "unknown" when user has no CPR data for that crime/role', () => {
    const req = { crime: 'Break the Bank', role: 'Thief #2', minCpr: 65 }
    const userCpr = { 'Blast from the Past:Hacker': 80.0 }

    expect(checkRequirement(req, userCpr)).toBe('unknown')
  })

  it('returns "unknown" when userCpr is null (data not loaded)', () => {
    const req = { crime: 'Bidding War', role: 'Bomber #1', minCpr: 70 }

    expect(checkRequirement(req, null)).toBe('unknown')
  })

  it('returns "unknown" when userCpr is undefined', () => {
    const req = { crime: 'Bidding War', role: 'Bomber #1', minCpr: 70 }

    expect(checkRequirement(req, undefined)).toBe('unknown')
  })

  it('handles average tier requirements correctly', () => {
    const req = { level: 5, role: 'Average', minCpr: 75, isAverage: true }
    const userCpr = { 'avg:5': 78.2 }

    expect(checkRequirement(req, userCpr)).toBe('pass')
  })

  it('returns "fail" for average requirement when below threshold', () => {
    const req = { level: 4, role: 'Average', minCpr: 75, isAverage: true }
    const userCpr = { 'avg:4': 60.0 }

    expect(checkRequirement(req, userCpr)).toBe('fail')
  })

  it('handles CPR value of 0', () => {
    const req = { crime: 'Blast from the Past', role: 'Picklock #1', minCpr: 70 }
    const userCpr = { 'Blast from the Past:Picklock #1': 0 }

    expect(checkRequirement(req, userCpr)).toBe('fail')
  })

  it('handles empty userCpr object (user has no CPR data at all)', () => {
    const req = { crime: 'Break the Bank', role: 'Muscle #3', minCpr: 65 }
    const userCpr = {}

    expect(checkRequirement(req, userCpr)).toBe('unknown')
  })
})
