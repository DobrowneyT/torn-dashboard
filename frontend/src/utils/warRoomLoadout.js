/**
 * Enemy loadout observation formatting (#528 Part 2).
 *
 * The War Room shows the LATEST observed loadout per target with its age
 * (#528's own acceptance criterion) — a hover/tooltip on the existing Flags
 * column (see warRoomFlags.js) rather than a new column, since a loadout is
 * "have we ever seen this" information for most of a war (sparse — only
 * targets someone has actually fought), not a per-row constant like Flags'
 * other entries.
 */
import { fmtAgo, parseDbTime } from './time'

export const WEAPON_SLOT_LABELS = {
  primary: 'Primary',
  secondary: 'Secondary',
  melee: 'Melee',
  temporary: 'Temp',
}

export const ARMOR_SLOT_LABELS = {
  helmet: 'Helmet',
  chest: 'Chest',
  pants: 'Pants',
  boots: 'Boots',
  gloves: 'Gloves',
}

const SLOT_ORDER = [
  ['weapons', WEAPON_SLOT_LABELS],
  ['armor', ARMOR_SLOT_LABELS],
]

/**
 * A stale loadout shown confidently is worse than none (#528's own warning).
 * Past this age the flag switches tone rather than hiding — old intel still
 * has some value, it just should not read as "this is what they have right
 * now".
 */
export const LOADOUT_FRESH_MS = 2 * 60 * 60 * 1000    // 2 hours
export const LOADOUT_STALE_MS = 24 * 60 * 60 * 1000   // 1 day

/**
 * How much to trust an observation, as three bands rather than a yes/no.
 *
 * A single boolean made a 61-minute-old observation and a week-old one look
 * identical, which is the wrong shape for gear: within a war, what someone was
 * wearing two hours ago is almost certainly still true, while yesterday's is a
 * hint at best. The bands are what the icon colours.
 *
 *   fresh  (< 2h)     green  — act on it
 *   aging  (2h–24h)   amber  — probably still right, check if it matters
 *   stale  (> 24h)    grey   — a hint, not a fact
 *
 * An unreadable or absent timestamp is 'stale': the honest answer when we
 * cannot date an observation is the least confident one.
 */
export function loadoutFreshness(row, nowMs = Date.now()) {
  const at = parseDbTime(row?.observed_at ?? row?.updated_at)
  if (!at) return 'stale'
  const age = nowMs - at.getTime()
  if (age < LOADOUT_FRESH_MS) return 'fresh'
  if (age < LOADOUT_STALE_MS) return 'aging'
  return 'stale'
}

/**
 * The four injectables (#616).
 *
 * MonChoon: fighters "roll" needles — inject, fight, switch, inject again — so
 * three or four are active at once and the temp SLOT shows only whichever was
 * loaded at the instant we looked.
 *
 * ⚠️ Which needle is therefore not worth reporting; that a target uses them at
 * all is. And absence proves nothing: an empty temp slot means "not caught
 * mid-injection", never "does not use needles". The UI must never render a
 * negative from it.
 */
export const INJECTABLES = ['Epinephrine', 'Melatonin', 'Serotonin', 'Tyrosine']

/** Was a needle in the temp slot when we looked? Absence is NOT evidence. */
export function usesNeedles(loadout) {
  const temp = loadout?.weapons?.temporary?.name
  return typeof temp === 'string' && INJECTABLES.includes(temp.trim())
}

/**
 * Is this weapon one worth a lead's attention (#616)?
 *
 * ⚠️ Rarity is Torn's own quality glow, NOT item circulation. An earlier
 * analysis here proposed `circulation < 5000`, which measures how many exist
 * and tracks quality only by accident. MonChoon: "'rare' isn't about the number
 * of items in circulation, it's about the quality of the item itself."
 *
 * ⚠️ `glow` and `colour` are stored as observed and deliberately not resolved
 * into a tier — one capture showed a weapon carrying both (`glow-yellow` plus
 * `orange`), and which is authoritative is unsettled. So "notable" is the
 * honest question we CAN answer: anything Torn does not paint as default, or
 * anything carrying a bonus.
 */
