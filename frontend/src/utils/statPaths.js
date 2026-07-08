// Shared map of personalstats entries between the Dashboard (per-member card)
// and the Leadership Member Overview (whole-faction telemetry).
//
// personalstats is stored in `member_daily_stats.personalstats` as the full
// nested object returned by /v2/user/{id}/personalstats?cat=all. Each entry
// below pairs a stable `key` (used for column ordering / saved views and as
// the threshold lookup key) with a dotted `path` into that nested object,
// the category it belongs to, and presentation hints.
//
// Categories drive the grouping in the stat-picker modal.

export const STAT_CATEGORIES = [
  { id: 'attacking',     label: 'Attacking' },
  { id: 'faction',       label: 'Faction & War' },
  { id: 'crimes',        label: 'Crimes' },
  { id: 'items',         label: 'Items' },
  { id: 'drugs',         label: 'Drugs' },
  { id: 'hospital',      label: 'Hospital' },
  { id: 'jail',          label: 'Jail' },
  { id: 'trading',       label: 'Trading' },
  { id: 'finishing',     label: 'Finishing Hits' },
  { id: 'communication', label: 'Communication' },
  { id: 'travel',        label: 'Travel' },
  { id: 'jobs',          label: 'Jobs' },
  { id: 'racing',        label: 'Racing' },
  { id: 'missions',      label: 'Missions' },
  { id: 'misc',          label: 'Misc' },
]

