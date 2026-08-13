// #390 — talking to tornprobability, and the joins between four responses that
// were never designed to be joined.
//
// The fixtures are REAL fragments captured from the live service on 2026-08-13,
// spelling included. The spelling is the whole point: an invented fixture would
// have used one consistent form and proved nothing.
import { describe, expect, it, vi } from 'vitest'
import {
  createProbabilityClient,
  normaliseKey,
  indexByNormalisedKey,
  joinRoles,
  positionIndex,
  parseDiagramFrame,
  parseScenariosPage,
  PROBABILITY_BASE_URL,
} from '../src/oc/probabilityClient.js'

// Captured live. Note "Mob Mentality"/"Looter 1" in names against
// "MobMentality"/"Looter1" in weights — the same scenario, the same role.
const ROLE_NAMES = {
  'Mob Mentality': { P1: 'Looter 1', P2: 'Looter 2', P3: 'Looter 3', P4: 'Looter 4' },
  'Pet Project': { P1: 'Kidnapper', P2: 'Muscle', P3: 'Picklock' },
  'Cash Me if You Can': { P1: 'Thief 1', P2: 'Thief 2', P3: 'Lookout' },
}
const ROLE_WEIGHTS = {
  MobMentality: { Looter1: 33.96650646, Looter2: 26.48850715, Looter3: 18.36444021, Looter4: 21.18054618 },
  PetProject: { Kidnapper: 30.92676727, Muscle: 32.62884615, Picklock: 36.44438658 },
  CashMeIfYouCan: { Thief1: 54.18134868, Thief2: 28.04221236, Lookout: 17.77643896 },
}

describe('normaliseKey', () => {
  it('collapses the two spellings the service uses onto one', () => {
    expect(normaliseKey('Mob Mentality')).toBe(normaliseKey('MobMentality'))
    expect(normaliseKey('Looter 1')).toBe(normaliseKey('Looter1'))
    expect(normaliseKey('Cash Me if You Can')).toBe(normaliseKey('CashMeIfYouCan'))
  })

  it('does not collapse genuinely different roles', () => {
    // The normalisation has to be aggressive enough to join and no more.
    // Looter 1 and Looter 2 merging would silently halve a scenario's roles.
    expect(normaliseKey('Looter 1')).not.toBe(normaliseKey('Looter 2'))
    expect(normaliseKey('Thief 1')).not.toBe(normaliseKey('Thief 2'))
  })
})

describe('indexByNormalisedKey', () => {
  it('finds an entry under either spelling', () => {
    const idx = indexByNormalisedKey(ROLE_WEIGHTS)
    expect(idx.get(normaliseKey('Mob Mentality'))).toBeDefined()
    expect(idx.get(normaliseKey('MobMentality'))).toBeDefined()
  })

  it('tolerates a missing or empty object', () => {
    expect(indexByNormalisedKey({}).size).toBe(0)
    expect(indexByNormalisedKey(undefined as any).size).toBe(0)
  })
})

