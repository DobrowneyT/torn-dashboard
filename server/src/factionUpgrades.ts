/**
 * Reading Steadfast out of `GET /faction/upgrades` (#395 / #458).
 *
 * Steadfast is the faction's per-stat gym-gain bonus. Each level in a stat's
 * sub-branch adds 1%, and a faction can reach roughly 20% in one stat, 15% in
 * another and 10% in the rest — the largest single lever on training in the
 * game, and the reason MonChoon wants it visible.
 *
 * ⚠️ **This parser was written without a verified live response.** The API
 * gives each upgrade a `name`, a `level`, and a human-readable `ability`
 * string, but Torn's exact wording could not be confirmed (the wiki returns
 * 403 and there was no key to hand at authoring time). Everything below is
 * therefore built on one rule:
 *
 *   **Never invent a number.** Where a stat cannot be identified with
 *   confidence, it stays `null` and the raw text is carried through to the UI
 *   verbatim. A wrong percentage looks exactly like a right one; a missing one
 *   at least tells the truth about itself.
 *
 * The raw response is stored alongside the parse for the same reason, so a
 * wording change costs a re-derivation rather than a lost month of history.
 */

export type SteadfastStat = 'strength' | 'defense' | 'speed' | 'dexterity'

export interface SteadfastReading {
  strength: number | null
  defense: number | null
  speed: number | null
  dexterity: number | null
  /** Anything under Steadfast we could not attribute to a stat, verbatim. */
  unparsed: string[]
}

/** Accepts the spellings Torn and its players actually use. */
const STAT_PATTERNS: Array<[SteadfastStat, RegExp]> = [
  ['strength', /\bstr(ength)?\b/i],
  ['defense', /\bdef(en[cs]e)?\b/i],
  ['speed', /\bspe(ed)?\b/i],
  ['dexterity', /\bdex(terity)?\b/i],
]

const statOf = (text: string): SteadfastStat | null => {
  const hits = STAT_PATTERNS.filter(([, re]) => re.test(text))
  // ⚠️ Two stats named in one string is ambiguous, not a coin flip. Picking
  // the first match would silently attribute a bonus to the wrong stat.
  return hits.length === 1 ? hits[0][0] : null
}

/**
 * A percentage from the ability text, else the level.
 *
 * The text is preferred because it is Torn's own statement of the effect.
 * `level` is the fallback and is only reliable while "one level = one percent"
 * holds — true today, and the kind of thing that quietly stops being true.
 */
const percentOf = (text: string, level: unknown): number | null => {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(text)
  if (m) return Number(m[1])
  const n = Number(level)
  return Number.isFinite(n) && n > 0 ? n : null
}

const isSteadfastBranch = (name: unknown) => typeof name === 'string' && /steadfast/i.test(name)

/**
 * Pull the Steadfast percentages out of a `/faction/upgrades` response.
 *
 * Reads only the branch set named by `state`, because that is the set actually
 * in effect — a faction at war is running its war branches, and summing both
 * would report bonuses nobody is getting.
 */
export function readSteadfast(payload: any): SteadfastReading {
  const out: SteadfastReading = { strength: null, defense: null, speed: null, dexterity: null, unparsed: [] }
  const upgrades = payload?.upgrades
  if (!upgrades) return out

  const state = payload?.state === 'war' ? 'war' : 'peace'
  const branches: any[] = Array.isArray(upgrades[state]) ? upgrades[state] : []

  for (const branch of branches) {
    if (!isSteadfastBranch(branch?.name)) continue
    for (const up of branch?.upgrades ?? []) {
      const text = `${up?.name ?? ''} ${up?.ability ?? ''}`.trim()
      const stat = statOf(text)
      const pct = percentOf(String(up?.ability ?? ''), up?.level)
      if (stat && pct !== null) {
        // Highest wins: a sub-branch lists every level it passed through, and
        // summing them would multiply the bonus by its own level count.
        out[stat] = Math.max(out[stat] ?? 0, pct)
      } else if (text !== '') {
        out.unparsed.push(text)
      }
    }
  }
  return out
}

/** `'war' | 'peace'`, or null when the response does not say. */
export function readBranchState(payload: any): 'war' | 'peace' | null {
  return payload?.state === 'war' || payload?.state === 'peace' ? payload.state : null
}
