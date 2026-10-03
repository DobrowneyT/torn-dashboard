// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

/**
 * #458 — the panel's job is to say which half of the perk tree is working.
 *
 * ⚠️ The tests lean on that one question rather than on layout. Getting the
 * active/inactive split backwards is worse than not building the page: someone
 * plans a five-day training book around a Steadfast percentage that is only
 * live in war state, and a flat list looks completely plausible while doing it.
 */

vi.mock('../../../utils/apiClient', () => ({ apiGet: vi.fn() }))
const { apiGet } = await import('../../../utils/apiClient')
const { default: UpgradesSection } = await import('../UpgradesSection')

const upgrade = (over = {}) => ({
  id: 1, name: 'Defense training XVI', ability: 'Increases defense gym gains by 16%',
  level: 16, cost: 11279, unlockedMs: 1790812804 * 1000, ...over,
})

const payload = (over = {}) => ({
  snapshotDate: '2026-10-03', fetchedMs: Date.UTC(2026, 9, 3),
  state: 'peace', inactiveState: 'war',
  active: [{ name: 'Steadfast', order: 4, multiplier: 8, upgrades: [upgrade()] }],
  inactive: [{ name: 'Suppression', order: 2, multiplier: 4, upgrades: [upgrade({ id: 50, name: 'Ambush', ability: 'war only', level: 1 })] }],
  core: [{ id: 99, name: 'Weapon armory', ability: 'Unlocks weapon armory', level: 1, cost: 1000, unlockedMs: 1484661886000 }],
  ...over,
})

beforeEach(() => vi.clearAllMocks())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('UpgradesSection', () => {
  it('leads with the state actually in effect', async () => {
    apiGet.mockResolvedValue(payload())
    render(<UpgradesSection />)
    expect(await screen.findByText('At peace')).toBeTruthy()
    expect(screen.getByText('In effect now')).toBeTruthy()
  })

  it('⚠️ shows the active branch but keeps the inactive one collapsed', async () => {
    apiGet.mockResolvedValue(payload())
    render(<UpgradesSection />)
    expect(await screen.findByText('Steadfast')).toBeTruthy()
    expect(screen.queryByText('Suppression')).toBeNull()
    expect(screen.getByText(/War branches — not in effect/)).toBeTruthy()
  })

  it('reveals the inactive branches on request, labelled as giving nothing', async () => {
    apiGet.mockResolvedValue(payload())
    render(<UpgradesSection />)
    fireEvent.click(await screen.findByText(/War branches — not in effect/))
    expect(screen.getByText('Suppression')).toBeTruthy()
    expect(screen.getByText(/Do not plan around these/)).toBeTruthy()
  })

  it('swaps which side is primary when the faction is at war', async () => {
    apiGet.mockResolvedValue(payload({
      state: 'war', inactiveState: 'peace',
      active: [{ name: 'Suppression', order: 2, multiplier: 4, upgrades: [upgrade({ name: 'Ambush' })] }],
      inactive: [{ name: 'Steadfast', order: 4, multiplier: 8, upgrades: [upgrade()] }],
    }))
    render(<UpgradesSection />)
    expect(await screen.findByText('At war')).toBeTruthy()
    expect(screen.getByText('Suppression')).toBeTruthy()
    expect(screen.getByText(/Peace branches — not in effect/)).toBeTruthy()
  })

  it("renders Torn's own ability text, not a re-derived percentage", async () => {
    apiGet.mockResolvedValue(payload())
    render(<UpgradesSection />)
    expect(await screen.findByText('Increases defense gym gains by 16%')).toBeTruthy()
  })

  it('falls back to the level when Torn gave no ability text, inventing nothing', async () => {
    apiGet.mockResolvedValue(payload({
      active: [{ name: 'Steadfast', order: 4, multiplier: 8, upgrades: [upgrade({ ability: '', level: 7 })] }],
    }))
    render(<UpgradesSection />)
    expect(await screen.findByText('Level 7')).toBeTruthy()
  })

  it('⚠️ dates an unlock from epoch MILLIseconds, not 1970', async () => {
    apiGet.mockResolvedValue(payload())
    render(<UpgradesSection />)
    // 1790812804s → 1 Oct 2026. Treating it as ms would render Jan 1970, and
    // treating it as a DB timestamp string would render "Invalid Date".
    await screen.findByText('Steadfast')
    const dates = screen.getAllByText(/\b(19|20)\d{2}\b/).map(n => n.textContent)
    expect(dates.some(t => /Oct 1, 2026|1 Oct 2026/.test(t))).toBe(true)
    expect(dates.some(t => /1970|Invalid/.test(t))).toBe(false)
  })

  it('⚠️ claims no active side when Torn did not report the state', async () => {
    apiGet.mockResolvedValue(payload({ state: null, inactiveState: null, active: [] }))
    render(<UpgradesSection />)
    expect(await screen.findByText('Faction state unknown')).toBeTruthy()
    expect(screen.queryByText('In effect now')).toBeNull()
    expect(screen.getByText(/did not report whether the faction is at war/)).toBeTruthy()
  })

  it('renders an empty state before the first scrape, not an error', async () => {
    apiGet.mockResolvedValue({ snapshotDate: null, fetchedMs: null, state: null, active: [], inactive: [], core: [] })
    render(<UpgradesSection />)
    expect(await screen.findByText(/No snapshot yet/)).toBeTruthy()
  })

  it('surfaces a load failure instead of spinning forever', async () => {
    apiGet.mockRejectedValue(new Error('upstream exploded'))
    render(<UpgradesSection />)
    expect(await screen.findByText('upstream exploded')).toBeTruthy()
  })

  it('separates always-on core unlocks from the war/peace question', async () => {
    apiGet.mockResolvedValue(payload())
    render(<UpgradesSection />)
    expect(await screen.findByText('Core unlocks')).toBeTruthy()
    expect(screen.getByText('Weapon armory')).toBeTruthy()
  })
})
