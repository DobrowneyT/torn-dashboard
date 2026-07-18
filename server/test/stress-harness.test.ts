// Stress harness (#116) — unit contract for the two pure pieces the load
// test stands on: the mock Torn API (key encoding + deterministic roster
// churn + HTTP shapes the server actually consumes) and the latency stats
// aggregation the swarm reports. The swarm script itself is a thin I/O
// shell over these.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-ignore — plain-JS harness module, no type declarations
import { makeStressKey, parseStressKey, rosterAt, startMockTorn } from '../../deploy/stress/mock-torn.mjs'
// @ts-ignore — plain-JS harness module, no type declarations
import { summarize, parseServerTimestamp } from '../../deploy/stress/stats.mjs'

describe('stress key encoding', () => {
  it('round-trips faction id and member index through a 16-char key', () => {
    const key = makeStressKey(990001, 42)
    expect(key).toHaveLength(16)
    expect(parseStressKey(key)).toEqual({ factionId: 990001, memberIndex: 42 })
  })

  it('rejects keys that are not stress keys', () => {
    expect(parseStressKey('AAAA1111BBBB2222')).toBeNull()
  })
})

describe('deterministic roster churn', () => {
  const opts = { membersPerFaction: 100, churnFraction: 0.2, churnPeriodSec: 5 }

  it('serves the configured number of members with stable identities', () => {
    const a = rosterAt(990001, 1_000_000, opts)
    const b = rosterAt(990001, 1_000_000, opts)
    expect(a.members).toHaveLength(100)
    expect(a.members.map((m: any) => m.id)).toEqual(b.members.map((m: any) => m.id))
    expect(a.members[0].name).toBe(b.members[0].name)
  })

  it('members are fully stable within a bucket — no per-second field churn', () => {
    // Regression: last_action.timestamp derived from the exact second made
    // EVERY member differ on EVERY tick, so each broadcast carried the whole
    // roster (~120KB/frame in the first live run) instead of real churn.
    const t0 = 10_000_000
    expect(rosterAt(990001, t0 + 1_000, opts)).toEqual(rosterAt(990001, t0, opts))
  })

  it('is identical within a churn bucket and different across buckets', () => {
    const t0 = 10_000_000
    const inBucket = rosterAt(990001, t0 + 1_000, opts) // same 5s bucket
    const nextBucket = rosterAt(990001, t0 + 5_000, opts)
    const states = (r: any) => r.members.map((m: any) => m.status.state).join(',')
    expect(states(rosterAt(990001, t0, opts))).toBe(states(inBucket))
    expect(states(rosterAt(990001, t0, opts))).not.toBe(states(nextBucket))
  })

  it('different factions get different member ids', () => {
    const a = rosterAt(990001, 0, opts).members.map((m: any) => m.id)
    const b = rosterAt(990002, 0, opts).members.map((m: any) => m.id)
    expect(a.some((id: number) => b.includes(id))).toBe(false)
  })

  it('ABSOLUTE mode: churnPeriodSec=1 changes every member every second', () => {
    // Deliberate worst case (LAUNCH.md §7.5b): with a 1s bucket, every
    // member's time-derived fields move each tick, so each broadcast carries
    // the full roster — the load profile of the first live run, kept on
    // purpose as the ceiling test. This pin stops a future "fix" from
    // quantizing it away.
    const abs = { membersPerFaction: 50, churnFraction: 0.2, churnPeriodSec: 1 }
    const a = rosterAt(990001, 20_000_000, abs).members
    const b = rosterAt(990001, 20_001_000, abs).members
    for (let i = 0; i < a.length; i++) {
      expect(JSON.stringify(a[i])).not.toBe(JSON.stringify(b[i]))
    }
  })
})

describe('mock Torn HTTP server', () => {
  let mock: { port: number; close(): Promise<void> }
  const base = () => `http://127.0.0.1:${mock.port}`

  beforeAll(async () => {
    mock = await startMockTorn({ port: 0, membersPerFaction: 25 })
  })
  afterAll(async () => {
    await mock.close()
  })

  it('key/info resolves a stress key to a Limited member of its faction', async () => {
    const key = makeStressKey(990001, 7)
    const res = await fetch(`${base()}/v2/key/info?key=${key}`)
    const data: any = await res.json()
    expect(data.error).toBeUndefined()
    expect(data.info.user.faction_id).toBe(990001)
    expect(data.info.access.level).toBe(3)
    expect(String(data.info.user.id)).toMatch(/^\d+$/)
  })

  it('key/info rejects a non-stress key with a Torn-style error', async () => {
    const res = await fetch(`${base()}/v2/key/info?key=AAAA1111BBBB2222`)
    const data: any = await res.json()
    expect(data.error.code).toBe(2)
  })

  it('user/basic returns the member name for the key', async () => {
    const key = makeStressKey(990001, 0)
    const data: any = await (await fetch(`${base()}/v2/user/basic?key=${key}`)).json()
    expect(typeof data.basic.name).toBe('string')
  })

  it('faction members serves the shape the ticker consumes', async () => {
    const key = makeStressKey(990001, 0)
    const data: any = await (
      await fetch(`${base()}/v2/faction/990002/members?striptags=true&key=${key}`)
    ).json()
    expect(data.members).toHaveLength(25)
    const m = data.members[0]
    expect(typeof m.id).toBe('number')
    expect(typeof m.name).toBe('string')
    expect(typeof m.level).toBe('number')
    expect(['Okay', 'Hospital']).toContain(m.status.state)
    expect(typeof m.last_action.status).toBe('string')
  })

  it('faction basic and chain return benign shapes', async () => {
    const key = makeStressKey(990001, 0)
    const basic: any = await (await fetch(`${base()}/v2/faction/990002/basic?key=${key}`)).json()
    expect(typeof basic.basic.name).toBe('string')
    const chain: any = await (await fetch(`${base()}/v2/faction/990001/chain?key=${key}`)).json()
    expect(typeof chain.chain.current).toBe('number')
  })

  it('anything unrecognised returns empty success, never an error', async () => {
    const data: any = await (
      await fetch(`${base()}/v2/faction/rankedwars?key=${makeStressKey(990001, 0)}`)
    ).json()
    expect(data.error).toBeUndefined()
  })
})

describe('parseServerTimestamp', () => {
  it('parses the pg-style "+00" offset the server actually emits', () => {
    // Regression: Date.parse('…T13:48:56.622+00') is NaN in V8, so the first
    // live run silently collected ZERO latency samples.
    const t = parseServerTimestamp('2026-07-18T13:48:56.622+00')
    expect(t).toBe(Date.parse('2026-07-18T13:48:56.622Z'))
  })

  it('parses plain ISO strings unchanged', () => {
    expect(parseServerTimestamp('2026-07-18T13:48:56.622Z')).toBe(1784382536622)
  })

  it('returns NaN for garbage without throwing', () => {
    expect(Number.isNaN(parseServerTimestamp('not-a-date'))).toBe(true)
    expect(Number.isNaN(parseServerTimestamp(undefined))).toBe(true)
  })
})

describe('latency stats', () => {
  it('summarizes percentiles from raw samples', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100 ms
    const s = summarize(samples)
    expect(s.count).toBe(100)
    expect(s.min).toBe(1)
    expect(s.max).toBe(100)
    expect(s.p50).toBe(50)
    expect(s.p95).toBe(95)
    expect(s.p99).toBe(99)
    expect(s.mean).toBeCloseTo(50.5)
  })

  it('handles empty input without dividing by zero', () => {
    const s = summarize([])
    expect(s.count).toBe(0)
    expect(s.p50).toBeNull()
  })
})