export function isNotableWeapon(entry) {
  if (!entry) return false
  if (Array.isArray(entry.bonuses) && entry.bonuses.length > 0) return true
  for (const token of [entry.glow, entry.colour]) {
    if (typeof token === 'string' && token && token !== 'default') return true
  }
  return false
}

/**
 * Flat "Primary: AK-47, Chest: Combat Vest" list, in a stable slot order.
 *
 * ⚠️ Armour carries no quality signal at all — Torn renders it as `<area
 * title>` names inside the body model, with no glow class and no bonuses — so
 * every armour entry is `notable: false` and armour is listed in full. That is
 * MonChoon's call too: "for armour... just keep listing all of their armour",
 * with a rare-armour list a later, hard-coded follow-up.
 */
export function loadoutEntries(loadout) {
  const out = []
  for (const [group, labels] of SLOT_ORDER) {
    const bySlot = loadout?.[group]
    if (!bySlot) continue
    for (const [slot, label] of Object.entries(labels)) {
      const entry = bySlot[slot]
      if (!entry?.name) continue
      out.push({
        slot,
        label,
        name: entry.name,
        itemId: entry.item_id ?? null,
        group,
        bonuses: Array.isArray(entry.bonuses) ? entry.bonuses : [],
        glow: entry.glow ?? null,
        colour: entry.colour ?? null,
        // ⚠️ #929 — carried but NOT rendered anywhere yet, on purpose. MonChoon:
        // "I would still record dmg/acc in case we ever decide to display it".
        // Surfacing them here rather than only in the DB is what makes that a
        // one-line change later instead of a re-plumb.
        damage: typeof entry.damage === 'number' ? entry.damage : null,
        accuracy: typeof entry.accuracy === 'number' ? entry.accuracy : null,
        notable: group === 'weapons' && isNotableWeapon(entry),
      })
    }
  }
  return out
}

/**
 * The same entries, notable weapons first (#616).
 *
 * ⚠️ Sorted, never filtered. MonChoon chose "default on, collapsible": the
 * ordinary gear stays reachable behind a toggle rather than being dropped, so a
 * lead can still tell "genuinely unarmoured" from "not captured yet" — a
 * distinction a hard filter destroys.
 *
 * The sort is STABLE within each band, so slot order is preserved.
 */
export function rankedLoadoutEntries(loadout) {
  const entries = loadoutEntries(loadout)
  const notable = entries.filter((e) => e.notable)
  return { notable, ordinary: entries.filter((e) => !e.notable), all: [...notable, ...entries.filter((e) => !e.notable)] }
}

/** Multi-line tooltip text for the loadout flag — slots, who saw it, when. */
export function formatLoadoutTooltip(row, nowMs = Date.now()) {
  if (!row?.loadout) return ''
  const entries = loadoutEntries(row.loadout)
  if (entries.length === 0) return ''
  const lines = entries.map((e) => {
    // ⚠️ Bonuses are appended to the weapon that carries them rather than
    // listed separately: a special is a property of that specific item
    // instance, and "Assassinate" on its own line says nothing about which
    // weapon will hit you with it.
    const bonuses = e.bonuses.length > 0 ? ` (${e.bonuses.map((b) => b.title).join(', ')})` : ''
    return `${e.label}: ${e.name}${bonuses}`
  })
  if (usesNeedles(row.loadout)) lines.push('⚠ Seen using needles — assume buffed')
  const who = row.observed_by_name ? ` by ${row.observed_by_name}` : ''
  lines.push(`Observed ${fmtAgo(row.observed_at ?? row.updated_at, nowMs)}${who}`)
  return lines.join('\n')
}

/**
 * Is this observation past the staleness threshold?
 *
 * Kept as the two-way question for callers that only need "can I show this
 * confidently" — it is now the third band of loadoutFreshness(), so the two
 * can never disagree about where the line sits.
 */
