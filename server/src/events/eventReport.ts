// The event's live chain report (#971): what the Report tab shows.
//
// Two sources, and which figure comes from which is the design (#967):
//   * the CHAIN REPORT (polled by #970) is the source of truth for totals and
//     per-member figures — the numbers members will check us against, so we
//     show Torn's own rather than rebuilding them;
//   * `faction_attacks` (attacks-sync) gives the DAILY split and the TARGETS,
//     because it backfills after an outage — the chain report is cumulative
//     and cannot say what happened on which day.
//
// ⚠️ Respect is shown both ways, as the war report does: raw, and capped at 10
// per bonus hit with the deduction named.
import type pg from 'pg'
import { cappedRespectByMember } from './eventChainReport.js'
import { WIN_RESULTS, LOSS_RESULTS, ASSIST_RESULT } from '../warOverview/summary.js'

const DAY_S = 86_400
/** How many rows the most-targeted lists show. */
export const TOP_TARGETS = 10

// Torn's per-attack counters, in the order the report shows them.
export const ATTACK_KEYS = [
  'total', 'leave', 'mug', 'hospitalize', 'assists', 'retaliations', 'overseas',
  'draws', 'escapes', 'losses', 'war', 'bonuses',
] as const

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (n: number) => Math.round(n * 100) / 100

export interface NameBook { get(id: number | string): string }

export function nameBook(rows: Array<{ id: unknown; name: unknown }>): NameBook {
  const m = new Map(rows.map((r) => [String(r.id), String(r.name)]))
  return { get: (id) => m.get(String(id)) ?? `#${id}` }
}

/** Totals and per-member figures, straight from the latest chain report. */
export function chainSection(latest: any, names: NameBook) {
  const attackers: any[] = latest.attackers ?? []
  const bonuses: any[] = latest.bonuses ?? []
  const capped = cappedRespectByMember(attackers, bonuses)
  const bonusCount = new Map<string, number>()
  for (const b of bonuses) bonusCount.set(String(b.attacker_id), (bonusCount.get(String(b.attacker_id)) ?? 0) + 1)

  const members = attackers.map((a) => {
    const id = Number(a.id)
    const c = capped.get(String(a.id))!
    const attacks: Record<string, number> = {}
    for (const k of ATTACK_KEYS) attacks[k] = num(a.attacks?.[k])
    return {
      id,
      name: names.get(id),
      respect: {
        total: num(a.respect?.total), average: num(a.respect?.average), best: num(a.respect?.best),
        capped: c.capped, deduction: c.deduction,
      },
      attacks,
      bonus_hits: bonusCount.get(String(a.id)) ?? 0,
    }
  }).sort((x, y) => y.attacks.total - x.attacks.total || y.respect.total - x.respect.total)

  const d = latest.details ?? {}
  const deduction = round2(members.reduce((s, m) => s + m.respect.deduction, 0))
  const raw = num(d.respect)
  return {
    chain_id: Number(latest.chain_id),
    start: Number(latest.start_ms),
    end: latest.end_ms == null ? null : Number(latest.end_ms),
    as_of: Number(latest.sampled_ms),
    totals: {
      chain: num(d.chain),
      hits: members.reduce((s, m) => s + m.attacks.total, 0),
      respect: { raw, capped: round2(raw - deduction), deduction },
      members: num(d.members),
      targets: num(d.targets),
      best: num(d.best),
      leave: num(d.leave), mug: num(d.mug), hospitalize: num(d.hospitalize),
      assists: num(d.assists), retaliations: num(d.retaliations), overseas: num(d.overseas),
      draws: num(d.draws), escapes: num(d.escapes), losses: num(d.losses), war: num(d.war),
      bonuses: bonuses.length,
    },
    bonuses: bonuses.map((b) => ({
      chain: num(b.chain), attacker_id: Number(b.attacker_id), attacker: names.get(b.attacker_id),
      defender_id: Number(b.defender_id), respect: num(b.respect),
    })).sort((x, y) => x.chain - y.chain),
    members,
    non_attackers: (latest.non_attackers ?? [])
      .map((id: unknown) => ({ id: Number(id), name: names.get(id as number) }))
      .sort((x: any, y: any) => x.name.localeCompare(y.name)),
  }
}

