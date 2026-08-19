// War-room read path (slice #71): one combined delta/snapshot endpoint (the
// REST fallback and first-paint source) + the WebSocket hub the ticker
// broadcasts through. Delta semantics match the old PostgREST RPCs: rows
// whose updated_at advanced past `since` (everything when absent), with
// soft-deletes carried as tombstoned rows; the response's server_now is the
// client's next watermark (never client clocks).
import type { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import type { WebSocket } from 'ws'
import type pg from 'pg'
import { requireAuth } from './authz.js'
import { verifySessionToken } from './auth.js'

export interface WarRoomDeps {
  db: pg.Pool
  jwtSecret: string
  /** Socket keepalive period. Overridden only by tests. */
  heartbeatMs?: number
}

/**
 * How often to ping an idle socket.
 *
 * ⚠️ This is not optional politeness — it is what keeps the connection alive.
 * nginx gives an idle upstream `proxy_read_timeout 300s` and then tears the
 * tunnel down (deploy/nginx/default.conf). The hub only ever writes when the
 * ticker broadcasts, and the ticker is war-gated: with no war on it is idle, so
 * a socket can sit silent indefinitely. Every client therefore dropped and
 * reconnected on a five-minute cycle, logging a connection error each time —
 * visible in the access log on 2026-08-17 as successive 101s exactly 5m02s
 * apart, from the dashboard and the #487 userscript alike.
 *
 * A ping costs nothing and needs no client support: browsers answer at the
 * protocol level. Well under 300s so a single dropped ping is not fatal.
 */
const HEARTBEAT_MS = 30_000

export type WarRoomChannel = 'state' | 'dibs' | 'config' | 'chain' | 'memberstats'

export interface WarRoomHub {
  /**
   * Push a delta to connected war-room clients. Lead-only channels (see
   * LEAD_ONLY_CHANNELS) reach only sockets whose session carries a war
   * lead / leadership / admin role.
   */
  broadcast(channel: WarRoomChannel, rows: unknown[], serverNow: string): void
  /** Push an out-of-band alert event (e.g. a PUSH surge, #208) to every tab. */
  alert(payload: Record<string, unknown>): void
  clientCount(): number
}

const CHANNELS = {
  state: 'SELECT * FROM war_room_state_v2',
  dibs: 'SELECT * FROM war_room_dibs_v2',
  config: 'SELECT * FROM war_room_config_v2',
  chain: 'SELECT * FROM war_room_chain_v2',
  memberstats: 'SELECT * FROM war_room_member_stats_v2',
} as const

/**
 * Channels withheld from ordinary members (#336).
 *
 * Live energy and drug cooldowns say when a teammate is playing and whether
 * they are mid-overdose — war-planning data for leads, not something every
 * member should hold about every other member. Because the hub serialises ONE
 * frame and fans it out, hiding this in the UI would still ship it to every
 * browser; the withholding has to happen here.
 *
 * Deriving lead-only status from the channel NAME (rather than a flag at each
 * call site) means a future broadcaster cannot leak it by forgetting an
 * argument.
 */
const LEAD_ONLY_CHANNELS = new Set<WarRoomChannel>(['memberstats'])

/**
 * Who may see lead-only channels. Mirrors canEditMemberNotes on the client:
 * war leads, leadership and admins, never visitors (read-only outsiders).
 */
export function canSeeLeadOnlyChannels(claims: {
  is_warlead?: boolean
  is_leadership?: boolean
  is_admin?: boolean
  is_visitor?: boolean
} | null | undefined): boolean {
  if (!claims) return false
  if (claims.is_visitor) return false
  return Boolean(claims.is_warlead || claims.is_leadership || claims.is_admin)
}

/**
 * Channels whose rows are soft-deleted rather than removed.
 *
 * ⚠️ Only these two carry `deleted_at`; adding the filter to the others would
 * be a SQL error, not a no-op.
 */
const SOFT_DELETED_CHANNELS = new Set<WarRoomChannel>(['state', 'dibs'])

/**
 * ⚠️ A FULL snapshot omits tombstones; a delta must carry them.
 *
 * A tombstone cancels a row the client already holds, so it is essential in a
 * delta and meaningless in a snapshot — a client with no prior state has
 * nothing to cancel. Neither table is ever pruned, so shipping them anyway
 * meant sending the entire history of the faction's wars on every first load:
 * on forge, 2026-08-19, that was **2627 dib rows to describe 1 live claim**,
 * and 672 roster rows to describe 194 live members. First paint cost 2.1
 * seconds; the deltas that followed took 300ms.
 */
async function channelRows(
  db: pg.Pool,
  base: string,
  since: string | undefined,
  channel: WarRoomChannel
) {
  if (since) {
    const res = await db.query(`${base} WHERE updated_at > $1`, [since])
    return res.rows
  }
  const res = SOFT_DELETED_CHANNELS.has(channel)
    ? await db.query(`${base} WHERE deleted_at IS NULL`)
    : await db.query(base)
  return res.rows
}

async function fullDelta(db: pg.Pool, since: string | undefined, includeLeadOnly: boolean) {
  const now = await db.query('SELECT now() AS server_now')
  const [state, dibs, config, chain, memberstats] = await Promise.all([
    channelRows(db, CHANNELS.state, since, 'state'),
    channelRows(db, CHANNELS.dibs, since, 'dibs'),
    channelRows(db, CHANNELS.config, since, 'config'),
    channelRows(db, CHANNELS.chain, since, 'chain'),
    // Not merely filtered out of the response — never read for a non-lead.
    includeLeadOnly ? channelRows(db, CHANNELS.memberstats, since, 'memberstats') : Promise.resolve([]),
  ])
  return {
    state: { rows: state },
    dibs: { rows: dibs },
    config: { rows: config },
    chain: { rows: chain },
    memberstats: { rows: memberstats },
    server_now: now.rows[0].server_now,
  }
}

export async function registerWarRoomRoutes(
  app: FastifyInstance,
  deps: WarRoomDeps
): Promise<WarRoomHub> {
  await app.register(websocket)

  app.get('/api/war-room/delta', { preHandler: requireAuth() }, async (req) => {
    const since = (req.query as { since?: string }).since
    // The REST fallback is the same read path as the socket snapshot, so it
    // needs the same gate — otherwise a non-lead could just poll it directly.
    return fullDelta(deps.db, since, canSeeLeadOnlyChannels(req.session))
  })

  // Sockets carry their session's lead status: broadcast() needs it per client,
  // and re-verifying the token on every frame would be absurd. `alive` is the
  // heartbeat's view of the same socket — see HEARTBEAT_MS.
  const clients = new Map<WebSocket, { lead: boolean; alive: boolean }>()

  const heartbeat = setInterval(() => {
    for (const [socket, meta] of clients) {
      // No pong since the last tick: the peer is gone (a laptop that slept, a
      // network that moved) and only we still think otherwise. terminate()
      // rather than close() — there is nobody left to complete a handshake.
      if (!meta.alive) {
        clients.delete(socket)
        socket.terminate()
        continue
      }
      meta.alive = false
      try { socket.ping() } catch { clients.delete(socket) }
    }
  }, deps.heartbeatMs ?? HEARTBEAT_MS)
  // Must not hold the process open, and must not outlive the app — a leaked
  // interval turns every test that builds a stack into a hang.
  heartbeat.unref?.()
  app.addHook('onClose', () => { clearInterval(heartbeat) })

  // Authenticated socket: ?token= carries the same session JWT as the
  // Authorization header (browsers can't set headers on WebSocket).
  app.get('/api/war-room/ws', { websocket: true }, async (socket, req) => {
    const token = (req.query as { token?: string }).token
    const session = token ? await verifySessionToken(deps.jwtSecret, token) : null
    if (!session) {
      socket.close(4401, 'Authentication required')
      return
    }

    const lead = canSeeLeadOnlyChannels(session)
    const meta = { lead, alive: true }
    clients.set(socket, meta)
    socket.on('pong', () => { meta.alive = true })
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))

    // First frame: the full snapshot, so a (re)connecting client resyncs
    // without any REST round-trip.
    const snapshot = await fullDelta(deps.db, undefined, lead)
    socket.send(JSON.stringify({ type: 'snapshot', ...snapshot }))
  })

  return {
    broadcast(channel, rows, serverNow) {
      if (rows.length === 0) return
      const leadOnly = LEAD_ONLY_CHANNELS.has(channel)
      const frame = JSON.stringify({ type: 'delta', channel, rows, server_now: serverNow })
      for (const [socket, meta] of clients) {
        if (leadOnly && !meta.lead) continue
        if (socket.readyState === socket.OPEN) socket.send(frame)
      }
    },
    alert(payload) {
      const frame = JSON.stringify({ type: 'alert', ...payload })
      for (const socket of clients.keys()) {
        if (socket.readyState === socket.OPEN) socket.send(frame)
      }
    },
    clientCount: () => clients.size,
  }
}
