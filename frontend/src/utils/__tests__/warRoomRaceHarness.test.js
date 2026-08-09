/**
 * Two-transport race harness (#371, #376).
 *
 * The War Room is fed by a WebSocket AND by REST deltas that `pollNow()` fires
 * after every user write. Both land in the same map. The flicker users
 * reported — enemies snapping in and out of hospital — was a REST response,
 * in flight since before a write, arriving AFTER the socket frame carrying
 * that write and overwriting it with older data.
 *
 * That is an ORDERING bug, not a volume bug, which is what makes it testable
 * without a war: the trigger is a specific interleaving, and an interleaving
 * can be constructed. Everything here is deterministic — seeded randomness, a
 * simulated clock, no real sockets and no sleeping.
 *
 * ── Why this runs BOTH merge strategies ──────────────────────────────────
 *
 * The harness asserts two things at once:
 *
 *   1. the PRE-#371 arrival-order merge still flickers here, and
 *   2. the shipped version-aware merge does not.
 *
 * (1) is not decoration. A harness that stops exercising the race — because a
 * refactor changed the delta shape, or the poll timing, or the fixture — goes
 * quiet in exactly the same way as a fixed bug. Pinning the broken strategy to
 * a NON-ZERO flicker count means the harness has to keep reproducing the
 * original defect to pass, so it cannot rot into a test that proves nothing.
 */
import { describe, it, expect } from 'vitest'
import { mergeVersionedRows, liveRows } from '../warRoomMerge'

// ── The strategies under comparison ────────────────────────────────────────

/**
 * The merge as it behaved before #371: last writer wins, whoever that is.
 * Kept here, in the test, purely as the thing the fix has to beat.
 */
function mergeByArrival(map, rows, keyField) {
  for (const row of rows ?? []) {
    const key = row?.[keyField]
    if (key == null) continue
    map.set(key, row)
  }
  return map
}

const STRATEGIES = {
  'arrival-order (pre-#371)': mergeByArrival,
  'version-aware (shipped)': mergeVersionedRows,
}

// ── Deterministic clock and randomness ─────────────────────────────────────

/** mulberry32 — small, seeded, and identical on every machine and CI run. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Postgres renders the offset bare, e.g. "-05" — the #140 shape. */
const stamp = (ms) => `${new Date(ms).toISOString().replace('Z', '')}-00`

const row = (memberId, state, atMs) => ({
  member_id: memberId,
  updated_at: stamp(atMs),
  state: { status: { state } },
})

/**
 * Simulate one board session and count how often it flickered.
 *
 * The model, which mirrors the real system rather than approximating it:
 *
 *   - The SERVER holds the truth and rewrites a member's state at various
 *     ticks. Each rewrite bumps `updated_at`.
 *   - The SOCKET delivers each rewrite shortly after it happens.
 *   - A REST poll reads the truth AT THE MOMENT IT IS ISSUED and delivers that
 *     snapshot later. When its flight time straddles a rewrite, it arrives
 *     carrying data the socket has already superseded. That is the bug.
 *
 * A "flicker" is counted when the state the board is DISPLAYING for a member
 * goes backwards in version — the user-visible symptom, not an internal proxy
 * for it.
 */
