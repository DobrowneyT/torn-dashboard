// Raw table export as CSV (#517).
//
// Two endpoints: what the caller may export, and the export itself. The export
// streams from a server-side cursor — see STREAMING below for why that is
// non-negotiable and what it costs.
import type { FastifyInstance, FastifyReply } from 'fastify'
import type pg from 'pg'
import { once } from 'node:events'
import { requireAuth } from './authz.js'
import { rolesFromClaims } from './auth.js'
import { canExport, exportableFor, lookupExportTable } from './exportRegistry.js'
import { buildExportQuery, introspectColumns, parseTctBound, rangeBounds } from './exportQuery.js'
import { completionMarker, csvRow } from './exportCsv.js'

/**
 * Rows pulled from the cursor per round trip.
 *
 * ⚠️ STREAMING, and why a plain `db.query()` is not an option here.
 * `faction_attacks` is 444k rows and `member_daily_stats` carries a JSON blob
 * per row. Materialising either as a pg result array would put the whole
 * export in the API's heap — one leader clicking Export would be enough to
 * push the container into an OOM kill, taking the war room down with it. A
 * cursor holds this many rows and no more, whatever the range asks for.
 *
 * 500 is a balance: small enough that memory is flat, large enough that a
 * 444k-row export is ~900 round trips rather than 444,000.
 */
const BATCH = 500

