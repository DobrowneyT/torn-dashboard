// Deriving goodEndingN → diagram node id (#390).
//
// Driven by REAL probe responses captured from tornprobability's
// CalculateSuccess on 2026-08-13, against the real Break the Bank diagram. The
// point of the module is to resist a plausible-but-wrong mapping, and a fixture
// I invented would only confirm my own assumptions.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseScenarioTree } from '../src/oc/scenarioTree.js'
import {
  deriveEndingMap, terminalSignature, observedSignature, rolesInText, type Probe,
} from '../src/oc/endingMap.js'

const here = dirname(fileURLToPath(import.meta.url))
const tree = parseScenarioTree(readFileSync(join(here, 'fixtures', 'break-the-bank.mmd'), 'utf8'))
const ROLES = ['Robber', 'Muscle 1', 'Muscle 2', 'Thief 1', 'Muscle 3', 'Thief 2']

/** Captured live: one role dropped to CPR 1, the rest at 99. */
const good = (g1: number, g2: number, g3: number, g4: number, g5: number) =>
  ({ goodEnding1: g1, goodEnding2: g2, goodEnding3: g3, goodEnding4: g4, goodEnding5: g5 })

const PROBES: Probe[] = [
  { droppedRole: null,       endings: good(0.9700, 0.0098, 0.0197, 0.0002, 0.0001) },
  { droppedRole: 'Robber',   endings: good(0.1243, 0.1243, 0.0075, 0.7386, 0.0001) },
  { droppedRole: 'Muscle 1', endings: good(0.2462, 0.0025, 0.7386, 0.0075, 0.0001) },
  { droppedRole: 'Muscle 2', endings: good(0.7275, 0.0073, 0.0148, 0.0001, 0.2475) },
  { droppedRole: 'Thief 1',  endings: good(0.3675, 0.3675, 0.0148, 0.0001, 0.2475) },
  { droppedRole: 'Muscle 3', endings: good(0.4898, 0.0050, 0.0100, 0.0001, 0.0001) },
  { droppedRole: 'Thief 2',  endings: good(0.4899, 0.0050, 0.0100, 0.0001, 0.0000) },
]

describe('rolesInText', () => {
  it('matches prose "Muscle #2" against the role list\'s "Muscle 2"', () => {
    expect(rolesInText('Muscle #2 fires a warning shot toward one of the guards.', ROLES))
      .toEqual(['Muscle 2'])
  })

  it('returns every role a checkpoint involves, not just the first', () => {
    // Checkpoints routinely test two roles together, and dropping the second
    // would lose half the signature.
    expect(rolesInText('Robber and Muscle #1 aim at the guards.', ROLES))
      .toEqual(['Robber', 'Muscle 1'])
  })
})

describe('terminalSignature on the real diagram', () => {
  it('reads depth and the roles whose failure leads to each ending', () => {
    const sig = (id: string) => {
      const s = terminalSignature(tree, id, ROLES)
      return { depth: s.depth, roles: [...s.failRoles].sort() }
    }
    expect(sig('_A8S_')).toEqual({ depth: 0, roles: [] })
    expect(sig('_A8S2_')).toEqual({ depth: 1, roles: ['Robber', 'Thief 1'] })
    expect(sig('_A9S_')).toEqual({ depth: 1, roles: ['Muscle 1', 'Robber'] })
    expect(sig('_A10S_')).toEqual({ depth: 2, roles: ['Muscle 1', 'Robber'] })
    expect(sig('_B3S_')).toEqual({ depth: 2, roles: ['Muscle 2', 'Thief 1'] })
  })
})

