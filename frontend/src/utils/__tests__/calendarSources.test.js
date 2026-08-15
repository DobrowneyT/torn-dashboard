// #395 — the calendar's adapters.
//
// Four wire formats land in this file and every one of them has a way of
// failing silently: a bare '+00' offset that parses to NaN, an epoch in the
// wrong unit, a DATE read in local time, and a Feb 29 recurrence that rolls
// into March. None of those look like failures on screen — they look like
// dates. That is what these tests are for.
import { describe, expect, it } from 'vitest'
import {
  fromWars, fromWarPayouts, fromCompetitions, fromPayoutWeeks,
  fromEvents, fromBirthdays, fromAnniversaries, parseSignup, fromSteadfast,
  steadfastLabel, layoutWeek,
  aggregate, byDay, upcoming, monthGrid, utcDate, dayKey, EVENT_KINDS,
} from '../calendarSources'

const AUG = { from: new Date(Date.UTC(2026, 7, 1)), to: new Date(Date.UTC(2026, 7, 31)) }

describe('fromWars (epoch seconds)', () => {
  it('reads epoch seconds, not milliseconds', () => {
    const [e] = fromWars([{ id: 9, start_at: 1_754_000_000, end_at: 1_754_400_000, opponent_name: 'Bad Company' }])
    expect(e.startsAt.getTime()).toBe(1_754_000_000_000)
    expect(e.endsAt.getTime()).toBe(1_754_400_000_000)
    expect(e.title).toBe('Ranked war vs Bad Company')
    expect(e.kind).toBe('war')
  })

  it('marks a war with no recorded end as still running, not instantaneous', () => {
    // ⚠️ Everywhere else here a null end means a point in time. For a war it
    // means the opposite — it has not finished — and the two must not be the
    // same flag, or the war you are IN gets clipped out of the window.
    const [e] = fromWars([{ id: 9, start_at: 1_754_000_000, end_at: null, opponent_name: 'X' }])
    expect(e.endsAt).toBeNull()
    expect(e.open).toBe(true)

    const finished = fromWars([{ id: 9, start_at: 1_754_000_000, end_at: 1_754_400_000 }])[0]
    expect(finished.open).toBe(false)
  })

  it('names an unresolved opponent by id rather than inventing one', () => {
    const [e] = fromWars([{ id: 9, start_at: 1_754_000_000, opponent_id: 4242, opponent_name: null }])
    expect(e.title).toContain('#4242')
  })

  it('drops a war with no start rather than placing it at the epoch', () => {
    expect(fromWars([{ id: 9, start_at: null }])).toEqual([])
    expect(fromWars([{ id: 9, start_at: 0 }])).toEqual([])
  })
})

describe('fromCompetitions (timestamptz with a bare offset)', () => {
  it('⚠️ parses the bare "+00" offset Postgres actually sends', () => {
    // The #140 trap. `new Date` on this string returns NaN, silently.
    const wire = '2026-08-12T15:30:28.041124+00'
    expect(Number.isNaN(Date.parse(wire))).toBe(true)
    const [e] = fromCompetitions([{ id: 3, name: 'Gym Grind', window_start: wire, window_end: null }])
    expect(e.startsAt.getTime()).toBe(Date.UTC(2026, 7, 12, 15, 30, 28, 41))
  })

  it('excludes a rolling competition with no window', () => {
    // A competition with no boundaries is genuinely not a dated thing. Pinning
    // it to today would put a permanent fixture in every month.
    expect(fromCompetitions([{ id: 3, name: 'Rolling 7d', window_start: null }])).toEqual([])
  })
})

