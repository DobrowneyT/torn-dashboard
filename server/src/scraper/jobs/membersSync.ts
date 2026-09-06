// Faction members sync — port of cpr_scraper.py's _sync_members_to_supabase
// + _reconcile_key_pool. Marks everyone not in the fresh roster as left
// (rows are history, never deleted), upserts current members, and keeps the
// consented key pool aligned with membership: leavers' keys drop out of
// rotation, rejoiners' keys come back in (claim-time validation still
// guards a stale key).
//
// #284: also captures the roster's lifetime `days_in_faction` onto
// members.total_days_in_faction, and maintains member_faction_stints — one
// open stint per current member — so the days-in-faction streak can be derived.
//
// #309: after the reconcile it also re-verifies every enrolled key against
// /v2/key/info, so a member who enrolled while still a Recruit (no faction
// API access) joins the pool within an hour of Torn promoting them — no
// re-login needed — and a key that lost access (or died) drops back out.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { TornApiError } from '../tornClient.js'

// A snapshot gap larger than this many days reads as an absence when seeding a
// new stint's start from history; ≤ this tolerates brief job downtime.
const STINT_GAP_DAYS = 2

// Torn key errors that mean the key itself is unusable, not "try again later":
// 2 incorrect key, 7 insufficient permissions, 13 disabled for owner
// inactivity, 16 access level too low, 18 paused by the owner. Anything else
// (the transient 5/8/9/17 set, an unknown code, a network blip) leaves the key
// alone — wrongly dropping a donor's key out of the pool is the worse failure.
const FATAL_KEY_CODES = new Set([2, 7, 13, 16, 18])

// Surfaced as the run's `details` in Global Admin → Recent Runs.
export type ReverifyCounts = {
  keys_checked: number
  keys_promoted: number
  keys_revoked: number
  keys_disabled: number
  keys_unverified: number
}

/**
 * Re-verify every enrolled, non-disabled key with its OWN key (so this costs
 * the shared pool budget nothing and can't rate-limit a single key). Runs
 * after the roster reconcile — which re-enables a current member's key — so a
 * key that is still broken ends the run disabled again. Best-effort per key:
 * one failure never aborts the rest.
 */
async function reverifyPooledKeys({ pool, client }: JobDeps): Promise<ReverifyCounts> {
  const counts: ReverifyCounts = {
    keys_checked: 0, keys_promoted: 0, keys_revoked: 0, keys_disabled: 0, keys_unverified: 0,
  }
  const keys = await pool.listAllKeys()
  for (const row of keys) {
    counts.keys_checked += 1
    try {
      const data = await client.fetch('/v2/key/info', row.key)
      const info = data?.info ?? {}
      const ownerId = info.user?.id == null ? null : String(info.user.id)
      if (ownerId !== null && ownerId !== String(row.member_id)) {
        // Mirrors the login-time wrong-account check: the stored key no longer
        // belongs to the member we attribute it to.
        await pool.disable(row.member_id, `key now belongs to Torn user ${ownerId}, not ${row.member_id}`)
        counts.keys_disabled += 1
        continue
      }
      const hasFactionAccess = info.access?.faction === true
      const keyLevel = info.access?.level == null ? null : Number(info.access.level)
      await pool.setAccess(row.member_id, { hasFactionAccess, keyLevel })
      if (hasFactionAccess && row.has_faction_access === false) counts.keys_promoted += 1
      if (!hasFactionAccess && row.has_faction_access === true) counts.keys_revoked += 1
    } catch (err) {
      if (err instanceof TornApiError && FATAL_KEY_CODES.has(err.tornCode)) {
        // A write failure here must not abort the remaining keys either.
        try {
          await pool.disable(row.member_id, err.message)
          counts.keys_disabled += 1
        } catch { counts.keys_unverified += 1 }
      } else {
        // Transient: leave the row exactly as it is and retry next run.
        counts.keys_unverified += 1
      }
    }
  }
  return counts
}

// Infer the current stint's joined_at for a member we're first opening a stint
// for. If they have a run of recent daily snapshots (the stats/profile jobs only
// snapshot current members), walk back the most recent contiguous run and use
// its start. A stale-or-absent newest snapshot means a fresh join/rejoin ⇒ now.
async function seedJoinedAt(dbc: any, memberId: string): Promise<Date> {
  const now = new Date()
  const res = await dbc.query(
    `SELECT snapshot_date::text AS d FROM member_daily_stats
     WHERE member_id = $1 ORDER BY snapshot_date DESC`,
    [memberId]
  )
  if (res.rows.length === 0) return now
  const dayMs = 86400_000
  const toDate = (s: string) => new Date(`${s}T00:00:00Z`)
  const dates = res.rows.map((r: { d: string }) => toDate(r.d))
  if (now.getTime() - dates[0].getTime() > STINT_GAP_DAYS * dayMs) return now
  let start = dates[0]
  for (let i = 1; i < dates.length; i++) {
    if (dates[i - 1].getTime() - dates[i].getTime() <= STINT_GAP_DAYS * dayMs) start = dates[i]
    else break
  }
  return start
}

