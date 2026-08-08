// Estimated arrival for travelling members (#330).
import { describe, it, expect } from 'vitest'
import {
  TRAVEL_VARIANCE, FLIGHT_SECONDS,
  travelDestination, methodsForPlaneType, travelEta, formatTravelEta,
} from '../warRoomTravel'

const T0 = Date.parse('2026-08-08T12:00:00Z')
const ago = (sec) => new Date(T0 - sec * 1000).toISOString()

describe('travelDestination', () => {
  it('reads the country off an outbound flight', () => {
    expect(travelDestination('Traveling from Torn to Switzerland')).toBe('switzerland')
  })

  it('reads the country off a RETURN flight', () => {
    // The flight time is a property of the route, not the direction, so the
    // country is whichever end is not Torn.
    expect(travelDestination('Traveling from UAE to Torn')).toBe('uae')
  })

  it('accepts the short-form description', () => {
    expect(travelDestination('Traveling to Mexico')).toBe('mexico')
    expect(travelDestination('Returning from Japan')).toBe('japan')
  })

  it('resolves the names Torn uses interchangeably', () => {
    // The faction payload says "UAE"; the in-game flight table says "United
    // Arab Emirates". Both have to land on the same row.
    expect(travelDestination('Traveling from Torn to United Arab Emirates')).toBe('uae')
    expect(travelDestination('Traveling from Torn to UK')).toBe('united kingdom')
    expect(travelDestination('Traveling from Torn to United Kingdom')).toBe('united kingdom')
  })

  it('is null for a destination we have no flight time for', () => {
    // Better no estimate than one built on a guessed duration.
    expect(travelDestination('Traveling from Torn to Atlantis')).toBeNull()
    expect(travelDestination(null)).toBeNull()
    expect(travelDestination('In Switzerland')).toBeNull()
  })
})

describe('methodsForPlaneType', () => {
  it('maps the two aircraft we have confirmed', () => {
    // Observed on live members: a BCT flight reported `airliner`, an airstrip
    // flight reported `light_aircraft`.
    expect(methodsForPlaneType('airliner')).toEqual(['business'])
    expect(methodsForPlaneType('light_aircraft')).toEqual(['airstrip'])
  })

  it('returns every method for an aircraft we have not mapped', () => {
    // Standard and WLT are still unknown, and a flight perk may add more. An
    // unknown type must widen the estimate, never silently pick a method —
    // guessing produces a confidently wrong landing time.
    expect(methodsForPlaneType('zeppelin')).toEqual(['business', 'wlt', 'airstrip', 'standard'])
    expect(methodsForPlaneType(null)).toHaveLength(4)
    expect(methodsForPlaneType(undefined)).toHaveLength(4)
  })
})

describe('travelEta', () => {
  const eta = (over = {}) => travelEta({
    description: 'Traveling from Torn to Mexico',
    planeType: 'light_aircraft',   // airstrip: 1020s
    departedAt: ago(0),
    nowMs: T0,
    ...over,
  })

  it('gives a band around the known flight time', () => {
    const out = eta()
    expect(out.state).toBe('estimate')
    // 1020s ±3% → 989.4 .. 1050.6
    expect(out.earliestSec).toBe(Math.round(1020 * (1 - TRAVEL_VARIANCE)))
    expect(out.latestSec).toBe(Math.round(1020 * (1 + TRAVEL_VARIANCE)))
  })

  it('counts down as the flight progresses', () => {
    const out = eta({ departedAt: ago(600) })
    expect(out.earliestSec).toBe(Math.round(1020 * 0.97) - 600)
    expect(out.latestSec).toBe(Math.round(1020 * 1.03) - 600)
  })

  it('never claims an exact arrival', () => {
    // Torn added up to 3% flight-time variance (patch #26). Even with the
    // method known, the answer is a window — presenting a single certain time
    // would be wrong by up to 40s on a long flight.
    expect(TRAVEL_VARIANCE).toBe(0.03)
    expect(eta().earliestSec).not.toBe(eta().latestSec)
  })

  it('is unknown when we did not witness the departure', () => {
    // The normal case for anyone already airborne when the board came up.
    expect(eta({ departedAt: null }).state).toBe('unknown')
    expect(eta({ departedAt: undefined }).state).toBe('unknown')
  })

  it('is unknown for a destination with no flight time on file', () => {
    expect(eta({ description: 'Traveling from Torn to Narnia' }).state).toBe('unknown')
  })

  it('widens across every method when the aircraft is unrecognised', () => {
    const out = eta({ planeType: 'mystery' })
    // Mexico: business 420 .. standard 1440.
    expect(out.earliestSec).toBe(Math.round(420 * 0.97))
    expect(out.latestSec).toBe(Math.round(1440 * 1.03))
    expect(out.methods).toHaveLength(4)
  })

  it('narrows by elimination as candidates expire', () => {
    // The payoff of polling every second: a method whose latest possible
    // landing has passed while they are still airborne is ruled out.
    // Mexico business 420 (max 433), wlt 720 (max 742), airstrip 1020 (max 1051).
    const out = eta({ planeType: 'mystery', departedAt: ago(800) })
    expect(out.methods).toEqual(['airstrip', 'standard'])
    expect(out.earliestSec).toBe(Math.round(1020 * 0.97) - 800)
  })

  it('does not eliminate a candidate at its nominal time, only past its upper bound', () => {
    // Eliminating at 420s would rule out a business-class flight that is
    // legitimately still in the air at 425s thanks to the variance.
    const out = eta({ planeType: 'mystery', departedAt: ago(425) })
    expect(out.methods).toContain('business')
    // Past the upper bound it goes.
    expect(eta({ planeType: 'mystery', departedAt: ago(440) }).methods).not.toContain('business')
  })

  it('reports overdue rather than a landing in the past', () => {
    // Reachable in normal play: the Watchlist job special lets a Detective
    // Agency EXTEND someone's flight, so a member can still be airborne after
    // every candidate has expired. The code must not conclude the impossible.
    const out = eta({ planeType: 'light_aircraft', departedAt: ago(5000) })
    expect(out.state).toBe('overdue')
    expect(out.earliestSec).toBeUndefined()
  })

  it('clamps a still-in-flight estimate at zero rather than going negative', () => {
    const out = eta({ planeType: 'light_aircraft', departedAt: ago(1000) })
    expect(out.earliestSec).toBe(0)
    expect(out.latestSec).toBeGreaterThan(0)
  })

  it('uses the same flight time in both directions', () => {
    const outbound = eta({ description: 'Traveling from Torn to Japan', planeType: 'airliner' })
    const inbound = eta({ description: 'Traveling from Japan to Torn', planeType: 'airliner' })
    expect(outbound.latestSec).toBe(inbound.latestSec)
  })
})