describe('fromPayoutWeeks (DATE)', () => {
  it('⚠️ marks the day the money moves, not the week it covers', () => {
    // The week 3–9 August pays on the 10th. A seven-day bar says "this is
    // happening all week" when the only date anyone needs is payday.
    const [e] = fromPayoutWeeks([{ id: 1, week_start: '2026-08-03', week_end: '2026-08-09' }])
    expect(e.startsAt.toISOString()).toBe('2026-08-10T00:00:00.000Z')
    expect(e.endsAt).toBeNull()
    expect(e.allDay).toBe(true)
    expect(e.title).toBe('OC Payout')
    // The week it covers is still readable, just not occupying seven cells.
    expect(e.note).toBe('for 2026-08-03 – 2026-08-09')
  })

  it('⚠️ derives payday from week_end + 1, not from "the next Monday"', () => {
    // Both rules agree on a Mon–Sun week and disagree the moment a faction
    // runs one that is not. week_end + 1 is the actual rule.
    const [midweek] = fromPayoutWeeks([{ id: 2, week_start: '2026-08-05', week_end: '2026-08-11' }])
    expect(dayKey(midweek.startsAt)).toBe('2026-08-12') // a Wednesday
  })

  it('reads the DATE as UTC midnight, not local midnight', () => {
    const [e] = fromPayoutWeeks([{ id: 1, week_start: '2026-08-03', week_end: '2026-08-09' }])
    expect(e.startsAt.getUTCHours()).toBe(0)
  })

  it('links to the week so the payouts page can open its modal', () => {
    const [e] = fromPayoutWeeks([{ id: 42, week_start: '2026-08-03', week_end: '2026-08-09' }])
    expect(e.href).toBe('/oc/payouts?week=42')
  })
})

describe('fromWarPayouts', () => {
  const war = (over = {}) => ({
    id: 9, start_at: Math.floor(Date.UTC(2026, 7, 5) / 1000), end_at: Math.floor(Date.UTC(2026, 7, 8, 14) / 1000),
    opponent_name: 'Bad Company', payout_id: 77, ...over,
  })

  it('puts a payout marker on the war\'s last day, linked to the payout', () => {
    const [e] = fromWarPayouts([war()])
    expect(dayKey(e.startsAt)).toBe('2026-08-08')
    expect(e.allDay).toBe(true)
    expect(e.kind).toBe('payout')
    expect(e.title).toBe('RW Payout — Bad Company')
    expect(e.href).toBe('/rw/payouts?payout=77')
  })

  it('⚠️ emits nothing for a war with no payout saved yet', () => {
    // A "RW Payout" flag on every finished war is a link to nothing until
    // leadership pays it out, and one dead link teaches people to stop
    // trusting the ones that work.
    expect(fromWarPayouts([war({ payout_id: null })])).toEqual([])
  })

  it('emits nothing for a war still running', () => {
    expect(fromWarPayouts([war({ end_at: null })])).toEqual([])
  })
})

