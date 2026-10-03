import { describe, it, expect } from 'vitest'
import { splitChaseLists, formatChaseList, profileUrl } from '../rollCallChase'

/**
 * Two chase lists off a roll call (MonChoon, 2026-10-03).
 *
 * ⚠️ The tests are weighted towards the boundary between the lists, because
 * every way of getting it wrong produces a plausible-looking list. A lead
 * pastes it into Discord and chases it; a list that quietly omits the silent
 * non-responders looks reassuringly short, and one that mixes "can self-hosp"
 * in with "not coming" wastes the five minutes before a war on the wrong people.
 */

const member = (id, name, bsp = null) => ({ member_id: id, member_name: name, bsp_total: bsp })

const ROSTER = [
  member(1, 'Coming', 5_000_000),
  member(2, 'SelfHosp', 4_000_000),
  member(3, 'NotAvailable', 3_000_000),
  member(4, 'NeedsMerc', 2_000_000),
  member(5, 'Silent', 1_000_000),
  member(6, 'HalfAnswered', 900_000),
]

// ⚠️ `can_self_hospital` is null for anyone on at the start — the server nulls
// it on write, because the question only applies to a "no".
const RESPONSES = [
  { member_id: '1', on_at_start: true,  can_self_hospital: null,  needs_merc: false, availability: 'start' },
  { member_id: '2', on_at_start: false, can_self_hospital: true,  needs_merc: false, availability: 'late_1h' },
  { member_id: '3', on_at_start: false, can_self_hospital: false, needs_merc: false, availability: 'unavailable' },
  { member_id: '4', on_at_start: false, can_self_hospital: false, needs_merc: true,  availability: 'late_3h' },
  // 5 deliberately absent — never responded.
  { member_id: '6', on_at_start: false, can_self_hospital: null,  needs_merc: false, availability: 'late_1h' },
]

const names = (l) => l.map(e => e.member_name)