const WINS = [...WIN_RESULTS]
const LOSSES = [...LOSS_RESULTS]

/**
 * Per TCT day from `daily_from`, per member — from attacks-sync, so a day an
 * outage interrupted fills itself in once Torn is back.
 *
 * ⚠️ Days are 24-hour windows from `daily_from`, which leadership set to a TCT
 * midnight; `day` is the date that window starts on.
 */
export async function dailySection(db: pg.Pool, us: number, fromMs: number, toMs: number, names: NameBook) {
  if (toMs <= fromMs) return []
  const from = Math.floor(fromMs / 1000)
  const to = Math.ceil(toMs / 1000)
  const out = await db.query(
    `SELECT ((started - $1) / ${DAY_S})::int AS day, attacker_id AS id,
            count(*) FILTER (WHERE result = ANY($4))         AS hits,
            count(*) FILTER (WHERE result = 'Attacked')      AS leave,
            count(*) FILTER (WHERE result = 'Mugged')        AS mug,
            count(*) FILTER (WHERE result = 'Hospitalized')  AS hospitalize,
            count(*) FILTER (WHERE result = $6)              AS assists,
            count(*) FILTER (WHERE result = ANY($5))         AS losses,
            coalesce(sum(respect_gain), 0)                   AS respect
       FROM faction_attacks
      WHERE NOT is_incoming AND attacker_faction_id = $3
        AND started >= $1 AND started < $2
      GROUP BY 1, 2`,
    [from, to, us, WINS, LOSSES, ASSIST_RESULT],
  )
  const inc = await db.query(
    `SELECT ((started - $1) / ${DAY_S})::int AS day, defender_id AS id,
            count(*)                                  AS incoming,
            count(*) FILTER (WHERE result = ANY($4))  AS beaten,
            count(*) FILTER (WHERE result = ANY($5))  AS defended
       FROM faction_attacks
      WHERE is_incoming AND defender_faction_id = $3
        AND attacker_faction_id IS DISTINCT FROM $3
        AND started >= $1 AND started < $2
      GROUP BY 1, 2`,
    [from, to, us, WINS, LOSSES],
  )

  const days = new Map<number, Map<number, any>>()
  const row = (day: number, id: number) => {
    if (!days.has(day)) days.set(day, new Map())
    const m = days.get(day)!
    if (!m.has(id)) {
      m.set(id, { id, name: names.get(id), hits: 0, leave: 0, mug: 0, hospitalize: 0, assists: 0,
        losses: 0, respect: 0, incoming: 0, beaten: 0, defended: 0 })
    }
    return m.get(id)
  }
  for (const r of out.rows) {
    const x = row(Number(r.day), Number(r.id))
    for (const k of ['hits', 'leave', 'mug', 'hospitalize', 'assists', 'losses']) x[k] = Number(r[k])
    x.respect = round2(Number(r.respect))
  }
  for (const r of inc.rows) {
    const x = row(Number(r.day), Number(r.id))
    x.incoming = Number(r.incoming); x.beaten = Number(r.beaten); x.defended = Number(r.defended)
  }

  return [...days.entries()].sort((a, b) => a[0] - b[0]).map(([day, m]) => {
    const members = [...m.values()].sort((a, b) => b.hits - a.hits || b.respect - a.respect)
    const sum = (k: string) => members.reduce((s, x) => s + x[k], 0)
    return {
      day: new Date((from + day * DAY_S) * 1000).toISOString().slice(0, 10), // db-time-safe: epoch maths
      starts_at: (from + day * DAY_S) * 1000,
      totals: {
        hits: sum('hits'), mug: sum('mug'), hospitalize: sum('hospitalize'), assists: sum('assists'),
        losses: sum('losses'), respect: round2(sum('respect')), incoming: sum('incoming'),
        beaten: sum('beaten'), defended: sum('defended'),
      },
      members,
    }
  })
}

