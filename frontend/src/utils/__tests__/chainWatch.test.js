// Chain Watch derivations (#772).
//
// The spreadsheet this replaces got two things wrong by hand, and both are
// pinned here: it typed three timezone rows and broke across a DST fold, and
// it made coverage something you found by scanning for blanks.
import { describe, it, expect } from 'vitest'
import {
  hourRows, groupByTctDay, gapsAhead, gapSentence, coverage,
  pickerOptions, bonusLabel, localLabel, tctLabel, GAP_HORIZON_HOURS,
} from '../chainWatch'

const EVENT = {
  id: 1,
  // ⚠️ 10:00, not midnight — the 2025 event ran 25 Oct 10:00 → 1 Nov 16:00 TCT.
  starts_at: '2027-10-25T10:00:00+00',
  ends_at: '2027-10-28T10:00:00+00',
  slots_per_hour: 2,
  bonus_hours: [5, 6],
  bonus_multiplier: 2,
  bonus_applies_to: 'tickets',
}
const NOW = Date.parse('2027-10-26T14:20:00Z')
const sign = (hour, slot, id, name) => ({
  hour_start: `${hour}+00`, slot_index: slot, member_id: id, member_name: name,
})

describe('hourRows', () => {
  it('⚠️ starts on the event hour, not on midnight', () => {
    const rows = hourRows(EVENT, [], NOW)
    expect(rows[0].tct).toBe('10:00')
    expect(rows).toHaveLength(72)
    expect(rows.at(-1).tct).toBe('09:00')
  })

  it('⚠️ decides "elapsed" from the clock it is handed, not from Date.now()', () => {
    // A viewer with a skewed system clock would otherwise be shown hours as
    // past that are still claimable — and that viewer is the half-asleep
    // person at 3am this page is for.
    const early = hourRows(EVENT, [], Date.parse('2027-10-25T12:00:00Z'))
    const late = hourRows(EVENT, [], Date.parse('2027-10-27T12:00:00Z'))
    expect(early.filter((r) => r.isPast)).toHaveLength(2)
    expect(late.filter((r) => r.isPast)).toHaveLength(50)
  })

  it('marks exactly one hour as now', () => {
    const rows = hourRows(EVENT, [], NOW)
    const now = rows.filter((r) => r.isNow)
    expect(now).toHaveLength(1)
    expect(now[0].tct).toBe('14:00')
  })

  it('reads slots_per_hour from the event rather than assuming two', () => {
    const rows = hourRows({ ...EVENT, slots_per_hour: 3 }, [], NOW)
    expect(rows[0].slots).toHaveLength(3)
  })

  it('places a sign-up in its own slot and leaves the other open', () => {
    const rows = hourRows(EVENT, [sign('2027-10-26T04:00:00', 1, '9200', 'Watcher One')], NOW)
    const row = rows.find((r) => r.hourIso.startsWith('2027-10-26T04'))
    expect(row.slots[0]).toBeNull()
    expect(row.slots[1].member_name).toBe('Watcher One')
    expect(row.openSlots).toBe(1)
  })

  it('marks the event’s bonus hours, and only those', () => {
    const rows = hourRows(EVENT, [], NOW)
    expect(rows.filter((r) => r.isBonus).map((r) => r.tct))
      .toEqual(['05:00', '06:00', '05:00', '06:00', '05:00', '06:00'].slice(0, 6))
  })

  it('returns nothing for an event with no usable window', () => {
    expect(hourRows({ starts_at: null, ends_at: null }, [], NOW)).toEqual([])
    expect(hourRows({ starts_at: EVENT.ends_at, ends_at: EVENT.starts_at }, [], NOW)).toEqual([])
  })
})

