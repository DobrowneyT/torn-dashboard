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

export interface WarRoomHub {
  /** Push a delta to every connected war-room client. */
  broadcast(channel: 'state' | 'dibs' | 'config' | 'chain', rows: unknown[], serverNow: string): void
  clientCount(): number
}

const CHANNELS = {
  state: 'SELECT * FROM war_room_state_v2',
  dibs: 'SELECT * FROM war_room_dibs_v2',
  config: 'SELECT * FROM war_room_config_v2',
  chain: 'SELECT * FROM war_room_chain_v2',
} as const

async function channelRows(db: pg.Pool, base: string, since: string | undefined) {
  const res = since
    ? await db.query(`${base} WHERE updated_at > $1`, [since])
    : await db.query(base)
  return res.rows
}

async function fullDelta(db: pg.Pool, since: string | undefined) {
  const now = await db.query('SELECT now() AS server_now')
  const [state, dibs, config, chain] = await Promise.all([
    channelRows(db, CHANNELS.state, since),
    channelRows(db, CHANNELS.dibs, since),
    channelRows(db, CHANNELS.config, since),
    channelRows(db, CHANNELS.chain, since),
  ])
  return {
    state: { rows: state },
    dibs: { rows: dibs },
    config: { rows: config },
    chain: { rows: chain },
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
    return fullDelta(deps.db, since)
  })

  const clients = new Set<WebSocket>()

  // Authenticated socket: ?token= carries the same session JWT as the
  // Authorization header (browsers can't set headers on WebSocket).
  app.get('/api/war-room/ws', { websocket: true }, async (socket, req) => {
    const token = (req.query as { token?: string }).token
    const session = token ? await verifySessionToken(deps.jwtSecret, token) : null
    if (!session) {
      socket.close(4401, 'Authentication required')
      return
    }

    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))

    // First frame: the full snapshot, so a (re)connecting client resyncs
    // without any REST round-trip.
    const snapshot = await fullDelta(deps.db, undefined)
    socket.send(JSON.stringify({ type: 'snapshot', ...snapshot }))
  })

  return {
    broadcast(channel, rows, serverNow) {
      if (rows.length === 0) return
      const frame = JSON.stringify({ type: 'delta', channel, rows, server_now: serverNow })
      for (const socket of clients) {
        if (socket.readyState === socket.OPEN) socket.send(frame)
      }
    },
    clientCount: () => clients.size,
  }
}
