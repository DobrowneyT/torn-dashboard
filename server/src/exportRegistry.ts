// CSV export registry (#517).
//
// A hand-curated allowlist of exportable tables. ⚠️ A table absent from this
// file is NOT exportable and the endpoint 404s. That is deliberate and is the
// whole security model: enumerating the schema instead would publish any new
// table the day it is created, including one holding something that should
// never leave the server.
//
// ⚠️ `member_secrets` is not here and must never be added. It holds API keys.

import type { Role } from './auth.js'

/** The role FLOOR a table's data sits behind. */
export type ExportRole = 'warlead' | 'leadership' | 'admin'

/** How the table's filter column stores time — see the TIME TRAP below. */
export type TimeType = 'epoch' | 'timestamptz' | 'timestamp' | 'date'

export interface ExportTable {
  /** Human label for the picker. */
  label: string
  /** One-line note shown under the label, so a caller picks the right table. */
  note: string
  /**
   * The column the date range filters on.
   *
   * ⚠️ THE TIME TRAP THIS FIELD EXISTS FOR. `created_at` means opposite things
   * in two of our tables: `crimes.created_at` is a bigint holding TORN's
   * crime-creation time, while `faction_attacks.created_at` is a timestamptz
   * holding WHEN WE INSERTED THE ROW. A generic exporter filtering on
   * "created_at" would filter on the event in one table and on our scrape time
   * in the other — and both exports would look entirely correct.
   *
   * The same reasoning rejects `updated_at` as a universal filter: it means
   * "last touched", so a July row rewritten last night is missing from a July
   * export and present in an August one.
   */
  timeCol: string
  timeType: TimeType
  role: ExportRole
  /**
   * Epoch-seconds columns that get a readable `<col>_tct` companion beside the
   * raw integer. The filter column belongs here too when it is an epoch.
   */
  epochCols?: string[]
  /**
   * Member-id columns with NO name stored alongside them, resolved against
   * `members` into a `<col>_name` companion.
   *
   * ⚠️ Deliberately empty for `faction_attacks` and `faction_revives`: those
   * already store `attacker_name` / `target_name` etc., which is the name
   * AS OF THE EVENT. Joining `members` there would overwrite history with
   * whoever holds that id today, and would silently blank every opponent —
   * they were never in our roster at all.
   */
  resolveNames?: string[]
}

