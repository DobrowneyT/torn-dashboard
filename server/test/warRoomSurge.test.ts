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
// Online by default: a status surge now requires it (#367), so the existing
// cases describe members who are actually at the keyboard.
function row(member: number, faction: number, state: string, deleted = false, activity = 'Online') {
  return {
    member_id: member,
    faction_id: faction,
    deleted_at: deleted ? new Date() : null,
    state: { status: { state }, last_action: { status: activity } },
  }
}

/**
 * A row for the revive detector. The status stays put at Hospital across calls
 * on purpose: a revive flag that flips while the status ALSO moves is a side
 * effect of the status change, not somebody toggling the setting (#367).
 */
function reviveRow(member: number, faction: number, revivable: boolean, deleted = false, state = 'Hospital') {
  return {
    member_id: member,
    faction_id: faction,
    deleted_at: deleted ? new Date() : null,
    state: { status: { state }, last_action: { status: 'Online' }, is_revivable: revivable },
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

describe('the online gate on status surges (#367)', () => {
  const offline = (m: number) => row(m, ENEMY, 'Okay', false, 'Offline')
  const idle = (m: number) => row(m, ENEMY, 'Okay', false, 'Idle')

  function seedHospital(d: Detector, members: number[], nowMs = 0) {
    d.observe(members.map((m) => row(m, ENEMY, 'Hospital')), { enemyId: ENEMY, ourId: OURS, config: statusOnly, nowMs })
  }

  it('ignores members whose hospital timer simply expired while they were offline', () => {
    // The reported bug: while WE farm a faction, batches drop out of hospital
    // every few minutes with nobody at the keyboard, and that fired "incoming
    // push!" at the lead who was doing the pushing.
    const d = createSurgeDetector()
    seedHospital(d, [1, 2, 3, 4])
    expect(d.observe([1, 2, 3, 4].map(offline), { enemyId: ENEMY, ourId: OURS, config: statusOnly, nowMs: 1000 }))
      .toEqual([])
  })

  it('ignores idle members too', () => {
    // Idle is "logged in a while ago", not "at the keyboard". Counting it
    // would put most of the farming noise straight back.
    const d = createSurgeDetector()
    seedHospital(d, [1, 2, 3])
    expect(d.observe([1, 2, 3].map(idle), { enemyId: ENEMY, ourId: OURS, config: statusOnly, nowMs: 1000 }))
      .toEqual([])
  })

  it('still fires for members who are online when they come out', () => {
    const d = createSurgeDetector()
    seedHospital(d, [1, 2, 3])
    expect(recover(d, [1, 2, 3], ENEMY, 1000)).toHaveLength(1)
  })

  it('counts only the online ones out of a mixed batch', () => {
    // Two real, two timing out — below the threshold of three, so silence.
    const d = createSurgeDetector()
    seedHospital(d, [1, 2, 3, 4])
    const mixed = [row(1, ENEMY, 'Okay'), row(2, ENEMY, 'Okay'), offline(3), offline(4)]
    expect(d.observe(mixed, { enemyId: ENEMY, ourId: OURS, config: statusOnly, nowMs: 1000 })).toEqual([])
  })

  it('does not count a member who was already online and merely re-reported', () => {
    const d = createSurgeDetector()
    seedHospital(d, [1, 2, 3])
    expect(recover(d, [1, 2, 3], ENEMY, 1000)).toHaveLength(1)
    // Same three, still Okay and online, on the next poll — no new transitions.
    expect(recover(d, [1, 2, 3], ENEMY, 400_000)).toEqual([])
  })

  it('ignores a row with no activity rather than assuming online', () => {
    // Absent is not Online. Assuming it would reopen the farming false alarm
    // for any payload shape that omits last_action.
    const d = createSurgeDetector()
    const bare = (m: number) => ({ member_id: m, faction_id: ENEMY, deleted_at: null, state: { status: { state: 'Okay' } } })
    d.observe([1, 2, 3].map((m) => row(m, ENEMY, 'Hospital')), { enemyId: ENEMY, ourId: OURS, config: statusOnly, nowMs: 0 })
    expect(d.observe([1, 2, 3].map(bare), { enemyId: ENEMY, ourId: OURS, config: statusOnly, nowMs: 1000 })).toEqual([])
  })
})

describe('the passive-flip gate on revive surges (#367)', () => {
  it('ignores revives that turn on because the member entered hospital', () => {
    // `is_revivable` means "a revive is possible right now", and a revive is
    // only possible in hospital — so the flag flips true the moment someone
    // with revives already on gets hospitalised. While we farm them, that is
    // every target we put down.
    const d = createSurgeDetector()
    const healthy = (m: number) => reviveRow(m, ENEMY, false, false, 'Okay')
    const downed = (m: number) => reviveRow(m, ENEMY, true, false, 'Hospital')

    d.observe([1, 2, 3, 4].map(healthy), { enemyId: ENEMY, ourId: OURS, config: reviveOnly, nowMs: 0 })
    expect(d.observe([1, 2, 3, 4].map(downed), { enemyId: ENEMY, ourId: OURS, config: reviveOnly, nowMs: 1000 }))
      .toEqual([])
  })

  it('still fires when revives come on with the status holding still', () => {
    // Nothing else about them changed, so somebody reached for the setting —
    // which is the whole signal this alert is built on.
    const d = createSurgeDetector()
    revivesOff(d, [1, 2, 3], ENEMY, 0)
    expect(revivesOn(d, [1, 2, 3], ENEMY, 1000)).toHaveLength(1)
  })

  it('fires for healthy members turning revives on, if Torn reports that', () => {
    // We do not know whether a healthy member can read as revivable. The gate
    // is written so the alert works either way: what it rejects is a
    // SIMULTANEOUS status change, not a particular status.
    const d = createSurgeDetector()
    const healthyOff = (m: number) => reviveRow(m, ENEMY, false, false, 'Okay')
    const healthyOn = (m: number) => reviveRow(m, ENEMY, true, false, 'Okay')
    d.observe([1, 2, 3].map(healthyOff), { enemyId: ENEMY, ourId: OURS, config: reviveOnly, nowMs: 0 })
    expect(d.observe([1, 2, 3].map(healthyOn), { enemyId: ENEMY, ourId: OURS, config: reviveOnly, nowMs: 1000 }))
      .toHaveLength(1)
  })

  it('counts a first-seen status as no change, so a new member can still be counted', () => {
    // prevStatus is undefined on first sighting; that must not read as "the
    // status changed" and suppress a genuine toggle on the next poll.
    const d = createSurgeDetector()
    revivesOff(d, [1, 2, 3], ENEMY, 0)
    expect(revivesOn(d, [1, 2, 3], ENEMY, 1000)).toHaveLength(1)
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
  it('tracks both kinds independently', () => {
    const d = createSurgeDetector()
    // Seed: hospitalised, revives off.
    d.observe([1, 2, 3].map((m) => reviveRow(m, ENEMY, false)), { enemyId: ENEMY, ourId: OURS, config, nowMs: 0 })
    // They turn revives on while still in hospital — a revive surge.
    const first = d.observe([1, 2, 3].map((m) => reviveRow(m, ENEMY, true)), { enemyId: ENEMY, ourId: OURS, config, nowMs: 1000 })
    expect(first.map((e) => e.kind)).toEqual(['revive'])
    // Later they come out, online — a status surge.
    const second = d.observe([1, 2, 3].map((m) => row(m, ENEMY, 'Okay')), { enemyId: ENEMY, ourId: OURS, config, nowMs: 2000 })
    expect(second.map((e) => e.kind)).toEqual(['status'])
  })

  it('stays silent through a farming run, which fired both alerts before #367', () => {
    // The reported bug, end to end. We are farming them: targets get
    // hospitalised (flipping is_revivable true for anyone with revives on),
    // then their timers expire while they are offline. Neither is a push, and
    // neither should say a word to the faction doing the farming.
    const d = createSurgeDetector()
    const okayOffline = (m: number) => row(m, ENEMY, 'Okay', false, 'Offline')
    const hospitalRevivable = (m: number) => reviveRow(m, ENEMY, true)

    d.observe([1, 2, 3, 4].map(okayOffline), { enemyId: ENEMY, ourId: OURS, config, nowMs: 0 })
    // We put them in hospital; revives were already on, so the flag flips.
    expect(d.observe([1, 2, 3, 4].map(hospitalRevivable), { enemyId: ENEMY, ourId: OURS, config, nowMs: 1000 })).toEqual([])
    // Their timers run out while they are still offline.
    expect(d.observe([1, 2, 3, 4].map(okayOffline), { enemyId: ENEMY, ourId: OURS, config, nowMs: 600_000 })).toEqual([])
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
