// Per-member war notes (#199). One global note per member — war intel that
// persists across wars. Any signed-in member can read all notes; war leads,
// leadership, and admin can write. An empty note clears the row.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireNotVisitor, requireRole } from './authz.js'

const NOTE_MAX = 2000

export function registerMemberNotesRoutes(app: FastifyInstance, db: pg.Pool) {
  // All notes, keyed by member_id — the roster fetches once and looks up per row.
  app.get('/api/member-notes', { preHandler: requireAuth() }, async () => {
    const res = await db.query(
      'SELECT member_id, note, updated_by, updated_at FROM member_notes WHERE note <> \'\''
    )
    return { notes: res.rows }
  })

  app.get('/api/member-notes/:memberId', { preHandler: requireAuth() }, async (req) => {
    const { memberId } = req.params as { memberId: string }
    const res = await db.query(
      'SELECT member_id, note, updated_by, updated_at FROM member_notes WHERE member_id = $1',
      [memberId]
    )
    return { note: res.rows[0] ?? null }
  })

  app.put(
    '/api/member-notes/:memberId',
    { preHandler: [requireNotVisitor(), requireRole('warlead', 'leadership', 'admin')] },
    async (req, reply) => {
      const { memberId } = req.params as { memberId: string }
      if (!/^\d+$/.test(memberId)) return reply.status(400).send({ error: 'invalid member id' })
      const raw = (req.body as { note?: unknown })?.note
      const note = typeof raw === 'string' ? raw.trim() : ''
      if (note.length > NOTE_MAX) {
        return reply.status(400).send({ error: `note too long (max ${NOTE_MAX} chars)` })
      }
      const updatedBy = String(req.session!.torn_user_id)

      // An empty note clears the row so the roster icon disappears.
      if (note === '') {
        await db.query('DELETE FROM member_notes WHERE member_id = $1', [memberId])
        return { member_id: memberId, note: '' }
      }
      const res = await db.query(
        `INSERT INTO member_notes (member_id, note, updated_by, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (member_id) DO UPDATE SET
           note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING member_id, note, updated_by, updated_at`,
        [memberId, note, updatedBy]
      )
      return res.rows[0]
    }
  )
}