/**
 * ⚠️ How much of the roster one run may retire before it is treated as a bad
 * fetch rather than a real event.
 *
 * On 2026-08-24 capacityx retired 95 of 96 members in a single run (#645). No
 * faction empties in an hour; a roster that says so is describing a different
 * faction. This needs no extra API call and is the last line if the identity
 * check below is ever bypassed.
 */
export const MAX_ROSTER_RETIREMENT = 0.5

/**
 * Below this many held members the retirement guard does not apply.
 *
 * ⚠️ A three-member faction losing two is 67% and entirely plausible. The guard
 * is about implausible SCALE, and scale needs a denominator worth dividing by —
 * without this floor a small or newly-provisioned faction could never sync
 * through an ordinary departure.
 */
export const MIN_ROSTER_FOR_RETIREMENT_GUARD = 20

export async function membersSyncJob(deps: JobDeps): Promise<RunResult> {
  const { db, pool, client } = deps
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  // ⚠️ **Verify the key still belongs to OUR faction before trusting anything
  // it returns.** This is #645, and it cost capacityx thirteen days.
  //
  // A Torn key answers for its owner's CURRENT faction. When a member leaves,
  // their key stays in the pool until something notices — and the round-robin
  // will eventually claim it. `/v2/faction/members` then returns THEIR NEW
  // FACTION'S roster, which this job wrote as ours: 95 real members marked
  // departed, 31 strangers inserted, and every real key disabled as "not in
  // faction". With the pool empty, the only job that could re-enable them is
  // this one, which needs a key from the pool it just emptied.
  //
  // ⚠️ The obvious cheaper check — "the key owner must appear in the roster" —
  // does NOT catch this, and it is worth saying so because it looks sufficient.
  // The departed member IS in the roster their key returned; it is their new
  // faction's. Only the faction ID distinguishes the two.
  //
  // One extra call per hourly run, against thirteen days of every scraper
  // failing in silence.
  const usRow = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
  const us = usRow.rows[0]?.torn_faction_id == null ? null : String(usRow.rows[0].torn_faction_id)

  if (us !== null) {
    // ⚠️ Fails OPEN on a transient error, CLOSED on a definite mismatch.
    //
    // Refusing to sync whenever /v2/faction/basic is unavailable would let a
    // Torn hiccup stop member syncing fleet-wide — trading a rare, guarded
    // failure for a frequent unguarded one. The two guards below need no API
    // call and still stand, so an unverifiable run is degraded rather than
    // dangerous. A run that positively KNOWS the id differs is a different
    // matter and stops.
    let theirs: string | null = null
    try {
      const basic = await client.fetch('/v2/faction/basic', claimed.key)
      theirs = basic?.basic?.id == null ? null : String(basic.basic.id)
    } catch (err) {
      console.warn(
        `[members-sync] could not verify the key's faction (${err instanceof Error ? err.message : String(err)}) ` +
        '— proceeding on the roster-retirement and key-pool guards alone'
      )
    }
    if (theirs !== null && theirs !== us) {
      // ⚠️ Disable THAT ONE KEY, not the ninety-five members it would have
      // retired. The key is the thing that is wrong.
      const reason = `key owner is now in faction ${theirs}, not ${us} — left the faction`
      await pool.disable(claimed.member_id, reason)
      throw new Error(
        `refusing to sync: ${reason}. The key has been disabled; the roster was not touched.`
      )
    }
  }

  const data = await client.fetch('/v2/faction/members', claimed.key)
  const roster: Array<{
    id: number; name: string; days_in_faction?: number
    status?: { state?: string } | null
  }> = data.members ?? []
  if (roster.length === 0) throw new Error('Torn returned an empty roster — refusing to mark everyone as left')

  const dbc = await db.connect()
  try {
    await dbc.query('BEGIN')

    // ⚠️ **Refuse a run that would retire most of the faction** (#645).
    //
    // Independent of the identity check above and deliberately so: that one
    // needs an API call and a configured faction id, this one needs neither.
    // No faction loses half its members in an hour — a roster saying so is
    // describing somewhere else. capacityx retired 95 of 96 in a single run.
    //
    // Compared against members we currently hold, so a genuinely small faction
    // is unaffected: retiring 2 of 3 is 67% but the floor below exempts it.
    const currentCount = await dbc.query(
      'SELECT count(*)::int AS n FROM members WHERE is_current = true'
    )
    const held = Number(currentCount.rows[0]?.n ?? 0)
    const incoming = new Set(roster.map((m) => String(m.id)))
    if (held >= MIN_ROSTER_FOR_RETIREMENT_GUARD) {
      const retiring = await dbc.query(
        'SELECT member_id FROM members WHERE is_current = true AND NOT (member_id = ANY($1))',
        [[...incoming]]
      )
      const share = retiring.rows.length / held
      if (share > MAX_ROSTER_RETIREMENT) {
        await dbc.query('ROLLBACK')
        throw new Error(
          `refusing to sync: this roster would retire ${retiring.rows.length} of ${held} members ` +
          `(${Math.round(share * 100)}%). That is not a faction event — nothing was changed.`
        )
      }
    }

    // Whom did we consider present going into this run? (open stints)
    const openBefore = await dbc.query(
      `SELECT member_id FROM member_faction_stints WHERE left_at IS NULL`
    )
    const openSet = new Set<string>(openBefore.rows.map((r: { member_id: string }) => String(r.member_id)))

    await dbc.query(
      `UPDATE members SET is_current = false, last_seen = now() WHERE is_current = true`
    )
    for (const m of roster) {
      // Torn preserves the account of a player who has died — status "Fallen",
      // described as "Resting in Peace". They stay on the roster indefinitely
      // (which is how a faction exceeds 100 members), so is_current stays true
      // and their stint history is left intact; is_fallen is what every member
      // listing, stat and scrape filters on instead.
      await dbc.query(
        `INSERT INTO members (member_id, member_name, total_days_in_faction, is_current, is_fallen, last_seen, updated_at)
         VALUES ($1, $2, $3, true, $4, now(), now())
         ON CONFLICT (member_id) DO UPDATE SET
           member_name = EXCLUDED.member_name,
           total_days_in_faction = EXCLUDED.total_days_in_faction,
           is_current = true, is_fallen = EXCLUDED.is_fallen,
           last_seen = now(), updated_at = now()`,
        [String(m.id), m.name, m.days_in_faction ?? null, m.status?.state === 'Fallen']
      )
    }

    // Key-pool reconcile off the roster we just wrote.
    const currentIds = roster.map((m) => String(m.id))
    await dbc.query(
      `UPDATE member_secrets SET disabled = true,
              last_error = 'not in faction as of ' || now()::text, updated_at = now()
       WHERE disabled = false AND NOT (member_id = ANY($1))`,
      [currentIds]
    )
    await dbc.query(
      `UPDATE member_secrets SET disabled = false, last_error = NULL, updated_at = now()
       WHERE disabled = true AND member_id = ANY($1)`,
      [currentIds]
    )

    // ⚠️ **Never finish a reconcile with an unusable pool** (#645).
    //
    // This is the guard that turns a bad hour into a bad hour rather than
    // thirteen days. Everything above can be wrong in a way nobody predicted;
    // what made capacityx unrecoverable was not the bad roster but the DEADLOCK
    // it created — every key disabled, and the only job that could re-enable
    // them needing a key from the pool it had just emptied.
    //
    // The condition mirrors keyPool.claim() exactly. If it ever drifts, this
    // guard silently stops guarding, which is why it is spelled out rather than
    // approximated by `disabled = false`.
    const claimable = await dbc.query(
      `SELECT count(*)::int AS n FROM member_secrets
        WHERE disabled = false AND consent_at IS NOT NULL AND cpr_api_key IS NOT NULL
          AND has_faction_access IS NOT FALSE`
    )
    if (Number(claimable.rows[0]?.n ?? 0) === 0 && currentIds.length > 0) {
      await dbc.query('ROLLBACK')
      throw new Error(
        'refusing to sync: this reconcile would leave no usable key in the pool, and ' +
        'members-sync is the only job that can put one back — nothing was changed.'
      )
    }

    // Stints: close anyone who dropped off the roster, open a stint for anyone
    // newly present. Members already holding an open stint are left untouched.
    const currentSet = new Set(currentIds)
    const toClose = [...openSet].filter((id) => !currentSet.has(id))
    if (toClose.length > 0) {
      await dbc.query(
        `UPDATE member_faction_stints SET left_at = now()
         WHERE left_at IS NULL AND member_id = ANY($1)`,
        [toClose]
      )
    }
    for (const id of currentIds) {
      if (openSet.has(id)) continue
      const joinedAt = await seedJoinedAt(dbc, id)
      await dbc.query(
        `INSERT INTO member_faction_stints (member_id, joined_at) VALUES ($1, $2)
         ON CONFLICT (member_id) WHERE left_at IS NULL DO NOTHING`,
        [id, joinedAt]
      )
    }

    await dbc.query('COMMIT')
  } catch (err) {
    await dbc.query('ROLLBACK')
    throw err
  } finally {
    dbc.release()
  }

  // Key re-verification (#309) — outside the transaction (it talks to Torn) and
  // skipped entirely when the key pool has no at-rest secret configured.
  let details: ReverifyCounts | undefined
  if (deps.encryptionKey) details = await reverifyPooledKeys(deps)

  return { rows: roster.length, details }
}
