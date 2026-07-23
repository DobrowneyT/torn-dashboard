// Competition metric registry (#183). Code-defined and extensible on purpose:
// the vast majority of contests measure a Torn personalstat we already snapshot
// daily into member_daily_stats.personalstats, so adding one is a config entry
// here. A genuinely new data need (a stat we don't yet fetch) is a bigger job —
// a new scraper cron pulling that API request — and would add a metric with a
// different `source` plus its own adapter. This slice ships the `personalstats`
// source with a total-delta reducer; the per-day-average reducer arrives in
// #184 and non-personalstats sources (war/OC) are later slices.
//
// `path` is the key path INTO the stored personalstats object, which Torn's v2
// API nests by category (e.g. { drugs: { xantaken } }). The leaderboard query
// extracts it with the jsonb `#>>` path operator.
//
// NOTE: the paths below are the expected Torn v2 personalstats layout, but the
// exact category nesting should be verified against a live snapshot before
// leaning on any single metric — a wrong path yields nulls (member absent from
// the board), never a wrong number.

export type MetricSource = 'personalstats'
export type MetricReducer = 'total' | 'avg_per_day'

export interface MetricDef {
  id: string
  label: string
  source: MetricSource
  /** Key path into the personalstats jsonb (Torn v2 nests by category). */
  path: string[]
  /** Reducers this metric supports; the first is the default. */
  reducers: MetricReducer[]
}

// Curated shortlist — deliberately small and sensible, not the 200+ raw keys.
export const METRICS: MetricDef[] = [
  { id: 'xanax_taken', label: 'Xanax taken', source: 'personalstats', path: ['drugs', 'xantaken'], reducers: ['total', 'avg_per_day'] },
  { id: 'attacks_won', label: 'Attacks won', source: 'personalstats', path: ['attacking', 'attacks', 'won'], reducers: ['total', 'avg_per_day'] },
  { id: 'respect_for_faction', label: 'Respect earned for faction', source: 'personalstats', path: ['attacking', 'faction', 'respect'], reducers: ['total', 'avg_per_day'] },
  { id: 'blood_withdrawn', label: 'Blood bags filled', source: 'personalstats', path: ['medical', 'blood', 'withdrawn'], reducers: ['total', 'avg_per_day'] },
  { id: 'revives', label: 'Revives made', source: 'personalstats', path: ['medical', 'revives'], reducers: ['total', 'avg_per_day'] },
  { id: 'energy_refills', label: 'Energy refills used', source: 'personalstats', path: ['other', 'refills', 'energy'], reducers: ['total', 'avg_per_day'] },
  { id: 'nerve_refills', label: 'Nerve refills used', source: 'personalstats', path: ['other', 'refills', 'nerve'], reducers: ['total', 'avg_per_day'] },
  { id: 'gym_energy_trained', label: 'Energy spent in the gym', source: 'personalstats', path: ['other', 'trains'], reducers: ['total', 'avg_per_day'] },
]

const BY_ID = new Map(METRICS.map((m) => [m.id, m]))

export function getMetric(id: string): MetricDef | undefined {
  return BY_ID.get(id)
}

// The shape the create-form dropdown consumes — no internal path leakage.
export function metricOptions(): { id: string; label: string; reducers: MetricReducer[] }[] {
  return METRICS.map((m) => ({ id: m.id, label: m.label, reducers: m.reducers }))
}
