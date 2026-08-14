/**
 * TNL's Steadfast rotation (#395).
 *
 * Steadfast is the faction's gym-gain bonus, and the tree only allows so much
 * of it at once:
 *
 *   • Four **main** trees — STR, SPD, DEF, DEX — each up to 10%.
 *   • A **secondary** tree adding 5% to *either* speed *or* strength.
 *   • A second secondary adding 5% to *either* defense *or* dexterity.
 *   • A **tertiary** tree adding a further 5% to one of those two.
 *
 * Because each secondary is an either/or, TNL rotates them so everyone gets a
 * turn, and the two rotations are deliberately offset by half a month:
 *
 *   > Steadfast perk rotation:
 *   > DEF/DEX SWAP ON 16TH
 *   > STR/SPE SWAP ON 1ST
 *
 * ⚠️ **This module answers "which stat", never "how much".** The magnitudes
 * depend on what the faction has actually unlocked, which changes as upgrades
 * are bought, and is read from the live `/faction/upgrades` snapshot instead —
 * see `deriveMagnitudes`. Hard-coding 15/20 here would have been half a line
 * and would have started lying the moment MonChoon bought the tertiary tree.
 *
 * The rotation itself is pure arithmetic on the calendar, so it predicts
 * forward indefinitely — which is the point. People plan training around it,
 * and a training book is five days of commitment.
 */

/** The Strength/Speed secondary moves on the 1st; Defense/Dexterity on the 16th. */
export const STR_SPD_SWAP_DAY = 1
export const DEF_DEX_SWAP_DAY = 16

// Anchors, from MonChoon on 2026-08-14:
//   "Currently, we have speed above 10%, but on the 1st of September it will
//    change to Strength. Then, we also have defense above 10%, and on august
//    [16th] it will change to dexterity."
//
// August 2026 is a SPEED month. The Defense/Dexterity period running
// 16 Jul – 15 Aug 2026 is a DEFENSE period.
const STR_SPD_ANCHOR = { year: 2026, month: 8 } // 1-indexed
const DEF_DEX_ANCHOR = { year: 2026, month: 7 } // the period STARTING 16 July

/** Whole months from an anchor; negative before it. Floors correctly for the past. */
const monthsSince = (anchor, year, month) => (year - anchor.year) * 12 + (month - anchor.month)

/**
 * Which stat holds each secondary on a given date.
 *
 * ⚠️ Alternation must work backwards as well as forwards — the calendar can be
 * paged into the past, and JavaScript's `%` returns a negative remainder for
 * negative operands, which would silently invert every month before the
 * anchor. Hence the `& 1` on an absolute value rather than `% 2`.
 */
export function picksOn(date) {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()

  const strSpdIndex = monthsSince(STR_SPD_ANCHOR, year, month)

  // The Defense/Dexterity period runs from the 16th to the 15th, so a date
  // before the 16th belongs to the period that started LAST month.
  const periodMonth = day >= DEF_DEX_SWAP_DAY ? month : month - 1
  const periodYear = periodMonth === 0 ? year - 1 : year
  const defDexIndex = monthsSince(DEF_DEX_ANCHOR, periodYear, periodMonth === 0 ? 12 : periodMonth)

  const even = (n) => (Math.abs(n) & 1) === 0
  return {
    strSpd: even(strSpdIndex) ? 'speed' : 'strength',
    defDex: even(defDexIndex) ? 'defense' : 'dexterity',
  }
}

/** UTC midnight for y/m/d, months allowed to overflow. */
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d)) // db-time-safe

/**
 * The rotation split into segments across `[from, to]` — one per stretch where
 * both picks hold steady.
 *
 * Segments, not days: the two swaps are offset, so a month contains two
 * boundaries and three-ish stretches. Each becomes one band on the calendar,
 * which is exactly what MonChoon asked for — *"have the event band stretch
 * across instead of individual ones on each day"* — and it also makes the
 * changeover legible as a seam rather than something to be spotted by reading
 * thirty identical labels.
 */
