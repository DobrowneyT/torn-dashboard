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
export const LOADOUT_STALE_MS = 60 * 60 * 1000 // 1 hour

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

/** Is this observation past the staleness threshold? */
export function isLoadoutStale(row, nowMs = Date.now()) {
  const at = parseDbTime(row?.observed_at ?? row?.updated_at)
  if (!at) return true
  return nowMs - at.getTime() > LOADOUT_STALE_MS
}
