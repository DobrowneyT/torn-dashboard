// #974 — reads mugs, damage and weapon procs out of archived attack logs.
//
// ⚠️ Built from REAL log lines (35 forge logs sampled 2026-10-17), not from
// guesses about Torn's wording. What they showed:
//   * A weapon proc is identified by the line's ICON, not its text. Ordinary
//     lines use a small fixed set (PLAIN_ICONS); anything else names its proc
//     — `attacking-events-stricken`, `-plunder`, `-powerful`, `-execute`… The
//     proc can be its own line ("Stricken increased X's hospital time by
//     68.19%") or the hit line itself (a Powerful hit carries `-powerful`).
//   * ⚠️ So no proc is matched by wording, and Revitalize needs no guessed
//     text: it is counted under whatever icon Torn gives it, from the first real
//     line that carries it — the acceptance criterion's "capture a real proc
//     line before counting it", by construction.
//   * Damage-over-time TICKS ("Bleeding damaged X for 106") carry the proc's
//     icon too. The proc is the line that STARTS it ("X began bleeding"); a
//     tick is neither a proc nor a hit.
//   * ⚠️ Stealthed attackers have `attacker: null` and read "Someone". The
//     identity comes from the stored attack (`attacker_id`), never the text.
//
// Bump PARSER_VERSION whenever the output changes: the archiver re-parses
// every log stored under an older version (#975 will).
//
// v2 (2026-10-17, from ~2,000 real forge logs on staging): drops icons that
// are outcomes or actions rather than effects, credits the two effects the
// TEXT proves are the defender's, and recognises every tick wording.

//
// v3 (2026-10-17): bounties. Claimed only on a hospitalize, on that line:
// "X hospitalized Y and claimed a $100,000 bounty (+3.13)" — the one wording in
// ~2,100 real logs, with or without the respect suffix.

export const PARSER_VERSION = 3

/** Icons on ordinary lines. Anything else on a line is a proc or an effect. */
export const PLAIN_ICONS = new Set([
  'attacking-events-assault', 'attacking-events-critical-hit', 'attacking-events-miss',
  'attacking-events-attack-join', 'attacking-events-hospitalize', 'attacking-events-leave',
  'attacking-events-mug', 'attacking-events-reloading', 'attacking-events-grenade-use',
  'attacking-events-ziro-damage', 'attacking-events-attack-win', 'attacking-events-standart-damage',
])

/**
 * Icons that are not effects at all — an outcome, a loot, a booster, a stance,
 * or a weapon hurting its own user. Evidence, from real lines:
 * `attack-lose` "X lost to Y", `stalemate` "X stalemated with Y", `loot`
 * "X looted 2x Grenade from Y", `booster-use` "X injected a syringe of…",
 * `smash-wait` "X lifts his Sledgehammer off the ground", `windup` "X wound up
 * his Kodachi", `hazadous` "The Nock Gun's recoil damages X", `ziro-damage`
 * zero-damage hits and ineffective sprays.
 */
export const NOT_EFFECTS = new Set([
  'attack-lose', 'stalemate', 'loot', 'booster-use', 'smash-wait', 'windup', 'hazadous', 'ziro-damage',
])

/**
 * Effects the line's TEXT shows belong to the defender, though Torn writes
 * them on the attacker's line: `parry` "X hit Y … but it was parried", and
 * `notouching`, which only ever appears on the attacker's MISSES. ⚠️ Only what
 * the text proves — other armour-looking names (riot, dune, eod) are left with
 * the line's actor rather than guessed at.
 */
export const DEFENDER_EFFECTS = new Set(['parry', 'notouching'])

const ICON_PREFIX = 'attacking-events-'
const HIT_ACTIONS = new Set(['hit', 'critical hit', 'won', 'specialTemp'])
/**
 * A damage-over-time tick, in every wording seen: "Bleeding damaged X for 106",
 * "Severe burning damaged X for 80", "Molotov Cocktail scorches X for 807".
 * ⚠️ v1 matched a one-word name only, so multi-word ticks counted as procs.
 */
const TICK = /\b(damaged|scorches) .+ for [\d,]+$/
/** "… for 1251" at the end of a hit line. */
const DAMAGE = /\bfor ([\d,]+)$/
/** "X mugged Y for $1,791,890 (+2.90)" */
const MUG = /\bmugged .+ for \$([\d,]+)/
/** "X hospitalized Y and claimed a $100,000 bounty (+3.13)" */
const BOUNTY = /\bhospitalized .+ and claimed a \$([\d,]+) bounty\b/
/** The respect gain Torn appends to the finishing line: "(+2.90)". */
const RESPECT = /\(\+([\d.]+)\)\s*$/

