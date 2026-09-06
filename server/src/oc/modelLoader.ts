/**
 * The built-in OC scenario model (#606).
 *
 * ⚠️ **A file, not a table, and that is the whole point.** OC scenario
 * structure is Torn game data: the flowchart for Crane Reaction is identical
 * for every faction on the planet and changes only when Torn ships an update.
 * Mirroring it on a schedule into per-tenant tables spent API budget on a
 * constant and let two tenants disagree about a fact that cannot differ between
 * them — and it only ran where somebody had enabled the job. Measured on the
 * live fleet on 2026-09-06: **three of five tenants had zero scenarios**, so
 * the OC Simulator was simply empty for most factions.
 *
 * Shipped in the image, the model is identical everywhere by construction,
 * needs no network at page load, and arrives with a reviewable diff when it
 * changes. `scripts/oc-model-build.mts` regenerates it.
 *
 * ⚠️ Nothing here reaches the control plane. #609 slice 4 can publish a newer
 * model to `global`, but this file is the FLOOR — a tenant with no
 * `GLOBAL_DATABASE_URL`, or one whose control plane is down, still has a
 * complete model. That is what keeps "killing the admin container leaves every
 * tenant fully functional" true for the Simulator too.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODEL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'model')

/**
 * `Guardian Ángels` → `guardianangels`.
 *
 * ⚠️ NFD-normalised before stripping. Torn really does use U+00C1 in that
 * name, and a naive `[^a-z0-9]` strip yields `guardianngels` — which 404s on
 * the source, so the whole scenario would silently arrive with no rewards.
 */
export function scenarioSlug(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

export type RewardSource = 'crimeshub' | null

export interface OcModelReward {
  /** ⚠️ `null` means "we have no cash figure", NOT "it pays nothing". An
   *  item-paying ending (Crane Reaction) has money null and itemCount set. */
  money: number | null
  respect: number | null
  itemCount: number | null
  /** Crimes Hub's own "?" marker on an ending it is unsure of. */
  uncertain: boolean
}

export interface OcModelEnding {
  key: string
  nodeId: string | null
  kind: 'good' | 'bad'
  resolved: boolean
  problem: string | null
  starved: boolean
  /** ⚠️ `null` when no reward figure is known — either the scenario has no
   *  Crimes Hub coverage, or its shape was not recognised and was deliberately
   *  not guessed at. Absent beats confidently wrong (#441/#473/#351). */
  reward: OcModelReward | null
}

export interface OcModelRole {
  positionId: string
  roleName: string
  weight: number
}

export interface OcScenarioModel {
  name: string
  slug: string
  parameterCount: number
  isComplete: boolean
  diagramValid: boolean
  diagramProblems: unknown
  roles: OcModelRole[]
  endings: OcModelEnding[]
  roleFidelity: { error: number; roles: unknown } | null
  sources: { structure: string; roles: string; rewards: RewardSource }
}

let cache: Map<string, OcScenarioModel> | null = null

/**
 * ⚠️ Lazy and cached. Eager loading at import would make every test file that
 * touches anything in `oc/` pay a 400KB parse it does not use, and would make
 * a single malformed file break module loading everywhere rather than one
 * call site.
 */
export function loadOcModel(dir = MODEL_DIR): Map<string, OcScenarioModel> {
  if (cache) return cache
  const byName = new Map<string, OcScenarioModel>()
  if (!existsSync(dir)) {
    console.warn(`[oc-model] ${dir} is missing — the built-in scenario model is unavailable`)
    cache = byName
    return byName
  }
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file === 'index.json') continue
    try {
      const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as OcScenarioModel
      byName.set(doc.name, doc)
    } catch (e) {
      // ⚠️ One bad file must not take the rest down. A model that is 30/31
      // complete still runs the Simulator; a throw here would blank it.
      console.error(`[oc-model] skipping ${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  cache = byName
  return byName
}

export function getScenario(name: string, dir?: string): OcScenarioModel | undefined {
  return loadOcModel(dir).get(name)
}

export function scenarioNames(dir?: string): string[] {
  return [...loadOcModel(dir).keys()].sort()
}

/**
 * The mermaid source, read on demand.
 *
 * ⚠️ Kept out of the JSON and out of the cache: it is ~28KB per scenario and
 * ~1.1MB in total, against 400KB for everything else put together. Inlining it
 * would triple the boot cost for a field only the ending-map tooling and the
 * scenario detail view ever read — and would turn every refresh into a
 * one-line diff nobody can review, which is most of why this is a file at all.
 */
export function scenarioDiagram(slug: string, dir = MODEL_DIR): string | null {
  const path = join(dir, `${slug}.mmd`)
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

/** Test seam — drops the memoised model. */
export function resetOcModelCache(): void {
  cache = null
}
