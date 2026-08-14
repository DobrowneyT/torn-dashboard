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
