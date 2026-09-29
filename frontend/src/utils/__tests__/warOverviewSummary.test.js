// The War Overview's windowed summary (MonChoon, 2026-09-28).
import { describe, it, expect } from 'vitest'
import { summariseWindow, classifyEventType } from '../warOverviewSummary'

const US = 10739
const OPP = 20747
const OTHER = 99999

const atk = (o) => ({
  started: 100, attacker_faction_id: US, defender_faction_id: OPP,
  attacker_id: 1, defender_id: 2, result: 'Attacked', ...o,
})
const rev = (o) => ({ timestamp: 100, target_faction_id: US, target_id: 1, reviver_faction_id: OTHER, ...o })

const base = { fromTs: 0, toTs: 1000, ourFactionId: US }

describe('the summary describes the graph', () => {
  it('⚠️ drops attacks against a faction that is filtered out', () => {
    // The bug: the summary counted every attack in the window whatever was
    // ticked, so the numbers and the plot above them disagreed with nothing to
    // say which was right.
    const attacks = [atk({ defender_faction_id: OPP }), atk({ defender_faction_id: OTHER })]
    const all = summariseWindow({ ...base, attacks })
    expect(all.outgoing.total).toBe(2)

    const onlyOpp = summariseWindow({ ...base, attacks, selectedFactionIds: new Set([OPP]) })
    expect(onlyOpp.outgoing.total).toBe(1)
  })

  it('⚠️ filters an INCOMING attack by its attacker, not by us', () => {
    // Testing our own faction id would make the filter a no-op in one
    // direction — the numbers would move for outgoing and stand still for
    // incoming, which reads as a display bug rather than a filter.
    const attacks = [
      atk({ attacker_faction_id: OPP, defender_faction_id: US }),
      atk({ attacker_faction_id: OTHER, defender_faction_id: US }),
    ]
    const r = summariseWindow({ ...base, attacks, selectedFactionIds: new Set([OPP]) })
    expect(r.incoming.total).toBe(1)
  })

  it('treats a null selection as "all", not as "none"', () => {
    // ⚠️ The default before the user touches a checkbox. Reading it as an
    // empty set would show zeroes on first load.
    expect(summariseWindow({ ...base, attacks: [atk()] }).outgoing.total).toBe(1)
  })

  it('honours the time window', () => {
    const attacks = [atk({ started: 50 }), atk({ started: 5000 })]
    expect(summariseWindow({ ...base, attacks }).outgoing.total).toBe(1)
  })
})

describe('revives are never faction-filtered', () => {
  it('⚠️ counts a revive from a faction that is unticked', () => {
    // Being revived by a stranger is not something you choose, and the reviver
    // is almost never the faction you are warring. Filtering them out is what
    // emptied the revives panel on the faction view.
    const r = summariseWindow({
      ...base, revives: [rev({ reviver_faction_id: OTHER })],
      selectedFactionIds: new Set([OPP]),
    })
    expect(r.revives).toBe(1)
  })

  it('still scopes revives to US, and to the window', () => {
    const revives = [
      rev(),                                   // ours
      rev({ target_faction_id: OTHER }),       // somebody else's
      rev({ timestamp: 9999 }),                // outside the window
    ]
    expect(summariseWindow({ ...base, revives }).revives).toBe(1)
  })
})

describe('the faction summary splits the same way the member one does', () => {
  it('reports attack / assist / loss / total in both directions', () => {
    const attacks = [
      atk({ result: 'Attacked' }), atk({ result: 'Assist' }), atk({ result: 'Lost' }),
      atk({ attacker_faction_id: OPP, defender_faction_id: US, result: 'Hospitalized' }),
      atk({ attacker_faction_id: OPP, defender_faction_id: US, result: 'Stalemate' }),
    ]
    const r = summariseWindow({ ...base, attacks })
    expect(r.outgoing).toEqual({ attack: 1, assist: 1, loss: 1, total: 3 })
    expect(r.incoming).toEqual({ attack: 1, assist: 0, loss: 1, total: 2 })
  })

  it('⚠️ total counts an unrecognised result even when the columns cannot', () => {
    // The three named columns can sum to less than total, and that gap is the
    // honest shape — a result type Torn adds later shows as a gap rather than
    // being filed under "loss" by default.
    const r = summariseWindow({ ...base, attacks: [atk({ result: 'SomethingNew' })] })
    expect(r.outgoing.total).toBe(1)
    expect(r.outgoing.attack + r.outgoing.assist + r.outgoing.loss).toBe(0)
  })
})

describe('member mode', () => {
  it('scopes to one member in both directions', () => {
    const attacks = [
      atk({ attacker_id: 1 }), atk({ attacker_id: 7 }),
      // ⚠️ attacker_id must be somebody ELSE, or the default (1) makes this
      // row count as member 1 attacking as well as being attacked.
      atk({ attacker_id: 8, defender_id: 1, attacker_faction_id: OPP, defender_faction_id: US }),
    ]
    const r = summariseWindow({ ...base, attacks, mode: 'member', memberId: 1 })
    expect(r.outgoing.total).toBe(1)
    expect(r.incoming.total).toBe(1)
  })
})

describe('classifyEventType', () => {
  it('⚠️ counts Special as an attack, which the payout set deliberately does not', () => {
    expect(classifyEventType('Special')).toBe('attack')
  })
  it('maps the loss family and assists', () => {
    for (const r of ['Lost', 'Timeout', 'Interrupted', 'Stalemate', 'Escape']) {
      expect(classifyEventType(r)).toBe('loss')
    }
    expect(classifyEventType('Assist')).toBe('assist')
    expect(classifyEventType('Mugged')).toBe('attack')
  })
  it('returns null for nothing and for the unknown', () => {
    expect(classifyEventType('')).toBeNull()
    expect(classifyEventType('Brand New')).toBeNull()
  })
})
