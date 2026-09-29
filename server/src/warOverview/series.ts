// Pre-binned series for the Discord bot's chart (#811 slice 4).
//
// ⚠️ **The bot draws bars; it does not decide what goes in them.** Binning,
// faction ranking, colour assignment and the event classifier all happen here,
// so the PNG in Discord and the plot on the page are the same arithmetic.
// Shipping raw rows and binning in Python would be a THIRD implementation of
// logic that has already drifted three times in this repo — `LOSS_RESULTS` in
// two files, `classifyEventType` local to the view, `WIN_RESULTS` disagreeing
// about `Special`.
//
// ⚠️ The bin widths and the palette are deliberate copies of
// `WarOverviewView.jsx` and must stay in step with it. They are display
// constants rather than arithmetic — a war rendered with different bins in
// Discord and on the page looks like different data.
import { classifyEventType, factionKey, reviveOutcome, NO_FACTION_ID } from './summary.js'

/** Matplotlib's tab20, which the page also uses so the two look alike. */
export const PALETTE = [
  '#1f77b4', '#aec7e8', '#ff7f0e', '#ffbb78', '#2ca02c', '#98df8a', '#d62728', '#ff9896',
  '#9467bd', '#c5b0d5', '#8c564b', '#c49c94', '#e377c2', '#f7b6d2', '#7f7f7f', '#c7c7c7',
  '#bcbd22', '#dbdb8d', '#17becf', '#9edae5',
]

export const REVIVE_COLOURS = { success: '#3b82f6', failure: '#f97316' }

/**
 * Bin width, chosen to keep the plot to roughly 50–300 bars.
 *
 * ⚠️ Identical to `pickBinSeconds` in WarOverviewView.jsx.
 */
export function pickBinSeconds(windowSeconds: number): number {
  if (windowSeconds <= 2 * 60) return 5
  if (windowSeconds <= 10 * 60) return 30
  if (windowSeconds <= 60 * 60) return 60
  if (windowSeconds <= 6 * 3600) return 300
  if (windowSeconds <= 48 * 3600) return 3600
  return 6 * 3600
}

/** How many factions get their own colour before the rest become "Other". */
export const MAX_SERIES = 8

export interface Series { label: string; colour: string; values: number[] }
export interface Panel { key: string; title: string; series: Series[] }
export interface Chart { bin_seconds: number; x_ms: number[]; panels: Panel[] }

interface Ev { ts: number; faction: number }

export interface SeriesArgs {
  attacks: any[]
  revives: any[]
  fromTs: number
  toTs: number
  ourFactionId: number
  selectedFactionIds?: Set<number> | null
  mode?: 'faction' | 'member'
  memberId?: number | null
  factionNames?: Record<number, string>
}

/**
 * Three panels of stacked series: outgoing, incoming, revives.
 *
 * ⚠️ Panel order matches the page's chart AND its summary rows, so somebody
 * holding a screenshot of one against the other sees the same shape.
 */
export function buildChart({
  attacks, revives, fromTs, toTs, ourFactionId,
  selectedFactionIds = null, mode = 'faction', memberId = null, factionNames = {},
}: SeriesArgs): Chart {
  const binSeconds = pickBinSeconds(Math.max(1, toTs - fromTs))
  const nBins = Math.max(1, Math.floor((toTs - fromTs) / binSeconds) + 1)
  const x_ms = Array.from({ length: nBins }, (_, i) => (fromTs + i * binSeconds) * 1000)
  const idxOf = (ts: number) =>
    Math.min(nBins - 1, Math.max(0, Math.floor((ts - fromTs) / binSeconds)))

  const picked = (fid: unknown) =>
    selectedFactionIds == null || selectedFactionIds.has(factionKey(fid))

  const out: Ev[] = []
  const inc: Ev[] = []
  for (const a of attacks) {
    const ts = Number(a.started)
    if (ts < fromTs || ts > toTs) continue
    // ⚠️ Only classified events are plotted, matching the page — an
    // unrecognised result is a visible gap rather than a guess.
    if (!classifyEventType(a.result)) continue

    const isOurs = mode === 'member'
      ? Number(a.attacker_id) === Number(memberId)
      : Number(a.attacker_faction_id) === Number(ourFactionId)
    if (isOurs && picked(a.defender_faction_id)) {
      out.push({ ts, faction: factionKey(a.defender_faction_id) })
    }
    const isAgainstUs = mode === 'member'
      ? Number(a.defender_id) === Number(memberId)
      : Number(a.defender_faction_id) === Number(ourFactionId)
    if (isAgainstUs && picked(a.attacker_faction_id)) {
      inc.push({ ts, faction: factionKey(a.attacker_faction_id) })
    }
  }

  // ⚠️ ONE colour map across both attack panels, ranked by total events, so the
  // same faction is the same colour top and bottom. Two independently ranked
  // maps would recolour the opponent between panels, which reads as two
  // different factions.
  const totals = new Map<number, number>()
  for (const e of [...out, ...inc]) totals.set(e.faction, (totals.get(e.faction) ?? 0) + 1)
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
  const top = ranked.slice(0, MAX_SERIES)
  const restSet = new Set(ranked.slice(MAX_SERIES))
  const colour = new Map<number, string>()
  top.forEach((f, i) => colour.set(f, PALETTE[i % PALETTE.length]))

  const label = (fid: number) =>
    fid === NO_FACTION_ID ? '(no faction)'
      : factionNames[fid] ? `${factionNames[fid]} [${fid}]` : `faction ${fid}`

  const panelFor = (key: string, title: string, events: Ev[]): Panel => {
    const rows = new Map<number, number[]>()
    for (const f of top) rows.set(f, new Array(nBins).fill(0))
    const other = new Array(nBins).fill(0)
    for (const e of events) {
      const row = rows.get(e.faction)
      if (row) row[idxOf(e.ts)] += 1
      // ⚠️ Everything past MAX_SERIES still counted, so the stacked bar heights
      // match the summary totals. Dropping them would make the chart quietly
      // disagree with the numbers printed beside it.
      else if (restSet.has(e.faction)) other[idxOf(e.ts)] += 1
    }
    const series: Series[] = []
    for (const f of top) {
      const values = rows.get(f)!
      if (values.some((v) => v > 0)) {
        series.push({ label: label(f), colour: colour.get(f)!, values })
      }
    }
    if (other.some((v: number) => v > 0)) {
      series.push({ label: `Other (${restSet.size})`, colour: '#888888', values: other })
    }
    return { key, title, series }
  }

  // ⚠️ Revives split by OUTCOME and never by faction — the page's rule.
  // Faction-filtering them is what emptied its revive panel.
  const rev = { success: new Array(nBins).fill(0), failure: new Array(nBins).fill(0) }
  for (const r of revives) {
    const ts = Number(r.timestamp)
    if (ts < fromTs || ts > toTs) continue
    const mine = mode === 'member'
      ? Number(r.target_id) === Number(memberId)
      : Number(r.target_faction_id) === Number(ourFactionId)
    if (!mine) continue
    rev[reviveOutcome(r)][idxOf(ts)] += 1
  }

  return {
    bin_seconds: binSeconds,
    x_ms,
    panels: [
      panelFor('outgoing', 'Outgoing', out),
      panelFor('incoming', 'Incoming', inc),
      {
        key: 'revives',
        title: 'Revives',
        series: ([
          { label: 'Revived', colour: REVIVE_COLOURS.success, values: rev.success },
          { label: 'Failed revive', colour: REVIVE_COLOURS.failure, values: rev.failure },
        ] as Series[]).filter((s) => s.values.some((v) => v > 0)),
      },
    ],
  }
}
