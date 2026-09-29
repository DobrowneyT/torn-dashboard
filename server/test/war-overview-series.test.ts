// The pre-binned series the Discord bot draws (#811 slice 4).
//
// ⚠️ **The chart must agree with the summary printed beside it.** They are
// computed by different functions over the same rows, so the tests that matter
// are the ones comparing their totals — a chart that quietly disagrees with the
// numbers under it is worse than no chart.
import { describe, expect, it } from 'vitest'
import { buildChart, pickBinSeconds, MAX_SERIES } from '../src/warOverview/series.js'
import { summariseWindow } from '../src/warOverview/summary.js'

const US = 10739
const OPP = 20747
const START = 1_790_000_000
const HOUR = 3600

const atk = (o: Record<string, unknown> = {}) => ({
  started: START + 60, attacker_faction_id: US, defender_faction_id: OPP,
  attacker_id: 1, defender_id: 2, result: 'Attacked', ...o,
})
const rev = (o: Record<string, unknown> = {}) => ({
  timestamp: START + 60, target_faction_id: US, target_id: 1,
  reviver_faction_id: 555, result: 'success', ...o,
})

const base = { fromTs: START, toTs: START + 4 * HOUR, ourFactionId: US }
const sum = (s: { values: number[] }[]) =>
  s.reduce((t, x) => t + x.values.reduce((a, b) => a + b, 0), 0)

