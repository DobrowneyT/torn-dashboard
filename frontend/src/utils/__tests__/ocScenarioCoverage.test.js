// #723 — every crime our factions have actually run must resolve by NAME.
//
// The list below is not a wiki transcription. It is `select distinct name,
// difficulty from oc_crime_types` across all five tenant databases on
// 2026-09-13 — the crimes Torn has really spawned for us. Four of them were
// absent from `config.ocScenarios`, and the difficulty fallback gave each a
// confident category anyway. Lock Stock's was wrong, at 21% of tnl's spawns.
//
// ⚠️ This guards the GAP, not the values. A crime missing here still renders
// and still gets a category; what it loses is the one signal that says the
// category was chosen rather than guessed.
import { describe, it, expect } from 'vitest'
import { config } from '../../config'
import { makeCategoryResolver } from '../ocPlanner'

const OBSERVED = [
  ['Best of the Lot', 2], ['Bidding War', 6], ['Blast from the Past', 7],
  ['Break the Bank', 8], ['Cleared for Takeoff', 7], ['Clinical Precision', 8],
  ['Counter Offer', 5], ['Dish It Out', 6], ['First Aid and Abet', 1],
  ['Gaslight the Way', 3], ['Guardian Ángels', 5], ['Honey Trap', 5],
  ['Hostile Takeover', 9], ['Leave No Trace', 6], ['Lock Stock', 8],
  ['Manifest Cruelty', 8], ['Market Forces', 3], ['Mob Mentality', 1],
  ['No Reserve', 5], ['Pet Project', 1], ['Plucking the Lotus Petal', 4],
  ['Smoke and Wing Mirrors', 3], ['Snow Blind', 4], ['Sneaky Git Grab', 6],
  ['Stacking the Deck', 8], ['Stage Fright', 4], ['Thou Shalt Not Steal', 2],
  ['Window of Opportunity', 7],
]

const resolve = makeCategoryResolver({
  scenarios: config.ocScenarios, categories: config.ocCategories,
})

describe('scenario coverage', () => {
  it.each(OBSERVED)('%s is modelled by name', (name, difficulty) => {
    expect(resolve.detail(name, difficulty)).toMatchObject({ source: 'name' })
  })

  it('⚠️ Lock Stock is Elaborate, which its difficulty alone cannot tell you', () => {
    // 5/6, not 4/5. It is a chain root feeding Hostile Takeover, so the
    // break-even it drives is (5/6)^(1/2) = 91.3%, not (4/5)^(1/2) = 89.4%.
    expect(resolve('Lock Stock', 8)).toBe('elaborate')
    expect(config.ocCategories.elaborate.scopeCost).toBe(5)
  })

  it('agrees with the difficulty Torn reports for it', () => {
    for (const [name, difficulty] of OBSERVED) {
      expect(config.ocScenarios[name].difficulty, name).toBe(difficulty)
    }
  })

  it('keeps the unaccented Guardian Angels spelling as an alias', () => {
    expect(resolve.detail('Guardian Angels', 5).source).toBe('name')
    expect(resolve('Guardian Angels', 5)).toBe(resolve('Guardian Ángels', 5))
  })
})
