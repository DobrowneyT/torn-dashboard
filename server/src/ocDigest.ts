// OC supply digest and efficiency report (#1024, PRD #1018).
//
// ⚠️ **On request only** (MonChoon, 2026-10-19): `/oc digest` and `/oc report`
// in Discord ask for these; nothing is posted on a schedule.
//
//   digest — supply right now: per crime level, open seats, members seated,
//            and members out of an OC who clear the bar for an open seat there.
//   report — for crimes that finished in the window: how each crew's
//            role-weighted CPR compared with the best arrangement of the same
//            people, and, for failures, the weakest heavy seat.
//
// ⚠️ Scope is not in it: the dashboard does not store the faction's scope, and
// a digest that guessed would be worse than one that says it does not know.
import type pg from 'pg'
import { collectOcWatch } from './ocWatchInternal.js'
import { bestArrangement, openSeatsFor, TOP_TIER, type Crime, type Readings } from './ocSuggestionProducers.js'
import { loadOcModel } from './oc/modelLoader.js'

async function readingsFor(db: pg.Pool, ids: string[]): Promise<Readings> {
  const readings: Readings = new Map()
  if (!ids.length) return readings
  const { rows } = await db.query(
    'SELECT member_id, crime_name, position_label, cpr_value FROM member_cpr_v2 WHERE member_id = ANY($1)', [ids])
  for (const r of rows) {
    const m = readings.get(String(r.member_id)) ?? new Map<string, number>()
    m.set(`${r.crime_name}||${r.position_label}`, Math.round(Number(r.cpr_value)))
    readings.set(String(r.member_id), m)
  }
  return readings
}

export async function collectDigest(db: pg.Pool, nowMs = Date.now()) {
  const feed = await collectOcWatch(db, nowMs)
  const crimes = feed.crimes as Crime[]
  const { rows: current } = await db.query(
    `SELECT member_id, member_name FROM members WHERE is_current IS TRUE AND is_fallen IS NOT TRUE`)
  const ids = current.map((r: any) => String(r.member_id))
  const readings = await readingsFor(db, ids)

  const seated = new Set<string>()
  for (const c of crimes) for (const s of c.slots ?? []) if (s.user?.id != null) seated.add(String(s.user.id))
  const idle = ids.filter((id) => !seated.has(id))

  const levels = new Map<number, { crimes: number; open: number; seated: number; idle_qualified: number }>()
  const level = (d: number) => {
    let l = levels.get(d)
    if (!l) { l = { crimes: 0, open: 0, seated: 0, idle_qualified: 0 }; levels.set(d, l) }
    return l
  }
  for (const c of crimes) {
    const l = level(c.difficulty)
    l.crimes++
    for (const s of c.slots ?? []) {
      if (s.user?.id != null) l.seated++
      else if (c.status === 'Recruiting') l.open++
    }
  }
  // Out of an OC and clearing the bar for an open seat at that level.
  for (const id of idle) {
    const qualifiedAt = new Set(openSeatsFor(id, crimes, readings).filter((s) => s.clears === true).map((s) => s.crime.difficulty))
    for (const d of qualifiedAt) level(d).idle_qualified++
  }

  const byLevel = [...levels.entries()].sort((a, b) => b[0] - a[0]).map(([difficulty, l]) => ({ difficulty, ...l }))
  // "What to start next": a top-tier level with more qualified idle members than open seats.
  const startNext = byLevel
    .filter((l) => l.difficulty >= TOP_TIER && l.idle_qualified > l.open)
    .map((l) => ({ difficulty: l.difficulty, short_by: l.idle_qualified - l.open }))
  return {
    server_now: nowMs,
    crimes_fetched_at: feed.crimes_fetched_at,
    members: { current: ids.length, seated: ids.length - idle.length, idle: idle.length },
    levels: byLevel,
    start_next: startNext,
    scope: null as null,
  }
}

/** "Picklock" #1 of two → "Picklock #1"; a role that appears once keeps its bare name. */
function seatLabel(position: string, number: number | null, sameRole: number): string {
  return sameRole > 1 && number != null ? `${position} #${number}` : position
}

