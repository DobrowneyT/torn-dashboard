// @vitest-environment jsdom
//
// The payout panel (#773) — the half of the spreadsheet that turns served
// hours into money, and the queue of rows a leader still has to look at.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import PayoutPanel from '../PayoutPanel'

afterEach(cleanup)

const EVENT = {
  id: 1, payout_per_slot: 1_500_000,
  bonus_hours: [5, 6], bonus_multiplier: 2, bonus_applies_to: 'tickets',
}
const H = Date.parse('2027-11-03T04:00:00Z')
const slot = (id, name, over = {}) => ({
  member_id: id, member_name: name, hour_start: new Date(H).toISOString(),
  hour_ms: String(H), slot_index: 0, is_bonus: false, is_payable: true,
  flag: null, flag_reason: null, pay_decision: null, ...over,
})
const draw = (props = {}) => render(
  <PayoutPanel event={EVENT} signups={[]} removed={[]} outcome={{ state: 'running', dropped: false }}
    canEdit onDecide={() => {}} busyKey={null} {...props} />)

describe('the table', () => {
  const signups = [
    ...Array.from({ length: 23 }, () => slot('3015831', 'Warwinds')),
    ...Array.from({ length: 4 }, () => slot('873341', 'Goosey')),
  ]

  it('⚠️ the pay link carries exactly the number on the row', () => {
    // The sheet showed Warwinds 35,000,000 beside a link paying 34,500,000.
    draw({ signups })
    const row = screen.getByTestId('payout-3015831')
    expect(within(row).getByText('34,500,000')).toBeTruthy()
    expect(within(row).getByTestId('pay-3015831').getAttribute('href')).toContain('money=34500000')
  })

  it('totals from the rows on screen', () => {
    draw({ signups })
    expect(within(screen.getByTestId('payout-totals')).getByText('40,500,000')).toBeTruthy()
  })

  it('says so when nothing has been served', () => {
    draw()
    expect(screen.getByText(/nothing has been served yet/i)).toBeTruthy()
  })
})

describe('the flag queue', () => {
  const flagged = [
    slot('1', 'Quiet One', { flag: 'absent', flag_reason: 'No actions recorded during the hour' }),
    slot('2', 'Risky One', { flag: 'absent-at-risk', flag_reason: 'No actions while the chain timer was running low' }),
  ]

  it('⚠️ puts the at-risk row first, because it is the one worth a minute', () => {
    // If both look identical in the table, leadership treats them identically.
    draw({ signups: flagged })
    const items = within(screen.getByTestId('flag-queue')).getAllByRole('listitem')
    expect(items[0].textContent).toMatch(/Risky One/)
    expect(items[1].textContent).toMatch(/Quiet One/)
  })

  it('⚠️ still counts a flagged slot as paid until a leader says otherwise', () => {
    // A flag asks a question; it does not withhold money on its own.
    draw({ signups: flagged })
    expect(within(screen.getByTestId('payout-1')).getByText('1,500,000')).toBeTruthy()
  })

  it('offers both answers, and reports the leader’s choice', () => {
    const onDecide = vi.fn()
    draw({ signups: flagged, onDecide })
    const first = within(screen.getByTestId('flag-queue')).getAllByRole('listitem')[0]
    fireEvent.click(within(first).getByRole('button', { name: /^pay$/i }))
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ member_id: '2' }), 'paid')
  })

  it('⚠️ is hidden from a member entirely, not just made read-only', () => {
    // MonChoon, 2026-10-01. This queue names members beside a flag, and
    // "absent while the chain was at risk" is an ACCUSATION until a leader has
    // ruled on it. A member reading their own name here would see a verdict
    // that has not been reached. It used to show them the rows without the
    // buttons; that was still showing them the charge sheet.
    draw({ signups: flagged, canEdit: false })
    expect(screen.queryByTestId('flag-queue')).toBeNull()
  })

  it('is absent entirely once every flag has been answered', () => {
    draw({ signups: flagged.map((s) => ({ ...s, pay_decision: 'paid' })) })
    expect(screen.queryByTestId('flag-queue')).toBeNull()
  })
})

