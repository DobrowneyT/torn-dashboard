// Spy-stat providers, as pure fetch-and-parse (#889 slice 5).
//
// ⚠️ **Extracted from `spyFetch.ts`, which keeps its own DB writes.** Two
// surfaces now need "TornStats first, BSP for the rest" — the War Room and the
// Book of Grudges — and they write to different tables. The alternative was a
// second implementation, and two copies of "which field is defense" is exactly
// how surfaces end up quietly disagreeing about the same player.
//
// ⚠️ **Nothing here touches the database.** That is the whole point of the
// split: the caller decides what to do with a reading, so the War Room keeps
// writing `war_room_state_v2` and the grudge list writes `grudge_targets`,
// with neither able to break the other.

/** One provider's reading of a player's battle stats. */
export interface SpyReading {
  total: number
  str: number | null
  spd: number | null
  def: number | null
  dex: number | null
  source: 'tornstats' | 'bsp'
  /**
   * When the SPY was taken, not when we fetched it.
   *
   * ⚠️ Null for BSP, which gives no capture time. Absent, never zero — a
   * missing capture time must not read as "captured at the epoch", and it must
   * not be filled in with `now()` either, which would present an estimate of
   * unknown age as something taken this minute.
   */
  spiedAt: Date | null
}

const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Fetch a faction's TornStats spy report.
 *
 * Returns null on any failure — a dead provider is not an error here, it is a
 * reason to fall through to BSP.
 */
export async function fetchTornStatsFaction(
  tsKey: string, factionId: number | string, baseUrl = 'https://www.tornstats.com'
): Promise<any | null> {
  try {
    const resp = await fetch(`${baseUrl}/api/v2/${tsKey}/spy/faction/${factionId}`)
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

/**
 * Read a TornStats faction payload into id → reading.
 *
 * ⚠️ `minTimestamp` drops spies older than the configured floor. A spy from
 * last year is worse than no spy: it is a number people will act on, and the
 * target has trained since. Dropping it lets BSP answer instead.
 */
export function readTornStatsFaction(
  payload: any, wanted: Set<number>, minTimestamp = 0
): Map<number, SpyReading> {
  const out = new Map<number, SpyReading>()
  const entries = payload?.faction?.members
  if (!entries || typeof entries !== 'object') return out
  for (const key of Object.keys(entries)) {
    const entry = entries[key]
    const id = num(entry?.id ?? key)
    if (id === null || !wanted.has(id)) continue
    const spy = entry?.spy
    // ⚠️ A total of 0 or missing is "no spy on record", not a player with no
    // stats. Storing it would put somebody at the bottom of every sort and
    // make them look like a free hit.
    const total = num(spy?.total)
    if (total === null || total <= 0) continue
    const ts = num(spy?.timestamp)
    if (ts === null || ts < minTimestamp) continue
    out.set(id, {
      total,
      str: num(spy.strength), spd: num(spy.speed),
      def: num(spy.defense), dex: num(spy.dexterity),
      source: 'tornstats',
      spiedAt: new Date(ts * 1000),
    })
  }
  return out
}

/**
 * Fetch one player's stats from Battle Stats Predictor.
 *
 * ⚠️ BSP answers per player, so this is one call each — which is why callers
 * space them, and why TornStats (one call per faction) is tried first.
 */
export async function fetchBspStats(
  bspKey: string, id: number | string, baseUrl = 'http://www.lol-manager.com'
): Promise<SpyReading | null> {
  try {
    const resp = await fetch(`${baseUrl}/api/battlestats/${bspKey}/${id}/TornForge`)
    const data: any = await resp.json()
    return readBspStats(data)
  } catch {
    return null
  }
}

/** Parse a BSP response. Exported so the shape is testable without a server. */
export function readBspStats(data: any): SpyReading | null {
  // Result 1 and 6 are both "we have an answer"; anything else is not.
  if (!data || (data.Result !== 1 && data.Result !== 6)) return null
  const total = num(data.TBS)
  if (total === null || total <= 0) return null
  return {
    total,
    str: num(data.Strength), spd: num(data.Speed),
    def: num(data.Defense), dex: num(data.Dexterity),
    source: 'bsp',
    // ⚠️ BSP gives no capture time. NULL, never now().
    spiedAt: null,
  }
}

/** BSP rate courtesy — the legacy 30ms spacing, kept deliberate and named. */
export const BSP_SPACING_MS = 30
