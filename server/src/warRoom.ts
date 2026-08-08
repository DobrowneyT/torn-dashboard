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
}

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

async function channelRows(db: pg.Pool, base: string, since: string | undefined) {
  const res = since
    ? await db.query(`${base} WHERE updated_at > $1`, [since])
    : await db.query(base)
  return res.rows
}

async function fullDelta(db: pg.Pool, since: string | undefined, includeLeadOnly: boolean) {
  const now = await db.query('SELECT now() AS server_now')
  const [state, dibs, config, chain, memberstats] = await Promise.all([
    channelRows(db, CHANNELS.state, since),
    channelRows(db, CHANNELS.dibs, since),
    channelRows(db, CHANNELS.config, since),
    channelRows(db, CHANNELS.chain, since),
    // Not merely filtered out of the response — never read for a non-lead.
    includeLeadOnly ? channelRows(db, CHANNELS.memberstats, since) : Promise.resolve([]),
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
  // and re-verifying the token on every frame would be absurd.
  const clients = new Map<WebSocket, { lead: boolean }>()

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
    clients.set(socket, { lead })
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
