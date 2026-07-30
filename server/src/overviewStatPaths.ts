// Server-side mirror of the dotted personalstats paths the Member Overview grid
// can actually display (frontend/src/utils/statPaths.js `STAT_PATHS[].path`).
// The overview endpoint projects each day-row's stored personalstats down to
// just these leaves — same nested shape, far smaller payload — so long/`all`
// windows stay cheap. Keep in sync with statPaths.js when a stat is added.
export const OVERVIEW_STAT_PATHS: readonly string[] = [
  // Attacking
  'attacking.attacks.won', 'attacking.attacks.lost', 'attacking.attacks.stalemate',
  'attacking.attacks.assist', 'attacking.attacks.stealth', 'attacking.defends.won',
  'attacking.defends.lost', 'attacking.elo', 'attacking.unarmored_wins',
  'attacking.highest_level_beaten', 'attacking.escapes.player', 'attacking.escapes.foes',
  'attacking.killstreak.best', 'attacking.hits.success', 'attacking.hits.miss',
  'attacking.hits.critical', 'attacking.hits.one_hit_kills', 'attacking.damage.total',
  'attacking.damage.best', 'attacking.networth.money_mugged', 'attacking.networth.largest_mug',
  'attacking.networth.items_looted', 'attacking.ammunition.total',
  // Faction & War
  'attacking.faction.respect', 'attacking.faction.retaliations', 'attacking.faction.ranked_war_hits',
  'attacking.faction.raid_hits', 'attacking.faction.territory.wall_joins',
  'attacking.faction.territory.wall_clears', 'attacking.faction.territory.wall_time',
  'other.ranked_war_wins',
  // Crimes
  'crimes.organized_crimes', 'crimes.total', 'criminal_offenses.total',
  'criminal_offenses.sell_illegal_goods', 'criminal_offenses.theft', 'criminal_offenses.auto_theft',
  'criminal_offenses.drug_deals', 'criminal_offenses.computer', 'criminal_offenses.fraud',
  'criminal_offenses.murder', 'criminal_offenses.other',
  // Items
  'items.used.energy_drinks', 'items.used.boosters', 'items.used.stat_enhancers',
  'items.used.alcohol', 'items.used.consumables', 'items.used.candy', 'items.used.books',
  'items.used.easter_eggs', 'items.found.city', 'items.found.dump', 'items.trashed',
  'items.viruses_coded',
  // Drugs
  'drugs.xanax', 'drugs.cannabis', 'drugs.ecstasy', 'drugs.ketamine', 'drugs.lsd', 'drugs.opium',
  'drugs.pcp', 'drugs.shrooms', 'drugs.speed', 'drugs.vicodin', 'drugs.total', 'drugs.overdoses',
  'drugs.rehabilitations.amount',
  // Hospital
  'hospital.times_hospitalized', 'hospital.medical_items_used', 'hospital.blood_withdrawn',
  'hospital.reviving.revives', 'hospital.reviving.revives_received', 'hospital.reviving.skill',
  // Jail
  'jail.times_jailed', 'jail.busts.success', 'jail.busts.fails', 'jail.bails.amount', 'jail.bails.fees',
  // Trading
  'trading.items.bought.market', 'trading.items.bought.shops', 'trading.items.auctions.won',
  'trading.items.auctions.sold', 'trading.items.sent', 'trading.trades', 'trading.points.bought',
  'trading.points.sold', 'trading.bazaar.customers', 'trading.bazaar.sales', 'trading.bazaar.profit',
  'trading.item_market.sales', 'trading.item_market.revenue', 'trading.item_market.fees',
  // Finishing Hits
  'finishing_hits.heavy_artillery', 'finishing_hits.machine_guns', 'finishing_hits.rifles',
  'finishing_hits.sub_machine_guns', 'finishing_hits.shotguns', 'finishing_hits.pistols',
  'finishing_hits.temporary', 'finishing_hits.piercing', 'finishing_hits.slashing',
  'finishing_hits.clubbing', 'finishing_hits.mechanical', 'finishing_hits.hand_to_hand',
  // Communication
  'communication.mails_sent.total', 'communication.mails_sent.friends',
  'communication.mails_sent.faction', 'communication.mails_sent.colleagues',
  'communication.classified_ads', 'communication.personals',
  // Travel
  'travel.total', 'travel.time_spent', 'travel.items_bought', 'travel.hunting.skill',
  'travel.attacks_won', 'travel.defends_lost',
  // Jobs
  'jobs.job_points_used', 'jobs.trains_received',
  // Racing
  'racing.skill', 'racing.points', 'racing.races.entered', 'racing.races.won',
  // Missions
  'missions.credits', 'missions.missions', 'missions.contracts.total', 'missions.contracts.duke',
  // Misc
  'other.refills.energy', 'other.refills.nerve', 'other.refills.token', 'other.activity.time',
  'other.activity.streak.current', 'other.activity.streak.best', 'other.awards',
  'other.merits_bought', 'other.donator_days', 'networth.total',
  'bounties.placed.amount', 'bounties.collected.amount', 'bounties.received.amount',
]

/**
 * Rebuild a personalstats object containing only the catalog paths present in
 * `full`, preserving the nested shape so the client's dotted-path lookups work
 * unchanged. Missing paths are simply omitted.
 */
export function projectPersonalstats(full: unknown, paths: readonly string[] = OVERVIEW_STAT_PATHS): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (full == null || typeof full !== 'object') return out
  for (const path of paths) {
    const parts = path.split('.')
    let src: any = full
    let ok = true
    for (const p of parts) {
      if (src == null || typeof src !== 'object') { ok = false; break }
      src = src[p]
    }
    if (!ok || src === undefined) continue
    let dst: Record<string, unknown> = out
    for (let i = 0; i < parts.length - 1; i++) {
      if (dst[parts[i]] == null || typeof dst[parts[i]] !== 'object') dst[parts[i]] = {}
      dst = dst[parts[i]] as Record<string, unknown>
    }
    dst[parts[parts.length - 1]] = src
  }
  return out
}
