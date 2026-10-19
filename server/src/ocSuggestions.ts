// The OC action feed (#1020, PRD #1018).
//
// Producers — seat swaps (#1021), joined too low (#1022), members not in an OC
// (#1023) — call `reportSuggestions` with every suggestion of their kind they
// can see RIGHT NOW. This module turns that into a lifecycle the bot renders:
//
//   new key            → open            (the bot posts it)
//   same key, changed  → open, version+1 (the bot edits it)
//   key gone, resolved → resolved        (the producer saw the move happen)
//   key gone otherwise → expired         (no longer possible)
//   Done pressed       → done            (and stays done — never re-nagged)
//   Not now pressed    → snoozed until T, then open again
//
// ⚠️ **A version, not a "dirty" flag.** Every change bumps `version`; the bot
// reports back the version it drew. Anything with `rendered_version < version`
// needs the bot, so a crash between "edited the message" and "told the
// dashboard" just redraws it once more — never a lost state, never a duplicate.
import type pg from 'pg'

export interface SuggestionInput {
  key: string
  kind: string
  crimeId?: string | null
  memberIds?: string[]
  title: string
  body?: string
  steps?: string[]
  value?: Record<string, number>
  severity?: 'info' | 'warn' | 'urgent'
  /** Epoch ms after which it can no longer be acted on. */
  expiresAt?: number | null
}

/** Default snooze for "Not now". */
export const SNOOZE_MINUTES_DEFAULT = 60
/** Who is pinged until the faction says otherwise (MonChoon, 2026-10-19). */
export const PING_DEFAULT = ['2250591']
export const PING_SETTING = 'oc_watch_ping_member_ids'

/**
 * Which suggestion kinds the feed produces, per faction — `/oc feed` (#1024).
 * Unset means on.
 */
export const FEED_KINDS = ['swap', 'too_low', 'idle'] as const
export type FeedKind = (typeof FEED_KINDS)[number]
export const FEED_KINDS_SETTING = 'oc_feed_kinds'

export async function feedKinds(db: Queryable): Promise<Record<FeedKind, boolean>> {
  const { rows } = await db.query(`SELECT value FROM faction_settings WHERE key = $1`, [FEED_KINDS_SETTING])
  const v = (rows[0]?.value ?? {}) as Record<string, unknown>
  return Object.fromEntries(FEED_KINDS.map((k) => [k, v[k] !== false])) as Record<FeedKind, boolean>
}

