// #395 — the dashboard "Upcoming" card.
//
// `whenLabel` is the whole reason this card is readable at a glance, and every
// interesting case in it is a timezone case. Torn runs on TCT (= UTC) and a
// faction spans timezones, so "Today" has to mean today in TCT — otherwise two
// members reading the same card disagree about what day the war starts.
//
// The empty-render contract is pinned by a source check, in the same spirit as
// the #140 scanner: this repo has no component renderer, and a card that
// quietly starts rendering an empty shell every day is exactly the kind of
// regression nobody files a bug for — they just stop reading that corner of
// the screen.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { whenLabel } from '../UpcomingEvents'
import { daysInMonth } from '../calendar/BirthdayCard'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '..', 'UpcomingEvents.jsx'), 'utf8')

const NOW = new Date(Date.UTC(2026, 7, 12, 12, 0)) // Wednesday 12 Aug 2026, 12:00 TCT
const at = (d, h = 0, m = 0) => new Date(Date.UTC(2026, 7, d, h, m))

describe('whenLabel', () => {
  it('says "Now" for something already running', () => {
    expect(whenLabel({ startsAt: at(10), endsAt: at(15) }, NOW)).toBe('Now')
  })

  it('says "Now" for an open-ended war with no recorded end', () => {
    // ⚠️ Without the `open` flag this reads as a finished one-day event and
    // the war you are in gets labelled with a date in the past.
    expect(whenLabel({ startsAt: at(10), endsAt: null, open: true }, NOW)).toBe('Now')
  })

  it('gives today and tomorrow their names, and the rest a weekday', () => {
    expect(whenLabel({ startsAt: at(12, 20) }, NOW)).toBe('Today 20:00 TCT')
    expect(whenLabel({ startsAt: at(13, 9, 30) }, NOW)).toBe('Tomorrow 09:30 TCT')
    expect(whenLabel({ startsAt: at(15, 18) }, NOW)).toBe('Sat 18:00 TCT')
  })

  it('⚠️ counts days in TCT, not in elapsed hours', () => {
    // 23:00 tonight is 11 hours away but it is still TODAY. A naive
    // hours/24 would call it "Tomorrow" and a member would show up a day late.
    expect(whenLabel({ startsAt: at(12, 23) }, NOW)).toBe('Today 23:00 TCT')
    // And 01:00 tomorrow is 13 hours away — still tomorrow.
    expect(whenLabel({ startsAt: at(13, 1) }, NOW)).toBe('Tomorrow 01:00 TCT')
  })

  it('omits a time for an all-day entry, which has none to show', () => {
    expect(whenLabel({ startsAt: at(14), allDay: true }, NOW)).toBe('Fri')
    expect(whenLabel({ startsAt: at(12), allDay: true }, NOW)).toBe('Today')
  })
})

describe('the empty contract', () => {
  it('⚠️ returns null rather than rendering an empty card', () => {
    // An empty card every day trains people to stop looking, and then it fails
    // silently on the one day it matters.
    expect(SOURCE).toMatch(/if\s*\(events\.length === 0\)\s*return null/)
  })

  it('swallows a fetch failure instead of parking an error on the dashboard', () => {
    expect(SOURCE).toMatch(/\.catch\(\(\)\s*=>\s*\{[^}]*setEvents\(\[\]\)/)
  })
})

describe('daysInMonth', () => {
  it('offers 29 February, which is a real birthday', () => {
    expect(daysInMonth(2)).toBe(29)
  })

  it('does not offer days that do not exist', () => {
    expect(daysInMonth(4)).toBe(30)
    expect(daysInMonth(1)).toBe(31)
  })
})
