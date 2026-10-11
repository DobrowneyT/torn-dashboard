// Naming every faction a war's rows mention (#943 follow-up).
//
// ⚠️ The bug: a third faction that joined a war reached Discord as
// `faction 21716` while the War Overview page beside it showed the name. The
// page built its lookup from the attack rows; the internal endpoint built a
// smaller one from the opponent plus revivers. Same war, two answers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { resolveFactionNames } from '../src/warOverview/factionNames.js'

let stack: TestStack

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(
    `INSERT INTO factions (id, name, tag) VALUES (21716, 'Backfilled From Table', 'BFT')
     ON CONFLICT (id) DO NOTHING`)
}, 30000)

afterAll(async () => { await stack?.close() })

describe('naming factions from the rows', () => {
  it('⚠️ names a third faction from the ATTACK rows', async () => {
    // THE bug. These columns exist and the endpoint was not reading them.
    const names = await resolveFactionNames(stack.db, [
      { attacker_faction_id: 999, attacker_faction_name: 'Third Party',
        defender_faction_id: 10739, defender_faction_name: 'Us' },
    ])
    expect(names[999]).toBe('Third Party')
    expect(names[10739]).toBe('Us')
  })

  it('names a reviver faction, as it always did', async () => {
    const names = await resolveFactionNames(stack.db, [
      { reviver_faction_id: 555, reviver_faction_name: 'Medics' },
    ])
    expect(names[555]).toBe('Medics')
  })

  it('⚠️ backfills from the factions table when no row named it', async () => {
    // `factions-sync` maintains that table precisely so an id referenced by an
    // attack can be shown as a name rather than "faction 21716".
    const names = await resolveFactionNames(stack.db, [
      { attacker_faction_id: 21716, attacker_faction_name: null },
    ])
    expect(names[21716]).toBe('Backfilled From Table')
  })

  it('prefers the name ON THE ROW over the table', async () => {
    // ⚠️ The row's name is contemporaneous — what the faction was called at the
    // time — and a post-mortem read months later should say that, not today's.
    const names = await resolveFactionNames(stack.db, [
      { attacker_faction_id: 21716, attacker_faction_name: 'Name At The Time' },
    ])
    expect(names[21716]).toBe('Name At The Time')
  })

  it('⚠️ the opponent wins outright', async () => {
    // It is the name the war was fought under, and a stray row spelling it
    // differently must not override it.
    const names = await resolveFactionNames(
      stack.db,
      [{ attacker_faction_id: 777, attacker_faction_name: 'Stale Spelling' }],
      { id: 777, name: 'Romania Elite Kommando' },
    )
    expect(names[777]).toBe('Romania Elite Kommando')
  })

  it('⚠️ never names faction 0 — that is "no faction"', async () => {
    // A real filterable id with six figures of rows behind it on the live box.
    const names = await resolveFactionNames(stack.db, [
      { attacker_faction_id: 0, attacker_faction_name: 'nonsense' },
      { defender_faction_id: null, defender_faction_name: 'also nonsense' },
    ])
    expect(names[0]).toBeUndefined()
    expect(Object.keys(names)).toHaveLength(0)
  })

  it('an unknown id with no row name and no table entry is simply absent', async () => {
    // ⚠️ Absent, not guessed. The caller renders "faction <id>", which is
    // honest; inventing a name would not be.
    const names = await resolveFactionNames(stack.db, [
      { attacker_faction_id: 424242, attacker_faction_name: null },
    ])
    expect(names[424242]).toBeUndefined()
  })

  it('handles an empty set without querying for nothing', async () => {
    expect(await resolveFactionNames(stack.db, [])).toEqual({})
  })
})
