/**
 * Persisting incident state to `global` (#609 slice 4).
 *
 * The only IO in the alerting path. `alertRules.ts` decides what is wrong and
 * `incidents.ts` decides what is news; this file does nothing but read and
 * write rows, which is what keeps both of those testable without a database.
 *
 * ⚠️ The admin container is the ONLY writer in the fleet, so there is no
 * concurrent-writer problem to solve here — but the whole reconciliation is
 * still written in one transaction. A crash between "delete the cleared
 * incidents" and "record that they cleared" would lose the resolution event
 * while forgetting the incident, and the operator would be left with an
 * "opened" message and no matching "resolved" — the failure mode that teaches
 * people the channel is unreliable.
 */
import type pg from 'pg'
import type { Severity } from './alertRules.js'
import type { Incident, Reconciliation } from './incidents.js'

export interface AlertEvent {
  key: string
  kind: 'opened' | 'resolved'
  severity: Severity
  title: string
  detail: string
  at: string
}

export interface IncidentStore {
  load(): Promise<Incident[]>
  save(r: Reconciliation, nowIso: string): Promise<void>
  recentEvents(sinceIso: string): Promise<AlertEvent[]>
  getState<T>(key: string): Promise<T | null>
  setState(key: string, value: unknown): Promise<void>
}

/** Events older than this are pruned. Long enough for a monthly look back. */
export const EVENT_RETENTION_DAYS = 90

/**
 * ⚠️ **Timestamps are formatted by Postgres, not by the driver.**
 *
 * `src/db.ts` installs a PROCESS-WIDE `setTypeParser` for timestamptz so the
 * tenant API can serve PostgREST-shaped strings — which means a column here
 * comes back as a `Date` or as `2026-09-05T07:01:00-05` depending on nothing
 * more principled than whether something in the import graph happened to pull
 * that module in. The second shape is not ISO-8601 (`-05`, no minutes) and
 * `Date.parse` rejects it outright, so a plain `String(value)` leaks an
 * unparseable local-offset string into the digest and the status page.
 *
 * Formatting in SQL removes the question. These columns are read back as UTC
 * ISO text no matter which parser is installed.
 */
const ISO_UTC = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${col}`

const INCIDENT_COLUMNS = [
  'key', 'severity', 'title', 'detail', 'observations', 'misses',
  ISO_UTC('first_seen_at'), ISO_UTC('last_seen_at'), ISO_UTC('opened_at'),
].join(', ')

function toIncident(row: Record<string, unknown>): Incident {
  return {
    key: String(row.key),
    severity: row.severity as Severity,
    title: String(row.title),
    detail: String(row.detail ?? ''),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    observations: Number(row.observations),
    misses: Number(row.misses),
    // ⚠️ `?? null`, never a falsy coalesce. NULL here means "never announced",
    // and the difference decides whether a resolution message is sent at all.
    openedAt: row.opened_at ? String(row.opened_at) : null,
  }
}

export function pgIncidentStore(db: pg.Pool): IncidentStore {
  return {
    async load() {
      const res = await db.query(`SELECT ${INCIDENT_COLUMNS} FROM alert_incidents`)
      return res.rows.map(toIncident)
    },

    async save(r, nowIso) {
      const client = await db.connect()
      try {
        await client.query('BEGIN')

        const keys = r.incidents.map((i) => i.key)
        // Rows absent from the next state have cleared. `= ANY($1)` with an
        // empty array is valid and deletes everything, which is correct: no
        // incidents means nothing is open.
        await client.query('DELETE FROM alert_incidents WHERE NOT (key = ANY($1::text[]))', [keys])

        for (const i of r.incidents) {
          await client.query(
            `INSERT INTO alert_incidents
               (key, severity, title, detail, first_seen_at, last_seen_at, observations, misses, opened_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (key) DO UPDATE SET
               severity = EXCLUDED.severity,
               title = EXCLUDED.title,
               detail = EXCLUDED.detail,
               last_seen_at = EXCLUDED.last_seen_at,
               observations = EXCLUDED.observations,
               misses = EXCLUDED.misses,
               opened_at = EXCLUDED.opened_at`,
            [
              i.key, i.severity, i.title, i.detail,
              i.firstSeenAt, i.lastSeenAt, i.observations, i.misses, i.openedAt,
            ]
          )
        }

        for (const [kind, list] of [['opened', r.opened], ['resolved', r.resolved]] as const) {
          for (const i of list) {
            await client.query(
              `INSERT INTO alert_events (key, kind, severity, title, detail, at)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [i.key, kind, i.severity, i.title, i.detail, nowIso]
            )
          }
        }

        await client.query(
          `DELETE FROM alert_events WHERE at < now() - ($1 || ' days')::interval`,
          [String(EVENT_RETENTION_DAYS)]
        )

        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    },

    async recentEvents(sinceIso) {
      const res = await db.query(
        `SELECT key, kind, severity, title, detail, ${ISO_UTC('at')}
           FROM alert_events WHERE at >= $1 ORDER BY at DESC`,
        [sinceIso]
      )
      return res.rows.map((row: Record<string, unknown>) => ({
        key: String(row.key),
        kind: row.kind as 'opened' | 'resolved',
        severity: row.severity as Severity,
        title: String(row.title),
        detail: String(row.detail ?? ''),
        at: String(row.at),
      }))
    },

    async getState<T>(key: string) {
      const res = await db.query('SELECT value FROM control_state WHERE key = $1', [key])
      return res.rows.length ? (res.rows[0].value as T) : null
    },

    async setState(key, value) {
      await db.query(
        `INSERT INTO control_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)]
      )
    },
  }
}
