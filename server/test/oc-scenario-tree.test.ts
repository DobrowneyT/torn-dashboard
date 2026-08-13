// OC scenario flowchart parsing (#390).
//
// Tested against the REAL Break the Bank diagram as served by
// tornprobability.com, not a hand-written sample: the whole point of this
// module is to survive someone else's rendering format, and a fixture I wrote
// myself would only prove I can parse my own assumptions.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseScenarioTree, pathsToTerminal, checkpointsOnPath, allPassTerminal,
  validateScenarioTree,
} from '../src/oc/scenarioTree.js'

const here = dirname(fileURLToPath(import.meta.url))
const BTB = readFileSync(join(here, 'fixtures', 'break-the-bank.mmd'), 'utf8')
const tree = parseScenarioTree(BTB)

describe('parseScenarioTree against the real Break the Bank diagram', () => {
  it('finds the root without assuming it is called _Prelude_', () => {
    // Derived as "the node nothing points at". The naming convention is theirs
    // to change, and a hardcoded id would break silently — every path lookup
    // would return nothing and every ending would look unreachable.
    expect(tree.root).toBe('_Prelude_')
  })

  it('classifies nodes by mermaid shape', () => {
    // ([...]) narrative, {...} checkpoint, [...] outcome. The shape is how the
    // site encodes "this is a CPR roll" — there is no other marker.
    expect(tree.nodes.get('_A1_')?.kind).toBe('narrative')
    expect(tree.nodes.get('_A1_C1_')?.kind).toBe('checkpoint')
    expect(tree.nodes.get('_A1_C1F_')?.kind).toBe('outcome')
  })

  it('unescapes the HTML entities the diagram ships with', () => {
    expect(tree.nodes.get('_A1_')?.text).toContain("crew leaps out")
    expect(tree.nodes.get('_A1_C1F_')?.text).toContain("crew's demand")
  })

  it('finds exactly the five good and five bad endings the API reports', () => {
    const good = tree.terminals.filter((t) => t.ending === 'good').map((t) => t.id).sort()
    const bad = tree.terminals.filter((t) => t.ending === 'bad').map((t) => t.id).sort()
    expect(good).toEqual(['_A10S_', '_A8S2_', '_A8S_', '_A9S_', '_B3S_'])
    expect(bad).toHaveLength(5)
  })

  it('does NOT treat a checkpoint failure branch as an ending', () => {
    // The trap in the id scheme: `_A1_C1F_` ends in F but the crime carries on
    // from it. Only a node with no way out has actually ended. Getting this
    // wrong would invent dozens of endings that the API never reports.
    expect(tree.nodes.get('_A1_C1F_')?.kind).toBe('outcome')
    expect(tree.terminals.map((t) => t.id)).not.toContain('_A1_C1F_')
    expect((tree.edges.get('_A1_C1F_') ?? []).length).toBeGreaterThan(0)
  })

  it('records edges in both directions', () => {
    expect(tree.edges.get('_A8_4_')).toContain('_A8S_')
    expect(tree.parents.get('_A8S_')).toContain('_A8_4_')
  })
})

describe('pathsToTerminal', () => {
  it('walks every terminal back to the root', () => {
    for (const terminal of tree.terminals) {
      const paths = pathsToTerminal(tree, terminal.id)
      expect(paths.length, terminal.id).toBeGreaterThan(0)
      for (const p of paths) {
        expect(p[0], terminal.id).toBe(tree.root)
        expect(p[p.length - 1], terminal.id).toBe(terminal.id)
      }
    }
  })

  it('terminates on a cycle instead of hanging', () => {
    // The diagrams are DAGs today. A rendering bug upstream that introduced a
    // loop should fail the job, not wedge it — a hung cron is far harder to
    // notice than a failed one.
    const cyclic = parseScenarioTree([
      'flowchart LR',
      ' _Prelude_(["start"])',
      ' _Prelude_ --> _A_',
      ' _A_ --> _B_',
      ' _B_ --> _A_',
      ' _B_ --> _A1S_',
    ].join('\n'))
    expect(() => pathsToTerminal(cyclic, '_A1S_')).not.toThrow()
  })
})

describe('checkpointsOnPath', () => {
  it('counts a pass and a fail on the branch actually taken', () => {
    const t = parseScenarioTree([
      'flowchart LR',
      ' _Prelude_(["s"])',
      ' _C1_{"roll"}',
      ' _C1F_["failed"]',
      ' _Prelude_ --> _C1_',
      ' _C1_ --> _C1F_',
      ' _C1_ --> _A1S_',
      ' _C1F_ --> _A1F_',
    ].join('\n'))
    const pass = pathsToTerminal(t, '_A1S_')[0]
    const fail = pathsToTerminal(t, '_A1F_')[0]
    expect(checkpointsOnPath(t, pass)).toEqual({ passed: 1, failed: 0 })
    expect(checkpointsOnPath(t, fail)).toEqual({ passed: 0, failed: 1 })
  })
})

