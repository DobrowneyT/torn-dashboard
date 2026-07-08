import Fastify, { type FastifyInstance } from 'fastify'

export interface ServerOptions {
  factionSlug: string
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.get('/api/health', async () => ({ status: 'ok', faction: opts.factionSlug }))

  return app
}
