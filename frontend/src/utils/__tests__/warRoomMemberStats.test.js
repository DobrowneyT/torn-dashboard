// Live energy + cooldown display for our own members (#336).
import { describe, it, expect } from 'vitest'
import {
  OVERDOSE_DRUG_CD_SEC,
  indexMemberStats, remainingCooldown, formatCooldown,
  overdosedByDrugCooldown, formatEnergy, statsAgeSeconds, hasStatsError,
  memberStatSortValue, compareMemberStat,
  energyHue, energyBand, HUE_EMPTY, HUE_FULL_BAR, HUE_STACKED,
  cooldownHue, COOLDOWN_CEILING_SEC, HUE_READY, HUE_CAPPED,
} from '../warRoomMemberStats'
// The pre-existing hospital-status overdose flag (#199), imported here to pin
// the relationship between the two detectors rather than describe it in prose.
import { isOverdosed as statusOverdosed } from '../memberNotes'

const T0 = Date.parse('2026-08-08T12:00:00Z')
const at = (iso) => iso

describe('indexMemberStats', () => {
  it('indexes rows by member id as strings', () => {
    // Row ids arrive as numbers from the bigint column but member_id on the
    // roster rows is compared as a string all over the view.
    const idx = indexMemberStats([{ member_id: 1700, energy_current: 10 }])
    expect(idx['1700'].energy_current).toBe(10)
  })

  it('tolerates an empty or absent delta', () => {
    expect(indexMemberStats([])).toEqual({})
    expect(indexMemberStats()).toEqual({})
    expect(indexMemberStats([null, { energy_current: 1 }])).toEqual({})
  })
})

describe('remainingCooldown', () => {
  it('ages a stored reading down by the time since it was fetched', () => {
    // The core of the module: Torn gives seconds-at-fetch-time, not a
    // timestamp, so a stored 3600 is already stale when it renders.
    expect(remainingCooldown(3600, at('2026-08-08T11:55:00Z'), T0)).toBe(3300)
  })

  it('never goes negative once a cooldown has elapsed', () => {
    expect(remainingCooldown(60, at('2026-08-08T11:00:00Z'), T0)).toBe(0)
  })

  it('returns null when there is no reading at all', () => {
    // "Unknown" and "ready" must not render the same — a war lead reading
    // "Ready" off a member whose key failed would plan around a fiction.
    expect(remainingCooldown(null, at('2026-08-08T11:59:00Z'), T0)).toBeNull()
    expect(remainingCooldown(undefined, null, T0)).toBeNull()
  })

  it('falls back to the raw reading when fetched_at is unusable', () => {
    expect(remainingCooldown(900, null, T0)).toBe(900)
    expect(remainingCooldown(900, 'not-a-date', T0)).toBe(900)
  })
})

describe('formatCooldown', () => {
  it('distinguishes unknown from ready', () => {
    // The column is numeric and scanned vertically, so a ready cooldown reads
    // as 0 (#351) rather than the word "Ready", which was the widest value in
    // the column and broke the scan. The dash still means "no reading".
    expect(formatCooldown(null)).toBe('—')
    expect(formatCooldown(0)).toBe('0')
  })

  it('formats seconds, minutes and hours compactly', () => {
    expect(formatCooldown(45)).toBe('45s')
    expect(formatCooldown(600)).toBe('10m')
    expect(formatCooldown(3600)).toBe('1h')
    expect(formatCooldown(7500)).toBe('2h 5m')
  })
})

