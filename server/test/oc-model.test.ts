// #606 — the built-in OC scenario model.
//
// ⚠️ The property this file exists to protect is that the dataset can be
// INCOMPLETE but never WRONG. Crimes Hub's reward format has at least six
// shapes and the extractor discovered each one by having a scenario break the
// parser written for the previous ones. A parser that fell through to a default
// recorded Crane Reaction's good endings as paying nothing — a fabricated
// figure in a committed file, which is strictly worse than an absent one. The
// tests below assert that no such figure can be present.
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadOcModel, getScenario, scenarioNames, scenarioDiagram, resetOcModelCache, scenarioSlug,
} from '../src/oc/modelLoader.js'
import { scenarioSlug } from '../src/oc/modelLoader.js'

beforeEach(() => resetOcModelCache())

describe('the committed model', () => {
  it('carries every scenario the mirror held', () => {
    const model = loadOcModel()
    expect(model.size).toBe(31)
    expect(scenarioNames()).toContain('Clinical Precision')
    expect(scenarioNames()).toContain('Window of Opportunity')
  })

  it('⚠️ is identical for every tenant by construction', () => {
    // The failure this replaces: the mirror only ran where somebody had enabled
    // the job, so on 2026-09-06 three of five live tenants held ZERO scenarios
    // and their Simulator was silently empty. A file cannot be absent on some
    // tenants and present on others.
    const a = loadOcModel()
    resetOcModelCache()
    const b = loadOcModel()
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort())
  })

  it('keeps roles with their weights', () => {
    const s = getScenario('Clinical Precision')!
    expect(s.roles).toHaveLength(4)
    expect(s.roles.map((r) => r.roleName).sort())
      .toEqual(['Assassin', 'Cat Burglar', 'Cleaner', 'Imitator'])
    expect(s.roles.every((r) => Number.isFinite(r.weight))).toBe(true)
  })

  it('records field-level provenance', () => {
    // #606 acceptance: a Crimes Hub figure must never read as one of our own
    // observations.
    const withRewards = getScenario('Clinical Precision')!
    expect(withRewards.sources).toMatchObject({ structure: 'tornprobability', rewards: 'crimeshub' })
    const without = [...loadOcModel().values()].find((s) => s.sources.rewards === null)
    expect(without).toBeDefined()
  })
})

describe('⚠️ rewards are absent rather than invented', () => {
  const allEndings = () => [...loadOcModel().values()].flatMap((s) => s.endings)

  it('never records a good ending as paying zero cash with nothing else', () => {
    // THE regression this guards. `money: 0, itemCount: 0` on a GOOD ending is
    // the signature of a parser that fell through to a default — it asserts
    // "this pays nothing", which is never true of a good ending.
    const fabricated = allEndings().filter(
      (e) => e.kind === 'good' && e.reward && e.reward.money === 0 && !e.reward.itemCount
    )
    expect(fabricated).toEqual([])
  })

  it('models an item-paying ending as money null, not money zero', () => {
    // Crane Reaction pays in items: `Good End #1 / 1841 / x3`. Recording 0 there
    // would let the simulator value it at nothing instead of reporting it
    // unpriced (#441).
    const crane = getScenario('Crane Reaction')!
    const g1 = crane.endings.find((e) => e.key === 'goodEnding1')!
    expect(g1.reward).toMatchObject({ money: null, respect: 1841, itemCount: 3 })
  })

  it('leaves a shape it could not parse as null rather than guessing', () => {
    // Gaslight the Way uses ranges (`x14-15`) and probabilistic drops
    // (`x4 (43%)`). Those are deliberately unpublished.
    const gas = getScenario('Gaslight the Way')!
    const unpriced = gas.endings.filter((e) => e.kind === 'good' && e.reward === null)
    expect(unpriced.length).toBeGreaterThan(0)
  })

  it('carries an explicit uncertainty flag on every published reward', () => {
    // Crimes Hub marks endings it is unsure of with a trailing "?" — the
    // author's own confidence signal, not ours to discard. Every reward we
    // publish states its position explicitly rather than leaving the field off,
    // so "certain" is never merely the absence of a flag.
    for (const e of allEndings()) {
      if (e.reward) expect(typeof e.reward.uncertain).toBe('boolean')
    }
  })

  it('⚠️ documents that Crimes Hub terminals we cannot place are DROPPED', () => {
    // Counter Offer is the clearest case: Crimes Hub draws six bad endings —
    // two of them flagged uncertain — and our mirrored model has NONE, because
    // our upstream reports only good endings for that crime. The build reports
    // 23 such orphans across three scenarios and drops them, because placing
    // them needs the graph structure (slice 2).
    //
    // This test exists so the gap is visible in the suite rather than only in
    // build output nobody re-reads. It should be INVERTED when slice 2 lands.
    const counter = getScenario('Counter Offer')!
    expect(counter.endings.every((e) => e.kind === 'good')).toBe(true)
    expect(counter.sources.rewards).toBe('crimeshub')
  })

  it('has no reward figure without a declared source', () => {
    for (const s of loadOcModel().values()) {
      if (s.sources.rewards === null) {
        expect(s.endings.every((e) => e.reward === null)).toBe(true)
      }
    }
  })
})

