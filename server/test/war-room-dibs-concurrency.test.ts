// Server-side dibs concurrency harness (#385).
//
// #383 built the client-side half of this: a deterministic simulation of the
// delta merge, which is where the FLICKER lived (#371). This is the other half.
// #376 was a server-side logic bug — a claim silently tombstoned — and nothing
// exercised that path under concurrency, which is why it took a war and two
// user reports to find, and why it kept being conflated with the flicker.
//
// What runs here: real templated Postgres, the real ticker, real WebSocket
// clients, N holders claiming and releasing against a shared target pool
// concurrently, and a roster oscillating Hospital → Okay → Hospital on its own
// schedules — including the tight re-hospitalisation that farm mode produces.
//
// ── Determinism ──────────────────────────────────────────────────────────────
//
// A flaky concurrency test gets muted, and a muted test is worse than none.
// So: every decision comes from a seeded PRNG, and every assertion is an
// INVARIANT that must hold for any valid interleaving — never an expected
// sequence. The claims within a round genuinely race (Promise.all against one
// Postgres), so the interleaving is not fixed; what is fixed is the set of
// actions attempted and the roster's state at every tick.
//
// ── Time ─────────────────────────────────────────────────────────────────────
//
// Wall-clock waiting would make this take minutes. Instead the round advances a
// virtual clock: every live deadline is moved back by ROUND_SECONDS, which is
// exactly equivalent to that much time passing, and the fixture's hospital
// `until` values advance in the same currency. The established pattern from
// war-room-dibs-expiry.test.ts, applied uniformly rather than per-case.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'

let stack: TestStack
const US = Number(TEST_FACTION.tornFactionId)
const ENEMY = 90050

const SEED = 0x5eed4385
const ROUNDS = 30
/** Simulated seconds per round. Three rounds outlast the 30s expiry window. */
const ROUND_SECONDS = 12
const EXPIRY_SECONDS = 30

/** Holders who claim and release. Ids double as Torn user ids. */
const HOLDERS = ['1801', '1802', '1803', '1804', '1805']
/** Contested targets, driven by the PRNG. */
const TARGETS = [90150, 90151, 90152, 90153, 90154]
/**
 * The farm-mode canary: a dedicated target on a fixed Okay/Hospital cycle with
 * a holder who never lets go. Under the #376 fix this claim survives the entire
 * run; with the fix reverted it dies on the second hospital exit. Deliberately
 * NOT PRNG-driven — the one thing here that must be a fixed scenario.
 */
const CANARY = 90159
const CANARY_HOLDER = HOLDERS[0]

/**
 * Postgres timestamptz → epoch ms.
 *
 * ⚠️ `Date.parse` returns NaN on the shape pg actually emits — a bare two-digit
 * offset like `2026-08-12T05:07:27.775736-05` (the #140 trap). Silently. Every
 * comparison against NaN is false, so a check written with `Date.parse` does
 * not fail loudly, it just stops checking — which cost this harness a wrong
 * "no cause" verdict and a monotonicity assertion that could never fire.
 *
 * frontend/src/utils/time.js has parseDbTime for the same reason; the server
 * has no equivalent and a test must not import across into the frontend.
 */
function dbTimeMs(ts: string | null): number | null {
  if (!ts) return null
  const s = String(ts).replace(/([+-]\d{2})$/, '$1:00')
  const ms = new Date(s).getTime()
  return Number.isNaN(ms) ? null : ms
}

/** Deterministic PRNG (mulberry32) — same seed, same actions, every run. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const tokens: Record<string, string> = {}

function tickerDeps() {
  const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
  return { db: stack.db, pool, hub: stack.warRoomHub!, tornBaseUrl: stack.tornBaseUrl }
}

// ── Roster simulation ────────────────────────────────────────────────────────

interface SimStatus { state: 'Okay' | 'Hospital'; until: number | null }

/** Virtual epoch, advanced by ROUND_SECONDS per round alongside the deadlines. */
let clockEpoch = 1752200000
const statuses = new Map<number, SimStatus>()
/** Hospital ticks remaining, per target. */
const hospitalLeft = new Map<number, number>()

