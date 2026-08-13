/**
 * Talking to tornprobability.com (#390).
 *
 * Everything here is about the joins between four responses that were clearly
 * never designed to be joined, so the module's real job is normalisation and
 * refusing to guess when a join fails.
 *
 * ⚠️ HTTPS on port 3000, not HTTP. The ticket recorded `http://…:3000`; plain
 * HTTP to that port gets an empty reply, which reads exactly like the service
 * being down and would send anyone debugging it in the wrong direction.
 */

export const PROBABILITY_BASE_URL = 'https://tornprobability.com:3000'

export interface ScenarioSummary {
  name: string
  parameters: number
}

export interface CalculateSuccessResponse {
  successChance: number
  failureChance: number
  [endingKey: string]: number
}

export interface ProbabilityClientOptions {
  baseUrl?: string
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * The key normalisation, and the reason this module exists.
 *
 * Confirmed against the live service on 2026-08-13:
 *
 *   GetSupportedScenarios  "Mob Mentality"     GetRoleNames  "Looter 1"
 *   GetRoleWeights         "MobMentality"      GetRoleWeights "Looter1"
 *
 * The same scenario and the same role, spelled two ways. A raw join drops every
 * multi-word name — which is most of them — and a dropped weight is
 * indistinguishable from a role that genuinely has none.
 */
export const normaliseKey = (s: string) => s.replace(/[\s#_-]/g, '').toLowerCase()

/** Index an object by normalised key, so either spelling finds the entry. */
export function indexByNormalisedKey<T>(obj: Record<string, T>): Map<string, T> {
  const out = new Map<string, T>()
  for (const [k, v] of Object.entries(obj ?? {})) out.set(normaliseKey(k), v)
  return out
}

export interface ScenarioRole {
  positionId: string
  roleName: string
  /** null when the weights response had no entry for this role. */
  weight: number | null
}

/**
 * Join role names to role weights for one scenario.
 *
 * Position order comes from the NAMES response, not the weights: the CPR vector
 * CalculateSuccess expects is indexed by P1..PN, and the weights object is a
 * plain map with no guaranteed order. Sorting the weights would produce a
 * plausible vector in the wrong order — numbers that all look fine and a
 * success chance for a crime nobody is running.
 */
export function joinRoles(
  scenarioName: string,
  roleNames: Record<string, Record<string, string>>,
  roleWeights: Record<string, Record<string, number>>
): ScenarioRole[] {
  const namesByScenario = indexByNormalisedKey(roleNames)
  const weightsByScenario = indexByNormalisedKey(roleWeights)

  const names = namesByScenario.get(normaliseKey(scenarioName))
  if (!names) return []

  const weights = weightsByScenario.get(normaliseKey(scenarioName))
  const weightsByRole = weights ? indexByNormalisedKey(weights) : null

  return Object.entries(names)
    // "P10" must sort after "P9", so compare the numeric suffix rather than
    // the string. A six-role crime is the current maximum, but a lexicographic
    // sort here would be a bug waiting for the seventh.
    .sort((a, b) => positionIndex(a[0]) - positionIndex(b[0]))
    .map(([positionId, roleName]) => ({
      positionId,
      roleName,
      weight: weightsByRole?.get(normaliseKey(roleName)) ?? null,
    }))
}

/** "P3" → 3. Returns a large number for anything unparseable, so it sorts last. */
export function positionIndex(positionId: string): number {
  const m = /^P(\d+)$/i.exec(positionId)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

export interface ScenarioCompleteness {
  name: string
  /** How many observed paths the model was built from. */
  paths: number | null
  isComplete: boolean
}

/**
 * Completeness, scraped from the `/scenarios` HTML page.
 *
 * ⚠️ This exists ONLY on that page. The API does not carry it, and an
 * in-progress scenario answers with numbers that look exactly as authoritative
 * as a finished one — Lock Stock returns endings summing to 1.00000 just like
 * Break the Bank, while being built from a fraction of the observed paths.
 * Nothing in the response distinguishes them. A simulator that states a number
 * with false confidence is #376 again, so this is worth scraping HTML for.
 *
 * Verified against the live page on 2026-08-13: 27 Complete, 4 In Progress.
 */
export function parseScenariosPage(html: string): ScenarioCompleteness[] {
  const out: ScenarioCompleteness[] = []
  // Cards are <a class="card">, each with a name span and a meta span carrying
  // "411 paths <span class="tag complete">Complete</span>".
  const cardRe = /<span class="card-name">([^<]*)<\/span>\s*<span class="card-meta">([\s\S]*?)<\/span>\s*<\/a>/g
  for (const m of html.matchAll(cardRe)) {
    const name = decodeEntities(m[1].trim())
    const meta = m[2]
    const paths = /([\d,]+)\s*paths/i.exec(meta)
    // Read the TAG, not the absence of the word "progress": a future tag we do
    // not recognise must not silently read as complete.
    const tag = /<span class="tag (\w+)"/.exec(meta)?.[1]?.toLowerCase()
    out.push({
      name,
      paths: paths ? Number(paths[1].replace(/,/g, '')) : null,
      isComplete: tag === 'complete',
    })
  }
  return out
}

/** The page is HTML; names like "Guardian Ángels" arrive encoded. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function createProbabilityClient(opts: ProbabilityClientOptions = {}) {
  const baseUrl = opts.baseUrl ?? PROBABILITY_BASE_URL
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 20_000

  async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(`${baseUrl}${path}`, { ...init, signal: controller.signal })
      if (!res.ok) throw new Error(`${path} responded ${res.status}`)
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    baseUrl,

    scenarios: () => getJson<ScenarioSummary[]>('/api/GetSupportedScenarios'),

    /** Completeness per scenario, from the HTML page — the API omits it. */
    async completeness(): Promise<ScenarioCompleteness[]> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await doFetch(`${baseUrl}/scenarios`, { signal: controller.signal })
        if (!res.ok) throw new Error(`/scenarios responded ${res.status}`)
        return parseScenariosPage(await res.text())
      } finally {
        clearTimeout(timer)
      }
    },

    roleNames: () => getJson<Record<string, Record<string, string>>>('/api/GetRoleNames'),
    roleWeights: () => getJson<Record<string, Record<string, number>>>('/api/GetRoleWeights'),

    calculateSuccess: (scenario: string, parameters: number[]) =>
      getJson<CalculateSuccessResponse>('/api/CalculateSuccess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario, parameters }),
      }),