describe('overdosedByDrugCooldown', () => {
  it('flags a drug cooldown longer than any normal dose', () => {
    expect(OVERDOSE_DRUG_CD_SEC).toBe(36_000)
    expect(overdosedByDrugCooldown({ cooldown_drug: 40_000 })).toBe(true)
  })

  it('does not flag a normal xanax cooldown', () => {
    // A xanax leaves 6-8h; 10h is the unambiguous line.
    expect(overdosedByDrugCooldown({ cooldown_drug: 8 * 3600 })).toBe(false)
    expect(overdosedByDrugCooldown({ cooldown_drug: 36_000 })).toBe(false)
  })

  it('is false when there is no reading', () => {
    expect(overdosedByDrugCooldown(null)).toBe(false)
    expect(overdosedByDrugCooldown({})).toBe(false)
    expect(overdosedByDrugCooldown({ cooldown_drug: null })).toBe(false)
  })

  it('stays true off the SERVER LATCH as the cooldown burns down (#357)', () => {
    // The bug this replaces: the old test asserted the same thing against the
    // stored cooldown, which the sweep overwrites every pass — so a real
    // overdose lost its flag the moment it dropped under 10h, with nine hours
    // still to run. The expiry is recorded once and read back here.
    const stats = { cooldown_drug: 30_000, overdose_until: '2026-08-08T20:00:00+00' }
    expect(overdosedByDrugCooldown(stats, T0)).toBe(true)
  })

  it('goes false once the latched overdose has expired', () => {
    expect(overdosedByDrugCooldown(
      { cooldown_drug: 0, overdose_until: '2026-08-08T11:00:00+00' }, T0,
    )).toBe(false)
  })

  it('prefers the latch over the live reading in both directions', () => {
    // A high cooldown with an expired latch is a NEW normal dose, not a
    // lingering overdose; a low cooldown with a live latch is an overdose
    // still running. The latch wins either way.
    expect(overdosedByDrugCooldown(
      { cooldown_drug: 40_000, overdose_until: '2026-08-08T11:00:00+00' }, T0,
    )).toBe(false)
    expect(overdosedByDrugCooldown(
      { cooldown_drug: 100, overdose_until: '2026-08-08T22:00:00+00' }, T0,
    )).toBe(true)
  })

  it('falls back to the live test for rows written before the latch', () => {
    // Otherwise an overdose already in progress would blink off across the
    // deploy, which is the one moment a lead is most likely to notice.
    expect(overdosedByDrugCooldown({ cooldown_drug: 40_000 }, T0)).toBe(true)
    expect(overdosedByDrugCooldown({ cooldown_drug: 8 * 3600 }, T0)).toBe(false)
  })

  it('parses the bare Postgres offset on the latch', () => {
    // '-05' without minutes is rejected by Date.parse (#140). Falling through
    // to the live test here would quietly restore the old broken behaviour.
    expect(overdosedByDrugCooldown(
      { cooldown_drug: 0, overdose_until: '2026-08-08T18:00:00.000000-05' }, T0,
    )).toBe(true)
  })

  it('catches an overdose the hospital-status flag (#199) can no longer see', () => {
    // The two detectors cover different windows and this is the gap this one
    // exists to fill: released from hospital, so status_details no longer says
    // "Overdosed", but still sitting on a crippling drug cooldown.
    const released = { member_id: 1, status_state: 'Okay', status_details: '' }
    expect(statusOverdosed(released)).toBe(false)
    expect(overdosedByDrugCooldown({ cooldown_drug: 40_000 })).toBe(true)
  })
})

describe('formatEnergy', () => {
  it('renders current over maximum', () => {
    expect(formatEnergy({ energy_current: 87, energy_maximum: 150 })).toBe('87/150')
  })

  it('renders a dash when there is no reading', () => {
    expect(formatEnergy(null)).toBe('—')
    expect(formatEnergy({})).toBe('—')
  })

  it('renders 0 energy rather than treating it as missing', () => {
    // 0/150 is a real and tactically important state; a falsiness check here
    // would blank exactly the member you most need to see.
    expect(formatEnergy({ energy_current: 0, energy_maximum: 150 })).toBe('0/150')
  })

  it('does not turn a NULL reading into zero energy', () => {
    // The other half of the same distinction, and a live bug: the sweep writes
    // a row with null energy and a last_error when a member's key fails, and
    // Number(null) is 0 — so those members rendered as "0/150" and read as
    // empty rather than unasked.
    expect(formatEnergy({ energy_current: null, energy_maximum: 150 })).toBe('—')
    expect(formatEnergy({ energy_current: '', energy_maximum: 150 })).toBe('—')
  })
})

