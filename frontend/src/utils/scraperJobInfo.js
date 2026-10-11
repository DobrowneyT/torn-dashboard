// Human summaries for each scraper job, shown as a hover tooltip on the job
// name in Global Admin's Scraper Jobs table. Sourced from the job-by-job
// reference in server/src/scraper/README.md — keep them in sync when a job's
// behavior or API footprint changes.

export const SCRAPER_JOB_INFO = {
  'items-sync':
    'Torn item catalog with market/sell/buy prices (GET /v2/torn/items). ' +
    'Feeds payout item valuations and the OC Simulator\'s item-reward values, ' +
    'which price at current market — so this runs every 6 hours rather than ' +
    'daily. ~1 API call.',
  'inventory-sync':
    "Faction armory snapshot across every category (GET /faction/{id}). " +
    'Upserts inventory_items for loaned-item tracking and payout valuations. ~1 API call.',
  'crimes-sync':
    'Organized crimes, incremental from the oldest in-flight crime ' +
    '(GET /v2/faction/crimes, pages of 100). Feeds OC pages, OC Planner, ' +
    'and weekly OC payouts. 1–few API calls.',
  'attacks-sync':
    'Faction attacks, incremental forward sync (GET /v2/faction/attacks, ' +
    'pages of 100). Feeds War Room, RW payouts, and war overview, and captures ' +
    'each side\'s faction name into the factions lookup for free (no extra ' +
    'calls). 1 call per 100 new attacks.',
  'revives-sync':
    'Revives our members RECEIVED, incremental forward sync ' +
    '(GET /v2/faction/revives?filters=incoming, pages of 100). Feeds the War ' +
    "Room's revive-chance estimate — which needs a rolling 24h history, so it " +
    'runs standing rather than per war — and the war overview\'s revive charts, ' +
    'which read whole war windows. First run pages back through the entire ' +
    'history and can take a while; after that, 1 call per 100 new revives.',
  'factions-sync':
    'Faction lookup completion: fills tags (and any missing names) for faction ' +
    'ids seen in attacks via GET /v2/faction/{id}/basic — attacks-sync captures ' +
    'names inline but the attack payload has no tag. Gives the payout opposing-' +
    'faction filter its "[TAG]" labels. 1 call per unresolved faction, capped ' +
    'at 40 per run.',
  'members-sync':
    'Faction roster (GET /v2/faction/members): marks leavers, upserts current ' +
    'members, and reconciles the key pool. Feeds the Members page and every ' +
    'roster dropdown. 1 API call.',
  'cpr-scan':
    "Crime pass-rate (CPR) scan: a faction available-crimes call plus one " +
    "per-member call using each member's own key (GET /v2/user/organizedcrimes), " +
    'then recomputes tiers. Feeds CPR modals and tiered payouts. 1 + one call per pooled key.',
  'member-stats':
    'Per-member personalstats + profile snapshot plus faction gym totals. ' +
    'Feeds dashboard stats and Member Overview trends. The heavy one — ' +
    '~2 calls per member + 5.',
  'member-profile':
    'Daily slow-moving profile denorms (donator/property/last-action) for ' +
    'every current member. Composes with member-stats via COALESCE. ' +
    '~1 call per member.',
  'member-battle-stats':
    "Our own members' battle stats, daily, best source first: each member's " +
    'OWN key (GET /v2/user?selections=battlestats — self-only, so there is no ' +
    'faction-wide call), then a TornStats faction spy, then a BSP estimate for ' +
    'anyone still unknown. Lead-only. ~1 call per pooled key + 1 + one per ' +
    'member with no key.',
  'stats-samples-prune':
    'Housekeeping: prunes the intraday member_stat_samples series past its ' +
    'retention window, keeping samples still needed to resolve competitions. ' +
    'No API calls (DB only).',
  'scraper-runs-prune':
    'Housekeeping: prunes this run log past its 30-day window. Keeps each ' +
    "job's newest success and every failure since it, so the fleet-metrics " +
    '"last success" and consecutive-failure count stay exact however far back ' +
    'they reach. No API calls (DB only).',
  'wars-sync':
    'Ranked-wars list sync with live scores, plus the official ' +
    'rankedwarreport once per newly-completed war (GET /v2/faction/{warId}/' +
    'rankedwarreport). Feeds RW pages, War History, and RW payouts. ' +
    '1–2 list calls + 1 per unreported war.',
  'war-lifecycle':
    'War-room automation (GET /v2/faction/{id}/rankedwars): auto-setup on a ' +
    'new matched war, auto-enable at T-1h, auto-disable at war end. Never ' +
    'touches a manual session. 1 call (+2 baseline calls during auto-setup).',
  'competitions-resolve':
    'Auto-resolves competitions at day-boundary closes and interval draws. ' +
    'Feeds competition leaderboards and prize payouts. No API calls (DB only).',
  'chain-sample':
    'Chain Watch (#774): the chain counter and its timer, every 4 minutes ' +
    '(GET /v2/faction/{id}/chain). Append-only, unlike the War Room singleton ' +
    'it deliberately does not reuse — that one overwrites every poll, so the ' +
    'chain\'s end becomes a moment you had to catch rather than a fact the ' +
    'payout can read back hours later. 4 minutes is enough because payout is ' +
    'HOURLY: a detection error only matters when the chain dies within 4 ' +
    'minutes of an hour boundary. 1 API call per run (~360/day).',
  'activity-sample':
    'Chain Watch (#774): who was around and who was in the air, every 5 ' +
    'minutes (GET /v2/faction/members). ONE call covers the whole roster — ' +
    'last_action and the full status object, including plane_image_type — so ' +
    'the cost is the same whether 2 people signed up or 40, and it also ' +
    'records who was awake at 04:00 and did NOT sign up. Feeds the watch ' +
    'flags and the travel warnings. 1 API call per run (~288/day).',
  'crime-occupancy':
    'Observed OC occupancy, every minute at the :30 mark ' +
    '(GET /v2/faction/crimes?cat=available). Records when each member was ' +
    'actually SEEN in a crime slot, because Torn never reports a departure — ' +
    'every "left at" elsewhere is inferred. Feeds the payout page\'s observed ' +
    'time. 1 API call per minute (~1,440/day).',
  'member-thread-sweep':
    'Queues membership notes for the per-member Discord threads — a note when ' +
    'somebody joins the faction, and another when they leave. ⚠️ Costs ZERO ' +
    'Torn API calls: it reads the faction-stints table members-sync already ' +
    'maintains and writes to an outbox the Discord bot polls. The bot is never ' +
    'called by the dashboard, and the forum channel is the BOT\u2019s setting, ' +
    'changed from Discord. ' +
    '⚠️ The FIRST run deliberately queues nothing — ' +
    'it only records the moment this faction started being watched, because ' +
    'the roster sitting there has no recorded join dates and inventing ~90 of ' +
    'them would write fiction into permanent records.',
  'dibs-summary':
    'Freezes each finished war\'s dibs activity into a per-member summary — ' +
    'claims taken, converted, lost to a teammate, and taken from others. ' +
    '⚠️ It runs AFTER a war, never during: attacks are scraped every 30 ' +
    'minutes while the War Room\'s dibs sweep runs every second, so the attack ' +
    'row that explains a claim\'s death lands long after the claim is gone. ' +
    '⚠️ A war whose attacks have not landed yet WAITS for a later run rather ' +
    'than being summarised early — a war counted too soon records real ' +
    'conversions as "no swing" against named members. ⚠️ Costs ZERO Torn API ' +
    'calls: it reads claims and attacks already in the database and makes no ' +
    'request of its own. Most runs do nothing at all.',
  'grudge-stats':
    'Daily battle-stat lookup for Book of Grudges targets — TornStats first ' +
    '(one call covers a whole faction), then Battle Stats Predictor for anyone ' +
    'it did not cover (one call each). ⚠️ Daily rather than quarter-hourly ' +
    'like the status refresh beside it: these are third-party servers we do ' +
    'not own, and spy stats move on the order of weeks. It refetches only ' +
    'readings older than seven days, so most runs do nothing. The column shows ' +
    'which source answered and when the SPY was taken — not when we fetched ' +
    'it, which can be months newer.',
  'grudge-refresh':
    'Keeps the Book of Grudges current every 15 minutes — each target\u2019s name, ' +
    'faction and live status, so the list can say who is attackable right now. ' +
    'Grouped by faction: one call covers every target in a faction, and only a ' +
    'target who is alone in theirs (or in none) costs a call of their own, so ' +
    'the cost grows with the number of FACTIONS on the list rather than the ' +
    'number of targets. Uses only the keys of members who accepted the Target ' +
    'Lookups disclosure; if nobody has, it does nothing rather than failing.',
  'member-hof':
    'Daily snapshot of each member\'s Hall of Fame standings — the value and ' +
    'the global Torn rank per category. One call per member, so roughly one ' +
    'per hundred members per run; daily is affordable where per-page-load ' +
    'would not be. Battle stats are absent because Torn reports those only to ' +
    'you about yourself, so no faction-wide battle-stat board is possible.',
  'faction-upgrades':
    'Daily snapshot of the faction\'s purchased upgrades, including the ' +
    'Steadfast gym-gain percentages and whether the war or peace branch set ' +
    'is in effect. One row per day rather than one row overall, so the ' +
    'calendar can show what a bonus was on a given date instead of ' +
    'repainting history with today\'s numbers. One Torn API call per run.',
  'member-event-windows':
    'Daily read of each member\'s chosen Torn event start hour, for members ' +
    'who explicitly opted into that scope — nobody else is touched. Uses each ' +
    'member\'s OWN key, not a pooled one, because the endpoint answers for the ' +
    'caller: a rotating key would report one person\'s hour under everyone\'s ' +
    'name. One Torn API call per opted-in member.',
  'revives-sync':
    'On-demand only (no schedule): pages incoming revives for a specific ' +
    'ranked war (GET /v2/faction/revives, pages of 100). Feeds RW payout ' +
    'revive counts. A few calls per war window.',
}

/** Tooltip text for a job name, or a generic fallback for unknown jobs. */
export function scraperJobSummary(jobName) {
  return SCRAPER_JOB_INFO[jobName] || 'Scraper job. Hover details are not available for this job.'
}