describe('observedSignature from the probe sweep', () => {
  it('reports only the roles whose drop RAISES an ending', () => {
    // A drop that lowers an ending means that role gates a checkpoint the
    // ending needed to PASS — the opposite relationship, and counting it would
    // make every ending look related to every role.
    expect([...observedSignature('goodEnding4', PROBES)].sort()).toEqual(['Muscle 1', 'Robber'])
    expect([...observedSignature('goodEnding5', PROBES)].sort()).toEqual(['Muscle 2', 'Thief 1'])
  })

  it('ignores the noise every drop produces', () => {
    // Dropping any role perturbs every ending slightly. Without the margin,
    // goodEnding3 would appear to respond to roles it does not depend on, and
    // its signature would match several terminals at once.
    const loose = observedSignature('goodEnding3', PROBES, 1)
    const tight = observedSignature('goodEnding3', PROBES, 1.5)
    expect(tight.size).toBeLessThanOrEqual(loose.size)
    expect([...tight]).toEqual(['Muscle 1'])
  })
})

describe('deriveEndingMap — the real mapping', () => {
  const result = deriveEndingMap(tree, ROLES, PROBES)

  it('resolves every ending to exactly one node', () => {
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(Object.keys(result.map)).toHaveLength(5)
    expect(new Set(Object.values(result.map)).size).toBe(5)
  })

  it('anchors goodEnding1 to the all-pass ending', () => {
    expect(result.map.goodEnding1).toBe('_A8S_')
  })

  it('SWAPS positions 3 and 4 against declaration order', () => {
    // The finding this module exists for. Declaration order is
    //   _A8S_, _A8S2_, _A10S_, _A9S_, _B3S_
    // and the derived mapping is
    //   _A8S_, _A8S2_, _A9S_,  _A10S_, _B3S_
    // so goodEnding3 and goodEnding4 would have carried each other's money —
    // and _A10S_ pays differently from _A9S_, which is exactly the kind of
    // wrong that stays plausible all the way into an OC manager's decision.
    expect(result.map).toEqual({
      goodEnding1: '_A8S_',
      goodEnding2: '_A8S2_',
      goodEnding3: '_A9S_',
      goodEnding4: '_A10S_',
      goodEnding5: '_B3S_',
    })
    const declared = tree.terminals.filter((t) => t.ending === 'good').map((t) => t.id)
    expect(declared).toEqual(['_A8S_', '_A8S2_', '_A10S_', '_A9S_', '_B3S_'])
    expect(result.map.goodEnding3).not.toBe(declared[2])
  })
})

describe('deriveEndingMap refuses rather than guessing', () => {
  it('fails when the API and the diagram disagree on how many endings exist', () => {
    // Either the diagram changed upstream or the parse dropped something. Both
    // mean no mapping can be trusted, so none is offered.
    const short = PROBES.map((p) => ({
      ...p,
      endings: Object.fromEntries(Object.entries(p.endings).filter(([k]) => k !== 'goodEnding5')),
    }))
    const r = deriveEndingMap(tree, ROLES, short)
    expect(r.ok).toBe(false)
    expect(r.map).toEqual({})
    expect(r.problems[0]).toMatch(/4 good endings but the diagram has 5/)
  })

  it('fails without a baseline probe rather than inventing one', () => {
    const r = deriveEndingMap(tree, ROLES, PROBES.filter((p) => p.droppedRole !== null))
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toMatch(/no baseline probe/)
  })

  it('reports a tie instead of picking a side', () => {
    // Muscle 3 and Thief 2 gate the same checkpoint and are indistinguishable
    // under single-role drops. An ending separated only by such a pair must be
    // surfaced as needing a paired probe — never resolved by coin flip.
    const flat: Probe[] = [
      { droppedRole: null, endings: good(0.97, 0.0098, 0.0098, 0.0002, 0.0002) },
      ...ROLES.map((r) => ({ droppedRole: r, endings: good(0.5, 0.0098, 0.0098, 0.0002, 0.0002) })),
    ]
    const r = deriveEndingMap(tree, ROLES, flat)
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/no role evidence|ties between/)
  })

  it('never returns a partial map alongside ok:true', () => {
    // The invariant that makes this safe to build on. A half-derived mapping is
    // the worst output available: the endings it resolved look exactly as
    // trustworthy as the ones it did not.
    for (const probes of [PROBES, PROBES.slice(0, 2), []]) {
      const r = deriveEndingMap(tree, ROLES, probes)
      if (r.ok) expect(Object.keys(r.map)).toHaveLength(5)
    }
  })
})