export function rotationSegments(from, to) {
  if (!(from instanceof Date) || !(to instanceof Date) || to < from) return []

  // Every swap boundary from the month before `from` to the month after `to`,
  // so a segment straddling either edge is still clipped correctly.
  const boundaries = []
  const start = utc(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)
  for (let i = -1; i <= monthSpan(from, to) + 1; i++) {
    const y = start.getUTCFullYear()
    const m = start.getUTCMonth() + 1 + i
    boundaries.push(utc(y, m, STR_SPD_SWAP_DAY), utc(y, m, DEF_DEX_SWAP_DAY))
  }
  boundaries.sort((a, b) => a - b)

  const segments = []
  for (let i = 0; i < boundaries.length; i++) {
    const segStart = boundaries[i]
    const next = boundaries[i + 1]
    if (!next) break
    const segEnd = new Date(next.getTime() - 86_400_000) // inclusive last day
    if (segEnd < from || segStart > to) continue
    segments.push({
      start: segStart < from ? from : segStart,
      end: segEnd > to ? to : segEnd,
      // ⚠️ Read from the segment's own start, never carried over from the
      // previous segment — an off-by-one at a boundary would mislabel a whole
      // fortnight, and the label is what people plan a training book around.
      ...picksOn(segStart),
      clippedStart: segStart < from,
      clippedEnd: segEnd > to,
    })
  }
  return segments
}

const monthSpan = (from, to) =>
  (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())

/**
 * Split an observed snapshot into "main tree" and "secondary bonus" per pair.
 *
 * The API reports each stat's CURRENT total, so on any one day the pick's
 * figure already includes its bonus. Separating them needs one assumption,
 * stated rather than buried:
 *
 *   **the two main trees in a pair are at the same level.**
 *
 * True in practice — a faction maxes both mains before buying a secondary,
 * since the secondary is the expensive half. Where it does not hold, the
 * derived bonus is wrong and `suspect` says so instead of the UI presenting a
 * confident number.
 *
 * ⚠️ Returns nulls, never zeros, for anything unobserved. A faction with no
 * Speed Training genuinely has 0%, and that must stay distinguishable from a
 * snapshot we do not have.
 */
export function deriveMagnitudes(snapshot, picksAtSnapshot) {
  if (!snapshot || !picksAtSnapshot) return null

  const read = (stat) => {
    const v = snapshot[`steadfast_${stat}`]
    return v === null || v === undefined ? null : Number(v)
  }

  const pair = (a, b, pick) => {
    const other = pick === a ? b : a
    const pickValue = read(pick)
    const otherValue = read(other)
    if (pickValue === null || otherValue === null) return { main: null, bonus: null, suspect: false }
    return {
      main: otherValue,
      bonus: pickValue - otherValue,
      // A pick BELOW the other stat cannot be a bonus, so the equal-mains
      // assumption has failed and the split is not trustworthy.
      suspect: pickValue < otherValue,
    }
  }

  return {
    strSpd: pair('strength', 'speed', picksAtSnapshot.strSpd),
    defDex: pair('defense', 'dexterity', picksAtSnapshot.defDex),
    observedOn: snapshot.snapshot_date ?? null,
  }
}

/**
 * The four percentages on a date, from the rotation plus observed magnitudes.
 *
 * With no snapshot to work from this returns nulls and the caller shows which
 * stats are boosted without claiming by how much — still the useful half, and
 * honest about the other.
 */
export function percentagesFor(picks, magnitudes) {
  const blank = { strength: null, speed: null, defense: null, dexterity: null }
  if (!magnitudes) return blank

  const out = { ...blank }
  const apply = (a, b, pick, m) => {
    if (!m || m.main === null) return
    const other = pick === a ? b : a
    out[other] = m.main
    out[pick] = m.bonus === null ? null : m.main + m.bonus
  }
  apply('strength', 'speed', picks.strSpd, magnitudes.strSpd)
  apply('defense', 'dexterity', picks.defDex, magnitudes.defDex)
  return out
}
