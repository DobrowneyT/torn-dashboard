// ⚠️ The server and the page compute the War Overview summary SEPARATELY, and
// this is the test that stops them drifting.
//
// The duplication is forced: the page recomputes on every drag of the range
// slider (a round trip per drag would be unusable) and the Discord bot cannot
// run browser JS. So the numbers exist twice — `frontend/src/utils/
// warOverviewSummary.js` and `server/src/warOverview/summary.ts`.
//
// What makes that survivable is running both over the same inputs and failing
// when they disagree. Without it, a Discord embed quietly contradicts the page
// it claims to mirror, and nobody finds out until a payout argument.
//
// This repo has watched one idea drift across two implementations three times
// in two days: LOSS_RESULTS in two files, classifyEventType local to the view,
// WIN_RESULTS disagreeing about `Special`.
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS from the frontend workspace, no type declarations
import * as web from '../../frontend/src/utils/warOverviewSummary.js'
import * as srv from '../src/warOverview/summary.js'
// @ts-expect-error — plain JS from the frontend workspace, no type declarations
import * as webPayout from '../../frontend/src/utils/warPayoutCalculations.js'

const US = 10739
const OPP = 20747
const OTHER = 99999

const RESULTS = [
  'Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted', 'Special',
  'Assist', 'Lost', 'Timeout', 'Interrupted', 'Stalemate', 'Escape',
  'SomethingTornAddedLater', '',
]

/** A deterministic spread of rows that touches every branch in both files. */
function fixture() {
  const attacks: any[] = []
  let id = 1
  for (const result of RESULTS) {
    for (const [af, df] of [[US, OPP], [US, OTHER], [US, null], [OPP, US], [OTHER, US], [null, US]]) {
      attacks.push({
        started: 100 + (id % 7),
        attacker_faction_id: af, defender_faction_id: df,
        attacker_id: (id % 3) + 1, defender_id: (id % 4) + 1,
        result,
      })
      id += 1
    }
  }
  const revives = [
    { timestamp: 101, target_faction_id: US, target_id: 1, reviver_faction_id: OTHER, result: 'success' },
    { timestamp: 102, target_faction_id: US, target_id: 2, reviver_faction_id: OPP, result: 'failure' },
    { timestamp: 103, target_faction_id: US, target_id: 1, reviver_faction_id: null, result: null },
    { timestamp: 999, target_faction_id: US, target_id: 1, reviver_faction_id: OTHER, result: 'success' },
    { timestamp: 101, target_faction_id: OTHER, target_id: 9, reviver_faction_id: US, result: 'success' },
  ]
  return { attacks, revives }
}

const CASES: Array<[string, any]> = [
  ['faction, all factions', { mode: 'faction', selectedFactionIds: null }],
  ['faction, opponent only', { mode: 'faction', selectedFactionIds: new Set([OPP]) }],
  ['faction, opponent + no-faction', { mode: 'faction', selectedFactionIds: new Set([OPP, 0]) }],
  ['faction, nothing selected', { mode: 'faction', selectedFactionIds: new Set() }],
  ['member 1, all', { mode: 'member', memberId: 1, selectedFactionIds: null }],
  ['member 2, opponent only', { mode: 'member', memberId: 2, selectedFactionIds: new Set([OPP]) }],
]

describe('the server summary agrees with the page', () => {
  const { attacks, revives } = fixture()

  it.each(CASES)('%s', (_label, over) => {
    const args = { attacks, revives, fromTs: 0, toTs: 500, ourFactionId: US, ...over }
    expect(srv.summariseWindow(args)).toEqual(web.summariseWindow(args))
  })

  it('agrees on a narrowed time window too', () => {
    const args = { attacks, revives, fromTs: 101, toTs: 103, ourFactionId: US, selectedFactionIds: null }
    expect(srv.summariseWindow(args)).toEqual(web.summariseWindow(args))
  })

  it('⚠️ agrees on EVERY result string, one at a time', () => {
    // The per-case totals above could coincidentally match while a single
    // result was classified differently. This pins each one.
    for (const result of RESULTS) {
      expect(srv.classifyEventType(result)).toBe(web.classifyEventType(result))
    }
  })

  it('⚠️ agrees on the no-faction key and on revive outcomes', () => {
    for (const v of [null, undefined, '', 0, '0', '20747', 20747]) {
      expect(srv.factionKey(v)).toBe(web.factionKey(v))
    }
    for (const result of ['success', 'failure', 'FAILURE', null, undefined, 'weird']) {
      expect(srv.reviveOutcome({ result } as any)).toBe(web.reviveOutcome({ result }))
    }
  })

  it('the fixture actually exercises all three columns in both directions', () => {
    // ⚠️ A parity test over empty buckets passes trivially. This asserts the
    // inputs are rich enough for the comparison to mean something.
    const r = srv.summariseWindow({ attacks, revives, fromTs: 0, toTs: 500, ourFactionId: US })
    for (const b of [r.outgoing, r.incoming]) {
      expect(b.attack).toBeGreaterThan(0)
      expect(b.assist).toBeGreaterThan(0)
      expect(b.loss).toBeGreaterThan(0)
      expect(b.total).toBeGreaterThan(b.attack + b.assist + b.loss - 1)
    }
    expect(r.revives.success).toBeGreaterThan(0)
    expect(r.revives.failure).toBeGreaterThan(0)
  })
})

/**
 * ⚠️ The sets themselves, not just the numbers they produce.
 *
 * The summary fixture above would catch a disagreement about a result it
 * happens to contain. These assertions catch one about a result NOBODY thought
 * to put in the fixture — which is how `Special` drifted the first time. #530
 * made this matter more: the dibs summary now reuses the server's sets, so a
 * silent divergence would reach a leaderboard with members' names on it.
 */
describe('the result vocabularies are the same on both sides', () => {
  const sorted = (s: Iterable<string>) => [...s].sort()

  it('WIN_RESULTS match', () => {
    expect(sorted(srv.WIN_RESULTS)).toEqual(sorted(webPayout.WIN_RESULTS))
  })

  it('LOSS_RESULTS match', () => {
    expect(sorted(srv.LOSS_RESULTS)).toEqual(sorted(webPayout.LOSS_RESULTS))
  })

  it('ASSIST_RESULT matches', () => {
    expect(srv.ASSIST_RESULT).toBe(webPayout.ASSIST_RESULT)
  })

  it("⚠️ and `Special` is still OUT of the scoring set on both sides", () => {
    // Every payout path tests WIN_RESULTS directly; adding Special to it would
    // silently change what people are paid.
    expect(srv.WIN_RESULTS.has('Special')).toBe(false)
    expect(webPayout.WIN_RESULTS.has('Special')).toBe(false)
    expect(srv.TIMELINE_WIN_RESULTS.has('Special')).toBe(true)
  })
})
