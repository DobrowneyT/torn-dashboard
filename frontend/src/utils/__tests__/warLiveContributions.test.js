// The live War Contributions leaderboard (#793 follow-up, MonChoon 2026-09-27).
//
// Two things this table has to be honest about while a war is running:
//   • a member's score appears TWICE — raw, then bonus-normalised — because the
//     first is what Torn's own war report shows them and the second is what
//     their payout share is computed from, and people were reading one as the
//     other;
//   • assists and losses are war effort that scored nothing, and were
//     previously filtered out before they ever reached the leaderboard.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../factionIdentity', () => ({ getFactionId: () => 555 }))
vi.mock('../apiClient', () => ({ apiGet: vi.fn() }))

import { apiGet } from '../apiClient'
import { loadLiveContributionsFromAttacks } from '../warDataLoader.js'
import { WIN_RESULTS, LOSS_RESULTS, ASSIST_RESULT } from '../warPayoutCalculations.js'

const war = { start_at: 1000, end_at: 2000 }

/** Our faction, outgoing, in the war — the caller only varies result/respect/chain. */
const hit = (over) => ({
  attacker_id: 1, attacker_name: 'Fighter', attacker_faction_id: 555,
  is_ranked_war: true, is_incoming: false, respect_gain: 0, chain: 1, ...over,
})

function serve(attacks, roster = []) {
  apiGet.mockImplementation((path) => {
    if (path.startsWith('/api/members/roster')) return Promise.resolve({ roster })
    if (path.startsWith('/api/attacks')) return Promise.resolve({ attacks })
    return Promise.resolve({})
  })
}

beforeEach(() => { apiGet.mockReset() })

describe('score: raw and normalised, side by side', () => {
  it('reports the uncapped total AND the bonus-capped one', async () => {
    // A 100-chain bonus hit pays big respect; payout caps it at 10. Both
    // numbers are real and they must not be conflated.
    serve([
      hit({ result: 'Attacked', respect_gain: 12.5, chain: 3 }),
      hit({ result: 'Attacked', respect_gain: 94.2, chain: 100 }),
    ])
    const [row] = await loadLiveContributionsFromAttacks(war)
    expect(row.score_raw).toBeCloseTo(106.7, 5)   // what Torn reports
    expect(row.score).toBeCloseTo(22.5, 5)        // 12.5 + capped 10
  })

  it('leaves the two equal when nobody landed a bonus hit', async () => {
    // ⚠️ The common case, and the one that would hide a swapped pair of
    // fields — so the bonus case above is what actually pins the order.
    serve([hit({ result: 'Attacked', respect_gain: 7.25, chain: 4 })])
    const [row] = await loadLiveContributionsFromAttacks(war)
    expect(row.score_raw).toBeCloseTo(7.25, 5)
    expect(row.score).toBeCloseTo(7.25, 5)
  })

  it('never caps a non-bonus hit, however large', async () => {
    // Only the milestone chain numbers are capped. A big ordinary hit is a big
    // ordinary hit in both columns.
    serve([hit({ result: 'Attacked', respect_gain: 88, chain: 99 })])
    const [row] = await loadLiveContributionsFromAttacks(war)
    expect(row.score).toBeCloseTo(88, 5)
  })
})

describe('assists and losses', () => {
  it('counts them without letting them touch the score', async () => {
    serve([
      hit({ result: 'Attacked', respect_gain: 10 }),
      hit({ result: ASSIST_RESULT }),
      hit({ result: ASSIST_RESULT }),
      hit({ result: 'Lost' }),
    ])
    const [row] = await loadLiveContributionsFromAttacks(war)
    expect(row.attacks).toBe(1)
    expect(row.assists).toBe(2)
    expect(row.losses).toBe(1)
    expect(row.score).toBeCloseTo(10, 5)
    expect(row.score_raw).toBeCloseTo(10, 5)
  })

  it('⚠️ shows a member who only assisted, who used to be invisible', async () => {
    // The result filter ran BEFORE aggregation, so forty assists and no wins
    // read as having done nothing at all.
    serve([hit({ attacker_id: 9, attacker_name: 'Helper', result: ASSIST_RESULT })])
    const rows = await loadLiveContributionsFromAttacks(war)
    const helper = rows.find(r => r.member_id === 9)
    expect(helper).toBeDefined()
    expect(helper.assists).toBe(1)
    expect(helper.attacks).toBe(0)
  })

  it('⚠️ counts stalemates and escapes as losses, matching war pay', async () => {
    // MonChoon's first instinct was Lost + Timeout + Interrupted only. The
    // established model — applyAttackToBucket and the war timeline — is these
    // five, and a third meaning of "loss" is worse than any one of them.
    serve([...LOSS_RESULTS].map(result => hit({ result })))
    const [row] = await loadLiveContributionsFromAttacks(war)
    expect(row.losses).toBe(LOSS_RESULTS.size)
    expect(LOSS_RESULTS.has('Stalemate')).toBe(true)
    expect(LOSS_RESULTS.has('Escape')).toBe(true)
  })

  it('every win type lands in attacks, not in losses', async () => {
    serve([...WIN_RESULTS].map(result => hit({ result, respect_gain: 1 })))
    const [row] = await loadLiveContributionsFromAttacks(war)
    expect(row.attacks).toBe(WIN_RESULTS.size)
    expect(row.losses).toBe(0)
    expect(row.assists).toBe(0)
  })

  it('⚠️ files an unknown result in NO column rather than guessing', async () => {
    // A result type Torn adds later must not silently inflate "losses" — a
    // wrong column reads as fact, an absent one reads as a gap.
    serve([hit({ result: 'SomethingNew' }), hit({ result: 'Attacked', respect_gain: 3 })])
    const [row] = await loadLiveContributionsFromAttacks(war)
    expect(row.attacks).toBe(1)
    expect(row.assists).toBe(0)
    expect(row.losses).toBe(0)
  })
})

describe('what still must not be counted', () => {
  it('ignores the opponent, incoming hits and non-war attacks', async () => {
    serve([
      hit({ attacker_faction_id: 10739, result: ASSIST_RESULT }),   // not us
      hit({ is_incoming: true, result: ASSIST_RESULT }),            // taken, not made
      hit({ is_ranked_war: false, result: ASSIST_RESULT }),         // outside the war
    ])
    const rows = await loadLiveContributionsFromAttacks(war)
    expect(rows.filter(r => (r.assists || 0) > 0)).toEqual([])
  })

  it('seeds roster members at zero in every column', async () => {
    // Somebody looking themselves up has to find their own row, even at nil.
    serve([], [{ member_id: 42, member_name: 'Idle', is_current: true }])
    const [row] = await loadLiveContributionsFromAttacks(war)
    expect(row).toMatchObject({ member_id: 42, attacks: 0, assists: 0, losses: 0, score: 0, score_raw: 0 })
  })
})
