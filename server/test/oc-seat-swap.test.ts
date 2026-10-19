// #1021 — better seating within a crime.
import { describe, expect, it } from 'vitest'
import { seatSwap, moveSequence, swapResolved, type SwapCrime, type Readings } from '../src/ocSuggestionProducers.js'

const NOW = 1_800_000_000
const W = new Map([['P1', 10], ['P2', 60], ['P3', 30]])
const slot = (pid: string, label: string, user?: { id: number; progress?: number }, cpr?: number) => ({
  position_info: { id: pid, label }, position_label: label, checkpoint_pass_rate: cpr ?? null,
  user: user ? { id: user.id, joined_at: NOW - 100, progress: user.progress ?? 30 } : null,
})
// Alice (101) sits in the light seat but is the stronger Hacker; Bob (102) the reverse.
const crime = (over: Partial<SwapCrime> = {}): SwapCrime => ({
  id: 77, name: 'Blast from the Past', difficulty: 7, status: 'Recruiting', ready_at: NOW + 3600,
  slots: [slot('P1', 'Picklock #1', { id: 101 }, 60), slot('P2', 'Hacker', { id: 102 }, 55), slot('P3', 'Bomber')],
  ...over,
})
const readings = (): Readings => new Map([
  ['101', new Map([['Blast from the Past||Hacker', 80], ['Blast from the Past||Bomber', 50]])],
  ['102', new Map([['Blast from the Past||Picklock #1', 70], ['Blast from the Past||Bomber', 40]])],
])
const base = (over: Record<string, unknown> = {}) => ({
  crime: crime(), weights: W, readings: readings(), online: new Set(['101', '102', '103']),
  names: new Map([['101', 'Alice'], ['102', 'Bob'], ['103', 'Cara']]), nowSec: NOW, ...over,
})

/** Apply moves and check every step is legal: one person per seat, always. */
function replay(seating: (string | null)[], moves: ReturnType<typeof moveSequence>) {
  const seat = [...seating]
  for (const mv of moves) {
    if (mv.kind === 'leave') { seat[seat.indexOf(mv.member)] = null; continue }
    expect(seat[mv.to]).toBeNull()
    const from = seat.indexOf(mv.member)
    if (from >= 0) seat[from] = null
    seat[mv.to] = mv.member
  }
  return seat
}

describe('seatSwap', () => {
  it('swaps the stronger Hacker into the heavy seat, through the free seat, with the moves in order', () => {
    const s = seatSwap(base())!
    expect(s.kind).toBe('swap')
    expect(s.key).toBe('swap:77:101@P2,102@P1')
    expect(s.memberIds.sort()).toEqual(['101', '102'])
    // 10·70 + 60·80 = 5500 vs 10·60 + 60·55 = 3900 → +16.0 weighted over a total weight of 100
    expect(s.value).toEqual({ weighted_gain: 16 })
    expect(s.title).toContain('+16.0 weighted CPR')
    expect(s.body).toContain('Alice: Picklock #1 (CPR 60, 10% weight) → Hacker (CPR 80, 60% weight)')
    // Swapped through the free Bomber seat, which stays free afterwards.
    expect(s.steps).toEqual(['Alice moves to Bomber', 'Bob moves to Picklock #1', 'Alice moves to Hacker'])
  })

  it('states the gain in success chance when the simulator can be trusted', () => {
    const full = crime({ status: 'Recruiting', slots: [...crime().slots!.slice(0, 2), slot('P3', 'Bomber', { id: 103 }, 50)] })
    const r = readings()
    r.set('103', new Map())
    // A fake simulator: success is the weighted average CPR.
    const successOf = (v: Record<string, number>) => (10 * v.P1 + 60 * v.P2 + 30 * v.P3) / 100 / 100
    // Full crime, but Cara is idle (planning complete) and online.
    full.slots![2].user!.progress = 100
    const s = seatSwap(base({ crime: full, readings: r, successOf }))!
    expect(s.value).toEqual({ success_pp: 16 })
    expect(s.steps![0]).toContain('Cara leaves the crime')
    expect(s.steps!.at(-1)).toContain('Cara rejoins as Bomber')
  })

  it('needs every mover online, a real reading for every new seat, and a seat to move through', () => {
    expect(seatSwap(base({ online: new Set(['101']) }))).toBeNull()
    const r = readings(); r.get('101')!.delete('Blast from the Past||Hacker')
    expect(seatSwap(base({ readings: r }))).toBeNull()
    const full = crime({ slots: [...crime().slots!.slice(0, 2), slot('P3', 'Bomber', { id: 103, progress: 40 }, 50)] })
    const rr = readings(); rr.set('103', new Map())
    expect(seatSwap(base({ crime: full, readings: rr }))).toBeNull()   // full, nobody idle
  })

  it('stays quiet below the threshold, and on a crime that has started', () => {
    expect(seatSwap(base({ minWeightedGain: 17 }))).toBeNull()
    expect(seatSwap(base({ crime: crime({ ready_at: NOW - 1 }) }))).toBeNull()
  })

  it('suggests nothing when the arrangement is already best', () => {
    const r = readings()
    r.get('101')!.set('Blast from the Past||Hacker', 40)
    expect(seatSwap(base({ readings: r }))).toBeNull()
  })
})

describe('moveSequence', () => {
  it('breaks a three-way cycle through one free seat, legally', () => {
    const seating = ['a', 'b', 'c', null]
    const target = new Map([['a', 1], ['b', 2], ['c', 0]])
    const moves = moveSequence(seating, target)
    expect(replay(seating, moves)).toEqual(['c', 'a', 'b', null])
    expect(moves).toHaveLength(4)
  })

  it('an idle member leaves first and rejoins last', () => {
    const seating = ['a', 'b', 'x']
    const target = new Map([['a', 1], ['b', 0], ['x', 2]])
    const moves = moveSequence(seating, target, 'x')
    expect(moves[0]).toEqual({ kind: 'leave', member: 'x' })
    expect(moves.at(-1)).toEqual({ kind: 'join', member: 'x', to: 2 })
    expect(replay(seating, moves)).toEqual(['b', 'a', 'x'])
  })
})

describe('swapResolved', () => {
  it('is resolved once everyone sits where it said', () => {
    const done = crime({ slots: [slot('P1', 'Picklock #1', { id: 102 }), slot('P2', 'Hacker', { id: 101 }), slot('P3', 'Bomber')] })
    expect(swapResolved('swap:77:101@P2,102@P1', [done])).toBe(true)
    expect(swapResolved('swap:77:101@P2,102@P1', [crime()])).toBe(false)
  })
})
