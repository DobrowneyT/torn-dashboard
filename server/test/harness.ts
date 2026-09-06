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
// A real new-faction DB gets the policy-defaults seed (db/new-faction runbook);
// the admin/OC policy endpoints serve those defaults until a leader edits them.
const SETTINGS_SEED = readFileSync(
  join(here, '..', '..', 'db', 'seed', '03_faction_settings_defaults.sql'),
  'utf8'
)

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
  /** Whether the key has faction API access (access.faction); defaults to true. */
  factionAccess?: boolean
}

/** Key-pool at-rest secret used by the app under test (sync triggers). */
export const TEST_KEY_ENCRYPTION_KEY = 'e'.repeat(64)

/** A GitHub issue the feedback endpoint created against the fixture (#253). */
export interface GithubIssueCapture {
  repo: string
  title: string
  body: string
  labels: string[]
  auth: string | null
}

export interface TestStack {
  baseUrl: string
  /** Base URL of the Torn fixture server (for components that take it directly). */
  tornBaseUrl: string
  db: pg.Pool
  /** War-room WebSocket hub of the app under test (broadcast seam for the ticker). */
  warRoomHub?: import('../src/warRoom.js').WarRoomHub
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
    /** The `comment` param of every request so far (null where absent). */
    comments(): Array<string | null>
  }
  /** GitHub fixture the feedback endpoint (#253) talks to. */
  github: {
    /** Base URL of the GitHub fixture (for the #255 prune job seam). */
    baseUrl: string
    /** Every issue the feedback endpoint has created, in order. */
    issuesCreated(): GithubIssueCapture[]
    /** Set an issue's state (for the #255 prune tests). 'error' → the fixture 500s. */
    setIssueState(number: number, state: 'open' | 'closed' | 'error'): void
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

/** Options for the feedback (#253) GitHub integration in the test stack. */
export interface FeedbackTestOptions {
  /** When false, no PAT is configured — the endpoint is disabled. Default true. */
  enabled?: boolean
}

export interface StackOverrides {
  /**
   * Rate limiting (#485). ⚠️ OFF by default for every stack: a few hundred
   * tests share one loopback address, so a default-on limit would make
   * unrelated suites fail in ways that look like the feature under test.
   * rate-limit.test.ts opts in with tiny numbers of its own.
   */
  rateLimit?: import('../src/app.js').RateLimitOptions | false
  /**
   * War-room socket keepalive period, ms. Production is 30s, which no test can
   * wait for — war-room.test.ts sets a few tens of ms to watch a real ping.
   */
  warRoomHeartbeatMs?: number
  /**
   * OC scenario model (#606). Absent means the real committed dataset.
   *
   * ⚠️ Tests that assert on scenario structure should inject a fixture via
   * `ocModelFixture()`. Asserting against the committed dataset would couple
   * the suite to its exact contents, so a routine model refresh — Torn adds
   * crimes — would break tests unrelated to the change.
   */
  ocModel?: Map<string, import('../src/oc/modelLoader.js').OcScenarioModel>
}

/** Boot embedded Postgres + templated faction DB + Torn fixture + GitHub fixture + API. */
export async function startTestStack(
  extendApp?: (app: FastifyInstance) => void,
  feedbackOpts: FeedbackTestOptions = {},
  overrides: StackOverrides = {}
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
  await db.query(SETTINGS_SEED)
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
  // Every request's `comment` param (null when absent) — Torn surfaces this in
  // each member's API-usage log, so key donors can see what used their key.
  const seenComments: Array<string | null> = []
  const torn: Server = createServer((req, res) => {
    hitCount += 1
    const url = new URL(req.url ?? '/', 'http://fixture')
    seenComments.push(url.searchParams.get('comment'))
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
          access: { level: user.accessLevel ?? 3, type: 'Limited Access', faction: user.factionAccess ?? true },
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

  // GitHub fixture (#253): captures created issues and serves issue state. The
  // second fake in the suite — feedback POSTs a real HTTP request to it.
  let issueCounter = 1000
  const createdIssues: GithubIssueCapture[] = []
  const issueStates = new Map<number, 'open' | 'closed' | 'error'>()
  const github: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://gh')
    res.setHeader('content-type', 'application/json')
    const auth = req.headers.authorization ?? null
    if (req.method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(url.pathname)) {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        let body: any = {}
        try { body = JSON.parse(raw || '{}') } catch { /* leave empty */ }
        const number = issueCounter++
        const repo = url.pathname.split('/').slice(2, 4).join('/')
        createdIssues.push({ repo, title: body.title, body: body.body, labels: body.labels ?? [], auth })
        issueStates.set(number, 'open')
        res.statusCode = 201
        res.end(JSON.stringify({ number, html_url: `https://github.com/${repo}/issues/${number}`, state: 'open' }))
      })
      return
    }
    const stateMatch = req.method === 'GET' && url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/)
    if (stateMatch) {
      const number = Number(stateMatch[1])
      const state = issueStates.get(number) ?? 'open'
      // 'error' simulates a GitHub API failure for the #255 prune resilience test.
      if (state === 'error') {
        res.statusCode = 500
        res.end(JSON.stringify({ message: 'server error' }))
        return
      }
      res.end(JSON.stringify({ number, state }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ message: 'not found' }))
  })
  await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve))
  const ghAddr = github.address()
  if (ghAddr === null || typeof ghAddr === 'string') throw new Error('github fixture port')
  const githubBaseUrl = `http://127.0.0.1:${ghAddr.port}`
  const feedbackEnabled = feedbackOpts.enabled !== false

  // The API under test, over real HTTP
  const app = await buildServer({
    // #606: tests drive a fixture model unless one is supplied, so the suite is
    // never coupled to the dataset committed in the image.
    ocModel: overrides.ocModel,
    factionSlug: TEST_FACTION.slug,
    db,
    tornBaseUrl,
    jwtSecret: TEST_JWT_SECRET,
    keyEncryptionKey: TEST_KEY_ENCRYPTION_KEY,
    // Spy providers point at the fixture; keys are arbitrary fixture tokens.
    tornStatsApiKey: 'TSKEY123',
    bspApiKey: 'BSPKEY99',
    tornStatsBaseUrl: tornBaseUrl,
    bspBaseUrl: tornBaseUrl,
    // Feedback → GitHub fixture (#253). Disabled when the test opts out.
    feedbackGithubToken: feedbackEnabled ? 'gh-test-token' : undefined,
    feedbackGithubRepo: 'test-owner/test-repo',
    feedbackGithubBaseUrl: githubBaseUrl,
    feedbackLabel: 'needs-triage',
    rateLimit: overrides.rateLimit ?? false,
    warRoomHeartbeatMs: overrides.warRoomHeartbeatMs,
  })
  extendApp?.(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  if (addr === null || typeof addr === 'string') throw new Error('api port')

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    tornBaseUrl,
    db,
    warRoomHub: app.warRoomHub,
    torn: {
      addKey: (key, user) => goodKeys.set(key, user),
      addBadKey: (key, code, message) => badKeys.set(key, { code, message }),
      setFactionCrimes: (payload) => { factionCrimesPayload = payload },
      lastFactionCrimesKey: () => factionCrimesKey,
      setPath: (pathname, payload) => pathPayloads.set(pathname, payload),
      setHandler: (pathname, handler) => pathHandlers.set(pathname, handler),
      hits: () => hitCount,
      comments: () => [...seenComments],
    },
    github: {
      baseUrl: githubBaseUrl,
      issuesCreated: () => [...createdIssues],
      setIssueState: (number, state) => issueStates.set(number, state),
    },
    close: async () => {
      await app.close()
      await new Promise<void>((resolve, reject) => torn.close((e) => (e ? reject(e) : resolve())))
      await new Promise<void>((resolve, reject) => github.close((e) => (e ? reject(e) : resolve())))
      await db.end()
      await embedded.stop()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
