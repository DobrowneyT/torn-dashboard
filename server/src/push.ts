// Web Push delivery for War Room notifications (#207). This is the pipe the
// surge-alert (#208) and leader-headline (#209) slices call into; it owns
// subscription storage, VAPID-signed delivery, and stale-endpoint pruning.
//
// VAPID keypair is an operator secret (env: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
// / VAPID_SUBJECT — generate with `npx web-push generate-vapid-keys`; see
// docs/PUSH.md). When it isn't configured, subscriptions still store but
// sendToMembers is a no-op, so the rest of the app degrades cleanly.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import webpush from 'web-push'
import { requireAuth, requireRole } from './authz.js'

export interface VapidConfig {
  publicKey: string
  privateKey: string
  /** mailto: or https: contact, per the VAPID spec. */
  subject: string
}

export interface PushSubscriptionInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PushPayload {
  title: string
  body: string
  /** War Room path to focus/open on click. */
  url?: string
  /** Collapse key so repeated alerts replace rather than stack. */
  tag?: string
}

/** Delivers one push; throws on failure with a `.statusCode` (web-push does). */
export type PushSender = (sub: webpush.PushSubscription, payload: string) => Promise<unknown>

export interface PushService {
  /** VAPID public key for the client's PushManager.subscribe, or null when unconfigured. */
  readonly publicKey: string | null
  readonly configured: boolean
  subscribe(memberId: string, sub: PushSubscriptionInput): Promise<void>
  unsubscribe(endpoint: string): Promise<void>
  sendToMembers(memberIds: string[], payload: PushPayload): Promise<PushResult>
}

export interface PushResult {
  sent: number
  pruned: number
  failed: number
}

export interface PushServiceOptions {
  db: pg.Pool
  vapid?: VapidConfig | null
  /** Injectable for tests; defaults to VAPID-signed web-push delivery. */
  sender?: PushSender
}

function isValidSubscription(sub: unknown): sub is PushSubscriptionInput {
  if (!sub || typeof sub !== 'object') return false
  const s = sub as PushSubscriptionInput
  return (
    typeof s.endpoint === 'string' &&
    /^https?:\/\//.test(s.endpoint) &&
    !!s.keys &&
    typeof s.keys.p256dh === 'string' &&
    typeof s.keys.auth === 'string'
  )
}

export function createPushService({ db, vapid, sender }: PushServiceOptions): PushService {
  const configured = !!(vapid?.publicKey && vapid.privateKey && vapid.subject)

  // Default sender: VAPID-signed Web Push. Only wired when configured.
  const deliver: PushSender =
    sender ??
    ((sub, payload) =>
      webpush.sendNotification(sub, payload, {
        vapidDetails: {
          subject: vapid!.subject,
          publicKey: vapid!.publicKey,
          privateKey: vapid!.privateKey,
        },
      }))

  return {
    get publicKey() {
      return configured ? vapid!.publicKey : null
    },
    get configured() {
      return configured
    },

    async subscribe(memberId, sub) {
      if (!isValidSubscription(sub)) throw new Error('invalid subscription')
      // Upsert by endpoint: a re-subscribe on the same device refreshes the keys
      // and re-owns it to the current member.
      await db.query(
        `INSERT INTO push_subscriptions (endpoint, member_id, p256dh, auth)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE SET
           member_id = EXCLUDED.member_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [sub.endpoint, String(memberId), sub.keys.p256dh, sub.keys.auth]
      )
    },

    async unsubscribe(endpoint) {
      await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint])
    },

    async sendToMembers(memberIds, payload) {
      const result: PushResult = { sent: 0, pruned: 0, failed: 0 }
      if (!configured || memberIds.length === 0) return result

      const ids = memberIds.map(String)
      const rows = await db.query(
        'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = ANY($1)',
        [ids]
      )
      const body = JSON.stringify(payload)

      await Promise.all(
        rows.rows.map(async (row) => {
          const sub: webpush.PushSubscription = {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          }
          try {
            await deliver(sub, body)
            result.sent += 1
          } catch (err) {
            const status = (err as { statusCode?: number })?.statusCode
            // 404/410 = the browser dropped this subscription; stop wasting
            // sends on it (and don't count it as a real failure).
            if (status === 404 || status === 410) {
              await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [row.endpoint])
              result.pruned += 1
            } else {
              result.failed += 1
            }
          }
        })
      )
      return result
    },
  }
}

export interface RegisterPushOptions {
  db: pg.Pool
  vapid?: VapidConfig | null
  sender?: PushSender
}

/**
 * Wire the push endpoints and return the service so background senders
 * (#208 surge alerts, #209 leader headlines) can reuse it:
 *   GET  /api/push/vapid-public-key  — public key (or null) for the client
 *   POST /api/push/subscribe         — store this browser's subscription
 *   POST /api/push/unsubscribe       — drop it (permission revoked / opt-out)
 *   POST /api/push/test              — leadership: send a test push to self
 */
export function registerPushRoutes(app: FastifyInstance, opts: RegisterPushOptions): PushService {
  const service = createPushService(opts)

  app.get('/api/push/vapid-public-key', { preHandler: requireAuth() }, async () => ({
    publicKey: service.publicKey,
  }))

  app.post('/api/push/subscribe', { preHandler: requireAuth() }, async (req, reply) => {
    const sub = req.body as PushSubscriptionInput
    try {
      await service.subscribe(String(req.session!.torn_user_id), sub)
    } catch {
      return reply.status(400).send({ error: 'invalid subscription' })
    }
    return { ok: true }
  })

  app.post('/api/push/unsubscribe', { preHandler: requireAuth() }, async (req) => {
    const endpoint = (req.body as { endpoint?: unknown })?.endpoint
    if (typeof endpoint === 'string' && endpoint) await service.unsubscribe(endpoint)
    return { ok: true }
  })

  // A verify-delivery path for operators: pushes a test notification to the
  // caller's own devices only.
  app.post(
    '/api/push/test',
    { preHandler: requireRole('warlead', 'leadership', 'admin') },
    async (req, reply) => {
      if (!service.configured) {
        return reply.status(503).send({ error: 'push not configured' })
      }
      const result = await service.sendToMembers([String(req.session!.torn_user_id)], {
        title: 'War Room test',
        body: 'Push notifications are working. 🔔',
        url: '/war-room',
        tag: 'push-test',
      })
      return result
    }
  )

  return service
}
