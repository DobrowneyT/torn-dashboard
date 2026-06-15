/**
 * War Overview — interactive war post-mortem.
 *
 * Pulls the same data as the Python analyze_war.py script (faction_revives
 * + faction_attacks for one war) and renders it in two interactive views:
 *
 *   FACTION VIEW (default)
 *     Two stacked-bar Plotly subplots sharing the time axis.
 *       • Top   : incoming attacks on our faction, stacked by attacker faction
 *       • Bottom: incoming revives on our faction, stacked by reviver faction
 *     Click a legend entry to hide that faction (Plotly built-in).
 *     Drag the range slider at the bottom to focus on a time window — the
 *     summary stats panel below updates live with counts inside the window.
 *
 *   MEMBER VIEW (--member dropdown)
 *     Three stacked-bar subplots for one of our members:
 *       • Top    : outgoing hits, stacked by defender faction
 *       • Middle : incoming hits, stacked by attacker faction
 *       • Bottom : incoming revives, stacked by reviver faction
 *     Same legend toggling, same range slider, same windowed summary.
 *
 * Stable per-faction colors hold across all panels in a single render so
 * the war opponent (or a merc faction) is the same color top-to-bottom.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import Plot from 'react-plotly.js'
import { loadWars, loadWar, loadFactionAttacksByWindow, loadFactionRevivesByWar, loadFactionsByIds } from '../utils/warDataLoader'
import { formatWarDateRange } from '../utils/warPayoutCalculations'

const OUR_FACTION_ID = 10739

// Faction_attacks.result classifier — mirrors the same buckets the payout
// calculator uses so "attack / assist / loss" mean the same thing here as
// they do in the Hit Report. Wins (leave/mug/hosp) collapse to 'attack' for
// the member-inspector breakdown.
const WIN_RESULTS = new Set(['Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted', 'Special'])
const LOSS_RESULTS = new Set(['Lost', 'Timeout', 'Interrupted', 'Stalemate', 'Escape'])
function classifyEventType(result) {
  if (!result) return null
  if (result === 'Assist') return 'assist'
  if (WIN_RESULTS.has(result)) return 'attack'
  if (LOSS_RESULTS.has(result)) return 'loss'
  return null
}

// Plotly marker symbols for each event type — visible at a glance even when
// faction color is shared. Matches the legend annotation below the plot.
const TYPE_MARKER = { attack: 'circle', assist: 'diamond', loss: 'x' }
const TYPE_LABEL  = { attack: 'Attack', assist: 'Assist', loss: 'Loss' }

// Categorical 20-color palette (matches matplotlib's tab20 — same colors used
// by the Python script so the two stay visually consistent).
const PALETTE = [
  '#1f77b4', '#aec7e8', '#ff7f0e', '#ffbb78', '#2ca02c', '#98df8a', '#d62728', '#ff9896',
  '#9467bd', '#c5b0d5', '#8c564b', '#c49c94', '#e377c2', '#f7b6d2', '#7f7f7f', '#c7c7c7',
  '#bcbd22', '#dbdb8d', '#17becf', '#9edae5',
]

// Time-bin width auto-picked to keep the plot to roughly 50–300 bars regardless
// of how long the war ran. Matches the Python helper exactly.
function pickBinSeconds(windowSeconds) {
  if (windowSeconds <=      2 * 60)  return [5,    '5 sec']
  if (windowSeconds <=     10 * 60)  return [30,   '30 sec']
  if (windowSeconds <=     60 * 60)  return [60,   '1 min']
  if (windowSeconds <=  6 * 3600)    return [300,  '5 min']
  if (windowSeconds <= 48 * 3600)    return [3600, '1 h']
  return [6 * 3600, '6 h']
}

/**
 * Build a faction-id → color map shared across all panels of a single chart.
 * Pre-rank by total event count so the busiest faction always gets index 0.
 */
function buildColorMap(eventGroups, topN) {
  const totals = new Map()
  for (const events of eventGroups) {
    for (const e of events) {
      const fid = e.faction
      if (!fid) continue
      totals.set(fid, (totals.get(fid) ?? 0) + 1)
    }
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([fid]) => fid)
  const top = ranked.slice(0, topN)
  const map = {}
  top.forEach((fid, i) => { map[fid] = PALETTE[i % PALETTE.length] })
  return { colorMap: map, topFactions: new Set(top) }
}

