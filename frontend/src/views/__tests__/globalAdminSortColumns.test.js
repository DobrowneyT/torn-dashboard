// Sorting the scraper tables on Global Admin (#838, epic #803).
//
// ⚠️ This is the screen somebody opens WHEN SOMETHING IS ALREADY WRONG, and
// 1 of 13 columns sorted. The `activity-sample` failure earlier this cycle ran
// for two days across 477 runs; being able to order that table by status would
// have surfaced it immediately.
import { describe, expect, it } from 'vitest'
import { sortRows } from '../../utils/tableSort.js'
import { sortKeyPoolRows } from '../../utils/keyPoolTable.js'
// ⚠️ Imported, not restated. A test that keeps its own copy of the config
// cannot notice the real one drifting — which is the thing it exists to catch.
import { RUN_COLUMNS } from '../GlobalAdminView.jsx'

describe('scraper runs', () => {
  const run = (o = {}) => ({ job_name: 'attacks-sync', started_at: '2026-09-25T00:00:00+00',
    status: 'success', rows_written: 0, error: null, ...o })

  it('sorts started_at through parseDbTime, not as a string', () => {
    // ⚠️ Postgres hands us `+00` — a bare two-digit offset that `new Date`
    // rejects outright (#140). A string compare happens to work while every
    // value shares a format and stops the moment one does not.
    const rows = [
      run({ job_name: 'a', started_at: '2026-09-25T00:00:00+00' }),
      run({ job_name: 'b', started_at: '2026-09-26T00:00:00+00' }),
    ]
    expect(sortRows(rows, RUN_COLUMNS, 'started_at', 'desc')[0].job_name).toBe('b')
  })

  it('groups failures together when sorted by status', () => {
    // The question this table is opened to answer.
    const rows = [run({ job_name: 'a', status: 'success' }),
                  run({ job_name: 'b', status: 'error' }),
                  run({ job_name: 'c', status: 'error' })]
    const statuses = sortRows(rows, RUN_COLUMNS, 'status', 'asc').map(r => r.status)
    expect(statuses).toEqual(['error', 'error', 'success'])
  })

  it('sorts rows_written numerically and keeps a real zero', () => {
    // ⚠️ A run that wrote 0 rows is a FINDING, not a missing value — it is how
    // a silently-failing job looks.
    const rows = [run({ job_name: 'a', rows_written: 0 }),
                  run({ job_name: 'b', rows_written: 100 })]
    expect(sortRows(rows, RUN_COLUMNS, 'rows_written', 'asc')[0].rows_written).toBe(0)
  })

  it('sinks runs with no error when sorting by error', () => {
    // ⚠️ Nulls last in both directions: a healthy run has no error, and
    // dragging those to the top would bury the ones that failed.
    const rows = [run({ job_name: 'ok', error: null }),
                  run({ job_name: 'bad', error: 'RangeError' })]
    expect(sortRows(rows, RUN_COLUMNS, 'error', 'desc')[0].job_name).toBe('bad')
    expect(sortRows(rows, RUN_COLUMNS, 'error', 'asc')[0].job_name).toBe('bad')
  })
})

describe('the key pool table still behaves', () => {
  it('keeps empties last in both directions after the refactor', () => {
    const rows = [
      { member_name: 'a', key_level: 4 },
      { member_name: 'b', key_level: null, missing: true },
      { member_name: 'c', key_level: 2 },
    ]
    expect(sortKeyPoolRows(rows, 'level', 'asc').map(r => r.member_name)).toEqual(['c', 'a', 'b'])
    expect(sortKeyPoolRows(rows, 'level', 'desc').map(r => r.member_name)).toEqual(['a', 'c', 'b'])
  })
})
