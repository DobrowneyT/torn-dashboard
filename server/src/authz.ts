// Role guards. buildServer attaches the verified session (or null) to every
// request; guards only inspect req.session, so routes compose them freely.
import type { preHandlerHookHandler } from 'fastify'
import { rolesFromClaims, type Role, type SessionClaims } from './auth.js'

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionClaims | null
  }
}

/** Any valid session — plain members included. Visitors may read. */
export function requireAuth(): preHandlerHookHandler {
  return async (req, reply) => {
    if (!req.session) return reply.status(401).send({ error: 'Authentication required' })
  }
}

export function requireRole(...allowed: Role[]): preHandlerHookHandler {
  return async (req, reply) => {
    if (!req.session) return reply.status(401).send({ error: 'Authentication required' })
    const roles = rolesFromClaims(req.session)
    if (!allowed.some((r) => roles.includes(r))) {
      return reply.status(403).send({ error: 'Forbidden' })
    }
  }
}

/** Write-path guard: visitors are read-only everywhere it's applied. */
export function requireNotVisitor(): preHandlerHookHandler {
  return async (req, reply) => {
    if (!req.session) return reply.status(401).send({ error: 'Authentication required' })
    if (req.session.is_visitor) {
      return reply.status(403).send({ error: 'Visitor mode is read-only' })
    }
  }
}
