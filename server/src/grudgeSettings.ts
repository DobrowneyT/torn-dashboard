// Book of Grudges settings (#889, slice 6): severities and watched factions.
//
// ⚠️ Both are FACTION SETTINGS, never enums in code. Factions will want their
// own vocabulary for how badly somebody wronged them, and a hardcoded
// Low/Medium/High would be wrong for them and considerably less fun. The
// watched-faction list is leadership policy for the same reason — our own
// faction, the family, allies, whoever else they name.

export interface Severity { id: string; label: string }

/** A stable, url-safe id derived from a label. */
export function slugify(label: string): string {
  return String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export type SeverityResult =
  | { ok: true; severities: Severity[] }
  | { ok: false; error: string }

/**
 * Validate and normalise a submitted severity list.
 *
 * ⚠️ **An existing id is kept, never re-derived from the label.** Renaming
 * "Petty" to "Mildly annoying" must not change its id, because
 * `grudge_entries.severity_id` points at it — re-slugging on every save would
 * orphan every grudge that used the old name, and the column would quietly
 * start rendering a raw slug instead of a label.
 *
 * ⚠️ Order is the ARRAY order. A separate `order` field is a second source of
 * truth for the same fact, and they drift.
 */
export function normaliseSeverities(input: unknown): SeverityResult {
  if (!Array.isArray(input)) return { ok: false, error: 'severities must be a list' }
  if (input.length > 20) return { ok: false, error: 'at most 20 severities' }

  const out: Severity[] = []
  const seenIds = new Set<string>()
  const seenLabels = new Set<string>()

  for (const raw of input) {
    const label = String((raw as any)?.label ?? '').trim()
    if (!label) return { ok: false, error: 'every severity needs a label' }
    if (label.length > 60) return { ok: false, error: `"${label.slice(0, 20)}…" is too long` }

    const lower = label.toLowerCase()
    if (seenLabels.has(lower)) return { ok: false, error: `"${label}" appears twice` }
    seenLabels.add(lower)

    // Keep a supplied id; only mint one for a genuinely new row.
    const supplied = String((raw as any)?.id ?? '').trim()
    let id = supplied || slugify(label)
    if (!id) return { ok: false, error: `"${label}" produces no usable id` }
    // ⚠️ Two different labels can slug to the same id ("Blood feud" and
    // "blood-feud"). Left alone, the second would silently overwrite the
    // first's meaning for every grudge pointing at that id.
    if (seenIds.has(id)) {
      if (supplied) return { ok: false, error: `duplicate severity id "${id}"` }
      let n = 2
      while (seenIds.has(`${id}-${n}`)) n += 1
      id = `${id}-${n}`
    }
    seenIds.add(id)
    out.push({ id, label })
  }
  return { ok: true, severities: out }
}

export type WatchedResult =
  | { ok: true; factions: string[] }
  | { ok: false; error: string }

/**
 * Validate a watched-faction list.
 *
 * ⚠️ Stored as STRINGS. Torn sends faction ids as numbers and the column is
 * text; a mixed-type comparison matches nothing, which here would mean an
 * own-faction target sailing onto the public list.
 */
export function normaliseWatchedFactions(input: unknown): WatchedResult {
  if (!Array.isArray(input)) return { ok: false, error: 'watched factions must be a list' }
  if (input.length > 50) return { ok: false, error: 'at most 50 watched factions' }
  const out: string[] = []
  for (const raw of input) {
    const id = String(raw ?? '').trim()
    if (!/^\d+$/.test(id)) return { ok: false, error: `"${id}" is not a faction id` }
    if (!out.includes(id)) out.push(id)
  }
  return { ok: true, factions: out }
}

/** Severity ids that disappeared between the stored list and the new one. */
export function removedSeverityIds(before: Severity[], after: Severity[]): string[] {
  const keep = new Set(after.map((s) => s.id))
  return before.map((s) => s.id).filter((id) => !keep.has(id))
}
