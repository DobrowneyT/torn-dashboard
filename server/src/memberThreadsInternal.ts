// The mailbox Choonbot drains (#942).
//
// ⚠️ **The bot polls these; the dashboard never calls the bot.** Chain Watch
// already works this way across five factions and the bot has no inbound HTTP
// server — it is a Discord gateway client. Pushing would mean a web server, an
// exposed port, a new auth scope, and dashboard-side handling of the bot being
// down. MonChoon: *"basically a mailbox from the dashboard that there are
// updates waiting to be posted."*
//
// ⚠️ **Its own token scope**, like the War Overview's: the same bot holds
// several, and keeping them apart is what stops a leak of one surrendering the
// others (#609).
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { bearerFrom, tokenMatches } from './fleetMetricsAuth.js'
import { collectMemberWarReport } from './memberWarReport.js'

/** A drain takes at most this many at once, so one poll cannot run for ever. */
export const DRAIN_BATCH = 50

/**
 * How long a claimed-but-unfinished row waits before another drain may take it.
 *
 * ⚠️ A crashed drain leaves rows claimed and never posted. Without a timeout
 * they are stranded for good, and the member silently never gets their note —
 * the quietest possible failure for a feature whose whole job is a record.
 * Generous enough that a slow-but-alive drain is never overtaken.
 */
export const CLAIM_STALE_MS = 10 * 60 * 1000

export function registerMemberThreadRoutes(
  app: FastifyInstance, db: pg.Pool, expectedToken: string,
): void {
  const authed = (req: any, reply: any): boolean => {
    const presented = bearerFrom(req.headers.authorization)
    // ⚠️ One message for a missing token and a wrong one, matching the other
    // internal routes: distinguishing them tells a prober which half they have.
    if (presented === null || !tokenMatches(presented, expectedToken)) {
      reply.status(401).send({ error: 'Authentication required' })
      return false
    }
    return true
  }

  /**
   * What is waiting, and where each member's thread is.
   *
   * ⚠️ Claims the rows it returns, so two drains cannot post the same note
   * twice. The claim is a timestamp rather than a flag — see CLAIM_STALE_MS.
   */
  app.post('/api/internal/member-threads/claim', async (req, reply) => {
    if (!authed(req, reply)) return
    const res = await db.query(
      `UPDATE member_thread_outbox o
          SET claimed_at = now(), attempts = o.attempts + 1
        WHERE o.id IN (
          SELECT id FROM member_thread_outbox
           WHERE posted_at IS NULL
             AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $1))
           ORDER BY queued_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
      RETURNING o.id, o.member_id, o.kind, o.subject, o.payload, o.attempts,
                -- ⚠️ **The message we posted LAST time, if there was one.** Its
                -- presence is what turns a re-queued entry into an EDIT rather
                -- than a second embed in the same thread. A re-run of a war is
                -- a correction; two posts for one war is the bug.
                o.message_id,
                (extract(epoch from o.queued_at) * 1000)::bigint AS queued_ms`,
      [CLAIM_STALE_MS / 1000, DRAIN_BATCH],
    )
    // The registry, so the bot knows which thread each note belongs in — and
    // which members have none yet and need one created.
    const threads = await db.query(
      `SELECT member_id, thread_id, channel_id FROM member_threads`,
    )
    const byMember: Record<string, unknown> = {}
    for (const t of threads.rows) {
      byMember[String(t.member_id)] = { thread_id: t.thread_id, channel_id: t.channel_id }
    }
    // ⚠️ **The forum channel is NOT returned, and is not stored here.** It is
    // the bot's setting, editable from Discord per tenant like Chain Watch's
    // board and ping channels. `chain_settings` draws that line explicitly:
    // what the bot owns is *how it talks* — "which channel things land in" —
    // while the dashboard owns facts about the faction. Keeping a copy here as
    // well would make two places authoritative for one id, and the one that
    // drifts is always the one nobody is looking at.
    return { threads: byMember, pending: res.rows }
  })

  /**
   * One note posted. Records the thread (creating the registry row on a first
   * post) and the message id.
   *
   * ⚠️ **The thread id comes back from the bot**, because only the bot can
   * create a Discord thread. This is the write that makes the registry true,
   * and it must happen before the row is marked posted — a crash between them
   * would leave a thread nobody has recorded and a note that gets sent again.
   */
  app.post('/api/internal/member-threads/posted', async (req, reply) => {
    if (!authed(req, reply)) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const id = Number(b.id)
    const threadId = b.thread_id == null ? null : String(b.thread_id)
    const channelId = b.channel_id == null ? null : String(b.channel_id)
    const messageId = b.message_id == null ? null : String(b.message_id)
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'id required' })
    }
    const row = await db.query(
      `SELECT member_id FROM member_thread_outbox WHERE id = $1`, [id],
    )
    if (row.rows.length === 0) return reply.status(404).send({ error: 'Unknown outbox row' })
    const memberId = String(row.rows[0].member_id)

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      if (threadId && channelId) {
        await client.query(
          `INSERT INTO member_threads (member_id, thread_id, channel_id, last_posted_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (member_id) DO UPDATE
             SET thread_id = EXCLUDED.thread_id,
                 channel_id = EXCLUDED.channel_id,
                 last_posted_at = now()`,
          [memberId, threadId, channelId],
        )
      }
      await client.query(
        `UPDATE member_thread_outbox
            SET posted_at = now(), message_id = $2, last_error = NULL
          WHERE id = $1`,
        [id, messageId],
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return { ok: true }
  })

  /**
   * One note failed.
   *
   * ⚠️ The row is RELEASED rather than retried immediately, and the reason is
   * kept. #944 needs a deleted or renamed thread to fail loudly and visibly;
   * a queue that silently retries for ever hides exactly that.
   */
  app.post('/api/internal/member-threads/failed', async (req, reply) => {
    if (!authed(req, reply)) return
    const b = (req.body ?? {}) as Record<string, unknown>
    const id = Number(b.id)
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'id required' })
    }
    const res = await db.query(
      `UPDATE member_thread_outbox
          SET claimed_at = NULL, last_error = $2
        WHERE id = $1 AND posted_at IS NULL`,
      [id, String(b.error ?? 'unknown').slice(0, 500)],
    )
    if (res.rowCount === 0) return reply.status(404).send({ error: 'Unknown or already posted' })
    return { ok: true }
  })

  /**
   * Everything one member's post-war report needs, for one (war, member) (#943).
   *
   * ⚠️ **A GET, and it claims nothing.** The bot calls this per member while
   * rendering, and a drain that had to claim a row to read the facts could not
   * retry a failed render without the ten-minute wait. The mailbox entry is
   * what gets claimed; this is just the data.
   *
   * ⚠️ **400 on a live or unknown war, never a partial report.** A scoreless
   * report posted into a permanent record cannot be unposted, and MonChoon was
   * explicit: *"I don't want it to post scoreless reports because the wrap up
   * never completed, it should just fail loudly."*
   */
  app.get('/api/internal/member-threads/report', async (req, reply) => {
    if (!authed(req, reply)) return
    const q = (req.query ?? {}) as Record<string, string | undefined>
    if (!q.war || !q.member) {
      return reply.status(400).send({ error: 'war and member are required' })
    }
    const out = await collectMemberWarReport(db, q.war, q.member)
    if ('error' in out) return reply.status(400).send(out)
    return out
  })
}
