// That every Member Overview column declares the RIGHT sort kind (#835).
//
// ⚠️ This test exists because the conversion got it wrong and nothing caught
// it. `TEXT_COLUMNS` was written as `member_name` — the field the accessor
// reads — when the column id is `name`. The name column would have been
// compared numerically: every value NaN, every comparison 0, and the roster
// silently stuck in arrival order. Nothing else in the suite touches it.
import { describe, expect, it } from 'vitest'
import { IDENTITY_COLUMNS, TEXT_COLUMNS } from '../MemberOverview.jsx'

describe('sort kinds', () => {
  it('names columns that actually exist', () => {
    // ⚠️ The exact bug: a key that is not a column id is not a type error, not
    // a test failure, and not visible — it is just a column that stops sorting.
    for (const key of TEXT_COLUMNS) {
      expect(IDENTITY_COLUMNS[key], `"${key}" is not a column id`).toBeTruthy()
    }
  })

  it('classifies every identity column by what its sort value really is', () => {
    // A representative row with every field populated, so each accessor
    // returns its natural type rather than a fallback.
    const row = {
      member_name: 'Alice', level: 50, last_action_timestamp: 1_790_000_000,
      is_donator: true, property_name: 'Villa', tier: 3,
      total_days_in_faction: 400, streak_days: 12, gym_energy_perday: 250,
    }
    for (const [key, def] of Object.entries(IDENTITY_COLUMNS)) {
      const value = def.sortValue(row)
      if (value === undefined) continue          // battle stats needs its own shape
      const isText = typeof value === 'string'
      expect(TEXT_COLUMNS.has(key), `${key} returns ${typeof value}`).toBe(isText)
    }
  })
})