describe('energyHue (#351)', () => {
  const hue = (current, maximum = 150) => energyHue({ energy_current: current, energy_maximum: maximum })

  it('anchors the three reference points a war lead reads for', () => {
    // Empty is red, a FULL NATURAL BAR is amber, a fully stacked member is
    // green. Amber sits on the full bar rather than halfway up the range
    // because 150 is what you get for free — it means "has not stacked".
    expect(hue(0)).toBe(HUE_EMPTY)
    expect(hue(150)).toBe(HUE_FULL_BAR)
    expect(hue(1000)).toBe(HUE_STACKED)
  })

  it('separates a full bar from a stacked member', () => {
    // The bug this replaces: the old tone banded on current/maximum, so
    // 150/150 and 1000/150 both came out "high" — exactly the distinction
    // that decides whether the faction is ready to start a war.
    expect(hue(150)).not.toBe(hue(1000))
  })

  it('ramps red to amber across the natural bar', () => {
    // Mid-war, almost everyone lives in 0-150, so this stretch gets its own
    // full sweep instead of being squashed into the bottom 15% of one ramp.
    expect(hue(75)).toBeGreaterThan(hue(0))
    expect(hue(75)).toBeLessThan(hue(150))
  })

  it('ramps amber to green across the stack', () => {
    expect(hue(500)).toBeGreaterThan(hue(150))
    expect(hue(500)).toBeLessThan(hue(1000))
  })

  it('rises monotonically all the way up', () => {
    // Any dip would read as "this member has less energy" and mislead a push
    // call. Worth pinning across the piecewise join at 150.
    const points = [0, 25, 50, 100, 145, 150, 155, 200, 400, 700, 999, 1000]
    const hues = points.map((p) => hue(p))
    for (let i = 1; i < hues.length; i++) expect(hues[i]).toBeGreaterThanOrEqual(hues[i - 1])
  })

  it('clamps beyond the stack target rather than wrapping past green', () => {
    // Hue is circular: unclamped, 1500 would run past green into cyan/blue.
    expect(hue(1500)).toBe(HUE_STACKED)
    expect(hue(-5)).toBe(HUE_EMPTY)
  })

  it('uses the member reported maximum as the amber anchor', () => {
    // Donator//non-donator caps differ, so the "full bar" line is per member
    // rather than a hardcoded 150.
    expect(energyHue({ energy_current: 100, energy_maximum: 100 })).toBe(HUE_FULL_BAR)
  })

  it('falls back to the standard bar when maximum is missing or junk', () => {
    expect(energyHue({ energy_current: 150 })).toBe(HUE_FULL_BAR)
    expect(energyHue({ energy_current: 150, energy_maximum: 0 })).toBe(HUE_FULL_BAR)
  })

  it('returns null with no reading, so the cell can stay grey', () => {
    // A member we could not ask must never be coloured — red would read as
    // "this member is empty" and get them written off for the push.
    expect(energyHue(null)).toBeNull()
    expect(energyHue({})).toBeNull()
    expect(energyHue({ energy_current: null })).toBeNull()
  })

  it('returns a whole number so the inline style does not churn', () => {
    expect(Number.isInteger(hue(37))).toBe(true)
  })
})

describe('energyBand', () => {
  it('names the three states in words for the tooltip', () => {
    expect(energyBand({ energy_current: 0, energy_maximum: 150 })).toBe('empty')
    expect(energyBand({ energy_current: 90, energy_maximum: 150 })).toBe('regenerating')
    expect(energyBand({ energy_current: 150, energy_maximum: 150 })).toBe('full bar')
    expect(energyBand({ energy_current: 600, energy_maximum: 150 })).toBe('stacked')
  })

  it('is null when there is no reading', () => {
    expect(energyBand(null)).toBeNull()
  })
})

describe('statsAgeSeconds', () => {
  it('reports how stale a reading is', () => {
    // Our roster polls at a 30s floor while the enemy board runs at 1 Hz, so
    // the UI must be able to say "this is 40s old" rather than imply live.
    expect(statsAgeSeconds({ fetched_at: at('2026-08-08T11:59:20Z') }, T0)).toBe(40)
  })

  it('is null when never fetched', () => {
    expect(statsAgeSeconds({}, T0)).toBeNull()
    expect(statsAgeSeconds(null, T0)).toBeNull()
  })
})

describe('hasStatsError', () => {
  it('reports a failed key so the cell can say why it is blank', () => {
    expect(hasStatsError({ last_error: 'Incorrect key' })).toBe(true)
    expect(hasStatsError({ last_error: null })).toBe(false)
    expect(hasStatsError(null)).toBe(false)
  })
})

