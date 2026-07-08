import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type pg from 'pg'
import {
  factionIdentity,
  loginWithTornKey,
  rolesFromClaims,
  verifySessionToken,
  type AuthDeps,
  type SessionClaims,
} from './auth.js'

export interface ServerOptions {
  factionSlug: string
  db?: pg.Pool
  tornBaseUrl?: string
  jwtSecret?: string
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.get('/api/health', async () => ({ status: 'ok', faction: opts.factionSlug }))

  if (opts.db && opts.tornBaseUrl && opts.jwtSecret) {
    const deps: AuthDeps = { db: opts.db, tornBaseUrl: opts.tornBaseUrl, jwtSecret: opts.jwtSecret }

    app.post('/api/auth/login', async (req, reply) => {
      const apiKey = (req.body as { apiKey?: unknown } | null)?.apiKey
      if (typeof apiKey !== 'string' || apiKey.trim() === '') {
        return reply.status(400).send({ error: 'apiKey is required' })
      }
      const result = await loginWithTornKey(deps, apiKey.trim())
      if (!result.ok) return reply.status(result.status).send({ error: result.error })
      return { token: result.token, expires_at: result.expiresAt }
    })

    app.get('/api/bootstrap', async (req) => {
      const config = await factionIdentity(deps.db)
      const publicView = {
        faction: {
          slug: config.slug,
          display_name: config.display_name,
          branding: config.branding,
        },
        features: config.features,
      }
      const claims = await sessionFromRequest(deps.jwtSecret, req)
      if (!claims) return publicView
      return {
        ...publicView,
        user: { torn_user_id: claims.torn_user_id, roles: rolesFromClaims(claims) },
      }
    })
  }

  return app
}

async function sessionFromRequest(jwtSecret: string, req: FastifyRequest): Promise<SessionClaims | null> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return verifySessionToken(jwtSecret, header.slice('Bearer '.length))
}
