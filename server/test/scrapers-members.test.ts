// Members + member-stats scrapers and tier assignment (slice #69), on the
// scraper core against the Torn fixture. Reference specs: cpr_scraper.py
// (_sync_members_to_supabase + _reconcile_key_pool), scrape_member_stats.py,
// assign_tiers.py.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'

let stack: TestStack
const ENCRYPTION_KEY = 'c'.repeat(64)

function deps() {
  return {
    db: stack.db,
    pool: createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY }),
    client: createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 200, perMs: 1000 } }),
    // Presence of the at-rest secret arms the key re-verification pass (#309).
    encryptionKey: ENCRYPTION_KEY,
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
  // members-sync re-verifies every pooled key against /v2/key/info (#309), so
  // the shared-stack keys have to exist in the Torn fixture.
  stack.torn.addKey('STAYERKEY1001AAA', { id: '1001', factionId: TEST_FACTION.tornFactionId })
  stack.torn.addKey('BOOMKEY01003CCCC', { id: '1003', factionId: TEST_FACTION.tornFactionId })
  // #645: members-sync now confirms the claimed key still answers for OUR
  // faction before trusting the roster it returns.
  stack.torn.setPath('/v2/faction/basic', {
    basic: { id: Number(TEST_FACTION.tornFactionId), name: 'Us', tag: 'US' },
  })
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('members sync job', () => {
  it('applies current/left transitions and reconciles the key pool', async () => {
    stack.torn.setPath('/v2/faction/members', {
      members: [
        { id: 1001, name: 'Stayer', days_in_faction: 589 },
        { id: 1003, name: 'Boomerang', days_in_faction: 12 },
        { id: 1004, name: 'FreshRecruit', days_in_faction: 1 },
      ],
    })

    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    const result = await membersSyncJob(deps())
    expect(result.rows).toBe(3)

    const members = await stack.db.query(
      'SELECT member_id, member_name, is_current, tier, total_days_in_faction FROM members ORDER BY member_id'
    )
    expect(members.rows).toEqual([
      // Torn's lifetime days_in_faction is captured verbatim (#284).
      { member_id: '1001', member_name: 'Stayer', is_current: true, tier: 3, total_days_in_faction: 589 },
      // The leaver keeps their row (history) but drops out of the roster.
      { member_id: '1002', member_name: 'Leaver', is_current: false, tier: 4, total_days_in_faction: null },
      { member_id: '1003', member_name: 'Boomerang', is_current: true, tier: 5, total_days_in_faction: 12 },
      // Brand-new member gets the tier default (6).
      { member_id: '1004', member_name: 'FreshRecruit', is_current: true, tier: 6, total_days_in_faction: 1 },
    ])

    // Stints (#284): every roster member has exactly one open stint; the leaver
    // has none open. No prior snapshot history here, so joined_at seeds to ~now.
    const stints = await stack.db.query(
      `SELECT member_id, left_at IS NULL AS open FROM member_faction_stints
       WHERE left_at IS NULL ORDER BY member_id`
    )
    expect(stints.rows.map((r) => r.member_id)).toEqual(['1001', '1003', '1004'])
    const leaverOpen = await stack.db.query(
      `SELECT count(*)::int AS n FROM member_faction_stints WHERE member_id = '1002' AND left_at IS NULL`
    )
    expect(leaverOpen.rows[0].n).toBe(0)

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

// #309 — every members-sync re-verifies the enrolled keys against /v2/key/info
// so a recruit promoted to full member joins the pool without re-logging in.
describe('key-pool re-verification (#309)', () => {
  const REVERIFY_ROSTER = {
    members: [
      { id: 1001, name: 'Stayer', days_in_faction: 589 },
      { id: 1003, name: 'Boomerang', days_in_faction: 12 },
      { id: 1004, name: 'FreshRecruit', days_in_faction: 1 },
      { id: 2001, name: 'Promoted', days_in_faction: 3 },
      { id: 2002, name: 'StillRecruit', days_in_faction: 1 },
      { id: 2003, name: 'Revoked', days_in_faction: 400 },
      { id: 2004, name: 'FatalError', days_in_faction: 200 },
      { id: 2005, name: 'Hiccup', days_in_faction: 300 },
      { id: 2006, name: 'WrongAccount', days_in_faction: 50 },
    ],
  }
  const ids = ['2001', '2002', '2003', '2004', '2005', '2006']
  const secret = async (memberId: string) =>
    (await stack.db.query(
      `SELECT has_faction_access, key_level, disabled, last_error FROM member_secrets WHERE member_id = $1`,
      [memberId]
    )).rows[0]

  beforeAll(async () => {
    for (const id of ids) {
      await stack.db.query(
        `INSERT INTO members (member_id, member_name, is_current) VALUES ($1, $2, true)
         ON CONFLICT (member_id) DO NOTHING`,
        [id, `Member ${id}`]
      )
    }
    const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
    // Enrolled at login as a recruit (no faction access) — Torn has since promoted them.
    await pool.store('2001', 'RECRUITKEY2001AA', { hasFactionAccess: false, keyLevel: 3 })
    stack.torn.addKey('RECRUITKEY2001AA', { id: '2001', factionId: TEST_FACTION.tornFactionId, accessLevel: 4 })
    // Still inside Torn's recruit window — nothing changes.
    await pool.store('2002', 'RECRUITKEY2002BB', { hasFactionAccess: false, keyLevel: 3 })
    stack.torn.addKey('RECRUITKEY2002BB', { id: '2002', factionId: TEST_FACTION.tornFactionId, factionAccess: false })
    // Had faction access at login; the owner has since narrowed the key's scopes.
    await pool.store('2003', 'FULLKEY002003CCC', { hasFactionAccess: true, keyLevel: 3 })
    stack.torn.addKey('FULLKEY002003CCC', { id: '2003', factionId: TEST_FACTION.tornFactionId, factionAccess: false })
    // Fatal key error (13 = disabled for owner inactivity) ⇒ out of the pool.
    await pool.store('2004', 'DEADKEY002004DDD', { hasFactionAccess: true, keyLevel: 3 })
    stack.torn.addBadKey('DEADKEY002004DDD', 13, 'Key temporarily disabled due to owner inactivity')
    // Transient error (5 = too many requests) ⇒ untouched, retried next run.
    await pool.store('2005', 'BUSYKEY002005EEE', { hasFactionAccess: true, keyLevel: 3 })
    stack.torn.addBadKey('BUSYKEY002005EEE', 5, 'Too many requests')
    // The key now resolves to a different Torn account than the row it's stored on.
    await pool.store('2006', 'SWAPKEY002006FFF', { hasFactionAccess: true, keyLevel: 3 })
    stack.torn.addKey('SWAPKEY002006FFF', { id: '9999', factionId: TEST_FACTION.tornFactionId })
  })

  afterAll(async () => {
    await stack.db.query(`DELETE FROM member_secrets WHERE member_id = ANY($1)`, [ids])
    await stack.db.query(`DELETE FROM member_faction_stints WHERE member_id = ANY($1)`, [ids])
    await stack.db.query(`DELETE FROM member_daily_stats WHERE member_id = ANY($1)`, [ids])
    await stack.db.query(`DELETE FROM members WHERE member_id = ANY($1)`, [ids])
  })

  it('promotes, revokes, refreshes and disables enrolled keys off /v2/key/info', async () => {
    stack.torn.setPath('/v2/faction/members', REVERIFY_ROSTER)
    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    const result = await membersSyncJob(deps())

    // One key's failure aborts neither the roster reconcile nor the other keys.
    expect(result.rows).toBe(REVERIFY_ROSTER.members.length)

    // Promoted recruit: flipped true, key_level refreshed from access.level.
    expect(await secret('2001')).toMatchObject({
      has_faction_access: true, key_level: 4, disabled: false, last_error: null,
    })
    // Still a recruit: stays false (and stays out of the pool).
    expect(await secret('2002')).toMatchObject({ has_faction_access: false, disabled: false })
    // Lost faction access: flipped back to false.
    expect(await secret('2003')).toMatchObject({ has_faction_access: false, disabled: false })
    // Fatal Torn key error: disabled with the reason for Key Pool Health.
    const fatal = await secret('2004')
    expect(fatal.disabled).toBe(true)
    expect(fatal.last_error).toContain('13')
    // Transient error: untouched, retried next run.
    expect(await secret('2005')).toMatchObject({
      has_faction_access: true, key_level: 3, disabled: false, last_error: null,
    })
    // Wrong account: disabled, like the login-time wrong-account check.
    const swapped = await secret('2006')
    expect(swapped.disabled).toBe(true)
    expect(swapped.last_error).toContain('9999')

    // The promoted recruit is now claimable; the two false rows are not.
    const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
    const claimable = (await pool.listKeys()).map((k) => k.member_id)
    expect(claimable).toContain('2001')
    expect(claimable).not.toContain('2002')
    expect(claimable).not.toContain('2003')
    expect(claimable).not.toContain('2004')
    expect(claimable).not.toContain('2006')
  })

  it('skips the re-verify pass when KEY_ENCRYPTION_KEY is unset', async () => {
    // Torn would now report faction access for 2002 — but with no at-rest secret
    // configured the job must not touch the pool at all.
    stack.torn.addKey('RECRUITKEY2002BB', { id: '2002', factionId: TEST_FACTION.tornFactionId })
    stack.torn.setPath('/v2/faction/members', REVERIFY_ROSTER)

    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    const { encryptionKey: _omitted, ...unconfigured } = deps()
    const result = await membersSyncJob(unconfigured)

    expect(result.rows).toBe(REVERIFY_ROSTER.members.length)
    expect(await secret('2002')).toMatchObject({ has_faction_access: false })
  })
})

describe('member stats job', () => {
  const backfillTs: number[] = []
  const profileCalls: number[] = []

  it('backfills missing days, snapshots today personalstats + gym, and no longer fetches profile', async () => {
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
      // Tripwire: member-stats must NOT call profile anymore (it moved to the
      // member-profile job, #226). Records any call so we can assert none happened.
      stack.torn.setHandler(`/v2/user/${mid}/profile`, () => {
        profileCalls.push(mid)
        return {
          profile: {
            id: mid,
            donator_status: mid === 1001 ? 'Subscriber' : null,
            property: { name: mid === 1001 ? 'Private Island' : null },
            last_action: { status: 'Online', timestamp: 1751900000 + mid },
          },
        }
      })
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
    // Profile enrichment is the separate member-profile job now — no profile calls.
    expect(profileCalls).toEqual([])

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
    // personalstats + gym land; profile denorms are left untouched (member-profile's job).
    expect(todayRow.rows[0]).toMatchObject({
      gym_strength: 1000, gym_speed: 2000, gym_dexterity: 3000, gym_defense: 4000, gym_energy: 5000,
    })
    expect(todayRow.rows[0].personalstats).toEqual({ drugs: { xantaken: 1101 } })
    expect(todayRow.rows[0].is_donator).toBeNull()
    expect(todayRow.rows[0].property_name).toBeNull()

    // 1003 has no gym contributions; member-stats still lands its personalstats.
    const other = await stack.db.query(
      `SELECT personalstats, gym_strength FROM member_daily_stats
       WHERE member_id = '1003' AND snapshot_date = $1`,
      [iso(today)]
    )
    expect(other.rows[0]).toMatchObject({ gym_strength: null })
    expect(other.rows[0].personalstats).toEqual({ drugs: { xantaken: 1103 } })

    // #227: the run also appends a slim sample per current member — the
    // competition-relevant personalstats categories plus gym, with a captured_at.
    const sample = await stack.db.query(
      `SELECT stats, gym_energy, captured_at FROM member_stat_samples
       WHERE member_id = '1001' ORDER BY id DESC LIMIT 1`
    )
    expect(sample.rows[0].stats).toEqual({ drugs: { xantaken: 1101 } })
    expect(sample.rows[0].gym_energy).toBe(5000)
    expect(sample.rows[0].captured_at).toBeTruthy()
    // One sample per current member this run (1001, 1003, 1004).
    const count = await stack.db.query(`SELECT count(*)::int AS n FROM member_stat_samples`)
    expect(count.rows[0].n).toBe(3)
  })
})

describe('member_stat_samples retention (#227)', () => {
  it('prunes samples older than 90 days unless inside an unresolved competition window', async () => {
    // An unresolved competition whose window brackets one old sample.
    await stack.db.query(
      `INSERT INTO competitions (name, metric_id, window_kind, window_start, window_end)
       VALUES ('Old contest', 'xanax_taken', 'fixed',
               (now() - interval '121 days')::date, (now() - interval '119 days')::date)`
    )
    await stack.db.query(`
      INSERT INTO member_stat_samples (member_id, captured_at, stats) VALUES
        ('1001', now() - interval '200 days', '{"tag":"orphan"}'),
        ('1001', now() - interval '120 days', '{"tag":"boundary"}'),
        ('1001', now() - interval '2 days',   '{"tag":"recent"}')
    `)

    const { statsSamplesPruneJob } = await import('../src/scraper/jobs/statsSamplesPrune.js')
    const result = await statsSamplesPruneJob(deps())

    // Only the 200-day sample outside any competition window is pruned.
    expect(result.rows).toBe(1)
    const tag = async (t: string) =>
      (await stack.db.query(`SELECT count(*)::int AS n FROM member_stat_samples WHERE stats->>'tag' = $1`, [t])).rows[0].n
    expect(await tag('orphan')).toBe(0)   // pruned
    expect(await tag('boundary')).toBe(1) // kept — inside the unresolved competition's window
    expect(await tag('recent')).toBe(1)   // kept — within 90 days
  })
})

describe('member profile job (#226)', () => {
  it('writes donator/property/last-action denorms onto today\'s row without fetching personalstats', async () => {
    const personalstatsCalls: number[] = []
    for (const mid of [1001, 1003, 1004]) {
      stack.torn.setHandler(`/v2/user/${mid}/personalstats`, () => {
        personalstatsCalls.push(mid)
        return { personalstats: {} }
      })
      stack.torn.setHandler(`/v2/user/${mid}/profile`, () => ({
        profile: {
          id: mid,
          donator_status: mid === 1001 ? 'Subscriber' : null,
          property: { name: mid === 1001 ? 'Private Island' : null },
          last_action: { status: 'Online', timestamp: 1751800000 + mid },
        },
      }))
    }

    const { memberProfileJob } = await import('../src/scraper/jobs/memberProfile.js')
    const result = await memberProfileJob(deps())

    // One row per current member (1001, 1003, 1004); profile only, no personalstats.
    expect(result.rows).toBe(3)
    expect(personalstatsCalls).toEqual([])

    const today = new Date().toISOString().slice(0, 10)
    const donator = await stack.db.query(
      `SELECT is_donator, property_name, last_action_timestamp, personalstats
       FROM member_daily_stats WHERE member_id = '1001' AND snapshot_date = $1`,
      [today]
    )
    expect(donator.rows[0]).toMatchObject({
      is_donator: true, property_name: 'Private Island', last_action_timestamp: 1751801001,
    })
    // Composes with member-stats: the personalstats written earlier survive the profile upsert.
    expect(donator.rows[0].personalstats).toEqual({ drugs: { xantaken: 1101 } })

    const nonDonator = await stack.db.query(
      `SELECT is_donator, property_name FROM member_daily_stats
       WHERE member_id = '1003' AND snapshot_date = $1`,
      [today]
    )
    expect(nonDonator.rows[0]).toMatchObject({ is_donator: false, property_name: null })
  })
})

// #284 — stint maintenance + rollout seeding. Runs last so it can drive its own
// rosters without disturbing the earlier shared-stack tests.
describe('faction stints (#284)', () => {
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400_000))
  const roster = (extra: Array<{ id: number; name: string; days_in_faction?: number }>) => ({
    members: [
      { id: 1001, name: 'Stayer', days_in_faction: 589 },
      { id: 1003, name: 'Boomerang', days_in_faction: 12 },
      { id: 1004, name: 'FreshRecruit', days_in_faction: 1 },
      ...extra,
    ],
  })

  // Remove the synthetic members so the later cpr-scan test still sees exactly
  // the shared-stack roster (1001/1003/1004).
  afterAll(async () => {
    const ids = ['3001', '3002', '3003']
    await stack.db.query(`DELETE FROM member_faction_stints WHERE member_id = ANY($1)`, [ids])
    await stack.db.query(`DELETE FROM member_daily_stats WHERE member_id = ANY($1)`, [ids])
    await stack.db.query(`DELETE FROM members WHERE member_id = ANY($1)`, [ids])
  })

  it('seeds a new stint from the most recent contiguous snapshot run (gap = absence)', async () => {
    await stack.db.query(`
      INSERT INTO members (member_id, member_name, is_current) VALUES
        ('3001', 'Veteran', false), ('3002', 'Returner', false)
      ON CONFLICT (member_id) DO NOTHING
    `)
    // 3001: unbroken run for the last 6 days, then an old orphan 30 days back.
    for (const n of [1, 2, 3, 4, 5, 6, 30]) {
      await stack.db.query(
        `INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats)
         VALUES ('3001', $1, '{}') ON CONFLICT DO NOTHING`, [daysAgo(n)]
      )
    }
    // 3002: only stale snapshots (40–45 days back) — newest is well past the gap.
    for (const n of [40, 41, 42, 43, 44, 45]) {
      await stack.db.query(
        `INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats)
         VALUES ('3002', $1, '{}') ON CONFLICT DO NOTHING`, [daysAgo(n)]
      )
    }

    stack.torn.setPath('/v2/faction/members', roster([
      { id: 3001, name: 'Veteran' }, { id: 3002, name: 'Returner' },
    ]))
    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    await membersSyncJob(deps())

    const v = await stack.db.query(
      `SELECT (joined_at AT TIME ZONE 'UTC')::date::text AS d FROM member_faction_stints
       WHERE member_id = '3001' AND left_at IS NULL`
    )
    // Start of the contiguous run — 6 days ago, not the 30-day-old orphan.
    expect(v.rows[0].d).toBe(daysAgo(6))

    const r = await stack.db.query(
      `SELECT (joined_at AT TIME ZONE 'UTC')::date::text AS d FROM member_faction_stints
       WHERE member_id = '3002' AND left_at IS NULL`
    )
    // Newest snapshot is stale → treated as a fresh join at ~now.
    expect(r.rows[0].d).toBe(daysAgo(0))
  })

  it('closes the open stint on leave and opens a fresh one on rejoin', async () => {
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, is_current) VALUES ('3003', 'Yoyo', false)
       ON CONFLICT (member_id) DO NOTHING`
    )
    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')

    // Present → one open stint (no snapshots ⇒ joined ~now).
    stack.torn.setPath('/v2/faction/members', roster([{ id: 3003, name: 'Yoyo' }]))
    await membersSyncJob(deps())
    let s = await stack.db.query(
      `SELECT count(*)::int AS n FROM member_faction_stints WHERE member_id = '3003' AND left_at IS NULL`
    )
    expect(s.rows[0].n).toBe(1)

    // Absent → the open stint is closed.
    stack.torn.setPath('/v2/faction/members', roster([]))
    await membersSyncJob(deps())
    s = await stack.db.query(
      `SELECT
         count(*) FILTER (WHERE left_at IS NULL)::int AS open,
         count(*) FILTER (WHERE left_at IS NOT NULL)::int AS closed
       FROM member_faction_stints WHERE member_id = '3003'`
    )
    expect(s.rows[0]).toMatchObject({ open: 0, closed: 1 })

    // Rejoin → a second, fresh stint opens; the prior one stays closed.
    stack.torn.setPath('/v2/faction/members', roster([{ id: 3003, name: 'Yoyo' }]))
    await membersSyncJob(deps())
    s = await stack.db.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE left_at IS NULL)::int AS open
       FROM member_faction_stints WHERE member_id = '3003'`
    )
    expect(s.rows[0]).toMatchObject({ total: 2, open: 1 })
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

// ── Fallen members ──────────────────────────────────────────────────────────
//
// Torn preserves the account of a player who has died — status "Fallen",
// described as "Resting in Peace". They stay on the roster indefinitely, which
// is also how a faction comes to exceed 100 members. They cannot act, so they
// must not be counted, scraped or chased for roll call; but they have not left
// the faction, so is_current and their stint history are left alone.
describe('fallen members', () => {
  const rosterWith = (members: Array<Record<string, unknown>>) => ({ members })

  afterAll(async () => {
    await stack.db.query(`DELETE FROM member_faction_stints WHERE member_id = '4001'`)
    await stack.db.query(`DELETE FROM members WHERE member_id = '4001'`)
  })

  it('marks a Fallen member without treating them as having left', async () => {
    stack.torn.setPath('/v2/faction/members', rosterWith([
      { id: 1001, name: 'Stayer', days_in_faction: 590, status: { state: 'Okay' } },
      { id: 4001, name: 'Remembered', days_in_faction: 900, status: { state: 'Fallen', description: 'Fallen' } },
    ]))
    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    await membersSyncJob(deps())

    const res = await stack.db.query(
      'SELECT is_current, is_fallen FROM members WHERE member_id = $1', ['4001']
    )
    expect(res.rows[0].is_fallen).toBe(true)
    // ⚠️ Still a member. Flipping is_current would close their stint and read
    // as "left the faction", which is both wrong and the sort of thing nobody
    // wants to see happen to a memorial account.
    expect(res.rows[0].is_current).toBe(true)
  })

  it('leaves a living member untouched, and clears the flag if it ever lifts', async () => {
    stack.torn.setPath('/v2/faction/members', rosterWith([
      { id: 1001, name: 'Stayer', days_in_faction: 591, status: { state: 'Okay' } },
      { id: 4001, name: 'Remembered', days_in_faction: 901, status: { state: 'Okay' } },
    ]))
    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    await membersSyncJob(deps())

    const res = await stack.db.query(
      'SELECT member_id, is_fallen FROM members WHERE member_id = ANY($1) ORDER BY member_id',
      [['1001', '4001']]
    )
    expect(res.rows.map((r: any) => r.is_fallen)).toEqual([false, false])
  })

  it('tolerates a roster row with no status at all', async () => {
    // Not every Torn payload carries status; absence must read as "not fallen"
    // rather than throwing or flagging everyone.
    stack.torn.setPath('/v2/faction/members', rosterWith([
      { id: 1001, name: 'Stayer', days_in_faction: 592 },
    ]))
    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    await membersSyncJob(deps())
    const res = await stack.db.query('SELECT is_fallen FROM members WHERE member_id = $1', ['1001'])
    expect(res.rows[0].is_fallen).toBe(false)
  })

  it('⚠️ is excluded from every member listing and scrape target', async () => {
    // The point of the flag. Each of these is a separate query in a separate
    // file, and each one would otherwise count or scrape a dead account.
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, tier, is_current, is_fallen)
       VALUES ('4001', 'Remembered', 3, true, true)
       ON CONFLICT (member_id) DO UPDATE SET is_current = true, is_fallen = true`
    )
    const listed = async (sql: string) => {
      const r = await stack.db.query(sql)
      return r.rows.map((x: any) => String(x.member_id))
    }
    // members page / battle-stat leaderboard / OC roster / scrape targets
    for (const sql of [
      `SELECT m.member_id FROM members m WHERE m.is_current = true AND m.is_fallen = false`,
      `SELECT member_id FROM members WHERE is_current = true AND is_fallen = false`,
      `SELECT member_id FROM members WHERE is_fallen = false`,
    ]) {
      expect(await listed(sql), sql).not.toContain('4001')
    }
    // ...but a direct lookup still finds them, so nothing 404s on an old link.
    const direct = await stack.db.query('SELECT member_name FROM members WHERE member_id = $1', ['4001'])
    expect(direct.rows[0].member_name).toBe('Remembered')
  })
})

// ── #645: the roster swap that cost capacityx thirteen days ──────────────────
//
// On 2026-08-24 a member who had left capacityx still had a key in the pool.
// The round-robin claimed it, `/v2/faction/members` answered with THEIR NEW
// FACTION'S roster, and this job wrote it as ours: 95 real members marked
// departed, 31 strangers inserted, every real key disabled as "not in faction".
// With the pool empty the only job that could re-enable those keys was this
// one, which needs a key from the pool it had just emptied — so it failed
// hourly with `no pooled key available` for thirteen days while every surface
// reported the tenant healthy.
//
// ⚠️ One stack for all of this, not one per describe. An earlier version booted
// two more embedded Postgres instances and risked flaking unrelated suites by
// pushing concurrent servers past what the runner has (it had already happened
// once, in oc.test.ts). Tests that destabilise the suite are not worth the
// isolation they buy.
describe('#645 — roster-swap protection', () => {
  let bare: TestStack
  const DEPARTED = 'DEPARTEDKEY99999'
  const LOYAL = 'LOYALKEY00000002'

  const bareDeps = () => ({
    db: bare.db,
    pool: createKeyPool({ db: bare.db, encryptionKey: ENCRYPTION_KEY }),
    client: createTornClient({ baseUrl: bare.tornBaseUrl, budget: { requests: 200, perMs: 1000 } }),
    encryptionKey: ENCRYPTION_KEY,
  })

  const ours = () => bare.torn.setPath('/v2/faction/basic', {
    basic: { id: Number(TEST_FACTION.tornFactionId), name: 'Us', tag: 'US' },
  })
  const elsewhere = () => bare.torn.setPath('/v2/faction/basic', {
    basic: { id: 99999, name: 'Elsewhere', tag: 'ELSE' },
  })
  const heldCount = async () =>
    Number((await bare.db.query('SELECT count(*)::int AS n FROM members WHERE is_current')).rows[0].n)

  beforeAll(async () => {
    bare = await startTestStack()
    await bare.db.query(`
      INSERT INTO members (member_id, member_name, tier, is_current)
      SELECT (2000 + g)::text, 'Member' || g, 3, true FROM generate_series(1, 30) g
    `)
    const pool = createKeyPool({ db: bare.db, encryptionKey: ENCRYPTION_KEY })
    await pool.store('2001', DEPARTED, { consentVersion: 'v2' })
    await pool.store('2002', LOYAL, { consentVersion: 'v2' })
    bare.torn.addKey(DEPARTED, { id: '2001', factionId: '99999' })
    bare.torn.addKey(LOYAL, { id: '2002', factionId: TEST_FACTION.tornFactionId })
  }, 60000)

  afterAll(async () => { await bare?.close() })

  it('⚠️ refuses to sync, disables THAT key, and leaves the roster alone', async () => {
    elsewhere()
    bare.torn.setPath('/v2/faction/members', {
      members: [{ id: 90001, name: 'Stranger', days_in_faction: 4 }],
    })

    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    await expect(membersSyncJob(bareDeps())).rejects.toThrow(/now in faction 99999/)

    // ⚠️ THE assertion. The bug was never that the run failed — it was that the
    // run SUCCEEDED and wrote another faction's roster over ours.
    expect(await heldCount()).toBe(30)

    // ⚠️ The one bad key is disabled; the loyal one is untouched. Dropping that
    // key was always the correct response, not retiring ninety-five members.
    const keys = await bare.db.query('SELECT member_id, disabled, last_error FROM member_secrets')
    const bad = keys.rows.find((r) => r.member_id === '2001')!
    expect(bad.disabled).toBe(true)
    expect(bad.last_error).toMatch(/left the faction/)
    expect(keys.rows.find((r) => r.member_id === '2002')!.disabled).toBe(false)
  })

  it('⚠️ the cheap check that looks sufficient would NOT have caught this', async () => {
    // "The key owner must appear in the roster it returned" needs no extra API
    // call and is the obvious guard — I nearly shipped it. It fails here: the
    // departed member IS in the roster their key returns, because it is their
    // new faction's. Only the faction ID separates the two, which is what
    // justifies the extra call.
    await bare.db.query(
      `UPDATE member_secrets SET disabled = false, last_error = NULL WHERE member_id = '2001'`
    )
    elsewhere()
    bare.torn.setPath('/v2/faction/members', {
      members: [
        { id: 2001, name: 'Departed', days_in_faction: 9 },   // the key owner, present
        { id: 90002, name: 'Stranger', days_in_faction: 4 },
      ],
    })
    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    await expect(membersSyncJob(bareDeps())).rejects.toThrow(/now in faction 99999/)
    expect(await heldCount()).toBe(30)
  })

  it('⚠️ refuses a roster that would retire most of the faction', async () => {
    // The identity check passes here — the key is genuinely ours — so this is
    // the backstop for a truncated or otherwise wrong response from a VALID
    // key, which no API call can detect.
    ours()
    bare.torn.setPath('/v2/faction/members', {
      members: [{ id: 2001, name: 'Member1', days_in_faction: 100 }],
    })
    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    await expect(membersSyncJob(bareDeps())).rejects.toThrow(/would retire 29 of 30/)
    expect(await heldCount()).toBe(30)
  })

  it('accepts ordinary attrition, so the guard is not itself the outage', async () => {
    ours()
    const roster = Array.from({ length: 28 }, (_, i) => ({
      id: 2001 + i, name: `Member${i + 1}`, days_in_faction: 100,
    }))
    bare.torn.setPath('/v2/faction/members', { members: roster })
    const { membersSyncJob } = await import('../src/scraper/jobs/membersSync.js')
    await expect(membersSyncJob(bareDeps())).resolves.toMatchObject({ rows: 28 })
  })
})
