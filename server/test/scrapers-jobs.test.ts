// Ported scrapers (slice #68): items catalog + crimes + CPR, on the scraper
// core against the Torn fixture. Expected rows are hand-derived from the
// Python originals (scripts/items_update.py, daily_crime_update.py +
// sync_to_supabase.py, cpr_scraper.py) — those remain in-repo as the
// executable reference specs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'
import { createRunLogger } from '../src/scraper/runLog.js'
import { itemsSyncJob } from '../src/scraper/jobs/itemsSync.js'

let stack: TestStack
const ENCRYPTION_KEY = 'b'.repeat(64)

function deps() {
  return {
    db: stack.db,
    pool: createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY }),
    client: createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 100, perMs: 1000 } }),
  }
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, tier, is_current) VALUES
      ('800', 'KeyOwnerA', 3, true),
      ('801', 'KeyOwnerB', 3, true)
  `)
  const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
  await pool.store('800', 'MEMBERKEYA00800A', { keyLevel: 3, consentVersion: 'v2' })
  await pool.store('801', 'MEMBERKEYB00801B', { keyLevel: 3, consentVersion: 'v2' })
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('items sync job', () => {
  it('fetches the full catalog with a pooled key and upserts the Python transform shape', async () => {
    stack.torn.setPath('/v2/torn/items', {
      items: [
        {
          id: 66, name: 'Morphine', description: 'A painkiller.', effect: 'Reduces hospital time',
          type: 'Medical', sub_type: null, circulation: 500000, is_tradable: true,
          image: 'https://torn.com/images/items/66/large.png',
          value: { market_price: 48000, sell_price: 45000, buy_price: 0 },
        },
        // Missing value block and name — the Python transform defaults these.
        { id: 1466, description: null, effect: null, type: 'Other', circulation: 3, is_tradable: false },
      ],
    })

    const result = await itemsSyncJob(deps())
    expect(result.rows).toBe(2)

    const rows = await stack.db.query('SELECT * FROM items ORDER BY id')
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows[0]).toMatchObject({
      id: 66, name: 'Morphine', type: 'Medical',
      market_price: 48000, sell_price: 45000, buy_price: 0,
      circulation: 500000, is_tradable: true,
      image_url: 'https://torn.com/images/items/66/large.png',
    })
    // Python: name falls back to `Item {id}`, missing value.* become 0.
    expect(rows.rows[1]).toMatchObject({
      id: 1466, name: 'Item 1466', market_price: 0, sell_price: 0, buy_price: 0, is_tradable: false,
    })
  })
})

// ── Crimes sync fixtures ────────────────────────────────────────────────────
// Page 1: exactly 100 plain successful crimes (created 1001..1100) — the
// "exactly 100 means keep paging" boundary from the Python paginator.
// Page 2 (from=1100): overlap crime 100 + a rich Planning crime + a rich
// Successful crime with items.
const plainCrime = (i: number) => ({
  id: i, name: 'Mob Mentality', difficulty: 3, status: 'Successful',
  created_at: 1000 + i, planning_at: 1000 + i, executed_at: 2000 + i,
  ready_at: null, expired_at: null, slots: [], rewards: { money: 100, respect: 1, items: [] },
})

const richPlanning = {
  id: 101, name: 'Break the Bank', difficulty: 8, status: 'Planning',
  previous_crime_id: 55, created_at: 1101, planning_at: 1150,
  executed_at: null, ready_at: 1400, expired_at: null,
  slots: [
    {
      position: 'Robber', position_info: { id: 'BTB-R1', number: 1 },
      checkpoint_pass_rate: 75,
      user: { id: 800, name: 'KeyOwnerA', joined_at: 1200, outcome: null, progress: 50.5, item_outcome: null },
      item_requirement: { id: 206, name: 'Xanax', is_reusable: false, is_available: true },
    },
    {
      position: 'Hacker', position_info: { id: 'BTB-H1', number: 1 },
      checkpoint_pass_rate: 60, user: null, item_requirement: null,
    },
  ],
  rewards: null,
}

const richSuccessful = {
  id: 102, name: 'Smash and Grab', difficulty: 5, status: 'Successful',
  created_at: 1102, planning_at: 1160, executed_at: 2500, ready_at: null, expired_at: null,
  slots: [
    {
      position: 'Looter', position_info: { id: 'SAG-L1', number: 1 },
      checkpoint_pass_rate: 88,
      user: {
        id: 801, name: 'KeyOwnerB', joined_at: 1210, outcome: 'success', progress: 100,
        item_outcome: { item_id: 206, outcome: 'used', owned_by: 801, item_uid: 555 },
      },
      item_requirement: { id: 206, name: 'Xanax', is_reusable: false, is_available: true },
    },
  ],
  rewards: {
    money: 5000000, respect: 100,
    // Torn lists qty=0 "potential drops" — the reward-items table must skip
    // them (the jsonb rewards_items column keeps the raw list).
    items: [{ id: 66, name: 'Morphine', quantity: 2 }, { id: 99, name: 'Ghost Costume', quantity: 0 }],
  },
}

describe('crimes sync job', () => {
  const fromParams: number[] = []

  beforeAll(() => {
    stack.torn.setHandler('/v2/faction/crimes', (url) => {
      const from = Number(url.searchParams.get('from') ?? 0)
      fromParams.push(from)
      const all = [...Array.from({ length: 100 }, (_, i) => plainCrime(i + 1)), richPlanning, richSuccessful]
      const matching = all
        .filter((c) => c.created_at >= from)
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, 100)
      return { crimes: matching }
    })
  })

  it('pages the full history into the four crime tables with the Python transform shapes', async () => {
    const { crimesSyncJob } = await import('../src/scraper/jobs/crimesSync.js')
    const result = await crimesSyncJob(deps())

    // First run on an empty DB starts from the beginning and pages twice
    // (page 1 is exactly 100 crimes).
    expect(fromParams[0]).toBe(0)
    expect(fromParams.length).toBeGreaterThanOrEqual(2)

    const count = await stack.db.query('SELECT count(*)::int AS n FROM crimes')
    expect(count.rows[0].n).toBe(102)
    expect(result.rows).toBe(102)

    const planning = await stack.db.query(`SELECT * FROM crimes WHERE crime_id = '101'`)
    expect(planning.rows[0]).toMatchObject({
      name: 'Break the Bank', difficulty: 8, status: 'Planning',
      previous_crime_id: '55', created_at: 1101, ready_at: 1400,
      total_slots: 2, filled_slots: 1,
    })
    expect(planning.rows[0].first_seen).toBeTruthy()

    const success = await stack.db.query(`SELECT * FROM crimes WHERE crime_id = '102'`)
    expect(success.rows[0].rewards_money).toBe(5000000)
    expect(success.rows[0].rewards_items).toHaveLength(2)

    const slots = await stack.db.query(`SELECT * FROM crime_slots WHERE crime_id = '101' ORDER BY position_id`)
    expect(slots.rows).toHaveLength(2)
    expect(slots.rows[1]).toMatchObject({
      position: 'Robber', position_id: 'BTB-R1', position_number: 1,
      user_id: '800', user_name: 'KeyOwnerA', joined_at: 1200,
      item_requirement_id: '206', item_requirement_is_available: true,
    })
    expect(parseFloat(slots.rows[1].checkpoint_pass_rate)).toBe(75)
    expect(slots.rows[0].user_id).toBeNull()

    // Reward items: qty=0 potential drop skipped.
    const rewards = await stack.db.query(`SELECT * FROM crime_reward_items WHERE crime_id = '102'`)
    expect(rewards.rows).toHaveLength(1)
    expect(rewards.rows[0]).toMatchObject({ item_id: '66', item_name: 'Morphine', quantity: 2 })

    // Required items: was_consumed reflects the used/lost outcome.
    const req101 = await stack.db.query(`SELECT * FROM crime_required_items WHERE crime_id = '101'`)
    expect(req101.rows[0]).toMatchObject({ item_id: '206', was_consumed: false, user_id: '800' })
    const req102 = await stack.db.query(`SELECT * FROM crime_required_items WHERE crime_id = '102'`)
    expect(req102.rows[0]).toMatchObject({
      item_id: '206', was_consumed: true, outcome: 'used', outcome_owned_by: '801', outcome_item_uid: '555',
    })

    // #168: the sync also maintains the participation log — crime 101's
    // occupant is an open segment with the exact joined_at.
    const part = await stack.db.query(
      `SELECT joined_at, left_at, completed FROM crime_participation_v2 WHERE crime_id = '101' AND member_id = '800'`
    )
    expect(part.rows[0]).toMatchObject({ joined_at: 1200, left_at: null, completed: false })
  })

  it('resumes from the oldest incomplete crime and applies status transitions in place', async () => {
    const before = await stack.db.query(`SELECT first_seen FROM crimes WHERE crime_id = '101'`)

    // The Planning crime has since executed.
    stack.torn.setHandler('/v2/faction/crimes', (url) => {
      fromParams.push(Number(url.searchParams.get('from') ?? 0))
      return {
        crimes: [
          { ...richPlanning, status: 'Successful', executed_at: 3000, rewards: { money: 9000000, respect: 200, items: [] } },
          richSuccessful,
        ],
      }
    })

    const { crimesSyncJob } = await import('../src/scraper/jobs/crimesSync.js')
    await crimesSyncJob(deps())

    // Incremental start = the oldest incomplete crime's created_at (101 @ 1101).
    expect(fromParams[fromParams.length - 1]).toBe(1101)

    const updated = await stack.db.query(`SELECT * FROM crimes WHERE crime_id = '101'`)
    expect(updated.rows[0].status).toBe('Successful')
    expect(updated.rows[0].executed_at).toBe(3000)
    expect(updated.rows[0].rewards_money).toBe(9000000)
    // first_seen survives updates (set on first insert only).
    expect(updated.rows[0].first_seen).toBe(before.rows[0].first_seen)
  })

  it('anchors the incremental start on the oldest still-in-flight crime, skipping terminal Expired ones', async () => {
    // Regression: `executed_at IS NULL` alone treats Expired crimes (which
    // never execute) as in-flight, so one stale Expired crime pinned the
    // cursor months back and every run re-fetched the whole tail. The cursor
    // must skip Expired and anchor on the oldest genuinely-incomplete crime.
    await stack.db.query(`
      INSERT INTO crimes (crime_id, name, difficulty, status, created_at, executed_at) VALUES
        ('9001', 'Old Expired',      7, 'Expired',    50, NULL),
        ('9002', 'Fresh Recruiting', 7, 'Recruiting', 60, NULL)
    `)
    let capturedFrom = -1
    stack.torn.setHandler('/v2/faction/crimes', (url) => {
      capturedFrom = Number(url.searchParams.get('from') ?? -1)
      return { crimes: [] }
    })

    const { crimesSyncJob } = await import('../src/scraper/jobs/crimesSync.js')
    await crimesSyncJob(deps())

    // 60 (the Recruiting crime), NOT 50 (the Expired one).
    expect(capturedFrom).toBe(60)

    await stack.db.query(`DELETE FROM crimes WHERE crime_id IN ('9001', '9002')`)
  })
})

describe('CPR scan job', () => {
  let robberCpr = 72

  beforeAll(() => {
    // Faction available-crimes scan: one filled slot (CPR belongs to that
    // user) and one empty slot (no attribution with a faction-context key).
    stack.torn.setHandler('/v2/faction/crimes', () => ({
      crimes: [{
        id: 900, name: 'Break the Bank', difficulty: 8, status: 'Recruiting', created_at: 5000,
        slots: [
          { position: 'Robber', position_info: { id: 'BTB-R1', number: 1 }, checkpoint_pass_rate: 65, user: { id: 801, name: 'KeyOwnerB' } },
          { position: 'Muscle', position_info: { id: 'BTB-M1', number: 1 }, checkpoint_pass_rate: 99, user: null },
        ],
      }],
    }))
    // Per-member scan: the key owner's CPR rides on empty slots. Key A works;
    // key B answers with a Torn auth error (invalid/expired key).
    stack.torn.setHandler('/v2/user/organizedcrimes', (url) => {
      const key = url.searchParams.get('key')
      if (key === 'MEMBERKEYA00800A') {
        return {
          organizedcrimes: [{
            id: 900, name: 'Break the Bank', difficulty: 8, status: 'Recruiting',
            slots: [
              { position: 'Robber', position_info: { id: 'BTB-R1', number: 1 }, checkpoint_pass_rate: robberCpr, user: null },
              { position: 'Hacker', position_info: { id: 'BTB-H1', number: 1 }, checkpoint_pass_rate: 68, user: null },
            ],
          }],
        }
      }
      return { error: { code: 2, error: 'Incorrect key' } }
    })
  })

  it('attributes filled slots to their user and empty slots to the key owner; bad keys leave the pool', async () => {
    const { cprScanJob } = await import('../src/scraper/jobs/cprScan.js')
    const result = await cprScanJob(deps())

    const cpr = await stack.db.query(
      `SELECT member_id, crime_name, position_label, difficulty, cpr_value, observation_count
       FROM member_cpr_v2 ORDER BY member_id, position_label`
    )
    expect(cpr.rows).toEqual([
      { member_id: '800', crime_name: 'Break the Bank', position_label: 'Hacker', difficulty: 8, cpr_value: 68, observation_count: 1 },
      { member_id: '800', crime_name: 'Break the Bank', position_label: 'Robber', difficulty: 8, cpr_value: 72, observation_count: 1 },
      // From the faction scan's filled slot — attributed to the slotted user.
      { member_id: '801', crime_name: 'Break the Bank', position_label: 'Robber', difficulty: 8, cpr_value: 65, observation_count: 1 },
    ])

    // Crime type + positions registered.
    const types = await stack.db.query(`SELECT name, difficulty FROM oc_crime_types`)
    expect(types.rows).toEqual([{ name: 'Break the Bank', difficulty: 8 }])
    const positions = await stack.db.query(
      `SELECT position_label, position_id FROM oc_crime_positions WHERE crime_name = 'Break the Bank' ORDER BY position_label`
    )
    // Note: the faction scan's empty Muscle slot is unattributable (faction
    // key, no owner) so — matching the Python original — it produces no
    // entry and its position is never registered.
    expect(positions.rows).toEqual([
      { position_label: 'Hacker', position_id: 'BTB-H1' },
      { position_label: 'Robber', position_id: 'BTB-R1' },
    ])

    // Key B failed → out of the rotation, reason recorded.
    const disabled = await stack.db.query(`SELECT disabled, last_error FROM member_secrets WHERE member_id = '801'`)
    expect(disabled.rows[0].disabled).toBe(true)
    expect(disabled.rows[0].last_error).toContain('Incorrect key')

    expect(result.details).toMatchObject({ members_scraped: 1, keys_invalidated: 1 })
  })

  it('re-scans update the value and increment observation_count, keeping first_seen_at', async () => {
    const before = await stack.db.query(
      `SELECT first_seen_at FROM member_cpr_v2 WHERE member_id = '800' AND position_label = 'Robber'`
    )
    robberCpr = 74

    const { cprScanJob } = await import('../src/scraper/jobs/cprScan.js')
    await cprScanJob(deps())

    const row = await stack.db.query(
      `SELECT cpr_value, observation_count, first_seen_at, last_seen_at
       FROM member_cpr_v2 WHERE member_id = '800' AND position_label = 'Robber'`
    )
    expect(row.rows[0].cpr_value).toBe(74)
    expect(row.rows[0].observation_count).toBe(2)
    expect(row.rows[0].first_seen_at).toBe(before.rows[0].first_seen_at)
  })
})

describe('inventory sync job', () => {
  it('fetches the faction inventory with a pooled key and upserts inventory_items + sync_metadata', async () => {
    // v1 faction endpoint keyed by the seeded faction id, one category per key.
    stack.torn.setHandler(`/faction/${TEST_FACTION.tornFactionId}`, () => ({
      drugs: [
        { ID: 206, name: 'Xanax', quantity: 40, available: 38, loaned: 2, loaned_to: '801', type: 'Drug' },
        // Missing name/quantity → defaults ("Item {ID}", 0).
        { ID: 197 },
      ],
      armor: [
        { ID: 640, name: 'Riot Helmet', quantity: 5, available: 5, loaned: 0, loaned_to: null, type: 'Defensive' },
      ],
    }))

    const { inventorySyncJob } = await import('../src/scraper/jobs/inventorySync.js')
    const result = await inventorySyncJob(deps())
    expect(result.rows).toBe(3)

    const rows = await stack.db.query(`SELECT * FROM inventory_items ORDER BY id`)
    expect(rows.rows).toHaveLength(3)
    expect(rows.rows.find((r) => r.id === '206')).toMatchObject({
      name: 'Xanax', quantity: 40, available: 38, loaned: 2, loaned_to: '801',
      api_type: 'Drug', category: 'drugs',
    })
    // Missing fields default the Python/manual-sync way.
    expect(rows.rows.find((r) => r.id === '197')).toMatchObject({
      name: 'Item 197', quantity: 0, available: 0, loaned: 0, category: 'drugs',
    })

    // sync_metadata records the inventory sync so the Leadership page's
    // "last synced" reads the same whether cron or a manual sync wrote it.
    const meta = await stack.db.query(`SELECT synced_by FROM sync_metadata WHERE data_type = 'inventory'`)
    expect(meta.rows).toHaveLength(1)
    expect(meta.rows[0].synced_by).toBe('scraper')
  })
})

// #247: a failure part-way through the crimes backlog must not throw away the
// pages already fetched — crimes-sync commits per page, so an error on a later
// page leaves the earlier pages persisted for the next run to resume from.
describe('crimes sync job — incremental persistence on failure', () => {
  it('persists earlier pages when a later page fails mid-pagination', async () => {
    // Clean slate so the cursor starts at 0 and page sizes are predictable.
    await stack.db.query('DELETE FROM crime_required_items')
    await stack.db.query('DELETE FROM crime_reward_items')
    await stack.db.query('DELETE FROM crime_slots')
    await stack.db.query('DELETE FROM crime_participation_v2')
    await stack.db.query('DELETE FROM crimes')

    // Page 1 (from=0) returns a full 100 crimes; the next page (from=1100)
    // rate-limits. The current all-in-one-transaction code loses everything;
    // per-page commits keep page 1.
    stack.torn.setHandler('/v2/faction/crimes', (url) => {
      const from = Number(url.searchParams.get('from') ?? 0)
      if (from === 0) {
        return { crimes: Array.from({ length: 100 }, (_, i) => plainCrime(i + 1)) }
      }
      return { error: { code: 5, error: 'Too many requests' } }
    })

    const { crimesSyncJob } = await import('../src/scraper/jobs/crimesSync.js')
    await expect(crimesSyncJob(deps())).rejects.toThrow()

    // Page 1's 100 crimes survived the later failure.
    const count = await stack.db.query('SELECT count(*)::int AS n FROM crimes')
    expect(count.rows[0].n).toBe(100)
  })
})
