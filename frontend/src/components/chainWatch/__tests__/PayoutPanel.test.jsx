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

  it('shows a member the numbers but never the buttons', () => {
    draw({ signups: flagged, canEdit: false })
    expect(within(screen.getByTestId('flag-queue')).queryByRole('button')).toBeNull()
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