    /**
     * The mermaid flowchart for one scenario, from the SSE feed.
     *
     * ⚠️ Read incrementally, and NOT with `res.text()`. This is an event stream
     * the server holds open after sending the diagram — `text()` waits for an
     * end that never comes, so it would abort on the timeout every single time
     * and the diagram we already received would be thrown away with it.
     *
     * So: consume chunks until a COMPLETE diagram frame has arrived, then hang
     * up. Taking what we need and closing the connection is also the polite
     * thing to do to someone else's small server on a once-a-day mirror.
     */
    async diagram(scenario: string): Promise<string> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await doFetch(
          `${baseUrl}/events/x7k2?s=${encodeURIComponent(scenario)}`,
          { signal: controller.signal, headers: { Accept: 'text/event-stream' } }
        )
        if (!res.ok) throw new Error(`diagram feed responded ${res.status}`)
        if (!res.body) throw new Error(`diagram feed for ${scenario} returned no body`)

        const decoder = new TextDecoder()
        let buffered = ''
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffered += decoder.decode(chunk as Uint8Array, { stream: true })
          const diagram = parseDiagramFrame(buffered)
          if (diagram) return diagram
        }
        // Stream ended without one. Try the tail in case the final frame closed
        // the body rather than being followed by a separator.
        const diagram = parseDiagramFrame(buffered.endsWith('\n\n') ? buffered : `${buffered}\n\n`)
        if (!diagram) throw new Error(`no diagram frame for ${scenario}`)
        return diagram
      } finally {
        clearTimeout(timer)
        // Closes the connection whether we succeeded, threw, or timed out.
        controller.abort()
      }
    },
  }
}

/**
 * Pull the base64 mermaid out of an SSE stream's first `diagram` frame.
 *
 * Exported and tested separately because the stream is the awkward part: frames
 * are separated by blank lines, `data:` may repeat across lines for one frame,
 * and a truncated read (which is normal — we abort the stream deliberately) can
 * leave a partial final frame that must not be decoded as if it were whole.
 */
export function parseDiagramFrame(sse: string): string | null {
  const frames = sse.split(/\r?\n\r?\n/)

  // ⚠️ An SSE frame is terminated by a blank line, so a trailing segment with
  // no terminator is by definition incomplete. This matters more than it looks:
  // truncated base64 does not fail to decode, it decodes to a PREFIX. Half a
  // diagram still starts with "flowchart LR", passes every sanity check below,
  // and gets stored as a complete flowchart with most of its nodes missing.
  // The tree parser would then validate it and report unreachable endings for a
  // crime that has none.
  if (!/\r?\n\r?\n$/.test(sse)) frames.pop()

  for (const frame of frames) {
    const lines = frame.split(/\r?\n/)
    const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim()
    if (event !== 'diagram') continue
    const data = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('')
    if (!data) continue
    try {
      const decoded = Buffer.from(data, 'base64').toString('utf8')
      // A partial frame decodes to mojibake rather than throwing, so check it
      // actually looks like the thing we asked for.
      if (!/^\s*flowchart\s/i.test(decoded)) continue
      return decoded
    } catch {
      continue
    }
  }
  return null
}