export async function setFeedKind(db: Queryable, kind: FeedKind | 'all', enabled: boolean) {
  const cur = await feedKinds(db)
  for (const k of FEED_KINDS) if (kind === 'all' || kind === k) cur[k] = enabled
  await db.query(
    `INSERT INTO faction_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [FEED_KINDS_SETTING, JSON.stringify(cur)])
  return cur
}

type Queryable = Pick<pg.Pool, 'query'>

/**
 * Bring one kind's suggestions in line with what its producer sees now.
 *
 * `live` is everything of `kind` that is currently true. Anything of that kind
 * still open or snoozed but no longer live closes — `resolved` when its key is
 * in `resolvedKeys` (the producer saw the suggested move happen), otherwise
 * `expired`.
 */
export async function reportSuggestions(
  db: Queryable, kind: string, live: SuggestionInput[], resolvedKeys: Set<string> = new Set(),
  closeReason = 'No longer possible',
): Promise<{ opened: number; updated: number; closed: number }> {
  let opened = 0
  let updated = 0
  for (const s of live) {
    const res = await db.query(
      `INSERT INTO oc_suggestions (key, kind, crime_id, member_ids, title, body, steps, value, severity, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10::bigint IS NULL THEN NULL ELSE to_timestamp($10::bigint / 1000.0) END)
       ON CONFLICT (key) DO UPDATE SET
         -- Reopening a closed (resolved/expired) one is a NEW message: the old
         -- one stays as history. A done one is never reopened.
         status = CASE WHEN oc_suggestions.status IN ('resolved', 'expired') THEN 'open' ELSE oc_suggestions.status END,
         message_id = CASE WHEN oc_suggestions.status IN ('resolved', 'expired') THEN NULL ELSE oc_suggestions.message_id END,
         rendered_version = CASE WHEN oc_suggestions.status IN ('resolved', 'expired') THEN 0 ELSE oc_suggestions.rendered_version END,
         closed_at = CASE WHEN oc_suggestions.status IN ('resolved', 'expired') THEN NULL ELSE oc_suggestions.closed_at END,
         close_reason = CASE WHEN oc_suggestions.status IN ('resolved', 'expired') THEN NULL ELSE oc_suggestions.close_reason END,
         opened_at = CASE WHEN oc_suggestions.status IN ('resolved', 'expired') THEN now() ELSE oc_suggestions.opened_at END,
         title = EXCLUDED.title, body = EXCLUDED.body, steps = EXCLUDED.steps, value = EXCLUDED.value,
         severity = EXCLUDED.severity, crime_id = EXCLUDED.crime_id, member_ids = EXCLUDED.member_ids,
         expires_at = EXCLUDED.expires_at,
         version = oc_suggestions.version + CASE
           WHEN oc_suggestions.status IN ('resolved', 'expired') THEN 1
           WHEN oc_suggestions.status = 'done' THEN 0
           WHEN (oc_suggestions.title, oc_suggestions.body, oc_suggestions.steps, oc_suggestions.value, oc_suggestions.severity)
                IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.body, EXCLUDED.steps, EXCLUDED.value, EXCLUDED.severity) THEN 1
           ELSE 0 END,
         updated_at = now()
       WHERE oc_suggestions.status <> 'done'
       RETURNING (xmax = 0) AS inserted, version`,
      [s.key, kind, s.crimeId ?? null, s.memberIds ?? [], s.title, s.body ?? '',
       JSON.stringify(s.steps ?? []), JSON.stringify(s.value ?? {}), s.severity ?? 'info', s.expiresAt ?? null])
    if (res.rows[0]?.inserted) opened++
    else if (res.rows[0]) updated++
  }
  const keys = live.map((s) => s.key)
  const closed = await db.query(
    `UPDATE oc_suggestions
        SET status = CASE WHEN key = ANY($3) THEN 'resolved' ELSE 'expired' END,
            close_reason = CASE WHEN key = ANY($3) THEN 'Seen happening' ELSE $4 END,
            closed_at = now(), version = version + 1, updated_at = now()
      WHERE kind = $1 AND status IN ('open', 'snoozed') AND NOT (key = ANY($2))`,
    [kind, keys, [...resolvedKeys], closeReason])
  return { opened, updated, closed: closed.rowCount ?? 0 }
}

/** Expire the overdue and wake the snoozed. Cheap; run on every read. */
export async function housekeep(db: Queryable): Promise<void> {
  await db.query(
    `UPDATE oc_suggestions
        SET status = 'expired', close_reason = 'Ran out of time', closed_at = now(),
            version = version + 1, updated_at = now()
      WHERE status IN ('open', 'snoozed') AND expires_at IS NOT NULL AND expires_at <= now()`)
  await db.query(
    `UPDATE oc_suggestions
        SET status = 'open', snoozed_until = NULL, version = version + 1, updated_at = now()
      WHERE status = 'snoozed' AND snoozed_until <= now()`)
}

const ms = (col: string) => `(extract(epoch FROM ${col}) * 1000)::bigint`

export function suggestionView(r: any) {
  return {
    id: Number(r.id),
    key: r.key,
    kind: r.kind,
    status: r.status,
    crime_id: r.crime_id ?? null,
    member_ids: r.member_ids ?? [],
    title: r.title,
    body: r.body,
    steps: r.steps ?? [],
    value: r.value ?? {},
    severity: r.severity,
    version: Number(r.version),
    message_id: r.message_id ?? null,
    channel_id: r.channel_id ?? null,
    acted_by: r.acted_by ?? null,
    close_reason: r.close_reason ?? null,
    opened_at: r.opened_ms == null ? null : Number(r.opened_ms),
    expires_at: r.expires_ms == null ? null : Number(r.expires_ms),
    snoozed_until: r.snoozed_ms == null ? null : Number(r.snoozed_ms),
  }
}

const SELECT = `SELECT *, ${ms('opened_at')} AS opened_ms, ${ms('expires_at')} AS expires_ms,
                       ${ms('snoozed_until')} AS snoozed_ms FROM oc_suggestions`

/** Everything the bot has to draw or redraw. */
export async function suggestionsNeedingBot(db: Queryable) {
  await housekeep(db)
  const { rows } = await db.query(`${SELECT} WHERE rendered_version < version ORDER BY opened_at, id LIMIT 50`)
  return rows.map(suggestionView)
}

export async function pingList(db: Queryable): Promise<string[]> {
  const { rows } = await db.query(`SELECT value FROM faction_settings WHERE key = $1`, [PING_SETTING])
  const v = rows[0]?.value
  return Array.isArray(v) ? v.map(String) : PING_DEFAULT
}

/** Counts per kind and status, plus how many were ever posted — for tuning. */
export async function suggestionStats(db: Queryable) {
  const { rows } = await db.query(
    `SELECT kind, status, count(*)::int AS n, count(*) FILTER (WHERE posted_at IS NOT NULL)::int AS posted
       FROM oc_suggestions GROUP BY 1, 2 ORDER BY 1, 2`)
  const out: Record<string, Record<string, number>> = {}
  for (const r of rows) {
    const k = (out[r.kind] ??= { posted: 0 })
    k[r.status] = r.n
    k.posted += r.posted
  }
  return out
}

/**
 * The bot drew `version` of suggestion `id` (into `message_id`) — or, with
 * `deleted`, removed its message because it closed.
 */
export async function markRendered(db: Queryable, id: number, version: number, messageId?: string | null,
  channelId?: string | null, deleted = false) {
  const { rows } = await db.query(
    `UPDATE oc_suggestions
        SET rendered_version = greatest(rendered_version, $2),
            message_id = CASE WHEN $5 THEN NULL ELSE coalesce($3, message_id) END,
            channel_id = coalesce($4, channel_id),
            posted_at = CASE WHEN $3::text IS NOT NULL THEN coalesce(posted_at, now()) ELSE posted_at END
      WHERE id = $1
      RETURNING id`, [id, version, messageId ?? null, channelId ?? null, deleted])
  return rows.length > 0
}

/** Done / Not now from the action feed. Returns the new row, or an error. */
export async function act(db: Queryable, id: number, action: 'done' | 'snooze', by: string, minutes = SNOOZE_MINUTES_DEFAULT) {
  const res = action === 'done'
    ? await db.query(
        `UPDATE oc_suggestions
            SET status = 'done', acted_by = $2, acted_at = now(), closed_at = now(),
                close_reason = 'Marked done', snoozed_until = NULL, version = version + 1, updated_at = now()
          WHERE id = $1 AND status IN ('open', 'snoozed') RETURNING id`, [id, by])
    : await db.query(
        `UPDATE oc_suggestions
            SET status = 'snoozed', acted_by = $2, acted_at = now(),
                snoozed_until = now() + make_interval(mins => $3::int), version = version + 1, updated_at = now()
          WHERE id = $1 AND status = 'open' RETURNING id`, [id, by, minutes])
  if (!res.rows[0]) return { ok: false as const, error: 'That suggestion has already closed or changed.' }
  const { rows } = await db.query(`${SELECT} WHERE id = $1`, [id])
  return { ok: true as const, suggestion: suggestionView(rows[0]) }
}
