// #445 — picking a set of crimes to compare, in the order they were picked.
import { describe, expect, it } from 'vitest'
import {
  groupByCategory, toggleSelection, selectionIndex, selectedScenarios,
  staleSelections, selectionScopeCost, CATEGORY_ORDER,
} from '../ocCrimeSelection'

const SCENARIOS = [
  { name: 'Break the Bank' },      // advanced — see the name-authoritative test
  { name: 'Mob Mentality' },       // introductory
  { name: 'Pet Project' },         // introductory
  { name: 'Stacking the Deck' },   // (per config)
]

describe('groupByCategory', () => {
  it('groups hardest first', () => {
    const groups = groupByCategory(SCENARIOS)
    const keys = groups.map((g) => g.key).filter((k) => k !== 'unknown')
    // Rendered order must follow CATEGORY_ORDER, not alphabetical.
    const expected = CATEGORY_ORDER.filter((k) => keys.includes(k))
    expect(keys).toEqual(expected)
  })

  it('uses the crime NAME, not its difficulty number', () => {
    // ⚠️ The case this exists for. Difficulty 8 spans BOTH Advanced and
    // Elaborate, and Break the Bank is difficulty 8 — but the config puts it in
    // Advanced, and the config is what the OC Planner shows. Falling back to
    // the number would land it in Elaborate here and Advanced there: a quiet
    // inconsistency nobody reports and everybody distrusts. It also changes the
    // scope cost from 4 to 5, which would flow into a budget.
    const groups = groupByCategory([{ name: 'Break the Bank', difficulty: 8 }])
    expect(groups[0].key).toBe('advanced')
    expect(groups[0].scopeCost).toBe(4)
  })

  it('still lists a crime it cannot categorise', () => {
    // Hiding it would make a mirrored crime invisible with no explanation.
    const groups = groupByCategory([{ name: 'Some Brand New Crime' }])
    expect(groups.find((g) => g.key === 'unknown').crimes).toHaveLength(1)
  })

  it('sorts within a group alphabetically, which is only a display choice', () => {
    const groups = groupByCategory([{ name: 'Pet Project' }, { name: 'Mob Mentality' }])
    const intro = groups.find((g) => g.key === 'introductory')
    expect(intro.crimes.map((c) => c.name)).toEqual(['Mob Mentality', 'Pet Project'])
  })

  it('carries the scope cost per group, since that is what a pick costs', () => {
    const groups = groupByCategory([{ name: 'Break the Bank' }])
    expect(groups[0].scopeCost).toBe(4)
  })

  it('handles nothing mirrored yet', () => {
    expect(groupByCategory([])).toEqual([])
    expect(groupByCategory(undefined)).toEqual([])
  })
})

describe('toggleSelection', () => {
  it('appends, so ticking order is preserved', () => {
    let sel = []
    sel = toggleSelection(sel, 'B')
    sel = toggleSelection(sel, 'A')
    sel = toggleSelection(sel, 'C')
    // ⚠️ NOT alphabetical. Selection order is the display order and is the one
    // piece of intent the picker exists to capture.
    expect(sel).toEqual(['B', 'A', 'C'])
  })

  it('removes without disturbing the order of the rest', () => {
    const sel = toggleSelection(['B', 'A', 'C'], 'A')
    expect(sel).toEqual(['B', 'C'])
  })

  it('re-adding puts a crime at the end, not back in its old slot', () => {
    let sel = toggleSelection(['B', 'A', 'C'], 'A')
    sel = toggleSelection(sel, 'A')
    expect(sel).toEqual(['B', 'C', 'A'])
  })

  it('tolerates an empty starting selection', () => {
    expect(toggleSelection(undefined, 'A')).toEqual(['A'])
  })
})

describe('selectionIndex', () => {
  it('is 1-based, for the enumeration shown on the checkbox', () => {
    expect(selectionIndex(['B', 'A'], 'B')).toBe(1)
    expect(selectionIndex(['B', 'A'], 'A')).toBe(2)
  })

  it('is null when unselected, which is not position 0', () => {
    expect(selectionIndex(['B'], 'Z')).toBeNull()
  })
})

describe('selectedScenarios', () => {
  it('returns objects in selection order, not source order', () => {
    const chosen = selectedScenarios(SCENARIOS, ['Pet Project', 'Break the Bank'])
    expect(chosen.map((s) => s.name)).toEqual(['Pet Project', 'Break the Bank'])
  })

  it('drops a name that no longer exists rather than rendering a blank card', () => {
    // ⚠️ A persisted selection outlives a crime being renamed upstream. An
    // empty panel with no explanation is worse than the crime being absent.
    const chosen = selectedScenarios(SCENARIOS, ['Break the Bank', 'Deleted Crime'])
    expect(chosen.map((s) => s.name)).toEqual(['Break the Bank'])
  })
})

describe('staleSelections', () => {
  it('names what was dropped, so the UI can explain the gap', () => {
    expect(staleSelections(SCENARIOS, ['Break the Bank', 'Deleted Crime']))
      .toEqual(['Deleted Crime'])
  })

  it('is empty when everything resolves', () => {
    expect(staleSelections(SCENARIOS, ['Break the Bank'])).toEqual([])
  })
})

describe('selectionScopeCost', () => {
  it('totals what spawning the whole set would cost', () => {
    // Break the Bank (advanced, 4) + Pet Project (introductory, 1)
    expect(selectionScopeCost(SCENARIOS, ['Break the Bank', 'Pet Project'])).toBe(5)
  })

  it('is 0 for an empty selection', () => {
    expect(selectionScopeCost(SCENARIOS, [])).toBe(0)
  })

  it('⚠️ returns null rather than a total that omits an unknown crime', () => {
    // A quietly-short total is a budget someone would act on.
    const scenarios = [...SCENARIOS, { name: 'Some Brand New Crime' }]
    expect(selectionScopeCost(scenarios, ['Break the Bank', 'Some Brand New Crime'])).toBeNull()
  })
})
