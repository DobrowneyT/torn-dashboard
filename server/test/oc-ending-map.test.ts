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
  deriveEndingMap, terminalSignature, observedSignature, rolesInText, realEndingKeys, type Probe,
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

  // #473 — collective nouns, measured across all 31 scenarios.
  describe('collective references', () => {
    it('⚠️ resolves a nickname for a numbered role family', () => {
      // Lock Stock _A1_C2_, one of the six checkpoints that named nobody. A
      // bruiser is an enforcer and the only candidates are the two Muscle.
      expect(rolesInText('The bruisers feign defeat in an attempt to draw the caterers in.', ROLES))
        .toEqual(['Muscle 1', 'Muscle 2', 'Muscle 3'])
    })

    it('resolves a family plural without needing a table entry', () => {
      // Derived from the role list, so it needs no entry per crime and there is
      // nothing to tune — which is what keeps it from overfitting 31 samples.
      expect(rolesInText('The thieves split up to cover both exits.', ROLES))
        .toEqual(['Thief 1', 'Thief 2'])
    })

    it('⚠️ treats a metonym as scenery once the prose names actors', () => {
      // Bidding War _A4_C2_ in spirit: "Bomber #2 sneaks around the Humvee" is
      // a parked vehicle to sneak around, not the Driver doing anything. The
      // first cut let collectives ADD to a direct mention and produced exactly
      // this mis-attribution — which still improved the residual, which is why
      // the rule cannot be chosen on the residual.
      const roles = ['Driver', 'Bomber 2']
      expect(rolesInText('Bomber #2 sneaks around the Humvee to surprise the guard.', roles))
        .toEqual(['Bomber 2'])
      expect(rolesInText('The Humvee crashes into the wall but gets stuck halfway through.', roles))
        .toEqual(['Driver'])
    })

    it('leaves a genuine whole-crew checkpoint to the crew rule', () => {
      // Four of the six no-role checkpoints really do mean everyone — "The
      // whole team assaults the guards" — and must NOT be forced onto a family.
      expect(rolesInText('The whole team assaults the guards in a desperate attempt.', ROLES))
        .toEqual([])
    })
  })

  // #473 — a role named in the possessive is usually a referent, not a
  // participant, and averaging them in makes a fatal failure look survivable.
  describe('possessive referents', () => {
    const MC = ['Hacker', 'Interrogator', 'Reviver', 'Cat Burglar']

    it('⚠️ drops a role that merely owns something', () => {
      // Manifest Cruelty _A5_C1_. Interrogator is why the manager needs
      // reviving, not someone being tested. This one checkpoint is most of why
      // the crime read 0.113 and now reads 0.041.
      expect(rolesInText("Reviver curses Interrogator's overexuberance and tries to revive the manager.", MC))
        .toEqual(['Reviver'])
    })

    it('keeps both when the possessive is conjoined', () => {
      // Manifest Cruelty _B6_C2_ — "Hacker and Cat Burglar's search" has both
      // of them searching.
      expect(rolesInText("The manager is brought in to aid Hacker and Cat Burglar's search.", MC))
        .toEqual(['Hacker', 'Cat Burglar'])
    })

    it('⚠️ keeps a role whose possession is an ACTIVITY, not an object', () => {
      // The three scenarios a blanket possessive rule made worse, and reading
      // the sentences predicted all three before the numbers did. Following
      // someone's instructions tests the instructions.
      const bftp = ['Engineer', 'Picklock 2']
      expect(rolesInText("Engineer joins in to help, following Picklock #2's precise instructions.", bftp))
        .toEqual(['Engineer', 'Picklock 2'])
      const aith = ['Muscle 1', 'Muscle 2']
      expect(rolesInText("Muscle #1 follows the guard, leading him straight into Muscle #2's ambush.", aith))
        .toEqual(['Muscle 1', 'Muscle 2'])
    })

    it('⚠️ never strips the only role named', () => {
      // Lock Stock _A2_C2_ — "The guard notices Assassin's nervousness" IS the
      // Assassin's checkpoint. Stripping it would leave nothing and fall
      // through to averaging the whole crew, which is a different crime.
      const ls = ['Assassin', 'Smuggler']
      expect(rolesInText("The guard notices Assassin's nervousness and starts to question him.", ls))
        .toEqual(['Assassin'])
    })

    it('handles the curly apostrophe the diagrams actually use', () => {
      expect(rolesInText('Thief #2 tries to reclaim Muscle #3\u2019s weapon.', ROLES))
        .toEqual(['Thief 2'])
    })
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

describe('realEndingKeys — the API pads its ending slots', () => {
  // ⚠️ Found by running all 31 scenarios on 2026-08-13. The service answers
  // with a fixed number of ending slots and zero-pads the unused tail. Taken at
  // face value, seven scenarios looked like the API and the diagram disagreed
  // about the crime's shape, and all seven were refused.
  const padded = (...vals: number[]): Probe[] => [
    {
      droppedRole: null,
      endings: Object.fromEntries(vals.map((v, i) => [`goodEnding${i + 1}`, v])),
    },
  ]

  it('drops the trailing zeros — the real Plucking the Lotus Petal shape', () => {
    // goodEnding1..10 returned, 5..10 exactly 0, diagram has exactly 4 endings.
    const probes = padded(0.9797, 0.0099, 0.0002, 0.01, 0, 0, 0, 0, 0, 0)
    expect(realEndingKeys('goodEnding', probes))
      .toEqual(['goodEnding1', 'goodEnding2', 'goodEnding3', 'goodEnding4'])
  })

  it('keeps a zero in the MIDDLE, which is a real but unreachable ending', () => {
    // Renumbering around an interior zero would shift every later ending onto
    // the wrong node — the exact class of silent mis-mapping this module exists
    // to prevent.
    const probes = padded(0.97, 0, 0.02, 0.01, 0, 0)
    expect(realEndingKeys('goodEnding', probes))
      .toEqual(['goodEnding1', 'goodEnding2', 'goodEnding3', 'goodEnding4'])
  })

  it('counts an ending real if ANY probe reaches it, not just the baseline', () => {
    // Dropping a role to CPR 1 is what makes the rare endings appear. Judging
    // on the baseline alone would discard endings the sweep can plainly see.
    const probes: Probe[] = [
      { droppedRole: null, endings: { goodEnding1: 0.99, goodEnding2: 0.01, goodEnding3: 0 } },
      { droppedRole: 'Robber', endings: { goodEnding1: 0.5, goodEnding2: 0.1, goodEnding3: 0.4 } },
    ]
    expect(realEndingKeys('goodEnding', probes)).toHaveLength(3)
  })

  it('sorts by number, so goodEnding10 does not land between 1 and 2', () => {
    const probes = padded(...Array.from({ length: 10 }, (_, i) => (i < 7 ? 0.1 : 0)))
    expect(realEndingKeys('goodEnding', probes)).toEqual(
      Array.from({ length: 7 }, (_, i) => `goodEnding${i + 1}`)
    )
  })

  it('returns nothing when every slot is empty', () => {
    expect(realEndingKeys('goodEnding', padded(0, 0, 0))).toEqual([])
    expect(realEndingKeys('goodEnding', [])).toEqual([])
  })

  it('does not confuse badEnding slots with goodEnding ones', () => {
    const probes: Probe[] = [{
      droppedRole: null,
      endings: { goodEnding1: 0.9, goodEnding2: 0, badEnding1: 0.1, badEnding2: 0 },
    }]
    expect(realEndingKeys('goodEnding', probes)).toEqual(['goodEnding1'])
    expect(realEndingKeys('badEnding', probes)).toEqual(['badEnding1'])
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
