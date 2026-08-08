// PUSH-surge detection (#208, extended #359): rate-based, per-kind,
// per-direction, cooldown-gated.
import { describe, it, expect } from 'vitest'
import { createSurgeDetector, type SurgeConfig } from '../src/warRoomSurge.js'

const ENEMY = 111
const OURS = 222

const config: SurgeConfig = {
  status: {
    enabled: true,
    enemy: { threshold: 3, windowSec: 60 },
    our: { threshold: 3, windowSec: 60 },
    cooldownSec: 300,
  },
  revive: {
    enabled: true,
    enemy: { threshold: 3, windowSec: 300 },
    our: { threshold: 3, windowSec: 300 },
    cooldownSec: 600,
  },
}

// Only the status detector on, so the two kinds can be exercised in isolation.
const statusOnly: SurgeConfig = { ...config, revive: { ...config.revive, enabled: false } }
const reviveOnly: SurgeConfig = { ...config, status: { ...config.status, enabled: false } }

// Build a changed-row where `member` transitions to `state` on `faction`.
function row(member: number, faction: number, state: string, deleted = false) {
  return {
    member_id: member,
    faction_id: faction,
    deleted_at: deleted ? new Date() : null,
    state: { status: { state } },
  }
}

/** A row carrying only the revive flag — the status half is deliberately absent. */
function reviveRow(member: number, faction: number, revivable: boolean, deleted = false) {
  return {
    member_id: member,
    faction_id: faction,
    deleted_at: deleted ? new Date() : null,
    state: { status: { state: 'Hospital' }, is_revivable: revivable },
  }
}

type Detector = ReturnType<typeof createSurgeDetector>

// Seed a member as hospitalised (first sighting seeds silently), then flip Okay.
function hospitalize(detector: Detector, members: number[], faction: number, nowMs: number, cfg = statusOnly) {
  detector.observe(members.map((m) => row(m, faction, 'Hospital')), { enemyId: ENEMY, ourId: OURS, config: cfg, nowMs })
}
function recover(detector: Detector, members: number[], faction: number, nowMs: number, cfg = statusOnly) {
  return detector.observe(members.map((m) => row(m, faction, 'Okay')), { enemyId: ENEMY, ourId: OURS, config: cfg, nowMs })
}

// Same shape for revives: seed with revives off, then flip them on.
function revivesOff(detector: Detector, members: number[], faction: number, nowMs: number, cfg = reviveOnly) {
  return detector.observe(members.map((m) => reviveRow(m, faction, false)), { enemyId: ENEMY, ourId: OURS, config: cfg, nowMs })
}
function revivesOn(detector: Detector, members: number[], faction: number, nowMs: number, cfg = reviveOnly) {
  return detector.observe(members.map((m) => reviveRow(m, faction, true)), { enemyId: ENEMY, ourId: OURS, config: cfg, nowMs })
}

describe('status surge detection (#208)', () => {
  it('fires an enemy-side surge when N enemies become Okay within the window', () => {
    const d = createSurgeDetector()
    hospitalize(d, [1, 2, 3], ENEMY, 0)
    const fired = recover(d, [1, 2, 3], ENEMY, 1000)
    expect(fired).toEqual([{ kind: 'status', direction: 'enemy', count: 3, windowSec: 60 }])
  })

  it('separates our-side from enemy-side', () => {
    const d = createSurgeDetector()
    hospitalize(d, [1, 2, 3], OURS, 0)
    const fired = recover(d, [1, 2, 3], OURS, 1000)
    expect(fired).toEqual([{ kind: 'status', direction: 'our', count: 3, windowSec: 60 }])
  })

  it('does not fire below the threshold', () => {
    const d = createSurgeDetector()
    hospitalize(d, [1, 2], ENEMY, 0)
    expect(recover(d, [1, 2], ENEMY, 1000)).toEqual([])
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
    const off: SurgeConfig = {
      status: { ...config.status, enabled: false },
      revive: { ...config.revive, enabled: false },
    }
    d.observe([1, 2, 3].map((m) => row(m, ENEMY, 'Hospital')), { enemyId: ENEMY, ourId: OURS, config: off, nowMs: 0 })
    const fired = d.observe([1, 2, 3].map((m) => row(m, ENEMY, 'Okay')), { enemyId: ENEMY, ourId: OURS, config: off, nowMs: 1000 })
    expect(fired).toEqual([])
  })

  it('does not treat a roster-leaver tombstone as a recovery', () => {
    const d = createSurgeDetector()
    hospitalize(d, [1, 2, 3], ENEMY, 0)
    // Two recover, one leaves the roster (tombstone) — only 2 real recoveries.
    recover(d, [1, 2], ENEMY, 500)
    const fired = d.observe([row(3, ENEMY, 'Okay', true)], { enemyId: ENEMY, ourId: OURS, config: statusOnly, nowMs: 1000 })
    expect(fired).toEqual([])
  })
})

