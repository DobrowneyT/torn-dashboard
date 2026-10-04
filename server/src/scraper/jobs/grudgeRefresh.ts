// Book of Grudges refresh (#889, slice 4): who each target is, and where they
// are right now.
//
// ⚠️ **Purpose-scoped.** The rotator claims with `purpose: 'target-lookup'`, so
// a member who has not accepted the Target Lookups disclosure is skipped for
// this job and for nothing else (#894). If NOBODY has accepted, this job does
// nothing at all — which is the correct outcome, not an error.
//
// ⚠️ **Grouped by faction.** `/faction/{id}/members` returns every member's
// status in one call, so a faction holding several targets costs one call
// rather than several. A faction holding exactly ONE costs the same single call
// either way and drags back every other member of that faction for nothing, so
// `planStatusRefresh` routes it to the individual lookup instead.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { createKeyRotator } from '../sampleCapture.js'
import { planStatusRefresh, departedFromFaction, isWatchedFaction } from '../../grudges.js'
import {
  readProfile, readFactionName, readFactionMembers, identityChanges,
  regateOnFactionChange, type ResolvedTarget,
} from '../../grudgeEnrich.js'
import { planWatchCycle, shardFor, describePlan } from '../../grudgeWatchPlan.js'

/**
 * How often the job does a full pass when watch mode is OFF.
 *
 * ⚠️ The job ticks every minute so watch mode can be fast, but off-duty it
 * must not refresh every minute — that would spend the budget whether anybody
 * is chaining or not. A stated tunable, not a magic number.
 */
const IDLE_SWEEP_MINUTES = 15

