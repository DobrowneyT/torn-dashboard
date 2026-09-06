/**
 * Build the committed OC scenario model (#606).
 *
 * ⚠️ **A maintainer script, run by hand, whose OUTPUT is committed.** Nothing at
 * runtime fetches any of this. OC scenario structure is Torn game data — the
 * flowchart for Crane Reaction is identical for every faction on the planet and
 * changes only when Torn ships an update, perhaps a few times a year. Mirroring
 * it on a schedule, per tenant, spent API budget and scraper slots on a
 * constant, and let two tenants disagree about a fact that cannot differ
 * between them. Worse, it only ran where somebody remembered to enable the job:
 * measured on 2026-09-06, three of five live tenants had **zero** scenarios.
 *
 *   npm run oc:model:build -- --export <tenant-export.json> --crimeshub <facts.json>
 *
 * `--export` is the model as mirrored from tornprobability, dumped from a
 * populated tenant. `--crimeshub` is the reward facts extracted from Crimes
 * Hub (permission granted by its author, recorded on #606).
 *
 * ⚠️ Two sources, deliberately not interchangeable, and the file records which
 * gave what:
 *   tornprobability → the graph, ending probabilities, successChance, weights
 *   Crimes Hub      → per-ending money, respect and item counts
 * Crimes Hub carries no success probabilities at all, so it cannot replace the
 * first; tornprobability carries no payouts, so it cannot replace the second.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { scenarioSlug } from '../src/oc/modelLoader.js'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(here, '..', 'src', 'oc', 'model')

interface Reward {
  money: number | null
  respect: number | null
  itemCount: number | null
  /** ⚠️ The reward IS the next crime: Stacking the Deck pays by spawning Ace in
   *  the Hole. Valuing such an ending needs the chain maths in ocChains.js
   *  (#585), not a figure here — so money stays null rather than 0. */
  chainsTo: string | null
  /** Crimes Hub's own "?" marker on an ending it is unsure of. Preserved. */
  uncertain: boolean
}

const { values: args } = parseArgs({
  options: { export: { type: 'string' }, crimeshub: { type: 'string' }, out: { type: 'string' } },
})
if (!args.export) {
  console.error('Usage: oc-model-build.mts --export <tenant-export.json> [--crimeshub <facts.json>]')
  process.exit(2)
}

const outDir = args.out ?? OUT_DIR
const scenarios = JSON.parse(readFileSync(args.export, 'utf8')) as any[]
const hub = args.crimeshub ? JSON.parse(readFileSync(args.crimeshub, 'utf8')) : {}

mkdirSync(outDir, { recursive: true })
// Rebuild from scratch so a scenario Torn removed disappears from the diff
// rather than lingering as an orphan nobody notices.
for (const f of readdirSync(outDir)) if (/\.(json|mmd)$/.test(f)) rmSync(join(outDir, f))

const index: Array<{ slug: string; name: string }> = []
let rewarded = 0, skipped = 0, unparsed = 0
/** ⚠️ Crimes Hub terminals with no counterpart in our mirrored model. These are
 *  DROPPED, and the count is reported because it is a real gap rather than a
 *  rounding error: seven scenarios (Counter Offer, Window of Opportunity, Ace
 *  in the Hole and others) have zero bad endings in our data while Crimes Hub
 *  draws them. Merging those terminals in needs the graph structure, so it is
 *  slice 2 — but a silent drop would let the gap look like it does not exist. */
const orphans: string[] = []

for (const s of scenarios) {
  const slug = scenarioSlug(s.name)
  const facts = hub[slug]
  const endings = (s.endings ?? []).map((e: any) => {
    const f = facts?.endings?.[e.ending_key]
    let reward: Reward | null = null
    if (f && !f.unparsed) {
      reward = {
        money: f.money ?? null,
        respect: f.respect ?? null,
        itemCount: f.itemCount ?? null,
        chainsTo: f.chainsTo ?? null,
        uncertain: !!f.uncertain,
      }
      rewarded += 1
    } else if (f?.unparsed) {
      // ⚠️ Left NULL on purpose. A shape the extractor did not recognise is a
      // shape we do not understand, and publishing a guess for it would put a
      // fabricated payout in a committed file — strictly worse than an absent
      // one, which the simulator already reports as unpriced (#441/#473).
      unparsed += 1
    } else {
      skipped += 1
    }
    return {
      key: e.ending_key,
      nodeId: e.node_id,
      kind: e.kind,
      resolved: e.resolved,
      problem: e.problem ?? null,
      starved: e.starved ?? false,
      reward,
    }
  })

  for (const key of Object.keys(facts?.endings ?? {})) {
    if (!(s.endings ?? []).some((e: any) => e.ending_key === key)) orphans.push(`${slug}/${key}`)
  }

  const doc = {
    name: s.name,
    slug,
    parameterCount: s.parameter_count,
    isComplete: s.is_complete,
    diagramValid: s.diagram_valid,
    diagramProblems: s.diagram_problems ?? null,
    roles: (s.roles ?? []).map((r: any) => ({
      positionId: r.position_id,
      roleName: r.role_name,
      weight: Number(r.weight),
    })),
    endings,
    roleFidelity: s.role_fidelity_error == null
      ? null
      : { error: Number(s.role_fidelity_error), roles: s.role_fidelity_roles ?? null },
    /** ⚠️ Field-level provenance (#606 acceptance). Which source supplied what,
     *  so a Crimes Hub figure never reads as one of our own observations. */
    sources: {
      structure: 'tornprobability',
      roles: 'tornprobability',
      rewards: facts ? 'crimeshub' : null,
    },
  }

  // ⚠️ The diagram lives in its own .mmd file. It is ~28KB of mermaid per
  // scenario — 90% of the payload — and inlining it as a JSON string makes
  // every refresh an unreadable one-line diff, which defeats the whole point of
  // committing this rather than scheduling it.
  if (s.diagram) writeFileSync(join(outDir, `${slug}.mmd`), s.diagram.endsWith('\n') ? s.diagram : s.diagram + '\n')
  writeFileSync(join(outDir, `${slug}.json`), JSON.stringify(doc, null, 2) + '\n')
  index.push({ slug, name: s.name })
}

index.sort((a, b) => a.name.localeCompare(b.name))
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n')

console.log(`wrote ${index.length} scenarios to ${outDir}`)
console.log(`  endings with rewards:  ${rewarded}`)
console.log(`  no Crimes Hub data:    ${skipped}`)
console.log(`  unparsed (left null):  ${unparsed}`)
if (orphans.length) {
  console.log(`\n⚠️  ${orphans.length} Crimes Hub ending(s) have NO counterpart in our model and were dropped.`)
  console.log('   Our upstream reports only good endings for some crimes while Crimes Hub draws the')
  console.log('   bad ones. Merging them needs the graph structure — slice 2 of #606.')
  console.log(`   ${orphans.join(' ')}`)
}
