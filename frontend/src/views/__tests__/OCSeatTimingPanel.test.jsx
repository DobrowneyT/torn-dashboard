// @vitest-environment jsdom
//
// #744 slice 3 — the seat table, on screen.
//
// ⚠️ This panel exists because the number it shows is the single most
// actionable thing in the whole person-day line of work and nothing surfaced
// it. "Your sixth seat is taken 55h before it is needed" is capacity a faction
// frees tomorrow, with no training and no scope cost — and until now it lived
// in an endpoint nobody calls.
//
// Its own file, per the v3.97.0 lesson: a panel declared inside the view it
// serves is a temporal-dead-zone throw waiting to happen.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { SeatTimingPanel } from '../OCSeatTimingPanel'

afterEach(cleanup)

// capacityx's real shape — the faction the issue was written about.
const CAPACITYX = {
  measured: true,
  reason: 'ok',
  window_days: 180,
  headline: { roles: 6, seat: 6, earlyHours: 55, earlyPersonDays: 5.72 },
  byRoleCount: {
    6: {
      roles: 6,
      earlyHoursTotal: 137.3,
      earlyPersonDays: 5.72,
      worstSeat: { seat: 6, earlyHours: 55, lateHours: 0, idealHours: 120, medianHours: 65, observations: 40 },
      thinSeats: [],
      implausibleSeats: [],
      seats: [
        { seat: 1, idealHours: 0,   medianHours: 13.6, earlyHours: 0,    lateHours: 13.6, observations: 42 },
        { seat: 2, idealHours: 24,  medianHours: 28.0, earlyHours: 0,    lateHours: 4,    observations: 42 },
        { seat: 3, idealHours: 48,  medianHours: 36.3, earlyHours: 11.7, lateHours: 0,    observations: 41 },
        { seat: 4, idealHours: 72,  medianHours: 44.6, earlyHours: 27.4, lateHours: 0,    observations: 41 },
        { seat: 5, idealHours: 96,  medianHours: 52.8, earlyHours: 43.2, lateHours: 0,    observations: 40 },
        { seat: 6, idealHours: 120, medianHours: 65.0, earlyHours: 55,   lateHours: 0,    observations: 40 },
      ],
    },
  },
}

const ON_THE_LINE = {
  measured: true,
  reason: 'ok',
  window_days: 180,
  headline: null,
  byRoleCount: {
    4: {
      roles: 4, earlyHoursTotal: 0, earlyPersonDays: 0, worstSeat: null,
      thinSeats: [], implausibleSeats: [],
      seats: [1, 2, 3, 4].map((s) => ({
        seat: s, idealHours: 24 * (s - 1), medianHours: 24 * (s - 1),
        earlyHours: 0, lateHours: 0, observations: 30,
      })),
    },
  },
}

describe('SeatTimingPanel', () => {
  it('leads with the seat worth acting on', () => {
    render(<SeatTimingPanel timing={CAPACITYX} />)
    const lead = screen.getByTestId('seat-headline')
    expect(lead.textContent).toMatch(/6th seat/i)
    expect(lead.textContent).toMatch(/55h/)
  })

  it('⚠️ says what the earliness buys, not just that it exists', () => {
    // "55h early" is a fact; "5.7 person-days per crime, freed with no training
    // and no scope cost" is the reason to care. The whole point of the panel is
    // that this is a lever, so it has to read as one.
    render(<SeatTimingPanel timing={CAPACITYX} />)
    expect(screen.getByTestId('seat-headline').textContent).toMatch(/5\.7 person-days/)
  })

  it('shows each seat against the hour it is needed', () => {
    // Both numbers in one row, as "taken / needed" — the DISTANCE between them
    // is the finding, so they are read together rather than in two columns.
    render(<SeatTimingPanel timing={CAPACITYX} />)
    const row = screen.getByTestId('seat-row-6').textContent
    expect(row).toMatch(/65h/)    // actually taken
    expect(row).toMatch(/120h/)   // needed at
  })

  it('⚠️ marks late seats as late rather than hiding them', () => {
    // capacityx's first two seats are LATE. A panel that only drew the early
    // side would imply a faction is uniformly early and make the advice wrong
    // for the seats it is wrong about.
    render(<SeatTimingPanel timing={CAPACITYX} />)
    expect(within(screen.getByTestId('seat-row-1')).getByText(/13\.6h late/i)).toBeTruthy()
    expect(within(screen.getByTestId('seat-row-3')).getByText(/11\.7h early/i)).toBeTruthy()
  })

  it('⚠️ congratulates a faction on the line instead of inventing a lever', () => {
    render(<SeatTimingPanel timing={ON_THE_LINE} />)
    expect(screen.queryByTestId('seat-headline')).toBeNull()
    expect(screen.getByTestId('seat-on-track').textContent).toMatch(/on schedule/i)
  })

  it('names the window, because a median over 180 days is a different claim to one over 7', () => {
    render(<SeatTimingPanel timing={CAPACITYX} />)
    expect(screen.getByText(/180 days/)).toBeTruthy()
  })
})

describe('SeatTimingPanel — when it should not draw', () => {
  it('renders nothing before the fetch lands', () => {
    const { container } = render(<SeatTimingPanel timing={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for a faction with no history', () => {
    const { container } = render(
      <SeatTimingPanel timing={{ measured: false, reason: 'no-observations', byRoleCount: {}, headline: null }} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('⚠️ survives a role count whose seats were all dropped', () => {
    // Every seat thin or implausible leaves an empty seats array. Reducing over
    // it for a max is fine; rendering a table of nothing under a heading that
    // promises one is not.
    const { container } = render(
      <SeatTimingPanel timing={{
        measured: true, reason: 'ok', window_days: 180, headline: null,
        byRoleCount: { 6: { roles: 6, seats: [], earlyHoursTotal: 0, earlyPersonDays: 0, worstSeat: null, thinSeats: [1, 2, 3, 4, 5, 6], implausibleSeats: [] } },
      }} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('⚠️ says which seats it could not measure rather than leaving a hole', () => {
    // A table missing seat 4 with no explanation reads as "nobody ever sits
    // there", which is a far more alarming claim than "we could not look".
    render(<SeatTimingPanel timing={{
      ...CAPACITYX,
      byRoleCount: {
        6: { ...CAPACITYX.byRoleCount[6], thinSeats: [2], seats: CAPACITYX.byRoleCount[6].seats.filter((s) => s.seat !== 2) },
      },
    }} />)
    expect(screen.getByTestId('seat-gaps').textContent).toMatch(/seat 2/i)
  })
})