export async function grudgeRefreshJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const targets = await db.query(
    `SELECT id, target_id, target_name, faction_id, faction_name, state
       FROM grudge_targets WHERE removed_at IS NULL ORDER BY target_id`
  )
  if (targets.rows.length === 0) return { rows: 0, details: { note: 'no targets' } }

  // ⚠️ Watch mode, the War Room's gate idea applied here with its own state.
  // On: a fast, sharded refresh every minute. Off: one pass a quarter-hour.
  // Nothing in this file reads war-room config.
  const watchRow = await db.query(
    `SELECT value FROM faction_settings WHERE key = 'grudge_watch'`
  )
  const watching = watchRow.rows[0]?.value?.enabled === true
  const minute = Math.floor(Date.now() / 60_000)
  if (!watching && minute % IDLE_SWEEP_MINUTES !== 0) {
    return { rows: 0, details: { note: 'watch off; between idle sweeps' } }
  }

  const { active, rfetch } = await createKeyRotator(pool, client, undefined, 'target-lookup')
  if (active.length === 0) {
    // ⚠️ NOT an error. It means nobody has accepted the Target Lookups
    // disclosure yet, which is a legitimate state the design explicitly
    // permits — and throwing would light up the job-failure alerting for a
    // consent decision members are entitled to make.
    return { rows: 0, details: { note: 'no key consented to target lookups' } }
  }

  const watchedRow = await db.query(
    `SELECT value FROM faction_settings WHERE key = 'grudge_watched_factions'`
  )
  const watched = Array.isArray(watchedRow.rows[0]?.value) ? watchedRow.rows[0].value : []
  const isWatched = (fid: string | null) => isWatchedFaction(fid, watched)

  const full = planStatusRefresh(targets.rows as any)
  // ⚠️ The cadence is DERIVED from the list and the keys available, never a
  // constant. Twenty targets and four hundred are not the same job.
  const cycle = planWatchCycle(full, active.length)
  const plan = watching ? shardFor(full, cycle) : full
  const byTargetId = new Map(targets.rows.map((r: any) => [String(r.target_id), r]))
  const resolved = new Map<string, ResolvedTarget>()
  const factionNames = new Map<string, string>()
  let calls = 0

  // ── grouped: one call covers every target in the faction ──────────────────
  for (const factionId of plan.factions) {
    const data = await rfetch(`/v2/faction/${factionId}/members`)
    calls += 1
    if (!data) continue
    const members = readFactionMembers(data)
    const expected = (targets.rows as any[])
      .filter((r) => String(r.faction_id) === factionId)
      .map((r) => String(r.target_id))

    for (const id of expected) {
      const seen = members.get(id)
      if (seen) resolved.set(id, { ...seen, factionId })
    }

    // ⚠️ Absent from their own faction's member list means they LEFT it, which
    // is the only signal Torn gives us. They need an individual profile call to
    // re-home them, and `basic` would not do: it carries no faction.
    for (const gone of departedFromFaction(expected, [...members.keys()])) {
      plan.individuals.push(gone)
    }

    // ⚠️ Only when we do not already know the name. Faction names almost
    // never change, and fetching one every sweep DOUBLED the cost of every
    // grouped faction for a string we already had.
    const known = (targets.rows as any[]).find(
      (r) => String(r.faction_id) === factionId && r.faction_name
    )?.faction_name
    if (known) {
      factionNames.set(factionId, known)
    } else {
      const basic = await rfetch(`/v2/faction/${factionId}/basic`)
      calls += 1
      const name = readFactionName(basic)
      if (name) factionNames.set(factionId, name)
    }
  }

  // ── individual: unfactioned, alone in their faction, or just departed ──────
  for (const id of plan.individuals) {
    const data = await rfetch(`/v2/user/${id}/profile`)
    calls += 1
    if (!data) continue
    const p = readProfile(data)
    if (p) resolved.set(String(id), p)
  }

  // Name any faction we learned about from an individual lookup.
  for (const p of resolved.values()) {
    if (p.factionId && !factionNames.has(p.factionId)) factionNames.set(p.factionId, '')
  }
  for (const [fid, name] of factionNames) {
    if (name !== '') continue
    const basic = await rfetch(`/v2/faction/${fid}/basic`)
    calls += 1
    const resolvedName = readFactionName(basic)
    if (resolvedName) factionNames.set(fid, resolvedName)
  }

  // ── write ────────────────────────────────────────────────────────────────
  let updated = 0
  let renamed = 0
  let regated = 0

  for (const [targetId, p] of resolved) {
    const row = byTargetId.get(targetId)
    if (!row) continue

    const changes = identityChanges(row as any, p)
    const nextState = regateOnFactionChange(row as any, p.factionId, isWatched)

    await db.query(
      `UPDATE grudge_targets
          SET target_name = COALESCE($2, target_name),
              level = COALESCE($3, level),
              faction_id = $4,
              faction_name = $5,
              status_state = $6, status_until = $7, status_description = $8,
              status_fetched_at = now(),
              state = COALESCE($9, state),
              state_changed_at = CASE WHEN $9 IS NULL THEN state_changed_at ELSE now() END
        WHERE id = $1`,
      [row.id, p.name, p.level, p.factionId,
       p.factionId ? (factionNames.get(p.factionId) ?? null) : null,
       p.statusState, p.statusUntil, p.statusDescription, nextState]
    )
    updated += 1

    // ⚠️ Identity changes only. Status churns every few minutes, and an audit
    // row per hospital timer would bury the three things the trail exists to
    // answer under thousands nobody asked for.
    for (const c of changes) {
      if (c.field === 'target_name') renamed += 1
      await db.query(
        `INSERT INTO grudge_audit
           (target_row_id, target_id, actor_member_id, action, field, old_value, new_value)
         VALUES ($1,$2,'system','edited',$3,$4,$5)`,
        [row.id, targetId, c.field, c.from, c.to]
      )
    }
    if (nextState) {
      regated += 1
      await db.query(
        `INSERT INTO grudge_audit
           (target_row_id, target_id, actor_member_id, action, field, old_value, new_value)
         VALUES ($1,$2,'system','state_changed','state',$3,$4)`,
        [row.id, targetId, row.state, nextState]
      )
    }
  }

  return {
    rows: updated,
    details: {
      targets: targets.rows.length,
      watching,
      cadence: describePlan(cycle, active.length),
      calls_per_sweep: cycle.callsPerSweep,
      shards: cycle.shards,
      seconds_per_sweep: cycle.secondsPerSweep,
      calls,
      // The saving grouping buys, stated rather than assumed.
      grouped_factions: plan.factions.length,
      individual_lookups: plan.individuals.length,
      renamed,
      regated,
      keys: active.length,
    },
  }
}
