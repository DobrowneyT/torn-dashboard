// Naming every faction that appears in a war's rows.
//
// ⚠️ **One resolver, because there were nearly four.** The page builds this
// lookup from the attack rows (`WarOverviewView.jsx`), `warOverviewInternal`
// built a smaller one from the opponent plus revivers, and `memberWarReport`
// copied that smaller one. The result reached Discord as `faction 21716` while
// the page beside it showed the name — the same figure, two answers.
//
// ⚠️ **Three sources, in order of trust.** The rows carry the name AS RECORDED
// AT THE TIME, which is what a post-mortem wants; the `factions` table is the
// current name and covers ids the rows never named. The opponent comes from
// `ranked_wars` and wins outright, because that is the name the war was fought
// under.
import type pg from 'pg'

export interface NameableRow {
  attacker_faction_id?: number | string | null
  attacker_faction_name?: string | null
  defender_faction_id?: number | string | null
  defender_faction_name?: string | null
  reviver_faction_id?: number | string | null
  reviver_faction_name?: string | null
}

const PAIRS: Array<[idKey: keyof NameableRow, nameKey: keyof NameableRow]> = [
  ['attacker_faction_id', 'attacker_faction_name'],
  ['defender_faction_id', 'defender_faction_name'],
  ['reviver_faction_id', 'reviver_faction_name'],
]

/**
 * Names for every faction id these rows mention.
 *
 * ⚠️ `opponent` is applied LAST so it cannot be overwritten by a row that
 * happens to spell it differently.
 */
export async function resolveFactionNames(
  db: pg.Pool,
  rows: Iterable<NameableRow>,
  opponent?: { id: number | null; name: string | null },
): Promise<Record<number, string>> {
  const names: Record<number, string> = {}
  const seen = new Set<number>()

  for (const row of rows) {
    for (const [idKey, nameKey] of PAIRS) {
      const id = Number(row[idKey])
      // ⚠️ Faction 0 is "no faction" and must never be named. It is a real
      // filterable id with six figures of rows behind it on the live box.
      if (!Number.isFinite(id) || id <= 0) continue
      seen.add(id)
      const name = row[nameKey]
      if (typeof name === 'string' && name && !names[id]) names[id] = name
    }
  }

  // ⚠️ Backfill from `factions`, which `factions-sync` maintains precisely so
  // an id referenced by an attack can be shown as a name. Only for ids still
  // unnamed — a row's own name is contemporaneous and this one is current.
  const missing = [...seen].filter((id) => !names[id])
  if (missing.length > 0) {
    const res = await db.query(
      'SELECT id, name FROM factions WHERE id = ANY($1::int[])', [missing],
    )
    for (const r of res.rows) {
      if (r.name) names[Number(r.id)] = r.name
    }
  }

  if (opponent?.id && opponent.name) names[Number(opponent.id)] = opponent.name
  return names
}