function simulate({ strategy, seed, members = 8, ticks = 400 }) {
  const merge = STRATEGIES[strategy]
  const rand = rng(seed)
  const t0 = Date.UTC(2026, 7, 9, 12, 0, 0)

  // Server truth per member, and the deliveries queued toward the client.
  const truth = new Map()
  const deliveries = []           // { atMs, rows }

  for (let id = 1; id <= members; id++) {
    truth.set(id, { state: 'Hospital', atMs: t0 })
  }

  for (let tick = 1; tick <= ticks; tick++) {
    const nowMs = t0 + tick * 100

    // The roster sync flips somebody. Hospital exits are the interesting edge
    // — that is where the reported flicker clustered, because that is when
    // people are clicking (claiming the target that just came up).
    if (rand() < 0.35) {
      const id = 1 + Math.floor(rand() * members)
      const cur = truth.get(id)
      const next = cur.state === 'Hospital' ? 'Okay' : 'Hospital'
      truth.set(id, { state: next, atMs: nowMs })
      // Socket frame: fast, but not instant.
      deliveries.push({ atMs: nowMs + 5 + Math.floor(rand() * 20), rows: [row(id, next, nowMs)] })
    }

    // A user writes (dibs claim/release), which fires a REST delta. The
    // response carries a snapshot of EVERY member as of right now, and takes
    // a while to come back.
    if (rand() < 0.25) {
      const snapshot = [...truth.entries()].map(([id, v]) => row(id, v.state, v.atMs))
      const flightMs = 30 + Math.floor(rand() * 260)
      deliveries.push({ atMs: nowMs + flightMs, rows: snapshot })
    }
  }

  // Deliver in wall-clock order. Ties break by insertion order, which is what
  // a single-threaded client does with two sockets ready at once.
  deliveries.sort((a, b) => a.atMs - b.atMs)

  const map = new Map()
  const displayed = new Map()     // member_id → updated_at currently on screen
  let flickers = 0

  for (const d of deliveries) {
    merge(map, d.rows, 'member_id')
    for (const r of liveRows(map)) {
      const was = displayed.get(r.member_id)
      const now = r.updated_at
      if (was != null && now < was) flickers += 1   // ISO strings sort chronologically
      displayed.set(r.member_id, now)
    }
  }

  // Where the board ended up, against where the server actually is.
  const converged = [...truth.entries()].every(([id, v]) => {
    const shown = map.get(id)
    return shown?.state?.status?.state === v.state
  })

  return { flickers, converged }
}

// ── The comparison ─────────────────────────────────────────────────────────

const SEEDS = [1, 7, 42, 1337, 90210]

describe('two-transport race harness', () => {
  it('reproduces the flicker on the pre-#371 arrival-order merge', () => {
    // The harness's own smoke test. If this ever reads zero, the simulation
    // has stopped generating the interleaving and every other assertion below
    // is worthless.
    const total = SEEDS.reduce(
      (n, seed) => n + simulate({ strategy: 'arrival-order (pre-#371)', seed }).flickers, 0
    )
    // Currently ~147 across the five seeds. The floor is deliberately well
    // below that but well above 1: a harness scraping a single lucky race is
    // barely reproducing the bug, and would stop noticing if the interleaving
    // got rarer.
    expect(total).toBeGreaterThan(50)
  })

  it('reproduces it on EVERY seed, not just in aggregate', () => {
    // One pathological seed carrying the whole suite would let the race go
    // unexercised on the others without anyone noticing.
    for (const seed of SEEDS) {
      const { flickers } = simulate({ strategy: 'arrival-order (pre-#371)', seed })
      // Weakest seed currently lands at 18.
      expect(flickers, `seed ${seed} barely reproduced the race`).toBeGreaterThan(5)
    }
  })

  it('never flickers on the shipped version-aware merge', () => {
    for (const seed of SEEDS) {
      const { flickers } = simulate({ strategy: 'version-aware (shipped)', seed })
      expect(flickers, `seed ${seed} flickered`).toBe(0)
    }
  })

  it('still converges on the truth — rejecting stale rows must not drop fresh ones', () => {
    // The guard that makes the previous assertion mean something. A merge that
    // ignored every incoming row would score a perfect zero flickers and show
    // a permanently frozen board.
    for (const seed of SEEDS) {
      const { converged } = simulate({ strategy: 'version-aware (shipped)', seed })
      expect(converged, `seed ${seed} did not converge`).toBe(true)
    }
  })

  it('holds up as the board gets busier', () => {
    // The reported conditions: a full war roster, heavy clicking. Load changes
    // how OFTEN the race is hit, not whether the ordering rule is right — so
    // the fixed strategy should stay at zero while the broken one gets worse.
    const big = { members: 40, ticks: 1500, seed: 4242 }
    const broken = simulate({ strategy: 'arrival-order (pre-#371)', ...big })
    const fixed = simulate({ strategy: 'version-aware (shipped)', ...big })

    // ~123 today; more members and more clicking means more chances to hit it.
    expect(broken.flickers).toBeGreaterThan(50)
    expect(fixed.flickers).toBe(0)
    expect(fixed.converged).toBe(true)
  })

  it('is deterministic — the same seed gives the same result twice', () => {
    // Non-negotiable for CI. A flaky race test gets muted, and a muted test is
    // worse than no test.
    const a = simulate({ strategy: 'arrival-order (pre-#371)', seed: 99 })
    const b = simulate({ strategy: 'arrival-order (pre-#371)', seed: 99 })
    expect(a).toEqual(b)
  })
})
