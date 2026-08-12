// Saved RW payout history: turning a stored `war_payouts` row back into
// something the page can show and reload.
//
// Kept out of the component so it can be tested without a DOM — the numbers in
// here end up in a batch-payout URL that moves real money, which is not a thing
// to verify by looking at it.
import { parseDbTime } from './time'

/**
 * One row of the history table.
 *
 * `totalPayout` comes from the member rows rather than the stored
 * `total_payout` column. Both should agree — the column is written as the sum
 * of the eligible amounts — but the member rows are the sheet that was
 * actually paid, and if the two ever disagree the sheet is the truth. The
 * column is the fallback for a payout whose member rows are gone.
 */
export function summariseWarPayoutRow(payout) {
  const members = payout?.war_payout_members ?? []
  const eligible = members.filter((m) => m.is_eligible)
  const summedPayout = eligible.reduce((s, m) => s + (Number(m.payout_amount) || 0), 0)

  return {
    id: payout.id,
    warId: payout.war_id,
    warType: payout.war_type,
    // A war row is joined in, not denormalised, so it can legitimately be
    // absent. Say so rather than rendering an empty cell.
    opponent: payout.war_opponent_name || null,
    opponentId: payout.war_opponent_id ?? null,
    startAt: payout.war_start_at ?? null,
    endAt: payout.war_end_at ?? null,
    totalPayout: members.length > 0 ? summedPayout : (Number(payout.total_payout) || 0),
    memberCount: members.length || (Number(payout.member_count) || 0),
    eligibleCount: eligible.length,
    factionCutPercent: Number(payout.faction_cut_percent) || 0,
    savedBy: payout.created_by ?? null,
    // #140: a bare "+00" offset is not ISO 8601, and `new Date` returns NaN on
    // it. This column rendered a literal "Invalid Date" for every row until it
    // went through parseDbTime.
    savedAt: parseDbTime(payout.created_at),
    notes: payout.notes || null,
  }
}

/**
 * The saved settings, as the flat shape the form holds them in.
 *
 * Every key here is a control on the page. Anything stored on the payout that
 * is NOT a control — total_payout, member_count, war_id — is deliberately
 * absent: those are outputs, and feeding an output back in as an input is how
 * a reloaded payout would quietly stop matching its own numbers.
 */
export function restoredWarPayoutSettings(payout) {
  const num = (v, fallback) => (v == null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v))
  return {
    warClass: payout.war_type === 'termed' ? 'termed' : 'real',
    factionCutPercent: num(payout.faction_cut_percent, 20),
    totalReward: num(payout.total_reward, 0),
    minScoreThreshold: num(payout.min_score_threshold, 50),
    notes: payout.notes || '',
    mercCost: num(payout.merc_cost, 0),
    reviverCost: num(payout.reviver_cost, 0),
    factionTopUp: num(payout.faction_top_up, 0),

    warHitMult: num(payout.war_hit_multiplier, 1),
    assistMult: num(payout.assist_multiplier, 0.5),
    lossMult: num(payout.loss_multiplier, 0.5),
    mugMult: num(payout.mug_multiplier, 0),
    regularHitMult: num(payout.regular_hit_multiplier, 1),
    partWeight: num(payout.participation_weight, 50),

    raceTargetScore: num(payout.race_target_score, 0),
    // A saved payout has a fixed cutoff. Reloading it in 'auto' would let the
    // detector move the cutoff off the one the payout was computed with.
    raceCutoffMode: 'manual',
    raceCutoffTimestamp: num(payout.race_cutoff_timestamp, 0),
    racePostCutoffMode: payout.race_post_cutoff_mode || 'flat',
    racePreCutoffPercent: num(payout.race_pre_cutoff_percent, 50),

    postWarHitMult: num(payout.post_war_hit_multiplier, 1),
    postAssistMult: num(payout.post_assist_multiplier, 0.5),
    postLossMult: num(payout.post_loss_multiplier, 0.5),
    postMugMult: num(payout.post_mug_multiplier, 0),
    postRegularHitMult: num(payout.post_regular_hit_multiplier, 0),
    postPartWeight: num(payout.post_participation_weight, 50),
    postDistMode: payout.post_dist_mode || 'formula',
    postFlatThreshold: num(payout.post_flat_threshold, 0),
    postScaleEnabled: Boolean(payout.post_scale_enabled),
    postScaleHours: num(payout.post_scale_hours, 0),
  }
}

/**
 * Eligibility overrides needed to reproduce the saved sheet.
 *
 * Only members whose saved eligibility DISAGREES with what the score threshold
 * would decide get an override. Writing one for every member would reproduce
 * the sheet just as faithfully and then freeze it: the threshold control would
 * stop doing anything, with no indication why.
 */
export function restoredEligibilityOverrides(payout) {
  const threshold = Number(payout.min_score_threshold) || 0
  const overrides = {}
  for (const m of payout.war_payout_members ?? []) {
    const byRule = (Number(m.score) || 0) >= threshold
    const saved = Boolean(m.is_eligible)
    if (saved !== byRule) overrides[m.member_id] = saved
  }
  return overrides
}

/** Per-member multiplier tweaks, as the pre-cutoff override map. */
export function restoredMultiplierOverrides(payout) {
  const overrides = {}
  for (const m of payout.war_payout_members ?? []) {
    if (m.multiplier_overrides) overrides[m.member_id] = m.multiplier_overrides
  }
  return overrides
}

/**
 * The batch-payout URL exactly as it was saved.
 *
 * Recalculating a completed war is deterministic — the official report and the
 * attack history are both immutable — so a reload should reproduce the saved
 * amounts. `driftAgainst` is how we find out when it does not, instead of
 * assuming. A leader re-paying from a URL that silently drifted would send the
 * wrong amounts to real people.
 */
export function driftAgainst(savedPayout, recomputedMembers) {
  const saved = new Map(
    (savedPayout.war_payout_members ?? [])
      .filter((m) => m.is_eligible)
      .map((m) => [Number(m.member_id), Math.floor(Number(m.payout_amount) || 0)])
  )
  const now = new Map(
    (recomputedMembers ?? [])
      .filter((m) => m.isEligible)
      .map((m) => [Number(m.memberId), Math.floor(Number(m.payoutAmount) || 0)])
  )

  const changed = []
  for (const [id, amount] of saved) {
    if (!now.has(id)) changed.push({ memberId: id, saved: amount, now: null })
    else if (now.get(id) !== amount) changed.push({ memberId: id, saved: amount, now: now.get(id) })
  }
  for (const [id, amount] of now) {
    if (!saved.has(id)) changed.push({ memberId: id, saved: null, now: amount })
  }

  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0)
  return {
    changed,
    matches: changed.length === 0,
    savedTotal: sum(saved),
    recomputedTotal: sum(now),
  }
}