/** Incoming and outgoing per member, and who was hit most — whole event. */
export async function targetsSection(db: pg.Pool, us: number, fromMs: number, toMs: number, names: NameBook) {
  const from = Math.floor(fromMs / 1000)
  const to = Math.ceil(toMs / 1000)
  const perMember = await db.query(
    `WITH o AS (
       SELECT attacker_id AS id, count(*) AS outgoing, count(DISTINCT defender_id) AS distinct_targets
         FROM faction_attacks
        WHERE NOT is_incoming AND attacker_faction_id = $3 AND started >= $1 AND started < $2
        GROUP BY 1),
     i AS (
       SELECT defender_id AS id, count(*) AS incoming,
              count(*) FILTER (WHERE result = ANY($4)) AS beaten,
              count(*) FILTER (WHERE result = ANY($5)) AS defended,
              count(DISTINCT attacker_id) AS distinct_attackers
         FROM faction_attacks
        WHERE is_incoming AND defender_faction_id = $3
        AND attacker_faction_id IS DISTINCT FROM $3 AND started >= $1 AND started < $2
        GROUP BY 1)
     -- ⚠️ An attack between two of OUR members (sparring, a chain feed) is
     -- stored as incoming; it is neither, and counting it put our own members
     -- in "Who hit us most" (found on staging, 2026-10-17).
     SELECT coalesce(o.id, i.id) AS id,
            coalesce(o.outgoing, 0) AS outgoing, coalesce(o.distinct_targets, 0) AS distinct_targets,
            coalesce(i.incoming, 0) AS incoming, coalesce(i.beaten, 0) AS beaten,
            coalesce(i.defended, 0) AS defended, coalesce(i.distinct_attackers, 0) AS distinct_attackers
       FROM o FULL JOIN i ON i.id = o.id`,
    [from, to, us, WINS, LOSSES],
  )
  const members = perMember.rows.map((r) => ({
    id: Number(r.id), name: names.get(r.id),
    outgoing: Number(r.outgoing), distinct_targets: Number(r.distinct_targets),
    incoming: Number(r.incoming), beaten: Number(r.beaten), defended: Number(r.defended),
    distinct_attackers: Number(r.distinct_attackers),
  }))

  // Who outside the faction we hit most, and who hit us most.
  const ourTargets = await db.query(
    `SELECT defender_id AS id, max(defender_name) AS name, count(*) AS hits,
            count(DISTINCT attacker_id) AS by_members
       FROM faction_attacks
      WHERE NOT is_incoming AND attacker_faction_id = $3 AND started >= $1 AND started < $2
      GROUP BY 1 ORDER BY hits DESC, id LIMIT ${TOP_TARGETS}`,
    [from, to, us],
  )
  const theirAttackers = await db.query(
    `SELECT attacker_id AS id, max(attacker_name) AS name, count(*) AS hits,
            count(DISTINCT defender_id) AS on_members
       FROM faction_attacks
      WHERE is_incoming AND defender_faction_id = $3
        AND attacker_faction_id IS DISTINCT FROM $3 AND started >= $1 AND started < $2
        AND attacker_id IS NOT NULL
      GROUP BY 1 ORDER BY hits DESC, id LIMIT ${TOP_TARGETS}`,
    [from, to, us],
  )
  return {
    members: members.sort((a, b) => b.incoming - a.incoming || b.outgoing - a.outgoing),
    most_targeted: [...members].filter((m) => m.incoming > 0)
      .sort((a, b) => b.incoming - a.incoming).slice(0, TOP_TARGETS),
    most_active: [...members].filter((m) => m.outgoing > 0)
      .sort((a, b) => b.outgoing - a.outgoing).slice(0, TOP_TARGETS),
    our_top_targets: ourTargets.rows.map((r) => ({
      id: Number(r.id), name: r.name ?? `#${r.id}`, hits: Number(r.hits), by_members: Number(r.by_members),
    })),
    top_attackers_on_us: theirAttackers.rows.map((r) => ({
      // ⚠️ Stealthed attackers arrive as "Someone"; the id is the identity.
      id: Number(r.id), name: r.name ?? `#${r.id}`, hits: Number(r.hits), on_members: Number(r.on_members),
    })),
  }
}

