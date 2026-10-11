// The wrap-up verdict rules (#945).
//
// ⚠️ Every rule here decides whether ~94 permanent messages get posted. The
// bias is always toward refusing: a report that was never posted can be posted
// tomorrow, and one that was posted with a missing source cannot be unposted.
import { describe, expect, it } from 'vitest'
import {
  assessWrapUp, retryWindowMinutes, DEFAULT_RETRY_WINDOW_MINUTES, type WrapUpFacts,
} from '../src/warWrapUp.js'

const complete = (over: Partial<WrapUpFacts> = {}): WrapUpFacts => ({
  reportUnavailable: false,
  contributionRows: 94,
  attackRows: 1200,
  dibsSummarised: true,
  dibsEnabled: true,
  minutesWaiting: 5,
  retryWindowMinutes: 120,
  ...over,
})

describe('the retry window is a stated tunable', () => {
  it('defaults to two hours when unset', () => {
    expect(retryWindowMinutes(null)).toBe(DEFAULT_RETRY_WINDOW_MINUTES)
    expect(retryWindowMinutes({})).toBe(DEFAULT_RETRY_WINDOW_MINUTES)
  })

  it('takes a configured value', () => {
    expect(retryWindowMinutes({ retry_window_minutes: 45 })).toBe(45)
  })

  it('⚠️ refuses zero, which would fail every war instantly', () => {
    expect(retryWindowMinutes({ retry_window_minutes: 0 })).toBe(DEFAULT_RETRY_WINDOW_MINUTES)
    expect(retryWindowMinutes({ retry_window_minutes: -5 })).toBe(DEFAULT_RETRY_WINDOW_MINUTES)
  })

  it('⚠️ caps at a week, so a war cannot sit waiting for ever', () => {
    // An unbounded window is the silent failure this whole job exists to avoid.
    expect(retryWindowMinutes({ retry_window_minutes: 99_999_999 })).toBe(7 * 24 * 60)
  })

  it('ignores nonsense rather than crashing the job', () => {
    expect(retryWindowMinutes({ retry_window_minutes: 'soon' })).toBe(DEFAULT_RETRY_WINDOW_MINUTES)
    expect(retryWindowMinutes('nope')).toBe(DEFAULT_RETRY_WINDOW_MINUTES)
  })
})

describe('everything present', () => {
  it('queues', () => {
    expect(assessWrapUp(complete()).action).toBe('queue')
  })
})

describe('⚠️ report_unavailable fails IMMEDIATELY', () => {
  it('does not wait out the window first', () => {
    // Torn is saying *never*, not *not yet*. Burning two hours of retries only
    // delays the message to the human who has to decide what to do.
    const v = assessWrapUp(complete({
      reportUnavailable: true, contributionRows: 0, minutesWaiting: 0,
    }))
    expect(v.action).toBe('fail')
    expect(v.reason).toMatch(/permanently unavailable/)
  })

  it('fails even when everything else is present', () => {
    expect(assessWrapUp(complete({ reportUnavailable: true })).action).toBe('fail')
  })
})

describe('missing contributions', () => {
  it('waits inside the window', () => {
    const v = assessWrapUp(complete({ contributionRows: 0, minutesWaiting: 30 }))
    expect(v.action).toBe('wait')
    expect(v.reason).toMatch(/30 of 120/)
  })

  it('⚠️ fails loudly at the end of the window, queueing nothing', () => {
    const v = assessWrapUp(complete({ contributionRows: 0, minutesWaiting: 121 }))
    expect(v.action).toBe('fail')
    expect(v.reason).toMatch(/scoreless/)
  })

  it('the boundary belongs to failing, not waiting', () => {
    // At exactly the window we have waited the whole window. Waiting one more
    // tick would make the stated tunable mean "a bit more than this".
    expect(assessWrapUp(complete({ contributionRows: 0, minutesWaiting: 120 })).action)
      .toBe('fail')
    expect(assessWrapUp(complete({ contributionRows: 0, minutesWaiting: 119.9 })).action)
      .toBe('wait')
  })
})

describe('missing attacks', () => {
  it('⚠️ blocks even when contributions are present', () => {
    // Contributions come from Torn's war report; the scores in a member's
    // thread come from OUR ledger. A war with one and not the other renders
    // every score as absent while the payout sheet shows figures — two sources
    // disagreeing in public.
    const v = assessWrapUp(complete({ attackRows: 0, minutesWaiting: 5 }))
    expect(v.action).toBe('wait')
  })

  it('fails loudly once the window is out', () => {
    expect(assessWrapUp(complete({ attackRows: 0, minutesWaiting: 200 })).action).toBe('fail')
  })
})

describe('⚠️ dibs blocks only when the job is ENABLED', () => {
  it('a disabled tenant queues without it', () => {
    // MonChoon: "If dibs summary is disabled we can ship the war reports
    // without it rather than wait." On four of five tenants the job is off, so
    // blocking would mean the wrap-up never completes there.
    const v = assessWrapUp(complete({ dibsEnabled: false, dibsSummarised: false }))
    expect(v.action).toBe('queue')
    expect(v.reason).toMatch(/disabled/)
  })

  it('an enabled tenant waits for it', () => {
    expect(assessWrapUp(complete({ dibsEnabled: true, dibsSummarised: false })).action)
      .toBe('wait')
  })

  it('an enabled tenant that never produces it fails rather than queueing', () => {
    const v = assessWrapUp(complete({
      dibsEnabled: true, dibsSummarised: false, minutesWaiting: 500,
    }))
    expect(v.action).toBe('fail')
    expect(v.reason).toMatch(/dibs-summary is enabled/)
  })
})

describe('the order the checks run in', () => {
  it('⚠️ contributions are reported before dibs', () => {
    // Both are missing. The reason names the one a human should act on first —
    // and dibs cannot even be computed for a war whose attacks have not landed.
    const v = assessWrapUp(complete({
      contributionRows: 0, dibsSummarised: false, minutesWaiting: 1000,
    }))
    expect(v.reason).toMatch(/war_member_contributions/)
    expect(v.reason).not.toMatch(/dibs/)
  })
})