/**
 * Bucket events into time bins per faction.
 * Returns { traces, otherCount } where traces is a list of Plotly bar specs.
 */
// Group a bin's reason strings into a compact tooltip suffix:
// "<br>Hospitalized by X ×3<br>Mugged ×1 …", top 8 reasons, "+N more" overflow.
// Returns '' when there are no reasons (e.g. attack panels), so the hover line
// simply doesn't appear.
function formatReasonTooltip(reasonMap) {
  if (!reasonMap || reasonMap.size === 0) return ''
  const sorted = [...reasonMap.entries()].sort((a, b) => b[1] - a[1])
  const lines = sorted.slice(0, 8).map(([r, c]) => `${r} ×${c}`)
  if (sorted.length > 8) lines.push(`+${sorted.length - 8} more`)
  return '<br>' + lines.join('<br>')
}

// Increment a reason counter inside a per-bin Map<reason,count>, lazily creating
// the bin's map. No-op when the event carries no reason (attacks).
function tallyReason(reasonBins, binIndex, reason) {
  if (!reason) return
  if (!reasonBins[binIndex]) reasonBins[binIndex] = new Map()
  const m = reasonBins[binIndex]
  m.set(reason, (m.get(reason) ?? 0) + 1)
}

function buildStackedTraces(events, fromTs, toTs, binSeconds, colorMap, topFactions, nameLookup, xaxis, yaxis, groupPrefix = '', groupTitle = '') {
  const nBins = Math.max(1, Math.floor((toTs - fromTs) / binSeconds) + 1)
  const byFaction = new Map()
  const otherCounts = new Array(nBins).fill(0)
  const fallbackCounts = new Array(nBins).fill(0)
  // Parallel per-bin reason maps (only populated when events carry a `reason`).
  const byFactionReasons = new Map()
  const otherReasons = new Array(nBins)
  const fallbackReasons = new Array(nBins)

  for (const e of events) {
    const ts = e.ts
    if (ts == null) continue
    const i = Math.min(nBins - 1, Math.max(0, Math.floor((ts - fromTs) / binSeconds)))
    const fid = e.faction
    if (!fid) {
      fallbackCounts[i] += 1
      tallyReason(fallbackReasons, i, e.reason)
      continue
    }
    if (topFactions.has(fid)) {
      if (!byFaction.has(fid)) {
        byFaction.set(fid, new Array(nBins).fill(0))
        byFactionReasons.set(fid, new Array(nBins))
      }
      byFaction.get(fid)[i] += 1
      tallyReason(byFactionReasons.get(fid), i, e.reason)
    } else {
      otherCounts[i] += 1
      tallyReason(otherReasons, i, e.reason)
    }
  }

  const xs = Array.from({ length: nBins }, (_, i) =>
    new Date((fromTs + i * binSeconds) * 1000).toISOString().replace('T', ' ').slice(0, 19)
  )

  const lg = (key) => groupPrefix ? `${groupPrefix}_${key}` : key
  const titleProp = groupTitle ? { legendgrouptitle: { text: groupTitle } } : {}
  const HOVER = '%{y} events<br>%{x|%b %d %H:%M}%{customdata}<extra>%{fullData.name}</extra>'

  const traces = []
  const orderedFactions = [...byFaction.keys()].sort((a, b) => {
    const sa = byFaction.get(a).reduce((s, v) => s + v, 0)
    const sb = byFaction.get(b).reduce((s, v) => s + v, 0)
    return sb - sa
  })
  for (const fid of orderedFactions) {
    const reasons = byFactionReasons.get(fid)
    traces.push({
      type: 'bar',
      x: xs,
      y: byFaction.get(fid),
      customdata: reasons.map(formatReasonTooltip),
      name: nameLookup[fid] ? `${nameLookup[fid]} [${fid}]` : `faction ${fid}`,
      marker: { color: colorMap[fid] || '#777' },
      legendgroup: lg(`f${fid}`),
      ...(traces.length === 0 ? titleProp : {}),
      hovertemplate: HOVER,
      xaxis, yaxis,
    })
  }
  if (otherCounts.some(c => c > 0)) {
    traces.push({
      type: 'bar', x: xs, y: otherCounts, name: 'Other',
      customdata: otherReasons.map(formatReasonTooltip),
      marker: { color: '#888' }, legendgroup: lg('other'),
      hovertemplate: HOVER, xaxis, yaxis,
    })
  }
  if (fallbackCounts.some(c => c > 0)) {
    traces.push({
      type: 'bar', x: xs, y: fallbackCounts, name: '(no faction)',
      customdata: fallbackReasons.map(formatReasonTooltip),
      marker: { color: '#444' }, legendgroup: lg('nofac'),
      hovertemplate: HOVER, xaxis, yaxis,
    })
  }
  return traces
}