export function isLoadoutStale(row, nowMs = Date.now()) {
  return loadoutFreshness(row, nowMs) === 'stale'
}

/**
 * The percentage a bonus description is really about.
 *
 * ⚠️ **The first NON-NEGATIVE percentage anywhere in the string**, which is a
 * rule measured against 1,301 real captures rather than guessed. The first
 * version anchored to the start and lost the four specials that matter most:
 *
 *   "Eviscerates opponent causing them 15% extra damage…"   → 15
 *   "Ignores 26% of armor mitigation"                        → 26   (Penetrate)
 *   "Life regenerated by 10% of damage dealt"                → 10   (Bloodlust)
 *   "Instantly defeats a target if they're below 15% life"   → 15   (Execute)
 *
 * ⚠️ **Negative percentages are SKIPPED because they are penalties, not the
 * bonus.** This is the whole reason the rule is not simply "the first
 * percentage": in production, `+1.75 Accuracy -30% Dexterity` and
 * `+4 stealth, -5% damage` both lead with a cost, and reporting "30%" for a
 * Dexterity penalty would advertise a drawback as a benefit.
 *
 *   "+1.75 Accuracy -30% Dexterity"   → null
 *   "+4 stealth, -5% damage"          → null
 *   "+1.50 Accuracy"                  → null  (no percentage at all)
 *
 * ⚠️ **The FIRST, not the largest.** "37% chance to Burn opponent causing 90%
 * damage over 3 turns" is a 37% proc, and 90% is what it does when it lands.
 *
 * ⚠️ Still not a proc chance by nature — a chance on "37% chance to Burn", a
 * magnitude on "16% increased damage". That is why the description is kept
 * stored beside it rather than replaced by it.
 */
export function bonusPercentFromDescription(description) {
  const text = String(description ?? '')
  for (const m of text.matchAll(/([+-]?)(\d+(?:\.\d+)?)%/g)) {
    if (m[1] === '-') continue
    const n = Number(m[2])
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * One weapon's bonuses as a single comma-delimited line (#929).
 *
 *   "Focus 16%, 30mW Laser 4%, Reflex Sight"
 *
 * MonChoon, 2026-10-09: *"lets just show the weapons, and then the bonuses
 * underneath that, comma-delimited"*.
 *
 * ⚠️ **A bonus with no percentage renders as its bare title.** Disarm carries
 * no figure at all and attachments are frequently flat values ("+1.00
 * Accuracy"), so appending a percentage unconditionally would print
 * "Disarm undefined%" on a real capture. Absent, never zero — a bonus shown as
 * "0%" reads as useless rather than unmeasured.
 *
 * ⚠️ **Specials and attachments are mixed together**, because Torn's DOM does
 * not distinguish them: Burn and Reflex Sight are the same markup with the same
 * attributes. The only discriminator is which side of the slot's `topMarker`
 * they sit on, which the capture does not record. Shown as Torn presented them
 * rather than filtered against a hard-coded specials list that would silently
 * drop whatever Torn adds next.
 *
 * Returns '' when there is nothing to say, so a caller can skip the row
 * entirely rather than render an empty line under every ordinary weapon.
 */
export function formatBonusLine(bonuses) {
  if (!Array.isArray(bonuses) || bonuses.length === 0) return ''
  return bonuses
    .map((b) => {
      const title = String(b?.title ?? '').trim()
      if (!title) return ''
      // ⚠️ Prefer what the capture RECORDED, then fall back to deriving it from
      // the description. The fallback is what makes a month of existing
      // observations show percentages at all: 1,301 forge captures carry
      // descriptions and no `percent`, because that field only arrives with
      // userscript 1.52.0. Without this they would stay bare titles until every
      // member updated, for data we already hold.
      const pct = typeof b?.percent === 'number' && Number.isFinite(b.percent)
        ? b.percent
        : bonusPercentFromDescription(b?.description)
      return pct === null ? title : `${title} ${pct}%`
    })
    .filter(Boolean)
    .join(', ')
}