describe('formatTravelEta', () => {
  const fmt = (over = {}) => formatTravelEta(travelEta({
    description: 'Traveling from Torn to Mexico',
    planeType: 'light_aircraft',
    departedAt: ago(0),
    nowMs: T0,
    ...over,
  }))

  it('marks an estimate as an estimate', () => {
    // It must never read like the exact hospital countdown beside it.
    expect(fmt()).toMatch(/^~/)
  })

  it('shows a range when the methods are still ambiguous', () => {
    expect(fmt({ planeType: 'mystery' })).toContain('–')
  })

  it('collapses to a single figure once the band is tight', () => {
    // A ±3% window on one known method is not worth two numbers.
    expect(fmt()).not.toContain('–')
  })

  it('says nothing rather than guessing when the departure was missed', () => {
    expect(fmt({ departedAt: null })).toBe('—')
  })

  it('says overdue plainly', () => {
    expect(fmt({ departedAt: ago(5000) })).toBe('landing')
  })
})

describe('FLIGHT_SECONDS table', () => {
  it('has all four methods for every destination', () => {
    for (const [dest, times] of Object.entries(FLIGHT_SECONDS)) {
      expect(Object.keys(times).sort(), dest).toEqual(['airstrip', 'business', 'standard', 'wlt'])
    }
  })

  it('orders the methods fastest to slowest everywhere', () => {
    // The elimination logic assumes this ordering holds; a typo in the table
    // that inverted two methods would silently corrupt every estimate.
    for (const [dest, t] of Object.entries(FLIGHT_SECONDS)) {
      expect(t.business, dest).toBeLessThan(t.wlt)
      expect(t.wlt, dest).toBeLessThan(t.airstrip)
      expect(t.airstrip, dest).toBeLessThan(t.standard)
    }
  })

  it('keeps the methods far enough apart for their variance bands not to overlap', () => {
    // Elimination only works because ±3% bands cannot touch. Adjacent methods
    // differ by ~1.4x; they would need to be within 1.06x to overlap.
    const ratio = (1 + TRAVEL_VARIANCE) / (1 - TRAVEL_VARIANCE)
    for (const [dest, t] of Object.entries(FLIGHT_SECONDS)) {
      expect(t.wlt / t.business, dest).toBeGreaterThan(ratio)
      expect(t.airstrip / t.wlt, dest).toBeGreaterThan(ratio)
      expect(t.standard / t.airstrip, dest).toBeGreaterThan(ratio)
    }
  })

  it('carries the whole published destination list', () => {
    expect(Object.keys(FLIGHT_SECONDS)).toHaveLength(11)
    expect(FLIGHT_SECONDS.mexico.standard).toBe(24 * 60)
    expect(FLIGHT_SECONDS['south africa'].business).toBe(85 * 60)
  })
})