describe('fromEvents', () => {
  const christmas = {
    id: 4, source: 'torn_event', title: 'Christmas Town', note: 'Runs to the 31st',
    starts_at: '2024-12-01T00:00:00+00', ends_at: '2024-12-31T23:59:00+00', recurrence: 'yearly',
  }

  it('marks typed-in entries editable — and only those', () => {
    const [e] = fromEvents([{ id: 1, source: 'manual', title: 'Chain night', starts_at: '2026-08-14T20:00:00+00', recurrence: 'none' }])
    expect(e.editable).toBe(true)
    expect(e.kind).toBe('faction')
    // ⚠️ Nothing derived is editable. A delete control on an aggregated war
    // either does nothing or deletes the war.
    expect(fromWars([{ id: 1, start_at: 1_754_000_000 }])[0].editable).toBeUndefined()
  })

  it('separates a Torn event from a faction one', () => {
    const [e] = fromEvents([christmas], { from: new Date(Date.UTC(2026, 11, 1)), to: new Date(Date.UTC(2026, 11, 31)) })
    expect(e.kind).toBe('torn')
    expect(e.source).toBe('torn_event')
  })

  it('recurs a yearly event into the displayed year, keeping its length', () => {
    const [e] = fromEvents([christmas], { from: new Date(Date.UTC(2026, 11, 1)), to: new Date(Date.UTC(2026, 11, 31)) })
    expect(e.startsAt.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(e.endsAt.toISOString()).toBe('2026-12-31T23:59:00.000Z')
    expect(e.recurring).toBe(true)
  })

  it('gives each year its own id, so a grid does not collide two occurrences', () => {
    const wide = fromEvents([christmas], { from: new Date(Date.UTC(2026, 0, 1)), to: new Date(Date.UTC(2027, 11, 31)) })
    expect(new Set(wide.map((e) => e.id)).size).toBe(wide.length)
    expect(wide).toHaveLength(2)
  })

  it('⚠️ clamps a Feb 29 recurrence instead of rolling it into March', () => {
    // Date.UTC(2027, 1, 29) is silently 2027-03-01. A yearly event drifting
    // into the wrong MONTH is worse than showing it a day early.
    const leap = { id: 5, source: 'torn_event', title: 'Leap thing', starts_at: '2024-02-29T12:00:00+00', recurrence: 'yearly' }
    const [e] = fromEvents([leap], { from: new Date(Date.UTC(2027, 0, 1)), to: new Date(Date.UTC(2027, 11, 31)) })
    expect(e.startsAt.toISOString()).toBe('2027-02-28T12:00:00.000Z')
  })

  it('keeps a one-off exactly where it was entered', () => {
    const [e] = fromEvents(
      [{ id: 6, source: 'manual', title: 'Roll call', starts_at: '2026-08-14T20:00:00+00', recurrence: 'none' }],
      { from: new Date(Date.UTC(2027, 0, 1)), to: new Date(Date.UTC(2027, 11, 31)) }
    )
    expect(e.startsAt.getUTCFullYear()).toBe(2026)
  })
})

describe('fromBirthdays', () => {
  it('places a month/day birthday in the displayed year', () => {
    const [e] = fromBirthdays([{ member_id: '1', member_name: 'MonChoon', birth_month: 8, birth_day: 14 }], AUG)
    expect(e.startsAt.toISOString()).toBe('2026-08-14T00:00:00.000Z')
    expect(e.kind).toBe('personal')
    expect(e.allDay).toBe(true)
  })

  it('mentions an age only when the member chose to give a year', () => {
    // Month/day are what the faction uses. The year is optional and separate
    // precisely so we are not holding a full DOB nobody needs.
    const withYear = fromBirthdays([{ member_id: '1', member_name: 'A', birth_month: 8, birth_day: 14, birth_year: 1990 }], AUG)
    expect(withYear[0].note).toBe('Turning 36')
    const without = fromBirthdays([{ member_id: '2', member_name: 'B', birth_month: 8, birth_day: 14 }], AUG)
    expect(without[0].note).toBeNull()
  })

  it('clamps Feb 29 to the 28th in a non-leap year', () => {
    const [e] = fromBirthdays([{ member_id: '1', member_name: 'A', birth_month: 2, birth_day: 29 }], {
      from: new Date(Date.UTC(2027, 0, 1)), to: new Date(Date.UTC(2027, 11, 31)),
    })
    expect(dayKey(e.startsAt)).toBe('2027-02-28')
  })

  it('falls back to the member id when we have no name', () => {
    const [e] = fromBirthdays([{ member_id: '99', birth_month: 1, birth_day: 2 }], AUG)
    expect(e.title).toContain('99')
  })
})

describe('fromAnniversaries', () => {
  it('accepts the datetime-string shape Torn v1 serves', () => {
    const [e] = fromAnniversaries([{ member_id: '1', member_name: 'A', signup: '2015-08-14 05:39:32' }], AUG)
    expect(dayKey(e.startsAt)).toBe('2026-08-14')
    expect(e.title).toBe('A — 11 years in Torn')
  })

  it('accepts epoch seconds too', () => {
    // ⚠️ The field's shape was never verified against a live v2 response, and
    // guessing wrong would show every member the same wrong date while looking
    // entirely normal. Both shapes are handled rather than one assumed.
    const [e] = fromAnniversaries([{ member_id: '1', member_name: 'A', signup: 1_439_530_772 }], AUG)
    expect(dayKey(e.startsAt)).toBe('2026-08-14')
  })

  it('shows no anniversary in the signup year itself', () => {
    const rows = [{ member_id: '1', member_name: 'A', signup: '2026-08-14 05:39:32' }]
    expect(fromAnniversaries(rows, AUG)).toEqual([])
  })

  it('drops a member whose signup we do not have', () => {
    expect(fromAnniversaries([{ member_id: '1', signup: null }], AUG)).toEqual([])
    expect(fromAnniversaries([{ member_id: '1', signup: '' }], AUG)).toEqual([])
  })
})

describe('parseSignup', () => {
  it('reads seconds and milliseconds apart', () => {
    expect(parseSignup(1_439_530_772).getUTCFullYear()).toBe(2015)
    expect(parseSignup(1_439_530_772_000).getUTCFullYear()).toBe(2015)
  })

  it('returns null for junk rather than an Invalid Date', () => {
    expect(parseSignup('not a date')).toBeNull()
    expect(parseSignup(0)).toBeNull()
    expect(parseSignup(undefined)).toBeNull()
  })
})

describe('aggregate', () => {
  const payload = {
    wars: [{
      id: 1, start_at: Math.floor(Date.UTC(2026, 7, 5) / 1000), end_at: Math.floor(Date.UTC(2026, 7, 8) / 1000),
      opponent_name: 'Z', payout_id: 55,
    }],
    competitions: [{ id: 2, name: 'Comp', window_start: '2026-08-03T00:00:00+00', window_end: '2026-08-10T00:00:00+00' }],
    payout_weeks: [{ id: 3, week_start: '2026-08-10', week_end: '2026-08-16' }],
    events: [{ id: 5, source: 'manual', title: 'Chain', starts_at: '2026-08-01T20:00:00+00', recurrence: 'none' }],
    birthdays: [{ member_id: '6', member_name: 'M', birth_month: 8, birth_day: 14 }],
    anniversaries: [{ member_id: '7', member_name: 'N', signup: '2015-08-22 00:00:00' }],
  }

  it('merges every source into one chronological list', () => {
    const events = aggregate(payload, AUG)
    // war + its payout marker + competition + OC payout + manual + birthday + anniversary
    expect(events).toHaveLength(7)
    const times = events.map((e) => e.startsAt.getTime())
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('⚠️ carries no "deadline" kind — expiring OCs were removed', () => {
    // MonChoon, 2026-08-14: "I dont need crimes on there at all." Kept as a
    // test so the source does not quietly return via a copy-paste.
    expect(Object.keys(EVENT_KINDS)).not.toContain('deadline')
    expect(aggregate({ expiring_crimes: [{ crime_id: 1, expired_at: 1_754_000_000 }] }, AUG)).toEqual([])
  })

  it('pairs a war with its payout marker on the last day', () => {
    const events = aggregate(payload, AUG)
    const payout = events.find((e) => e.source === 'war_payout')
    expect(dayKey(payout.startsAt)).toBe('2026-08-08')
  })

  it('⚠️ keeps an event that OVERLAPS the window, not just one that starts in it', () => {
    // A war that began last month is still being fought — and that is exactly
    // when someone opens the calendar. Filtering on start alone hides it.
    const july = {
      wars: [{ id: 1, start_at: Math.floor(Date.UTC(2026, 6, 28) / 1000), end_at: Math.floor(Date.UTC(2026, 7, 4) / 1000), opponent_name: 'Z' }],
    }
    expect(aggregate(july, AUG)).toHaveLength(1)
  })

  it('⚠️ does not carry an ongoing war into future months', () => {
    // Treating "no end recorded" as "never ends" put a red band across every
    // month for the rest of time. The war is ongoing as of today; it is not
    // ongoing in March 2027.
    const running = {
      wars: [{ id: 1, start_at: Math.floor(Date.UTC(2026, 7, 10) / 1000), end_at: null, opponent_name: 'Ongoing' }],
    }
    const openUntil = new Date(Date.UTC(2026, 7, 20))
    expect(aggregate(running, { ...AUG, openUntil })).toHaveLength(1)
    expect(aggregate(running, {
      from: new Date(Date.UTC(2027, 2, 1)), to: new Date(Date.UTC(2027, 2, 31)), openUntil,
    })).toEqual([])
  })

  it('⚠️ keeps an in-progress war whose end is not recorded yet', () => {
    // The same trap one level down: `endsAt ?? startsAt` collapses an open war
    // to a point and clips it out of every window after its start date.
    const running = {
      wars: [{ id: 1, start_at: Math.floor(Date.UTC(2026, 6, 20) / 1000), end_at: null, opponent_name: 'Ongoing' }],
    }
    expect(aggregate(running, AUG)).toHaveLength(1)
  })

  it('excludes an event wholly outside the window', () => {
    const old = { wars: [{ id: 1, start_at: Math.floor(Date.UTC(2025, 0, 1) / 1000), end_at: Math.floor(Date.UTC(2025, 0, 3) / 1000) }] }
    expect(aggregate(old, AUG)).toEqual([])
  })

  it('survives a payload with missing keys', () => {
    expect(aggregate({}, AUG)).toEqual([])
    expect(aggregate(null, AUG)).toEqual([])
  })
})

describe('byDay', () => {
  it('⚠️ puts a multi-day event in every cell it covers', () => {
    // Indexed on the start alone, a five-day war shows on Monday and the grid
    // reads as empty for the rest of it.
    const map = byDay([{
      startsAt: new Date(Date.UTC(2026, 7, 5)), endsAt: new Date(Date.UTC(2026, 7, 8)), title: 'War',
    }])
    expect([...map.keys()].sort()).toEqual(['2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'])
  })

  it('puts a point-in-time event in exactly one cell', () => {
    const map = byDay([{ startsAt: new Date(Date.UTC(2026, 7, 5, 20)), endsAt: null, title: 'Chain' }])
    expect([...map.keys()]).toEqual(['2026-08-05'])
  })

  it('fills an open-ended war up to today and no further', () => {
    // It has not finished, but it has not happened tomorrow either.
    const map = byDay(
      [{ startsAt: new Date(Date.UTC(2026, 7, 5)), endsAt: null, open: true, title: 'War' }],
      { openUntil: new Date(Date.UTC(2026, 7, 7, 12)) }
    )
    expect([...map.keys()].sort()).toEqual(['2026-08-05', '2026-08-06', '2026-08-07'])
  })

  it('caps a runaway span rather than looping forever on a bad date', () => {
    const map = byDay(
      [{ startsAt: new Date(Date.UTC(2026, 0, 1)), endsAt: new Date(Date.UTC(2226, 0, 1)) }],
      { maxSpanDays: 10 }
    )
    expect(map.size).toBe(11)
  })
})

describe('upcoming', () => {
  const now = new Date(Date.UTC(2026, 7, 12, 12))
  const at = (d, h = 0) => new Date(Date.UTC(2026, 7, d, h))

  it('returns what is happening in the next week, soonest first', () => {
    const rows = upcoming([
      { title: 'later', startsAt: at(18) },
      { title: 'soon', startsAt: at(13) },
    ], { now })
    expect(rows.map((r) => r.title)).toEqual(['soon', 'later'])
  })

  it('includes an event already running', () => {
    // "The war you are in" is upcoming information to anyone opening the
    // dashboard, even though it started yesterday.
    const rows = upcoming([{ title: 'war', startsAt: at(10), endsAt: at(15) }], { now })
    expect(rows).toHaveLength(1)
  })

  it('excludes what has finished and what is beyond the horizon', () => {
    const rows = upcoming([
      { title: 'done', startsAt: at(1), endsAt: at(2) },
      { title: 'far', startsAt: at(30) },
    ], { now })
    expect(rows).toEqual([])
  })

  it('is empty rather than padded when nothing is on', () => {
    // ⚠️ The dashboard card renders nothing on an empty list. An empty card
    // every day trains people to stop looking at it.
    expect(upcoming([], { now })).toEqual([])
  })

  it('honours the limit', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ title: `e${i}`, startsAt: at(13, i) }))
    expect(upcoming(many, { now, limit: 3 })).toHaveLength(3)
  })
})

