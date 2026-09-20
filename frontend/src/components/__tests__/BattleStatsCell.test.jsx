// @vitest-environment jsdom
//
// #612 — the battle-stats breakdown moved off CSS-only `group-hover` onto
// InfoTooltip. The cell is pure (props in, no fetching) so it mounts directly.
//
// ⚠️ What this guards is the exact-vs-estimate distinction. The cell exists to
// stop a lead sizing up a target against a number nobody ever measured, and
// that distinction is carried by the underline: solid emerald for a reading
// from the member's own key, dotted for a guess. `group-hover` meant the
// breakdown behind it did not exist at all on a phone.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import BattleStatsCell from '../BattleStatsCell'

afterEach(cleanup)

const BASE = {
  bsp_total: 4_000_000,
  bsp_str: 1_000_000,
  bsp_def: 1_000_000,
  bsp_spd: 1_000_000,
  bsp_dex: 1_000_000,
  bsp_fetched_at: new Date().toISOString(),
}

const open = () => fireEvent.click(screen.getByRole('button'))

describe('BattleStatsCell', () => {
  it('renders a dim placeholder and no trigger when there is no reading', () => {
    render(<BattleStatsCell member={{ bsp_total: null }} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('???')).toBeTruthy()
  })

  it('⚠️ opens the breakdown on a tap, which is the whole point on a phone', () => {
    render(<BattleStatsCell member={{ ...BASE, spy_source: 'bsp' }} />)
    expect(screen.queryByRole('tooltip')).toBeNull()
    open()
    const panel = screen.getByRole('tooltip')
    expect(panel.textContent).toContain('STR')
    expect(panel.textContent).toContain('Total')
  })

  it('⚠️ marks an own-key reading as exact, in the underline and in the source token', () => {
    // The sentence that used to say this was dropped (MonChoon, 2026-09-19): it
    // widened the panel to repeat what the solid underline and a three-letter
    // source token already carry. Both of those must therefore still be right.
    render(<BattleStatsCell member={{ ...BASE, spy_source: 'torn' }} />)
    const cls = screen.getByRole('button').className
    expect(cls).toContain('decoration-solid')
    expect(cls).not.toContain('decoration-dotted')
    open()
    expect(screen.getByRole('tooltip').textContent).toContain('(API)')
  })

  it('⚠️ leaves an estimate dotted, and never claims it is exact', () => {
    // A TornStats spy and a BSP guess must not render like a measurement.
    render(<BattleStatsCell member={{ ...BASE, spy_source: 'tornstats', ts_spy_at: new Date().toISOString() }} />)
    expect(screen.getByRole('button').className).toContain('decoration-dotted')
    open()
    const panel = screen.getByRole('tooltip').textContent
    expect(panel).toContain('(TS)')
    expect(panel).not.toContain('(API)')
  })

  it('still shows a total when the source carries no per-stat breakdown', () => {
    // BSP-only rows usually have no str/def/spd/dex at all.
    render(<BattleStatsCell member={{ bsp_total: 9_000_000, spy_source: 'bsp', bsp_fetched_at: new Date().toISOString() }} />)
    open()
    const panel = screen.getByRole('tooltip')
    expect(panel.textContent).toContain('Total')
    expect(panel.textContent).not.toContain('STR')
  })
})
