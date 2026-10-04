// @vitest-environment jsdom
//
// #872 — the faction Hall of Fame board.
//
// ⚠️ The use case is BRAGGING RIGHTS (Singularity, 2026-10-03). Screening
// applicants and spotting anomalies were offered and declined, so these tests
// guard the absence of judgement as much as the presence of a board.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../../../utils/apiClient', () => ({ apiGet: vi.fn() }))
const { apiGet } = await import('../../../utils/apiClient')
const { default: HofSection } = await import('../HofSection')

const payload = (over = {}) => ({
  memberCount: 3,
  snapshotDate: '2026-10-03',
  fetchedMs: Date.UTC(2026, 9, 3),
  categories: [
    {
      category: 'working_stats',
      rows: [
        { memberId: '1', memberName: 'Alice', value: 12_000_000, globalRank: 48_000, factionRank: 1 },
        { memberId: '2', memberName: 'Bob', value: 9_000_000, globalRank: 91_000, factionRank: 2 },
        { memberId: '3', memberName: 'Carol', value: 1_000, globalRank: null, factionRank: 3 },
      ],
    },
    {
      category: 'revives',
      rows: [{ memberId: '2', memberName: 'Bob', value: 500, globalRank: 2_000, factionRank: 1 }],
    },
  ],
  ...over,
})

