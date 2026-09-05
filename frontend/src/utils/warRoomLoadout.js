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

/** Flat "Primary: AK-47, Chest: Combat Vest" list, in a stable slot order. */
export function loadoutEntries(loadout) {
  const out = []
  for (const [group, labels] of SLOT_ORDER) {
    const bySlot = loadout?.[group]
    if (!bySlot) continue
    for (const [slot, label] of Object.entries(labels)) {
      const entry = bySlot[slot]
      if (entry?.name) out.push({ slot, label, name: entry.name, itemId: entry.item_id ?? null })
    }
  }
  return out
}

/** Multi-line tooltip text for the loadout flag — slots, who saw it, when. */
export function formatLoadoutTooltip(row, nowMs = Date.now()) {
  if (!row?.loadout) return ''
  const entries = loadoutEntries(row.loadout)
  if (entries.length === 0) return ''
  const lines = entries.map((e) => `${e.label}: ${e.name}`)
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
