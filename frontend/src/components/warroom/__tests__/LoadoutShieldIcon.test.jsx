// @vitest-environment jsdom
//
// Rendering-level proof for the loadout shield icon (#528 Part 2 follow-up):
// a small, self-contained presentational component (props in, no fetching),
// so it mounts directly rather than needing the desktop War Room's own
// auth/websocket data layer.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

  // ⚠️ The panel is no longer in the DOM until it is opened (#612). It used to
  // be rendered always and hidden with `group-hover`, which is precisely why it
  // did not exist on a phone: no hover, no panel, and a shield on screen
  // advertising gear nobody could read.
  // The band cases render twice without cleanup in between, so open the most
  // recent shield rather than assuming there is only one.
  const openPanel = () => {
    const shields = screen.getAllByRole('button', { name: 'Observed gear' })
    fireEvent.click(shields[shields.length - 1])
  }

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
    expect(screen.queryByText('AK-47')).toBeNull()
    openPanel()
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
    openPanel()
    expect(screen.queryByText(/over 2h old/)).toBeNull()
  })

  it('is amber between 2h and 24h — probably still right', () => {
    expect(shieldFor(121)).toContain('text-amber-600')
    openPanel()
    expect(screen.getByText(/over 2h old/)).toBeTruthy()
  })

  it('is grey past 24h — a hint, not a fact', () => {
    expect(shieldFor(25 * 60)).toContain('text-gray-400')
    openPanel()
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

/**
 * #929 — the bonuses, which were captured for a month with nothing showing
 * them. `formatBonusLine`, `rankedLoadoutEntries` and friends were written in
 * 3.93.0 and never imported by a component; MonChoon found it by looking at the
 * War Room and seeing no specials anywhere.
 */
describe('weapon bonuses (#929)', () => {
  const openPanel = () => {
    const shields = screen.getAllByRole('button', { name: 'Observed gear' })
    fireEvent.click(shields[shields.length - 1])
  }

  const withBonuses = (weapons) => ({
    loadout: { weapons, armor: { chest: { name: 'Dune Armour' } } },
    observed_by_name: 'Scout',
    observed_at: new Date().toISOString(),
  })

  it('lists a weapon\'s bonuses underneath it, comma-delimited', () => {
    render(<LoadoutShieldIcon loadoutRow={withBonuses({
      melee: {
        name: 'Macana',
        bonuses: [{ title: 'Cupid', percent: 84 }, { title: 'Achilles', percent: 50 }],
      },
    })} />)
    openPanel()
    expect(screen.getByText('Macana')).toBeTruthy()
    expect(screen.getByText('Cupid 84%, Achilles 50%')).toBeTruthy()
  })

  /**
   * ⚠️ The row has to be ITS OWN row under the weapon. Appended to the name
   * cell, "Burn 37%" reads as part of the weapon's name and a long bonus list
   * shoves the right-aligned names out of their column.
   */
  it('puts the bonuses on a separate row from the weapon name', () => {
    render(<LoadoutShieldIcon loadoutRow={withBonuses({
      secondary: { name: 'Flamethrower', bonuses: [{ title: 'Burn', percent: 37 }] },
    })} />)
    openPanel()
    const nameCell = screen.getByText('Flamethrower')
    const bonusCell = screen.getByText('Burn 37%')
    expect(nameCell.closest('tr')).not.toBe(bonusCell.closest('tr'))
  })

  /** ⚠️ Would otherwise print "Disarm NaN%" on a real capture. */
  it('shows a bonus with no percentage as its bare title', () => {
    render(<LoadoutShieldIcon loadoutRow={withBonuses({
      primary: {
        name: 'ArmaLite M-15A4',
        bonuses: [{ title: 'Focus', percent: 16 }, { title: 'Reflex Sight' }, { title: 'Disarm' }],
      },
    })} />)
    openPanel()
    expect(screen.getByText('Focus 16%, Reflex Sight, Disarm')).toBeTruthy()
  })

  it('renders no bonus row at all for an ordinary weapon', () => {
    render(<LoadoutShieldIcon loadoutRow={withBonuses({ primary: { name: 'Pocket Knife' } })} />)
    openPanel()
    expect(screen.getByText('Pocket Knife')).toBeTruthy()
    // One row for the weapon, one for the armour — no blank third row.
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2)
  })

  /**
   * ⚠️ Recorded, not rendered. MonChoon asked for damage/accuracy to be kept
   * "in case we ever decide to display it" — so they must NOT leak into the
   * panel now, or the decision has been made by accident.
   */
  it('does not show damage or accuracy', () => {
    render(<LoadoutShieldIcon loadoutRow={withBonuses({
      primary: { name: 'ArmaLite M-15A4', damage: 76.54, accuracy: 61.37 },
    })} />)
    openPanel()
    expect(screen.queryByText(/76\.54/)).toBeNull()
    expect(screen.queryByText(/61\.37/)).toBeNull()
  })

  it('still shows armour, which carries no bonuses', () => {
    render(<LoadoutShieldIcon loadoutRow={withBonuses({
      melee: { name: 'Macana', bonuses: [{ title: 'Cupid', percent: 84 }] },
    })} />)
    openPanel()
    expect(screen.getByText('Dune Armour')).toBeTruthy()
  })
})