describe('revive surge detection (#359)', () => {
  it('fires when N enemies turn their revives on within the window', () => {
    // The point of the alert: this is the push being SET UP, before anyone is
    // back on their feet.
    const d = createSurgeDetector()
    revivesOff(d, [1, 2, 3], ENEMY, 0)
    expect(revivesOn(d, [1, 2, 3], ENEMY, 1000))
      .toEqual([{ kind: 'revive', direction: 'enemy', count: 3, windowSec: 300 }])
  })

  it('fires on our own side too', () => {
    const d = createSurgeDetector()
    revivesOff(d, [1, 2, 3], OURS, 0)
    expect(revivesOn(d, [1, 2, 3], OURS, 1000))
      .toEqual([{ kind: 'revive', direction: 'our', count: 3, windowSec: 300 }])
  })

  it('only counts the off→on edge, not members who were already revivable', () => {
    // A member sitting revivable across many ticks must be counted once, at
    // the moment they switched — otherwise the roster poll would re-count the
    // whole revivable population on every pass and fire constantly.
    const d = createSurgeDetector()
    revivesOff(d, [1, 2, 3], ENEMY, 0)
    expect(revivesOn(d, [1, 2], ENEMY, 1000)).toEqual([])
    // Re-reporting the same two as still revivable adds nothing.
    expect(revivesOn(d, [1, 2], ENEMY, 2000)).toEqual([])
    // The third one crossing the edge is what tips it over.
    expect(revivesOn(d, [3], ENEMY, 3000)).toHaveLength(1)
  })

  it('does not count a first sighting as turning revives on', () => {
    // Same cold-start discipline as the status detector: a process restart
    // re-reads the whole roster in one tick, and every already-revivable
    // member would otherwise look like a simultaneous surge.
    const d = createSurgeDetector()
    expect(revivesOn(d, [1, 2, 3, 4, 5], ENEMY, 0)).toEqual([])
  })

  it('does not fire when revives are turned OFF', () => {
    const d = createSurgeDetector()
    revivesOn(d, [1, 2, 3], ENEMY, 0)
    expect(revivesOff(d, [1, 2, 3], ENEMY, 1000)).toEqual([])
  })

  it('honours its own longer window, independent of the status one', () => {
    const d = createSurgeDetector()
    revivesOff(d, [1, 2, 3], ENEMY, 0)
    revivesOn(d, [1], ENEMY, 0)
    revivesOn(d, [2], ENEMY, 90_000)          // t=90s — past the 60s STATUS window
    // Still inside the 300s revive window, so all three count.
    expect(revivesOn(d, [3], ENEMY, 120_000)).toHaveLength(1)
  })

  it('holds off re-firing during its own longer cooldown', () => {
    const d = createSurgeDetector()
    revivesOff(d, [1, 2, 3], ENEMY, 0)
    expect(revivesOn(d, [1, 2, 3], ENEMY, 1000)).toHaveLength(1)

    // A second surge 400s later — past the STATUS cooldown (300s) but still
    // inside the revive one (600s). This is the assertion that the two kinds
    // do not share a cooldown.
    revivesOff(d, [1, 2, 3], ENEMY, 400_000)
    expect(revivesOn(d, [1, 2, 3], ENEMY, 401_000)).toEqual([])

    // Far enough out that the muted surge above has also aged out of the 300s
    // window. Note what happens otherwise: a surge suppressed by the cooldown
    // is NOT discarded, so it fires the moment the cooldown lifts if it is
    // still inside the window. That is intended — the surge was real, we only
    // muted it — but it makes the timings here load-bearing.
    revivesOff(d, [1, 2, 3], ENEMY, 750_000)
    expect(revivesOn(d, [1, 2, 3], ENEMY, 751_000)).toHaveLength(1)
  })

  it('fires a cooldown-suppressed surge as soon as the cooldown lifts', () => {
    // Pinning the behaviour the test above works around, so it is a decision
    // on record rather than an accident of the window filter.
    const d = createSurgeDetector()
    revivesOff(d, [1, 2, 3], ENEMY, 0)
    expect(revivesOn(d, [1, 2, 3], ENEMY, 1000)).toHaveLength(1)   // cooldown → 601s

    revivesOff(d, [1, 2, 3], ENEMY, 500_000)
    expect(revivesOn(d, [1, 2, 3], ENEMY, 501_000)).toEqual([])    // suppressed, still counted

    // Nothing new happens here — the same three are simply re-reported — but
    // the cooldown has lifted and their transitions are still in the window.
    expect(revivesOn(d, [1, 2, 3], ENEMY, 610_000)).toHaveLength(1)
  })

  it('forgets a roster leaver so a rejoin re-seeds rather than firing', () => {
    const d = createSurgeDetector()
    revivesOff(d, [1, 2, 3], ENEMY, 0)
    d.observe([reviveRow(3, ENEMY, false, true)], { enemyId: ENEMY, ourId: OURS, config: reviveOnly, nowMs: 500 })
    revivesOn(d, [1, 2], ENEMY, 1000)
    // 3 rejoins already revivable: a first sighting, so it seeds silently.
    expect(revivesOn(d, [3], ENEMY, 1500)).toEqual([])
  })

  it('ignores a row with no revive flag rather than reading it as false', () => {
    // Absent is not false. Seeding a missing field as false would make the
    // flag's first real appearance look like the member just enabled it.
    const d = createSurgeDetector()
    const bare = (m: number) => ({ member_id: m, faction_id: ENEMY, deleted_at: null, state: { status: { state: 'Hospital' } } })
    d.observe([1, 2, 3].map(bare), { enemyId: ENEMY, ourId: OURS, config: reviveOnly, nowMs: 0 })
    expect(revivesOn(d, [1, 2, 3], ENEMY, 1000)).toEqual([])
  })

  it('is a no-op when only the status detector is enabled', () => {
    const d = createSurgeDetector()
    revivesOff(d, [1, 2, 3], ENEMY, 0, statusOnly)
    expect(revivesOn(d, [1, 2, 3], ENEMY, 1000, statusOnly)).toEqual([])
  })
})