function initRoster() {
  clockEpoch = 1752200000
  statuses.clear()
  hospitalLeft.clear()
  for (const t of [...TARGETS, CANARY]) {
    statuses.set(t, { state: 'Hospital', until: clockEpoch + 120 })
    hospitalLeft.set(t, 2)
  }
}

/**
 * Advance every target one round.
 *
 * The canary follows a fixed farm-mode loop: two rounds down, one round up.
 * One round up is 12 simulated seconds — comfortably inside the 30s window, so
 * a correct server never legitimately expires this claim, and any tombstone on
 * it is a real defect rather than a rule firing.
 */
function advanceRoster(round: number, rand: () => number) {
  clockEpoch += ROUND_SECONDS

  // Canary: Hospital, Hospital, Okay, repeat.
  //
  // `until` is fixed on ENTRY and held constant for the stay. Recomputing it
  // each round from the moving clock makes an ordinary countdown look like a
  // fresh hit, which is precisely the #107 trigger — the sim would then be
  // asking the server to distinguish two things it had made identical.
  const phase = round % 3
  const wasDown = statuses.get(CANARY)!.state === 'Hospital'
  statuses.set(CANARY, phase === 2
    ? { state: 'Okay', until: null }
    : {
        state: 'Hospital',
        until: wasDown ? statuses.get(CANARY)!.until! : clockEpoch + 90,
      })

  for (const t of TARGETS) {
    const cur = statuses.get(t)!
    if (cur.state === 'Hospital') {
      const left = (hospitalLeft.get(t) ?? 0) - 1
      if (rand() < 0.15) {
        // Re-hit while down: `until` jumps UP. This is the #107 trigger, and
        // the reason the sweep has to distinguish it from an ordinary
        // countdown — which it can only do by comparing across ticks.
        statuses.set(t, { state: 'Hospital', until: (cur.until ?? clockEpoch) + 300 })
        hospitalLeft.set(t, left + 3)
      } else if (left <= 0) {
        statuses.set(t, { state: 'Okay', until: null })
        hospitalLeft.set(t, 0)
      } else {
        // Ordinary countdown: the absolute `until` does not move.
        hospitalLeft.set(t, left)
      }
    } else if (rand() < 0.45) {
      // Back down. A tight one (1 round) is the farm-mode case.
      const stay = rand() < 0.5 ? 1 : 3
      statuses.set(t, { state: 'Hospital', until: clockEpoch + stay * ROUND_SECONDS + 30 })
      hospitalLeft.set(t, stay)
    }
  }
}

function enemyPayload() {
  return {
    members: [...TARGETS, CANARY].map((id) => ({
      id, name: `Foe${id}`, level: 50, position: 'Soldier',
      last_action: { status: 'Idle', timestamp: clockEpoch },
      status: statuses.get(id)!, is_revivable: false,
    })),
  }
}

// ── WebSocket client ─────────────────────────────────────────────────────────

interface Client {
  ws: WebSocket
  /** Every 'state' row seen, in arrival order. */
  stateRows: Array<{ member_id: number; updated_at: string }>
  /** Target ids seen tombstoned on the dibs channel. */
  releasesSeen: Set<number>
  ready: Promise<void>
}

