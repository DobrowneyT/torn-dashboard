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
})
