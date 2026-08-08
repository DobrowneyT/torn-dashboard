// Live energy + drug/medical/booster cooldowns for OUR OWN members (#336).
//
// Torn exposes `bars` and `cooldowns` as SELF-only selections — there is no
// /v2/user/{id} variant for either, unlike profile or personalstats. So the
// only route to a teammate's energy is a call made with that teammate's own
// key, one call per member per cycle. (YATA reaches the same conclusion; see
// the issue for the comparison.) Both selections need only `minimal` access
// and our enrolment floor is Limited, so every pooled key qualifies.
//
// This module is the pure half: response parsing, the overdose derivation, and
// the cadence gate. The loop that spends the keys lives in warRoomTicker.

import type pg from 'pg'

/** One member's stored live stats. Every field is nullable — a key can fail. */
export interface MemberStats {
  energy_current: number | null
  energy_maximum: number | null
  cooldown_drug: number | null
  cooldown_medical: number | null
  cooldown_booster: number | null
}

/**
 * Overdose threshold, in seconds of remaining DRUG cooldown.
 *
 * Torn has no "is overdosed" flag anywhere in the API — `overdoses` exists only
 * as a lifetime counter under personalstats, which cannot answer "right now".
 * But an overdose leaves a drug cooldown far longer than any normal dose: a
 * xanax tops out around 8h, so anything past 10h is unambiguous.
 */
export const OVERDOSE_DRUG_CD_SEC = 36_000

/** Hard floor on the poll cadence — one Torn call per enrolled member per cycle. */
export const MEMBER_STATS_MIN_INTERVAL_SEC = 30

function num(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/**
 * Pull the fields we keep out of a /v2/user?selections=bars,cooldowns body.
 *
 * `bars` also returns nerve, happy and life. We deliberately drop them: they
 * are personal data with no war-room use, and the narrower the stored set, the
 * smaller the disclosure. Job perks (YATA's revive-ability flag) are dropped
 * for the same reason plus a practical one — outside revivers get hired, so a
 * teammate's revive ability never enters war planning.
 */
export function parseMemberStats(body: unknown): MemberStats {
  const b = (body ?? {}) as Record<string, any>
  // v2 nests the bars under `bars` (energy/nerve/happy/life/chain) but returns
  // `cooldowns` at the TOP level — an asymmetry that is easy to miss, and did
  // bite: this originally read `b.energy`, copied from YATA's v1 code where
  // selections are flattened. Cooldowns worked, energy silently came back
  // empty. The `?? b.energy` fallback keeps the flattened shape working.
  const bars = (b.bars ?? {}) as Record<string, any>
  const energy = (bars.energy ?? b.energy ?? {}) as Record<string, unknown>
  const cooldowns = (b.cooldowns ?? bars.cooldowns ?? {}) as Record<string, unknown>
  return {
    energy_current: num(energy.current),
    energy_maximum: num(energy.maximum),
    cooldown_drug: num(cooldowns.drug),
    cooldown_medical: num(cooldowns.medical),
    cooldown_booster: num(cooldowns.booster),
  }
}

/** Is this drug cooldown long enough to mean an overdose rather than a dose? */
export function isOverdosed(drugCooldownSec: number | null | undefined): boolean {
  const n = num(drugCooldownSec)
  if (n === null) return false
  return n > OVERDOSE_DRUG_CD_SEC
}

/**
 * Is a member-stats sweep due?
 *
 * 0 means OFF and must win over any staleness — otherwise "disabled" would
 * still fire a full per-member sweep on the first tick after a restart.
 */
export function memberStatsPollDue(
  lastFetchedEpochSec: number | null | undefined,
  intervalSec: number,
  nowMs: number
): boolean {
  const interval = Number(intervalSec)
  if (!Number.isFinite(interval) || interval <= 0) return false
  const last = Number(lastFetchedEpochSec)
  if (lastFetchedEpochSec == null || !Number.isFinite(last)) return true
  return nowMs / 1000 - last >= Math.max(MEMBER_STATS_MIN_INTERVAL_SEC, interval)
}

/** The one Torn call this feature makes, per member, with that member's key. */
export const MEMBER_STATS_PATH = '/v2/user?selections=bars,cooldowns'

interface StatsFetcher {
  fetch(path: string, key: string): Promise<unknown>
}

interface OwnedKey {
  member_id: string
  key: string
}

/**
 * Sweep every enrolled member's own key once and persist the results.
 *
 * Sequential on purpose: this walks the whole roster, and firing N concurrent
 * requests would spike Torn traffic in a burst at the top of each cycle for no
 * benefit — the cadence floor gives us a whole 30s to finish in.
 *
 * A failing key is recorded (last_error) rather than thrown: one member with a
 * revoked key must not cost everyone else their stats. fetched_at advances on
 * failure too, since it means "when we last tried" — otherwise a roster of
 * broken keys would re-sweep on every single tick.
 */
export async function sweepMemberStats(
  db: pg.Pool,
  client: StatsFetcher,
  keys: OwnedKey[]
): Promise<unknown[]> {
  const changed: unknown[] = []
  for (const { member_id, key } of keys) {
    let stats: MemberStats = {
      energy_current: null, energy_maximum: null,
      cooldown_drug: null, cooldown_medical: null, cooldown_booster: null,
    }
    let lastError: string | null = null
    try {
      stats = parseMemberStats(await client.fetch(MEMBER_STATS_PATH, key))
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }

    const res = await db.query(
      `INSERT INTO war_room_member_stats_v2
         (member_id, energy_current, energy_maximum,
          cooldown_drug, cooldown_medical, cooldown_booster,
          last_error, fetched_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
       ON CONFLICT (member_id) DO UPDATE SET
         energy_current = EXCLUDED.energy_current,
         energy_maximum = EXCLUDED.energy_maximum,
         cooldown_drug = EXCLUDED.cooldown_drug,
         cooldown_medical = EXCLUDED.cooldown_medical,
         cooldown_booster = EXCLUDED.cooldown_booster,
         last_error = EXCLUDED.last_error,
         fetched_at = EXCLUDED.fetched_at,
         updated_at = now()
       RETURNING *`,
      [member_id, stats.energy_current, stats.energy_maximum,
       stats.cooldown_drug, stats.cooldown_medical, stats.cooldown_booster, lastError]
    )
    if (res.rows.length > 0) changed.push(res.rows[0])
  }
  return changed
}

/**
 * Members who left the roster (or revoked their key) keep stale energy on the
 * board forever otherwise. Hard-deletes rather than tombstones: this table
 * carries no history worth keeping, and a delta client treats an absent row as
 * "no data" already.
 */
export async function pruneMemberStats(db: pg.Pool, keepMemberIds: string[]): Promise<void> {
  await db.query(
    'DELETE FROM war_room_member_stats_v2 WHERE NOT (member_id = ANY($1))',
    [keepMemberIds]
  )
}