describe('splitChaseLists', () => {
  it('leaves out everybody who is on at the start', () => {
    const { missing, maybe } = splitChaseLists(ROSTER, RESPONSES)
    expect(names(missing)).not.toContain('Coming')
    expect(names(maybe)).not.toContain('Coming')
  })

  it('⚠️ does not mistake an on-at-start null for a "no" to self-hosp', () => {
    // The server nulls can_self_hospital when on_at_start is true. Reading it
    // without checking on_at_start first puts the entire attending roster into
    // the missing list.
    const { missing } = splitChaseLists([member(1, 'Coming')], [
      { member_id: '1', on_at_start: true, can_self_hospital: null, needs_merc: false },
    ])
    expect(missing).toEqual([])
  })

  it('puts "no to start, yes to self-hosp" in MAYBE and nowhere else', () => {
    const { missing, maybe } = splitChaseLists(ROSTER, RESPONSES)
    expect(names(maybe)).toEqual(['SelfHosp'])
    expect(names(missing)).not.toContain('SelfHosp')
  })

  it('puts a flat "no" to both in MISSING', () => {
    expect(names(splitChaseLists(ROSTER, RESPONSES).missing)).toContain('NotAvailable')
  })

  it('counts "needs a merc" as MISSING — they cannot get themselves in', () => {
    const { missing, maybe } = splitChaseLists(ROSTER, RESPONSES)
    expect(names(missing)).toContain('NeedsMerc')
    expect(names(maybe)).not.toContain('NeedsMerc')
  })

  it('⚠️ counts a non-responder as MISSING, not as unknown', () => {
    // Silence is the most common way somebody fails to turn up. Leaving the
    // silent ones off makes the chase list look reassuringly short.
    const { missing } = splitChaseLists(ROSTER, RESPONSES)
    expect(names(missing)).toContain('Silent')
    expect(missing.find(e => e.member_name === 'Silent').reason).toBe('no response')
  })

  it('counts "no to start, self-hosp unanswered" as MISSING, not MAYBE', () => {
    // Only an explicit yes earns a place on the maybe list; an unanswered
    // question is not a yes.
    const { missing, maybe } = splitChaseLists(ROSTER, RESPONSES)
    expect(names(missing)).toContain('HalfAnswered')
    expect(names(maybe)).not.toContain('HalfAnswered')
  })

  it('⚠️ matches ids across the string/number divide', () => {
    // The roster carries numeric ids; roll-call rows carry strings. A
    // same-type Set lookup misses every row and dumps the whole faction into
    // `missing` — which looks like a catastrophic roll call rather than a bug.
    const { missing, maybe } = splitChaseLists([member(2, 'SelfHosp')], [
      { member_id: '2', on_at_start: false, can_self_hospital: true },
    ])
    expect(names(maybe)).toEqual(['SelfHosp'])
    expect(missing).toEqual([])
  })

  it('keeps the two lists disjoint and accounts for everyone not attending', () => {
    const { missing, maybe } = splitChaseLists(ROSTER, RESPONSES)
    const overlap = names(missing).filter(n => names(maybe).includes(n))
    expect(overlap).toEqual([])
    expect(missing.length + maybe.length).toBe(ROSTER.length - 1) // all but 'Coming'
  })

  it('sorts strongest first, with unread stats last in BOTH lists', () => {
    const roster = [member(7, 'Unknown', null), member(8, 'Small', 1_000), member(9, 'Big', 9_000_000)]
    const { missing } = splitChaseLists(roster, [])
    expect(names(missing)).toEqual(['Big', 'Small', 'Unknown'])
  })

  it('survives an empty roster and empty responses', () => {
    expect(splitChaseLists([], [])).toEqual({ missing: [], maybe: [] })
    expect(splitChaseLists(undefined, undefined)).toEqual({ missing: [], maybe: [] })
  })

  it('falls back to the id when a member has no name', () => {
    const { missing } = splitChaseLists([{ member_id: 42 }], [])
    expect(missing[0].member_name).toBe('42')
  })
})

describe('formatChaseList', () => {
  it('carries name, id, stats and a profile link on one line each', () => {
    const { maybe } = splitChaseLists(ROSTER, RESPONSES)
    const text = formatChaseList(maybe, { title: 'Maybe' })
    expect(text).toContain('Maybe (1)')
    expect(text).toContain('SelfHosp [2]')
    expect(text).toContain('4.00M')
    expect(text).toContain('can self-hosp')
    expect(text).toContain(profileUrl(2))
  })

  it('renders an unread stat total as ??? rather than 0 or blank', () => {
    const text = formatChaseList([{ member_id: 9, member_name: 'NoSpy', bsp_total: null, reason: 'no response' }])
    expect(text).toContain('???')
    expect(text).not.toMatch(/\b0\b/)
  })

  it('states the count so a reader knows the paste is complete', () => {
    const { missing } = splitChaseLists(ROSTER, RESPONSES)
    expect(formatChaseList(missing, { title: 'Missing' })).toContain(`Missing (${missing.length})`)
  })

  it('says so plainly when the list is empty', () => {
    expect(formatChaseList([], { title: 'Missing' })).toBe('Missing (0) — nobody')
  })

  it('puts one member per line, because Discord collapses anything tabular', () => {
    const { missing } = splitChaseLists(ROSTER, RESPONSES)
    const lines = formatChaseList(missing, { title: 'Missing' }).split('\n')
    expect(lines).toHaveLength(missing.length + 1) // + the header
  })

  it('links to the profile, not an attack page', () => {
    // These are our OWN members — you do not attack them. The profile is what
    // answers "have they self-hospped yet", which is the reason to open it.
    const text = formatChaseList([{ member_id: 5, member_name: 'X', bsp_total: 1, reason: 'no response' }])
    expect(text).toContain('profiles.php?XID=5')
    expect(text).not.toContain('sid=attack')
  })
})
