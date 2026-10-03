// Reading Steadfast out of /faction/upgrades (#395 / #458).
//
// ⚠️ This parser was written WITHOUT a verified live response — Torn's exact
// `ability` wording could not be confirmed at authoring time. So the tests are
// weighted towards the failure modes rather than the happy path: the parser's
// job is to be right or silent, never confidently wrong. A wrong percentage on
// a gym-gain display looks exactly like a right one, and someone plans a
// training week around it.
import { describe, expect, it } from 'vitest'
import { readSteadfast, readBranchState } from '../src/factionUpgrades.js'

const payload = (over: any = {}) => ({
  state: 'peace',
  upgrades: {
    core: { upgrades: [] },
    peace: [
      {
        name: 'Steadfast',
        order: 1,
        upgrades: [
          { id: 1, name: 'Strength Training VII', ability: '+ 7% strength gym gains', level: 7 },
          { id: 2, name: 'Defense Training V', ability: '+ 5% defense gym gains', level: 5 },
        ],
      },
      { name: 'Criminality', upgrades: [{ name: 'Anonymity', ability: 'Hides faction crimes', level: 1 }] },
    ],
    war: [],
  },
  ...over,
})

describe('readSteadfast', () => {
  it('reads a percentage per stat from the ability text', () => {
    const s = readSteadfast(payload())
    expect(s.strength).toBe(7)
    expect(s.defense).toBe(5)
    expect(s.speed).toBeNull()
    expect(s.dexterity).toBeNull()
  })

  it('⚠️ leaves an unbought stat null, not zero', () => {
    // A faction that has not bought Speed Training genuinely has 0%. That is a
    // different fact from a parser that could not read it, and only one of
    // them should ever be printed as "0%".
    expect(readSteadfast(payload()).speed).toBeNull()
  })

  it('ignores branches that are not Steadfast', () => {
    // Criminality/Anonymity has no percentage and must not become one.
    expect(readSteadfast(payload()).unparsed).toEqual([])
  })

  it('⚠️ reads only the branch set that is actually in effect', () => {
    // A faction at war runs its war branches. Summing both sets, or reading
    // the wrong one, reports bonuses nobody is getting.
    const atWar = payload({
      state: 'war',
      upgrades: {
        core: { upgrades: [] },
        peace: [{ name: 'Steadfast', upgrades: [{ name: 'Strength Training X', ability: '+ 10% strength gym gains', level: 10 }] }],
        war: [{ name: 'Steadfast', upgrades: [{ name: 'Strength Training III', ability: '+ 3% strength gym gains', level: 3 }] }],
      },
    })
    expect(readSteadfast(atWar).strength).toBe(3)
  })

  it('⚠️ takes the highest level in a sub-branch, never the sum', () => {
    // A sub-branch lists every level passed through. Summing turns 1+2+3 into
    // a 6% bonus that does not exist.
    const laddered = payload({
      upgrades: {
        core: { upgrades: [] },
        peace: [{
          name: 'Steadfast',
          upgrades: [
            { name: 'Speed Training I', ability: '+ 1% speed gym gains', level: 1 },
            { name: 'Speed Training II', ability: '+ 2% speed gym gains', level: 2 },
            { name: 'Speed Training III', ability: '+ 3% speed gym gains', level: 3 },
          ],
        }],
        war: [],
      },
    })
    expect(readSteadfast(laddered).speed).toBe(3)
  })

  it('⚠️ refuses to guess when one string names two stats', () => {
    // "strength and defense" is ambiguous, not a coin flip. Taking the first
    // match would attribute the bonus to the wrong stat, silently.
    const ambiguous = payload({
      upgrades: {
        core: { upgrades: [] },
        peace: [{ name: 'Steadfast', upgrades: [{ name: 'Combined', ability: '+ 4% strength and defense gym gains', level: 4 }] }],
        war: [],
      },
    })
    const s = readSteadfast(ambiguous)
    expect(s.strength).toBeNull()
    expect(s.defense).toBeNull()
    // ...and it says so, verbatim, rather than dropping the perk.
    expect(s.unparsed[0]).toContain('strength and defense')
  })

  it('accepts the spellings Torn and its players actually use', () => {
    const abbreviated = payload({
      upgrades: {
        core: { upgrades: [] },
        peace: [{
          name: 'Steadfast',
          upgrades: [
            { name: 'Dex Training II', ability: '+ 2% dex gym gains', level: 2 },
            { name: 'Defence Training IV', ability: '+ 4% defence gym gains', level: 4 },
          ],
        }],
        war: [],
      },
    })
    const s = readSteadfast(abbreviated)
    expect(s.dexterity).toBe(2)
    expect(s.defense).toBe(4) // British spelling
  })

  it('falls back to level when the ability text carries no percentage', () => {
    // ⚠️ Only valid while "one level = one percent" holds. It does today, and
    // it is exactly the sort of thing that quietly stops holding — which is
    // why the raw payload is stored alongside the parse.
    const noPct = payload({
      upgrades: {
        core: { upgrades: [] },
        peace: [{ name: 'Steadfast', upgrades: [{ name: 'Strength Training VI', ability: 'Increases strength gym gains', level: 6 }] }],
        war: [],
      },
    })
    expect(readSteadfast(noPct).strength).toBe(6)
  })

  it('survives a response shaped like nothing we expected', () => {
    for (const junk of [null, undefined, {}, { upgrades: null }, { upgrades: { peace: 'nope' } }]) {
      const s = readSteadfast(junk)
      expect(s).toMatchObject({ strength: null, defense: null, speed: null, dexterity: null })
      expect(s.unparsed).toEqual([])
    }
  })
})

