import { describe, it, expect } from 'vitest'
import {
  ROLL_CALL_LEAD_TIME_SEC,
  rollCallGateActive,
  validateRollCall,
  formatTct,
  formatCountdown,
  availabilityLabel,
  rollCallTally,
  warTypeBadge,
  canSeeWarNotes,
  notePointsFromText,
  notePointsToText,
  isRollCallDismissed,
  markRollCallDismissed,
} from '../rollCall'

const HOUR = 3600

describe('roll-call per-war dismissal (#167)', () => {
  function fakeStorage(initial = {}) {
    const m = { ...initial }
    return {
      getItem: (k) => (k in m ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v) },
    }
  }

  it('is not dismissed by default', () => {
    expect(isRollCallDismissed('42', fakeStorage())).toBe(false)
  })

  it('marks a war dismissed and reads it back, scoped per war', () => {
    const s = fakeStorage()
    markRollCallDismissed('42', s)
    expect(isRollCallDismissed('42', s)).toBe(true)
    expect(isRollCallDismissed('99', s)).toBe(false)
  })

  it('matches numeric and string war ids', () => {
    const s = fakeStorage()
    markRollCallDismissed(42, s)
    expect(isRollCallDismissed('42', s)).toBe(true)
  })

  it('no-ops safely without a war id or storage', () => {
    expect(isRollCallDismissed(null, fakeStorage())).toBe(false)
    expect(() => markRollCallDismissed(null, fakeStorage())).not.toThrow()
    expect(isRollCallDismissed('42', null)).toBe(false)
  })
})

describe('note points <-> text', () => {
  it('splits text into trimmed, non-empty points', () => {
    expect(notePointsFromText('130 per person\n  Bonus = 10  \n\nUse warlords'))
      .toEqual(['130 per person', 'Bonus = 10', 'Use warlords'])
  })

  it('treats a legacy single-line note as one point', () => {
    expect(notePointsFromText('Focus their top 10')).toEqual(['Focus their top 10'])
  })

  it('is empty for blank/absent input', () => {
    expect(notePointsFromText('')).toEqual([])
    expect(notePointsFromText(null)).toEqual([])
    expect(notePointsFromText('   \n  ')).toEqual([])
  })

  it('joins points back to newline text, dropping blanks', () => {
    expect(notePointsToText([' A ', '', 'B', '   '])).toBe('A\nB')
  })

  it('round-trips', () => {
    const text = 'Opens after 24h\nOffliners only\nUse warlords'
    expect(notePointsToText(notePointsFromText(text))).toBe(text)
  })
})

describe('canSeeWarNotes', () => {
  it('grants war leaders', () => {
    expect(canSeeWarNotes({ isWarLead: true, isLeadership: false, isVisitor: false })).toBe(true)
  })

  it('grants real leadership/admin (isLeadership true, not a visitor)', () => {
    expect(canSeeWarNotes({ isWarLead: false, isLeadership: true, isVisitor: false })).toBe(true)
  })

  it('denies visitors even though the leadership layout flag is on for them', () => {
    // In the SPA the isLeadership prop is true for visitors (they see the
    // leadership layout), so the gate must exclude them explicitly.
    expect(canSeeWarNotes({ isWarLead: false, isLeadership: true, isVisitor: true })).toBe(false)
  })

  it('denies a plain member', () => {
    expect(canSeeWarNotes({ isWarLead: false, isLeadership: false, isVisitor: false })).toBe(false)
  })
})

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
    expect(warTypeBadge({ war_type: 'termed', termed_score_us: 15500, termed_score_them: 7200 })).toBe('Termed 15.5k–7.2k')
    expect(warTypeBadge({ war_type: 'termed', termed_score_us: 5000 })).toBe('Termed 5k–?')
    expect(warTypeBadge({ war_type: 'race', race_target_score: 25000 })).toBe('Race → 25k')
  })
})

describe('rollCallTally', () => {
  it('counts yes / no / total by on_at_start', () => {
    expect(rollCallTally([
      { on_at_start: true }, { on_at_start: true }, { on_at_start: false },
    ])).toEqual({ yes: 2, no: 1, total: 3 })
  })
  it('is all zero for no responses', () => {
    expect(rollCallTally([])).toEqual({ yes: 0, no: 0, total: 0 })
  })
  it('ignores rows without a definite answer', () => {
    expect(rollCallTally([{ on_at_start: true }, { on_at_start: undefined }, {}]))
      .toEqual({ yes: 1, no: 0, total: 1 })
  })
})
