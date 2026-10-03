import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * #871 — a settled payout week is a static sheet, not a recalculation.
 *
 * MonChoon, 2026-10-03: *"once its paid and fixed (for OC and RW payments)
 * they should be saved statically as sheets, since thats what was sent to
 * members (including item prices and things that fluctuate with the market)."*
 *
 * ⚠️ Source-reading rather than rendering. `PayoutManagement` needs auth, a
 * faction config, three API round trips and a crimes fetch to mount, and none
 * of that would make these assertions stronger — what matters is that specific
 * code paths are UNREACHABLE for a saved week, which is a property of the
 * source, not of one rendered scenario. The behavioural half is covered by
 * `recalculateWithItemPrices` below, which is pure.
 */

const SRC = new URL('../../', import.meta.url).pathname
const RAW = readFileSync(join(SRC, 'components/PayoutManagement.jsx'), 'utf8')

/**
 * ⚠️ Comments stripped before any "this call is absent" assertion. The warning
 * left at the old call site NAMES `enrichItemBreakdown` while explaining why it
 * must not be there, so a raw search finds the prose and reports the bug it is
 * warning about. Code only.
 */
const PM_CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const PM = RAW

describe('a saved week never re-prices itself', () => {
  it('⚠️ does not enrich a restored breakdown with live prices', () => {
    // This was the bug: the restore path called `enrichItemBreakdown` under a
    // comment claiming it was "for display only … names". The enricher returns
    // CURRENT market unit values and the result replaced the breakdown
    // wholesale, so every reopened week was silently re-priced.
    const restore = PM_CODE.slice(PM_CODE.indexOf('const storedBreakdown'))
    const upToResults = restore.slice(0, restore.indexOf('setHasCalculated(true)'))
    expect(upToResults).not.toMatch(/enrichItemBreakdown\s*\(/)
  })

  it('prefers the stored breakdown over rebuilding from live crime data', () => {
    expect(PM).toMatch(/const storedBreakdown = weekData\.item_breakdown \?\? null/)
    expect(PM).toMatch(/let itemBreakdown = storedBreakdown \?\?/)
    // The rebuild is reachable only when nothing was recorded.
    expect(PM).toMatch(/if \(crimeIds\.length > 0 && !pricesRecorded\)/)
  })

  it('⚠️ a legacy week does NOT fall back to live prices', () => {
    // Weeks saved before 0067 have no itemised prices. The stored per-member
    // payouts are still correct, so the week opens — it just cannot claim to
    // know what the items were worth, and must not invent it.
    expect(PM).toMatch(/pricesRecorded/)
    const restore = PM_CODE.slice(PM_CODE.indexOf('const storedBreakdown'))
    expect(restore.slice(0, restore.indexOf('setHasCalculated(true)')))
      .not.toMatch(/enrichItemBreakdown/)
  })
})

describe('a saved week never recalculates', () => {
  it('the main calculation effect bails out on a settled sheet', () => {
    const effect = PM.slice(PM.indexOf('if (savedWeekRef.current) return'))
    expect(effect.slice(0, 400)).toMatch(/calculatePayouts\(/)
  })

  it('⚠️ the guard is a ref, not reactive state', () => {
    // The guard is read inside the effect that PRODUCES payoutResults, so
    // reading it off those results would make the effect depend on its own
    // output.
    expect(PM).toMatch(/const savedWeekRef = useRef\(false\)/)
    expect(PM).toMatch(/if \(savedWeekRef\.current\) return/)
  })

  it('⚠️ is marked saved BEFORE the results are set', () => {
    // Otherwise an effect reacting to the new results could fire a
    // recalculation in the gap between the two statements.
    const i = PM.indexOf('savedWeekRef.current = true')
    const j = PM.indexOf('setPayoutResults(results)', i)
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
  })

  it('clears the flag everywhere a fresh, unsettled sheet begins', () => {
    // Every `setHasCalculated(false)` is a return to live working state, and
    // each must re-enable recalculation or the tool stops recomputing at all.
    const falses = PM.match(/setHasCalculated\(false\)/g) ?? []
    const clears = PM.match(/savedWeekRef\.current = false/g) ?? []
    expect(falses.length).toBeGreaterThan(0)
    expect(clears.length).toBe(falses.length)
  })
})

describe('what the sheet shows is what gets saved', () => {
  it('persists the breakdown and crime values as displayed', () => {
    const save = PM.slice(PM.indexOf('const weekData = {'))
    const body = save.slice(0, save.indexOf('}'))
    expect(body).toMatch(/item_breakdown: payoutResults\.itemBreakdown/)
    expect(body).toMatch(/crime_values: payoutResults\.crimeValues/)
  })

  it('⚠️ writes the sit-out thresholds instead of letting the default stand', () => {
    // These columns existed and were allowlisted from the start but were never
    // sent, so every stored row silently carried the table DEFAULT whether or
    // not that is what the week was computed under.
    const save = PM.slice(PM.indexOf('const weekData = {'))
    const body = save.slice(0, save.indexOf('}'))
    expect(body).toMatch(/min_time_for_full_tickets: MIN_TIME_FOR_FULL_TICKETS/)
    expect(body).toMatch(/min_time_for_any_payout: MIN_TIME_FOR_ANY_PAYOUT/)
  })
})

describe('migration 0067', () => {
  const sql = readFileSync(join(SRC, '../../db/migrations/0067-oc-payout-static-sheet.sql'), 'utf8')

  it('adds both columns idempotently', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS item_breakdown jsonb/)
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS crime_values\s+jsonb/)
  })

  it('⚠️ does not backfill — a past market price cannot be recovered', () => {
    expect(sql).not.toMatch(/\bUPDATE\b/i)
    expect(sql).toMatch(/NULLABLE and NOT backfilled/)
  })

  it('is reflected in template.sql for new tenants', () => {
    const tpl = readFileSync(join(SRC, '../../db/template.sql'), 'utf8')
    const tbl = tpl.slice(tpl.indexOf('CREATE TABLE public.oc_payout_weeks'))
    const body = tbl.slice(0, tbl.indexOf(');'))
    expect(body).toMatch(/item_breakdown jsonb/)
    expect(body).toMatch(/crime_values\s+jsonb/)
  })
})