describe('monthGrid', () => {
  it('is six Monday-first weeks containing the month', () => {
    const cells = monthGrid(new Date(Date.UTC(2026, 7, 1)))
    expect(cells).toHaveLength(42)
    expect(cells[0].date.getUTCDay()).toBe(1)
    // 1 Aug 2026 is a Saturday, so the grid opens on 27 July.
    expect(cells[0].key).toBe('2026-07-27')
    expect(cells[0].inMonth).toBe(false)
    expect(cells.filter((c) => c.inMonth)).toHaveLength(31)
  })

  it('handles a month starting on a Monday without a blank leading week', () => {
    const cells = monthGrid(new Date(Date.UTC(2026, 5, 1))) // 1 June 2026 is a Monday
    expect(cells[0].key).toBe('2026-06-01')
    expect(cells[0].inMonth).toBe(true)
  })
})

describe('steadfastLabel', () => {
  it('lists every stat it could read', () => {
    expect(steadfastLabel({
      steadfast_strength: 20, steadfast_defense: 15, steadfast_speed: 10, steadfast_dexterity: 5,
    })).toBe('STR 20% · DEF 15% · SPD 10% · DEX 5%')
  })

  it('⚠️ skips a stat we could not read, but prints a real zero', () => {
    // Number(null) is 0, so a naive numeric check would print "SPD 0%" for a
    // stat the parser failed on — a fabricated fact indistinguishable from a
    // measured one.
    expect(steadfastLabel({
      steadfast_strength: 20, steadfast_defense: null, steadfast_speed: 0, steadfast_dexterity: undefined,
    })).toBe('STR 20% · SPD 0%')
  })

  it('is null when nothing could be read at all', () => {
    expect(steadfastLabel({ steadfast_strength: null })).toBeNull()
    expect(steadfastLabel(null)).toBeNull()
  })
})