/**
 * Scatter mode: one dot per event at its exact UTC timestamp (y = 1 always).
 * Faction colour coding is shared with the histogram via the same colorMap.
 */
function buildScatterTraces(events, colorMap, topFactions, nameLookup, xaxis, yaxis, groupPrefix = '', groupTitle = '') {
  // If any event carries a `type` (attack / assist / loss), encode it as the
  // per-point marker symbol so the legend can stay grouped by faction while
  // shape distinguishes event class. Hover text also calls it out by name.
  const byFaction = new Map()       // fid → { x: [], reasons: [], symbols: [], typeNames: [] }
  const other = { x: [], reasons: [], symbols: [], typeNames: [] }
  const fallback = { x: [], reasons: [], symbols: [], typeNames: [] }

  for (const e of events) {
    if (e.ts == null) continue
    const x = new Date(e.ts * 1000).toISOString().replace('T', ' ').slice(0, 19)
    const reason = e.reason ? `<br>${e.reason}` : ''
    const symbol = TYPE_MARKER[e.type] || 'circle'
    const typeName = e.type ? `<br>Type: ${TYPE_LABEL[e.type]}` : ''
    const fid = e.faction
    const push = (bucket) => { bucket.x.push(x); bucket.reasons.push(reason); bucket.symbols.push(symbol); bucket.typeNames.push(typeName) }
    if (!fid) {
      push(fallback)
    } else if (topFactions.has(fid)) {
      if (!byFaction.has(fid)) byFaction.set(fid, { x: [], reasons: [], symbols: [], typeNames: [] })
      push(byFaction.get(fid))
    } else {
      push(other)
    }
  }

  const lg = (key) => groupPrefix ? `${groupPrefix}_${key}` : key
  const titleProp = groupTitle ? { legendgrouptitle: { text: groupTitle } } : {}
  const mkScatter = (extra) => ({
    type: 'scatter', mode: 'markers',
    y: new Array(extra.x.length).fill(1),
    marker: { size: 9, opacity: 0.8, symbol: extra.symbols, ...extra.marker },
    // customdata is [reason, typeName] so hover can show both lines.
    customdata: extra.x.map((_, i) => [extra.reasons[i], extra.typeNames[i]]),
    hovertemplate: '%{x|%b %d %H:%M:%S} TCT%{customdata[0]}%{customdata[1]}<extra>' + extra.tag + '</extra>',
    xaxis, yaxis,
    x: extra.x, name: extra.name, legendgroup: extra.legendgroup,
    ...(extra.titleProp || {}),
  })

  const traces = []
  for (const [fid, b] of byFaction.entries()) {
    traces.push(mkScatter({
      x: b.x, reasons: b.reasons, symbols: b.symbols, typeNames: b.typeNames,
      name: nameLookup[fid] ? `${nameLookup[fid]} [${fid}]` : `faction ${fid}`,
      tag: '%{fullData.name}',
      marker: { color: colorMap[fid] || '#777' },
      legendgroup: lg(`f${fid}`),
      titleProp: traces.length === 0 ? titleProp : {},
    }))
  }
  if (other.x.length > 0) {
    traces.push(mkScatter({ x: other.x, reasons: other.reasons, symbols: other.symbols, typeNames: other.typeNames, name: 'Other', tag: 'Other', marker: { color: '#888' }, legendgroup: lg('other') }))
  }
  if (fallback.x.length > 0) {
    traces.push(mkScatter({ x: fallback.x, reasons: fallback.reasons, symbols: fallback.symbols, typeNames: fallback.typeNames, name: '(no faction)', tag: '(no faction)', marker: { color: '#444' }, legendgroup: lg('nofac') }))
  }
  return traces
}