describe('readBranchState', () => {
  it('reports war or peace, and null when the response does not say', () => {
    expect(readBranchState({ state: 'war' })).toBe('war')
    expect(readBranchState({ state: 'peace' })).toBe('peace')
    expect(readBranchState({ state: 'chaos' })).toBeNull()
    expect(readBranchState(null)).toBeNull()
  })
})

// ── readUpgradesView (#458) ───────────────────────────────────────────────────
//
// ⚠️ The fixture below is the REAL shape, copied from a live `forge` snapshot
// on 2026-10-03 — including the two things that would have been guessed wrong:
// `core` is an object wrapping an array (not an array), and war/peace share
// branch names. Earlier tests in this file are hand-built because no live
// response was available then; these are not.
import { readUpgradesView } from '../src/factionUpgrades.js'

const live = () => ({
  state: 'peace',
  upgrades: {
    core: {
      upgrades: [
        { id: 1, cost: 1000, name: 'Weapon armory', level: 1, ability: 'Unlocks weapon armory', unlocked_at: 1484661886 },
      ],
    },
    peace: [
      {
        name: 'Steadfast', order: 4, multiplier: 8,
        upgrades: [
          { id: 36, cost: 4454, name: 'Strength training X', level: 10, ability: 'Increases strength gym gains by 10%', unlocked_at: 1790812814 },
          { id: 38, cost: 11279, name: 'Defense training XVI', level: 16, ability: 'Increases defense gym gains by 16%', unlocked_at: 1790812804 },
        ],
      },
      { name: 'Criminality', order: 1, multiplier: 2, upgrades: [] },
      // Shares its name with the war branch below — see the warning.
      { name: 'Voracity', order: 5, multiplier: 3, upgrades: [{ id: 90, name: 'Peace voracity', level: 1, ability: 'peace only', cost: 1, unlocked_at: 1 }] },
    ],
    war: [
      { name: 'Suppression', order: 2, multiplier: 4, upgrades: [] },
      { name: 'Voracity', order: 5, multiplier: 3, upgrades: [{ id: 91, name: 'War voracity', level: 1, ability: 'war only', cost: 1, unlocked_at: 1 }] },
    ],
  },
})