/**
 * What the report was built from, as one string (#972). The page asks for this
 * every few seconds and refetches the whole report only when it changes.
 *
 * ⚠️ **New attack ids, never `rows_written`.** Forge's attacks-sync reports
 * `rows_written = 1` every two minutes with nothing new, because its cursor
 * re-reads the newest attack on purpose. The count catches an outage backfill
 * landing BELOW the newest id; the max catches the ordinary new attack.
 *
 * ⚠️ The chain report part is the poller's `content_hash`, which only moves
 * when the report itself differs — an identical poll changes nothing here.
 */
export async function reportVersion(db: pg.Pool, eventId: number, us: number, fromMs: number, toMs: number) {
  const from = Math.floor(fromMs / 1000)
  const to = Math.ceil(toMs / 1000)
  const [rep, atk, parsed] = await Promise.all([
    db.query('SELECT content_hash FROM event_chain_report_latest WHERE event_id = $1', [eventId]),
    db.query(
      `SELECT count(*) AS n, max(attack_id) AS top FROM faction_attacks
        WHERE started >= $1 AND started < $2
          AND (attacker_faction_id = $3 OR defender_faction_id = $3)`,
      [from, to, us]),
    // #974 — the highlights move as logs are parsed, which can lag the attack.
    db.query('SELECT count(*) AS n FROM event_attack_log_parsed WHERE event_id = $1', [eventId]),
  ])
  return `${rep.rows[0]?.content_hash ?? '-'}:${atk.rows[0]?.n ?? 0}:${atk.rows[0]?.top ?? 0}:${parsed.rows[0]?.n ?? 0}`
}

/**
 * Highlights from the parsed attack logs (#974): highest mug, biggest hit,
 * most effects (procs), and effects per day. Our members only.
 *
 * ⚠️ Effects are named by the log line's icon — `stricken`, `plunder`,
 * `powerful`… — so a proc nobody has seen yet (Revitalize) appears here under
 * its own name the first time a real log carries it.
 */