export const STAT_PATHS = [
  // ── Attacking ───────────────────────────────────────────────────────────
  { key: 'attackswon',          label: 'Attacks Won',         category: 'attacking', path: 'attacking.attacks.won' },
  { key: 'attackslost',         label: 'Attacks Lost',        category: 'attacking', path: 'attacking.attacks.lost' },
  { key: 'attacksstalemate',    label: 'Attack Stalemates',   category: 'attacking', path: 'attacking.attacks.stalemate' },
  { key: 'attacksassist',       label: 'Attack Assists',      category: 'attacking', path: 'attacking.attacks.assist' },
  { key: 'attacksstealth',      label: 'Stealth Attacks',     category: 'attacking', path: 'attacking.attacks.stealth' },
  { key: 'defendswon',          label: 'Defends Won',         category: 'attacking', path: 'attacking.defends.won' },
  { key: 'defendslost',         label: 'Defends Lost',        category: 'attacking', path: 'attacking.defends.lost' },
  { key: 'elo',                 label: 'ELO',                 category: 'attacking', path: 'attacking.elo', noPerDay: true },
  { key: 'unarmoredwins',       label: 'Unarmored Wins',      category: 'attacking', path: 'attacking.unarmored_wins' },
  { key: 'highestlevelbeaten',  label: 'Highest Lvl Beaten',  category: 'attacking', path: 'attacking.highest_level_beaten', noPerDay: true },
  { key: 'escapesplayer',       label: 'Escapes (You)',       category: 'attacking', path: 'attacking.escapes.player' },
  { key: 'escapesfoes',         label: 'Escapes (Foes)',      category: 'attacking', path: 'attacking.escapes.foes' },
  { key: 'killstreakbest',      label: 'Best Killstreak',     category: 'attacking', path: 'attacking.killstreak.best', noPerDay: true },
  { key: 'hitssuccess',         label: 'Hits Landed',         category: 'attacking', path: 'attacking.hits.success' },
  { key: 'hitsmiss',            label: 'Hits Missed',         category: 'attacking', path: 'attacking.hits.miss' },
  { key: 'hitscritical',        label: 'Critical Hits',       category: 'attacking', path: 'attacking.hits.critical' },
  { key: 'onehitkills',         label: 'One-Hit Kills',       category: 'attacking', path: 'attacking.hits.one_hit_kills' },
  { key: 'damagetotal',         label: 'Damage Dealt',        category: 'attacking', path: 'attacking.damage.total' },
  { key: 'damagebest',          label: 'Best Damage Hit',     category: 'attacking', path: 'attacking.damage.best', noPerDay: true },
  { key: 'moneymugged',         label: 'Money Mugged',        category: 'attacking', path: 'attacking.networth.money_mugged', isCurrency: true },
  { key: 'largestmug',          label: 'Largest Mug',         category: 'attacking', path: 'attacking.networth.largest_mug', isCurrency: true, noPerDay: true },
  { key: 'itemslooted',         label: 'Items Looted',        category: 'attacking', path: 'attacking.networth.items_looted' },
  { key: 'ammoused',            label: 'Ammo Used',           category: 'attacking', path: 'attacking.ammunition.total' },

  // ── Faction & War ───────────────────────────────────────────────────────
  { key: 'respectforfaction',   label: 'Respect',             category: 'faction', path: 'attacking.faction.respect' },
  { key: 'retals',              label: 'Retals',              category: 'faction', path: 'attacking.faction.retaliations' },
  { key: 'rankedwarhits',       label: 'Ranked War Hits',     category: 'faction', path: 'attacking.faction.ranked_war_hits' },
  { key: 'raidhits',            label: 'Raid Hits',           category: 'faction', path: 'attacking.faction.raid_hits' },
  { key: 'walljoins',           label: 'Territory Wall Joins',category: 'faction', path: 'attacking.faction.territory.wall_joins' },
  { key: 'wallclears',          label: 'Territory Wall Clears', category: 'faction', path: 'attacking.faction.territory.wall_clears' },
  { key: 'walltime',            label: 'Wall Time (hrs)',     category: 'faction', path: 'attacking.faction.territory.wall_time', isSeconds: true },
  { key: 'rankedwarwins',       label: 'Ranked War Wins',     category: 'faction', path: 'other.ranked_war_wins' },

  // ── Crimes ──────────────────────────────────────────────────────────────
  { key: 'organizedcrimes',     label: 'Organized Crimes',    category: 'crimes', path: 'crimes.organized_crimes' },
  { key: 'crimestotal',         label: 'Crimes Total',        category: 'crimes', path: 'crimes.total' },
  { key: 'criminaloffenses',    label: 'Criminal Offenses',   category: 'crimes', path: 'criminal_offenses.total' },
  { key: 'crimes_sellillegal',  label: 'Sell Illegal Goods',  category: 'crimes', path: 'criminal_offenses.sell_illegal_goods' },
  { key: 'crimes_theft',        label: 'Theft',               category: 'crimes', path: 'criminal_offenses.theft' },
  { key: 'crimes_autotheft',    label: 'Auto Theft',          category: 'crimes', path: 'criminal_offenses.auto_theft' },
  { key: 'crimes_drugdeals',    label: 'Drug Deals',          category: 'crimes', path: 'criminal_offenses.drug_deals' },
  { key: 'crimes_computer',     label: 'Computer Crimes',     category: 'crimes', path: 'criminal_offenses.computer' },
  { key: 'crimes_fraud',        label: 'Fraud',               category: 'crimes', path: 'criminal_offenses.fraud' },
  { key: 'crimes_murder',       label: 'Murder',              category: 'crimes', path: 'criminal_offenses.murder' },
  { key: 'crimes_other',        label: 'Other Crimes',        category: 'crimes', path: 'criminal_offenses.other' },

  // ── Items ───────────────────────────────────────────────────────────────
  { key: 'energydrinkused',     label: 'Energy Drinks',       category: 'items', path: 'items.used.energy_drinks' },
  { key: 'boostersused',        label: 'Boosters Used',       category: 'items', path: 'items.used.boosters' },
  { key: 'statenhancersused',   label: 'SEs Used',            category: 'items', path: 'items.used.stat_enhancers' },
  { key: 'alcoholused',         label: 'Alcohol Used',        category: 'items', path: 'items.used.alcohol' },
  { key: 'consumablesused',     label: 'Consumables Used',    category: 'items', path: 'items.used.consumables' },
  { key: 'candyused',           label: 'Candy Used',          category: 'items', path: 'items.used.candy' },
  { key: 'booksused',           label: 'Books Used',          category: 'items', path: 'items.used.books' },
  { key: 'eastereggsused',      label: 'Easter Eggs Used',    category: 'items', path: 'items.used.easter_eggs' },
  { key: 'itemsfoundcity',      label: 'City Finds',          category: 'items', path: 'items.found.city' },
  { key: 'itemsfounddump',      label: 'Dump Finds',          category: 'items', path: 'items.found.dump' },
  { key: 'itemstrashed',        label: 'Items Trashed',       category: 'items', path: 'items.trashed' },
  { key: 'virusescoded',        label: 'Viruses Coded',       category: 'items', path: 'items.viruses_coded' },

  // ── Drugs ───────────────────────────────────────────────────────────────
  { key: 'xantaken',            label: 'Xanax Taken',         category: 'drugs', path: 'drugs.xanax' },
  { key: 'cannabis',            label: 'Cannabis',            category: 'drugs', path: 'drugs.cannabis' },
  { key: 'ecstasy',             label: 'Ecstasy',             category: 'drugs', path: 'drugs.ecstasy' },
  { key: 'ketamine',            label: 'Ketamine',            category: 'drugs', path: 'drugs.ketamine' },
  { key: 'lsd',                 label: 'LSD',                 category: 'drugs', path: 'drugs.lsd' },
  { key: 'opium',               label: 'Opium',               category: 'drugs', path: 'drugs.opium' },
  { key: 'pcp',                 label: 'PCP',                 category: 'drugs', path: 'drugs.pcp' },
  { key: 'shrooms',             label: 'Shrooms',             category: 'drugs', path: 'drugs.shrooms' },
  { key: 'speed',               label: 'Speed',               category: 'drugs', path: 'drugs.speed' },
  { key: 'vicodin',             label: 'Vicodin',             category: 'drugs', path: 'drugs.vicodin' },
  { key: 'drugsused',           label: 'Total Drugs',         category: 'drugs', path: 'drugs.total' },
  { key: 'overdosed',           label: 'Overdoses',           category: 'drugs', path: 'drugs.overdoses' },
  { key: 'rehabs',              label: 'Rehabs',              category: 'drugs', path: 'drugs.rehabilitations.amount' },

  // ── Hospital ────────────────────────────────────────────────────────────
  { key: 'timeshospitalized',   label: 'Times Hospitalized',  category: 'hospital', path: 'hospital.times_hospitalized' },
  { key: 'medicalitemsused',    label: 'Medical Items',       category: 'hospital', path: 'hospital.medical_items_used' },
  { key: 'bloodwithdrawn',      label: 'Blood Withdrawn',     category: 'hospital', path: 'hospital.blood_withdrawn' },
  { key: 'revives',             label: 'Revives Given',       category: 'hospital', path: 'hospital.reviving.revives' },
  { key: 'revivesreceived',     label: 'Revives Received',    category: 'hospital', path: 'hospital.reviving.revives_received' },
  { key: 'reviveskill',         label: 'Revive Skill',        category: 'hospital', path: 'hospital.reviving.skill', noPerDay: true },

  // ── Jail ────────────────────────────────────────────────────────────────
  { key: 'timesjailed',         label: 'Times Jailed',        category: 'jail', path: 'jail.times_jailed' },
  { key: 'bustssuccess',        label: 'Busts',               category: 'jail', path: 'jail.busts.success' },
  { key: 'bustsfails',          label: 'Bust Fails',          category: 'jail', path: 'jail.busts.fails' },
  { key: 'bailsamount',         label: 'Bails Posted',        category: 'jail', path: 'jail.bails.amount' },
  { key: 'bailsfees',           label: 'Bail Fees',           category: 'jail', path: 'jail.bails.fees', isCurrency: true },

  // ── Trading ─────────────────────────────────────────────────────────────
  { key: 'itemboughtmarket',    label: 'Market Buys',         category: 'trading', path: 'trading.items.bought.market' },
  { key: 'itemboughtshops',     label: 'Shop Buys',           category: 'trading', path: 'trading.items.bought.shops' },
  { key: 'auctionswon',         label: 'Auctions Won',        category: 'trading', path: 'trading.items.auctions.won' },
  { key: 'auctionssold',        label: 'Auctions Sold',       category: 'trading', path: 'trading.items.auctions.sold' },
  { key: 'itemssent',           label: 'Items Sent',          category: 'trading', path: 'trading.items.sent' },
  { key: 'trades',              label: 'Trades',              category: 'trading', path: 'trading.trades' },
  { key: 'pointsbought',        label: 'Points Bought',       category: 'trading', path: 'trading.points.bought' },
  { key: 'pointssold',          label: 'Points Sold',         category: 'trading', path: 'trading.points.sold' },
  { key: 'bazaarcustomers',     label: 'Bazaar Customers',    category: 'trading', path: 'trading.bazaar.customers' },
  { key: 'bazaarsales',         label: 'Bazaar Sales',        category: 'trading', path: 'trading.bazaar.sales' },
  { key: 'bazaarprofit',        label: 'Bazaar Profit',       category: 'trading', path: 'trading.bazaar.profit', isCurrency: true },
  { key: 'itemmarketsales',     label: 'Item Market Sales',   category: 'trading', path: 'trading.item_market.sales' },
  { key: 'itemmarketrevenue',   label: 'Item Market Revenue', category: 'trading', path: 'trading.item_market.revenue', isCurrency: true },
  { key: 'itemmarketfees',      label: 'Item Market Fees',    category: 'trading', path: 'trading.item_market.fees', isCurrency: true },

  // ── Finishing Hits ──────────────────────────────────────────────────────
  { key: 'fhheavyartillery',    label: 'FH Heavy Artillery',  category: 'finishing', path: 'finishing_hits.heavy_artillery' },
  { key: 'fhmachineguns',       label: 'FH Machine Guns',     category: 'finishing', path: 'finishing_hits.machine_guns' },
  { key: 'fhrifles',            label: 'FH Rifles',           category: 'finishing', path: 'finishing_hits.rifles' },
  { key: 'fhsubmachineguns',    label: 'FH Sub Machine Guns', category: 'finishing', path: 'finishing_hits.sub_machine_guns' },
  { key: 'fhshotguns',          label: 'FH Shotguns',         category: 'finishing', path: 'finishing_hits.shotguns' },
  { key: 'fhpistols',           label: 'FH Pistols',          category: 'finishing', path: 'finishing_hits.pistols' },
  { key: 'fhtemporary',         label: 'FH Temporary',        category: 'finishing', path: 'finishing_hits.temporary' },
  { key: 'fhpiercing',          label: 'FH Piercing',         category: 'finishing', path: 'finishing_hits.piercing' },
  { key: 'fhslashing',          label: 'FH Slashing',         category: 'finishing', path: 'finishing_hits.slashing' },
  { key: 'fhclubbing',          label: 'FH Clubbing',         category: 'finishing', path: 'finishing_hits.clubbing' },
  { key: 'fhmechanical',        label: 'FH Mechanical',       category: 'finishing', path: 'finishing_hits.mechanical' },
  { key: 'fhhandtohand',        label: 'FH Hand-to-Hand',     category: 'finishing', path: 'finishing_hits.hand_to_hand' },

  // ── Communication ───────────────────────────────────────────────────────
  { key: 'mailssent',           label: 'Mails Sent',          category: 'communication', path: 'communication.mails_sent.total' },
  { key: 'mailsfriends',        label: 'Mails (Friends)',     category: 'communication', path: 'communication.mails_sent.friends' },
  { key: 'mailsfaction',        label: 'Mails (Faction)',     category: 'communication', path: 'communication.mails_sent.faction' },
  { key: 'mailscolleagues',     label: 'Mails (Colleagues)',  category: 'communication', path: 'communication.mails_sent.colleagues' },
  { key: 'classifiedads',       label: 'Classified Ads',      category: 'communication', path: 'communication.classified_ads' },
  { key: 'personals',           label: 'Personals',           category: 'communication', path: 'communication.personals' },

  // ── Travel ──────────────────────────────────────────────────────────────
  { key: 'traveltotal',         label: 'Travels',             category: 'travel', path: 'travel.total' },
  { key: 'traveltime',          label: 'Travel Time (hrs)',   category: 'travel', path: 'travel.time_spent', isSeconds: true },
  { key: 'travelitemsbought',   label: 'Items Bought Abroad', category: 'travel', path: 'travel.items_bought' },
  { key: 'huntingskill',        label: 'Hunting Skill',       category: 'travel', path: 'travel.hunting.skill', noPerDay: true },
  { key: 'travelattackswon',    label: 'Travel Attacks Won',  category: 'travel', path: 'travel.attacks_won' },
  { key: 'traveldefendslost',   label: 'Travel Defends Lost', category: 'travel', path: 'travel.defends_lost' },

  // ── Jobs ────────────────────────────────────────────────────────────────
  { key: 'jobpointsused',       label: 'Job Points Used',     category: 'jobs', path: 'jobs.job_points_used' },
  { key: 'trainsreceived',      label: 'Trains Received',     category: 'jobs', path: 'jobs.trains_received' },

  // ── Racing ──────────────────────────────────────────────────────────────
  { key: 'racingskill',         label: 'Racing Skill',        category: 'racing', path: 'racing.skill', noPerDay: true },
  { key: 'racingpoints',        label: 'Racing Points',       category: 'racing', path: 'racing.points' },
  { key: 'racesentered',        label: 'Races Entered',       category: 'racing', path: 'racing.races.entered' },
  { key: 'raceswon',            label: 'Races Won',           category: 'racing', path: 'racing.races.won' },

  // ── Missions ────────────────────────────────────────────────────────────
  { key: 'missioncreditsearned', label: 'Mission Credits',    category: 'missions', path: 'missions.credits' },
  { key: 'missions_total',      label: 'Missions Completed',  category: 'missions', path: 'missions.missions' },
  { key: 'contracts_total',     label: 'Contracts',           category: 'missions', path: 'missions.contracts.total' },
  { key: 'contracts_duke',      label: 'Duke Contracts',      category: 'missions', path: 'missions.contracts.duke' },

  // ── Misc ────────────────────────────────────────────────────────────────
  { key: 'refills',             label: 'Energy Refills',      category: 'misc', path: 'other.refills.energy' },
  { key: 'nerverefills',        label: 'Nerve Refills',       category: 'misc', path: 'other.refills.nerve' },
  { key: 'tokenrefills',        label: 'Token Refills',       category: 'misc', path: 'other.refills.token' },
  { key: 'timeplayed',          label: 'Activity (hrs)',      category: 'misc', path: 'other.activity.time', isSeconds: true },
  { key: 'activitystreak',      label: 'Activity Streak',     category: 'misc', path: 'other.activity.streak.current', noPerDay: true },
  { key: 'beststreak',          label: 'Best Streak',         category: 'misc', path: 'other.activity.streak.best', noPerDay: true },
  { key: 'awards',              label: 'Awards',              category: 'misc', path: 'other.awards' },
  { key: 'meritsbought',        label: 'Merits Bought',       category: 'misc', path: 'other.merits_bought' },
  { key: 'donatordays',         label: 'Donator Days',        category: 'misc', path: 'other.donator_days', noPerDay: true },
  { key: 'networth',            label: 'Net Worth',           category: 'misc', path: 'networth.total', isCurrency: true, noPerDay: true },
  { key: 'bountiesplaced',      label: 'Bounties Placed',     category: 'misc', path: 'bounties.placed.amount' },
  { key: 'bountiescollected',   label: 'Bounties Collected',  category: 'misc', path: 'bounties.collected.amount' },
  { key: 'bountiesreceived',    label: 'Bounties Received',   category: 'misc', path: 'bounties.received.amount' },
]

