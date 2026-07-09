// Test harness for the two agreed seams:
//   1. Black-box HTTP against the per-faction API, backed by a REAL faction
//      database created from db/template.sql on an embedded Postgres.
//   2. A fake Torn fixture server injected via the Torn client's base URL —
//      the only fake in the suite.
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
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

// Mirrors the real /v2/key/info payload: user carries id/faction_id/company_id
// only — no name.
export interface TornFixtureUser {
  id: string
  factionId: string | null
  /** Torn key access level; defaults to 3 (Limited Access). */
  accessLevel?: number
}

/** The Torn key the harness configures the server itself with. */
export const TEST_SERVER_TORN_KEY = 'SERVERKEY1234567'

export interface TestStack {
  baseUrl: string
  /** Base URL of the Torn fixture server (for components that take it directly). */
  tornBaseUrl: string
  db: pg.Pool
  torn: {
    /** Register a Torn API key the fixture will answer for. */
    addKey(key: string, user: TornFixtureUser): void
    /** Register a key the fixture answers with a Torn error payload. */
    addBadKey(key: string, code: number, message: string): void
    /** Payload the fixture serves for /v2/faction/crimes. */
    setFactionCrimes(payload: unknown): void
    /** The key used on the most recent /v2/faction/crimes call. */
    lastFactionCrimesKey(): string | null
    /** Serve an arbitrary payload for an exact pathname (checked before 404). */
    setPath(pathname: string, payload: unknown): void
    /** Serve a computed payload for an exact pathname (gets the request URL). */
    setHandler(pathname: string, handler: (url: URL) => unknown): void
    hits(): number
  }
  close(): Promise<void>
}

/** Ask the OS for a currently free port (embedded-postgres needs an explicit one). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') return reject(new Error('no port'))
      srv.close(() => resolve(addr.port))
    })
  })
}

/** Boot embedded Postgres + templated faction DB + Torn fixture + API. */
export async function startTestStack(
  extendApp?: (app: FastifyInstance) => void
): Promise<TestStack> {
  // Real templated Postgres
  const pgPort = await freePort()
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
  // Teardown race: embedded Postgres can terminate idle pooled connections
  // (57P01) while the pool is still draining, and an unhandled pool 'error'
  // fails the whole vitest run despite every test passing.
  db.on('error', () => {})
  await db.query(TEMPLATE)
  await db.query(
    `INSERT INTO faction_config (slug, display_name, torn_faction_id) VALUES ($1, $2, $3)`,
    [TEST_FACTION.slug, TEST_FACTION.displayName, TEST_FACTION.tornFactionId]
  )

  // Torn fixture server
  const goodKeys = new Map<string, TornFixtureUser>()
  const badKeys = new Map<string, { code: number; message: string }>()
  let factionCrimesPayload: unknown = null
  let factionCrimesKey: string | null = null
  const pathPayloads = new Map<string, unknown>()
  const pathHandlers = new Map<string, (url: URL) => unknown>()
  let hitCount = 0
  const torn: Server = createServer((req, res) => {
    hitCount += 1
    const url = new URL(req.url ?? '/', 'http://fixture')
    res.setHeader('content-type', 'application/json')
    // Custom handlers win over the built-in routes so tests can override
    // the crimes endpoint with parameterized (pagination) behavior.
    const handler = pathHandlers.get(url.pathname)
    if (handler) {
      res.end(JSON.stringify(handler(url)))
      return
    }
    if (url.pathname === '/v2/faction/crimes') {
      factionCrimesKey = url.searchParams.get('key')
      if (factionCrimesPayload === null) {
        res.end(JSON.stringify({ error: { code: 2, error: 'Incorrect key' } }))
        return
      }
      res.end(JSON.stringify(factionCrimesPayload))
      return
    }
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
          user: { id: Number(user.id), faction_id: user.factionId === null ? null : Number(user.factionId), company_id: 0 },
          access: { level: user.accessLevel ?? 3, type: 'Limited Access', faction: true },
        },
      }))
      return
    }
    if (pathPayloads.has(url.pathname)) {
      res.end(JSON.stringify(pathPayloads.get(url.pathname)))
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
    tornApiKey: TEST_SERVER_TORN_KEY,
  })
  extendApp?.(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('api port')

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    tornBaseUrl,
    db,
    torn: {
      addKey: (key, user) => goodKeys.set(key, user),
      addBadKey: (key, code, message) => badKeys.set(key, { code, message }),
      setFactionCrimes: (payload) => { factionCrimesPayload = payload },
      lastFactionCrimesKey: () => factionCrimesKey,
      setPath: (pathname, payload) => pathPayloads.set(pathname, payload),
      setHandler: (pathname, handler) => pathHandlers.set(pathname, handler),
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
