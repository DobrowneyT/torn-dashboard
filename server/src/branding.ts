// Branding image uploads (#173). Small logo/favicon/hero images are stored as
// bytea in the tenant DB (rides the existing per-faction backups + isolation —
// no shared volume or object store). Leadership uploads them as base64 JSON
// (no multipart dependency); anyone can read them back over the tenant origin.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireNotVisitor, requireRole } from './authz.js'

const KINDS = ['logo', 'favicon', 'hero']
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif']
const FAVICON_TYPES = ['image/x-icon', 'image/vnd.microsoft.icon', 'image/png']
const MAX_BYTES = 1_048_576 // 1 MB — branding images are small

function allowedTypes(kind: string): string[] {
  return kind === 'favicon' ? FAVICON_TYPES : IMAGE_TYPES
}

// Accept a raw base64 string or a full data: URL — strip the prefix if present.
function decodeBase64(input: string): Buffer {
  let b64 = input
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',')
    if (comma !== -1) b64 = b64.slice(comma + 1)
  }
  return Buffer.from(b64, 'base64')
}

export function registerBrandingRoutes(app: FastifyInstance, deps: { db: pg.Pool }) {
  const { db } = deps
  const WRITE_GUARD = { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] }

  // Upload/replace an asset. Leadership-gated. base64 body → bytea. The raised
  // bodyLimit covers base64's ~33% overhead on a 1 MB image.
  app.put('/api/admin/branding/:kind', { ...WRITE_GUARD, bodyLimit: 3_000_000 }, async (req, reply) => {
    const { kind } = req.params as { kind: string }
    if (!KINDS.includes(kind)) return reply.status(404).send({ error: `unknown asset kind; expected ${KINDS.join(', ')}` })

    const body = (req.body ?? {}) as { content_type?: unknown; data_base64?: unknown }
    if (typeof body.content_type !== 'string' || !allowedTypes(kind).includes(body.content_type)) {
      return reply.status(400).send({ error: `content_type must be one of: ${allowedTypes(kind).join(', ')}` })
    }
    if (typeof body.data_base64 !== 'string' || body.data_base64.trim() === '') {
      return reply.status(400).send({ error: 'data_base64 is required' })
    }
    const bytes = decodeBase64(body.data_base64)
    if (bytes.length === 0) return reply.status(400).send({ error: 'decoded image is empty' })
    if (bytes.length > MAX_BYTES) return reply.status(413).send({ error: `image exceeds ${MAX_BYTES} bytes` })

    await db.query(
      `INSERT INTO faction_branding_assets (kind, content_type, bytes, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (kind) DO UPDATE SET content_type = EXCLUDED.content_type,
         bytes = EXCLUDED.bytes, updated_at = now()`,
      [kind, body.content_type, bytes]
    )
    // Point branding.<kind> at the served path (versioned to bust caches). The
    // kind is validated above, so it's safe as a jsonb path element.
    const url = `/api/branding/${kind}?v=${Date.now()}`
    await db.query(
      `UPDATE faction_config
          SET branding = jsonb_set(COALESCE(branding, '{}'::jsonb), ARRAY[$1], to_jsonb($2::text)),
              updated_at = now()`,
      [kind, url]
    )
    return { url }
  })

  // Serve an asset. PUBLIC — the favicon/logo must load without a session.
  app.get('/api/branding/:kind', async (req, reply) => {
    const { kind } = req.params as { kind: string }
    if (!KINDS.includes(kind)) return reply.status(404).send({ error: 'unknown asset kind' })
    const res = await db.query('SELECT content_type, bytes FROM faction_branding_assets WHERE kind = $1', [kind])
    if (res.rows.length === 0) return reply.status(404).send({ error: 'not found' })
    reply.header('Content-Type', res.rows[0].content_type)
    reply.header('Cache-Control', 'public, max-age=300')
    return reply.send(res.rows[0].bytes)
  })
}
