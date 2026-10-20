// #1022 / #1023 — the producers' rules.
import { describe, expect, it } from 'vitest'
import { joinedTooLow, notInAnyOc, openSeatsFor, type Crime, type Readings } from '../src/ocSuggestionProducers.js'

const NOW = 1_800_000_000
const seat = (label: string, user?: { id: number; joined_at?: number; name?: string }, required: number | null = 60) =>
  ({ position_label: label, required_cpr: required, user: user ?? null })

const crimes = (): Crime[] => [
  { id: 1, name: 'Pet Project', difficulty: 1, status: 'Recruiting',
    slots: [seat('Kidnapper', { id: 101, joined_at: NOW - 600, name: 'Alice' }), seat('Muscle')] },
  { id: 2, name: 'Market Forces', difficulty: 5, status: 'Planning',
    slots: [seat('Enforcer', { id: 102, joined_at: NOW - 6 * 3600, name: 'Bob' })] },
  { id: 3, name: 'Blast from the Past', difficulty: 7, status: 'Recruiting',
    slots: [seat('Picklock #1', { id: 103, joined_at: NOW - 60, name: 'Cara' }), seat('Hacker', undefined, 70), seat('Bomber', undefined, 75)] },
  { id: 4, name: 'Break the Bank', difficulty: 8, status: 'Recruiting', slots: [seat('Robber', undefined, 60)] },
]
const readings = (): Readings => new Map([
  ['101', new Map([['Blast from the Past||Hacker', 74], ['Blast from the Past||Bomber', 70], ['Break the Bank||Robber', 55]])],
  ['200', new Map([['Break the Bank||Robber', 66]])],
  ['300', new Map([['Blast from the Past||Hacker', 72]])],
  // WalkMode, 2026-10-20: 48 against a bar of 67 — must never be suggested.
  ['400', new Map([['Blast from the Past||Hacker', 48], ['Blast from the Past||Bomber', 48]])],
])

describe('openSeatsFor', () => {
  it('puts a 7/8 seat they clear first, then any they clear, then by level, then CPR', () => {
    const seats = openSeatsFor('101', crimes(), readings())
    // L7 they clear; then by level (an L8 near-miss over an L1 blank); then CPR.
    expect(seats.map((s) => `${s.crime.id}:${s.label}:${s.clears}`)).toEqual([
      '3:Hacker:true', '4:Robber:false', '3:Bomber:false', '1:Muscle:null',
    ])
    expect(seats[0]).toMatchObject({ label: 'Hacker', cpr: 74, required: 70, clears: true })
  })

  it('never invents a CPR', () => {
    const seats = openSeatsFor('999', crimes(), readings())
    expect(seats.every((s) => s.cpr === null && s.clears === null)).toBe(true)
  })
})

describe('joined too low (#1022)', () => {
  it('flags a recent join below level 7 with a higher seat open', () => {
    const { live } = joinedTooLow({ crimes: crimes(), readings: readings(), names: new Map(), nowSec: NOW })
    expect(live.map((s) => s.key)).toEqual(['too_low:101:1'])
    expect(live[0]).toMatchObject({ kind: 'too_low', memberIds: ['101'], crimeId: '1', severity: 'warn' })
    expect(live[0].body).toContain('Blast from the Past')
    expect(live[0].body).toContain('CPR 74, clears the bar of 70')
    expect(live[0].steps).toEqual(['Alice leaves Pet Project', 'Alice joins Blast from the Past as Hacker'])
    expect(live[0].expiresAt).toBe((NOW - 600 + 4 * 3600) * 1000)
  })

  it('never flags level 7 or 8, and goes quiet after the window', () => {
    const { live } = joinedTooLow({ crimes: crimes(), readings: readings(), names: new Map(), nowSec: NOW })
    // Cara (L7 with an L8 open) and Bob (joined 6h ago) are absent.
    expect(live.some((s) => s.key.includes(':103:') || s.key.includes(':102:'))).toBe(false)
  })

  it('a member who moved up resolves; one who simply left does not', () => {
    const c = crimes()
    c[0].slots = [seat('Kidnapper'), seat('Muscle')]                    // Alice left Pet Project…
    c[2].slots![1] = seat('Hacker', { id: 101, joined_at: NOW, name: 'Alice' })   // …and took the L7 Hacker seat
    const { resolved } = joinedTooLow({ crimes: c, readings: readings(), names: new Map(), nowSec: NOW,
      previousKeys: ['too_low:101:1', 'too_low:555:1'] })
    expect([...resolved]).toEqual(['too_low:101:1'])
  })
})

