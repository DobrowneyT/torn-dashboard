// The Discord bot's War Overview endpoint (#811).
//
// ⚠️ The numbers themselves are pinned by war-overview-parity.test.ts, which
// holds the server's summary level with the page's. What is tested HERE is
// everything around them: the token, the window, the filters, and the shapes
// the bot depends on.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { warOverviewScope } from '../../db/warOverviewTokenLib.mjs'

const TOKEN = 'w'.repeat(64)
const US = Number(TEST_FACTION.tornFactionId)
const OPP = 20747
const OTHER = 99999
const WAR = 4242
const START = 1_790_000_000
const END = START + 7200

let stack: TestStack
const get = (qs = '', token: string | null = TOKEN) =>
  fetch(`${stack.baseUrl}/api/internal/war-overview${qs}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  })

const atk = (over: Record<string, unknown>) => ({
  started: START + 60, attacker_faction_id: US, defender_faction_id: OPP,
  attacker_id: 1001, attacker_name: 'Ours', defender_id: 2001, defender_name: 'Theirs',
  result: 'Attacked', ...over,
})

beforeAll(async () => {
  stack = await startTestStack(undefined, {}, { warOverviewToken: TOKEN })
  await stack.db.query(
    `INSERT INTO ranked_wars (id, start_at, end_at, opponent_id, opponent_name, our_score, opponent_score, is_termed)
     VALUES ($1, $2, $3, $4, 'Damage Inc', 100, 90, false)`,
    [WAR, START, END, OPP])

  const rows = [
    atk({ result: 'Attacked' }),
    atk({ result: 'Assist', is_ranked_war: false }),
    atk({ result: 'Lost' }),
    atk({ defender_faction_id: OTHER, result: 'Attacked' }),      // a third party
    atk({ defender_faction_id: null, result: 'Attacked' }),       // faction-less
    atk({ attacker_faction_id: OPP, defender_faction_id: US, attacker_id: 2001,
          defender_id: 1001, result: 'Hospitalized' }),           // incoming
    atk({ started: END + 9999, result: 'Attacked' }),             // outside the window
  ]
  let i = 0
  for (const a of rows) {
    i += 1
    await stack.db.query(
      `INSERT INTO faction_attacks
         (attack_id, started, result, attacker_id, attacker_name, attacker_faction_id,
          defender_id, defender_name, defender_faction_id, is_incoming, is_ranked_war)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [90000 + i, a.started, a.result, a.attacker_id, a.attacker_name, a.attacker_faction_id,
       a.defender_id, a.defender_name, a.defender_faction_id,
       Number(a.defender_faction_id) === US, true])
  }
  for (const [id, ts, result, target] of [
    [1, START + 30, 'success', 1001], [2, START + 40, 'failure', 1001], [3, END + 5000, 'success', 1001],
  ] as any[]) {
    await stack.db.query(
      `INSERT INTO faction_revives
         (revive_id, timestamp, result, reviver_id, reviver_faction_id, target_id, target_faction_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, ts, result, 7777, OTHER, target, US])
  }
}, 60000)

afterAll(async () => { await stack?.close() })

describe('authentication', () => {
  it('⚠️ answers 401 identically for a missing and a wrong token', async () => {
    // Distinguishing them tells a prober which half they have already solved.
    const none = await get('', null)
    const wrong = await get('', 'x'.repeat(64))
    expect(none.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(await none.json()).toEqual(await wrong.json())
  })

  it('⚠️ answers 401, not 500, for a SHORT token', async () => {
    // timingSafeEqual throws on a length mismatch, and 500-vs-401 is an oracle.
    expect((await get('', 'short')).status).toBe(401)
  })

  it('accepts the right one', async () => {
    expect((await get()).status).toBe(200)
  })

  it('the scope is its own, not chain-watch\'s', () => {
    // ⚠️ Reusing chain-watch:<slug> would mean a leak of the board credential
    // also surrenders a war's full attack and revive history (#609).
    expect(warOverviewScope('forge')).toBe('war-overview:forge')
    expect(warOverviewScope('forge')).not.toContain('chain-watch')
  })
})

describe('without a war id', () => {
  it('offers the wars, so the bot can build a picker', async () => {
    const body = await (await get()).json()
    expect(body.wars.map((w: any) => w.id)).toContain(WAR)
    expect(body.our_faction_id).toBe(US)
    expect(body.summary).toBeUndefined()
  })
})

describe('a war', () => {
  it('counts only what falls inside the war window', async () => {
    // ⚠️ Two rows sit outside it — one attack and one revive. A summary that
    // swept the whole table would be wrong by exactly those.
    const body = await (await get(`?war=${WAR}`)).json()
    expect(body.summary.outgoing.total).toBe(5)   // 3 vs opp + 1 third party + 1 faction-less
    expect(body.summary.incoming.total).toBe(1)
    expect(body.summary.revives).toEqual({ success: 1, failure: 1, total: 2 })
  })

  it('breaks the attacks out by type', async () => {
    const body = await (await get(`?war=${WAR}`)).json()
    expect(body.summary.outgoing).toMatchObject({ attack: 3, assist: 1, loss: 1 })
  })

  it('⚠️ warring_only drops third parties AND the faction-less', async () => {
    // (no faction) is the filterable id 0; leaving it in is most of the noise
    // the flag exists to remove.
    const body = await (await get(`?war=${WAR}&warring_only=1`)).json()
    expect(body.warring_only).toBe(true)
    expect(body.summary.outgoing.total).toBe(3)
  })

  it('⚠️ never faction-filters revives, even with warring_only', async () => {
    // The reviver here is a third faction. Being revived by a stranger is not
    // something you choose.
    const body = await (await get(`?war=${WAR}&warring_only=1`)).json()
    expect(body.summary.revives.total).toBe(2)
  })

  it('scopes to one member in member mode', async () => {
    const body = await (await get(`?war=${WAR}&mode=member&member=1001`)).json()
    expect(body.mode).toBe('member')
    expect(body.member_name).toBe('Ours')
    expect(body.summary.incoming.total).toBe(1)
  })

  it('lists our participants for the bot\'s autocomplete', async () => {
    const body = await (await get(`?war=${WAR}`)).json()
    expect(body.members.map((m: any) => m.id)).toContain(1001)
    // ⚠️ Not the opponent's players — the command picks one of OURS.
    expect(body.members.map((m: any) => m.id)).not.toContain(2001)
  })

  it('⚠️ excludes revivers from the faction list', async () => {
    // Matches the page: revivers are not in the faction filter, because the
    // filter answers "who am I fighting".
    const body = await (await get(`?war=${WAR}`)).json()
    expect(body.factions.map((f: any) => f.id)).not.toContain(OTHER === 99999 ? 7777 : -1)
    expect(body.factions.some((f: any) => f.is_no_faction)).toBe(true)
  })

  it('⚠️ sends every time as epoch MILLISECONDS', async () => {
    // Postgres timestamptz crosses as "...-05", which new Date() parses to NaN
    // and Python's fromisoformat rejects. A number survives both.
    const body = await (await get(`?war=${WAR}`)).json()
    expect(typeof body.window.from_ms).toBe('number')
    expect(body.window.from_ms).toBe(START * 1000)
    expect(typeof body.server_now).toBe('number')
    for (const w of body.wars) {
      expect(w.updated_ms === null || typeof w.updated_ms === 'number').toBe(true)
    }
  })

  it('reports a war it does not have rather than pretending', async () => {
    const body = await (await get('?war=999999')).json()
    expect(body.error).toBe('no such war')
  })
})