/** Everything after the first byte is unrecoverable — see the marker below. */
async function streamRows(
  db: pg.Pool,
  reply: FastifyReply,
  sql: string,
  params: Array<string | number>,
  columns: string[]
): Promise<{ rows: number; complete: boolean }> {
  const raw = reply.raw
  let rows = 0

  // A caller who closes the tab mid-export must not leave us fetching another
  // 400k rows into a socket nobody is reading.
  let aborted = false
  raw.on('close', () => { aborted = true })

  const write = async (chunk: string) => {
    // Backpressure. Without the drain wait, a fast cursor against a slow
    // client buffers the entire export in the socket's write queue — which is
    // the very heap growth the cursor exists to prevent.
    if (!raw.write(chunk)) await once(raw, 'drain')
  }

  const client = await db.connect()
  let settled = false
  try {
    // READ ONLY is both a guard and a promise: this transaction stays open for
    // the length of a large export, and it must never be able to write.
    await client.query('BEGIN READ ONLY')
    await client.query(`DECLARE tnl_export NO SCROLL CURSOR FOR ${sql}`, params)

    await write(csvRow(columns))

    for (;;) {
      if (aborted) return { rows, complete: false }
      const batch = await client.query(`FETCH ${BATCH} FROM tnl_export`)
      if (batch.rows.length === 0) break
      // Join the batch into ONE write: 500 small writes per round trip is
      // 500 syscalls for no benefit.
      let chunk = ''
      for (const row of batch.rows) {
        chunk += csvRow(columns.map((c) => row[c]))
      }
      rows += batch.rows.length
      await write(chunk)
    }

    await client.query('COMMIT')
    settled = true
    return { rows, complete: true }
  } finally {
    // A connection must never go back to the pool mid-transaction — the next
    // borrower would inherit an open cursor and a READ ONLY snapshot. Guarded
    // rather than unconditional so a clean export does not log Postgres's
    // "there is no transaction in progress" warning on every download.
    if (!settled) await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

export function registerExportRoutes(app: FastifyInstance, db: pg.Pool) {
  // What this caller may export. The picker is built from this rather than
  // from a client-side copy of the registry, so a member never sees the name
  // of a table they cannot have.
  app.get('/api/export/tables', { preHandler: requireAuth() }, async (req) => {
    return { tables: exportableFor(rolesFromClaims(req.session!)) }
  })

  /**
   * A member's OWN stat history (#867).
   *
   * ⚠️ There is no table parameter and no member parameter, and that is the
   * design rather than an omission. `member_daily_stats` is registered as
   * `role: 'leadership'` because it holds every member's data; relaxing that
   * would hand the whole roster to anyone with a session. This is a separate,
   * narrower door whose row filter cannot be influenced from the request at
   * all — a `?member=` that is merely CHECKED is an IDOR waiting to be found,
   * so there is nothing to check.
   *
   * The id comes from the verified session claims and nowhere else.
   */
  app.get('/api/export/me/stats.csv', { preHandler: requireAuth() }, async (req, reply) => {
    const claims = req.session!
    // ⚠️ 403 with a reason, never an empty CSV — an empty file reads as "you
    // have no stats", which is a different and wrong statement. (The `visitor`
    // role had its own branch here for the same reason; #922 removed the role,
    // and the identity check below covers what is left.)
    const memberId = String(claims.torn_user_id ?? '')
    if (!memberId) return reply.status(403).send({ error: 'No member identity on this session' })

    const table = 'member_daily_stats'
    const spec = lookupExportTable(table)
    if (!spec) return reply.status(404).send({ error: 'Unknown export table' })

    const q = (req.query ?? {}) as { from?: string; to?: string }
    const from = parseTctBound(q.from)
    const to = parseTctBound(q.to)
    if (!from || !to) {
      return reply.status(400).send({
        error: 'from and to are required, as TCT YYYY-MM-DD or YYYY-MM-DDTHH:MM',
      })
    }
    if (to.ms < from.ms) return reply.status(400).send({ error: 'to must not precede from' })

    const cols = await introspectColumns(db, table)
    if (cols.length === 0) return reply.status(404).send({ error: 'Unknown export table' })

    const bounds = rangeBounds(spec.timeType, from, to)
    const { sql, params, columns } = buildExportQuery(table, spec, cols, bounds, {
      column: 'member_id',
      memberId,
    })

    const filename = `my_stats_${q.from}_${q.to}.csv`.replace(/[^\w.\-]/g, '_')
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    try {
      const { rows, complete } = await streamRows(db, reply, sql, params, columns)
      // Same completion marker as the leadership export — a truncated stream
      // still carries a 200, so this trailer is the only way to tell them apart.
      if (complete) reply.raw.write(completionMarker(rows))
    } catch (err) {
      req.log.error({ err, memberId, from: q.from, to: q.to }, 'self export stream failed')
    } finally {
      reply.raw.end()
    }
  })

  app.get('/api/export/:table/csv', { preHandler: requireAuth() }, async (req, reply) => {
    const { table } = req.params as { table: string }
    const spec = lookupExportTable(table)
    // ⚠️ 404, not 403. A table absent from the registry is not a table this
    // API has, whoever is asking — and a 403 would confirm the name exists.
    if (!spec) return reply.status(404).send({ error: 'Unknown export table' })

    if (!canExport(spec.role, rolesFromClaims(req.session!))) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const q = (req.query ?? {}) as { from?: string; to?: string }
    const from = parseTctBound(q.from)
    const to = parseTctBound(q.to)
    if (!from || !to) {
      return reply.status(400).send({
        error: 'from and to are required, as TCT YYYY-MM-DD or YYYY-MM-DDTHH:MM',
      })
    }
    if (to.ms < from.ms) return reply.status(400).send({ error: 'to must not precede from' })

    const cols = await introspectColumns(db, table)
    if (cols.length === 0) return reply.status(404).send({ error: 'Unknown export table' })

    const bounds = rangeBounds(spec.timeType, from, to)
    const { sql, params, columns } = buildExportQuery(table, spec, cols, bounds)

    const filename = `${table}_${q.from}_${q.to}.csv`.replace(/[^\w.\-]/g, '_')
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // The length is unknowable before the last row, and a proxy that buffers
      // to compute one would undo the streaming.
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })

    try {
      const { rows, complete } = await streamRows(db, reply, sql, params, columns)
      // ⚠️ THE COMPLETION MARKER. The status line went out with the headers, so
      // a failure from here on cannot be reported as one — the client already
      // has its 200 and will happily save a file that opens perfectly and is
      // missing most of its rows. This trailer is the only difference between a
      // finished export and a truncated one; the UI verifies it and strips it
      // before saving.
      if (complete) reply.raw.write(completionMarker(rows))
    } catch (err) {
      // Nothing to send but the truncation itself. Log enough to reproduce it.
      req.log.error({ err, table, from: q.from, to: q.to }, 'export stream failed')
    } finally {
      reply.raw.end()
    }
  })
}
