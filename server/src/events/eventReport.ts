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
/**
 * One-off lists (highest mugs, biggest hits, who hit us…) go to this many; the
 * page shows about ten and scrolls (MonChoon, 2026-10-18). Per-member boards
 * are never cut — every member is listed.
 */
export const LIST_LIMIT = 100

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
      // ⚠️ Torn's `details.best` is the best hit INCLUDING chain bonuses (the
      // 100k bonus is 40,960 respect). Each attacker's own `best` leaves bonus
      // hits out, so the best of those is the best ordinary hit.
      best: members.reduce((b, m) => Math.max(b, m.respect.best), 0),
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
  return memberDays(db, us, fromMs, toMs, names, true)
}

/**
 * Per-member figures over ONE range (#Stats view) — the daily figures without
 * the split by day, so "Overall" and a custom range add up the same way a day
 * does.
 */
export async function rangeMembers(db: pg.Pool, us: number, fromMs: number, toMs: number, names: NameBook) {
  const [only] = await memberDays(db, us, fromMs, toMs, names, false)
  return only ?? { totals: emptyTotals(), members: [] }
}

const emptyTotals = () => ({ hits: 0, mug: 0, hospitalize: 0, assists: 0, retaliations: 0, losses: 0,
  respect: 0, incoming: 0, beaten: 0, defended: 0 })