describe('⚠️ the local-time column across a DST fold', () => {
  // The exact case the spreadsheet got wrong: the 2025 event crossed the US
  // change and rows 100-101 of the workbook list "2:00-3:00" twice, patched by
  // hand. TCT never folds — it is UTC — so the grid stays regular and the
  // LOCAL column is where the fold shows up.
  const DST_EVENT = {
    ...EVENT,
    starts_at: '2027-11-07T04:00:00+00', // 00:00 EDT → the fold is at 06:00 UTC
    ends_at: '2027-11-07T10:00:00+00',
  }

  it('keeps TCT hours strictly regular through the fold', () => {
    const rows = hourRows(DST_EVENT, [], Date.parse('2027-11-07T04:00:00Z'))
    expect(rows.map((r) => r.tct)).toEqual(['04:00', '05:00', '06:00', '07:00', '08:00', '09:00'])
  })

  it('⚠️ renders the repeated local hour twice, because that is what happened', () => {
    const rows = hourRows(DST_EVENT, [], Date.parse('2027-11-07T04:00:00Z'))
    const local = rows.map((r) => localLabel(r.ms, 'America/New_York'))
    // 01:00 EDT and 01:00 EST are DIFFERENT instants an hour apart. Two rows
    // reading "01:00" is correct and must not be collapsed.
    expect(local.filter((l) => l === '01:00')).toHaveLength(2)
    expect(new Set(rows.map((r) => r.ms)).size).toBe(6)
  })

  it('serves a zone that never folds without inventing one', () => {
    const rows = hourRows(DST_EVENT, [], Date.parse('2027-11-07T04:00:00Z'))
    expect(rows.map((r) => localLabel(r.ms, 'Asia/Kolkata')))
      .toEqual(['09:30', '10:30', '11:30', '12:30', '13:30', '14:30'])
  })

  it('falls back to TCT rather than throwing on a zone the browser rejects', () => {
    expect(localLabel(Date.parse('2027-10-25T10:00:00Z'), 'Not/AZone'))
      .toBe(tctLabel(Date.parse('2027-10-25T10:00:00Z')))
  })
})

describe('the six-hour warning', () => {
  const rows = () => hourRows(EVENT, [
    sign('2027-10-26T15:00:00', 0, '9200', 'One'),   // 15:00 half-covered
    sign('2027-10-26T16:00:00', 0, '9200', 'One'),
    sign('2027-10-26T16:00:00', 1, '9300', 'Two'),   // 16:00 fully covered
  ], NOW)

  it('⚠️ counts slots, not hours', () => {
    // An hour holding one of two watchers is ONE unfilled slot — not zero, and
    // not two. This is the count the 2025 data makes interesting: 43 of 211
    // served hours ran single-covered.
    const gaps = gapsAhead(rows(), NOW)
    const bySlot = Object.fromEntries(gaps.map((g) => [g.tct, g.open]))
    expect(bySlot['15:00']).toBe(1)
    expect(bySlot['16:00']).toBeUndefined()
    expect(bySlot['17:00']).toBe(2)
  })

  it('looks exactly six hours ahead and no further', () => {
    const gaps = gapsAhead(rows(), NOW)
    expect(gaps.at(-1).tct).toBe('19:00')
    expect(gaps.every((g) => g.ms < NOW + GAP_HORIZON_HOURS * 3600_000)).toBe(true)
  })

  it('never reports an hour that has already run', () => {
    expect(gapsAhead(rows(), NOW).some((g) => g.ms < NOW - 3600_000)).toBe(false)
  })

  it('⚠️ names the fully naked hours even at one severity', () => {
    // One level is a decision about ALARM, not about information. A leader
    // reading the sentence should still know which hour has nobody at all.
    const sentence = gapSentence(gapsAhead(rows(), NOW))
    expect(sentence).toMatch(/^9 slots unfilled in the next 6 hours/)
    expect(sentence).toMatch(/15:00,/)          // half-covered: no marker
    expect(sentence).toMatch(/17:00 \(both\)/)  // nobody at all
    expect(sentence).not.toMatch(/15:00 \(both\)/)
  })

  it('says nothing at all when the next six hours are covered', () => {
    const full = hourRows({ ...EVENT, slots_per_hour: 1 },
      Array.from({ length: 8 }, (_, i) =>
        sign(`2027-10-26T${String(14 + i).padStart(2, '0')}:00:00`, 0, '9200', 'One')), NOW)
    expect(gapSentence(gapsAhead(full, NOW))).toBeNull()
  })
})