function wsConnect(token: string): Promise<Client> {
  const url = `${stack.baseUrl.replace('http', 'ws')}/api/war-room/ws?token=${token}`
  const ws = new WebSocket(url)
  const client: Client = { ws, stateRows: [], releasesSeen: new Set(), ready: Promise.resolve() }
  let markReady: () => void
  client.ready = new Promise<void>((r) => { markReady = r })
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data))
    if (msg.type === 'snapshot') markReady()
    if (msg.type !== 'delta') return
    if (msg.channel === 'state') {
      for (const r of msg.rows ?? []) {
        client.stateRows.push({ member_id: Number(r.member_id), updated_at: r.updated_at })
      }
    }
    if (msg.channel === 'dibs') {
      for (const r of msg.rows ?? []) if (r.deleted_at) client.releasesSeen.add(Number(r.target_id))
    }
  })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(client))
    ws.on('error', reject)
  })
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  stack = await startTestStack()
  const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })

  for (const id of HOLDERS) {
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, tier, is_current) VALUES ($1, $2, 3, true)
       ON CONFLICT (member_id) DO NOTHING`,
      [id, `Holder${id}`]
    )
    const key = `CONCURKEY${id}AAAA`.slice(0, 16)
    stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
    const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    })
    tokens[id] = ((await res.json()) as any).token
  }
  await pool.store(HOLDERS[0], 'CONCURPOOLKEY001', { consentVersion: 'v2' })

  await stack.db.query(
    `INSERT INTO war_room_config_v2 (id, enabled, faction_id, faction_name, auto_managed, dibs_expiry_seconds)
     VALUES (1, true, ${ENEMY}, 'Foes', false, ${EXPIRY_SECONDS})
     ON CONFLICT (id) DO UPDATE SET enabled = true, faction_id = ${ENEMY},
       auto_managed = false, dibs_expiry_seconds = ${EXPIRY_SECONDS}`
  )

  stack.torn.setHandler(`/v2/faction/${US}/members`, () => ({
    members: HOLDERS.map((id) => ({
      id: Number(id), name: `Holder${id}`, level: 40, position: 'Soldier',
      last_action: { status: 'Online', timestamp: clockEpoch },
      status: { state: 'Okay', until: null }, is_revivable: false,
    })),
  }))
  stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => enemyPayload())
}, 60000)

afterAll(async () => {
  await stack?.close()
})

// ── The run ──────────────────────────────────────────────────────────────────

async function claim(holder: string, targetId: number) {
  const res = await fetch(`${stack.baseUrl}/api/war-room/dibs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[holder]}` },
    body: JSON.stringify({ target_id: targetId }),
  })
  return res.status
}

async function release(holder: string, targetId: number) {
  await fetch(`${stack.baseUrl}/api/war-room/dibs/${targetId}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${tokens[holder]}` },
  })
}

interface LiveDib {
  id: number; target_id: number; claimed_by: number; auto_expire_at: string | null
}

async function liveDibs(): Promise<Map<number, LiveDib>> {
  const res = await stack.db.query(
    `SELECT id, target_id, claimed_by, auto_expire_at FROM war_room_dibs_v2 WHERE deleted_at IS NULL`
  )
  return new Map(res.rows.map((r: any) => [Number(r.id), {
    id: Number(r.id), target_id: Number(r.target_id),
    claimed_by: Number(r.claimed_by), auto_expire_at: r.auto_expire_at,
  }]))
}

describe('war-room dibs under concurrency (#385)', () => {
  it(
    'holds every invariant across a seeded run of concurrent claims and an oscillating roster',
    async () => {
      initRoster()
      const rand = rng(SEED)

      const clients = await Promise.all(HOLDERS.slice(0, 3).map((h) => wsConnect(tokens[h])))
      const { createWarRoomTicker } = await import('../src/warRoomTicker.js')
      const ticker = createWarRoomTicker(tickerDeps())

      // Prime: one tick so every target has a stored status to diff against.
      await ticker.tick()
      await Promise.all(clients.map((c) => c.ready))

      // The canary claim, taken once and never released by us.
      await claim(CANARY_HOLDER, CANARY)

      /** Round at which each live dib's deadline was armed, by dib id. */
      const armedAt = new Map<number, number>()
      /** Rounds at which each target was observed NOT Okay. */
      const downAt = new Map<number, Set<number>>()

      let tombstonesExplained = 0
      let windowExpiries = 0
      let untilJumpDrops = 0
      let canaryWindows = 0
      const violations: string[] = []

      for (let round = 1; round <= ROUNDS; round++) {
        // Virtual time passes FIRST: every pending deadline moves ROUND_SECONDS
        // closer. Doing this before the snapshot matters — read the deadlines
        // beforehand and every lapse looks causeless, because the row said
        // "in the future" at the moment it was read.
        await stack.db.query(
          `UPDATE war_room_dibs_v2 SET auto_expire_at = auto_expire_at - make_interval(secs => $1)
           WHERE deleted_at IS NULL AND auto_expire_at IS NOT NULL`,
          [ROUND_SECONDS]
        )

        const before = await liveDibs()
        const beforeStatus = new Map(
          [...TARGETS, CANARY].map((t) => [t, { ...statuses.get(t)! }])
        )

        // ── Concurrent user actions ──────────────────────────────────────────
        // Fired together against one Postgres, so these genuinely race.
        const manualReleases = new Set<number>()
        const claimedThisRound = new Map<string, number>()
        const actions: Array<Promise<unknown>> = []
        for (const holder of HOLDERS) {
          const roll = rand()
          const target = [...TARGETS][Math.floor(rand() * TARGETS.length)]
          if (holder === CANARY_HOLDER) continue // the canary holder only holds
          if (roll < 0.55) {
            claimedThisRound.set(holder, target)
            actions.push(claim(holder, target))
          } else if (roll < 0.75) {
            manualReleases.add(target)
            actions.push(release(holder, target))
          }
        }
        await Promise.all(actions)

        // ── Advance the world, then tick ─────────────────────────────────────
        advanceRoster(round, rand)
        await ticker.tick()

        const after = await liveDibs()
        for (const t of [...TARGETS, CANARY]) {
          if (statuses.get(t)!.state !== 'Okay') {
            if (!downAt.has(t)) downAt.set(t, new Set())
            downAt.get(t)!.add(round)
          }
        }
        for (const [id, d] of after) {
          const wasArmed = before.get(id)?.auto_expire_at != null
          if (d.auto_expire_at != null && !wasArmed) armedAt.set(id, round)
          if (d.auto_expire_at == null) armedAt.delete(id)
        }

        // ── INVARIANT: at most one live claim per target ─────────────────────
        const perTarget = new Map<number, number>()
        for (const d of after.values()) perTarget.set(d.target_id, (perTarget.get(d.target_id) ?? 0) + 1)
        for (const [t, n] of perTarget) {
          if (n > 1) violations.push(`round ${round}: target ${t} has ${n} live claims`)
        }

        // ── INVARIANT: at most one live claim per holder (single-dibs) ───────
        const perHolder = new Map<number, number>()
        for (const d of after.values()) perHolder.set(d.claimed_by, (perHolder.get(d.claimed_by) ?? 0) + 1)
        for (const [h, n] of perHolder) {
          if (n > 1) violations.push(`round ${round}: holder ${h} has ${n} live claims`)
        }

        // ── INVARIANT: no dib released without a cause ───────────────────────
        for (const [id, d] of before) {
          if (after.has(id)) continue
          const prev = beforeStatus.get(d.target_id)
          const next = statuses.get(d.target_id)!
          const holderStr = String(d.claimed_by)

          if (manualReleases.has(d.target_id)) { tombstonesExplained++; continue }
          // The single-dibs rule tombstones the holder's other claims, and a
          // re-claim of the same target replaces the row.
          if (claimedThisRound.has(holderStr)) { tombstonesExplained++; continue }
          // #107 — hospital `until` jumped up between observations.
          if (prev?.state === 'Hospital' && next.state === 'Hospital'
              && prev.until != null && next.until != null && next.until > prev.until) {
            untilJumpDrops++; tombstonesExplained++; continue
          }
          // #106/#159 — the window lapsed against a target that was Okay for
          // the whole window. The "whole window" half is the #376 property:
          // a deadline armed before a hospital stay must have been disarmed,
          // so it can never be the cause of a drop after the target went down.
          const deadlineMs = dbTimeMs(d.auto_expire_at)
          if (deadlineMs != null && deadlineMs <= Date.now() && next.state === 'Okay') {
            const armed = armedAt.get(id)
            const down = downAt.get(d.target_id)
            const wentDownSinceArming = armed != null && down != null
              && [...down].some((r) => r >= armed)
            if (wentDownSinceArming) {
              violations.push(
                `round ${round}: dib ${id} on target ${d.target_id} expired on a deadline ` +
                `armed at round ${armed}, but the target was in hospital since then — ` +
                `the #376 landmine (deadline not disarmed on the way down)`
              )
            } else {
              windowExpiries++
            }
            tombstonesExplained++
            continue
          }
          violations.push(
            `round ${round}: dib ${id} (target ${d.target_id}, holder ${d.claimed_by}) ` +
            `was tombstoned with no cause — prev=${JSON.stringify(prev)} next=${JSON.stringify(next)} ` +
            `auto_expire_at=${d.auto_expire_at}`
          )
        }

        // ── INVARIANT: the canary claim survives every farm-mode cycle ───────
        const canary = [...after.values()].find((d) => d.target_id === CANARY)
        if (process.env.DIBS_TRACE) {
          const b = [...before.values()].find((d) => d.target_id === CANARY)
          console.log(
            `r${round} canary ${beforeStatus.get(CANARY)!.state}→${statuses.get(CANARY)!.state} ` +
            `before=${b ? `id${b.id} exp=${b.auto_expire_at}` : 'GONE'} ` +
            `after=${canary ? `id${canary.id} exp=${canary.auto_expire_at}` : 'GONE'}`
          )
        }
        if (!canary) {
          violations.push(
            `round ${round}: the canary claim on ${CANARY} was released. Its holder never ` +
            `let go and it is never up for longer than the expiry window, so no rule ` +
            `legitimately frees it — this is #376.`
          )
          // Re-take it so the rest of the run still reports, rather than
          // collapsing into one failure at the first cycle.
          await claim(CANARY_HOLDER, CANARY)
        } else if (beforeStatus.get(CANARY)!.state === 'Hospital'
                   && statuses.get(CANARY)!.state === 'Okay') {
          // A full window on EVERY exit, not just the first.
          const deadline = dbTimeMs(canary.auto_expire_at)
          const secs = deadline == null ? null : (deadline - Date.now()) / 1000
          canaryWindows++
          if (secs == null || secs < EXPIRY_SECONDS - ROUND_SECONDS) {
            violations.push(
              `round ${round}: canary came out of hospital with ${secs ?? 'no'} seconds on ` +
              `its window, expected ~${EXPIRY_SECONDS}`
            )
          }
        }
      }

      // Let the last broadcasts land.
      await new Promise((r) => setTimeout(r, 200))

      // ── INVARIANT: no client sees a member's state go backwards ────────────
      for (const [i, c] of clients.entries()) {
        const lastSeen = new Map<number, number>()
        for (const row of c.stateRows) {
          const ts = dbTimeMs(row.updated_at)
          if (ts == null) {
            violations.push(`client ${i}: unparseable updated_at ${row.updated_at} — the ` +
              `monotonicity check would silently pass on every row`)
            continue
          }
          const prev = lastSeen.get(row.member_id)
          if (prev != null && ts < prev) {
            violations.push(`client ${i}: member ${row.member_id} went backwards in time`)
          }
          lastSeen.set(row.member_id, Math.max(ts, prev ?? ts))
        }
      }

      // ── INVARIANT: every release reached every client ──────────────────────
      const union = new Set<number>()
      for (const c of clients) for (const t of c.releasesSeen) union.add(t)
      for (const [i, c] of clients.entries()) {
        for (const t of union) {
          if (!c.releasesSeen.has(t)) {
            violations.push(`client ${i} never saw the release of target ${t}`)
          }
        }
      }

      for (const c of clients) c.ws.close()

      // Violations first: they name the defect. The floors below only say the
      // run was too quiet to mean anything, which is a far less useful message
      // to lead with when something is genuinely broken.
      expect(violations).toEqual([])

      // ── The harness must not pass by doing nothing ────────────────────────
      // Errors inside a tick are swallowed by design (#342), so a run where the
      // sweep quietly stopped firing would otherwise look identical to a clean
      // one. These floors make silence fail.
      expect(tombstonesExplained, 'no dibs churned at all — the run proved nothing').toBeGreaterThan(5)
      expect(canaryWindows, 'the canary never completed a farm-mode cycle').toBeGreaterThan(5)
      expect(windowExpiries + untilJumpDrops,
        'the auto-expiry sweep never fired — it may have stalled silently').toBeGreaterThan(0)
      const finalState = await stack.db.query(
        `SELECT count(*)::int AS n FROM war_room_state_v2 WHERE member_id = ANY($1)`,
        [[...TARGETS, CANARY]]
      )
      expect(finalState.rows[0].n).toBe(TARGETS.length + 1)
    },
    120000
  )
})