describe('memberStatSortValue', () => {
  it('sorts energy on the current value, not the fraction of maximum', () => {
    // "Who can throw the most hits right now" is a raw count question. A
    // 100/100 member is worth less to a chain than a 400/500 one.
    expect(memberStatSortValue('energy', { energy_current: 400, energy_maximum: 500 })).toBe(400)
    expect(memberStatSortValue('energy', { energy_current: 100, energy_maximum: 100 })).toBe(100)
  })

  it('sorts energy of zero as zero rather than unknown', () => {
    expect(memberStatSortValue('energy', { energy_current: 0 })).toBe(0)
  })

  it('sorts cooldowns on the AGED value, matching the cell', () => {
    // The sweep walks keys serially, so two members' readings were taken at
    // different moments. Comparing the raw stored seconds would rank a member
    // fetched 5 minutes ago against one fetched just now — the ordering would
    // disagree with the numbers on screen.
    const older = { cooldown_medical: 1000, fetched_at: at('2026-08-08T11:55:00Z') } // 700 left
    const newer = { cooldown_medical: 900, fetched_at: at('2026-08-08T12:00:00Z') }  // 900 left
    expect(memberStatSortValue('cooldown_medical', older, T0)).toBe(700)
    expect(memberStatSortValue('cooldown_medical', newer, T0)).toBe(900)
  })

  it('is null when there is no reading at all', () => {
    expect(memberStatSortValue('energy', null)).toBeNull()
    expect(memberStatSortValue('energy', {})).toBeNull()
    expect(memberStatSortValue('cooldown_drug', {}, T0)).toBeNull()
  })
})

describe('compareMemberStat', () => {
  const withEnergy = (n) => ({ energy_current: n, energy_maximum: 150 })
  const sortEnergy = (rows, dir) =>
    rows.slice().sort((a, b) => compareMemberStat('energy', a, b, dir, T0))
      .map((r) => r?.energy_current ?? 'none')

  it('orders ascending and descending', () => {
    const rows = [withEnergy(50), withEnergy(150), withEnergy(0)]
    expect(sortEnergy(rows, 1)).toEqual([0, 50, 150])
    expect(sortEnergy(rows, -1)).toEqual([150, 50, 0])
  })

  it('sinks members with no reading in BOTH directions', () => {
    // The crux (#351). "No reading" is not "zero energy" — sorting ascending
    // must surface the genuinely empty members, not the ones whose key failed
    // or who simply have not been swept yet. Both directions answer a question
    // about members we actually know something about.
    const rows = [withEnergy(50), null, withEnergy(150), {}]
    expect(sortEnergy(rows, 1)).toEqual([50, 150, 'none', 'none'])
    expect(sortEnergy(rows, -1)).toEqual([150, 50, 'none', 'none'])
  })

  it('ranks a ready cooldown above one still running, ascending', () => {
    // The scan this column exists for: who can act now.
    const ready = { cooldown_drug: 0, fetched_at: at('2026-08-08T12:00:00Z') }
    const busy = { cooldown_drug: 7200, fetched_at: at('2026-08-08T12:00:00Z') }
    expect(compareMemberStat('cooldown_drug', ready, busy, 1, T0)).toBeLessThan(0)
    expect(compareMemberStat('cooldown_drug', ready, busy, -1, T0)).toBeGreaterThan(0)
  })

  it('puts an overdosed member at the top when sorting drug CD descending', () => {
    // An overdose is a >10h cooldown, so it falls out of the ordering for free
    // — worth pinning, because "who is out of the fight" is the reason a lead
    // sorts this column at all.
    const od = { cooldown_drug: 40_000, fetched_at: at('2026-08-08T12:00:00Z') }
    const normal = { cooldown_drug: 7200, fetched_at: at('2026-08-08T12:00:00Z') }
    expect(compareMemberStat('cooldown_drug', od, normal, -1, T0)).toBeLessThan(0)
  })

  it('treats two unknowns as equal, leaving the prior order intact', () => {
    // Array.sort is stable, so returning 0 keeps whatever ordering the rows
    // already had rather than shuffling the unknown block on every poll.
    expect(compareMemberStat('energy', null, {}, 1, T0)).toBe(0)
  })
})

