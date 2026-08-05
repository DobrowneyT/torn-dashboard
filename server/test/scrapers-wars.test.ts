// Wars/attacks/revives scrapers (slice #70), on the scraper core against
// the Torn fixture. Reference specs: war_data_update.py,
// faction_attacks_update.py, fetch_revives_for_war.py (+ sync_to_supabase
// row shapes).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'

let stack: TestStack
// The app under test shares this secret (harness), so keys stored here are
// claimable by the sync trigger endpoints too.
const ENCRYPTION_KEY = TEST_KEY_ENCRYPTION_KEY
const US = Number(TEST_FACTION.tornFactionId)

function deps() {
  return {
    db: stack.db,
    pool: createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY }),
    client: createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 200, perMs: 1000 } }),
  }
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('1100', 'Scout', 3, true)
  `)
  const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
  await pool.store('1100', 'SCOUTKEY1100AAAA', { consentVersion: 'v2' })
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('wars sync job', () => {
  let reportHits = 0

  beforeAll(async () => {
    // War 500 already known (manually flagged termed) and completed this
    // run; 501 is ongoing; 502 completed but its report is permanently gone.
    await stack.db.query(`
      INSERT INTO ranked_wars (id, start_at, end_at, opponent_id, opponent_name, our_score, opponent_score, is_termed)
      VALUES (500, 1748000000, NULL, 9100, 'Old Foes', 100, 90, true)
    `)

    stack.torn.setHandler(`/v2/faction/${US}/rankedwars`, () => ({
      rankedwars: [
        {
          id: 500, start: 1748000000, end: 1748259200, target: 3000, winner: US,
          factions: [
            { id: US, name: 'Us', score: 3100 },
            { id: 9100, name: 'Old Foes', score: 2200 },
          ],
        },
        {
          id: 501, start: 1749000000, end: 0, target: 4000, winner: null,
          factions: [
            { id: US, name: 'Us', score: 40 },
            { id: 9101, name: 'Fresh Foes', score: 55 },
          ],
        },
        {
          id: 502, start: 1740000000, end: 1740259200, target: 2000, winner: 9102,
          factions: [
            { id: US, name: 'Us', score: 1000 },
            { id: 9102, name: 'Ancient Foes', score: 2000 },
          ],
        },
      ],
    }))
    stack.torn.setHandler('/v2/faction/500/rankedwarreport', () => {
      reportHits += 1
      return {
        rankedwarreport: {
          id: 500, forfeit: false,
          factions: [
            {
              id: US, name: 'Us', score: 3100,
              rewards: { items: [{ id: 1120, name: 'Armor Cache', quantity: 2 }] },
              rank: { before: 'Gold I', after: 'Platinum III' },
              members: [{ id: 1100, name: 'Scout', level: 40, attacks: 30, score: 410.25 }],
            },
            {
              id: 9100, name: 'Old Foes', score: 2200,
              rewards: { items: [] }, rank: { before: 'Gold II', after: 'Gold III' },
              members: [{ id: 9999, name: 'EnemyTop', level: 60, attacks: 44, score: 380 }],
            },
          ],
        },
      }
    })
    stack.torn.setHandler('/v2/faction/502/rankedwarreport', () => {
      reportHits += 1
      return { error: { code: 7, error: 'Incorrect ID-entity relation' } }
    })
  })

  it('pages wars, applies reports + contributions, and never clobbers is_termed', async () => {
    const { warsSyncJob } = await import('../src/scraper/jobs/warsSync.js')
    const result = await warsSyncJob(deps())

    const wars = await stack.db.query('SELECT * FROM ranked_wars ORDER BY id')
    expect(wars.rows.map((w: any) => w.id)).toEqual([500, 501, 502])

    const war500 = wars.rows[0]
    // Report applied: rewards/ranks/score; the manual termed flag survives.
    expect(war500).toMatchObject({
      end_at: 1748259200, our_score: 3100, opponent_score: 2200,
      opponent_id: 9100, opponent_name: 'Old Foes', winner_faction_id: US,
      rank_before: 'Gold I', rank_after: 'Platinum III',
      is_termed: true, report_fetched: true, forfeit: false,
    })
    expect(war500.rewards_items).toEqual([{ id: 1120, name: 'Armor Cache', quantity: 2 }])

    // Ongoing war: live scores land, no report attempted.
    expect(wars.rows[1]).toMatchObject({ id: 501, end_at: null, our_score: 40, opponent_score: 55 })

    // Permanently-unavailable report: flagged, never refetched.
    expect(wars.rows[2]).toMatchObject({ id: 502, report_unavailable: true, report_fetched: false })

    const contribs = await stack.db.query(
      'SELECT war_id, member_id, member_name, level, attacks, score, faction_id FROM war_member_contributions ORDER BY member_id'
    )
    expect(contribs.rows).toEqual([
      { war_id: 500, member_id: 1100, member_name: 'Scout', level: 40, attacks: 30, score: 410.25, faction_id: US },
      { war_id: 500, member_id: 9999, member_name: 'EnemyTop', level: 60, attacks: 44, score: 380, faction_id: 9100 },
    ])

    const hitsAfterFirst = reportHits
    await warsSyncJob(deps())
    // Second run: 500 has its report, 502 is flagged unavailable → no
    // report endpoints hit at all.
    expect(reportHits).toBe(hitsAfterFirst)

    expect(result.details).toMatchObject({ wars_seen: 3, reports_fetched: 1, reports_unavailable: 1 })
  })
})

describe('attacks sync job', () => {
  const fromParams: number[] = []
  const rawAttack = (id: number, started: number, extra: Record<string, unknown> = {}) => ({
    id, started, ended: started + 30,
    attacker: { id: 1100, name: 'Scout', faction: { id: US, name: 'Us' } },
    defender: { id: 9999, name: 'EnemyTop', faction: { id: 9100, name: 'Old Foes' } },
    result: 'Attacked', respect_gain: 7.5, chain: 12, is_ranked_war: true,
    modifiers: { fair_fight: 1.5, war: 2, chain: 1.1, warlord: 1 },
    ...extra,
  })

  it('pages forward from the newest stored attack and maps the Python row shape', async () => {
    stack.torn.setHandler('/v2/faction/attacks', (url) => {
      const from = Number(url.searchParams.get('from') ?? 0)
      fromParams.push(from)
      const all = [
        rawAttack(9001, 1748001000),
        rawAttack(9002, 1748002000, {
          // Incoming: the defender is us.
          attacker: { id: 8888, name: 'Aggressor', faction: { id: 9100, name: 'Old Foes' } },
          defender: { id: 1100, name: 'Scout', faction: { id: US, name: 'Us' } },
          result: 'Hospitalized', is_ranked_war: false,
        }),
        rawAttack(9003, 1748003000, { attacker: { id: 1100, name: 'Scout', faction: null } }),
      ]
      return { attacks: all.filter((a) => a.started >= from) }
    })

    const { attacksSyncJob } = await import('../src/scraper/jobs/attacksSync.js')
    const first = await attacksSyncJob(deps())
    expect(fromParams[0]).toBe(0)
    expect(first.rows).toBe(3)

    const rows = await stack.db.query('SELECT * FROM faction_attacks ORDER BY attack_id')
    expect(rows.rows[0]).toMatchObject({
      attack_id: 9001, started: 1748001000, attacker_id: 1100, attacker_name: 'Scout',
      attacker_faction_id: US, defender_id: 9999, defender_faction_id: 9100,
      result: 'Attacked', chain: 12, is_ranked_war: true, is_incoming: false,
      // Faction names stored inline on the row (like faction_revives).
      attacker_faction_name: 'Us', defender_faction_name: 'Old Foes',
    })
    expect(parseFloat(rows.rows[0].respect_gain)).toBe(7.5)
    expect(parseFloat(rows.rows[0].fair_fight)).toBe(1.5)
    expect(parseFloat(rows.rows[0].war_modifier)).toBe(2)
    // Defender faction == us → incoming.
    expect(rows.rows[1]).toMatchObject({ attack_id: 9002, is_incoming: true, is_ranked_war: false })
    // Factionless attacker survives normalization.
    expect(rows.rows[2]).toMatchObject({ attack_id: 9003, attacker_faction_id: null })

    // Faction names are captured inline from the attack payload into the
    // `factions` lookup (both sides), so the payout filter shows names without a
    // separate API lookup. A factionless side contributes nothing.
    const facs = await stack.db.query('SELECT id, name FROM factions WHERE id = ANY($1::int[]) ORDER BY id', [[US, 9100]])
    expect(facs.rows).toEqual([
      { id: 9100, name: 'Old Foes' },
      { id: US, name: 'Us' },
    ])

    // Second run resumes from the newest stored `started` (inclusive
    // overlap; existing rows are upserts, not duplicates).
    const second = await attacksSyncJob(deps())
    expect(fromParams[fromParams.length - 1]).toBe(1748003000)
    const count = await stack.db.query('SELECT count(*)::int AS n FROM faction_attacks')
    expect(count.rows[0].n).toBe(3)
  })
})

describe('revives sync job', () => {
  it('fetches a war window of incoming revives and flattens the nested payload', async () => {
    stack.torn.setHandler('/v2/faction/revives', (url) => ({
      revives: [
        {
          id: 7001, timestamp: 1748100000, result: 'success', success_chance: 92.5,
          reviver: { id: 4000, name: 'Medic', skill: 87.3, faction: { id: 9200, name: 'Revivers Inc' } },
          target: {
            id: 1100, name: 'Scout', faction: { id: US, name: 'Us' },
            hospital_reason: 'Hospitalized by EnemyTop', early_discharge: true,
            last_action: { status: 'Online', timestamp: 1748099000 }, online_status: 'Online',
          },
        },
      ],
    }))

    const { revivesSyncJob } = await import('../src/scraper/jobs/revivesSync.js')
    const result = await revivesSyncJob(deps(), 500)
    expect(result.rows).toBe(1)

    const rows = await stack.db.query('SELECT * FROM faction_revives WHERE rw_id = 500')
    expect(rows.rows[0]).toMatchObject({
      revive_id: 7001, rw_id: 500, timestamp: 1748100000,
      reviver_id: 4000, reviver_name: 'Medic', reviver_faction_id: 9200,
      reviver_faction_name: 'Revivers Inc',
      target_id: 1100, target_name: 'Scout', target_faction_id: US,
      hospital_reason: 'Hospitalized by EnemyTop', early_discharge: true,
      target_last_action: 1748099000, target_online_status: 'Online', result: 'success',
    })
    expect(parseFloat(rows.rows[0].reviver_skill)).toBe(87.3)
    expect(parseFloat(rows.rows[0].success_chance)).toBe(92.5)
  })

  it('404s on an unknown war id', async () => {
    const { revivesSyncJob } = await import('../src/scraper/jobs/revivesSync.js')
    await expect(revivesSyncJob(deps(), 999999)).rejects.toThrow(/not found/i)
  })
})

describe('on-demand sync triggers (HTTP seam)', () => {
  const tokens: Record<string, string> = {}

  async function loginAs(name: string, id: string, roles: string[]) {
    const key = `${name.toUpperCase().padEnd(13, 'K')}${id.slice(0, 3)}`
    stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
    for (const role of roles) {
      await stack.db.query('INSERT INTO role_assignments (torn_user_id, role) VALUES ($1, $2)', [id, role])
    }
    const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    })
    expect(res.status).toBe(200)
    tokens[name] = ((await res.json()) as any).token
  }

  async function post(path: string, as: string) {
    const res = await fetch(`${stack.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens[as]}` },
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  beforeAll(async () => {
    await loginAs('leader', '1200', ['leadership'])
    await loginAs('visitor', '1201', ['visitor'])
  })

  it('leadership triggers run the same job code and land in the run log; visitors cannot', async () => {
    const { status, body } = await post('/api/sync/attacks', 'leader')
    expect(status).toBe(200)
    expect(body.run.job_name).toBe('attacks-sync')
    expect(body.run.status).toBe('success')
    // Same incremental job: everything is already stored, so re-running
    // upserts the tail rows without duplicating.
    const count = await stack.db.query('SELECT count(*)::int AS n FROM faction_attacks')
    expect(count.rows[0].n).toBe(3)

    const revives = await post('/api/sync/wars/500/revives', 'leader')
    expect(revives.status).toBe(200)
    expect(revives.body.run.status).toBe('success')

    const wars = await post('/api/sync/wars', 'leader')
    expect(wars.status).toBe(200)
    expect(wars.body.run.job_name).toBe('wars-sync')

    // All three runs are queryable in the run log.
    const runs = await stack.db.query(
      `SELECT job_name FROM scraper_runs ORDER BY id DESC LIMIT 3`
    )
    expect(runs.rows.map((r: any) => r.job_name).sort()).toEqual(['attacks-sync', 'revives-sync', 'wars-sync'])

    expect((await post('/api/sync/attacks', 'visitor')).status).toBe(403)
    expect((await post('/api/sync/wars', 'visitor')).status).toBe(403)
    expect((await post('/api/sync/wars/500/revives', 'visitor')).status).toBe(403)
  })

  it('leadership can trigger crimes-sync and members-sync; visitors cannot', async () => {
    // The trigger + run-log wiring is what matters here (job success depends on
    // fixture data the other suites set up); assert the endpoint runs the right
    // job under the run logger and is leadership-gated.
    const crimes = await post('/api/sync/crimes', 'leader')
    expect(crimes.status).toBe(200)
    expect(crimes.body.run.job_name).toBe('crimes-sync')

    const members = await post('/api/sync/members', 'leader')
    expect(members.status).toBe(200)
    expect(members.body.run.job_name).toBe('members-sync')

    expect((await post('/api/sync/crimes', 'visitor')).status).toBe(403)
    expect((await post('/api/sync/members', 'visitor')).status).toBe(403)
  })
})

// #247: attacks-sync soft-stops on a rate limit mid-backlog — the pages already
// fetched stay committed and the run ends as a success, so the next run resumes
// from the newest stored attack. A non-transient error still fails. Runs last so
// its DELETE/handler churn can't disturb the earlier attacks fixtures.
describe('attacks sync job — soft-stop on rate limit (#247)', () => {
  const softAttack = (id: number, started: number) => ({
    id, started, ended: started + 30,
    attacker: { id: 1100, name: 'Scout', faction: { id: US, name: 'Us' } },
    defender: { id: 9999, name: 'Enemy', faction: { id: 9100, name: 'Foes' } },
    result: 'Attacked', respect_gain: 1, chain: 1, is_ranked_war: false,
    modifiers: { fair_fight: 1, war: 1, chain: 1, warlord: 1 },
  })

  it('soft-stops on a rate-limit error, keeping the pages already fetched', async () => {
    await stack.db.query('DELETE FROM faction_attacks')
    stack.torn.setHandler('/v2/faction/attacks', (url) => {
      const from = Number(url.searchParams.get('from') ?? 0)
      if (from === 0) return { attacks: Array.from({ length: 100 }, (_, i) => softAttack(7000 + i, i + 1)) }
      return { error: { code: 5, error: 'Too many requests' } }
    })

    const { attacksSyncJob } = await import('../src/scraper/jobs/attacksSync.js')
    const result = await attacksSyncJob(deps()) // resolves — does not throw
    expect(result.rows).toBe(100)
    const count = await stack.db.query('SELECT count(*)::int AS n FROM faction_attacks')
    expect(count.rows[0].n).toBe(100)
  })

  it('still surfaces a non-transient Torn error as a failure', async () => {
    await stack.db.query('DELETE FROM faction_attacks')
    stack.torn.setHandler('/v2/faction/attacks', (url) => {
      const from = Number(url.searchParams.get('from') ?? 0)
      if (from === 0) return { attacks: Array.from({ length: 100 }, (_, i) => softAttack(7000 + i, i + 1)) }
      return { error: { code: 6, error: 'Incorrect ID' } }
    })

    const { attacksSyncJob } = await import('../src/scraper/jobs/attacksSync.js')
    await expect(attacksSyncJob(deps())).rejects.toThrow()
  })
})