// Curated key list for the per-member Dashboard card. Keeps the DashboardView
// from rendering all ~100 stats — only the ones we historically surfaced there.
export const DASHBOARD_STAT_KEYS = new Set([
  'xantaken', 'refills', 'nerverefills', 'energydrinkused', 'boostersused',
  'statenhancersused', 'alcoholused', 'consumablesused', 'candyused',
  'drugsused', 'overdosed', 'rehabs',
  'attackswon', 'defendswon', 'retals', 'respectforfaction', 'rankedwarhits',
  'rankedwarwins', 'organizedcrimes',
  'trainsreceived', 'bustssuccess', 'bloodwithdrawn',
  'criminaloffenses', 'missioncreditsearned',
  'timeplayed', 'networth',
])

export const STAT_PATHS_BY_KEY = STAT_PATHS.reduce((acc, s) => {
  acc[s.key] = s
  return acc
}, {})

export const STAT_PATHS_BY_CATEGORY = STAT_CATEGORIES.map(cat => ({
  ...cat,
  stats: STAT_PATHS.filter(s => s.category === cat.id),
}))

// Walk a dotted path. Returns null on any missing intermediate or non-numeric leaf.
export function getByPath(obj, path) {
  if (!obj || !path) return null
  const node = path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
  if (node == null) return null
  const n = Number(node)
  return Number.isFinite(n) ? n : null
}

export function getStatValue(stats, statDef) {
  return getByPath(stats, statDef.path)
}
