/**
 * The scope economy — what actually limits how many crimes a faction can run.
 *
 * MonChoon, 2026-08-13: *"I meant scope, its the cost that it takes to spawn a
 * crime... you can only bank 100 scope maximum."*
 *
 * Spawning costs scope up front. Completing SUCCESSFULLY pays scope back.
 * Failing pays nothing, and the cost is already gone. So:
 *
 *     expected net scope = P(success) × reward − cost
 *
 * ⚠️ That asymmetry is the whole point, and it produces a **break-even success
 * chance** per difficulty, below which running the crime steadily destroys the
 * faction's ability to run anything at all:
 *
 *     Introductory  1/2 = 50.0%      Advanced   4/5 = 80.0%
 *     Simple        2/3 = 66.7%      Elaborate  5/6 = 83.3%
 *     Intermediate  3/4 = 75.0%
 *
 * This is the answer to "what is the optimal minimum CPR" — the minimum worth
 * setting is whatever puts success above that line for the difficulty being
 * run. A crime paying enormous money below its break-even is still a crime the
 * faction cannot afford to keep spawning, and money alone will never say so.
 */
import { config } from '../config'

/** Scope regenerates +1/day and the bank is hard-capped here. */
export const SCOPE_CAP = 100

/** The category entry for a crime category key, or null. */
function category(categoryKey) {
  return config?.ocCategories?.[categoryKey] ?? null
}

/**
 * Cost and reward for one spawn of this category.
 *
 * Returns null for an unknown category rather than assuming a cost. Guessing
 * here would put a made-up number into a budget calculation.
 */
export function scopeFor(categoryKey) {
  const c = category(categoryKey)
  if (!c || typeof c.scopeCost !== 'number' || typeof c.scopeReward !== 'number') return null
  return { cost: c.scopeCost, reward: c.scopeReward, label: c.label }
}

/**
 * The success chance at which a crime exactly pays for its own scope.
 *
 * Below it the crime is scope-negative and cannot be sustained; above it, each
 * run adds to the bank.
 */
export function breakEvenSuccess(categoryKey) {
  const s = scopeFor(categoryKey)
  if (!s || s.reward <= 0) return null
  return s.cost / s.reward
}

/**
 * Expected net scope for one spawn at a given success chance.
 *
 * Positive means the crime funds itself and then some.
 */
export function netScope(categoryKey, successChance) {
  const s = scopeFor(categoryKey)
  if (!s || !Number.isFinite(successChance)) return null
  return successChance * s.reward - s.cost
}

/**
 * A verdict on whether this crew can afford to run this crime repeatedly.
 *
 * `sustainable` is the question an OC manager is actually asking. The margin is
 * reported alongside so a crime sitting barely above the line reads differently
 * from one comfortably above it — the first is one bad week from draining.
 */
export function scopeVerdict(categoryKey, successChance) {
  const s = scopeFor(categoryKey)
  const breakEven = breakEvenSuccess(categoryKey)
  if (!s || breakEven === null || !Number.isFinite(successChance)) return null

  const net = successChance * s.reward - s.cost
  return {
    ...s,
    breakEven,
    net,
    sustainable: net > 0,
    // How far above or below the line, in success-chance terms — more useful
    // than the raw net, because it is the number you move with a CPR slider.
    margin: successChance - breakEven,
  }
}

/**
 * Money per scope spent — the ranking metric when scope is the scarce input.
 *
 * ⚠️ Not money per crime. Scope is what runs out, so the crime that turns each
 * point of it into the most cash wins, even if a pricier crime pays more per
 * run. Returns null rather than dividing by a cost we do not know.
 */
export function moneyPerScope(categoryKey, expectedMoney) {
  const s = scopeFor(categoryKey)
  if (!s || s.cost <= 0 || !Number.isFinite(expectedMoney)) return null
  return expectedMoney / s.cost
}

/**
 * How many spawns of this category the bank supports, and whether it is full.
 *
 * ⚠️ Scope above the cap is discarded. A faction sitting at 100 is wasting its
 * regeneration every day, so "at cap" is a prompt to spawn more or harder — not
 * a healthy state. Reporting the bank without that reads as a comfortable
 * surplus when it is actually waste.
 */
export function scopeBudget(banked, categoryKey) {
  const s = scopeFor(categoryKey)
  const bank = Number(banked)
  if (!s || !Number.isFinite(bank)) return null
  return {
    banked: bank,
    spawnsAffordable: s.cost > 0 ? Math.floor(bank / s.cost) : null,
    atCap: bank >= SCOPE_CAP,
    wastedPerDay: bank >= SCOPE_CAP ? 1 : 0,
  }
}