describe('the two detectors together', () => {
  it('tracks both kinds independently in one tick', () => {
    const d = createSurgeDetector()
    // Seed everyone hospitalised with revives off.
    d.observe([1, 2, 3].map((m) => reviveRow(m, ENEMY, false)), { enemyId: ENEMY, ourId: OURS, config, nowMs: 0 })
    // Now they all become Okay AND revivable in the same tick.
    const fired = d.observe(
      [1, 2, 3].map((m) => ({ member_id: m, faction_id: ENEMY, deleted_at: null, state: { status: { state: 'Okay' }, is_revivable: true } })),
      { enemyId: ENEMY, ourId: OURS, config, nowMs: 1000 }
    )
    expect(fired.map((e) => e.kind).sort()).toEqual(['revive', 'status'])
  })

  it('does not accumulate history for a kind while it is switched off', () => {
    // Switching a detector on must start from a clean slate. Counting
    // transitions observed while it was disabled would fire an alert about
    // something that happened before anyone asked to be told.
    const d = createSurgeDetector()
    revivesOff(d, [1, 2, 3], ENEMY, 0, statusOnly)
    revivesOn(d, [1, 2, 3], ENEMY, 1000, statusOnly)
    // Turn revives on and re-report the same already-revivable members.
    expect(revivesOn(d, [1, 2, 3], ENEMY, 2000, reviveOnly)).toEqual([])
  })
})
