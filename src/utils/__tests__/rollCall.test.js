import { describe, it, expect } from 'vitest'
import {
  ROLL_CALL_LEAD_TIME_SEC,
  rollCallGateActive,
  validateRollCall,
  formatTct,
  formatCountdown,
  availabilityLabel,
  warTypeBadge,
} from '../rollCall'

const HOUR = 3600

describe('rollCallGateActive', () => {
  const startAt = 1_000_000
  const war = { id: 1, startAt }

  it('is inactive with no current war', () => {
    expect(rollCallGateActive({ currentWar: null, mySubmitted: false, nowSec: 0 })).toBe(false)
  })

  it('is active well before start when not submitted', () => {
    expect(rollCallGateActive({ currentWar: war, mySubmitted: false, nowSec: startAt - 5 * HOUR })).toBe(true)
  })

  it('is inactive once submitted', () => {
    expect(rollCallGateActive({ currentWar: war, mySubmitted: true, nowSec: startAt - 5 * HOUR })).toBe(false)
  })

  it('auto-releases within the lead time (1h) of start', () => {
    expect(rollCallGateActive({ currentWar: war, mySubmitted: false, nowSec: startAt - ROLL_CALL_LEAD_TIME_SEC + 1 })).toBe(false)
  })

  it('is inactive after the war has started', () => {
    expect(rollCallGateActive({ currentWar: war, mySubmitted: false, nowSec: startAt + HOUR })).toBe(false)
  })
})

describe('validateRollCall', () => {
  it('requires on_at_start to be a boolean', () => {
    expect(validateRollCall({}).ok).toBe(false)
  })

  it('accepts "on at start" without further answers', () => {
    expect(validateRollCall({ on_at_start: true }).ok).toBe(true)
  })

  it('requires self-hospital + availability when not on at start', () => {
    expect(validateRollCall({ on_at_start: false }).ok).toBe(false)
    expect(validateRollCall({ on_at_start: false, can_self_hospital: false }).ok).toBe(false)
    expect(validateRollCall({ on_at_start: false, can_self_hospital: false, availability: 'on_time' }).ok).toBe(false)
    expect(validateRollCall({ on_at_start: false, can_self_hospital: true, availability: '3_5h' }).ok).toBe(true)
  })
})

describe('formatTct (TCT == UTC)', () => {
  it('formats a known unix timestamp in UTC', () => {
    // 2026-06-26 20:00:00 UTC = Friday
    const ts = Date.UTC(2026, 5, 26, 20, 0, 0) / 1000
    expect(formatTct(ts)).toBe('Fri 20:00 TCT (26/06)')
  })
  it('handles empty', () => {
    expect(formatTct(0)).toBe('—')
  })
})

describe('formatCountdown', () => {
  it('shows days+hours when far out', () => {
    expect(formatCountdown(100 + 2 * 86400 + 7 * HOUR, 100)).toBe('in 2d 7h')
  })
  it('shows hours+minutes within a day', () => {
    expect(formatCountdown(100 + 3 * HOUR + 30 * 60, 100)).toBe('in 3h 30m')
  })
  it('reports started once elapsed', () => {
    expect(formatCountdown(100, 200)).toBe('started')
  })
})

describe('labels', () => {
  it('maps availability values', () => {
    expect(availabilityLabel('on_time')).toBe('On time')
    expect(availabilityLabel('3_5h')).toBe('3–5 Hours Late')
    expect(availabilityLabel('unavailable')).toBe('Will not be available at all')
  })

  it('builds war-type badges', () => {
    expect(warTypeBadge(null)).toBe(null)
    expect(warTypeBadge({ war_type: 'real' })).toBe('Real')
    expect(warTypeBadge({ war_type: 'termed', termed_score: 5000 })).toBe('Termed 5k')
    expect(warTypeBadge({ war_type: 'race', race_target_score: 25000 })).toBe('Race → 25k')
  })
})