describe('the coverage headline', () => {
  it('leads with the next unstaffed hour', () => {
    // The current, partly-elapsed hour counts: nobody watching RIGHT NOW is
    // the most urgent thing the page can say.
    const rows = hourRows(EVENT, [
      sign('2027-10-26T14:00:00', 0, '9200', 'One'),
      sign('2027-10-26T14:00:00', 1, '9300', 'Two'),
      sign('2027-10-26T15:00:00', 0, '9200', 'One'),
      sign('2027-10-26T15:00:00', 1, '9300', 'Two'),
    ], NOW)
    expect(coverage(rows, NOW).nextGap.hourIso).toBe('2027-10-26T16:00:00.000Z')
  })

  it('⚠️ does not worsen when a day is appended beyond the horizon', () => {
    // A fresh day is 24 hours of nothing. An unbounded count would leap the
    // instant somebody clicks Add a day, reading as the roster collapsing when
    // in fact the window grew.
    const long = { ...EVENT, ends_at: '2027-10-30T10:00:00+00' } // horizon fully inside
    const before = hourRows(long, [], NOW)
    const after = hourRows({ ...long, ends_at: '2027-10-31T10:00:00+00' }, [], NOW)
    expect(after).toHaveLength(before.length + 24)
    expect(coverage(after, NOW).nextGap.hourIso).toBe(coverage(before, NOW).nextGap.hourIso)
    expect(coverage(after, NOW).openInHorizon).toBe(coverage(before, NOW).openInHorizon)
  })

  it('⚠️ grows only where the window was shorter than the horizon, and says so', () => {
    // Honest boundary: if the event ends inside the next 48h, appending a day
    // DOES raise the count — those hours did not exist before, so there was
    // nothing to staff. That is the window growing, not coverage collapsing,
    // and it is bounded by the horizon rather than by the whole event.
    const short = hourRows(EVENT, [], NOW)                                   // ends 28 Oct 10:00
    const longer = hourRows({ ...EVENT, ends_at: '2027-10-29T10:00:00+00' }, [], NOW)
    const grew = coverage(longer, NOW).openInHorizon - coverage(short, NOW).openInHorizon
    expect(grew).toBe(4 * EVENT.slots_per_hour)  // 4 hours of the 48 were off-grid
    expect(coverage(longer, NOW).nextGap.hourIso).toBe(coverage(short, NOW).nextGap.hourIso)
  })

  it('counts only inside its stated horizon', () => {
    const rows = hourRows(EVENT, [], NOW)
    expect(coverage(rows, NOW, 2).openInHorizon).toBe(4)
    expect(coverage(rows, NOW, 2).horizonHours).toBe(2)
  })
})

describe('grouping and labels', () => {
  it('⚠️ gives short first and last days rather than padding to 24', () => {
    const days = groupByTctDay(hourRows(EVENT, [], NOW))
    expect(days.map((d) => d.rows.length)).toEqual([14, 24, 24, 10])
    expect(days[0].rows[0].tct).toBe('10:00')
    expect(days.at(-1).rows.at(-1).tct).toBe('09:00')
  })

  it('reads the bonus wording off the event instead of hardcoding it', () => {
    expect(bonusLabel(EVENT)).toBe('pays 2× raffle tickets')
    expect(bonusLabel({ ...EVENT, bonus_applies_to: 'payout', bonus_multiplier: 3 }))
      .toBe('pays 3× money')
    expect(bonusLabel({ ...EVENT, bonus_applies_to: 'both' })).toBe('pays 2× money and tickets')
  })
})

describe('the assign picker', () => {
  const roster = [
    { member_id: '9200', member_name: 'One' },
    { member_id: '9300', member_name: 'Two' },
    { member_id: '9400', member_name: 'Three' },
  ]

  it('⚠️ keeps the other slot’s holder in the list, disabled with a reason', () => {
    // Dropping them silently makes a leader hunting for a name conclude the
    // picker is broken. The database refuses the pairing anyway (#771).
    // ⚠️ Match on the INSTANT. `tct` repeats every day, so `.find(r.tct)`
    // silently returns 25 Oct and the sign-up under test is not in the row at
    // all — which is how a picker assertion passes while testing nothing.
    const row = hourRows(EVENT, [sign('2027-10-26T15:00:00', 0, '9200', 'One')], NOW)
      .find((r) => r.hourIso === '2027-10-26T15:00:00.000Z')
    expect(row.slots[0].member_id).toBe('9200')
    const opts = pickerOptions(roster, row, 1)
    expect(opts).toHaveLength(3)
    expect(opts.find((o) => o.member_id === '9200').disabledReason).toBe('already watching this hour')
    expect(opts.find((o) => o.member_id === '9300').disabledReason).toBeNull()
  })

  it('does not disable the person already in the slot being replaced', () => {
    const row = hourRows(EVENT, [sign('2027-10-26T15:00:00', 0, '9200', 'One')], NOW)
      .find((r) => r.hourIso === '2027-10-26T15:00:00.000Z')
    expect(row.slots[0].member_id).toBe('9200')
    expect(pickerOptions(roster, row, 0).every((o) => !o.disabledReason)).toBe(true)
  })
})