describe('fromSteadfast', () => {
  // Observed on 14 Aug 2026, when the rotation had SPD and DEF boosted.
  const snapshot = {
    snapshot_date: '2026-08-14', branch_state: 'peace',
    steadfast_strength: 10, steadfast_speed: 15, steadfast_defense: 15, steadfast_dexterity: 10,
    steadfast_unparsed: [],
  }

  it('⚠️ is one band per rotation stretch, not a pill per day', () => {
    // A standing bonus repeated in thirty cells says thirty things happened
    // when one thing is true — and hides the changeover in the noise.
    const bands = fromSteadfast({ steadfast_rotation: true, steadfast_latest: snapshot }, AUG)
    expect(bands).toHaveLength(2)
    expect(bands.every((b) => b.band === true)).toBe(true)
    expect(dayKey(bands[0].startsAt)).toBe('2026-08-01')
    expect(dayKey(bands[0].endsAt)).toBe('2026-08-15')
    expect(dayKey(bands[1].startsAt)).toBe('2026-08-16')
  })

  it('moves the observed bonus onto whichever stat the rotation picks', () => {
    // The magnitudes are observed once; WHICH stat carries them is arithmetic.
    const [before, after] = fromSteadfast({ steadfast_rotation: true, steadfast_latest: snapshot }, AUG)
    expect(before.title).toBe('Steadfast STR 10% · DEF 15% · SPD 15% · DEX 10%')
    // From the 16th the DEF/DEX secondary is on dexterity.
    expect(after.title).toBe('Steadfast STR 10% · DEF 10% · SPD 15% · DEX 15%')
  })

  it('⚠️ predicts a future month, where no snapshot exists inside the window', () => {
    // The reason the endpoint sends the latest snapshot rather than a windowed
    // series. September 2026 is a STRENGTH month.
    const bands = fromSteadfast({ steadfast_rotation: true, steadfast_latest: snapshot }, {
      from: new Date(Date.UTC(2027, 2, 1)), to: new Date(Date.UTC(2027, 2, 31)),
    })
    expect(bands.length).toBeGreaterThan(0)
    expect(bands[0].title).toMatch(/\d+%/)
  })

  it('⚠️ names the boosted stats but claims no figure before the first scrape', () => {
    // Not a plausible-looking 15/10 default. The rotation is known; the
    // percentages are not, and the difference has to survive to the screen.
    const [band] = fromSteadfast({ steadfast_rotation: true, steadfast_latest: null }, AUG)
    expect(band.title).toBe('Steadfast SPE + DEF boosted')
    expect(band.note).toContain('not yet scraped')
  })

  it('says which stats carry the secondary trees, in words', () => {
    const [band] = fromSteadfast({ steadfast_rotation: true, steadfast_latest: snapshot }, AUG)
    expect(band.note).toContain('speed and defense carry the secondary trees')
    expect(band.note).toContain('observed 2026-08-14')
  })

  it('flags an observation that does not fit the expected pattern', () => {
    // The pick reading LOWER than its partner means the equal-mains assumption
    // has failed, and the split is not trustworthy.
    const odd = { ...snapshot, steadfast_speed: 8 }
    const [band] = fromSteadfast({ steadfast_rotation: true, steadfast_latest: odd }, AUG)
    expect(band.note).toContain('do not fit the expected pattern')
  })

  it('⚠️ shows nothing at all for a faction that has not opted in', () => {
    // The rotation encoded here is TNL's policy, and this stack serves several
    // factions. Another faction's Steadfast schedule looks exactly like their
    // own — which is the worst way for a calendar to be wrong, because nothing
    // about it reads as a guess.
    expect(fromSteadfast({ steadfast_latest: snapshot }, AUG)).toEqual([])
    expect(fromSteadfast({ steadfast_rotation: false, steadfast_latest: snapshot }, AUG)).toEqual([])
  })

  it('needs a window, and returns nothing without one', () => {
    expect(fromSteadfast({ steadfast_rotation: true, steadfast_latest: snapshot }, {})).toEqual([])
    expect(fromSteadfast(null, {})).toEqual([])
  })
})