export const EXPORT_TABLES: Record<string, ExportTable> = {
  // ---- Torn raw returns -------------------------------------------------
  faction_attacks: {
    label: 'Faction Attacks',
    note: "Every attack we scraped, filtered on Torn's own attack-start time.",
    timeCol: 'started',
    timeType: 'epoch',
    role: 'leadership',
    epochCols: ['started', 'ended'],
  },
  crimes: {
    label: 'Organised Crimes',
    // ⚠️ Filtering on `executed_at` means crimes that never executed
    // (planning, expired) are absent from every range. That is the honest
    // reading of "crimes in this window" and is called out in the picker.
    note: 'Executed OCs, filtered on execution time. Planning and expired crimes are excluded.',
    timeCol: 'executed_at',
    timeType: 'epoch',
    role: 'leadership',
    epochCols: ['created_at', 'planning_at', 'executed_at', 'ready_at', 'expired_at'],
  },
  faction_revives: {
    label: 'Revives',
    note: 'Revives given and received, filtered on the revive timestamp.',
    timeCol: 'timestamp',
    timeType: 'epoch',
    role: 'leadership',
    epochCols: ['timestamp', 'target_last_action'],
  },
  member_daily_stats: {
    label: 'Member Daily Stats',
    note: 'One personal-stats snapshot per member per day. Wide: carries raw JSON.',
    timeCol: 'snapshot_date',
    timeType: 'date',
    role: 'leadership',
    epochCols: ['last_action_timestamp'],
    resolveNames: ['member_id'],
  },
  member_stat_samples: {
    label: 'Member Stat Samples',
    note: 'Intraday battle-stat samples behind the member-metrics windows.',
    timeCol: 'captured_at',
    timeType: 'timestamptz',
    role: 'leadership',
    resolveNames: ['member_id'],
  },
  crime_participation_v2: {
    label: 'Crime Participation',
    note: 'Observed join/leave times per member per crime, filtered on last observation.',
    timeCol: 'updated_at',
    timeType: 'timestamptz',
    role: 'leadership',
    epochCols: ['joined_at', 'left_at'],
    resolveNames: ['member_id'],
  },
  ranked_wars: {
    label: 'Ranked Wars',
    note: 'War metadata: opponent, scores, and rewards, filtered on war start.',
    timeCol: 'start_at',
    timeType: 'epoch',
    role: 'leadership',
    epochCols: ['start_at', 'end_at'],
  },
  war_member_contributions: {
    label: 'War Contributions',
    note: "Torn's official per-member war-report score, filtered on last write.",
    timeCol: 'updated_at',
    timeType: 'timestamptz',
    role: 'leadership',
  },

  // ---- RW payouts ---------------------------------------------------------
  war_payouts: {
    label: 'War Payout Runs',
    note: 'One row per saved RW payout: formula settings, costs, and totals.',
    timeCol: 'updated_at',
    timeType: 'timestamptz',
    role: 'leadership',
    epochCols: ['race_cutoff_timestamp'],
  },
  war_payout_members: {
    label: 'War Payout Members',
    // No event time on this table either — see oc_payout_members above for
    // the same reasoning. `created_at` is when the payout row was written.
    note: 'Per-member RW payout lines, including the saved effort %. Filtered on when saved.',
    timeCol: 'created_at',
    timeType: 'timestamptz',
    role: 'leadership',
  },

  // ---- OC payouts -------------------------------------------------------
  oc_payout_weeks: {
    label: 'OC Payout Weeks',
    note: 'One row per saved payout week: totals, cut, and mode.',
    timeCol: 'week_start_timestamp',
    timeType: 'epoch',
    role: 'leadership',
    epochCols: ['week_start_timestamp', 'week_end_timestamp'],
  },
  oc_payout_members: {
    label: 'OC Payout Members',
    // No event time exists on this table — a member's payout line has no
    // moment of its own beyond the week it belongs to and when it was last
    // written. `updated_at` is the honest filter here, and the picker says so.
    note: 'Per-member payout lines. Filtered on when the line was last written, not on the week.',
    timeCol: 'updated_at',
    timeType: 'timestamp',
    role: 'leadership',
  },

  // ---- Member / CPR — personal data, admin only -------------------------
  members: {
    label: 'Members',
    note: 'The roster, current and former. Filtered on when the row was last updated.',
    timeCol: 'updated_at',
    timeType: 'timestamp',
    role: 'admin',
  },
  member_cpr_v2: {
    label: 'Member CPR',
    note: 'Per-member CPR by crime and position, filtered on last observation.',
    timeCol: 'last_seen_at',
    timeType: 'timestamptz',
    role: 'admin',
    resolveNames: ['member_id'],
  },
  member_faction_stints: {
    label: 'Faction Stints',
    note: 'Join/leave history behind days-in-faction, filtered on the join date.',
    timeCol: 'joined_at',
    timeType: 'timestamptz',
    role: 'admin',
    resolveNames: ['member_id'],
  },
  member_battle_stats: {
    label: 'Member Battle Stats',
    // Admin, not leadership — same floor as `members`/`member_cpr_v2` above:
    // battle stats are the single most sensitive number in Torn (see
    // db/migrations/0028-member-battle-stats.sql).
    note: 'Current str/def/spd/dex per member, filtered on last update.',
    timeCol: 'updated_at',
    timeType: 'timestamptz',
    role: 'admin',
    resolveNames: ['member_id'],
  },
}

/**
 * Who may export at each floor. An explicit table rather than an index into
 * ROLES: `ocmanager` is a sideways specialist role, not a rung on this ladder,
 * and a comparison against role ORDER would quietly hand it leadership data.
 *
 * ⚠️ This table is an ALLOW-LIST, which is why removing the `visitor` role
 * (#922, 2026-10-06) needed no change here: a role absent from every floor was
 * already denied by construction. `canExport` additionally rejected it
 * outright, which mattered only for somebody holding visitor AND a real role at
 * once — a combination the schema no longer permits.
 */
const ROLE_FLOOR: Record<ExportRole, Role[]> = {
  warlead: ['warlead', 'leadership', 'admin'],
  leadership: ['leadership', 'admin'],
  admin: ['admin'],
}

export function rolesAllowedFor(floor: ExportRole): Role[] {
  return ROLE_FLOOR[floor]
}

/** The registry entry, or null when the name is not exportable. */
export function lookupExportTable(name: unknown): ExportTable | null {
  if (typeof name !== 'string') return null
  return Object.prototype.hasOwnProperty.call(EXPORT_TABLES, name)
    ? EXPORT_TABLES[name]
    : null
}

export function canExport(floor: ExportRole, roles: readonly Role[]): boolean {
  return ROLE_FLOOR[floor].some((r) => roles.includes(r))
}

/** The tables a caller may export, in picker order. */
export function exportableFor(roles: readonly Role[]) {
  return Object.entries(EXPORT_TABLES)
    .filter(([, t]) => canExport(t.role, roles))
    .map(([table, t]) => ({
      table,
      label: t.label,
      note: t.note,
      timeCol: t.timeCol,
      timeType: t.timeType,
      role: t.role,
    }))
}