export async function collectReport(db: pg.Pool, days = 7, nowMs = Date.now()) {
  const since = Math.floor(nowMs / 1000) - days * 86400
  const { rows: crimes } = await db.query(
    `SELECT crime_id, name, difficulty, status, executed_at FROM crimes
      WHERE status IN ('Successful', 'Failure') AND executed_at >= $1 ORDER BY executed_at DESC`, [since])
  const { rows: slots } = crimes.length ? await db.query(
    `SELECT crime_id, position, position_id, position_number, checkpoint_pass_rate::float8 AS cpr, user_id, user_name
       FROM crime_slots WHERE crime_id = ANY($1)`, [crimes.map((c: any) => c.crime_id)]) : { rows: [] as any[] }
  const slotsOf = new Map<string, any[]>()
  for (const s of slots) slotsOf.set(s.crime_id, [...(slotsOf.get(s.crime_id) ?? []), s])
  const memberIds = [...new Set(slots.map((s: any) => String(s.user_id)).filter(Boolean))]
  const readings = await readingsFor(db, memberIds)
  const model = loadOcModel()

  let analysed = 0
  let sumEfficiency = 0
  const gaps: any[] = []
  const failures: any[] = []
  let successes = 0
  for (const c of crimes) {
    if (c.status === 'Successful') successes++
    const m = model.get(c.name)
    const ss = (slotsOf.get(c.crime_id) ?? []).filter((s) => s.user_id)
    if (!m || ss.length < 1) continue
    const weightOf = new Map(m.roles.map((r) => [r.positionId, r.weight]))
    const count = new Map<string, number>()
    for (const s of ss) count.set(s.position, (count.get(s.position) ?? 0) + 1)
    const seats = ss.map((s) => ({
      ...s, label: seatLabel(s.position, s.position_number, count.get(s.position) ?? 1),
      weight: weightOf.get(s.position_id) ?? 0,
    }))
    if (seats.some((s) => !s.weight || s.cpr == null)) continue
    const total = seats.reduce((n, s) => n + s.weight, 0)

    if (c.status === 'Failure') {
      // The weakest heavy seat: the most weight left on the table.
      const worst = [...seats].sort((a, b) => b.weight * (100 - b.cpr) - a.weight * (100 - a.cpr))[0]
      failures.push({
        crime_id: c.crime_id, name: c.name, difficulty: c.difficulty, executed_at: Number(c.executed_at) * 1000,
        weakest: { label: worst.label, member_id: String(worst.user_id), member_name: worst.user_name,
          cpr: Math.round(worst.cpr), weight_pct: Math.round((worst.weight / total) * 100) },
      })
    }

    const members = seats.map((s) => String(s.user_id))
    const now = seats.map((_, i) => i)
    // ⚠️ The seat they held uses the CPR Torn recorded at execution; any other
    // seat uses today's reading — the only one we have. Stated in the report.
    const cprOf = (mid: string, i: number) => members[i] === mid
      ? seats[i].cpr
      : readings.get(mid)?.get(`${c.name}||${seats[i].label}`) ?? null
    const found = bestArrangement(members, now, cprOf, seats.map((s) => s.weight))
    if (!found) continue
    analysed++
    const efficiency = found.bestScore > 0 ? found.nowScore / found.bestScore : 1
    sumEfficiency += efficiency
    const gain = (found.bestScore - found.nowScore) / total
    if (gain > 0.05) {
      const moves = members
        .map((mid, k) => (found.best[k] !== now[k]
          ? `${seats[k].user_name ?? mid}: ${seats[k].label} → ${seats[found.best[k]].label}` : null))
        .filter(Boolean)
      gaps.push({ crime_id: c.crime_id, name: c.name, difficulty: c.difficulty, status: c.status,
        executed_at: Number(c.executed_at) * 1000, weighted_gain: Math.round(gain * 10) / 10, moves })
    }
  }
  gaps.sort((a, b) => b.weighted_gain - a.weighted_gain)
  return {
    days,
    finished: crimes.length,
    successful: successes,
    failed: crimes.length - successes,
    analysed,
    average_efficiency: analysed ? Math.round((sumEfficiency / analysed) * 1000) / 10 : null,
    could_have_seated_better: gaps.length,
    biggest_gaps: gaps.slice(0, 5),
    failures: failures.slice(0, 10),
    caveat: 'Other seats are judged on today\'s CPR readings; the seat each member held uses the CPR recorded when the crime ran.',
  }
}
