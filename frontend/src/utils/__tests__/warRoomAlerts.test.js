import { describe, it, expect } from 'vitest'
import { hospitalExitDue, chainSecondsLeft, chainDropDue } from '../warRoomAlerts.js'

describe('hospitalExitDue', () => {
  const target = (state, until) => ({ status_state: state, status_until: until })

  it('fires inside the lead window before a hospital target comes out', () => {
    // until = 1000, lead = 60 → window [940, 1000)
    expect(hospitalExitDue(target('Hospital', 1000), 950, 60)).toBe(true)
    expect(hospitalExitDue(target('Hospital', 1000), 940, 60)).toBe(true)
  })

  it('does not fire before the window opens or after the target is out', () => {
    expect(hospitalExitDue(target('Hospital', 1000), 939, 60)).toBe(false) // too early
    expect(hospitalExitDue(target('Hospital', 1000), 1000, 60)).toBe(false) // already out (boundary)
    expect(hospitalExitDue(target('Hospital', 1000), 1200, 60)).toBe(false) // long out
  })

  it('only applies to hospital targets with a real until', () => {
    expect(hospitalExitDue(target('Okay', null), 950, 60)).toBe(false)
    expect(hospitalExitDue(target('Hospital', null), 950, 60)).toBe(false)
    expect(hospitalExitDue(target('Hospital', 0), 950, 60)).toBe(false)
    expect(hospitalExitDue(null, 950, 60)).toBe(false)
  })
})

describe('chainSecondsLeft', () => {
  it('returns the remaining seconds for a live, built chain', () => {
    expect(chainSecondsLeft({ current: 25, timeout: 1100 }, 1000)).toBe(100)
  })

  it('is null when idle, unbuilt, expired, or on cooldown', () => {
    expect(chainSecondsLeft(null, 1000)).toBeNull()
    expect(chainSecondsLeft({ current: 0, timeout: 1100 }, 1000)).toBeNull()       // no chain built
    expect(chainSecondsLeft({ current: 25, timeout: 900 }, 1000)).toBeNull()        // timer already passed
    expect(chainSecondsLeft({ current: 25, timeout: 1100, cooldown: 2000 }, 1000)).toBeNull() // cooling down
  })
})

describe('chainDropDue', () => {
  it('fires only when a live chain is at/under the threshold', () => {
    expect(chainDropDue({ current: 25, timeout: 1050 }, 1000, 60)).toBe(true)  // 50s left
    expect(chainDropDue({ current: 25, timeout: 1060 }, 1000, 60)).toBe(true)  // exactly 60s
    expect(chainDropDue({ current: 25, timeout: 1120 }, 1000, 60)).toBe(false) // 120s left
  })

  it('never fires without a live savable chain', () => {
    expect(chainDropDue({ current: 0, timeout: 1050 }, 1000, 60)).toBe(false)
    expect(chainDropDue({ current: 25, timeout: 1050, cooldown: 2000 }, 1000, 60)).toBe(false)
  })
})
