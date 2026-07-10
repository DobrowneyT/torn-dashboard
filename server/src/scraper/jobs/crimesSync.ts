// Crimes sync — port of scripts/daily_crime_update.py (fetch/pagination/
// incremental-start semantics) collapsed with sync_to_supabase.py's
// sync_crimes_data (row shapes for the four crime tables). The Python pair
// remains in-repo as the executable reference spec.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

const PAGE_FULL = 100

/**
 * Incremental start: the oldest crime that hasn't executed yet (so its
 * status/slots keep updating), else the newest created_at (check for new
 * spawns only), else 0 (empty DB — fetch all history).
 */
async function fetchStartTimestamp(db: JobDeps['db']): Promise<number> {
  const incomplete = await db.query(
    'SELECT min(created_at) AS ts FROM crimes WHERE executed_at IS NULL'
  )
  if (incomplete.rows[0].ts != null) return Number(incomplete.rows[0].ts)
  const newest = await db.query('SELECT max(created_at) AS ts FROM crimes')
  return newest.rows[0].ts != null ? Number(newest.rows[0].ts) : 0
}

export async function crimesSyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  // Paginate: keep going while a page comes back exactly full, resuming from
  // the last crime's created_at (pages overlap by design; dedupe by id).
  const all = new Map<number, any>()
  let from = await fetchStartTimestamp(db)
  for (;;) {
    const data = await client.fetch(
      `/v2/faction/crimes?cat=all&filters=created_at&from=${from}&sort=ASC`,
      claimed.key
    )
    const crimes: any[] = data.crimes ?? []
    if (crimes.length === 0) break
    for (const c of crimes) all.set(c.id, c)
    if (crimes.length < PAGE_FULL) break
    from = crimes[crimes.length - 1].created_at
  }

  let rows = 0
  const dbc = await db.connect()
  try {
    await dbc.query('BEGIN')
    for (const crime of all.values()) {
      const crimeId = String(crime.id)
      const slots: any[] = crime.slots ?? []
      const rewards = crime.rewards ?? {}
      const rewardItems: any[] = rewards.items ?? []
      const filled = slots.filter((s) => s.user).length

      await dbc.query(
        `INSERT INTO crimes (crime_id, name, difficulty, status, previous_crime_id,
           created_at, planning_at, executed_at, ready_at, expired_at,
           total_slots, filled_slots, rewards_money, rewards_respect, rewards_items,
           last_updated, first_seen, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 now()::text, now()::text, now())
         ON CONFLICT (crime_id) DO UPDATE SET
           name = EXCLUDED.name, difficulty = EXCLUDED.difficulty, status = EXCLUDED.status,
           previous_crime_id = EXCLUDED.previous_crime_id, created_at = EXCLUDED.created_at,
           planning_at = EXCLUDED.planning_at, executed_at = EXCLUDED.executed_at,
           ready_at = EXCLUDED.ready_at, expired_at = EXCLUDED.expired_at,
           total_slots = EXCLUDED.total_slots, filled_slots = EXCLUDED.filled_slots,
           rewards_money = EXCLUDED.rewards_money, rewards_respect = EXCLUDED.rewards_respect,
           rewards_items = EXCLUDED.rewards_items,
           last_updated = now()::text, updated_at = now()`,
        [crimeId, crime.name ?? 'Unknown', crime.difficulty ?? 1, crime.status ?? 'Unknown',
         crime.previous_crime_id != null ? String(crime.previous_crime_id) : null,
         crime.created_at, crime.planning_at, crime.executed_at, crime.ready_at, crime.expired_at,
         slots.length, filled, rewards.money ?? 0, rewards.respect ?? 0,
         rewardItems.length > 0 ? JSON.stringify(rewardItems) : null]
      )
      rows += 1

      for (const slot of slots) {
        const user = slot.user ?? {}
        const itemReq = slot.item_requirement ?? {}
        const pi = slot.position_info ?? {}
        const itemOutcome = user.item_outcome ?? {}
        const positionId = pi.id ?? slot.position_id

        await dbc.query(
          `INSERT INTO crime_slots (crime_id, "position", position_id, position_number,
             checkpoint_pass_rate, user_id, user_name, joined_at, user_outcome, user_progress,
             item_requirement_id, item_requirement_name, item_requirement_is_reusable,
             item_requirement_is_available, item_outcome_id, item_outcome_outcome, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
           ON CONFLICT (crime_id, position_id) DO UPDATE SET
             "position" = EXCLUDED.position, position_number = EXCLUDED.position_number,
             checkpoint_pass_rate = EXCLUDED.checkpoint_pass_rate, user_id = EXCLUDED.user_id,
             user_name = EXCLUDED.user_name, joined_at = EXCLUDED.joined_at,
             user_outcome = EXCLUDED.user_outcome, user_progress = EXCLUDED.user_progress,
             item_requirement_id = EXCLUDED.item_requirement_id,
             item_requirement_name = EXCLUDED.item_requirement_name,
             item_requirement_is_reusable = EXCLUDED.item_requirement_is_reusable,
             item_requirement_is_available = EXCLUDED.item_requirement_is_available,
             item_outcome_id = EXCLUDED.item_outcome_id,
             item_outcome_outcome = EXCLUDED.item_outcome_outcome, updated_at = now()`,
          [crimeId, slot.position, positionId, pi.number ?? slot.position_number,
           slot.checkpoint_pass_rate, user.id != null ? String(user.id) : null, user.name ?? null,
           user.joined_at ?? null, user.outcome ?? null, user.progress ?? null,
           itemReq.id != null ? String(itemReq.id) : null, itemReq.name ?? null,
           itemReq.is_reusable ?? false, itemReq.is_available ?? false,
           itemOutcome.item_id != null ? String(itemOutcome.item_id) : null,
           itemOutcome.outcome ?? null]
        )

        if (itemReq.id != null) {
          const wasConsumed = itemOutcome.outcome === 'used' || itemOutcome.outcome === 'lost'
          await dbc.query(
            `INSERT INTO crime_required_items (crime_id, "position", position_id, position_number,
               item_id, item_name, is_reusable, is_available, user_id, outcome_owned_by,
               outcome_item_id, outcome_item_uid, outcome, was_consumed, unit_value, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, now(), now())
             ON CONFLICT (crime_id, position_id) DO UPDATE SET
               "position" = EXCLUDED.position, position_number = EXCLUDED.position_number,
               item_id = EXCLUDED.item_id, item_name = EXCLUDED.item_name,
               is_reusable = EXCLUDED.is_reusable, is_available = EXCLUDED.is_available,
               user_id = EXCLUDED.user_id, outcome_owned_by = EXCLUDED.outcome_owned_by,
               outcome_item_id = EXCLUDED.outcome_item_id, outcome_item_uid = EXCLUDED.outcome_item_uid,
               outcome = EXCLUDED.outcome, was_consumed = EXCLUDED.was_consumed, updated_at = now()`,
            [crimeId, slot.position, positionId, pi.number ?? slot.position_number,
             String(itemReq.id), itemReq.name ?? null, itemReq.is_reusable ?? false,
             itemReq.is_available ?? false, user.id != null ? String(user.id) : null,
             itemOutcome.owned_by != null ? String(itemOutcome.owned_by) : null,
             itemOutcome.item_id != null ? String(itemOutcome.item_id) : null,
             itemOutcome.item_uid != null ? String(itemOutcome.item_uid) : null,
             itemOutcome.outcome ?? null, wasConsumed]
          )
        }
      }

      for (const item of rewardItems) {
        if (item.id == null) continue
        // Torn lists qty=0 "potential drops" the crime could have produced
        // but didn't — skip them (mirrors sync_to_supabase + admin-db).
        const qty = Number(item.quantity) || 0
        if (qty <= 0) continue
        await dbc.query(
          `INSERT INTO crime_reward_items (crime_id, item_id, item_name, quantity,
             unit_value, total_value, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 0, 0, now(), now())
           ON CONFLICT (crime_id, item_id) DO UPDATE SET
             item_name = EXCLUDED.item_name, quantity = EXCLUDED.quantity, updated_at = now()`,
          [crimeId, String(item.id), item.name ?? null, qty]
        )
      }
    }
    await dbc.query('COMMIT')
  } catch (err) {
    await dbc.query('ROLLBACK')
    throw err
  } finally {
    dbc.release()
  }

  return { rows, details: { pages: undefined, fetched: all.size } }
}
