// Test harness for the two agreed seams:
//   1. Black-box HTTP against the per-faction API, backed by a REAL faction
//      database created from db/template.sql on an embedded Postgres.
//   2. A fake Torn fixture server injected via the Torn client's base URL —
//      the only fake in the suite.
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { buildServer } from '../src/app.js'

const here = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(join(here, '..', '..', 'db', 'template.sql'), 'utf8')

export const TEST_FACTION = {
  slug: 'forge',
  displayName: 'TNL Forge Dashboard',
  tornFactionId: '53100',
}
export const TEST_JWT_SECRET = 'test-jwt-secret'

export interface TornFixtureUser {
  id: string
  name?: string
  factionId: string | null
}

export interface TestStack {
  baseUrl: string
  db: pg.Pool
  torn: {
    /** Register a Torn API key the fixture will answer for. */
    addKey(key: string, user: TornFixtureUser): void
    /** Register a key the fixture answers with a Torn error payload. */
    addBadKey(key: string, code: number, message: string): void
    hits(): number
  }
  close(): Promise<void>
}

/** Boot embedded Postgres + templated faction DB + Torn fixture + API. */
export async function startTestStack(
  pgPort: number,
  extendApp?: (app: FastifyInstance) => void
): Promise<TestStack> {
  // Real templated Postgres
  const dataDir = mkdtempSync(join(tmpdir(), 'tnl-server-test-'))
  const embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: pgPort,
    persistent: false,
  })
  await embedded.initialise()
  await embedded.start()
  await embedded.createDatabase('faction_test')

  const db = new pg.Pool({
    host: '127.0.0.1',
    port: pgPort,
    user: 'postgres',
    password: 'postgres',
    database: 'faction_test',
  })
  await db.query(TEMPLATE)
  await db.query(
    `INSERT INTO faction_config (slug, display_name, torn_faction_id) VALUES ($1, $2, $3)`,
    [TEST_FACTION.slug, TEST_FACTION.displayName, TEST_FACTION.tornFactionId]
  )

  // Torn fixture server
  const goodKeys = new Map<string, TornFixtureUser>()
  const badKeys = new Map<string, { code: number; message: string }>()
  let hitCount = 0
  const torn: Server = createServer((req, res) => {
    hitCount += 1
    const url = new URL(req.url ?? '/', 'http://fixture')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/v2/key/info') {
      const key = url.searchParams.get('key') ?? ''
      const bad = badKeys.get(key)
      if (bad) {
        res.end(JSON.stringify({ error: { code: bad.code, error: bad.message } }))
        return
      }
      const user = goodKeys.get(key)
      if (!user) {
        res.end(JSON.stringify({ error: { code: 2, error: 'Incorrect key' } }))
        return
      }
      res.end(JSON.stringify({
        info: {
          user: { id: Number(user.id), name: user.name ?? `User${user.id}`, faction_id: user.factionId === null ? null : Number(user.factionId) },
          access: { level: 3, type: 'Limited Access' },
        },
      }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: { code: 0, error: `fixture: unhandled path ${url.pathname}` } }))
  })
  await new Promise<void>((resolve) => torn.listen(0, '127.0.0.1', resolve))
  const tornAddr = torn.address()
  if (tornAddr === null || typeof tornAddr === 'string') throw new Error('fixture port')
  const tornBaseUrl = `http://127.0.0.1:${tornAddr.port}`

  // The API under test, over real HTTP
  const app = await buildServer({
    factionSlug: TEST_FACTION.slug,
    db,
    tornBaseUrl,
    jwtSecret: TEST_JWT_SECRET,
  })
  extendApp?.(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('api port')

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    db,
    torn: {
      addKey: (key, user) => goodKeys.set(key, user),
      addBadKey: (key, code, message) => badKeys.set(key, { code, message }),
      hits: () => hitCount,
    },
    close: async () => {
      await app.close()
      await new Promise<void>((resolve, reject) => torn.close((e) => (e ? reject(e) : resolve())))
      await db.end()
      await embedded.stop()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
