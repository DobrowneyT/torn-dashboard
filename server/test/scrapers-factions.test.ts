// Faction-name backfill (restores the old sync's _backfill_factions step): the
// job resolves faction ids referenced by attacks that we don't yet have a name
// for, via /v2/faction/{id}/basic, and upserts the `factions` lookup table so
// the payout opposing-faction filter shows real names instead of "Faction #id".
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'
import { factionsSyncJob } from '../src/scraper/jobs/factionsSync.js'

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
  await stack.db.query(`INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('800', 'KeyOwner', 3, true)`)
  const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
  await pool.store('800', 'FACTIONKEY800AAA', { keyLevel: 3, consentVersion: 'v2' })

  // 111 is already known; 222 (good), 333 (no name), 444 (disbanded/error) are
  // referenced by attacks but missing from `factions`.
  await stack.db.query(`INSERT INTO factions (id, name, tag) VALUES (111, 'Known Faction', 'KNW')`)
  await stack.db.query(`
    INSERT INTO faction_attacks (attack_id, started, attacker_id, attacker_faction_id, defender_id, defender_faction_id, result, is_incoming) VALUES
      (1, 1000, 10, 111, 20, 222, 'Attacked', false),
      (2, 1001, 11, 222, 21, 333, 'Lost',     false),
      (3, 1002, 12, 333, 22, 444, 'Assist',   false)
  `)

  stack.torn.setPath('/v2/faction/222/basic', { basic: { id: 222, name: 'Phoenix Nirvana', tag: 'PN' } })
  stack.torn.setPath('/v2/faction/333/basic', { basic: { id: 333 } })                 // no name → skipped
  stack.torn.setPath('/v2/faction/444/basic', { error: { code: 6, error: 'Incorrect ID' } }) // disbanded → skipped, batch survives
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('factions sync job', () => {
  it('backfills missing faction names referenced by attacks and leaves known ones alone', async () => {
    const result = await factionsSyncJob(deps())
    // Only 222 resolved to a real name; 333 (no name) and 444 (error) are skipped
    // without aborting the batch.
    expect(result.rows).toBe(1)

    const rows = await stack.db.query('SELECT id, name, tag FROM factions ORDER BY id')
    expect(rows.rows).toEqual([
      { id: 111, name: 'Known Faction', tag: 'KNW' },  // untouched
      { id: 222, name: 'Phoenix Nirvana', tag: 'PN' }, // newly backfilled
    ])
  })

  it('is a no-op once every referenced faction is known', async () => {
    // 333/444 stay unresolved but are not retried into a name; 222 is now known
    // (name + tag) — so a second run resolves nothing new.
    const result = await factionsSyncJob(deps())
    expect(result.rows).toBe(0)
  })

  it('fills the tag for a name-only faction and marks a genuinely tagless one resolved', async () => {
    // attacks-sync leaves referenced factions present-by-name with a NULL tag;
    // factions-sync completes them. 555 has a tag; 666 genuinely has none.
    await stack.db.query(`INSERT INTO factions (id, name) VALUES (555, 'Named Only'), (666, 'Tagless')`)
    await stack.db.query(`
      INSERT INTO faction_attacks (attack_id, started, attacker_id, attacker_faction_id, defender_id, defender_faction_id, result, is_incoming) VALUES
        (4, 1003, 13, 555, 23, 666, 'Attacked', false)
    `)
    stack.torn.setPath('/v2/faction/555/basic', { basic: { id: 555, name: 'Named Only', tag: 'NOU' } })
    stack.torn.setPath('/v2/faction/666/basic', { basic: { id: 666, name: 'Tagless' } }) // no tag in response

    const result = await factionsSyncJob(deps())
    expect(result.rows).toBe(2)
    const rows = await stack.db.query('SELECT id, name, tag FROM factions WHERE id IN (555, 666) ORDER BY id')
    expect(rows.rows).toEqual([
      { id: 555, name: 'Named Only', tag: 'NOU' },
      { id: 666, name: 'Tagless', tag: '' },  // resolved to empty-string, not NULL
    ])

    // Second run: 666's '' tag reads as resolved, so it isn't re-fetched.
    const again = await factionsSyncJob(deps())
    expect(again.rows).toBe(0)
  })
})
