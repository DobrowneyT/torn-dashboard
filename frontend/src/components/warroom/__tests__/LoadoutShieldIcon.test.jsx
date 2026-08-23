// @vitest-environment jsdom
//
// Rendering-level proof for the loadout shield icon (#528 Part 2 follow-up):
// a small, self-contained presentational component (props in, no fetching),
// so it mounts directly rather than needing the desktop War Room's own
// auth/websocket data layer.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import LoadoutShieldIcon from '../LoadoutShieldIcon'

afterEach(cleanup)

describe('LoadoutShieldIcon', () => {
  it('renders nothing when there is no observation for this member', () => {
    const { container } = render(<LoadoutShieldIcon loadoutRow={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for an observation with an empty loadout', () => {
    const { container } = render(<LoadoutShieldIcon loadoutRow={{ loadout: { weapons: {}, armor: {} } }} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows the shield and a tooltip with every captured slot, who saw it, and its age', () => {
    render(
      <LoadoutShieldIcon
        loadoutRow={{
          loadout: {
            weapons: { primary: { name: 'AK-47' } },
            armor: { chest: { name: 'Combat Vest' } },
          },
          observed_by_name: 'Scout',
          observed_at: new Date().toISOString(),
        }}
      />
    )
    expect(screen.getByText('AK-47')).toBeTruthy()
    expect(screen.getByText('Combat Vest')).toBeTruthy()
    expect(screen.getByText(/Observed .* by Scout/)).toBeTruthy()
  })

  it('⚠️ dims the icon and marks the tooltip stale once past the 1h threshold — a stale loadout shown confidently is worse than none', () => {
    const hourAndHalfAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString()
    const { container } = render(
      <LoadoutShieldIcon
        loadoutRow={{
          loadout: { weapons: { primary: { name: 'AK-47' } }, armor: {} },
          observed_at: hourAndHalfAgo,
        }}
      />
    )
    expect(screen.getByText(/— stale/)).toBeTruthy()
    expect(container.querySelector('svg').getAttribute('class')).toContain('text-gray-400')
  })

  it('is not marked stale just under the threshold', () => {
    const fiftyMinAgo = new Date(Date.now() - 50 * 60 * 1000).toISOString()
    const { container } = render(
      <LoadoutShieldIcon
        loadoutRow={{
          loadout: { weapons: { primary: { name: 'AK-47' } }, armor: {} },
          observed_at: fiftyMinAgo,
        }}
      />
    )
    expect(screen.queryByText(/— stale/)).toBeNull()
    expect(container.querySelector('svg').getAttribute('class')).toContain('text-emerald-600')
  })
})