describe('cooldownHue (#356)', () => {
  it('is inverted from energy: green when ready, red at the ceiling', () => {
    // Low is good for a cooldown, high is good for energy.
    expect(HUE_READY).toBe(HUE_STACKED)
    expect(HUE_CAPPED).toBe(HUE_EMPTY)
    expect(cooldownHue('cooldown_drug', 0)).toBe(HUE_READY)
    expect(cooldownHue('cooldown_drug', COOLDOWN_CEILING_SEC.cooldown_drug)).toBe(HUE_CAPPED)
  })

  it('uses the ceilings leadership set', () => {
    expect(COOLDOWN_CEILING_SEC.cooldown_drug).toBe(8 * 3600)
    expect(COOLDOWN_CEILING_SEC.cooldown_medical).toBe(9 * 3600)
    expect(COOLDOWN_CEILING_SEC.cooldown_booster).toBe(48 * 3600)
  })

  it('puts the medical ceiling at the WARTIME maximum, not the usual one', () => {
    // 6h is normal, but war perks raise it to 9h — and wartime is when this
    // column is read. At a 6h ceiling every war-perk member would sit at flat
    // red for their last three hours, flattening exactly the window a lead is
    // scanning.
    expect(cooldownHue('cooldown_medical', 6 * 3600)).not.toBe(HUE_CAPPED)
    expect(cooldownHue('cooldown_medical', 9 * 3600)).toBe(HUE_CAPPED)
  })

  it('falls monotonically from ready to capped', () => {
    // Any rise would read as "more cooldown left" and mislead a push call.
    const points = [0, 60, 600, 1800, 3600, 7200, 14_400, 21_600, 28_800]
    const hues = points.map((p) => cooldownHue('cooldown_drug', p))
    for (let i = 1; i < hues.length; i++) expect(hues[i]).toBeLessThanOrEqual(hues[i - 1])
  })

  it('clamps past the ceiling instead of wrapping through red', () => {
    // Over-ceiling readings are NORMAL, not errors: an item that would push a
    // member past the cap applies anyway and they wait it out. Unclamped, hue
    // is circular and 2x the ceiling would come out magenta.
    expect(cooldownHue('cooldown_medical', 20 * 3600)).toBe(HUE_CAPPED)
    expect(cooldownHue('cooldown_booster', 100 * 3600)).toBe(HUE_CAPPED)
    expect(cooldownHue('cooldown_drug', -50)).toBe(HUE_READY)
  })

  it('scales each column against its own ceiling', () => {
    // 8h is the whole drug range but a sixth of the booster one, so the same
    // number of seconds must not look the same in both columns.
    const eightHours = 8 * 3600
    expect(cooldownHue('cooldown_drug', eightHours)).toBe(HUE_CAPPED)
    expect(cooldownHue('cooldown_booster', eightHours)).toBeGreaterThan(HUE_CAPPED)
  })

  it('returns null with no reading, so the cell can stay grey', () => {
    // A member whose key failed must never read as "ready".
    expect(cooldownHue('cooldown_drug', null)).toBeNull()
    expect(cooldownHue('cooldown_drug', undefined)).toBeNull()
    expect(cooldownHue('cooldown_drug', '')).toBeNull()
  })

  it('returns null for a column with no ceiling on file', () => {
    expect(cooldownHue('cooldown_mystery', 100)).toBeNull()
  })

  it('returns whole numbers so the inline style does not churn', () => {
    expect(Number.isInteger(cooldownHue('cooldown_medical', 1234))).toBe(true)
  })
})

// ── Timestamps in the shape the API really serves (#140) ─────────────────────
//
// Same trap that stopped #330 rendering: Postgres timestamptz arrives as text
// with a BARE two-digit offset, which is not valid ISO 8601, so Date.parse
// returns NaN. Here it did not blank the column — it silently disabled the
// ageing, so a cooldown sat at whatever value it had when last fetched and
// never counted down, and the staleness label never appeared at all. A wrong
// number that looks live is worse than a visibly missing one.
describe('bare-offset timestamps from the API', () => {
  const WIRE = '2026-08-12T15:30:28.041124+00'
  const fetchedMs = Date.UTC(2026, 7, 12, 15, 30, 28, 41)

  it('Date.parse cannot read it — the precondition this all rests on', () => {
    expect(Number.isNaN(Date.parse(WIRE))).toBe(true)
  })

  it('ages a cooldown against a bare-offset fetch time', () => {
    // 600s left when read, 100s ago → 500s left now.
    expect(remainingCooldown(600, WIRE, fetchedMs + 100_000)).toBe(500)
  })

  it('does not fall back to the unaged reading', () => {
    // The exact production symptom: the raw stored value, frozen.
    expect(remainingCooldown(600, WIRE, fetchedMs + 100_000)).not.toBe(600)
  })

  it('reports staleness instead of null', () => {
    expect(statsAgeSeconds({ fetched_at: WIRE }, fetchedMs + 90_000)).toBe(90)
  })

  it('still returns null when there is genuinely no fetch time', () => {
    expect(statsAgeSeconds({ fetched_at: null }, fetchedMs)).toBeNull()
    expect(statsAgeSeconds({}, fetchedMs)).toBeNull()
  })

  it('still shows the raw reading when the timestamp is unparseable junk', () => {
    // The documented fallback stays: better a slightly stale number than a
    // blank column. It just must not be reached by ordinary API data.
    expect(remainingCooldown(600, 'not-a-date', fetchedMs)).toBe(600)
  })
})