describe('layoutWeek', () => {
  // Mon 3 Aug 2026 → Sun 9 Aug 2026.
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 7, 3 + i))
    return { date, key: dayKey(date), inMonth: true }
  })
  const on = (d, h = 0) => new Date(Date.UTC(2026, 7, d, h))

  it('⚠️ turns a multi-day event into one band, not a pill in each cell', () => {
    // The repeated-pill rendering MISCOUNTED: a five-day war read as five
    // things, and each cell's "+N more" counted the same war again.
    const { bands, singles } = layoutWeek(week, [{ id: 'w', title: 'War', startsAt: on(4), endsAt: on(7) }])
    expect(bands).toHaveLength(1)
    expect(bands[0]).toMatchObject({ startCol: 1, endCol: 4, lane: 0 })
    expect([...singles.values()].flat()).toEqual([])
  })

  it('leaves a single-day event as a pill in its own cell', () => {
    const { bands, singles } = layoutWeek(week, [{ id: 'c', title: 'Chain', startsAt: on(5, 20), endsAt: null }])
    expect(bands).toEqual([])
    expect(singles.get('2026-08-05')).toHaveLength(1)
  })

  it('flags a band clipped by the week boundary at each end', () => {
    // A rounded end where the event does not stop is a lie about the shape.
    const { bands } = layoutWeek(week, [{ id: 'w', title: 'Long war', startsAt: on(1), endsAt: on(12) }])
    expect(bands[0]).toMatchObject({ startCol: 0, endCol: 6, continuesLeft: true, continuesRight: true })
  })

  it('⚠️ stops an open-ended war on TODAY, not at the end of the week', () => {
    // The first cut used the maximum Date for an open war, reasoning that it
    // has not finished. True — but it also has not happened tomorrow, and the
    // band ran to the right edge of every week and reappeared in every future
    // month. Today is the last day it can honestly occupy.
    const { bands } = layoutWeek(
      week,
      [{ id: 'w', title: 'Ongoing', startsAt: on(4), endsAt: null, open: true }],
      { openUntil: on(6, 9) } // "today" is Wednesday the 6th
    )
    expect(bands[0]).toMatchObject({ startCol: 1, endCol: 3, continuesRight: false })
  })

  it('does not run an open war backwards when it starts later today', () => {
    const { bands } = layoutWeek(
      week,
      [{ id: 'w', title: 'Starting', startsAt: on(6, 20), endsAt: null, open: true }],
      { openUntil: on(6, 9) }
    )
    expect(bands).toEqual([])
  })

  it('stacks overlapping bands into separate lanes, and reuses a free one', () => {
    const { bands, lanes } = layoutWeek(week, [
      { id: 'a', title: 'A', startsAt: on(3), endsAt: on(5) },
      { id: 'b', title: 'B', startsAt: on(4), endsAt: on(8) },
      { id: 'c', title: 'C', startsAt: on(7), endsAt: on(9) }, // fits back in lane 0
    ])
    expect(lanes).toBe(2)
    expect(bands.find((b) => b.event.id === 'a').lane).toBe(0)
    expect(bands.find((b) => b.event.id === 'b').lane).toBe(1)
    expect(bands.find((b) => b.event.id === 'c').lane).toBe(0)
  })

  it('skips an event that does not reach this week at all', () => {
    const { bands, lanes } = layoutWeek(week, [{ id: 'x', title: 'Last month', startsAt: on(-20), endsAt: on(-15) }])
    expect(bands).toEqual([])
    expect(lanes).toBe(0)
  })

  it('gives a one-day band its own row when it is explicitly a band', () => {
    // A single recorded day of Steadfast is still a band — it is a standing
    // state, not something that happened at a moment.
    const { bands } = layoutWeek(week, [{ id: 's', title: 'Steadfast', startsAt: on(4), endsAt: on(4), band: true }])
    expect(bands).toHaveLength(1)
    expect(bands[0]).toMatchObject({ startCol: 1, endCol: 1 })
  })
})

describe('utcDate', () => {
  it('clamps an impossible day into the month', () => {
    expect(dayKey(utcDate(2027, 2, 29))).toBe('2027-02-28')
    expect(dayKey(utcDate(2026, 4, 31))).toBe('2026-04-30')
  })

  it('keeps a valid day untouched', () => {
    expect(dayKey(utcDate(2028, 2, 29))).toBe('2028-02-29')
  })
})