export async function highlightsSection(
  db: pg.Pool, eventId: number, fromDailyMs: number, names: NameBook,
) {
  const counts = await db.query(
    `SELECT count(*) AS parsed, coalesce(sum(mug_amount) FILTER (WHERE outgoing), 0) AS mugged,
            coalesce(sum(damage_dealt), 0) AS damage
       FROM event_attack_log_parsed WHERE event_id = $1`, [eventId])
  const parsed = Number(counts.rows[0]?.parsed ?? 0)
  if (parsed === 0) return null

  const mugs = await db.query(
    `SELECT p.member_id AS id, p.mug_amount AS amount, a.defender_name AS target, p.started
       FROM event_attack_log_parsed p JOIN faction_attacks a ON a.attack_id = p.attack_id
      WHERE p.event_id = $1 AND p.outgoing AND p.mug_amount IS NOT NULL
      ORDER BY p.mug_amount DESC, p.attack_id LIMIT ${TOP_TARGETS}`, [eventId])
  // Bounties our members claimed (v3). ⚠️ Outgoing only — a bounty claimed ON
  // one of ours is the opponent's prize, not a highlight.
  const bounties = await db.query(
    `SELECT p.member_id AS id, p.bounty_amount AS amount, a.defender_name AS target, p.started
       FROM event_attack_log_parsed p JOIN faction_attacks a ON a.attack_id = p.attack_id
      WHERE p.event_id = $1 AND p.outgoing AND p.bounty_amount IS NOT NULL
      ORDER BY p.bounty_amount DESC, p.attack_id`, [eventId])
  const hits = await db.query(
    `SELECT p.member_id AS id, p.biggest_hit AS damage, p.outgoing,
            CASE WHEN p.outgoing THEN a.defender_name ELSE a.attacker_name END AS opponent, p.started
       FROM event_attack_log_parsed p JOIN faction_attacks a ON a.attack_id = p.attack_id
      WHERE p.event_id = $1 AND p.biggest_hit IS NOT NULL AND p.member_id IS NOT NULL
      ORDER BY p.biggest_hit DESC, p.attack_id LIMIT ${TOP_TARGETS}`, [eventId])
  // An effect counts for our member only when THEY made it — not the
  // opponent's proc in the same fight.
  const effects = await db.query(
    `SELECT e.actor_id AS id, e.effect, count(*) AS n
       FROM event_attack_log_effects e JOIN event_attack_log_parsed p ON p.attack_id = e.attack_id
      WHERE e.event_id = $1 AND e.actor_id = p.member_id
      GROUP BY 1, 2`, [eventId])
  const perDay = await db.query(
    `SELECT ((e.started - $2) / ${DAY_S})::int AS day, e.effect, count(*) AS n
       FROM event_attack_log_effects e JOIN event_attack_log_parsed p ON p.attack_id = e.attack_id
      WHERE e.event_id = $1 AND e.actor_id = p.member_id AND e.started >= $2
      GROUP BY 1, 2 ORDER BY 1, 2`, [eventId, Math.floor(fromDailyMs / 1000)])

  const byMember = new Map<number, { id: number; name: string; total: number; effects: Record<string, number> }>()
  for (const r of effects.rows) {
    const id = Number(r.id)
    if (!byMember.has(id)) byMember.set(id, { id, name: names.get(id), total: 0, effects: {} })
    const m = byMember.get(id)!
    m.total += Number(r.n)
    m.effects[r.effect] = Number(r.n)
  }
  const effectTotals: Record<string, number> = {}
  for (const m of byMember.values()) {
    for (const [k, v] of Object.entries(m.effects)) effectTotals[k] = (effectTotals[k] ?? 0) + v
  }
  const days = new Map<number, Record<string, number>>()
  for (const r of perDay.rows) {
    const d = Number(r.day)
    if (!days.has(d)) days.set(d, {})
    days.get(d)![r.effect] = Number(r.n)
  }
  const from = Math.floor(fromDailyMs / 1000)

  return {
    logs_parsed: parsed,
    total_mugged: Number(counts.rows[0].mugged),
    total_damage: Number(counts.rows[0].damage),
    highest_mugs: mugs.rows.map((r) => ({
      id: Number(r.id), name: names.get(r.id), amount: Number(r.amount), target: r.target ?? null,
      at: Number(r.started) * 1000,
    })),
    biggest_hits: hits.rows.map((r) => ({
      id: Number(r.id), name: names.get(r.id), damage: Number(r.damage), outgoing: !!r.outgoing,
      opponent: r.opponent ?? null, at: Number(r.started) * 1000,
    })),
    bounties: {
      claimed: bounties.rows.length,
      total: bounties.rows.reduce((t, r) => t + Number(r.amount), 0),
      top: bounties.rows.slice(0, TOP_TARGETS).map((r) => ({
        id: Number(r.id), name: names.get(r.id), amount: Number(r.amount), target: r.target ?? null,
        at: Number(r.started) * 1000,
      })),
    },
    most_effects: [...byMember.values()].sort((a, b) => b.total - a.total).slice(0, TOP_TARGETS),
    effect_totals: effectTotals,
    effects_by_day: [...days.entries()].sort((a, b) => a[0] - b[0]).map(([d, counts]) => ({
      day: new Date((from + d * DAY_S) * 1000).toISOString().slice(0, 10), // db-time-safe: epoch maths
      starts_at: (from + d * DAY_S) * 1000,
      effects: counts,
    })),
  }
}