describe('binning', () => {
  it('picks the same widths the page does', () => {
    // ⚠️ A war rendered with different bins in Discord and on the page looks
    // like different data.
    expect(pickBinSeconds(60)).toBe(5)
    expect(pickBinSeconds(30 * 60)).toBe(60)
    expect(pickBinSeconds(5 * HOUR)).toBe(300)
    expect(pickBinSeconds(24 * HOUR)).toBe(HOUR)
    expect(pickBinSeconds(10 * 86400)).toBe(6 * HOUR)
  })

  it('spreads events into the bin they belong to', () => {
    // ⚠️ The index is DERIVED from the chosen bin width, not assumed. A 4-hour
    // window gets 5-minute bins, not hourly ones — hardcoding "bin 2" made this
    // test fail against correct code.
    const attacks = [atk({ started: START + 10 }), atk({ started: START + 2 * HOUR + 10 })]
    const c = buildChart({ ...base, attacks, revives: [] })
    const values = c.panels[0].series[0].values
    const second = Math.floor((2 * HOUR + 10) / c.bin_seconds)
    expect(values[0]).toBe(1)
    expect(values[second]).toBe(1)
    expect(values.reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('never lets an edge event fall outside the array', () => {
    // ⚠️ An event exactly on `toTs` must land in the LAST bin, not at an index
    // past the end — which would either throw or silently vanish.
    const c = buildChart({ ...base, attacks: [atk({ started: base.toTs })], revives: [] })
    const values = c.panels[0].series[0].values
    expect(values[values.length - 1]).toBe(1)
    expect(sum(c.panels[0].series)).toBe(1)
  })
})

describe('the chart agrees with the summary', () => {
  const attacks = [
    atk({ result: 'Attacked' }), atk({ result: 'Assist' }), atk({ result: 'Lost' }),
    atk({ defender_faction_id: 999, result: 'Attacked' }),
    atk({ defender_faction_id: null, result: 'Attacked' }),
    atk({ attacker_faction_id: OPP, defender_faction_id: US, result: 'Hospitalized' }),
  ]
  const revives = [rev(), rev({ result: 'failure' })]

  it('totals match, panel for panel', () => {
    const args = { ...base, attacks, revives }
    const c = buildChart(args)
    const s = summariseWindow(args)
    expect(sum(c.panels[0].series)).toBe(s.outgoing.total)
    expect(sum(c.panels[1].series)).toBe(s.incoming.total)
    expect(sum(c.panels[2].series)).toBe(s.revives.total)
  })

  it('still match with warring_only applied', () => {
    const args = { ...base, attacks, revives, selectedFactionIds: new Set([US, OPP]) }
    const c = buildChart(args)
    const s = summariseWindow(args)
    expect(sum(c.panels[0].series)).toBe(s.outgoing.total)
    expect(sum(c.panels[1].series)).toBe(s.incoming.total)
    // ⚠️ Revives are NOT faction-filtered, so this must NOT drop.
    expect(sum(c.panels[2].series)).toBe(s.revives.total)
    expect(sum(c.panels[2].series)).toBe(2)
  })

  it('⚠️ an unrecognised result is absent from BOTH, not just one', () => {
    // The summary counts it in `total` but in no named column; the chart
    // plots only classified events. They agree because the chart is compared
    // against the sum of the named columns, not against total.
    const odd = [atk({ result: 'SomethingNew' })]
    const c = buildChart({ ...base, attacks: odd, revives: [] })
    expect(sum(c.panels[0].series)).toBe(0)
  })
})

describe('colours and series', () => {
  it('⚠️ gives a faction ONE colour across both attack panels', () => {
    // Two independently ranked maps would recolour the opponent between
    // panels, which reads as two different factions.
    const attacks = [
      atk({ defender_faction_id: OPP }),
      atk({ attacker_faction_id: OPP, defender_faction_id: US, result: 'Hospitalized' }),
    ]
    const c = buildChart({ ...base, attacks, revives: [] })
    const outOpp = c.panels[0].series.find((s) => s.label.includes(String(OPP)))
    const incOpp = c.panels[1].series.find((s) => s.label.includes(String(OPP)))
    expect(outOpp!.colour).toBe(incOpp!.colour)
  })

  it('⚠️ colours a faction that appears in only ONE panel', () => {
    // A mercenary that only ever hits us appears in `incoming` and nowhere
    // else. Ranking the colour map from the outgoing panel alone would leave
    // it uncoloured — dropped, or lumped into Other — even though it is one of
    // the most important things on the chart.
    //
    // Written after a mutation test: ranking on `out` only still passed,
    // because the opponent appears in both panels either way.
    const MERC = 31337
    const attacks = [
      atk({ defender_faction_id: OPP }),
      atk({ attacker_faction_id: MERC, defender_faction_id: US, result: 'Hospitalized' }),
    ]
    const c = buildChart({ ...base, attacks, revives: [] })
    const inc = c.panels[1].series
    expect(inc).toHaveLength(1)
    expect(inc[0].label).toContain(String(MERC))
    expect(inc[0].label).not.toContain('Other')
    // ⚠️ And it is a real palette colour, not the grey Other bucket uses.
    expect(inc[0].colour).not.toBe('#888888')
  })

  it('⚠️ rolls surplus factions into Other WITHOUT losing their events', () => {
    // Dropping them would make the bars shorter than the summary beside them.
    const attacks = Array.from({ length: MAX_SERIES + 5 }, (_, i) =>
      atk({ defender_faction_id: 1000 + i }))
    const c = buildChart({ ...base, attacks, revives: [] })
    expect(sum(c.panels[0].series)).toBe(attacks.length)
    expect(c.panels[0].series.some((s) => s.label.startsWith('Other ('))).toBe(true)
  })

  it('names the no-faction series rather than showing an id', () => {
    const c = buildChart({ ...base, attacks: [atk({ defender_faction_id: null })], revives: [] })
    expect(c.panels[0].series[0].label).toBe('(no faction)')
  })

  it('uses the opponent name when it has one', () => {
    const c = buildChart({ ...base, attacks: [atk()], revives: [],
                           factionNames: { [OPP]: 'Damage Inc' } })
    expect(c.panels[0].series[0].label).toBe(`Damage Inc [${OPP}]`)
  })

  it('splits revives into two coloured series', () => {
    const c = buildChart({ ...base, attacks: [], revives: [rev(), rev({ result: 'failure' })] })
    const labels = c.panels[2].series.map((s) => s.label)
    expect(labels).toEqual(['Revived', 'Failed revive'])
    expect(c.panels[2].series[0].colour).not.toBe(c.panels[2].series[1].colour)
  })

  it('omits a series that is empty rather than drawing a flat zero', () => {
    const c = buildChart({ ...base, attacks: [], revives: [rev()] })
    expect(c.panels[2].series.map((s) => s.label)).toEqual(['Revived'])
    expect(c.panels[0].series).toEqual([])
  })

  it('panels are outgoing, incoming, revives — the page\'s order', () => {
    const c = buildChart({ ...base, attacks: [], revives: [] })
    expect(c.panels.map((p) => p.key)).toEqual(['outgoing', 'incoming', 'revives'])
  })
})