const toInt = (s: string) => Number(s.replace(/,/g, ''))

export interface AttackIdentity {
  attacker_id: number | null
  defender_id: number | null
  /** Our member in this attack: the attacker outgoing, the defender incoming. */
  member_id: number | null
  outgoing: boolean
}

export interface ParsedEffect { seq: number; actor_id: number | null; effect: string; text: string }

export interface ParsedLog {
  mug_amount: number | null
  /** A bounty claimed by the attacker on the hospitalize (v3). */
  bounty_amount: number | null
  respect: number | null
  /** Damage our member dealt / took — Torn's own per-participant summary. */
  damage_dealt: number | null
  damage_taken: number | null
  hits: number | null
  misses: number | null
  /** Each of our member's hits, in order. */
  hit_damages: number[]
  biggest_hit: number | null
  effects: ParsedEffect[]
}

function logLines(raw: any): any[] {
  const pages: any[] = Array.isArray(raw?.pages) ? raw.pages : [raw]
  return pages.flatMap((p) => (Array.isArray(p?.attacklog?.log) ? p.attacklog.log : []))
}

function summaries(raw: any): any[] {
  const pages: any[] = Array.isArray(raw?.pages) ? raw.pages : [raw]
  return pages.flatMap((p) => (Array.isArray(p?.attacklog?.summary) ? p.attacklog.summary : []))
}

/**
 * Who did this line? ⚠️ A stealthed attacker is `null`; when the line's
 * defender is the attack's defender, the actor is the attack's attacker.
 */
export function actorOf(line: any, atk: AttackIdentity): number | null {
  const id = line?.attacker?.id
  if (id != null) return Number(id)
  if (line?.defender?.id != null && Number(line.defender.id) === atk.defender_id) return atk.attacker_id
  return null
}

export function parseAttackLog(raw: any, atk: AttackIdentity): ParsedLog {
  const lines = logLines(raw)
  const out: ParsedLog = {
    mug_amount: null, bounty_amount: null, respect: null, damage_dealt: null, damage_taken: null,
    hits: null, misses: null, hit_damages: [], biggest_hit: null, effects: [],
  }

  lines.forEach((line, seq) => {
    const text = String(line?.text ?? '')
    const actor = actorOf(line, atk)
    const icon = String(line?.icon ?? '')
    const tick = TICK.test(text)

    if (line?.action === 'mug') {
      const m = MUG.exec(text)
      if (m && actor === atk.attacker_id) out.mug_amount = toInt(m[1])
    }
    // ⚠️ Only on a hospitalize — never a leave, a mug or anything else.
    if (line?.action === 'hosp') {
      const b = BOUNTY.exec(text)
      if (b && actor === atk.attacker_id) out.bounty_amount = toInt(b[1])
    }
    const r = RESPECT.exec(text)
    if (r && actor === atk.attacker_id) out.respect = Number(r[1])

    if (!tick && HIT_ACTIONS.has(line?.action) && actor != null && actor === atk.member_id) {
      const d = DAMAGE.exec(text)
      if (d) out.hit_damages.push(toInt(d[1]))
    }

    const effect = icon.startsWith(ICON_PREFIX) ? icon.slice(ICON_PREFIX.length) : ''
    if (effect && !PLAIN_ICONS.has(icon) && !NOT_EFFECTS.has(effect) && !tick) {
      const owner = DEFENDER_EFFECTS.has(effect)
        ? (line?.defender?.id != null ? Number(line.defender.id) : null)
        : actor
      out.effects.push({ seq, actor_id: owner, effect, text })
    }
  })

  if (out.hit_damages.length) out.biggest_hit = Math.max(...out.hit_damages)

  if (atk.member_id != null) {
    const sums = summaries(raw)
    const mine = sums.find((s) => s?.id != null && Number(s.id) === atk.member_id)
      // ⚠️ Our member stealthed: their summary row has a null id. With one
      // null row it can only be theirs on an outgoing attack.
      ?? (atk.outgoing ? sums.find((s) => s?.id == null) : undefined)
    if (mine) {
      out.damage_dealt = Number(mine.damage ?? 0)
      out.hits = Number(mine.hits ?? 0)
      out.misses = Number(mine.misses ?? 0)
    }
    const others = sums.filter((s) => s !== mine)
    if (sums.length) out.damage_taken = others.reduce((t, s) => t + Number(s?.damage ?? 0), 0)
  }
  return out
}