describe('a dropped chain', () => {
  const dropped = {
    state: 'ended', dropped: true, peak: 61_204, endedAt: H,
    finalHourWatchers: [{ member_id: '1', member_name: 'Quiet One' }, { member_id: '2', member_name: 'Risky One' }],
  }

  it('⚠️ names who was on watch when it went', () => {
    // Two watchers per hour exist precisely so this should not happen. When it
    // does, who was on must not depend on anybody's memory.
    draw({ signups: [slot('1', 'Quiet One')], outcome: dropped })
    expect(screen.getByTestId('final-watchers').textContent).toMatch(/Quiet One, Risky One/)
    expect(screen.getByTestId('drop-postmortem').textContent).toMatch(/61,204/)
  })

  it('⚠️ pays the slots but withdraws the raffle, and says which', () => {
    draw({ signups: [slot('1', 'Quiet One')], outcome: dropped })
    expect(within(screen.getByTestId('payout-1')).getByText('1,500,000')).toBeTruthy()
    expect(screen.queryByText('Tickets')).toBeNull()
    expect(screen.getByTestId('no-raffle')).toBeTruthy()
  })

  it('keeps the raffle when the chain was banked', () => {
    draw({ signups: [slot('1', 'Quiet One')], outcome: { state: 'ended', dropped: false, peak: 100_000 } })
    expect(screen.getByText('Tickets')).toBeTruthy()
    expect(screen.queryByTestId('drop-postmortem')).toBeNull()
  })
})

describe('slots that were removed after the hour ran', () => {
  it('⚠️ shows them struck through, with who removed them and why', () => {
    // A member who worked an hour and was later taken off it sees a smaller
    // number with no explanation otherwise. Removed is not "never signed up".
    draw({
      signups: [slot('1', 'Quiet One')],
      removed: [{ ...slot('2', 'Taken Off'), removed_by: '9100',
        removed_by_name: 'The Lead', removed_reason: 'no-show' }],
    })
    const panel = screen.getByTestId('removed-slots')
    expect(panel.textContent).toMatch(/Taken Off/)
    expect(panel.textContent).toMatch(/The Lead/)
    expect(panel.textContent).toMatch(/no-show/)
  })
})

describe('what only leadership sees', () => {
  // MonChoon, 2026-10-01: the removed log and the flag queue are leadership
  // surfaces. One is a moderation record, the other an undecided accusation.
  const removed = [{
    hour_start: '2027-11-03T04:00:00Z', hour_ms: String(Date.parse('2027-11-03T04:00:00Z')),
    slot_index: 0, member_id: '9200', member_name: 'Watcher One',
    removed_by: '9100', removed_by_name: 'The Lead', removed_reason: 'no-show',
  }]

  // ⚠️ Needs a served slot too: with no rows the panel short-circuits to
  // "Nothing has been served yet" and renders none of this.
  const served = [slot('3015831', 'Warwinds')]

  it('hides the removed log from a member', () => {
    draw({ signups: served, removed, canEdit: false })
    expect(screen.queryByTestId('removed-slots')).toBeNull()
  })

  it('shows the removed log to leadership', () => {
    draw({ signups: served, removed, canEdit: true })
    expect(screen.getByTestId('removed-slots')).toBeTruthy()
  })
})

describe('the blanket eligibility switch', () => {
  const signups = [
    ...Array.from({ length: 3 }, () => slot('3015831', 'Warwinds')),
  ]

  it('is leadership only', () => {
    draw({ signups, canEdit: false, onSetEligible: () => {} })
    expect(screen.queryByTestId('eligible-3015831')).toBeNull()
  })

  it('is absent when the page cannot act on it', () => {
    // ⚠️ `canEdit` without a handler would render a button that does nothing.
    draw({ signups, canEdit: true })
    expect(screen.queryByTestId('eligible-3015831')).toBeNull()
  })

  it('⚠️ asks to WITHHOLD when the member is currently being paid', () => {
    // The label says which way the click will go, rather than showing a state
    // the reader has to interpret.
    const onSetEligible = vi.fn()
    draw({ signups, canEdit: true, onSetEligible })
    const btn = screen.getByTestId('eligible-3015831')
    expect(btn.textContent).toBe('Eligible')
    fireEvent.click(btn)
    expect(onSetEligible.mock.calls[0][1]).toBe(false)
  })

  it('⚠️ asks to RESTORE when every slot is already withheld', () => {
    const withheld = signups.map((s) => ({ ...s, pay_decision: 'unpaid' }))
    const onSetEligible = vi.fn()
    draw({ signups: withheld, canEdit: true, onSetEligible })
    const btn = screen.getByTestId('eligible-3015831')
    expect(btn.textContent).toBe('Not paid')
    fireEvent.click(btn)
    expect(onSetEligible.mock.calls[0][1]).toBe(true)
  })
})
