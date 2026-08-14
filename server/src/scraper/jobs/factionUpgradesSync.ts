// Faction upgrades snapshot (#395 / #458): one row per day from
// `GET /faction/upgrades`, so the calendar can show what Steadfast was
// actually giving on a given date.
//
// ⚠️ Snapshotted, not overwritten. A single current-state row would be less
// code and would make the calendar lie — repainted nightly, it would show
// today's percentages across all of last month. Perks change on the order of
// weeks, so a daily row is both cheap (one call) and enough resolution to catch
// the day an upgrade lands.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { readSteadfast, readBranchState } from '../../factionUpgrades.js'

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

export async function factionUpgradesSyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const payload = await client.fetch('/v2/faction/upgrades', claimed.key)
  // ⚠️ An empty response must not overwrite a good snapshot with an empty one.
  // A faction with no upgrades is a real state, but so is a call that came back
  // wrong, and only one of them should replace today's row.
  if (!payload?.upgrades) {
    return { rows: 0, details: { note: 'no upgrades in response — left today\'s snapshot alone' } }
  }

  const steadfast = readSteadfast(payload)
  await db.query(
    `INSERT INTO faction_upgrade_snapshots
       (snapshot_date, branch_state, steadfast_strength, steadfast_defense,
        steadfast_speed, steadfast_dexterity, steadfast_unparsed, payload, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (snapshot_date) DO UPDATE SET
       branch_state = EXCLUDED.branch_state,
       steadfast_strength = EXCLUDED.steadfast_strength,
       steadfast_defense = EXCLUDED.steadfast_defense,
       steadfast_speed = EXCLUDED.steadfast_speed,
       steadfast_dexterity = EXCLUDED.steadfast_dexterity,
       steadfast_unparsed = EXCLUDED.steadfast_unparsed,
       payload = EXCLUDED.payload,
       fetched_at = now()`,
    [
      isoDate(new Date()),
      readBranchState(payload),
      steadfast.strength, steadfast.defense, steadfast.speed, steadfast.dexterity,
      JSON.stringify(steadfast.unparsed),
      JSON.stringify(payload),
    ]
  )

  return {
    rows: 1,
    details: {
      branch_state: readBranchState(payload),
      steadfast,
    },
  }
}
