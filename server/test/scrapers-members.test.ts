// Members + member-stats scrapers and tier assignment (slice #69), on the
// scraper core against the Torn fixture. Reference specs: cpr_scraper.py
// (_sync_members_to_supabase + _reconcile_key_pool), scrape_member_stats.py,
// assign_tiers.py.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'

let stack: TestStack
const ENCRYPTION_KEY = 'c'.repeat(64)

function deps() {
  return {
    db: stack.db,
    pool: createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY }),
    client: createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 200, perMs: 1000 } }),
  }
}

beforeAll(async () => {
  stack = await startTestStack()
  // Stayer (1001), leaver (1002), and a previously-left member (1003) who
  // rejoins this run. 1004 appears for the first time in the fixture roster.
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, tier, is_current) VALUES
      ('1001', 'Stayer', 3, true),
      ('1002', 'Leaver', 4, true),
      ('1003', 'Boomerang', 5, false)
  `)
  const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
  await pool.store('1001', 'STAYERKEY1001AAA', { consentVersion: 'v2' })
  await pool.store('1002', 'LEAVERKEY1002BBB', { consentVersion: 'v2' })
  await pool.store('1003', 'BOOMKEY01003CCCC', { consentVersion: 'v2' })
  await pool.disable('1003', 'not in faction as of 2026-06-01')
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('members sync job', () => {
  it('applies current/left transitions and reconciles the key pool', async () => {
    stack.torn.setPath('/v2/faction/members', {
      members: [
        { id: 1001, name: 'Stayer' },
        { id: 1003, name: 'Boomerang' },
        { id: 1004, name: 'FreshRecruit' },
      ],
    })

    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    const result = await membersSyncJob(deps())
    expect(result.rows).toBe(3)

    const members = await stack.db.query(
      'SELECT member_id, member_name, is_current, tier FROM members ORDER BY member_id'
    )
    expect(members.rows).toEqual([
      { member_id: '1001', member_name: 'Stayer', is_current: true, tier: 3 },
      // The leaver keeps their row (history) but drops out of the roster.
      { member_id: '1002', member_name: 'Leaver', is_current: false, tier: 4 },
      { member_id: '1003', member_name: 'Boomerang', is_current: true, tier: 5 },
      // Brand-new member gets the tier default (6).
      { member_id: '1004', member_name: 'FreshRecruit', is_current: true, tier: 6 },
    ])

    // Pool reconcile: the leaver's key leaves the rotation with the reason;
    // the rejoiner's disabled key is let back in.
    const secrets = await stack.db.query(
      'SELECT member_id, disabled, last_error FROM member_secrets ORDER BY member_id'
    )
    expect(secrets.rows[0]).toMatchObject({ member_id: '1001', disabled: false })
    expect(secrets.rows[1].member_id).toBe('1002')
    expect(secrets.rows[1].disabled).toBe(true)
    expect(secrets.rows[1].last_error).toContain('not in faction')
    expect(secrets.rows[2]).toMatchObject({ member_id: '1003', disabled: false, last_error: null })
  })
})

describe('member stats job', () => {
  const backfillTs: number[] = []

  it('backfills missing days, snapshots today with profile denorms, and merges gym columns', async () => {
    // Bound the backfill: every target date already has a snapshot except
    // two known dates for member 1001; 1004 only misses today.
    const today = new Date()
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const daysAgo = (n: number) => new Date(today.getTime() - n * 86400_000)
    const missing1 = iso(daysAgo(3))
    const missing2 = iso(daysAgo(7))

    for (const mid of ['1001', '1003', '1004']) {
      for (let i = 1; i <= 30; i++) {
        const d = iso(daysAgo(i))
        if (mid === '1001' && (d === missing1 || d === missing2)) continue
        await stack.db.query(
          `INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats)
           VALUES ($1, $2, '{"seeded": true}') ON CONFLICT DO NOTHING`,
          [mid, d]
        )
      }
    }

    for (const mid of [1001, 1003, 1004]) {
      stack.torn.setHandler(`/v2/user/${mid}/personalstats`, (url) => {
        const ts = url.searchParams.get('timestamp')
        if (ts) backfillTs.push(Number(ts))
        return { personalstats: { drugs: { xantaken: ts ? 90 : 100 + mid } } }
      })
      stack.torn.setHandler(`/v2/user/${mid}/profile`, () => ({
        profile: {
          id: mid,
          donator_status: mid === 1001 ? 'Subscriber' : null,
          property: { name: mid === 1001 ? 'Private Island' : null },
          last_action: { status: 'Online', timestamp: 1751900000 + mid },
        },
      }))
    }
    stack.torn.setHandler('/v2/faction/contributors', (url) => {
      const stat = url.searchParams.get('stat')
      const base = { gymstrength: 1, gymspeed: 2, gymdexterity: 3, gymdefense: 4, gymenergy: 5 }[stat!] ?? 0
      return { contributors: [{ id: 1001, value: base * 1000 }, { id: 1004, value: base * 500 }] }
    })

    const { memberStatsJob } = await import('../src/scraper/jobs/memberStats.js')
    const result = await memberStatsJob(deps())

    // 2 backfill rows (1001) + 3 today rows.
    expect(result.rows).toBe(5)

    // Backfill timestamps: date midnight UTC + 3600 (the 01:00 snapshot offset).
    const expectedTs = Math.floor(new Date(`${missing1}T00:00:00Z`).getTime() / 1000) + 3600
    expect(backfillTs).toContain(expectedTs)

    const backfilled = await stack.db.query(
      `SELECT personalstats, profile FROM member_daily_stats WHERE member_id = '1001' AND snapshot_date = $1`,
      [missing1]
    )
    expect(backfilled.rows[0].personalstats).toEqual({ drugs: { xantaken: 90 } })
    expect(backfilled.rows[0].profile).toBeNull() // no historical profiles

    const todayRow = await stack.db.query(
      `SELECT * FROM member_daily_stats WHERE member_id = '1001' AND snapshot_date = $1`,
      [iso(today)]
    )
    expect(todayRow.rows[0]).toMatchObject({
      is_donator: true,
      property_name: 'Private Island',
      last_action_timestamp: 1751901001,
      gym_strength: 1000, gym_speed: 2000, gym_dexterity: 3000, gym_defense: 4000, gym_energy: 5000,
    })
    expect(todayRow.rows[0].personalstats).toEqual({ drugs: { xantaken: 1101 } })

    // 1003 has no gym contributions and no donator status.
    const other = await stack.db.query(
      `SELECT is_donator, property_name, gym_strength FROM member_daily_stats
       WHERE member_id = '1003' AND snapshot_date = $1`,
      [iso(today)]
    )
    expect(other.rows[0]).toMatchObject({ is_donator: false, property_name: null, gym_strength: null })
  })
})

describe('cpr-scan applies tier assignment (always-apply)', () => {
  it('recomputes every current member’s tier from fresh CPR, preserving overrides', async () => {
    // Reduced requirement set (tier 1 = one role check at 80).
    await stack.db.query(`
      INSERT INTO faction_settings (key, value) VALUES
        ('tier_requirements', '{"1":[{"crime":"Heist","role":"R1","minCpr":80}]}')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `)
    await stack.db.query(`UPDATE members SET tier_override = 2 WHERE member_id = '1004'`)

    stack.torn.setHandler('/v2/faction/crimes', () => ({ crimes: [] }))
    stack.torn.setHandler('/v2/user/organizedcrimes', (url) => {
      const key = url.searchParams.get('key')
      const cpr = key === 'STAYERKEY1001AAA' ? 85 : 20
      return {
        organizedcrimes: [{
          id: 950, name: 'Heist', difficulty: 7, status: 'Recruiting',
          slots: [{ position: 'R1', position_info: { id: 'H-R1', number: 1 }, checkpoint_pass_rate: cpr, user: null }],
        }],
      }
    })

    const { cprScanJob } = await import('../src/scraper/jobs/cprScan.js')
    await cprScanJob(deps())

    const members = await stack.db.query(
      `SELECT member_id, tier, tier_override FROM members WHERE is_current = true ORDER BY member_id`
    )
    expect(members.rows).toEqual([
      // 1001: Heist.R1 = 85 ≥ 80 → Tier 1 (was 3 — always-apply, downgrades and upgrades alike).
      { member_id: '1001', tier: 1, tier_override: null },
      // 1003: full data, misses → default Tier 6 (was 5).
      { member_id: '1003', tier: 6, tier_override: null },
      // 1004: no CPR data → Tier 0 manual review; the manual override column
      // is untouched by the scraper.
      { member_id: '1004', tier: 0, tier_override: 2 },
    ])
  })
})
