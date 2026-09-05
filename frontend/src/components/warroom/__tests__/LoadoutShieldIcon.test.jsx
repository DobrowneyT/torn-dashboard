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

  // Three bands, not two. A single stale/fresh flag made a 61-minute-old
  // observation and a week-old one look identical, which is the wrong shape for
  // gear: within a war, what someone wore two hours ago is almost certainly
  // still true, while yesterday's is a hint at best.
  const shieldFor = (minutesAgo) => {
    const { container } = render(
      <LoadoutShieldIcon
        loadoutRow={{
          loadout: { weapons: { primary: { name: 'AK-47' } }, armor: {} },
          observed_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
        }}
      />
    )
    return container.querySelector('svg').getAttribute('class')
  }

  it('is green under 2h — act on it', () => {
    expect(shieldFor(5)).toContain('text-emerald-600')
    expect(shieldFor(119)).toContain('text-emerald-600')
    expect(screen.queryByText(/over 2h old/)).toBeNull()
  })

  it('is amber between 2h and 24h — probably still right', () => {
    expect(shieldFor(121)).toContain('text-amber-600')
    expect(screen.getByText(/over 2h old/)).toBeTruthy()
  })

  it('is grey past 24h — a hint, not a fact', () => {
    expect(shieldFor(25 * 60)).toContain('text-gray-400')
    expect(screen.getByText(/over a day old/)).toBeTruthy()
  })

  it('⚠️ treats an undateable observation as the LEAST confident band — the honest answer when we cannot date it, not the most flattering one', () => {
    const { container } = render(
      <LoadoutShieldIcon
        loadoutRow={{ loadout: { weapons: { primary: { name: 'AK-47' } }, armor: {} } }}
      />
    )
    expect(container.querySelector('svg').getAttribute('class')).toContain('text-gray-400')
  })
})
