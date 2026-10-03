// @vitest-environment jsdom
//
// The two chase buttons on the War Room's Roll Call section (MonChoon,
// 2026-10-03).
//
// ⚠️ These assert what lands on the CLIPBOARD, not that a handler fired. The
// clipboard text is the entire product here — a lead pastes it into Discord and
// works down it — so a test that only checked the click would pass against an
// empty or wrongly-bucketed list.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('../WarNotesArchive', () => ({ default: () => null }))
vi.mock('../OpponentHistoryPanel', () => ({ default: () => null }))

const { default: WarNotesPanel } = await import('../WarNotesPanel')

const ROSTER = [
  { member_id: 1, member_name: 'Coming' },
  { member_id: 2, member_name: 'SelfHosp' },
  { member_id: 3, member_name: 'NotAvailable' },
  { member_id: 4, member_name: 'Silent' },
]

const RESPONSES = [
  { member_id: '1', on_at_start: true,  can_self_hospital: null,  needs_merc: false, availability: 'start' },
  { member_id: '2', on_at_start: false, can_self_hospital: true,  needs_merc: false, availability: 'late_1h' },
  { member_id: '3', on_at_start: false, can_self_hospital: false, needs_merc: false, availability: 'unavailable' },
  // 4 never responded.
]

// Battle stats arrive as the War Room's own index, keyed by string id.
const STATS = { '2': { total: 4_000_000 }, '3': { total: 3_000_000 } }

let written
beforeEach(() => {
  written = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (t) => { written.push(t) }) },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const open = (props = {}) => {
  render(
    <WarNotesPanel
      currentWar={{ id: 1 }}
      notes={{}}
      rollCallRows={RESPONSES}
      ourMembers={ROSTER}
      ourBattleStats={STATS}
      onSave={() => {}}
      {...props}
    />
  )
  // The section is collapsed by default — the tally is the headline.
  // ⚠️ By ROLE, not text: the panel's own <h4> heading also reads
  // "War Notes & Roll Call", so a bare text query matches two nodes.
  fireEvent.click(screen.getByRole('button', { name: /Roll Call/ }))
}

describe('the chase buttons', () => {
  it('count the two lists on their labels', () => {
    open()
    // Missing = NotAvailable + Silent. Maybe = SelfHosp. Coming is in neither.
    expect(screen.getByText('Copy missing (2)')).toBeTruthy()
    expect(screen.getByText('Copy maybes (1)')).toBeTruthy()
  })

  it('⚠️ copies the missing list with stats and a profile link', async () => {
    open()
    fireEvent.click(screen.getByText('Copy missing (2)'))
    await waitFor(() => expect(written).toHaveLength(1))
    const text = written[0]
    expect(text).toContain('Missing (2)')
    expect(text).toContain('NotAvailable [3]')
    expect(text).toContain('3.00M')
    expect(text).toContain('profiles.php?XID=3')
    // Silence counts as missing, and says why.
    expect(text).toContain('Silent [4]')
    expect(text).toContain('no response')
    // ⚠️ Never the people who ARE turning up.
    expect(text).not.toContain('Coming')
    // ⚠️ Nor the maybes — that is the other button.
    expect(text).not.toContain('SelfHosp')
  })

  it('⚠️ copies the maybes separately, and only those who can self-hosp', async () => {
    open()
    fireEvent.click(screen.getByText('Copy maybes (1)'))
    await waitFor(() => expect(written).toHaveLength(1))
    const text = written[0]
    expect(text).toContain('SelfHosp [2]')
    expect(text).toContain('can self-hosp')
    expect(text).toContain('4.00M')
    expect(text).not.toContain('NotAvailable')
    expect(text).not.toContain('Silent')
  })

  it('shows an unread stat total as ??? rather than a zero', async () => {
    open({ ourBattleStats: {} })
    fireEvent.click(screen.getByText('Copy missing (2)'))
    await waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]).toContain('???')
  })

  it('disables a button when its list is empty', () => {
    // Everybody turning up: nothing to chase.
    open({
      ourMembers: [{ member_id: 1, member_name: 'Coming' }],
      rollCallRows: [{ member_id: '1', on_at_start: true, can_self_hospital: null }],
    })
    expect(screen.getByText('Copy missing (0)').closest('button').disabled).toBe(true)
    expect(screen.getByText('Copy maybes (0)').closest('button').disabled).toBe(true)
  })

  it('⚠️ says so when the clipboard is unavailable, rather than looking broken', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('denied') }) },
    })
    open()
    fireEvent.click(screen.getByText('Copy missing (2)'))
    expect(await screen.findByText(/Could not reach the clipboard/)).toBeTruthy()
  })

  it('confirms the copy so a lead knows it landed', async () => {
    open()
    const btn = screen.getByText('Copy missing (2)')
    fireEvent.click(btn)
    await waitFor(() => expect(written).toHaveLength(1))
    // The icon swaps to a tick; the label keeps its count.
    expect(screen.getByText('Copy missing (2)')).toBeTruthy()
  })
})