async function memberDays(db: pg.Pool, us: number, fromMs: number, toMs: number, names: NameBook, byDay: boolean) {
  if (toMs <= fromMs) return []
  const from = Math.floor(fromMs / 1000)
  const to = Math.ceil(toMs / 1000)
  const dayExpr = byDay ? `((started - $1) / ${DAY_S})::int` : '0'
  const out = await db.query(
    `SELECT ${dayExpr} AS day, attacker_id AS id,
            count(*) FILTER (WHERE result = ANY($4))         AS hits,
            count(*) FILTER (WHERE result = 'Attacked')      AS leave,
            count(*) FILTER (WHERE result = 'Mugged')        AS mug,
            count(*) FILTER (WHERE result = 'Hospitalized')  AS hospitalize,
            count(*) FILTER (WHERE result = $6)              AS assists,
            count(*) FILTER (WHERE result = ANY($5))         AS losses,
            -- A retaliation carries Torn's 1.5× retaliation modifier.
            count(*) FILTER (WHERE retaliation_modifier > 1) AS retaliations,
            coalesce(sum(respect_gain), 0)                   AS respect
       FROM faction_attacks
      WHERE NOT is_incoming AND attacker_faction_id = $3
        AND started >= $1 AND started < $2
      GROUP BY 1, 2`,
    [from, to, us, WINS, LOSSES, ASSIST_RESULT],
  )
  const inc = await db.query(
    `SELECT ${dayExpr} AS day, defender_id AS id,
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
        losses: 0, retaliations: 0, respect: 0, incoming: 0, beaten: 0, defended: 0 })
    }
    return m.get(id)
  }
  for (const r of out.rows) {
    const x = row(Number(r.day), Number(r.id))
    for (const k of ['hits', 'leave', 'mug', 'hospitalize', 'assists', 'losses', 'retaliations']) x[k] = Number(r[k])
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
        retaliations: sum('retaliations'),
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
      GROUP BY 1 ORDER BY hits DESC, id LIMIT ${LIST_LIMIT}`,
    [from, to, us],
  )
  const theirAttackers = await db.query(
    `SELECT attacker_id AS id, max(attacker_name) AS name, count(*) AS hits,
            count(DISTINCT defender_id) AS on_members
       FROM faction_attacks
      WHERE is_incoming AND defender_faction_id = $3
        AND attacker_faction_id IS DISTINCT FROM $3 AND started >= $1 AND started < $2
        AND attacker_id IS NOT NULL
      GROUP BY 1 ORDER BY hits DESC, id LIMIT ${LIST_LIMIT}`,
    [from, to, us],
  )
  // #987 — the same, by FACTION, EVERY faction (the page scrolls past ten).
  // ⚠️ Factionless players and stealthed attackers are left out: MonChoon
  // reviewed them as rows on staging and found them no use ("kind of
  // useless"). Both still count everywhere else on Targets.
  const weHit = await db.query(
    `SELECT coalesce(defender_faction_id, 0) AS id, max(defender_faction_name) AS name,
            count(*) AS attacks, count(*) FILTER (WHERE result = ANY($4)) AS wins,
            count(DISTINCT attacker_id) AS members, coalesce(sum(respect_gain), 0) AS respect
       FROM faction_attacks
      WHERE NOT is_incoming AND attacker_faction_id = $3 AND started >= $1 AND started < $2
        AND defender_faction_id IS NOT NULL
      GROUP BY 1 ORDER BY attacks DESC, respect DESC`,
    [from, to, us, WINS],
  )
  const hitUs = await db.query(
    `SELECT CASE WHEN attacker_faction_id IS NOT NULL THEN attacker_faction_id::text
                 WHEN is_stealthed THEN 'stealthed' ELSE 'none' END AS key,
            max(attacker_faction_name) AS name,
            count(*) AS attacks, count(*) FILTER (WHERE result = ANY($4)) AS beaten,
            count(*) FILTER (WHERE result = ANY($5)) AS defended,
            count(DISTINCT defender_id) AS members, coalesce(sum(respect_loss), 0) AS respect
       FROM faction_attacks
      WHERE is_incoming AND defender_faction_id = $3
        AND attacker_faction_id IS DISTINCT FROM $3
        AND attacker_faction_id IS NOT NULL
        AND started >= $1 AND started < $2
      GROUP BY 1 ORDER BY attacks DESC, respect DESC`,
    [from, to, us, WINS, LOSSES],
  )
  const label = (key: string, name: string | null) =>
    key === 'stealthed' ? 'Stealthed' : key === 'none' || key === '0' ? 'No faction' : (name ?? `Faction ${key}`)

  return {
    factions_we_hit: weHit.rows.map((r) => ({
      id: Number(r.id) || null, name: label(String(r.id), r.name), attacks: Number(r.attacks),
      wins: Number(r.wins), members: Number(r.members), respect_gained: round2(Number(r.respect)),
    })),
    factions_hit_us: hitUs.rows.map((r) => ({
      id: /^\d+$/.test(r.key) ? Number(r.key) : null, kind: /^\d+$/.test(r.key) ? 'faction' : r.key,
      name: label(r.key, r.name), attacks: Number(r.attacks), beaten: Number(r.beaten),
      defended: Number(r.defended), members: Number(r.members), respect_lost: round2(Number(r.respect)),
    })),
    members: members.sort((a, b) => b.incoming - a.incoming || b.outgoing - a.outgoing),
    most_targeted: [...members].filter((m) => m.incoming > 0)
      .sort((a, b) => b.incoming - a.incoming),
    most_active: [...members].filter((m) => m.outgoing > 0)
      .sort((a, b) => b.outgoing - a.outgoing),
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
 * Effects worth a leaderboard of their own (MonChoon, 2026-10-18: Revitalize
 * and treat drops "will be important data points"; of the other effects "im
 * not sure we care about any").
 *
 * ⚠️ Matched by PART of the icon name, because neither has been seen in a log
 * yet — Torn's exact icon for a Revitalize proc or a treat drop is unknown, and
 * `revital` / `treat` catch any spelling of it. Every other effect is still
 * stored and listed as "all effects seen", which is how the real names will be
 * spotted the first time they appear (#975).
 */
export const TRACKED_EFFECTS = [
  { key: 'revitalize', label: 'Revitalize', match: 'revital' },
  { key: 'treats', label: 'Treats', match: 'treat' },
] as const

/** "looted a Jawbreaker" / "looted 3x Concussion Grenade" / "looted some Pixie Sticks" … "from Jimmy". */
const LOOT = /\blooted (?:(\d+)x |an? |some )?(.+?) from (.+)$/

export function parseLoot(text: string): { qty: number; item: string; from: string } | null {
  const m = LOOT.exec(text)
  if (!m) return null
  return { qty: m[1] ? Number(m[1]) : 1, item: m[2].trim(), from: m[3].trim() }
}

/**
 * Highlights from the parsed attack logs, over a RANGE (#974, the Stats view):
 * highest mugs, biggest hits, bounties, the tracked effects, and loot. Our
 * members only. Every name carries its id, so the page can link it.
 */
export async function highlightsSection(
  db: pg.Pool, eventId: number, fromMs: number, toMs: number, names: NameBook,
) {
  const from = Math.floor(fromMs / 1000)
  const to = Math.ceil(toMs / 1000)
  const RANGE = 'p.event_id = $1 AND p.started >= $2 AND p.started < $3'
  const args = [eventId, from, to]
  const counts = await db.query(
    `SELECT count(*) AS parsed, coalesce(sum(mug_amount) FILTER (WHERE outgoing), 0) AS mugged,
            coalesce(sum(damage_dealt), 0) AS damage
       FROM event_attack_log_parsed p WHERE ${RANGE}`, args)
  const parsed = Number(counts.rows[0]?.parsed ?? 0)
  if (parsed === 0) return null

  const mugs = await db.query(
    `SELECT p.member_id AS id, p.mug_amount AS amount, a.defender_id AS target_id, a.defender_name AS target, p.started
       FROM event_attack_log_parsed p JOIN faction_attacks a ON a.attack_id = p.attack_id
      WHERE ${RANGE} AND p.outgoing AND p.mug_amount IS NOT NULL
      ORDER BY p.mug_amount DESC, p.attack_id LIMIT ${LIST_LIMIT}`, args)
  // Bounties our members claimed (v3). ⚠️ Outgoing only — a bounty claimed ON
  // one of ours is the opponent's prize, not a highlight.
  const bounties = await db.query(
    `SELECT p.member_id AS id, p.bounty_amount AS amount, a.defender_id AS target_id, a.defender_name AS target, p.started
       FROM event_attack_log_parsed p JOIN faction_attacks a ON a.attack_id = p.attack_id
      WHERE ${RANGE} AND p.outgoing AND p.bounty_amount IS NOT NULL
      ORDER BY p.bounty_amount DESC, p.attack_id`, args)
  const hits = await db.query(
    `SELECT p.member_id AS id, p.biggest_hit AS damage, p.outgoing,
            CASE WHEN p.outgoing THEN a.defender_id ELSE a.attacker_id END AS opponent_id,
            CASE WHEN p.outgoing THEN a.defender_name ELSE a.attacker_name END AS opponent, p.started
       FROM event_attack_log_parsed p JOIN faction_attacks a ON a.attack_id = p.attack_id
      WHERE ${RANGE} AND p.biggest_hit IS NOT NULL AND p.member_id IS NOT NULL
      ORDER BY p.biggest_hit DESC, p.attack_id LIMIT ${LIST_LIMIT}`, args)
  // An effect counts for our member only when THEY made it — not the
  // opponent's proc in the same fight.
  const effects = await db.query(
    `SELECT e.actor_id AS id, e.effect, e.text, e.started,
            -- Loot comes FROM the other side of the fight: the defender when we
            -- attacked, so the source (an NPC like Jimmy) can be linked by id.
            CASE WHEN p.outgoing THEN a.defender_id ELSE a.attacker_id END AS other_id
       FROM event_attack_log_effects e
       JOIN event_attack_log_parsed p ON p.attack_id = e.attack_id
       JOIN faction_attacks a ON a.attack_id = e.attack_id
      WHERE ${RANGE} AND e.actor_id = p.member_id`, args)

  const effectTotals: Record<string, number> = {}
  const tracked = Object.fromEntries(TRACKED_EFFECTS.map((t) => [t.key, new Map<number, number>()]))
  type LootDrop = { item: string; qty: number; from: string; from_id: number | null; at: number }
  const loot = new Map<number, { id: number; name: string; drops: number; items: Record<string, number>; detail: LootDrop[] }>()
  const lootItems = new Map<string, number>()
  const lootSources = new Map<string, { from: string; from_id: number | null; drops: number }>()
  for (const r of effects.rows) {
    const id = Number(r.id)
    effectTotals[r.effect] = (effectTotals[r.effect] ?? 0) + 1
    for (const t of TRACKED_EFFECTS) {
      if (String(r.effect).includes(t.match)) tracked[t.key].set(id, (tracked[t.key].get(id) ?? 0) + 1)
    }
    if (r.effect === 'loot') {
      const l = parseLoot(String(r.text))
      if (!l) continue
      if (!loot.has(id)) loot.set(id, { id, name: names.get(id), drops: 0, items: {}, detail: [] })
      const m = loot.get(id)!
      const fromId = r.other_id == null ? null : Number(r.other_id)
      m.drops++
      m.items[l.item] = (m.items[l.item] ?? 0) + l.qty
      m.detail.push({ item: l.item, qty: l.qty, from: l.from, from_id: fromId, at: Number(r.started) * 1000 })
      lootItems.set(l.item, (lootItems.get(l.item) ?? 0) + l.qty)
      const key = `${fromId ?? l.from}`
      const src = lootSources.get(key) ?? { from: l.from, from_id: fromId, drops: 0 }
      src.drops++
      lootSources.set(key, src)
    }
  }
  const board = (m: Map<number, number>) => [...m.entries()]
    .map(([id, n]) => ({ id, name: names.get(id), count: n }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const bountyBy = new Map<number, { id: number; name: string; claims: number; total: number }>()
  for (const r of bounties.rows) {
    const id = Number(r.id)
    if (!bountyBy.has(id)) bountyBy.set(id, { id, name: names.get(id), claims: 0, total: 0 })
    const x = bountyBy.get(id)!
    x.claims++
    x.total += Number(r.amount)
  }
  const idOrNull = (v: unknown) => (v == null ? null : Number(v))

  return {
    logs_parsed: parsed,
    total_mugged: Number(counts.rows[0].mugged),
    total_damage: Number(counts.rows[0].damage),
    highest_mugs: mugs.rows.map((r) => ({
      id: Number(r.id), name: names.get(r.id), amount: Number(r.amount),
      target_id: idOrNull(r.target_id), target: r.target ?? null, at: Number(r.started) * 1000,
    })),
    biggest_hits: hits.rows.map((r) => ({
      id: Number(r.id), name: names.get(r.id), damage: Number(r.damage), outgoing: !!r.outgoing,
      opponent_id: idOrNull(r.opponent_id), opponent: r.opponent ?? null, at: Number(r.started) * 1000,
    })),
    bounties: {
      claimed: bounties.rows.length,
      total: bounties.rows.reduce((t, r) => t + Number(r.amount), 0),
      // Most earned from bounties: per member, by total value.
      by_member: [...bountyBy.values()].sort((a, b) => b.total - a.total || b.claims - a.claims),
      top: bounties.rows.slice(0, LIST_LIMIT).map((r) => ({
        id: Number(r.id), name: names.get(r.id), amount: Number(r.amount),
        target_id: idOrNull(r.target_id), target: r.target ?? null, at: Number(r.started) * 1000,
      })),
    },
    tracked: TRACKED_EFFECTS.map((t) => {
      const rows = board(tracked[t.key])
      return { key: t.key, label: t.label, total: rows.reduce((n, r) => n + r.count, 0), by_member: rows }
    }),
    loot: {
      drops: [...loot.values()].reduce((n, m) => n + m.drops, 0),
      by_member: [...loot.values()].sort((a, b) => b.drops - a.drops || a.name.localeCompare(b.name)),
      by_item: [...lootItems.entries()].map(([item, qty]) => ({ item, qty })).sort((a, b) => b.qty - a.qty),
      by_source: [...lootSources.values()].sort((a, b) => b.drops - a.drops),
    },
    // Everything else, for discovery: the first Revitalize or treat line shows
    // up here under its real name.
    effect_totals: effectTotals,
  }
}

/**
 * The wanted board (MonChoon, 2026-10-18): outsiders who attacked ONE of our
 * members `threshold` times or more during the range — win or lose, because
 * someone who keeps losing to the same member is still coming for them.
 *
 * ⚠️ Stealthed attackers cannot be on it (Torn does not say who they are), and
 * attacks between our own members are not incoming at all. Leadership's
 * removals (a member paying someone for defends) come back marked, not hidden,
 * so the page can offer to restore them.
 */
export async function wantedSection(
  db: pg.Pool, eventId: number, us: number, fromMs: number, toMs: number, names: NameBook, threshold: number,
) {
  const from = Math.floor(fromMs / 1000)
  const to = Math.ceil(toMs / 1000)
  const pairs = await db.query(
    `SELECT attacker_id, defender_id,
            max(attacker_name) AS attacker_name,
            max(attacker_faction_id) AS faction_id, max(attacker_faction_name) AS faction_name,
            count(*) AS attacks,
            count(*) FILTER (WHERE result = ANY($4)) AS won,
            count(*) FILTER (WHERE result = ANY($5)) AS failed,
            coalesce(sum(respect_loss), 0) AS respect,
            min(started) AS first_s, max(started) AS last_s
       FROM faction_attacks
      WHERE is_incoming AND defender_faction_id = $3
        AND attacker_faction_id IS DISTINCT FROM $3
        AND attacker_id IS NOT NULL
        AND started >= $1 AND started < $2
      GROUP BY attacker_id, defender_id`,
    [from, to, us, WINS, LOSSES],
  )
  const dismissed = await db.query(
    `SELECT attacker_id, note, dismissed_by,
            (extract(epoch from dismissed_at) * 1000)::bigint AS dismissed_ms
       FROM event_wanted_dismissed WHERE event_id = $1`, [eventId])
  const off = new Map(dismissed.rows.map((r) => [Number(r.attacker_id), r]))

  type Victim = { id: number; name: string; attacks: number; won: number; failed: number }
  const by = new Map<number, {
    id: number; name: string; faction_id: number | null; faction_name: string | null
    attacks: number; won: number; failed: number; respect_taken: number
    first_ms: number; last_ms: number; victims: Victim[]; most_on_one: number
  }>()
  for (const r of pairs.rows) {
    const id = Number(r.attacker_id)
    if (!by.has(id)) {
      by.set(id, {
        id, name: r.attacker_name ?? `#${id}`,
        faction_id: r.faction_id == null ? null : Number(r.faction_id), faction_name: r.faction_name ?? null,
        attacks: 0, won: 0, failed: 0, respect_taken: 0,
        first_ms: Number(r.first_s) * 1000, last_ms: Number(r.last_s) * 1000, victims: [], most_on_one: 0,
      })
    }
    const a = by.get(id)!
    const n = Number(r.attacks)
    a.attacks += n
    a.won += Number(r.won)
    a.failed += Number(r.failed)
    a.respect_taken = round2(a.respect_taken + Number(r.respect))
    a.first_ms = Math.min(a.first_ms, Number(r.first_s) * 1000)
    a.last_ms = Math.max(a.last_ms, Number(r.last_s) * 1000)
    a.most_on_one = Math.max(a.most_on_one, n)
    a.victims.push({ id: Number(r.defender_id), name: names.get(r.defender_id), attacks: n,
      won: Number(r.won), failed: Number(r.failed) })
  }
  const wanted = [...by.values()]
    .filter((a) => a.most_on_one >= threshold)
    .map((a) => ({ ...a, victims: a.victims.sort((x, y) => y.attacks - x.attacks) }))
    .sort((x, y) => y.most_on_one - x.most_on_one || y.attacks - x.attacks || x.name.localeCompare(y.name))
  return {
    threshold,
    wanted: wanted.filter((a) => !off.has(a.id)),
    dismissed: wanted.filter((a) => off.has(a.id)).map((a) => {
      const d = off.get(a.id)!
      return { ...a, note: d.note ?? null, dismissed_by: d.dismissed_by == null ? null : Number(d.dismissed_by),
        dismissed_by_name: d.dismissed_by == null ? null : names.get(d.dismissed_by),
        dismissed_ms: Number(d.dismissed_ms) }
    }),
  }
}

/**
 * Everyone who attacked ONE of our members in the range — the breakdown behind
 * "Most targeted". ⚠️ Stealthed attacks are one row of their own, so the rows
 * add up to the member's incoming total on Targets.
 */
export async function memberAttackers(
  db: pg.Pool, us: number, memberId: number, fromMs: number, toMs: number,
) {
  const from = Math.floor(fromMs / 1000)
  const to = Math.ceil(toMs / 1000)
  const r = await db.query(
    `SELECT attacker_id, max(attacker_name) AS name,
            max(attacker_faction_id) AS faction_id, max(attacker_faction_name) AS faction_name,
            count(*) AS attacks,
            count(*) FILTER (WHERE result = ANY($5)) AS won,
            count(*) FILTER (WHERE result = ANY($6)) AS failed,
            coalesce(sum(respect_loss), 0) AS respect,
            min(started) AS first_s, max(started) AS last_s
       FROM faction_attacks
      WHERE is_incoming AND defender_faction_id = $3 AND defender_id = $4
        AND attacker_faction_id IS DISTINCT FROM $3
        AND started >= $1 AND started < $2
      GROUP BY attacker_id
      ORDER BY attacks DESC, attacker_id`,
    [from, to, us, memberId, WINS, LOSSES],
  )
  const rows = r.rows.map((x) => ({
    id: x.attacker_id == null ? null : Number(x.attacker_id),
    // ⚠️ No attacker id means Torn hid who it was.
    name: x.attacker_id == null ? 'Stealthed' : (x.name ?? `#${x.attacker_id}`),
    faction_id: x.faction_id == null ? null : Number(x.faction_id), faction_name: x.faction_name ?? null,
    attacks: Number(x.attacks), won: Number(x.won), failed: Number(x.failed),
    respect_taken: round2(Number(x.respect)),
    first_ms: Number(x.first_s) * 1000, last_ms: Number(x.last_s) * 1000,
  }))
  return { member_id: memberId, total: rows.reduce((n, x) => n + x.attacks, 0), attackers: rows }
}
