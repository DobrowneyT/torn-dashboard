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
