/**
 * Choosing which crimes the simulator shows, and in what order (#445).
 *
 * MonChoon: *"allow me to select the crimes in order that I want to display on
 * the simulator page. So, checking them one at a time and it enumerates them as
 * I am checking them off."*
 *
 * ⚠️ Selection ORDER is the display order, and it is a deliberate user choice.
 * Nothing here may quietly re-sort it alphabetically or by difficulty — that
 * would silently discard the one piece of intent the picker exists to capture.
 */
import { config } from '../config'
import { makeCategoryResolver } from './ocPlanner'

/** Hardest first: the order the picker's groups are rendered in. */
export const CATEGORY_ORDER = ['elaborate', 'advanced', 'intermediate', 'simple', 'introductory']

/**
 * Group mirrored scenarios by difficulty category, for the picker.
 *
 * Reuses the Planner's resolver rather than re-deriving from difficulty:
 * difficulty 8 spans both Advanced and Elaborate, so the crime NAME is
 * authoritative and only unknown names fall back to the number. Re-deriving
 * here would put some crimes in a different group than the Planner shows,
 * which is the kind of quiet inconsistency nobody reports and everybody
 * distrusts.
 */
export function groupByCategory(scenarios, { resolver } = {}) {
  const resolve = resolver ?? makeCategoryResolver({
    scenarios: config.ocScenarios || {},
    categories: config.ocCategories || {},
  })

  const groups = new Map()
  for (const key of CATEGORY_ORDER) groups.set(key, [])
  const unknown = []

  for (const s of scenarios ?? []) {
    const key = resolve(s.name, s.difficulty ?? null)
    if (key && groups.has(key)) groups.get(key).push(s)
    // A crime we cannot categorise still has to be pickable. Hiding it would
    // make a mirrored crime invisible with no explanation.
    else unknown.push(s)
  }

  const out = CATEGORY_ORDER
    .filter((key) => groups.get(key).length > 0)
    .map((key) => ({
      key,
      label: config.ocCategories?.[key]?.label ?? key,
      scopeCost: config.ocCategories?.[key]?.scopeCost ?? null,
      crimes: groups.get(key).sort((a, b) => a.name.localeCompare(b.name)),
    }))

  if (unknown.length > 0) {
    out.push({
      key: 'unknown',
      label: 'Uncategorised',
      scopeCost: null,
      crimes: unknown.sort((a, b) => a.name.localeCompare(b.name)),
    })
  }
  return out
}

/**
 * Toggle a crime, preserving the order the others were picked in.
 *
 * Adding appends — the new crime is last, which is what "enumerates them as I
 * am checking them off" means. Removing closes the gap without disturbing
 * anything else's relative order.
 */
export function toggleSelection(selected, name) {
  const list = selected ?? []
  return list.includes(name) ? list.filter((n) => n !== name) : [...list, name]
}

/** 1-based position in the selection, or null when not selected. */
export function selectionIndex(selected, name) {
  const i = (selected ?? []).indexOf(name)
  return i === -1 ? null : i + 1
}

/**
 * Resolve selected names back to scenario objects, in selection order.
 *
 * ⚠️ Names that no longer exist are dropped rather than rendered as blanks. A
 * persisted selection can outlive a crime being renamed or removed upstream,
 * and a card for a crime with no data would be an empty panel with no
 * explanation.
 */
export function selectedScenarios(scenarios, selected) {
  const byName = new Map((scenarios ?? []).map((s) => [s.name, s]))
  return (selected ?? []).map((n) => byName.get(n)).filter(Boolean)
}

/** Selected names that no longer exist upstream, so the UI can say so. */
export function staleSelections(scenarios, selected) {
  const names = new Set((scenarios ?? []).map((s) => s.name))
  return (selected ?? []).filter((n) => !names.has(n))
}

/**
 * Total scope to spawn one of everything selected.
 *
 * The budget question the workspace is for: a set of crimes is only a plan if
 * the faction can afford to spawn it. Returns null when any selected crime has
 * an unknown category, rather than a total that quietly omits one.
 */
export function selectionScopeCost(scenarios, selected, { resolver } = {}) {
  const resolve = resolver ?? makeCategoryResolver({
    scenarios: config.ocScenarios || {},
    categories: config.ocCategories || {},
  })
  const chosen = selectedScenarios(scenarios, selected)
  if (chosen.length === 0) return 0

  let total = 0
  for (const s of chosen) {
    const key = resolve(s.name, s.difficulty ?? null)
    const cost = config.ocCategories?.[key]?.scopeCost
    if (typeof cost !== 'number') return null
    total += cost
  }
  return total
}
