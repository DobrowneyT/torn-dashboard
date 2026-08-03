// PUSH-surge detection (#208): rate-based, per-direction, cooldown-gated.
import { describe, it, expect } from 'vitest'
import { createSurgeDetector, type SurgeConfig } from '../src/warRoomSurge.js'

const ENEMY = 111
const OURS = 222

const config: SurgeConfig = {
  enabled: true,
  enemy: { threshold: 3, windowSec: 60 },
  our: { threshold: 3, windowSec: 60 },
  cooldownSec: 300,
}

// Build a changed-row where `member` transitions to `state` on `faction`.
function row(member: number, faction: number, state: string, deleted = false) {
  return {
    member_id: member,
    faction_id: faction,
    deleted_at: deleted ? new Date() : null,
    state: { status: { state } },
  }
}

// Seed a member as hospitalised (first sighting seeds silently), then flip Okay.
function hospitalize(detector: ReturnType<typeof createSurgeDetector>, members: number[], faction: number, nowMs: number) {
  detector.observe(members.map((m) => row(m, faction, 'Hospital')), { enemyId: ENEMY, ourId: OURS, config, nowMs })
}
function recover(detector: ReturnType<typeof createSurgeDetector>, members: number[], faction: number, nowMs: number) {
  return detector.observe(members.map((m) => row(m, faction, 'Okay')), { enemyId: ENEMY, ourId: OURS, config, nowMs })
}

describe('surge detection (#208)', () => {
  it('fires an enemy-side surge when N enemies become Okay within the window', () => {
    const d = createSurgeDetector()
    hospitalize(d, [1, 2, 3], ENEMY, 0)
    const fired = recover(d, [1, 2, 3], ENEMY, 1000)
    expect(fired).toEqual([{ direction: 'enemy', count: 3, windowSec: 60 }])
  })

  it('separates our-side from enemy-side', () => {
    const d = createSurgeDetector()
    hospitalize(d, [1, 2, 3], OURS, 0)
    const fired = recover(d, [1, 2, 3], OURS, 1000)
    expect(fired).toEqual([{ direction: 'our', count: 3, windowSec: 60 }])
  })

  it('does not fire below the threshold', () => {
    const d = createSurgeDetector()
    hospitalize(d, [1, 2], ENEMY, 0)
    expect(recover(d, [1, 2], ENEMY, 1000)) .toEqual([])
  })

  it('ignores recoveries that fall outside the rolling window', () => {
    const d = createSurgeDetector()
    hospitalize(d, [1, 2, 3], ENEMY, 0)
    recover(d, [1], ENEMY, 0)                 // t=0
    recover(d, [2], ENEMY, 30_000)            // t=30s
    const fired = recover(d, [3], ENEMY, 61_000) // t=61s — first recovery now aged out
    expect(fired).toEqual([])                 // only 2 within the trailing 60s
  })

  it('does not count a first sighting as a transition (no cold-start surge)', () => {
    const d = createSurgeDetector()
    // Seen for the very first time already Okay — must not fire.
    const fired = recover(d, [1, 2, 3, 4, 5], ENEMY, 0)
    expect(fired).toEqual([])
  })

  it('holds off re-firing during the cooldown, then fires again after it', () => {
    const d = createSurgeDetector()
    hospitalize(d, [1, 2, 3], ENEMY, 0)
    expect(recover(d, [1, 2, 3], ENEMY, 1000)).toHaveLength(1)

    // Another full surge 100s later — still inside the 300s cooldown.
    hospitalize(d, [1, 2, 3], ENEMY, 100_000)
    expect(recover(d, [1, 2, 3], ENEMY, 101_000)).toEqual([])

    // Past the cooldown it fires again.
    hospitalize(d, [1, 2, 3], ENEMY, 400_000)
    expect(recover(d, [1, 2, 3], ENEMY, 401_000)).toHaveLength(1)
  })

  it('is a no-op when disabled', () => {
    const d = createSurgeDetector()
    const off: SurgeConfig = { ...config, enabled: false }
    d.observe([1, 2, 3].map((m) => row(m, ENEMY, 'Hospital')), { enemyId: ENEMY, ourId: OURS, config: off, nowMs: 0 })
    const fired = d.observe([1, 2, 3].map((m) => row(m, ENEMY, 'Okay')), { enemyId: ENEMY, ourId: OURS, config: off, nowMs: 1000 })
    expect(fired).toEqual([])
  })

  it('does not treat a roster-leaver tombstone as a recovery', () => {
    const d = createSurgeDetector()
    hospitalize(d, [1, 2, 3], ENEMY, 0)
    // Two recover, one leaves the roster (tombstone) — only 2 real recoveries.
    recover(d, [1, 2], ENEMY, 500)
    const fired = d.observe([row(3, ENEMY, 'Okay', true)], { enemyId: ENEMY, ourId: OURS, config, nowMs: 1000 })
    expect(fired).toEqual([])
  })
})
