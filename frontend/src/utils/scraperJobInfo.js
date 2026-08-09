// Human summaries for each scraper job, shown as a hover tooltip on the job
// name in Global Admin's Scraper Jobs table. Sourced from the job-by-job
// reference in server/src/scraper/README.md — keep them in sync when a job's
// behavior or API footprint changes.

export const SCRAPER_JOB_INFO = {
  'items-sync':
    'Torn item catalog with market/sell/buy prices (GET /v2/torn/items). ' +
    'Feeds payout item valuations. ~1 API call.',
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
    'runs standing rather than per war — and the war overview\'s revive charts. ' +
    'First run reaches back 7 days, not the whole history. 1 call per 100 new ' +
    'revives.',
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
  'revives-sync':
    'On-demand only (no schedule): pages incoming revives for a specific ' +
    'ranked war (GET /v2/faction/revives, pages of 100). Feeds RW payout ' +
    'revive counts. A few calls per war window.',
}

/** Tooltip text for a job name, or a generic fallback for unknown jobs. */
export function scraperJobSummary(jobName) {
  return SCRAPER_JOB_INFO[jobName] || 'Scraper job. Hover details are not available for this job.'
}
