// @vitest-environment jsdom
//
// Live status, settings and history (#889, slices 6 and 7).
//
// The theme: this is the part people act on in a hurry. A countdown that lies
// by fifteen minutes, a severity silently wiped from the board, or a record
// that says "somebody edited the reason" without saying what it was — each is
// worse than not having the feature.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('../../../utils/apiClient', () => ({
  apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn(),
}))
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 9010, name: 'Me' } }),
}))

const { apiGet, apiPut } = await import('../../../utils/apiClient')
const { default: GrudgeList } = await import('../GrudgeList')
const { default: GrudgeSettings } = await import('../GrudgeSettings')
const { default: GrudgeHistory } = await import('../GrudgeHistory')

const nowSec = () => Math.floor(Date.now() / 1000)

const target = (over = {}) => ({
  id: 1, target_id: '5001', target_name: 'Likor', faction_id: null, faction_name: null,
  state: 'active', bsp_total: null, spy_source: null, level: 40,
  status_state: 'Okay', status_until: null, added_ms: Date.UTC(2026, 9, 4),
  added_by: '9010',
  grudges: [{ id: 11, member_id: '9010', member_name: 'Me', reason: 'mugged me' }],
  ...over,
})

beforeEach(() => vi.clearAllMocks())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('live hospital status', () => {
  const statusOf = (c) => c.querySelectorAll('tbody td')[6].textContent

  it('shows a countdown, not just the word Hospital', () => {
    // "Hospital" alone tells you nothing you can chain off.
    const rows = [target({ status_state: 'Hospital', status_until: nowSec() + 724 })]
    const { container } = render(<GrudgeList targets={rows} viewerId={9010} />)
    expect(statusOf(container)).toMatch(/Hospital/)
    expect(statusOf(container)).toMatch(/12m 0\ds/)
  })

  it('⚠️ says OUT NOW once the timer has run out, without waiting for the server', () => {
    // The server still says Hospital — it refreshes every 15 minutes — and
    // waiting for it would deliver the one moment you care about late.
    const rows = [target({ status_state: 'Hospital', status_until: nowSec() - 5 })]
    const { container } = render(<GrudgeList targets={rows} viewerId={9010} />)
    expect(statusOf(container)).toMatch(/Out now/i)
  })

  it('shows Okay plainly', () => {
    const { container } = render(<GrudgeList targets={[target()]} viewerId={9010} />)
    expect(statusOf(container)).toMatch(/Okay/)
  })

  it('⚠️ shows a dash, not a countdown, for a state we have never read', () => {
    const rows = [target({ status_state: null, status_until: null })]
    const { container } = render(<GrudgeList targets={rows} viewerId={9010} />)
    expect(statusOf(container).trim()).toBe('—')
  })

  it('⚠️ shows no countdown for a state with no end, like travelling', () => {
    // Torn sends until: 0 there. A countdown would be invented.
    const rows = [target({ status_state: 'Traveling', status_until: 0 })]
    const { container } = render(<GrudgeList targets={rows} viewerId={9010} />)
    expect(statusOf(container)).toMatch(/Traveling/)
    expect(statusOf(container)).not.toMatch(/\d+m \d+s/)
  })

  it('⚠️ "hide hospital" keeps somebody whose timer already expired', () => {
    // Hiding them would hide exactly the target you were waiting for.
    const rows = [
      target({ id: 1, target_id: '1', target_name: 'Still in', status_state: 'Hospital', status_until: nowSec() + 600 }),
      target({ id: 2, target_id: '2', target_name: 'Just out', status_state: 'Hospital', status_until: nowSec() - 5 }),
    ]
    const { container } = render(<GrudgeList targets={rows} viewerId={9010} />)
    fireEvent.click(screen.getByLabelText(/hide anyone in hospital/i))
    const names = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('a').textContent)
    expect(names).toEqual(['Just out'])
  })

  it('⚠️ defaults to "who can I hit soonest", with the unknown sinking', () => {
    const rows = [
      target({ id: 1, target_id: '1', target_name: 'Later', status_state: 'Hospital', status_until: nowSec() + 900 }),
      target({ id: 2, target_id: '2', target_name: 'Unknown', status_state: 'Traveling', status_until: 0 }),
      target({ id: 3, target_id: '3', target_name: 'Free', status_state: 'Okay' }),
      target({ id: 4, target_id: '4', target_name: 'Soon', status_state: 'Hospital', status_until: nowSec() + 60 }),
    ]
    const { container } = render(<GrudgeList targets={rows} viewerId={9010} />)
    const names = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('a').textContent)
    expect(names).toEqual(['Free', 'Soon', 'Later', 'Unknown'])
  })

  it('shows the level it looked up', () => {
    const { container } = render(<GrudgeList targets={[target({ level: 74 })]} viewerId={9010} />)
    expect(container.querySelectorAll('tbody td')[5].textContent).toBe('74')
  })
})