describe('diagrams', () => {
  it('are read on demand, not held in the model', () => {
    const s = getScenario('Clinical Precision')!
    expect(s).not.toHaveProperty('diagram')
    expect(scenarioDiagram(s.slug)).toContain('flowchart')
  })

  it('returns null for an unknown slug rather than throwing', () => {
    expect(scenarioDiagram('no-such-crime')).toBeNull()
  })
})

describe('scenarioSlug', () => {
  it('⚠️ normalises the accented name Torn actually uses', () => {
    // "Guardian Ángels" carries U+00C1. A naive slug yields `guardianngels`,
    // which 404s — the whole scenario would silently have no rewards.
    expect(scenarioSlug('Guardian Ángels')).toBe('guardianangels')
  })

  it('strips punctuation and spacing', () => {
    expect(scenarioSlug('Cash Me if You Can')).toBe('cashmeifyoucan')
    expect(scenarioSlug("Thou Shalt Not Steal")).toBe('thoushaltnotsteal')
  })
})

describe('resilience', () => {
  it('⚠️ skips a malformed file instead of blanking the model', () => {
    // A model that is 30/31 complete still runs the Simulator; a throw here
    // would take the whole page down for one bad byte.
    const dir = mkdtempSync(join(tmpdir(), 'oc-model-'))
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ name: 'Good One', slug: 'goodone', endings: [], roles: [] }))
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    try {
      const m = loadOcModel(dir)
      expect([...m.keys()]).toEqual(['Good One'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports an absent model directory without throwing', () => {
    expect(loadOcModel('/nonexistent-model-dir').size).toBe(0)
  })
})

describe('⚠️ chain rewards corroborate the observed chain table (#585)', () => {
  // Some crimes pay by spawning the next one, and Crimes Hub renders that
  // crime's NAME where the money would be. Without handling it, "Ace in the
  // Hole" was swallowed as a role label and four good endings read as
  // unparseable.
  //
  // The payoff is bigger than the parse. KNOWN_CHAINS in ocChains.js was
  // derived entirely from our own observed `previous_crime_id` edges; Crimes
  // Hub is a completely independent source, and every edge it reports agrees.
  const CORROBORATED: Record<string, string> = {
    'No Reserve': 'Bidding War',
    'Stacking the Deck': 'Ace in the Hole',
    'Manifest Cruelty': 'Gone Fission',
    'Gone Fission': 'Crane Reaction',
  }

  it('matches KNOWN_CHAINS on every edge it has', () => {
    for (const [parent, child] of Object.entries(CORROBORATED)) {
      const s = getScenario(parent)
      expect(s, `${parent} should be in the model`).toBeDefined()
      const chained = s!.endings.filter((e) => e.reward?.chainsTo)
      expect(chained.length, `${parent} should have chain endings`).toBeGreaterThan(0)
      for (const e of chained) expect(e.reward!.chainsTo).toBe(child)
    }
  })

  it('⚠️ values a chain ending as money null, never zero', () => {
    // The payout is the next crime. Valuing it needs chainedValue() in
    // ocChains.js — recording 0 here would have the simulator price a chain
    // parent at nothing, which is the #585 bug in reverse.
    const deck = getScenario('Stacking the Deck')!
    for (const e of deck.endings.filter((x) => x.reward?.chainsTo)) {
      expect(e.reward!.money).toBeNull()
    }
  })
})

/**
 * The recorded corrections in `model-overrides.json` (#606).
 *
 * ⚠️ Pinned here rather than trusted to the build, because these are the only
 * facts in the model that CANNOT be re-derived. The probe sweep that produced
 * the ending→node mapping ran against tornprobability's live API and no longer
 * runs, and the tenant export carries only its RESULT (resolved/starved), not
 * the per-ending probabilities it decided from. So if a future rebuild silently
 * drops the overrides file, the numbers regress to the ones that were wrong —
 * Blast from the Past back to a firm $111,028,512 where the answer is
 * $122,489,526 — and nothing else in the suite would notice.
 */
