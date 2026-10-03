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

/**
 * ── The branch view (#458) ───────────────────────────────────────────────────
 *
 * Everything above reads Steadfast alone, for the calendar. This reads the
 * whole tree, for the Upgrades panel.
 *
 * ⚠️ **Shapes verified against a live `forge` snapshot, 2026-10-03.** The
 * caveat at the top of this file no longer applies to the structure (it still
 * applies to `ability` WORDING, which is why nothing below parses it):
 *
 *   • `upgrades.core`  — an OBJECT, `{ upgrades: [...] }`, with no branch name,
 *                        order or multiplier. These are the always-on unlocks
 *                        (armory, etc).
 *   • `upgrades.war`   — an ARRAY of branches.
 *   • `upgrades.peace` — an ARRAY of branches.
 *   • branch: `{ name, order, multiplier, upgrades[] }`
 *   • upgrade: `{ id, name, ability, level, cost, unlocked_at }`
 *
 * ⚠️ **War and peace share branch NAMES.** Live forge carries Aggression,
 * Toleration and Voracity on both sides. So the two sets must never be merged
 * or deduplicated by name — they are different branches that happen to be
 * called the same thing, and collapsing them would silently drop whichever
 * side was processed second.
 *
 * ⚠️ **`unlocked_at` is EPOCH SECONDS**, not a Postgres timestamp. It comes
 * from Torn's JSON, not from our column, so `parseDbTime` is wrong here and
 * `new Date(unlocked_at)` lands in 1970. It is converted to epoch MILLIseconds
 * here and named `unlockedMs` so no caller has to guess which unit it holds.
 */

export interface UpgradeView {
  id: number | null
  name: string
  /** Torn's own words for what the perk does. Never re-derived. */
  ability: string
  level: number | null
  cost: number | null
  /** Epoch MILLIseconds, or null when Torn did not say. */
  unlockedMs: number | null
}

export interface BranchView {
  name: string
  order: number | null
  /** Respect cost multiplier for the next level in this branch. */
  multiplier: number | null
  upgrades: UpgradeView[]
}

export interface UpgradesView {
  /** 'war' | 'peace' | null when the response did not say. */
  state: string | null
  /** The branch set actually in effect right now. */
  active: BranchView[]
  /** The other side — bought and paid for, currently doing nothing. */
  inactive: BranchView[]
  /** Which side `inactive` is, so the UI can name it without inferring. */
  inactiveState: string | null
  /** Always-on unlocks. No branch, no multiplier. */
  core: UpgradeView[]
}

const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const readUpgrade = (u: any): UpgradeView => {
  const unlocked = num(u?.unlocked_at)
  return {
    id: num(u?.id),
    name: typeof u?.name === 'string' ? u.name : '',
    // ⚠️ Verbatim, and empty rather than invented. The panel shows Torn's
    // sentence; a perk whose ability string is missing shows its level alone,
    // which is honest, where a guessed effect would not be.
    ability: typeof u?.ability === 'string' ? u.ability : '',
    level: num(u?.level),
    cost: num(u?.cost),
    // Epoch seconds → milliseconds. Torn sends 0 for "not unlocked" in some
    // shapes, and 0 would render as 1970 rather than as unknown.
    unlockedMs: unlocked && unlocked > 0 ? unlocked * 1000 : null,
  }
}

const readBranch = (b: any): BranchView => ({
  name: typeof b?.name === 'string' ? b.name : '',
  order: num(b?.order),
  multiplier: num(b?.multiplier),
  upgrades: Array.isArray(b?.upgrades) ? b.upgrades.map(readUpgrade) : [],
})

/** `order` when Torn gives one, else name, so the list never reshuffles. */
const byOrderThenName = (a: BranchView, b: BranchView) =>
  (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
  a.name.localeCompare(b.name)

const branchSet = (v: unknown): BranchView[] =>
  Array.isArray(v) ? v.map(readBranch).sort(byOrderThenName) : []

/**
 * Split a `/faction/upgrades` payload into what is working and what is not.
 *
 * ⚠️ The split is the whole point of the endpoint. A flat list of everything
 * purchased tells people they have bonuses they are not currently getting —
 * someone plans a training week around a perk that is only live in war state.
 * When `state` is missing we do NOT guess a side: both sets come back empty of
 * active and the caller shows them as unknown rather than picking one.
 */
export function readUpgradesView(payload: any): UpgradesView {
  const state = readBranchState(payload)
  const war = branchSet(payload?.upgrades?.war)
  const peace = branchSet(payload?.upgrades?.peace)
  const coreRaw = payload?.upgrades?.core
  // core is an object wrapping an array, but tolerate a bare array too.
  const coreList = Array.isArray(coreRaw) ? coreRaw : coreRaw?.upgrades
  return {
    state,
    active: state === 'war' ? war : state === 'peace' ? peace : [],
    inactive: state === 'war' ? peace : state === 'peace' ? war : [...war, ...peace],
    inactiveState: state === 'war' ? 'peace' : state === 'peace' ? 'war' : null,
    core: Array.isArray(coreList) ? coreList.map(readUpgrade) : [],
  }
}
