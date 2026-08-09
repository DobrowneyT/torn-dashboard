/**
 * Best-case revive chance for our own members (#358).
 *
 * The original ask was a revive percentage next to a target. That number does
 * not exist as a property of a target: Torn computes it from BOTH parties, and
 * it is only ever reported to us after the fact, on revives our own faction
 * received. So there is nothing to show for an enemy, ever — see the note on
 * the issue.
 *
 * What IS computable is our own side. Torn's rule, from the wiki:
 *
 *   "This success chance is based on how many revives the target has recently
 *    received and at a base level each revive decreases the future success
 *    chance by around 8% which slowly fades over 24 hours."
 *
 * and, on the decay:
 *
 *   "Whenever a target receives a successful revive, 1 is added to its score.
 *    The added score then decays linearly to zero over a period of 24 hours."
 *
 * Every input to that is in our revive history once revives-sync is running:
 * who was revived and exactly when. So rather than trying to invert an
 * observed percentage, the score is computed DIRECTLY from the history, and
 * the observed percentages become something better — a check on the model (see
 * modelError below).
 *
 * The chance is quoted for a skill-100 reviver: a best case, and the right
 * frame for the actual decision, which is whether paying a good reviver to go
 * after this member is worth it.
 */
import { reading } from './reading'

/** One revive's score contribution decays linearly to zero over this long. */
export const SCORE_DECAY_SEC = 24 * 3600

/**
 * Torn's published figures, reconstructed into a formula.
 *
 * ⚠️ The wiki states the endpoints, not the curve between them, so the LINEAR
 * interpolation here is inference, not documentation. Both endpoints are
 * quoted directly:
 *
 *   - base chance runs 90% at skill 0 → 100% at skill 100
 *   - each point of score costs 8% at skill 0, halved to 4% at skill 100
 *
 * Anything between those is assumed to be a straight line. Because we scrape
 * the chance Torn actually showed on every revive, that assumption is testable
 * against real data rather than trusted — modelError() is exactly that test,
 * and it is surfaced to leads. If the curve turns out to be something else,
 * the error will show up as a systematic bias, not a silent wrong number.
 */