describe('joinRoles', () => {
  it('joins names to weights across the spelling difference', () => {
    // ⚠️ The hazard. A raw join on the scenario key returns nothing here, and
    // every weight would read as null — indistinguishable from a role that
    // genuinely has none.
    const roles = joinRoles('Mob Mentality', ROLE_NAMES, ROLE_WEIGHTS)
    expect(roles).toHaveLength(4)
    expect(roles.every((r) => r.weight !== null)).toBe(true)
    expect(roles[0]).toEqual({ positionId: 'P1', roleName: 'Looter 1', weight: 33.96650646 })
  })

  it('keeps roles in position order, not weights order', () => {
    // CalculateSuccess takes a CPR vector indexed by position. The weights
    // object has no guaranteed order, and sorting by it would produce a
    // plausible vector describing a crime nobody is running.
    const roles = joinRoles('Cash Me if You Can', ROLE_NAMES, ROLE_WEIGHTS)
    expect(roles.map((r) => r.positionId)).toEqual(['P1', 'P2', 'P3'])
    expect(roles.map((r) => r.roleName)).toEqual(['Thief 1', 'Thief 2', 'Lookout'])
    // Deliberately NOT weight order, which would be Thief 1, Thief 2, Lookout
    // only by coincidence here — assert the intent on a scenario where the two
    // differ.
    const mob = joinRoles('Mob Mentality', ROLE_NAMES, ROLE_WEIGHTS)
    expect(mob.map((r) => r.roleName)).toEqual(['Looter 1', 'Looter 2', 'Looter 3', 'Looter 4'])
    expect([...mob].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).map((r) => r.roleName))
      .not.toEqual(mob.map((r) => r.roleName))
  })

  it('reports a genuinely missing weight as null, having actually looked', () => {
    const roles = joinRoles('Pet Project', ROLE_NAMES, { PetProject: { Kidnapper: 30.9 } })
    expect(roles.find((r) => r.roleName === 'Kidnapper')!.weight).toBe(30.9)
    expect(roles.find((r) => r.roleName === 'Muscle')!.weight).toBeNull()
  })

  it('returns nothing for a scenario with no roles listed', () => {
    expect(joinRoles('Not A Crime', ROLE_NAMES, ROLE_WEIGHTS)).toEqual([])
  })

  it('still returns roles when the weights response omits the scenario entirely', () => {
    // Weights are a nice-to-have; the position→role mapping is load-bearing.
    // Losing the roles because a weight was missing would break the simulator
    // over a display detail.
    const roles = joinRoles('Pet Project', ROLE_NAMES, {})
    expect(roles.map((r) => r.roleName)).toEqual(['Kidnapper', 'Muscle', 'Picklock'])
    expect(roles.every((r) => r.weight === null)).toBe(true)
  })
})

describe('positionIndex', () => {
  it('orders numerically, so P10 follows P9', () => {
    // No crime has ten roles today. A lexicographic sort would be a bug waiting
    // for the first one that does.
    const ids = ['P10', 'P2', 'P1', 'P9']
    expect([...ids].sort((a, b) => positionIndex(a) - positionIndex(b)))
      .toEqual(['P1', 'P2', 'P9', 'P10'])
  })

  it('sorts anything unparseable last rather than first', () => {
    expect(positionIndex('nonsense')).toBeGreaterThan(positionIndex('P99'))
  })
})

describe('parseDiagramFrame', () => {
  const encode = (s: string) => Buffer.from(s, 'utf8').toString('base64')
  const flowchart = 'flowchart LR\n _Prelude_(["Kidnap the dogs."])\n _A0_(["Hop the fence."])'

  it('decodes the diagram frame out of the stream', () => {
    const sse = `event: diagram\ndata: ${encode(flowchart)}\n\nevent: stats\ndata: ${encode('{}')}\n\n`
    expect(parseDiagramFrame(sse)).toBe(flowchart)
  })

  it('reassembles a frame split across several data lines', () => {
    const b64 = encode(flowchart)
    const half = Math.floor(b64.length / 2)
    const sse = `event: diagram\ndata: ${b64.slice(0, half)}\ndata: ${b64.slice(half)}\n\n`
    expect(parseDiagramFrame(sse)).toBe(flowchart)
  })

  it('ignores the stats frames it is not looking for', () => {
    const sse = `event: stats\ndata: ${encode('{"money":1}')}\n\nevent: diagram\ndata: ${encode(flowchart)}\n\n`
    expect(parseDiagramFrame(sse)).toBe(flowchart)
  })

  it('refuses a truncated frame rather than returning mojibake', () => {
    // ⚠️ We abort the stream deliberately, so a partial final frame is NORMAL,
    // not an error case. Base64 decoding does not throw on it — it returns
    // garbage that would be stored as a diagram and fail much later, somewhere
    // it makes no sense.
    const b64 = encode(flowchart)
    const sse = `event: diagram\ndata: ${b64.slice(0, 20)}`
    expect(parseDiagramFrame(sse)).toBeNull()
  })

  it('returns null for a stream with no diagram at all', () => {
    expect(parseDiagramFrame('event: stats\ndata: e30=\n\n')).toBeNull()
    expect(parseDiagramFrame('')).toBeNull()
  })
})

