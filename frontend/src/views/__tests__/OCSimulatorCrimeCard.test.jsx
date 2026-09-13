// @vitest-environment jsdom
//
// ⚠️ MOUNTS THE COMPONENT THE HOOKS LIVE IN.
//
// v3.97.0's crash was a `useMemo` whose dependency array named a `const` from
// above its own declaration — a temporal-dead-zone throw on every render.
// `OCSimulatorResultPanel.test.jsx` was written in response, but it mounts
// `ResultPanel`; #707 added state and a callback to `CrimeCard`, a different
// component that nothing was mounting. Same gap, one file along.
//
// The assertions matter less than the render.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { CrimeCard } from '../OCSimulatorView'

vi.mock('../../api', () => ({
  apiGet: vi.fn(async () => ({ readings: {}, roster_size: 0, unmatched_roles: [], conflicts: [] })),
  apiPost: vi.fn(async () => ({ result: { successChance: 0.5, failureChance: 0.5 } })),
}))

const SCENARIO = {
  name: 'Blast from the Past',
  parameter_count: 2,
  is_complete: true,
  observed_paths: 912,
  roles: [
    { position_id: 'P1', role_name: 'Muscle', weight: 60 },
    { position_id: 'P2', role_name: 'Picklock 2', weight: 40 },
  ],
  endings: [
    { ending_key: 'goodEnding1', kind: 'good', resolved: true, node_id: 'A', money_avg: 1000 },
    { ending_key: 'badEnding1', kind: 'bad', resolved: true, node_id: 'F' },
  ],
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

describe('CrimeCard', () => {
  it('⚠️ renders without throwing', async () => {
    render(<CrimeCard scenario={SCENARIO} onRemove={() => {}} />)
    expect(screen.getByText(/Blast from the Past/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/Muscle/)).toBeTruthy())
  })

  it('offers the CPR suggestion without computing it up front', async () => {
    // ⚠️ On demand, never on render: every candidate is a call to a small
    // third-party probability service.
    render(<CrimeCard scenario={SCENARIO} onRemove={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Suggest minimum CPRs/i)).toBeTruthy())
  })

  it('survives a roster the API has nothing for', async () => {
    render(<CrimeCard scenario={SCENARIO} onRemove={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Blast from the Past/)).toBeTruthy())
  })
})
