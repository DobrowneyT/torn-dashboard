// CPR scan — port of scripts/cpr_scraper.py (v2, DB-native). Two stages:
//   1. Faction available-crimes scan with a rotation-claimed key — filled
//      slots carry the slotted user's CPR (empty slots have no owner to
//      attribute to and are skipped).
//   2. Per-member user/organizedcrimes with THAT member's own key — Torn
//      reports the key owner's CPR on empty slots, so every slot is
//      attributed to the key owner; filled slots to the slotted user.
// Merge semantics: register crime types/positions; per (member, crime,
// position) the value is replaced, observation_count increments, and
// first_seen_at is kept. A key that fails leaves the rotation with the
// reason recorded (the member re-submits from the dashboard).
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { TornApiError } from '../tornClient.js'

interface CprEntry {
  member_id: string
  crime_name: string
  difficulty: number | null
  position_label: string
  position_id: string | null
  cpr_value: number
}

function extractEntries(crimes: any[], memberIdContext: string | null): CprEntry[] {
  const entries: CprEntry[] = []
  for (const crime of crimes ?? []) {
    for (const slot of crime.slots ?? []) {
      const cpr = slot.checkpoint_pass_rate
      if (cpr == null) continue
      const pi = slot.position_info ?? {}
      const user = slot.user
      let attributedTo: string | null = null
      if (user?.id != null) attributedTo = String(user.id)
      else if (memberIdContext !== null) attributedTo = memberIdContext
      if (attributedTo === null) continue
      entries.push({
        member_id: attributedTo,
        crime_name: crime.name ?? 'Unknown',
        difficulty: crime.difficulty ?? null,
        position_label: pi.label ?? slot.position ?? 'Unknown',
        position_id: pi.id ?? slot.position_id ?? null,
        cpr_value: cpr,
      })
    }
  }
  return entries
}

export async function cprScanJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const entries: CprEntry[] = []

  // Stage 1: faction available-crimes scan (filled-slot CPR).
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')
  const factionScan = await client.fetch(
    '/v2/faction/crimes?cat=available&filters=created_at&offset=0&sort=DESC',
    claimed.key
  )
  entries.push(...extractEntries(factionScan.crimes ?? [], null))

  // Stage 2: per-member scan with each member's own key.
  let membersScraped = 0
  let keysInvalidated = 0
  for (const { member_id, key } of await pool.listKeys()) {
    try {
      const res = await client.fetch('/v2/user/organizedcrimes', key)
      entries.push(...extractEntries(res.organizedcrimes ?? [], member_id))
      membersScraped += 1
    } catch (err) {
      if (err instanceof TornApiError) {
        await pool.disable(member_id, err.message)
        keysInvalidated += 1
      } else {
        throw err
      }
    }
  }

  // Merge into the three v2 tables.
  let rows = 0
  const dbc = await db.connect()
  try {
    await dbc.query('BEGIN')
    for (const e of entries) {
      await dbc.query(
        `INSERT INTO oc_crime_types (name, difficulty) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET difficulty = EXCLUDED.difficulty`,
        [e.crime_name, e.difficulty]
      )
      await dbc.query(
        `INSERT INTO oc_crime_positions (crime_name, position_label, position_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (crime_name, position_label) DO NOTHING`,
        [e.crime_name, e.position_label, e.position_id]
      )
      await dbc.query(
        `INSERT INTO member_cpr_v2 (member_id, crime_name, position_label, difficulty, cpr_value)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (member_id, crime_name, position_label) DO UPDATE SET
           cpr_value = EXCLUDED.cpr_value, difficulty = EXCLUDED.difficulty,
           observation_count = member_cpr_v2.observation_count + 1,
           last_seen_at = now()`,
        [e.member_id, e.crime_name, e.position_label, e.difficulty, e.cpr_value]
      )
      rows += 1
    }
    await dbc.query('COMMIT')
  } catch (err) {
    await dbc.query('ROLLBACK')
    throw err
  } finally {
    dbc.release()
  }

  return { rows, details: { members_scraped: membersScraped, keys_invalidated: keysInvalidated } }
}
