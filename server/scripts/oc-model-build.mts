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

/**
 * Corrections neither source can supply on its own — see the `_readme` in the
 * file itself for the two entry kinds and why they are recorded rather than
 * derived.
 *
 * ⚠️ Read from the repo, NOT from a flag. Everything else this script consumes
 * is a capture of somebody else's data that we re-take when it changes; this is
 * OUR findings about how those two captures line up, and it has to travel with
 * the code that depends on it or a rebuild silently drops every correction.
 */
const overrides = JSON.parse(
  readFileSync(join(here, '..', 'src', 'oc', 'model-overrides.json'), 'utf8')
) as Record<string, {
  aliasEndings?: Record<string, string>
  rewardFrom?: Record<string, string>
  disputedKind?: Record<string, 'good' | 'bad'>
  disputedSuccessChance?: number
}>

mkdirSync(outDir, { recursive: true })
// Rebuild from scratch so a scenario Torn removed disappears from the diff
// rather than lingering as an orphan nobody notices.
for (const f of readdirSync(outDir)) if (/\.(json|mmd)$/.test(f)) rmSync(join(outDir, f))

const index: Array<{ slug: string; name: string }> = []
let rewarded = 0, skipped = 0, unparsed = 0, aliased = 0, disputed = 0
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
  const over = overrides[slug] ?? {}
  const rewardFrom = over.rewardFrom ?? {}
  // ⚠️ A hub ending named as somebody else's source is CONSUMED by that mapping.
  // Without this, Counter Offer's hub `goodEnding4` would be joined twice — once
  // correctly onto our goodEnding6, and once by name onto our goodEnding4, which
  // is the starved ending the mapping exists to take it away from.
  const claimed = new Set(Object.values(rewardFrom))
  const endings = (s.endings ?? []).map((e: any) => {
    const hubKey = rewardFrom[e.ending_key]
      ?? (claimed.has(e.ending_key) ? null : e.ending_key)
    const f = hubKey === null ? undefined : facts?.endings?.[hubKey]
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
      /** Set below for a surplus label folded onto a terminal it shares. */
      aliasOf: null as string | null,
      /**
       * What CRIMES HUB says this ending's kind is, when it disagrees with the
       * probability service — never what we have decided it is.
       *
       * ⚠️ `kind` above is deliberately left alone. Adopting the other source's
       * answer would replace one confident classification with another, and on
       * Counter Offer the source doing the disagreeing has marked both endings
       * with its own '?'. This field exists so the page can SHOW the conflict.
       */
      disputedKind: null as 'good' | 'bad' | null,
      reward,
    }
  })

  for (const key of Object.keys(facts?.endings ?? {})) {
    // A key some ending claims through `rewardFrom` is joined, not orphaned —
    // it simply does not carry the name of the ending it belongs to.
    if (claimed.has(key)) continue
    if (!(s.endings ?? []).some((e: any) => e.ending_key === key)) orphans.push(`${slug}/${key}`)
  }

  /**
   * Surplus API ending labels folded onto the terminal they actually share.
   *
   * ⚠️ Applied AFTER the reward join, and it deliberately does not copy the
   * target's reward: the alias and its target are the same outcome reported
   * twice, so they price from the same NODE observations, which is where the
   * money comes from. Copying the published reward too would double-count
   * nothing and merely invent a second claim about one ending.
   *
   * ⚠️ `starved` goes false because the ending is no longer starved — it has a
   * terminal. Leaving it true would keep #473's priced-at-$0-by-definition
   * rule in force and the alias would change nothing at all.
   */
  for (const [aliasKey, targetKey] of Object.entries(over.aliasEndings ?? {})) {
    const alias = endings.find((e) => e.key === aliasKey)
    const target = endings.find((e) => e.key === targetKey)
    if (!alias || !target) {
      throw new Error(
        `model-overrides.json: ${slug} aliases ${aliasKey} -> ${targetKey}, but ` +
        `${!alias ? aliasKey : targetKey} is not an ending on that scenario`
      )
    }
    if (!target.nodeId) {
      throw new Error(
        `model-overrides.json: ${slug} aliases ${aliasKey} onto ${targetKey}, which has no node`
      )
    }
    alias.nodeId = target.nodeId
    alias.resolved = true
    alias.starved = false
    alias.problem = null
    alias.aliasOf = targetKey
    aliased += 1
  }

  for (const [key, kind] of Object.entries(over.disputedKind ?? {})) {
    const e = endings.find((x) => x.key === key)
    if (!e) {
      throw new Error(`model-overrides.json: ${slug} disputes ${key}, which is not an ending on that scenario`)
    }
    if (e.kind === kind) {
      throw new Error(
        `model-overrides.json: ${slug} records ${key} as disputed-${kind}, but that is ` +
        `already its kind — a dispute has to be a disagreement`
      )
    }
    e.disputedKind = kind
    disputed += 1
  }

  const doc = {
    name: s.name,
    slug,
    parameterCount: s.parameter_count,
    isComplete: s.is_complete,
    /** ⚠️ How many paths TORNPROBABILITY observed, not us — global game data,
     *  which is why it travels with the model rather than staying per-tenant.
     *  The Simulator renders it as "N observed paths". */
    observedPaths: s.observed_paths == null ? null : Number(s.observed_paths),
    /**
     * What Crimes Hub's model makes this crew's success chance, where the two
     * services disagree about how some endings are classified (#606).
     *
     * ⚠️ Captured at a SPECIFIC crew — all CPRs at 75 — so it is a second
     * opinion to display beside ours at the same crew, never a figure to
     * recompute from or to substitute for the live one. `null` on every
     * scenario where the two agree, which is all but one.
     */
    disputedSuccessChance: over.disputedSuccessChance ?? null,
    diagramValid: s.diagram_valid,
    diagramProblems: s.diagram_problems ?? null,
    roles: (s.roles ?? []).map((r: any) => ({
      positionId: r.position_id,
      roleName: r.role_name,
      weight: Number(r.weight),
    })),
    endings,
    /**
     * Per-node money/respect/item aggregates (#606 slice 3).
     *
     * ⚠️ These are tornprobability's GLOBAL aggregates, not any faction's own
     * results — `oc-scenarios-mirror` wrote them straight from the upstream
     * feed's `stats` frame. That is what makes them model data rather than
     * tenant data, and it is why dropping the mirror table without carrying
     * them here would have silently stripped the payout, E(x) and success
     * figures the Simulator renders per node.
     *
     * ⚠️ `n` is the observation count and MUST survive: an average from one
     * run looks exactly like an average from six thousand, and the largest
     * node in the live feed carries 20,129.
     *
     * A faction's OWN observations stay in its container's database and are
     * layered over this at read time — MonChoon, 2026-09-07: "I don't think it
     * should be tied to any specific stats from a faction's actual results,
     * that can be something separate."
     */
    nodeStats: (s.node_stats ?? []).map((n: any) => ({
      nodeId: n.node_id,
      n: Number(n.n) || 0,
      money: {
        min: n.money_min == null ? null : Number(n.money_min),
        max: n.money_max == null ? null : Number(n.money_max),
        avg: n.money_avg == null ? null : Number(n.money_avg),
      },
      respect: {
        min: n.respect_min == null ? null : Number(n.respect_min),
        max: n.respect_max == null ? null : Number(n.respect_max),
        avg: n.respect_avg == null ? null : Number(n.respect_avg),
      },
      items: n.items ?? [],
    })),
    roleFidelity: s.role_fidelity_error == null
      ? null
      : { error: Number(s.role_fidelity_error), roles: s.role_fidelity_roles ?? null },
    /** ⚠️ Field-level provenance (#606 acceptance). Which source supplied what,
     *  so a Crimes Hub figure never reads as one of our own observations. */
    sources: {
      structure: 'tornprobability',
      roles: 'tornprobability',
      rewards: facts ? 'crimeshub' : null,
      nodeStats: 'tornprobability',
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
console.log(`  aliased onto a shared terminal: ${aliased}`)
console.log(`  disputed classification:       ${disputed}`)
if (orphans.length) {
  console.log(`\n⚠️  ${orphans.length} Crimes Hub ending(s) have NO counterpart in our model and were dropped.`)
  console.log('   Our upstream reports only good endings for some crimes while Crimes Hub draws the')
  console.log('   bad ones. Merging them needs the graph structure — slice 2 of #606.')
  console.log(`   ${orphans.join(' ')}`)
}
