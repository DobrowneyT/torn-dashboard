/**
 * Every data table must be sortable (#840, epic #803).
 *
 * ⚠️ **This epic exists because sorting was added table by table for two years
 * and nobody could tell what was missing.** Without a guard, that restarts the
 * day the epic closes. The repo already proved the pattern works:
 * `dbTimeParsing.test.js` scans for unguarded `Date.parse` and is why the #140
 * timestamp trap stopped recurring.
 *
 * ⚠️ **The allowlist is EMPTY and must stay that way.** A guard that ships
 * listing the remaining offenders documents debt instead of preventing more,
 * and an allowlist that never shrinks is just a comment.
 *
 * ⚠️ **What this cannot catch.** It is a regex over JSX, so:
 *   - a table whose headers come from a component this does not recognise
 *     reads as unsorted (add the component's name to SORT_MARKERS);
 *   - a table that imports a sort helper under another name reads as unsorted;
 *   - a column wired to a sort that does nothing still passes.
 * It catches the CARELESS case — a new `<table>` with plain `<th>` and no sort
 * wiring at all — not the determined one. That is the case that actually
 * happened, eight times.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../../', import.meta.url).pathname

/**
 * Names that mean "this file wires up sorting".
 *
 * ⚠️ Several are per-file adapters rather than the shared component, and that
 * is deliberate — `GlobalAdminView` and `WarRoomViewV2` keep their own header
 * cells for stated reasons (a `{key, dir}` shape, and a whole-cell click target
 * in a war room). The guard asks whether a table sorts, not whether it was
 * written the same way.
 */
const SORT_MARKERS = [
  'SortableTh', 'useTableSort', 'sortRows',
  'SortTh', 'SortHeader', 'AdminTh',
  'sortRanking', 'sortKeyPoolRows', 'sortSnapshot',
]

/** Files that render a `<table>` but are not data grids. */
const NOT_DATA_TABLES = [
  // ⚠️ Its two `<th>` matches are PROSE INSIDE A COMMENT, not markup. It is a
  // stat readout used inside other tables' cells. This one cost a correction
  // to the audit, so it is named rather than silently filtered.
  'components/BattleStatsCell.jsx',
]

/**
 * ⚠️ Empty, and the point of the issue. If something has to go here, the guard
 * should not ship — see the note at the top.
 */
const ALLOWLIST = []

function jsxFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...jsxFiles(full))
    } else if (entry.endsWith('.jsx')) {
      out.push(full)
    }
  }
  return out
}

/**
 * ⚠️ Comments are stripped before counting headers. `BattleStatsCell` matched
 * `<th` twice from the phrase "…, which is" inside a block comment, which is
 * how a non-table ended up on the audit's list of unsorted tables.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('every data table is sortable', () => {
  const offenders = []

  for (const file of jsxFiles(SRC)) {
    const rel = file.slice(SRC.length)
    if (NOT_DATA_TABLES.includes(rel)) continue
    const src = stripComments(readFileSync(file, 'utf8'))
    if (!src.includes('<table')) continue
    // A table with no header cells is a layout grid, not a data table.
    if (!/<th[\s>]/.test(src)) continue
    if (SORT_MARKERS.some((m) => src.includes(m))) continue
    offenders.push(rel)
  }

  it('finds no table without sort wiring', () => {
    expect(offenders, [
      'These files render a data table with no sorting:',
      ...offenders.map((f) => `  ${f}`),
      '',
      'Wire it up with SortableTh + useTableSort (frontend/src/components/SortableTh.jsx).',
      'If the columns genuinely should not sort, say so by adding the file to',
      'NOT_DATA_TABLES with a reason — never to ALLOWLIST, which must stay empty.',
    ].join('\n')).toEqual(ALLOWLIST)
  })

  it('still ships with an empty allowlist', () => {
    // ⚠️ The condition the issue put on this guard existing at all.
    expect(ALLOWLIST).toEqual([])
  })

  it('actually looks at files, rather than passing because it found none', () => {
    // ⚠️ A scanner with a broken path finds zero offenders and goes green
    // forever. This is the test that notices.
    const tables = jsxFiles(SRC).filter((f) =>
      stripComments(readFileSync(f, 'utf8')).includes('<table'))
    expect(tables.length).toBeGreaterThan(20)
  })

  it('would catch a plain table with no sorting', () => {
    // ⚠️ Proves the detector bites, without writing a bad file to disk.
    const bad = `
      export default function Thing() {
        return <table><thead><tr><th>Name</th></tr></thead></table>
      }`
    const stripped = stripComments(bad)
    expect(stripped.includes('<table')).toBe(true)
    expect(/<th[\s>]/.test(stripped)).toBe(true)
    expect(SORT_MARKERS.some((m) => stripped.includes(m))).toBe(false)
  })

  it('does not flag a table whose headers come from a comment', () => {
    // ⚠️ The BattleStatsCell case, as a unit rather than as an exception.
    const prose = `/** the <th> had no z-index, which is why #331 happened */
      export default function Cell() { return <table><tr><td>x</td></tr></table> }`
    expect(/<th[\s>]/.test(stripComments(prose))).toBe(false)
  })
})