describe('not in any OC (#1023)', () => {
  const members = [
    { id: '101', name: 'Alice' }, { id: '200', name: 'Dee' }, { id: '201', name: 'Eve' },
    { id: '202', name: 'Fed', state: 'Federal' },
  ]
  it('flags members out past the grace period, with their best seat; seated and federal are skipped', () => {
    const last = new Map([['200', NOW - 3 * 3600], ['201', NOW - 30 * 60]])
    const { live } = notInAnyOc({ crimes: crimes(), readings: readings(), members, lastSeatedSec: last, nowSec: NOW })
    expect(live.map((s) => s.key)).toEqual(['idle:200'])
    expect(live[0].body).toContain(`out of a crime since <t:${NOW - 3 * 3600}:R>`)
    expect(live[0].body).toContain('Break the Bank** (L8) as **Robber** — CPR 66, clears the bar of 60')
  })

  it('someone never seen in a crime counts as out', () => {
    const { live } = notInAnyOc({ crimes: crimes(), readings: readings(), members: [{ id: '300', name: 'Old hand' }],
      lastSeatedSec: new Map(), nowSec: NOW, joinedFactionSec: new Map([['300', NOW - 10 * 86400]]) })
    expect(live[0].body).toContain('not seen in a crime yet')
  })

  it('resolves when they join a crime', () => {
    const { resolved } = notInAnyOc({ crimes: crimes(), readings: readings(), members, lastSeatedSec: new Map(),
      nowSec: NOW, previousKeys: ['idle:101', 'idle:200'] })
    expect([...resolved]).toEqual(['idle:101'])
  })
})

describe('stable text (#1022/#1023 follow-up)', () => {
  it('the same situation a minute later is word-for-word the same, so the bot does not redraw it', () => {
    const at = (nowSec: number) => [
      ...joinedTooLow({ crimes: crimes(), readings: readings(), names: new Map(), nowSec }).live,
      ...notInAnyOc({ crimes: crimes(), readings: readings(), members: [{ id: '200', name: 'Dee' }],
        lastSeatedSec: new Map([['200', NOW - 7200]]), nowSec }).live,
    ].map((x) => x.body)
    expect(at(NOW + 60)).toEqual(at(NOW))
  })
})

describe('only seats they clear, and grace (2026-10-20)', () => {
  it('never suggests a seat below their bar — and with none they clear, says nothing', () => {
    const { live } = notInAnyOc({ crimes: crimes(), readings: readings(), members: [{ id: '400', name: 'WalkMode' }],
      lastSeatedSec: new Map(), nowSec: NOW })
    expect(live).toEqual([])
    const noReading = notInAnyOc({ crimes: crimes(), readings: readings(), members: [{ id: '999', name: 'Nobody' }],
      lastSeatedSec: new Map(), nowSec: NOW })
    expect(noReading.live).toEqual([])
  })

  it('joined too low only points at a seat they clear', () => {
    const c = crimes()
    c[0].slots![0].user = { id: 400, joined_at: NOW - 60, name: 'WalkMode' }
    const { live } = joinedTooLow({ crimes: c, readings: readings(), names: new Map(), nowSec: NOW })
    expect(live).toEqual([])
  })

  it('leaves a member new to the faction alone for a day, and one the membership sync has not recorded', () => {
    const members = [{ id: '200', name: 'Dee' }]
    const base = { crimes: crimes(), readings: readings(), members, lastSeatedSec: new Map<string, number>(), nowSec: NOW }
    expect(notInAnyOc({ ...base, joinedFactionSec: new Map([['200', NOW - 3600]]) }).live).toEqual([])
    expect(notInAnyOc({ ...base, joinedFactionSec: new Map() }).live).toEqual([])
    expect(notInAnyOc({ ...base, joinedFactionSec: new Map([['200', NOW - 2 * 86400]]) }).live).toHaveLength(1)
  })

  it('waits two hours after a crime by default', () => {
    const members = [{ id: '200', name: 'Dee' }]
    const at = (ago: number) => notInAnyOc({ crimes: crimes(), readings: readings(), members,
      lastSeatedSec: new Map([['200', NOW - ago]]), nowSec: NOW }).live.length
    expect(at(90 * 60)).toBe(0)
    expect(at(150 * 60)).toBe(1)
  })
})