export const MODEL = {
  baseAtSkillZero: 90,
  baseAtSkillMax: 100,
  penaltyAtSkillZero: 8,
  penaltyAtSkillMax: 4,
  skillMax: 100,
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/**
 * Skill as a 0-1 fraction of the maximum.
 *
 * An unknown skill resolves to 0 — an unskilled reviver — which understates
 * the chance rather than overstating it. Callers that must NOT make that
 * substitution (modelError, which would otherwise fold our own assumption into
 * the error we use to judge the assumption) check for the reading themselves.
 */
function skillFraction(skill) {
  return clamp(reading(skill) ?? 0, 0, MODEL.skillMax) / MODEL.skillMax
}

/** Starting chance against a fully-rested target, for a reviver of this skill. */
export function baseChance(skill) {
  const t = skillFraction(skill)
  return MODEL.baseAtSkillZero + (MODEL.baseAtSkillMax - MODEL.baseAtSkillZero) * t
}

/** Percentage points lost per point of target score, for a reviver of this skill. */
export function scorePenalty(skill) {
  const t = skillFraction(skill)
  return MODEL.penaltyAtSkillZero + (MODEL.penaltyAtSkillMax - MODEL.penaltyAtSkillZero) * t
}

/**
 * Did this revive add to the target's score?
 *
 * Only successful revives do. `result` is treated as successful unless it says
 * otherwise — including when it is missing. That is the deliberately
 * pessimistic reading: an uncounted revive inflates the chance we show, and an
 * inflated chance is what gets a reviver paid for an attempt that was never
 * good value. Erring the other way only makes us skip a target.
 */
export function countsTowardScore(revive) {
  const result = revive?.result
  if (result == null || result === '') return true
  return !/fail|unsuccess|error/i.test(String(result))
}

/**
 * The target's current revive score.
 *
 * Each qualifying revive contributes `1 - age/24h`, floored at zero, so a
 * revive 6 hours ago still carries 0.75 and one 25 hours ago carries nothing.
 * Revives in the future (clock skew between us and Torn) are clamped to a full
 * 1 rather than allowed to contribute more than one revive's worth.
 */
export function reviveScore(revives, nowSec) {
  let score = 0
  for (const r of revives ?? []) {
    if (!countsTowardScore(r)) continue
    const ts = reading(r?.timestamp)
    if (ts == null) continue
    const age = nowSec - ts
    if (age >= SCORE_DECAY_SEC) continue
    score += age <= 0 ? 1 : 1 - age / SCORE_DECAY_SEC
  }
  return score
}

/** Success chance for a target at this score, attempted by a reviver of this skill. */
export function chanceFromScore(score, skill) {
  return clamp(baseChance(skill) - Math.max(0, score) * scorePenalty(skill), 0, 100)
}

/**
 * What a skill-100 reviver would see for this member right now.
 *
 * `revives` is that member's history; anything older than 24h is free to
 * include, it simply contributes nothing.
 */
export function bestCaseChance(revives, nowSec) {
  return chanceFromScore(reviveScore(revives, nowSec), MODEL.skillMax)
}

/**
 * Group a flat revive list by target, newest first within each member.
 *
 * The endpoint returns one window for the whole faction; the board needs it
 * per member.
 */
export function indexRevivesByTarget(revives) {
  const byTarget = new Map()
  for (const r of revives ?? []) {
    const id = reading(r?.target_id)
    if (id == null) continue
    if (!byTarget.has(id)) byTarget.set(id, [])
    byTarget.get(id).push(r)
  }
  for (const list of byTarget.values()) {
    list.sort((a, b) => (reading(b?.timestamp) ?? 0) - (reading(a?.timestamp) ?? 0))
  }
  return byTarget
}

/**
 * How far the model is from what Torn actually showed.
 *
 * For each scraped revive we know three things: the chance Torn displayed, the
 * reviver's skill, and — by replaying the history up to that instant — the
 * score the target was carrying. That is enough to predict what should have
 * been displayed and compare.
 *
 * This exists because the interpolation in MODEL is inferred. Shipping an
 * inferred formula without a way to see it being wrong is how a plausible
 * number quietly becomes a trusted one. Returns null when there is nothing to
 * check against.
 *
 * `evaluateAfterSec` guards against a real artifact: an observation near the
 * START of the fetched window has had its own prior history truncated away, so
 * its score is understated, so the prediction comes out high — a positive bias
 * that is entirely our windowing and nothing to do with the formula. Pass the
 * window start plus 24h and everything evaluated has a complete history behind
 * it; the earlier rows still serve as that history.
 */
export function modelError(revives, evaluateAfterSec = -Infinity) {
  const sorted = (revives ?? [])
    .filter((r) => reading(r?.timestamp) != null && reading(r?.success_chance) != null)
    .sort((a, b) => reading(a.timestamp) - reading(b.timestamp))

  const byTarget = indexRevivesByTarget(sorted)
  const errors = []
  let biasSum = 0

  for (const r of sorted) {
    // Without the reviver's skill the prediction is unanchored; skip rather
    // than assume a skill and pollute the error with our own guess. Note this
    // is the one place that must NOT fall back to skill 0 the way baseChance
    // does — that fallback is a display choice, not a measurement.
    const skill = reading(r?.reviver_skill)
    if (skill == null) continue

    const at = reading(r.timestamp)
    if (at < evaluateAfterSec) continue
    const history = byTarget.get(reading(r.target_id)) ?? []
    // Strictly earlier: the displayed chance is what the reviver saw BEFORE
    // this revive landed, so this revive cannot be in its own score.
    const prior = history.filter((h) => reading(h.timestamp) < at)
    const predicted = chanceFromScore(reviveScore(prior, at), skill)
    const diff = predicted - reading(r.success_chance)
    errors.push(Math.abs(diff))
    biasSum += diff
  }

  if (errors.length === 0) return null
  return {
    samples: errors.length,
    meanAbsError: errors.reduce((a, b) => a + b, 0) / errors.length,
    maxAbsError: Math.max(...errors),
    // Signed: a consistent sign means the shape is wrong, not just noisy.
    bias: biasSum / errors.length,
  }
}

/** Red at hopeless, green at certain — the same hue ramp as the other columns. */
const HUE_WORST = 0
const HUE_BEST = 142

export function reviveChanceHue(chance) {
  const c = reading(chance)
  if (c == null) return null
  // The band that matters is 60–100: nothing realistic sits below 60, so
  // ramping from zero would render every member the same shade of green.
  const t = clamp((c - 60) / 40, 0, 1)
  return Math.round(HUE_WORST + (HUE_BEST - HUE_WORST) * t)
}

/**
 * Label for the chance cell.
 *
 * `null` (no history loaded yet) is NOT 0% — the #351 rule. A member with no
 * revives in the window is a genuine 100%, which is different again.
 */
export function formatReviveChance(chance) {
  const c = reading(chance)
  if (c == null) return '—'
  return `${Math.round(c)}%`
}