describe('model-overrides.json corrections', () => {
  it('folds Blast from the Past’s surplus ending labels onto the terminals they share', () => {
    const m = getScenario('Blast from the Past')
    expect(m, 'Blast from the Past is in the model').toBeTruthy()
    const by = new Map(m!.endings.map((e) => [e.key, e]))

    // Proven against Crimes Hub's own simulator at all-75 CPRs (2026-09-07):
    // its Good End #3 reads 17.78%, which is goodEnding3 + 35 + 310 exactly,
    // and Good End #4 reads 5.93% = goodEnding4 + 45 + 410.
    for (const key of ['goodEnding35', 'goodEnding310']) {
      expect(by.get(key)?.nodeId, key).toBe('_B8S1_')
      expect(by.get(key)?.aliasOf, key).toBe('goodEnding3')
    }
    for (const key of ['goodEnding45', 'goodEnding410']) {
      expect(by.get(key)?.nodeId, key).toBe('_B8S2_')
      expect(by.get(key)?.aliasOf, key).toBe('goodEnding4')
    }
    // ⚠️ The whole point: no longer starved, so #473's priced-at-$0-by-
    // definition rule stops applying and they price from the node instead.
    for (const key of ['goodEnding35', 'goodEnding310', 'goodEnding45', 'goodEnding410']) {
      expect(by.get(key)?.starved, key).toBe(false)
      expect(by.get(key)?.resolved, key).toBe(true)
    }
    // An alias points at a real ending, never at another alias.
    expect(by.get('goodEnding3')?.aliasOf).toBeNull()
    expect(by.get('goodEnding4')?.aliasOf).toBeNull()
  })

  it('puts Counter Offer’s published reward on the ending the observations identify', () => {
    const m = getScenario('Counter Offer')
    const by = new Map(m!.endings.map((e) => [e.key, e]))
    // Crimes Hub's goodEnding4 has respect 122; node _B5S_ — which the API
    // calls goodEnding6 — is observed at 120. Joined by key name it landed on
    // our goodEnding4 instead: the one starved ending on the crime, and so the
    // only one with no observation to check it against.
    expect(by.get('goodEnding6')?.nodeId).toBe('_B5S_')
    expect(by.get('goodEnding6')?.reward?.respect).toBe(122)
    // ⚠️ And it is not ALSO left on the ending that merely shares its name.
    expect(by.get('goodEnding4')?.reward).toBeNull()
  })

  it('⚠️ aliases nothing that the overrides file does not name', () => {
    // The file is a list of exceptions, each with its evidence written down. A
    // change that started folding endings together generally would show up here
    // as a count nobody accounted for.
    const aliased: string[] = []
    for (const m of loadOcModel().values()) {
      for (const e of m.endings) if (e.aliasOf) aliased.push(`${m.slug}/${e.key}`)
    }
    expect(aliased.sort()).toEqual([
      'blastfromthepast/goodEnding310',
      'blastfromthepast/goodEnding35',
      'blastfromthepast/goodEnding410',
      'blastfromthepast/goodEnding45',
    ])
  })
})

/**
 * The recorded success/failure dispute (#606).
 *
 * ⚠️ This is the one correction the model deliberately does NOT apply. Counter
 * Offer's goodEnding4 and goodEnding5 are counted as successes by the
 * probability service and drawn as failures by Crimes Hub, and both models sum
 * to 100% — so adopting either answer would replace one confident number with
 * another. The dispute is recorded and shown instead.
 */
describe('disputed classifications', () => {
  it('records Counter Offer’s two contested endings without adopting the other answer', () => {
    const m = getScenario('Counter Offer')
    const by = new Map(m!.endings.map((e) => [e.key, e]))
    for (const key of ['goodEnding4', 'goodEnding5']) {
      expect(by.get(key)?.disputedKind, key).toBe('bad')
      // ⚠️ Ours is unchanged. The whole point is that we did not pick a side.
      expect(by.get(key)?.kind, key).toBe('good')
    }
    // Every other ending on the crime is uncontested.
    for (const key of ['goodEnding1', 'goodEnding2', 'goodEnding3', 'goodEnding6']) {
      expect(by.get(key)?.disputedKind, key).toBeNull()
    }
  })

  it('⚠️ the recorded second opinion is reproduced by subtracting the contested mass', () => {
    // This is the anchor for the UI's live derivation. The panel does not read
    // `disputedSuccessChance` — it computes `ourSuccess - contestedMass`, which
    // only works because the two models agree on everything else. Observed at
    // all five CPRs at 75 on 2026-09-07:
    const OURS = 0.91588            // our simulator's success chance
    const CONTESTED = 0.05407 + 0.01267   // goodEnding5 + goodEnding4
    const m = getScenario('Counter Offer')
    expect(m!.disputedSuccessChance).toBe(0.8491)
    expect(OURS - CONTESTED).toBeCloseTo(m!.disputedSuccessChance!, 3)
  })

  it('⚠️ disputes nothing that the overrides file does not name', () => {
    const disputed: string[] = []
    for (const s of loadOcModel().values()) {
      for (const e of s.endings) if (e.disputedKind) disputed.push(`${s.slug}/${e.key}`)
    }
    expect(disputed.sort()).toEqual(['counteroffer/goodEnding4', 'counteroffer/goodEnding5'])
    // And only that one scenario carries a second-opinion success chance.
    const withAlt = [...loadOcModel().values()]
      .filter((s) => s.disputedSuccessChance !== null).map((s) => s.slug)
    expect(withAlt).toEqual(['counteroffer'])
  })
})
