/**
 * The one numeric guard for readings that may not exist.
 *
 * `Number(null)` is 0 and `Number('')` is 0, so a plain cast silently turns
 * "we have no reading" into "this member has zero". That has bitten this
 * codebase four separate times now, and always in the same direction:
 *
 *   - energy: a member whose own API key failed rendered as 0/150 and got
 *     written off for the push
 *   - cooldowns: an unfetched member rendered as Ready
 *   - revive chance (#358): an absent skill counted as skill 0
 *
 * Every one of those reads as a confident fact about the member rather than as
 * an absence, which is the worst possible failure for a board people make
 * calls from. So it lives in one place and everything numeric goes through it.
 */
export function reading(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