describe('GrudgeSettings', () => {
  beforeEach(() => apiGet.mockResolvedValue({ usage: { petty: 3 } }))

  it('edits a severity label and saves it', async () => {
    apiPut.mockResolvedValue({ severities: [], watched_factions: [], grudges_cleared: 0 })
    render(<GrudgeSettings severities={[{ id: 'petty', label: 'Petty' }]} watchedFactions={['10739']} />)
    fireEvent.change(await screen.findByLabelText('Severity 1'), { target: { value: 'Mildly annoying' } })
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() => expect(apiPut).toHaveBeenCalled())
    // ⚠️ The id goes back unchanged, which is what stops a rename orphaning
    // every grudge that used it.
    expect(apiPut.mock.calls[0][1].severities).toEqual([{ id: 'petty', label: 'Mildly annoying' }])
  })

  it('⚠️ warns BEFORE saving that a removal will clear grudges', async () => {
    // Finding out afterwards is how somebody silently wipes a field across the
    // whole board.
    render(<GrudgeSettings severities={[{ id: 'petty', label: 'Petty' }]} watchedFactions={[]} />)
    await screen.findByLabelText('Severity 1')
    fireEvent.click(screen.getByLabelText(/Remove Petty/i))
    expect(await screen.findByText(/3 using "Petty"/)).toBeTruthy()
  })

  it('⚠️ says renaming is safe, because it looks like it might not be', async () => {
    render(<GrudgeSettings severities={[]} watchedFactions={[]} />)
    expect(await screen.findByText(/Renaming one is safe/i)).toBeTruthy()
  })

  it('parses watched factions from however they were pasted', async () => {
    apiPut.mockResolvedValue({ severities: [], watched_factions: [], grudges_cleared: 0 })
    render(<GrudgeSettings severities={[]} watchedFactions={[]} />)
    fireEvent.change(await screen.findByLabelText(/watched factions/i), {
      target: { value: '10739, 8103  9999' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() => expect(apiPut).toHaveBeenCalled())
    expect(apiPut.mock.calls[0][1].watched_factions).toEqual(['10739', '8103', '9999'])
  })

  it('reports how many grudges were cleared', async () => {
    apiPut.mockResolvedValue({ severities: [], watched_factions: [], grudges_cleared: 4 })
    render(<GrudgeSettings severities={[]} watchedFactions={[]} />)
    fireEvent.click(await screen.findByRole('button', { name: /save settings/i }))
    expect(await screen.findByText(/4 grudges had a removed severity cleared/i)).toBeTruthy()
  })

  it('surfaces a rejection instead of looking saved', async () => {
    apiPut.mockRejectedValue(new Error('every severity needs a label'))
    render(<GrudgeSettings severities={[]} watchedFactions={[]} />)
    fireEvent.click(await screen.findByRole('button', { name: /save settings/i }))
    expect(await screen.findByText('every severity needs a label')).toBeTruthy()
  })
})

describe('GrudgeHistory', () => {
  const row = (over = {}) => ({
    id: 1, target_id: '5001', actor_member_id: '9010', actor_name: 'Me',
    action: 'edited', field: 'reason', old_value: 'first', new_value: 'second',
    at_ms: Date.UTC(2026, 9, 4, 12, 0, 0), ...over,
  })

  it('⚠️ shows what the value CHANGED FROM, not just that it changed', async () => {
    // "Somebody edited the reason" without saying what it was is the half of
    // the record that has no value.
    apiGet.mockResolvedValue({ history: [row()] })
    render(<GrudgeHistory />)
    expect(await screen.findByText(/first → second/)).toBeTruthy()
  })

  it('names the actor in plain words', async () => {
    apiGet.mockResolvedValue({ history: [row({ action: 'added', field: 'reason' })] })
    render(<GrudgeHistory />)
    expect(await screen.findByText(/Me added a grudge/)).toBeTruthy()
  })

  it('⚠️ attributes an automatic change to the lookup, not to a person', async () => {
    // A rename spotted by the sweep is not something a member did.
    apiGet.mockResolvedValue({
      history: [row({ actor_member_id: 'system', actor_name: null, field: 'target_name' })],
    })
    render(<GrudgeHistory />)
    expect(await screen.findByText(/The lookup saw a name change/)).toBeTruthy()
  })

  it('scopes to one target when asked', async () => {
    apiGet.mockResolvedValue({ history: [] })
    render(<GrudgeHistory targetId="5001" />)
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/grudges/audit?target_id=5001'))
  })

  it('renders an empty history without looking broken', async () => {
    apiGet.mockResolvedValue({ history: [] })
    render(<GrudgeHistory />)
    expect(await screen.findByText(/Nothing has happened yet/i)).toBeTruthy()
  })

  it('surfaces a load failure', async () => {
    apiGet.mockRejectedValue(new Error('audit unavailable'))
    render(<GrudgeHistory />)
    expect(await screen.findByText('audit unavailable')).toBeTruthy()
  })
})