describe('allPassTerminal — the anchor for the whole mapping', () => {
  it('identifies a single every-checkpoint-passed ending', () => {
    // This is what pins goodEnding1. Probing the API at all-99 CPRs puts 97%
    // of the mass on goodEnding1, so goodEnding1 IS the all-pass ending — and
    // this function names which node that is without guessing.
    const anchor = allPassTerminal(tree)
    expect(anchor).not.toBeNull()
    expect(anchor!.ending).toBe('good')
  })

  it('agrees with the API probe: goodEnding1 is the all-pass ending', () => {
    // Probing CalculateSuccess at all-99 CPRs puts 0.970 on goodEnding1, which
    // can only be the every-checkpoint-passed path. This names it structurally,
    // and the two agree — so the anchor is evidenced, not assumed.
    expect(allPassTerminal(tree)!.id).toBe('_A8S_')
  })

  it('exposes the fail-depth that shows declaration order is NOT the mapping', () => {
    // Declaration order is _A8S_(0 fails), _A8S2_(1), _A10S_(2), _A9S_(1),
    // _B3S_(2). The API at all-99 reports goodEnding2 = 0.0098 and
    // goodEnding3 = 0.0197 — BOTH one-fail magnitudes at a ~1% per-checkpoint
    // failure rate, while a two-fail ending lands near 1e-4 (goodEnding4 and
    // goodEnding5 are 0.0002 and 0.0001).
    //
    // So goodEnding3 cannot be _A10S_, which needs two failures. Position
    // matching breaks at the third ending — and it breaks QUIETLY, pairing an
    // ending with another ending's money while every number stays plausible.
    const depth = (id: string) =>
      Math.min(...pathsToTerminal(tree, id).map((p) => checkpointsOnPath(tree, p).failed))
    expect(depth('_A8S_')).toBe(0)
    expect(depth('_A8S2_')).toBe(1)
    expect(depth('_A9S_')).toBe(1)
    expect(depth('_A10S_')).toBe(2)
    expect(depth('_B3S_')).toBe(2)

    // Exactly two endings at each depth, which is what lets probability
    // magnitude sort them into pairs. The remaining ambiguity inside a pair
    // needs a targeted probe and must NOT be resolved by position.
    const depths = ['_A8S_', '_A8S2_', '_A10S_', '_A9S_', '_B3S_'].map(depth)
    expect(depths.filter((d) => d === 1)).toHaveLength(2)
    expect(depths.filter((d) => d === 2)).toHaveLength(2)
  })

  it('returns null rather than picking one when the anchor is ambiguous', () => {
    // An ambiguous anchor must read as "cannot map". Choosing arbitrarily here
    // is precisely how a plausible-but-wrong mapping gets shipped.
    const ambiguous = parseScenarioTree([
      'flowchart LR',
      ' _Prelude_(["s"])',
      ' _Prelude_ --> _A1S_',
      ' _Prelude_ --> _A2S_',
    ].join('\n'))
    expect(allPassTerminal(ambiguous)).toBeNull()
  })
})

// MonChoon's invariant (2026-08-13): "every branch should go to some leaf and
// have either a pass / fail case, so we should be able to verify the outcomes
// and that we have parsed it correctly."
//
// These are properties the SOURCE must have — a crime always resolves, and a
// checkpoint always has both outcomes — so a violation means either the diagram
// changed shape upstream or the parser dropped something. Both matter, and both
// should stop the mirror job rather than produce a partial tree that still
// yields confident numbers.
describe('validateScenarioTree', () => {
  it('passes cleanly on the real diagram', () => {
    // 18 checkpoints, every one with both a Pass and a Fail edge; no dead ends;
    // nothing unreachable. This is the check that would have caught the
    // labelled-edge bug the moment it was written, instead of via a path count
    // silently coming back zero.
    const v = validateScenarioTree(tree)
    expect(v.checkpointsMissingBranch).toEqual([])
    expect(v.deadEnds).toEqual([])
    expect(v.unreachable).toEqual([])
    expect(v.unreachableTerminals).toEqual([])
    expect(v.ok).toBe(true)
  })

  it('counts every checkpoint as having both outcomes', () => {
    const checkpoints = [...tree.nodes.values()].filter((n) => n.kind === 'checkpoint')
    expect(checkpoints).toHaveLength(18)
    for (const c of checkpoints) {
      const labels = (tree.edges.get(c.id) ?? [])
        .map((to) => tree.edgeLabels.get(`${c.id}>${to}`)?.toLowerCase())
      expect(labels, c.id).toContain('pass')
      expect(labels, c.id).toContain('fail')
    }
  })

  it('catches a checkpoint that lost a branch — the exact parser bug I shipped', () => {
    // Reproduces the labelled-edge failure: the Fail branch goes missing and
    // the checkpoint becomes a fork we only have half of.
    const broken = parseScenarioTree([
      'flowchart LR',
      ' _Prelude_(["s"])',
      ' _C1_{"roll"}',
      ' _Prelude_ --> _C1_',
      ' _C1_ -- "Pass" --> _A1S_',
    ].join('\n'))
    const v = validateScenarioTree(broken)
    expect(v.ok).toBe(false)
    expect(v.checkpointsMissingBranch).toEqual(['_C1_'])
  })

  it('catches a branch that stops without reaching an ending', () => {
    const broken = parseScenarioTree([
      'flowchart LR',
      ' _Prelude_(["s"])',
      ' _Mid_(["the story just stops"])',
      ' _Prelude_ --> _Mid_',
    ].join('\n'))
    expect(validateScenarioTree(broken).deadEnds).toEqual(['_Mid_'])
  })

  it('catches a subtree the root can never reach', () => {
    // An ending that can never happen still carries money statistics, and would
    // otherwise be mapped to some API ending that genuinely occurs.
    const broken = parseScenarioTree([
      'flowchart LR',
      ' _Prelude_(["s"])',
      ' _Prelude_ --> _A1S_',
      ' _Orphan_(["nothing points here"])',
      ' _Orphan_ --> _A2S_',
    ].join('\n'))
    const v = validateScenarioTree(broken)
    expect(v.ok).toBe(false)
    expect(v.unreachableTerminals).toContain('_A2S_')
  })
})
