#!/usr/bin/env node
// Mock Torn API for the #116 stress test. Serves exactly the endpoints the
// per-faction server consumes (login verification, war-room ticker roster
// fetches, setup enrichment) with deterministic synthetic data, so the load
// test measures OUR stack — never Torn, and never a real API key.
//
// Identity is stateless: a "stress key" encodes its owner's faction and
// member index, so /v2/key/info can resolve any generated key without any
// registration step. Rosters churn deterministically with time so every
// ticker fetch sees genuine state changes and broadcasts real deltas.
//
// Run:  node deploy/stress/mock-torn.mjs            (PORT, default 3999)
// Env:  MEMBERS_PER_FACTION (100), CHURN_FRACTION (0.2), CHURN_PERIOD_SEC (5)
import { createServer } from 'node:http'

const KEY_PREFIX = 'SK'

/** 16-char key encoding faction id (7 digits) + member index (4 digits). */
export function makeStressKey(factionId, memberIndex) {
  const f = String(factionId).padStart(7, '0')
  const m = String(memberIndex).padStart(4, '0')
  return `${KEY_PREFIX}${f}${m}XYZ`
}

export function parseStressKey(key) {
  const match = /^SK(\d{7})(\d{4})XYZ$/.exec(String(key ?? ''))
  if (!match) return null
  return { factionId: Number(match[1]), memberIndex: Number(match[2]) }
}

/** Member ids: unique across factions, small enough for int4 columns. */
function memberId(factionId, index) {
  return (factionId % 1_000_000) * 1_000 + index
}

/** Deterministic 32-bit hash → [0, 1). */
function unitHash(...parts) {
  let h = 2166136261
  for (const part of parts) {
    const s = String(part)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  return (h >>> 0) / 4294967296
}

/**
 * The faction's roster as of `epochMs`. Statuses are a pure function of
 * (member, time bucket): within a bucket the roster is stable; across
 * buckets ~churnFraction of members flip Okay <-> Hospital. That makes the
 * broadcast volume tunable and every run reproducible.
 */
export function rosterAt(factionId, epochMs, opts = {}) {
  const membersPerFaction = opts.membersPerFaction ?? 100
  const churnFraction = opts.churnFraction ?? 0.2
  const churnPeriodSec = opts.churnPeriodSec ?? 5
  const bucket = Math.floor(epochMs / 1000 / churnPeriodSec)
  const nowSec = Math.floor(epochMs / 1000)

  const members = []
  for (let i = 0; i < membersPerFaction; i++) {
    const id = memberId(factionId, i)
    const churns = unitHash('churn', id, bucket) < churnFraction
    const baseline = unitHash('base', id) < 0.7 // 70% Okay at rest
    const okay = churns ? !baseline : baseline
    members.push({
      id,
      name: `Stress ${factionId}-${String(i).padStart(3, '0')}`,
      level: 15 + (id % 70),
      position: i === 0 ? 'Leader' : 'Member',
      days_in_faction: 100,
      is_revivable: false,
      has_early_discharge: false,
      is_in_oc: false,
      is_on_wall: false,
      revive_setting: 'No one',
      last_action: {
        status: okay ? 'Online' : 'Offline',
        timestamp: nowSec - (okay ? 30 : 3600),
        relative: okay ? '1 minute ago' : '1 hour ago',
      },
      status: okay
        ? { description: 'Okay', details: '', state: 'Okay', until: 0 }
        : {
            description: 'In hospital',
            details: 'Stress-test injury',
            state: 'Hospital',
            until: nowSec + 600 + (unitHash('until', id, bucket) * 1200) | 0,
          },
    })
  }
  return { members }
}

function keyFromUrl(url) {
  return url.searchParams.get('key')
}

function handle(url, opts) {
  const path = url.pathname
  const parsed = parseStressKey(keyFromUrl(url))

  if (path === '/v2/key/info') {
    if (!parsed) return { error: { code: 2, error: 'Incorrect key' } }
    return {
      info: {
        user: {
          id: memberId(parsed.factionId, parsed.memberIndex),
          faction_id: parsed.factionId,
        },
        access: { level: 3, type: 'Limited Access', faction: parsed.memberIndex !== 0 },
      },
    }
  }

  if (path === '/v2/user/basic') {
    if (!parsed) return { error: { code: 2, error: 'Incorrect key' } }
    return {
      basic: {
        id: memberId(parsed.factionId, parsed.memberIndex),
        name: `Stress ${parsed.factionId}-${String(parsed.memberIndex).padStart(3, '0')}`,
        level: 15,
        gender: 'Enby',
        status: { state: 'Okay' },
      },
    }
  }

  const faction = /^\/v2\/faction\/(\d+)\/(\w+)$/.exec(path)
  if (faction) {
    const factionId = Number(faction[1])
    const selection = faction[2]
    if (selection === 'members') return rosterAt(factionId, Date.now(), opts)
    if (selection === 'basic') {
      return { basic: { id: factionId, name: `Stress Faction ${factionId}`, tag: 'STRS', members: opts.membersPerFaction ?? 100 } }
    }
    if (selection === 'chain') {
      return { chain: { current: 0, max: 10, modifier: 1, timeout: 0, start: 0, cooldown: 0, end: 0 } }
    }
    if (selection === 'rankedwars') return { rankedwars: [], _metadata: {} }
  }

  // Anything else (crimes, attacks, contributors, …): benign empty success so
  // background scraper jobs idle quietly instead of erroring.
  return {}
}

export function startMockTorn(opts = {}) {
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    const url = new URL(req.url, 'http://mock')
    const body = JSON.stringify(handle(url, opts))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 3999, () => {
      resolve({
        port: server.address().port,
        requestCount: () => requests,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = {
    port: Number(process.env.PORT ?? 3999),
    membersPerFaction: Number(process.env.MEMBERS_PER_FACTION ?? 100),
    churnFraction: Number(process.env.CHURN_FRACTION ?? 0.2),
    churnPeriodSec: Number(process.env.CHURN_PERIOD_SEC ?? 5),
  }
  const mock = await startMockTorn(opts)
  console.log(
    `mock-torn listening on :${mock.port} — ${opts.membersPerFaction} members/faction, ` +
    `${opts.churnFraction * 100}% churn every ${opts.churnPeriodSec}s`
  )
  setInterval(() => console.log(`mock-torn: ${mock.requestCount()} requests served`), 60_000).unref()
}