describe('readUpgradesView', () => {
  it('puts the in-effect side in `active` and the other in `inactive`', () => {
    const v = readUpgradesView(live())
    expect(v.state).toBe('peace')
    expect(v.inactiveState).toBe('war')
    expect(v.active.map(b => b.name)).toEqual(['Criminality', 'Steadfast', 'Voracity'])
    expect(v.inactive.map(b => b.name)).toEqual(['Suppression', 'Voracity'])
  })

  it('reads the war side as active when the faction is at war', () => {
    const v = readUpgradesView({ ...live(), state: 'war' })
    expect(v.active.map(b => b.name)).toEqual(['Suppression', 'Voracity'])
    expect(v.inactiveState).toBe('peace')
  })

  it('⚠️ keeps both Voracity branches — they share a name but are not the same', () => {
    // Merging or deduplicating by name would silently drop one side's perk.
    const v = readUpgradesView(live())
    const activeVoracity = v.active.find(b => b.name === 'Voracity')
    const inactiveVoracity = v.inactive.find(b => b.name === 'Voracity')
    expect(activeVoracity?.upgrades[0].name).toBe('Peace voracity')
    expect(inactiveVoracity?.upgrades[0].name).toBe('War voracity')
  })

  it('reads core from an object wrapping an array, as Torn actually sends it', () => {
    expect(readUpgradesView(live()).core.map(u => u.name)).toEqual(['Weapon armory'])
  })

  it('also tolerates core arriving as a bare array', () => {
    const p: any = live()
    p.upgrades.core = [{ id: 2, name: 'Medical armory', level: 1, ability: 'x', cost: 1, unlocked_at: 5 }]
    expect(readUpgradesView(p).core.map(u => u.name)).toEqual(['Medical armory'])
  })

  it('⚠️ converts unlocked_at from epoch SECONDS to milliseconds', () => {
    // It is Torn's JSON, not our timestamptz column: treating it as ms lands in
    // 1970 and treating it as a DB string yields NaN.
    const v = readUpgradesView(live())
    const str = v.active.find(b => b.name === 'Steadfast')!.upgrades[0]
    expect(str.unlockedMs).toBe(1790812814 * 1000)
    expect(new Date(str.unlockedMs!).getUTCFullYear()).toBe(2026)
  })

  it('reports an unknown unlock date as null rather than 1970', () => {
    const p: any = live()
    p.upgrades.peace[0].upgrades[0].unlocked_at = 0
    expect(readUpgradesView(p).active.find(b => b.name === 'Steadfast')!.upgrades[0].unlockedMs).toBeNull()
  })

  it('carries Torn\'s ability text verbatim and never invents one', () => {
    const v = readUpgradesView(live())
    const sf = v.active.find(b => b.name === 'Steadfast')!
    expect(sf.upgrades[0].ability).toBe('Increases strength gym gains by 10%')
    const p: any = live()
    delete p.upgrades.peace[0].upgrades[0].ability
    expect(readUpgradesView(p).active[1].upgrades[0].ability).toBe('')
  })

  it('orders branches by Torn\'s `order`, so the panel never reshuffles', () => {
    const v = readUpgradesView(live())
    expect(v.active.map(b => b.order)).toEqual([1, 4, 5])
  })

  it('⚠️ picks no side when `state` is missing, rather than guessing one', () => {
    // Guessing would be the worst outcome: it renders an authoritative-looking
    // "currently active" list that may be the wrong half of the tree.
    const p: any = live()
    delete p.state
    const v = readUpgradesView(p)
    expect(v.state).toBeNull()
    expect(v.active).toEqual([])
    expect(v.inactiveState).toBeNull()
    // Nothing is hidden, though — both sides are still reachable.
    expect(v.inactive.map(b => b.name)).toContain('Steadfast')
    expect(v.inactive.map(b => b.name)).toContain('Suppression')
  })

  it('survives an empty or broken payload without throwing', () => {
    for (const p of [null, undefined, {}, { upgrades: {} }, { upgrades: { peace: 'nope' } }]) {
      const v = readUpgradesView(p as any)
      expect(v.active).toEqual([])
      expect(v.core).toEqual([])
    }
  })
})
