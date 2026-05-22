// Shared map of personalstats entries between the Dashboard (per-member card)
// and the Leadership Member Overview (whole-faction telemetry).
//
// As of Phase 2/3, personalstats is stored in `member_daily_stats.personalstats`
// as the full nested object returned by /v2/user/{id}/personalstats?cat=all.
// Each entry below pairs a stable `key` (for column ordering / saved views)
// with a dotted `path` into that nested object and presentation hints.

export const STAT_PATHS = [
  // Drugs & items
  { key: 'xantaken',           label: 'Xanax Taken',      path: 'drugs.xanax' },
  { key: 'refills',            label: 'Energy Refills',   path: 'other.refills.energy' },
  { key: 'nerverefills',       label: 'Nerve Refills',    path: 'other.refills.nerve' },
  { key: 'energydrinkused',    label: 'Energy Drinks',    path: 'items.used.energy_drinks' },
  { key: 'boostersused',       label: 'Boosters Used',    path: 'items.used.boosters' },
  { key: 'statenhancersused',  label: 'SEs Used',         path: 'items.used.stat_enhancers' },
  { key: 'alcoholused',        label: 'Alcohol Used',     path: 'items.used.alcohol' },
  { key: 'consumablesused',    label: 'Consumables',      path: 'items.used.consumables' },
  { key: 'candyused',          label: 'Candy Used',       path: 'items.used.candy' },
  { key: 'drugsused',          label: 'Drugs Used',       path: 'drugs.total' },
  { key: 'overdosed',          label: 'Overdoses',        path: 'drugs.overdoses' },
  { key: 'rehabs',             label: 'Rehabs',           path: 'drugs.rehabilitations.amount' },

  // Combat / faction contribution
  { key: 'attackswon',         label: 'Attacks Won',      path: 'attacking.attacks.won' },
  { key: 'defendswon',         label: 'Defends Won',      path: 'attacking.defends.won' },
  { key: 'retals',             label: 'Retals',           path: 'attacking.faction.retaliations' },
  { key: 'respectforfaction',  label: 'Respect',          path: 'attacking.faction.respect' },
  { key: 'rankedwarhits',      label: 'Ranked War Hits',  path: 'attacking.faction.ranked_war_hits' },
  { key: 'rankedwarwins',      label: 'Ranked War Wins',  path: 'other.ranked_war_wins' },
  { key: 'organizedcrimes',    label: 'Organized Crimes', path: 'crimes.offenses.organized_crimes' },

  // Misc
  { key: 'trainsreceived',     label: 'Trains Received',  path: 'jobs.trains_received' },
  { key: 'peoplebusted',       label: 'Busts',            path: 'jail.busts.success' },
  { key: 'bloodwithdrawn',     label: 'Blood Withdrawn',  path: 'hospital.blood_withdrawn' },
  { key: 'criminaloffenses',   label: 'Criminal Offenses', path: 'crimes.offenses.total' },
  { key: 'missioncreditsearned', label: 'Mission Credits', path: 'missions.credits' },
  { key: 'timeplayed',         label: 'Activity (hrs)',   path: 'other.activity.time', isSeconds: true },
  { key: 'networth',           label: 'Net Worth',        path: 'networth.total', isCurrency: true },
]

// Walk a dotted path. Returns null on any missing intermediate or non-numeric leaf.
export function getByPath(obj, path) {
  if (!obj || !path) return null
  const node = path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
  if (node == null) return null
  const n = Number(node)
  return Number.isFinite(n) ? n : null
}

// Convenience: read a STAT_PATHS entry's value out of a personalstats blob.
export function getStatValue(stats, statDef) {
  return getByPath(stats, statDef.path)
}