/**
 * Build id → name lookup. DB names (from the factions table) are canonical;
 * inline names scraped from revive rows fill any gaps.
 */
function buildNameLookup(revives, dbNames) {
  const lookup = {}
  // Inline names from revives rows (fallback when not in DB)
  for (const r of revives) {
    if (r.reviver_faction_id && r.reviver_faction_name) lookup[r.reviver_faction_id] = r.reviver_faction_name
    if (r.target_faction_id  && r.target_faction_name)  lookup[r.target_faction_id]  = r.target_faction_name
  }
  // DB names win over inline (more canonical)
  Object.assign(lookup, dbNames)
  return lookup
}

export default function WarOverviewView() {
  const [wars, setWars] = useState([])
  const [warsLoading, setWarsLoading] = useState(true)
  const [selectedWarId, setSelectedWarId] = useState(null)
  const [war, setWar] = useState(null)
  const [revives, setRevives] = useState([])
  const [attacks, setAttacks] = useState([])
  const [factionNames, setFactionNames] = useState({})  // id → name from factions table
  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError] = useState(null)

  const [viewMode, setViewMode] = useState('faction')        // 'faction' | 'member'
  const [displayMode, setDisplayMode] = useState('histogram') // 'histogram' | 'scatter'
  const [binSizeSeconds, setBinSizeSeconds] = useState(null)  // null = auto
  const [selectedMemberId, setSelectedMemberId] = useState(null)
  const [topN, setTopN] = useState(8)

  // Time-window state driven by the range slider. null = full war range.
  const [windowRange, setWindowRange] = useState(null)

  // ── Load wars list (newest first, plenty for a dropdown) ────────────────
  useEffect(() => {
    let cancelled = false
    setWarsLoading(true)
    loadWars(100, 0)
      .then(rows => {
        if (cancelled) return
        setWars(rows)
        if (rows.length > 0 && selectedWarId == null) setSelectedWarId(rows[0].id)
      })
      .catch(e => console.error('loadWars failed:', e))
      .finally(() => { if (!cancelled) setWarsLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load attacks + revives + war row whenever the war changes ───────────
  useEffect(() => {
    if (selectedWarId == null) return
    let cancelled = false
    setDataLoading(true)
    setDataError(null)
    setWindowRange(null)  // reset window on war switch
    setSelectedMemberId(null)
    ;(async () => {
      try {
        const warRow = await loadWar(selectedWarId)
        if (cancelled) return
        setWar(warRow)
        const startAt = warRow.start_at
        const endAt = warRow.end_at || Math.floor(Date.now() / 1000)
        const [revs, atks] = await Promise.all([
          loadFactionRevivesByWar(selectedWarId),
          loadFactionAttacksByWindow(startAt, endAt),
        ])
        // Collect all faction IDs so we can resolve names from the factions table.
        const factionIds = new Set()
        for (const r of revs) {
          if (r.reviver_faction_id) factionIds.add(r.reviver_faction_id)
          if (r.target_faction_id)  factionIds.add(r.target_faction_id)
        }
        for (const a of atks) {
          if (a.attacker_faction_id) factionIds.add(a.attacker_faction_id)
          if (a.defender_faction_id) factionIds.add(a.defender_faction_id)
        }
        const fmap = await loadFactionsByIds(factionIds)
        if (cancelled) return
        setRevives(revs)
        setAttacks(atks)
        const names = {}
        for (const [id, row] of fmap.entries()) names[id] = row.name
        setFactionNames(names)
      } catch (e) {
        if (!cancelled) setDataError(e.message || String(e))
      } finally {
        if (!cancelled) setDataLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedWarId])

  // Members of our faction that appear in the loaded data (for the dropdown).
  const ourMembers = useMemo(() => {
    const map = new Map()
    for (const a of attacks) {
      if (a.attacker_faction_id === OUR_FACTION_ID && a.attacker_id) {
        if (!map.has(a.attacker_id)) map.set(a.attacker_id, a.attacker_name || `id ${a.attacker_id}`)
      }
      if (a.defender_faction_id === OUR_FACTION_ID && a.defender_id) {
        if (!map.has(a.defender_id)) map.set(a.defender_id, a.defender_name || `id ${a.defender_id}`)
      }
    }
    for (const r of revives) {
      if (r.target_faction_id === OUR_FACTION_ID && r.target_id) {
        if (!map.has(r.target_id)) map.set(r.target_id, r.target_name || `id ${r.target_id}`)
      }
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [attacks, revives])

  // ── Build the Plotly figure ─────────────────────────────────────────────
  const figure = useMemo(() => {
    if (!war) return null
    const fromTs = war.start_at
    const toTs = war.end_at || Math.floor(Date.now() / 1000)

    // Bin size: manual override or auto-pick from war duration.
    const [autoSeconds] = pickBinSeconds(toTs - fromTs)
    const binSeconds = binSizeSeconds ?? autoSeconds

    const nameLookup = buildNameLookup(revives, factionNames)
    const isScatter = displayMode === 'scatter'

    // Shared y-axis builder. `automargin` guarantees the rotated title always
    // has room (otherwise the tight left margin clips it). Scatter panels hide
    // tick labels since every event sits at y=1.
    const yAxis = (title, domain) => ({
      title: { text: title, font: { size: 13 }, standoff: 6 },
      domain,
      automargin: true,
      ...(isScatter ? { range: [0, 2], showticklabels: false, fixedrange: true } : {}),
    })

    if (viewMode === 'faction') {
      const outAtkEvents = attacks
        .filter(a => a.attacker_faction_id === OUR_FACTION_ID)
        .map(a => ({ ts: a.started, faction: a.defender_faction_id }))
      const incAtkEvents = attacks
        .filter(a => a.defender_faction_id === OUR_FACTION_ID)
        .map(a => ({ ts: a.started, faction: a.attacker_faction_id }))
      const incRevEvents = revives
        .filter(r => r.target_faction_id === OUR_FACTION_ID)
        .map(r => ({ ts: r.timestamp, faction: r.reviver_faction_id, reason: r.hospital_reason }))

      const { colorMap, topFactions } = buildColorMap([outAtkEvents, incAtkEvents, incRevEvents], topN)
      const traces = isScatter ? [
        ...buildScatterTraces(outAtkEvents, colorMap, topFactions, nameLookup, 'x', 'y',  'out', 'Outgoing'),
        ...buildScatterTraces(incAtkEvents, colorMap, topFactions, nameLookup, 'x', 'y2', 'inc', 'Incoming'),
        ...buildScatterTraces(incRevEvents, colorMap, topFactions, nameLookup, 'x', 'y3', 'rev', 'Revives'),
      ] : [
        ...buildStackedTraces(outAtkEvents, fromTs, toTs, binSeconds, colorMap, topFactions, nameLookup, 'x', 'y',  'out', 'Outgoing'),
        ...buildStackedTraces(incAtkEvents, fromTs, toTs, binSeconds, colorMap, topFactions, nameLookup, 'x', 'y2', 'inc', 'Incoming'),
        ...buildStackedTraces(incRevEvents, fromTs, toTs, binSeconds, colorMap, topFactions, nameLookup, 'x', 'y3', 'rev', 'Revives'),
      ]
      const layout = {
        ...(isScatter ? {} : { barmode: 'stack', bargap: 0.05 }),
        height: 880,
        margin: { l: 60, r: 30, t: 50, b: 70 },
        grid: { rows: 3, columns: 1, pattern: 'coupled' },
        legend: { orientation: 'v', x: 1.02, y: 1, font: { size: 11 }, tracegroupgap: 20 },
        yaxis:  yAxis('Outgoing', [0.7, 1.0]),
        yaxis2: yAxis('Incoming', [0.36, 0.66]),
        yaxis3: yAxis('Revives',  [0.0, 0.32]),
        xaxis: { type: 'date', rangeslider: { visible: true, thickness: 0.05 } },
      }
      return { traces, layout }
    }

    // Member view: 3 panels for the selected member.
    if (selectedMemberId == null) return null

    const outgoing = attacks
      .filter(a => a.attacker_id === selectedMemberId)
      .map(a => ({ ts: a.started, faction: a.defender_faction_id, type: classifyEventType(a.result) }))
    const incoming = attacks
      .filter(a => a.defender_id === selectedMemberId)
      .map(a => ({ ts: a.started, faction: a.attacker_faction_id, type: classifyEventType(a.result) }))
    const revIn = revives
      .filter(r => r.target_id === selectedMemberId)
      .map(r => ({ ts: r.timestamp, faction: r.reviver_faction_id, reason: r.hospital_reason }))

    const { colorMap, topFactions } = buildColorMap([outgoing, incoming, revIn], topN)
    const traces = isScatter ? [
      ...buildScatterTraces(outgoing, colorMap, topFactions, nameLookup, 'x', 'y',  'out', 'Outgoing'),
      ...buildScatterTraces(incoming, colorMap, topFactions, nameLookup, 'x', 'y2', 'inc', 'Incoming'),
      ...buildScatterTraces(revIn,    colorMap, topFactions, nameLookup, 'x', 'y3', 'rev', 'Revives'),
    ] : [
      ...buildStackedTraces(outgoing, fromTs, toTs, binSeconds, colorMap, topFactions, nameLookup, 'x', 'y',  'out', 'Outgoing'),
      ...buildStackedTraces(incoming, fromTs, toTs, binSeconds, colorMap, topFactions, nameLookup, 'x', 'y2', 'inc', 'Incoming'),
      ...buildStackedTraces(revIn,    fromTs, toTs, binSeconds, colorMap, topFactions, nameLookup, 'x', 'y3', 'rev', 'Revives'),
    ]
    const layout = {
      ...(isScatter ? {} : { barmode: 'stack', bargap: 0.05 }),
      height: 880,
      margin: { l: 60, r: 30, t: 50, b: 70 },
      grid: { rows: 3, columns: 1, pattern: 'coupled' },
      legend: { orientation: 'v', x: 1.02, y: 1, font: { size: 11 }, tracegroupgap: 20 },
      yaxis:  yAxis('Outgoing', [0.7, 1.0]),
      yaxis2: yAxis('Incoming', [0.36, 0.66]),
      yaxis3: yAxis('Revives',  [0.0, 0.32]),
      xaxis: { type: 'date', rangeslider: { visible: true, thickness: 0.05 } },
    }
    return { traces, layout }
  }, [war, attacks, revives, factionNames, displayMode, binSizeSeconds, viewMode, selectedMemberId, topN])

  // ── Windowed summary stats (driven by range-slider drag events) ─────────
  const summary = useMemo(() => {
    if (!war) return null
    const fromTs = windowRange?.[0] ?? war.start_at
    const toTs = windowRange?.[1] ?? (war.end_at || Math.floor(Date.now() / 1000))

    if (viewMode === 'faction') {
      let inc = 0, rev = 0
      for (const a of attacks) {
        if (a.defender_faction_id === OUR_FACTION_ID && a.started >= fromTs && a.started <= toTs) inc += 1
      }
      for (const r of revives) {
        if (r.target_faction_id === OUR_FACTION_ID && r.timestamp >= fromTs && r.timestamp <= toTs) rev += 1
      }
      return { fromTs, toTs, incoming: inc, revives: rev }
    }

    if (selectedMemberId == null) return null
    // Break out by event type so the user can see the attack/assist/loss
    // breakdown that drives payout participation.
    let rev = 0
    const out = { attack: 0, assist: 0, loss: 0, total: 0 }
    const inc = { attack: 0, assist: 0, loss: 0, total: 0 }
    for (const a of attacks) {
      if (a.started < fromTs || a.started > toTs) continue
      const t = classifyEventType(a.result)
      if (a.attacker_id === selectedMemberId) {
        out.total += 1
        if (t) out[t] += 1
      }
      if (a.defender_id === selectedMemberId) {
        inc.total += 1
        if (t) inc[t] += 1
      }
    }
    for (const r of revives) {
      if (r.timestamp >= fromTs && r.timestamp <= toTs && r.target_id === selectedMemberId) rev += 1
    }
    return { fromTs, toTs, outgoing: out, incoming: inc, revives: rev }
  }, [war, attacks, revives, factionNames, viewMode, selectedMemberId, windowRange])

  // Plotly fires `relayout` when the user drags the range slider or clicks a
  // range-selector button. Pull the new x-axis range out and update state.
  // Plotly returns date strings in the same UTC format we fed in ("YYYY-MM-DD
  // HH:MM:SS.mmm"). new Date() without a tz suffix is ambiguous across
  // browsers, so append "Z" to force UTC parsing.
  const parseUTC = s => Math.floor(new Date(s.trim().replace(' ', 'T').replace(/Z?$/, 'Z')).getTime() / 1000)
  const handleRelayout = useCallback((evt) => {
    const xa = evt['xaxis.range[0]']
    const xb = evt['xaxis.range[1]']
    const xrange = evt['xaxis.range']
    if (xa != null && xb != null) {
      setWindowRange([parseUTC(xa), parseUTC(xb)])
    } else if (Array.isArray(xrange) && xrange.length === 2) {
      setWindowRange([parseUTC(xrange[0]), parseUTC(xrange[1])])
    } else if (evt['xaxis.autorange']) {
      setWindowRange(null)
    }
  }, [])

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">War Overview</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Incoming attacks + revives plotted over time, sliceable by faction.
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">War</label>
            <select
              value={selectedWarId ?? ''}
              onChange={e => setSelectedWarId(Number(e.target.value))}
              disabled={warsLoading || !wars.length}
              className="min-w-[20rem] px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {wars.map(w => (
                <option key={w.id} value={w.id}>
                  #{w.id} — {w.opponent_name || `faction ${w.opponent_id}`}{' '}— {formatWarDateRange(w.start_at, w.end_at)}{w.end_at ? '' : ' (LIVE)'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">View</label>
            <div className="inline-flex rounded-lg border border-gray-300 dark:border-slate-600 overflow-hidden">
              <button
                onClick={() => setViewMode('faction')}
                className={`px-3 py-1.5 text-sm ${viewMode === 'faction' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300'}`}
              >
                Faction
              </button>
              <button
                onClick={() => setViewMode('member')}
                className={`px-3 py-1.5 text-sm border-l border-gray-300 dark:border-slate-600 ${viewMode === 'member' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300'}`}
              >
                Member
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Display</label>
            <div className="inline-flex rounded-lg border border-gray-300 dark:border-slate-600 overflow-hidden">
              <button
                onClick={() => setDisplayMode('histogram')}
                className={`px-3 py-1.5 text-sm ${displayMode === 'histogram' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300'}`}
              >
                Histogram
              </button>
              <button
                onClick={() => setDisplayMode('scatter')}
                className={`px-3 py-1.5 text-sm border-l border-gray-300 dark:border-slate-600 ${displayMode === 'scatter' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300'}`}
              >
                Scatter
              </button>
            </div>
          </div>
          {displayMode === 'histogram' && (
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Bin size</label>
              <div className="inline-flex rounded-lg border border-gray-300 dark:border-slate-600 overflow-hidden">
                {[
                  { label: 'Auto', value: null },
                  { label: '1m',   value: 60 },
                  { label: '5m',   value: 300 },
                  { label: '1h',   value: 3600 },
                  { label: '6h',   value: 21600 },
                  { label: '1d',   value: 86400 },
                ].map((opt, i) => (
                  <button
                    key={opt.label}
                    onClick={() => setBinSizeSeconds(opt.value)}
                    className={`px-3 py-1.5 text-sm ${i > 0 ? 'border-l border-gray-300 dark:border-slate-600' : ''} ${
                      binSizeSeconds === opt.value
                        ? 'bg-blue-600 text-white'
                        : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {viewMode === 'member' && (
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Member</label>
              <select
                value={selectedMemberId ?? ''}
                onChange={e => setSelectedMemberId(e.target.value ? Number(e.target.value) : null)}
                className="min-w-[14rem] px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— pick a member —</option>
                {ourMembers.map(m => (
                  <option key={m.id} value={m.id}>{m.name} [{m.id}]</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Top-N factions</label>
            <input
              type="number" min={3} max={20} value={topN}
              onChange={e => setTopN(Math.max(3, Math.min(20, Number(e.target.value) || 8)))}
              className="w-20 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Status banner */}
        {dataError && (
          <div className="mb-3 p-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-400">
            Failed to load data: {dataError}
          </div>
        )}
        {dataLoading && (
          <div className="mb-3 text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
            Loading attacks + revives…
          </div>
        )}

        {/* Plot */}
        {figure && !dataLoading && (
          <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-slate-700">
            <Plot
              data={figure.traces}
              layout={figure.layout}
              config={{ displayModeBar: true, responsive: true, displaylogo: false }}
              style={{ width: '100%' }}
              useResizeHandler
              onRelayout={handleRelayout}
            />
          </div>
        )}
        {/* Shape-key legend — only meaningful for member scatter where event
            type is encoded as the marker symbol. */}
        {figure && !dataLoading && viewMode === 'member' && displayMode === 'scatter' && (
          <div className="mt-2 px-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
            <span className="font-medium">Marker shape:</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-500 dark:bg-gray-400" /> Attack (leave/mug/hosp)</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rotate-45 bg-gray-500 dark:bg-gray-400" /> Assist</span>
            <span className="inline-flex items-center gap-1.5"><span className="font-mono font-bold text-gray-500 dark:text-gray-400">✕</span> Loss</span>
            <span className="italic">Color still encodes faction.</span>
          </div>
        )}
        {!dataLoading && !figure && viewMode === 'member' && (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            Pick a member to render the per-player breakdown.
          </p>
        )}

        {/* Windowed summary */}
        {summary && (
          <div className="mt-4 p-3 rounded-lg bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-700">
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">
              Window: {new Date(summary.fromTs * 1000).toUTCString().slice(5, 22)}
              {' → '}
              {new Date(summary.toTs * 1000).toUTCString().slice(5, 22)} TCT
              {windowRange == null && ' (full war)'}
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              {viewMode === 'faction' ? (
                <>
                  <StatPill label="Incoming attacks" value={summary.incoming} color="text-red-600 dark:text-red-400" />
                  <StatPill label="Incoming revives" value={summary.revives} color="text-blue-600 dark:text-blue-400" />
                </>
              ) : (
                <div className="flex flex-col gap-2 w-full">
                  {/* Outgoing breakdown: attacks (wins) / assists / losses */}
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">Outgoing</span>
                    <StatPill label="Attack" value={summary.outgoing?.attack ?? 0} color="text-emerald-600 dark:text-emerald-400" />
                    <StatPill label="Assist" value={summary.outgoing?.assist ?? 0} color="text-emerald-600 dark:text-emerald-400" />
                    <StatPill label="Loss"   value={summary.outgoing?.loss   ?? 0} color="text-emerald-600 dark:text-emerald-400" />
                    <StatPill label="Total"  value={summary.outgoing?.total  ?? 0} color="text-emerald-700 dark:text-emerald-300" />
                  </div>
                  {/* Incoming breakdown (attacker's result — Loss here = the
                      member successfully defended). */}
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">Incoming</span>
                    <StatPill label="Attack" value={summary.incoming?.attack ?? 0} color="text-red-600 dark:text-red-400" />
                    <StatPill label="Assist" value={summary.incoming?.assist ?? 0} color="text-red-600 dark:text-red-400" />
                    <StatPill label="Loss"   value={summary.incoming?.loss   ?? 0} color="text-red-600 dark:text-red-400" />
                    <StatPill label="Total"  value={summary.incoming?.total  ?? 0} color="text-red-700 dark:text-red-300" />
                  </div>
                  <div className="flex items-baseline gap-x-4">
                    <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide">Revives</span>
                    <StatPill label="Incoming" value={summary.revives ?? 0} color="text-blue-600 dark:text-blue-400" />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StatPill({ label, value, color }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={`font-mono font-bold text-lg ${color}`}>{value}</span>
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
    </div>
  )
}
