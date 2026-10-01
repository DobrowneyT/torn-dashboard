// The tables that had NO sorting at all (#839, epic #803).
//
// ⚠️ Every config here is new, so there is no "it used to do X" to lean on.
// These pin the decisions instead — which value a rendered cell sorts on, and
// where blanks go.
import { describe, expect, it } from 'vitest'
import { PAYOUT_HISTORY_COLUMNS } from '../../components/WarPayoutHistory.jsx'
import { ROLE_TABLE_COLUMNS } from '../FactionSettingsView.jsx'
import { STANDINGS_COLUMNS } from '../../components/CompetitionsSection.jsx'
import { CHAIN_PAYOUT_COLUMNS } from '../../components/chainWatch/PayoutPanel.jsx'
import { DASH_CRIME_COLUMNS, DASH_WAR_COLUMNS } from '../DashboardView.jsx'
import { sortRows } from '../../utils/tableSort.js'

const configs = {
  PAYOUT_HISTORY_COLUMNS, ROLE_TABLE_COLUMNS, STANDINGS_COLUMNS,
  CHAIN_PAYOUT_COLUMNS, DASH_CRIME_COLUMNS, DASH_WAR_COLUMNS,
}

describe('every new config', () => {
  it('declares a kind and accessor per column, with unique keys', () => {
    for (const [name, cols] of Object.entries(configs)) {
      for (const c of cols) {
        expect(c.kind, `${name}.${c.key}`).toBeTruthy()
        expect(typeof c.accessor, `${name}.${c.key}`).toBe('function')
      }
      const keys = cols.map(c => c.key)
      expect(new Set(keys).size, name).toBe(keys.length)
    }
  })
})

describe('faction settings', () => {
  it('sorts Torn ID numerically', () => {
    // ⚠️ Real forge ids. It is `text` in role_assignments and `bigint` in
    // members — a lexical sort puts 1712182 before 873341.
    const rows = [{ torn_user_id: 1712182 }, { torn_user_id: 873341 }, { torn_user_id: 2214797 }]
    expect(sortRows(rows, ROLE_TABLE_COLUMNS, 'torn_user_id', 'asc').map(r => r.torn_user_id))
      .toEqual([873341, 1712182, 2214797])
  })

  it('sorts Roles by COUNT, not by the first role alphabetically', () => {
    // ⚠️ "Who has the most access" is the question this table answers.
    const rows = [
      { member_name: 'one', grants: [{ role: 'warlead' }] },
      { member_name: 'two', grants: [{ role: 'leadership' }, { role: 'warlead' }] },
    ]
    expect(sortRows(rows, ROLE_TABLE_COLUMNS, 'roles', 'desc')[0].member_name).toBe('two')
  })
})

describe('competition standings', () => {
  it('keeps tied members in a stable order', () => {
    // ⚠️ Ties are the NORMAL case here — live forge has two members on 15.
    const rows = [
      { rank: 2, member_name: 'Helios-', value: 15 },
      { rank: 3, member_name: 'Jayturn', value: 15 },
      { rank: 1, member_name: 'YuRig', value: 16 },
    ]
    const once = sortRows(rows, STANDINGS_COLUMNS, 'value', 'desc', { tieBreak: 'member' })
    const twice = sortRows(rows, STANDINGS_COLUMNS, 'value', 'desc', { tieBreak: 'member' })
    expect(once.map(r => r.member_name)).toEqual(twice.map(r => r.member_name))
    expect(once[0].member_name).toBe('YuRig')
  })

  it('sinks members with no prize', () => {
    // ⚠️ Sorting by prize should surface who WON something, not bury them
    // under everyone who did not. Most rows are empty until a board resolves.
    const rows = [{ member_name: 'none', prize: null }, { member_name: 'won', prize: 500 }]
    expect(sortRows(rows, STANDINGS_COLUMNS, 'prize', 'desc')[0].member_name).toBe('won')
    expect(sortRows(rows, STANDINGS_COLUMNS, 'prize', 'asc')[0].member_name).toBe('won')
  })
})

describe('chain watch payouts', () => {
  it('sorts Ticket range on firstTicket, not the rendered span', () => {
    // ⚠️ The cell renders "firstTicket–lastTicket". A lexical sort on that puts
    // "10–19" before "9".
    //
    // ⚠️ This test USED TO SAY `{ first: 9 }` — the same wrong field name the
    // accessor had — so it passed against a column that read nothing. A
    // hand-written fixture carries the author's typo with it, which is why
    // `sortAccessorsReadRealFields.test.js` builds its rows from `payoutRows`
    // instead.
    const c = CHAIN_PAYOUT_COLUMNS.find(c => c.key === 'ticketRange')
    expect(c.accessor({ firstTicket: 9 })).toBe(9)
    const rows = [{ member_id: 1, firstTicket: 10 }, { member_id: 2, firstTicket: 9 }]
    expect(sortRows(rows, CHAIN_PAYOUT_COLUMNS, 'ticketRange', 'asc')[0].firstTicket).toBe(9)
  })

  it('carries a memberId column for the documented tie-break', () => {
    // ⚠️ `chainPayout.ORDER` is "slots descending, then member id ascending",
    // and states it has to be stable. The default reproduces that rather than
    // inventing a new order.
    expect(CHAIN_PAYOUT_COLUMNS.some(c => c.key === 'memberId')).toBe(true)
  })
})

describe('the dashboard strips', () => {
  it('sorts the war score on the member own contribution', () => {
    // ⚠️ The cell renders `myScore`, not the faction scoreline. Sorting a
    // composite like "42015 - 54904" as displayed is a lexical sort on two
    // numbers glued together.
    const c = DASH_WAR_COLUMNS.find(c => c.key === 'score')
    expect(c.accessor({ myScore: '1500' })).toBe(1500)
    expect(c.accessor({})).toBe(0)
  })

  it('falls back to the opponent id when a name is missing', () => {
    const c = DASH_WAR_COLUMNS.find(c => c.key === 'opponent')
    expect(c.accessor({ opponent_id: 20747 })).toBe('20747')
  })
})

describe('war payout history', () => {
  it('sorts total payout numerically above 2^32', () => {
    const rows = [{ warId: 1, totalPayout: 4294967296 }, { warId: 2, totalPayout: 4892000000 }]
    expect(sortRows(rows, PAYOUT_HISTORY_COLUMNS, 'totalPayout', 'desc')[0].warId).toBe(2)
  })

  it('sinks a war with no opponent recorded', () => {
    const rows = [{ warId: 1, opponent: null }, { warId: 2, opponent: 'Damage Inc' }]
    expect(sortRows(rows, PAYOUT_HISTORY_COLUMNS, 'opponent', 'desc')[0].warId).toBe(2)
  })
})