beforeEach(() => vi.clearAllMocks())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('HofSection', () => {
  it('opens on the first category and ranks the faction', async () => {
    apiGet.mockResolvedValue(payload())
    render(<HofSection />)
    expect(await screen.findByText('Alice')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.getByText('Carol')).toBeTruthy()
  })

  it('shows the global position beside the faction one, as an ordinal', async () => {
    // Singularity's own phrasing: "3rd in forge, 48,000th in Torn".
    apiGet.mockResolvedValue(payload())
    render(<HofSection />)
    expect(await screen.findByText('48,000th')).toBeTruthy()
    expect(screen.getByText('91,000th')).toBeTruthy()
  })

  it('⚠️ shows an em dash when Torn gave no global rank', async () => {
    // A fabricated position on a board people quote at each other is worse
    // than an honest gap.
    apiGet.mockResolvedValue(payload())
    render(<HofSection />)
    await screen.findByText('Carol')
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('switches category on click', async () => {
    apiGet.mockResolvedValue(payload())
    render(<HofSection />)
    fireEvent.click(await screen.findByText('Revives'))
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.queryByText('Alice')).toBeNull()
  })

  it('⚠️ never offers battle stats, and says why', async () => {
    // Torn returns it as null for other players, so a faction-wide board is
    // impossible. Its unexplained absence would otherwise be reported as a bug.
    apiGet.mockResolvedValue(payload())
    render(<HofSection />)
    await screen.findByText('Alice')
    expect(screen.queryByText(/battle stats/i)).toBeNull()
    fireEvent.click(screen.getByText('how to read it'))
    expect(await screen.findByText(/only reports those to you about yourself/i)).toBeTruthy()
  })

  it('⚠️ shows no thresholds, flags or compliance language', async () => {
    // This is a leaderboard, not an assessment. A board that implies judgement
    // stops being fun and starts being a performance review.
    apiGet.mockResolvedValue(payload())
    const { container } = render(<HofSection />)
    await screen.findByText('Alice')
    expect(container.textContent).not.toMatch(/threshold|flagged|inconclusive|compliance|below min/i)
  })

  it('renders an empty state before the first sweep, not an error', async () => {
    apiGet.mockResolvedValue({ memberCount: 0, snapshotDate: null, fetchedMs: null, categories: [] })
    render(<HofSection />)
    expect(await screen.findByText(/No standings yet/)).toBeTruthy()
  })

  it('surfaces a load failure instead of spinning forever', async () => {
    apiGet.mockRejectedValue(new Error('upstream exploded'))
    render(<HofSection />)
    expect(await screen.findByText('upstream exploded')).toBeTruthy()
  })

  it('explains that unread members are left out rather than ranked last', async () => {
    apiGet.mockResolvedValue(payload())
    render(<HofSection />)
    fireEvent.click(await screen.findByText('how to read it'))
    expect(await screen.findByText(/left out rather than ranked last/i)).toBeTruthy()
  })

  // =========================================================================
  // ⚠️ NUMERIC SORTING
  // =========================================================================
  //
  // The board shipped sorting every numeric column as TEXT, because
  // `compareValues` falls through to `localeCompare` when a column declares no
  // `kind` and BOARD_COLUMNS declared none. Real boards came out
  //
  //     #            1, 10, 11, 12 … 19, 2, 20 … 29, 3
  //     Racing skill 9.77, 9.32, 8.94, 8.77, 77.35, 75.33, 7.91
  //     Racing wins  97, 94, 933, 93, 89, 8,775, 86, 83, 808
  //
  // ⚠️ **The fixture above cannot catch this and never could.** It has three
  // rows ranked 1, 2, 3 — single digits, which sort identically as text and as
  // numbers. Every one of these tests passed while all four columns were
  // broken. A sorting fixture needs a value whose text order and numeric order
  // DISAGREE, so these use two-digit ranks and decimals.
  const ranked = (container) =>
    [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td').textContent)

  // Racing skill, as captured from the live board.
  const bigBoard = () => ({
    memberCount: 12,
    snapshotDate: '2026-10-04',
    fetchedMs: Date.UTC(2026, 9, 4),
    categories: [{
      category: 'racing_skill',
      rows: [77.35, 75.33, 68.95, 68.38, 9.77, 9.32, 8.94, 8.77, 7.91, 7.79, 7.49, 1.05]
        .map((value, i) => ({
          memberId: String(i + 1),
          memberName: `Racer${i + 1}`,
          value,
          globalRank: (i + 1) * 1000,
          factionRank: i + 1,
        })),
    }],
  })

  it('⚠️ ranks the # column numerically, not as text', async () => {
    apiGet.mockResolvedValue(bigBoard())
    const { container } = render(<HofSection />)
    await screen.findByText('Racer1')
    // Lexically this is 1, 10, 11, 12, 2, 3, … — which is what shipped.
    expect(ranked(container)).toEqual(['1','2','3','4','5','6','7','8','9','10','11','12'])
  })

  it('⚠️ sorts the value column numerically, not as text', async () => {
    apiGet.mockResolvedValue(bigBoard())
    const { container } = render(<HofSection />)
    await screen.findByText('Racer1')

    // The third header is the value column; its label is the category's.
    // ⚠️ The click target is the BUTTON inside the <th>, not the cell.
    // SortableTh puts onClick on the button, and events bubble up rather than
    // down, so clicking the <th> reorders nothing and the assertion below
    // silently compares the board to its own unsorted self.
    const valueTh = container.querySelectorAll('thead th')[2]
    expect(valueTh.textContent).toContain('Racing skill')
    fireEvent.click(valueTh.querySelector('button'))   // first click is ascending

    // Ascending by value is descending by rank. Sorted as TEXT it would be
    // 1.05, 68.38, 68.95, 7.49 … — ranks 12, 4, 3, 11 …
    expect(ranked(container)).toEqual(['12','11','10','9','8','7','6','5','4','3','2','1'])
  })

  it('⚠️ says travel time is in seconds, on the header but not the picker', async () => {
    // Torn's own spec: "Traveltime is shown in seconds." The live figures are
    // all exact multiples of 86,400, so they read as a DAY count and the unit
    // is easy to get wrong from the data alone.
    apiGet.mockResolvedValue({
      memberCount: 1,
      snapshotDate: '2026-10-04',
      fetchedMs: Date.UTC(2026, 9, 4),
      categories: [{
        category: 'travel_time',
        rows: [{ memberId: '1', memberName: 'Wanderer', value: 9_849_600, globalRank: 12, factionRank: 1 }],
      }],
    })
    const { container } = render(<HofSection />)
    await screen.findByText('Wanderer')
    expect(container.querySelectorAll('thead th')[2].textContent).toContain('Travel time (seconds)')
    // The picker chip stays unadorned.
    const chip = [...container.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Travel time')
    expect(chip).toBeTruthy()
  })

  it('⚠️ sorts the global rank numerically, and still sinks the unplaced', async () => {
    const board = bigBoard()
    board.categories[0].rows[3].globalRank = null
    apiGet.mockResolvedValue(board)
    const { container } = render(<HofSection />)
    await screen.findByText('Racer1')

    fireEvent.click(container.querySelectorAll('thead th')[3].querySelector('button'))
    const order = ranked(container)
    // 1000, 2000, 3000 … sorts as text to 1000, 10000, 11000, 12000, 2000 …
    expect(order.slice(0, 3)).toEqual(['1','2','3'])
    // #351: no global rank means UNPLACED, so it sinks even ascending.
    expect(order[order.length - 1]).toBe('4')
  })
})