describe('parseScenariosPage', () => {
  // Real markup, captured from the live page on 2026-08-13.
  const PAGE = `
<a class="card" href="/scenarios/view/break-the-bank">
  <span class="card-name">Break the Bank</span>
  <span class="card-meta">411 paths <span class="tag complete">Complete</span></span>
</a><a class="card" href="/scenarios/view/lock-stock">
  <span class="card-name">Lock Stock</span>
  <span class="card-meta">126 paths <span class="tag wip">In Progress</span></span>
</a><a class="card" href="/scenarios/view/guardian-angels">
  <span class="card-name">Guardian &#193;ngels</span>
  <span class="card-meta">1,204 paths <span class="tag complete">Complete</span></span>
</a>`

  it('reads completeness the API does not carry', () => {
    // ⚠️ Lock Stock returns endings summing to 1.00000 exactly like Break the
    // Bank, from a third of the observed paths. Nothing in the API response
    // distinguishes them, which is why this scrapes HTML at all.
    const rows = parseScenariosPage(PAGE)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ name: 'Break the Bank', paths: 411, isComplete: true })
    expect(rows[1]).toEqual({ name: 'Lock Stock', paths: 126, isComplete: false })
  })

  it('parses thousands separators out of the path count', () => {
    expect(parseScenariosPage(PAGE)[2].paths).toBe(1204)
  })

  it('decodes entities in scenario names, so the join still matches', () => {
    // "Guardian Ángels" really is spelled with an accent, and arrives encoded.
    // A name that fails to decode joins to nothing and the scenario vanishes.
    expect(parseScenariosPage(PAGE)[2].name).toBe('Guardian Ángels')
  })

  it('treats an unrecognised tag as NOT complete', () => {
    // Reading completeness as "the word progress is absent" would make any
    // future tag default to complete — the one direction that must not happen
    // silently.
    const odd = PAGE.replaceAll('tag complete', 'tag reviewing')
    expect(parseScenariosPage(odd).every((r) => r.isComplete === false)).toBe(true)
  })

  it('returns nothing rather than throwing on an unexpected page', () => {
    // The page is someone else's HTML and may be redesigned without notice.
    // Empty means "we learned nothing", which the mirror stores as NULL.
    expect(parseScenariosPage('<html><body>hello</body></html>')).toEqual([])
    expect(parseScenariosPage('')).toEqual([])
  })
})

describe('createProbabilityClient', () => {
  it('defaults to HTTPS on 3000', () => {
    // ⚠️ Plain HTTP to that port gets an empty reply, which reads exactly like
    // the service being down. The ticket recorded it as http:// and it is not.
    expect(PROBABILITY_BASE_URL).toBe('https://tornprobability.com:3000')
    expect(createProbabilityClient().baseUrl).toBe(PROBABILITY_BASE_URL)
  })

  it('posts the CPR vector in the shape CalculateSuccess expects', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ successChance: 0.9998, failureChance: 0.0002, goodEnding1: 0.97 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ))
    const client = createProbabilityClient({ fetchImpl: fetchImpl as any, baseUrl: 'https://x' })
    const res = await client.calculateSuccess('Break the Bank', [99, 99, 99, 99, 99, 99])

    expect(res.successChance).toBeCloseTo(0.9998)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://x/api/CalculateSuccess')
    expect(JSON.parse(init.body as string))
      .toEqual({ scenario: 'Break the Bank', parameters: [99, 99, 99, 99, 99, 99] })
  })

  it('throws on a non-200 rather than parsing an error page as data', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 }))
    const client = createProbabilityClient({ fetchImpl: fetchImpl as any, baseUrl: 'https://x' })
    await expect(client.scenarios()).rejects.toThrow(/502/)
  })

  it('escapes the scenario name in the diagram URL', async () => {
    // Every multi-word scenario name contains a space, and "Cash Me if You Can"
    // unescaped would produce a malformed request line.
    const flowchart = 'flowchart LR\n _A_(["x"])'
    const fetchImpl = vi.fn(async () => new Response(
      `event: diagram\ndata: ${Buffer.from(flowchart).toString('base64')}\n\n`,
      { status: 200 }
    ))
    const client = createProbabilityClient({ fetchImpl: fetchImpl as any, baseUrl: 'https://x' })
    await client.diagram('Cash Me if You Can')
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0])
      .toBe('https://x/events/x7k2?s=Cash%20Me%20if%20You%20Can')
  })
})
