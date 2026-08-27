-- Faction database template — one database per faction is created from this file.
--
-- Provenance: generated 2026-07-08 from the live Supabase project (Postgres 17)
-- by introspecting pg_catalog, then stripped of Supabase-specific machinery:
--   * RLS policies and the auth.jwt() helper functions (is_admin, is_leadership,
--     is_visitor, current_faction_id) — authorization moves into the API layer.
--   * pg_cron / pg_net war-room tick functions (private schema) and the
--     war_room_config_v2_cron_gate trigger — scheduling moves into the API layer.
-- Added on top of the live schema:
--   * faction_config  — single-row per-DB identity + branding (replaces env/js config)
--   * role_assignments — per-faction role grants (replaces hardcoded ID lists)
--
-- Regenerate against the live DB with:
--   pg_dump --schema-only --no-owner --no-privileges "$SUPABASE_DB_URL" \
--     --schema=public  # then re-apply the strips + additions above
--
-- Apply with: psql -d <fresh_db> -f template.sql  (or via db/new-faction.mjs)

SET check_function_bodies = off;

-- ── Extensions ────────────────────────────────────────────────────────────────
-- pgcrypto lives in the "extensions" schema to match the live DB, so function
-- bodies with search_path 'public','extensions' work verbatim.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── Sequences ─────────────────────────────────────────────────────────────────
CREATE SEQUENCE public.api_key_rotation_seq;
CREATE SEQUENCE public.crime_required_items_id_seq AS integer;
CREATE SEQUENCE public.crime_reward_items_id_seq AS integer;
CREATE SEQUENCE public.crime_slots_id_seq AS integer;
CREATE SEQUENCE public.oc_crime_positions_id_seq AS integer;
CREATE SEQUENCE public.oc_crime_types_id_seq AS integer;
CREATE SEQUENCE public.oc_payout_members_id_seq AS integer;
CREATE SEQUENCE public.oc_payout_weeks_id_seq AS integer;
CREATE SEQUENCE public.pricing_batches_id_seq AS integer;
CREATE SEQUENCE public.sync_metadata_id_seq AS integer;
CREATE SEQUENCE public.war_member_contributions_id_seq;
CREATE SEQUENCE public.war_payout_members_id_seq;
CREATE SEQUENCE public.war_payouts_id_seq;
CREATE SEQUENCE public.war_room_dibs_v2_id_seq;
CREATE SEQUENCE public.war_room_roll_call_v2_id_seq;

-- ── Tables ────────────────────────────────────────────────────────────────────

CREATE TABLE public.crime_required_items (
  id integer DEFAULT nextval('crime_required_items_id_seq'::regclass) NOT NULL,
  crime_id text NOT NULL,
  "position" text NOT NULL,
  position_id text NOT NULL,
  position_number integer,
  item_id text NOT NULL,
  item_name text,
  is_reusable boolean DEFAULT false,
  is_available boolean DEFAULT true,
  user_id text,
  outcome_owned_by text,
  outcome_item_id text,
  outcome_item_uid text,
  outcome text,
  was_consumed boolean DEFAULT false,
  unit_value bigint DEFAULT 0,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now()
);

CREATE TABLE public.crime_reward_items (
  id integer DEFAULT nextval('crime_reward_items_id_seq'::regclass) NOT NULL,
  crime_id text NOT NULL,
  item_id text NOT NULL,
  item_name text,
  quantity integer DEFAULT 1 NOT NULL,
  unit_value bigint DEFAULT 0,
  total_value bigint DEFAULT 0,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now()
);

CREATE TABLE public.crime_slots (
  id integer DEFAULT nextval('crime_slots_id_seq'::regclass) NOT NULL,
  crime_id text NOT NULL,
  "position" text NOT NULL,
  position_id text,
  position_number integer,
  checkpoint_pass_rate numeric(5,2),
  user_id text,
  user_name text,
  joined_at bigint,
  user_outcome text,
  user_progress numeric(6,2),
  item_requirement_id text,
  item_requirement_name text,
  item_requirement_is_reusable boolean,
  item_requirement_is_available boolean,
  item_outcome_id text,
  item_outcome_outcome text,
  updated_at timestamp without time zone DEFAULT now(),
  item_requirement_value bigint DEFAULT 0,
  item_outcome_value bigint DEFAULT 0
);

-- Per-(crime, member) participation stints (#168): retains time banked in a
-- crime a member left before it executed, which crime_slots (keyed by refillable
-- position) can't. Maintained by the crimes-sync.
CREATE TABLE public.crime_participation_v2 (
  crime_id   text NOT NULL,
  member_id  text NOT NULL,
  joined_at  bigint NOT NULL,
  left_at    bigint,
  completed  boolean NOT NULL DEFAULT false,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (crime_id, member_id)
);
CREATE INDEX crime_participation_v2_member_idx ON public.crime_participation_v2 (member_id);

-- #389: observed OC occupancy. Torn never reports when a member LEFT a crime,
-- so every "left at" above is inferred. This table records what the minute
-- poller actually saw. Surrogate key, not (crime_id, member_id): a member who
-- leaves and rejoins the same crime must keep BOTH stints, which the table
-- above cannot represent.
CREATE TABLE public.crime_occupancy (
  id             bigserial PRIMARY KEY,
  crime_id       text   NOT NULL,
  member_id      text   NOT NULL,
  position_id    text,
  torn_joined_at bigint,
  first_seen_at  bigint NOT NULL,
  last_seen_at   bigint NOT NULL,
  closed         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crime_occupancy_open_uniq
  ON public.crime_occupancy (crime_id, member_id, COALESCE(position_id, '')) WHERE NOT closed;
CREATE INDEX crime_occupancy_member_window_idx
  ON public.crime_occupancy (member_id, first_seen_at, last_seen_at);
CREATE INDEX crime_occupancy_crime_idx ON public.crime_occupancy (crime_id);

-- #389: poll heartbeat, so a payout window containing an outage can say so
-- rather than quietly under-reporting the departures it missed.
CREATE TABLE public.crime_occupancy_polls (
  polled_at   bigint PRIMARY KEY,
  crimes_seen integer NOT NULL DEFAULT 0,
  slots_seen  integer NOT NULL DEFAULT 0,
  opened      integer NOT NULL DEFAULT 0,
  closed      integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crime_occupancy_polls_at_idx ON public.crime_occupancy_polls (polled_at DESC);

-- #390: our own copy of the OC probability model from tornprobability.com.
-- The simulator computes against this copy, never the live service (one
-- person's server, non-standard port, no SLA) — an outage degrades to stale
-- numbers instead of a dead page. Note it is HTTPS on 3000, not HTTP.
CREATE TABLE public.oc_scenarios (
  name             text PRIMARY KEY,
  parameter_count  int  NOT NULL,
  -- NULL means we have not read the /scenarios page, which is distinct from
  -- false: the API does not carry completeness, and an in-progress model
  -- answers with numbers that look exactly as authoritative as a finished one.
  is_complete      boolean,
  observed_paths   int,
  diagram          text,
  diagram_valid    boolean,
  diagram_problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- #471: how well the simulated distribution matched the API's. `ok` means
  -- every reported ending got a node; `confident` means the numbers behind that
  -- assignment line up — a map can be complete and still be wrong about which
  -- ending is which.
  ending_map_residual numeric,
  ending_map_confident boolean
);

-- GetRoleNames spells a scenario "Mob Mentality" and its role "Looter 1";
-- GetRoleWeights spells the same two "MobMentality" and "Looter1". The mirror
-- normalises both sides — a raw join drops every multi-word name.
CREATE TABLE public.oc_scenario_roles (
  scenario_name text NOT NULL REFERENCES public.oc_scenarios(name) ON DELETE CASCADE,
  position_id   text NOT NULL,
  role_name     text NOT NULL,
  weight        numeric,
  PRIMARY KEY (scenario_name, position_id)
);

-- goodEndingN -> diagram node id. Nothing in either API response states this
-- correspondence, and position matching is WRONG: Break the Bank's derived
-- mapping swaps positions 3 and 4 against declaration order.
CREATE TABLE public.oc_scenario_endings (
  scenario_name text NOT NULL REFERENCES public.oc_scenarios(name) ON DELETE CASCADE,
  ending_key    text NOT NULL,
  node_id       text,
  kind          text NOT NULL,
  resolved      boolean NOT NULL DEFAULT false,
  problem       text,
  PRIMARY KEY (scenario_name, ending_key)
);
CREATE INDEX oc_scenario_endings_node_idx
  ON public.oc_scenario_endings (scenario_name, node_id);

-- #440: observed money/respect per diagram node, from the same SSE connection
-- that serves the flowchart. Joined to endings through oc_scenario_endings so
-- E(x) is computed rather than hand-entered.
CREATE TABLE public.oc_scenario_node_stats (
  scenario_name text NOT NULL REFERENCES public.oc_scenarios(name) ON DELETE CASCADE,
  node_id       text NOT NULL,
  -- Observation count, 1 to 6,419 across the real feed. Must reach the UI: an
  -- average from one run looks exactly like an average from six thousand.
  n             integer NOT NULL DEFAULT 0,
  money_min     bigint,
  money_max     bigint,
  money_avg     bigint,
  respect_min   numeric,
  respect_max   numeric,
  respect_avg   numeric,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_name, node_id)
);

CREATE TABLE public.crimes (
  crime_id text NOT NULL,
  name text NOT NULL,
  difficulty integer NOT NULL,
  status text NOT NULL,
  previous_crime_id text,
  created_at bigint,
  planning_at bigint,
  executed_at bigint,
  ready_at bigint,
  expired_at bigint,
  last_updated text,
  first_seen text,
  total_slots integer,
  filled_slots integer,
  rewards_money bigint DEFAULT 0,
  rewards_respect integer DEFAULT 0,
  rewards_items jsonb,
  updated_at timestamp without time zone DEFAULT now(),
  payout_week_id integer,
  total_reward_value bigint DEFAULT 0,
  item_reward_value bigint DEFAULT 0,
  item_cost_value bigint DEFAULT 0,
  net_reward_value bigint DEFAULT 0,
  total_cost_value bigint DEFAULT 0,
  net_value bigint DEFAULT 0
);

CREATE TABLE public.faction_attacks (
  attack_id bigint NOT NULL,
  code text,
  started bigint,
  ended bigint,
  attacker_id integer,
  attacker_name text,
  attacker_level integer,
  attacker_faction_id integer,
  attacker_faction_name text,
  defender_id integer,
  defender_name text,
  defender_level integer,
  defender_faction_id integer,
  defender_faction_name text,
  result text,
  respect_gain numeric(10,4) DEFAULT 0,
  respect_loss numeric(10,4) DEFAULT 0,
  chain integer,
  is_ranked_war boolean DEFAULT false,
  is_interrupted boolean DEFAULT false,
  is_stealthed boolean DEFAULT false,
  is_raid boolean DEFAULT false,
  is_territory_war boolean DEFAULT false,
  territory_war_id integer,
  finishing_hit_effects jsonb,
  fair_fight numeric(6,4) DEFAULT 1,
  war_modifier numeric(6,4) DEFAULT 1,
  chain_modifier numeric(10,4) DEFAULT 1,
  warlord_modifier numeric(6,4) DEFAULT 1,
  retaliation_modifier numeric(6,4) DEFAULT 1,
  group_modifier numeric(6,4) DEFAULT 1,
  overseas_modifier numeric(6,4) DEFAULT 1,
  is_incoming boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.faction_revives (
  revive_id bigint NOT NULL,
  rw_id bigint,
  "timestamp" bigint NOT NULL,
  reviver_id bigint NOT NULL,
  reviver_name text,
  reviver_faction_id bigint,
  reviver_faction_name text,
  reviver_skill numeric(6,2),
  target_id bigint NOT NULL,
  target_name text,
  target_faction_id bigint,
  target_faction_name text,
  hospital_reason text,
  early_discharge boolean DEFAULT false,
  target_last_action bigint,
  target_online_status text,
  success_chance numeric(5,2),
  result text,
  fetched_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.factions (
  id integer NOT NULL,
  name text NOT NULL,
  tag text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.inventory_items (
  id text NOT NULL,
  name text NOT NULL,
  quantity integer DEFAULT 0,
  available integer DEFAULT 0,
  loaned integer DEFAULT 0,
  -- {member_id, member_name, amount}[] — see inventoryMap.ts. Structured so a
  -- borrower's loaned amount and display name survive aggregation instead of
  -- collapsing into a lossy comma-joined string (follow-on fix to #542).
  loaned_to jsonb,
  api_type text,
  category text,
  last_synced timestamp without time zone DEFAULT now()
);

CREATE TABLE public.items (
  id integer NOT NULL,
  name text NOT NULL,
  description text,
  effect text,
  type text,
  sub_type text,
  market_price bigint,
  sell_price bigint,
  buy_price bigint,
  circulation integer,
  is_tradable boolean DEFAULT true,
  image_url text,
  last_updated timestamp without time zone DEFAULT now()
);


CREATE TABLE public.member_cpr_v2 (
  member_id text NOT NULL,
  crime_name text NOT NULL,
  position_label text NOT NULL,
  difficulty integer,
  cpr_value double precision NOT NULL,
  observation_count integer DEFAULT 1 NOT NULL,
  first_seen_at timestamp with time zone DEFAULT now(),
  last_seen_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.member_daily_stats (
  member_id text NOT NULL,
  snapshot_date date NOT NULL,
  personalstats jsonb,
  api_version text,
  gym_strength bigint,
  gym_speed bigint,
  gym_dexterity bigint,
  gym_defense bigint,
  created_at timestamp with time zone DEFAULT now(),
  gym_energy bigint,
  profile jsonb,
  is_donator boolean,
  property_name text,
  last_action_timestamp bigint
);

CREATE TABLE public.member_overview_thresholds (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  thresholds jsonb NOT NULL,
  created_by_id text,
  created_by_name text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.member_overview_views (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  columns jsonb NOT NULL,
  created_by_id text,
  created_by_name text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Service-side only: encrypted member API keys. Never exposed to clients.
CREATE TABLE public.member_secrets (
  member_id text NOT NULL,
  cpr_api_key bytea,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  key_level smallint,
  has_faction_access boolean,
  member_rank text,
  consent_at timestamp with time zone,
  consent_version text,
  key_fingerprint text,
  disabled boolean DEFAULT false NOT NULL,
  last_error text,
  -- Scraper key-pool rotation marker (claim = least-recently-claimed first).
  last_claimed_at timestamp with time zone,
  -- Last 4 chars of the key (#264) — shown to its owner as ••••<hint>, never the
  -- full key.
  key_hint text,
  -- #459: opt-in for reading the member's Torn event start time. Deliberately
  -- SEPARATE from consent_at — members consented to a stated list of uses, and
  -- /user/calendar is not on it. Absent means the scraper never touches this
  -- key for that purpose.
  calendar_scope_at timestamptz,
  calendar_scope_version text
);

CREATE TABLE public.members (
  member_id text NOT NULL,
  member_name text NOT NULL,
  tier integer DEFAULT 6,
  tier_override integer,
  last_scraped timestamp without time zone,
  updated_at timestamp without time zone DEFAULT now(),
  is_current boolean DEFAULT true,
  last_seen timestamp without time zone DEFAULT now(),
  first_seen timestamp without time zone DEFAULT now(),
  has_cpr_key boolean DEFAULT false NOT NULL,
  total_days_in_faction integer,
  -- Torn's "Resting in Peace" status: the account is preserved on the roster
  -- forever, so is_current stays true, but they are excluded from every
  -- member listing, stat and scrape. See 0042-fallen-members.sql.
  is_fallen boolean DEFAULT false NOT NULL
);

CREATE TABLE public.oc_crime_positions (
  id integer DEFAULT nextval('oc_crime_positions_id_seq'::regclass) NOT NULL,
  crime_name text NOT NULL,
  position_label text NOT NULL,
  position_id text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.oc_crime_types (
  id integer DEFAULT nextval('oc_crime_types_id_seq'::regclass) NOT NULL,
  name text NOT NULL,
  difficulty integer,
  first_seen_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.oc_payout_members (
  id integer DEFAULT nextval('oc_payout_members_id_seq'::regclass) NOT NULL,
  week_id integer,
  week_start date NOT NULL,
  week_end date NOT NULL,
  member_id text NOT NULL,
  member_name text NOT NULL,
  tier integer NOT NULL,
  base_tickets integer DEFAULT 0 NOT NULL,
  sit_out_penalty numeric(10,4) DEFAULT 0,
  adjusted_tickets numeric(10,4) DEFAULT 0,
  time_spent bigint DEFAULT 0,
  time_spent_percent numeric(10,4) DEFAULT 0,
  share_percent numeric(10,6) DEFAULT 0,
  payout bigint DEFAULT 0,
  crimes_count integer DEFAULT 0,
  crimes_participated text[],
  updated_at timestamp without time zone DEFAULT now(),
  theoretical_payout bigint DEFAULT 0
);

CREATE TABLE public.oc_payout_weeks (
  id integer DEFAULT nextval('oc_payout_weeks_id_seq'::regclass) NOT NULL,
  week_start date NOT NULL,
  week_end date NOT NULL,
  week_start_timestamp bigint,
  week_end_timestamp bigint,
  total_money_reward bigint DEFAULT 0,
  total_item_reward bigint DEFAULT 0,
  total_item_cost bigint DEFAULT 0,
  net_item_value bigint DEFAULT 0,
  faction_cut_percent numeric(5,2) DEFAULT 20.00,
  faction_cut_amount bigint DEFAULT 0,
  member_payout_total bigint DEFAULT 0,
  total_member_payout bigint DEFAULT 0,
  member_count integer DEFAULT 0,
  crimes_processed integer DEFAULT 0,
  total_time_spent bigint DEFAULT 0,
  average_time_spent bigint DEFAULT 0,
  total_adjusted_tickets numeric(10,4) DEFAULT 0,
  total_time_spent_percent numeric(10,4) DEFAULT 0,
  min_time_for_full_tickets integer DEFAULT 432000,
  min_time_for_any_payout integer DEFAULT 172800,
  saved_by text,
  saved_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  crime_ids text[],
  payout_mode text
);

CREATE TABLE public.pricing_batches (
  id integer DEFAULT nextval('pricing_batches_id_seq'::regclass) NOT NULL,
  item_id text,
  price bigint NOT NULL,
  quantity integer NOT NULL,
  added_at timestamp without time zone DEFAULT now(),
  added_by text NOT NULL
);

CREATE TABLE public.ranked_wars (
  id integer NOT NULL,
  start_at bigint NOT NULL,
  end_at bigint,
  opponent_id integer,
  opponent_name text,
  our_score integer DEFAULT 0,
  opponent_score integer DEFAULT 0,
  target integer,
  winner_faction_id integer,
  forfeit boolean DEFAULT false,
  is_termed boolean DEFAULT false,
  rewards_items jsonb,
  rank_before text,
  rank_after text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  -- Wars-sync progress flags (slice #70): a completed war's report is
  -- fetched once; permanently-unavailable reports are skipped forever.
  report_fetched boolean DEFAULT false NOT NULL,
  report_unavailable boolean DEFAULT false NOT NULL
);

-- Scraper infrastructure (slice #67): structured run log + per-job flags.
CREATE TABLE public.scraper_runs (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  job_name text NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  finished_at timestamp with time zone,
  status text DEFAULT 'running' NOT NULL,
  rows_written integer DEFAULT 0 NOT NULL,
  error text,
  details jsonb
);

CREATE TABLE public.scraper_jobs (
  job_name text NOT NULL,
  cron_schedule text NOT NULL,
  enabled boolean DEFAULT true NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.sync_metadata (
  id integer DEFAULT nextval('sync_metadata_id_seq'::regclass) NOT NULL,
  data_type text NOT NULL,
  last_sync timestamp without time zone NOT NULL,
  synced_by text NOT NULL
);

CREATE TABLE public.tier_requirements (
  tier integer NOT NULL,
  requirement_index integer NOT NULL,
  difficulty_level integer NOT NULL,
  role_name text NOT NULL,
  min_cpr numeric(5,2) NOT NULL,
  is_average boolean DEFAULT false,
  payout_tickets integer DEFAULT 2 NOT NULL
);

CREATE TABLE public.war_member_contributions (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  war_id integer NOT NULL,
  member_id integer NOT NULL,
  member_name text,
  level integer,
  attacks integer DEFAULT 0,
  score numeric(10,2) DEFAULT 0,
  faction_id integer,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.war_payout_members (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  payout_id bigint NOT NULL,
  member_id integer NOT NULL,
  member_name text,
  score numeric(10,2) DEFAULT 0,
  attacks integer DEFAULT 0,
  assist_attacks integer DEFAULT 0,
  payout_amount bigint DEFAULT 0,
  is_eligible boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  multiplier_overrides jsonb,
  war_hits integer DEFAULT 0,
  regular_hits integer DEFAULT 0,
  mugs integer DEFAULT 0,
  losses integer DEFAULT 0,
  race_breakdown jsonb,
  -- This member's final share of the payout pool (payout_amount / the
  -- war_payouts row's total_payout), server-computed at save time — not
  -- trusted from the client, and not the same number as participationShare
  -- or contributionShare (race_breakdown carries those per pre/post window).
  -- Backfilled for pre-existing rows by 0049-war-payout-effort-share.sql.
  effort_share numeric
);

CREATE TABLE public.war_payouts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  war_id integer NOT NULL,
  war_type text NOT NULL,
  faction_cut_percent numeric(5,2) DEFAULT 20,
  price_melee_cache bigint DEFAULT 0,
  price_armor_cache bigint DEFAULT 0,
  price_small_arms_cache bigint DEFAULT 0,
  price_medium_arms_cache bigint DEFAULT 0,
  price_heavy_arms_cache bigint DEFAULT 0,
  min_score_threshold numeric(10,2) DEFAULT 0,
  flat_payout_amount bigint DEFAULT 0,
  score_multiplier numeric(8,4) DEFAULT 1.0,
  attacks_weight numeric(5,4) DEFAULT 0.5,
  effort_weight numeric(5,4) DEFAULT 0.5,
  assist_multiplier numeric(5,4) DEFAULT 0.25,
  min_payout_threshold bigint DEFAULT 0,
  notes text,
  created_by text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  merc_cost bigint DEFAULT 0 NOT NULL,
  reviver_cost bigint DEFAULT 0 NOT NULL,
  faction_top_up bigint DEFAULT 0 NOT NULL,
  termed_mode text,
  race_target_score numeric,
  race_cutoff_mode text,
  race_cutoff_timestamp bigint,
  race_post_cutoff_mode text,
  race_pre_cutoff_percent integer DEFAULT 50,
  war_hit_multiplier numeric DEFAULT 1.25,
  loss_multiplier numeric DEFAULT 0.50,
  mug_multiplier numeric DEFAULT '-1.00'::numeric,
  regular_hit_multiplier numeric DEFAULT 0.00,
  participation_weight integer DEFAULT 50,
  member_count integer DEFAULT 0,
  total_reward numeric DEFAULT 0,
  total_payout numeric DEFAULT 0,
  post_war_hit_multiplier numeric,
  post_assist_multiplier numeric,
  post_loss_multiplier numeric,
  post_mug_multiplier numeric,
  post_regular_hit_multiplier numeric,
  post_participation_weight numeric,
  post_dist_mode text DEFAULT 'formula'::text NOT NULL,
  post_flat_threshold numeric DEFAULT 0 NOT NULL,
  post_scale_enabled boolean DEFAULT false NOT NULL,
  post_scale_hours integer DEFAULT 24 NOT NULL
);

-- Service-side only cache of API-key auth checks.
CREATE TABLE public.war_room_auth_cache (
  key_hash text NOT NULL,
  user_id text NOT NULL,
  expires_at timestamp with time zone NOT NULL
);

CREATE TABLE public.war_room_chain_v2 (
  id integer DEFAULT 1 NOT NULL,
  current integer,
  max integer,
  modifier numeric,
  timeout bigint,
  start_ts bigint,
  cooldown bigint,
  end_ts bigint,
  save_claimed_by bigint,
  save_claimed_name text,
  save_claimed_at timestamp with time zone,
  enemy jsonb,
  our_last_fetched_at timestamp with time zone,
  enemy_last_fetched_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.war_room_config_v2 (
  id integer DEFAULT 1 NOT NULL,
  enabled boolean DEFAULT false NOT NULL,
  faction_id bigint,
  faction_name text,
  revive_service_name text,
  revive_service_url text,
  revive_services jsonb,
  started_by bigint,
  started_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  tornstats_max_age_days integer DEFAULT 0 NOT NULL,
  chain_poll_interval_ours_sec integer DEFAULT 5 NOT NULL,
  chain_poll_interval_enemy_sec integer DEFAULT 30 NOT NULL,
  auto_managed boolean DEFAULT false NOT NULL,
  managed_war_id bigint,
  dibs_expiry_seconds integer DEFAULT 30 NOT NULL,
  headline_text text,
  headline_tone text,
  headline_set_by bigint,
  headline_set_at timestamp with time zone,
  surge_alerts_enabled boolean DEFAULT false NOT NULL,
  surge_enemy_threshold integer DEFAULT 3 NOT NULL,
  surge_enemy_window_sec integer DEFAULT 60 NOT NULL,
  surge_our_threshold integer DEFAULT 4 NOT NULL,
  surge_our_window_sec integer DEFAULT 60 NOT NULL,
  surge_cooldown_sec integer DEFAULT 300 NOT NULL,
  -- Revive-surge alerts (#359): a second detector watching members turn their
  -- revives ON, which is the push being set up rather than already under way.
  surge_revive_alerts_enabled boolean DEFAULT false NOT NULL,
  surge_revive_enemy_threshold integer DEFAULT 3 NOT NULL,
  surge_revive_enemy_window_sec integer DEFAULT 300 NOT NULL,
  surge_revive_our_threshold integer DEFAULT 4 NOT NULL,
  surge_revive_our_window_sec integer DEFAULT 300 NOT NULL,
  surge_revive_cooldown_sec integer DEFAULT 600 NOT NULL,
  member_stats_poll_interval_sec integer DEFAULT 0 NOT NULL,
  roster_poll_interval_ms integer DEFAULT 1000 NOT NULL,
  -- When the roster sync last ran (#330 fix). Board liveness is a property of
  -- the board, not of any one member's row — see db/migrations/0033.
  last_roster_sync_at timestamp with time zone,
  -- #480: when the lifecycle job first saw the currently-managed war matched
  -- (stamped once, at auto-setup). The reference point for both the
  -- matched+30min auto-enable below and for scoping "OD'd before this war"
  -- against the permanent, cross-war overdose_until latch.
  matched_detected_at timestamp with time zone,
  -- #480: when the lifecycle job auto-enabled this war (stamped once). NULL
  -- means "not yet auto-enabled for the currently-managed war" — the signal
  -- that lets the job attempt auto-enable at most once per war, so a leader
  -- who manually stops it afterwards is never fought on the next tick.
  auto_enabled_at timestamp with time zone
);

-- #336: live energy + cooldowns for our own members. Separate from
-- war_room_state_v2 because it is war-lead-only — its own table gives it its
-- own delta channel, which the hub withholds from non-lead sockets.
-- #348: our own members' battle stats. Lead-only, so it gets its own table
-- (and therefore its own role-checked read path) rather than columns on
-- `members`, which everything reads.
CREATE TABLE public.member_battle_stats (
  member_id text PRIMARY KEY,
  strength bigint,
  defense bigint,
  speed bigint,
  dexterity bigint,
  total bigint,
  source text DEFAULT 'torn' NOT NULL,
  fetched_at timestamp with time zone,
  spy_at timestamp with time zone,
  last_error text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX member_battle_stats_updated_at_idx
  ON public.member_battle_stats (updated_at);

CREATE TABLE public.war_room_member_stats_v2 (
  member_id bigint PRIMARY KEY,
  energy_current integer,
  energy_maximum integer,
  cooldown_drug integer,
  cooldown_medical integer,
  cooldown_booster integer,
  last_error text,
  fetched_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  -- When the overdose that caused the current drug cooldown wears off (#357).
  -- Latched on the first reading above the threshold and never shortened:
  -- cooldown_drug is overwritten every sweep, so a live threshold test loses
  -- the flag as soon as it burns below 10h.
  overdose_until timestamp with time zone
);

CREATE INDEX war_room_member_stats_v2_updated_at_idx
  ON public.war_room_member_stats_v2 (updated_at);

CREATE TABLE public.war_room_dibs_v2 (
  id bigint DEFAULT nextval('war_room_dibs_v2_id_seq'::regclass) NOT NULL,
  target_id bigint NOT NULL,
  claimed_by bigint NOT NULL,
  claimed_name text NOT NULL,
  claimed_at timestamp with time zone DEFAULT now() NOT NULL,
  war_id bigint,
  deleted_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  auto_expire_at timestamp with time zone
);

-- #523: attacker-set, live "raise a hand" markers — smoke/tear/help, one click
-- from the attack page against (requester, target). Deliberately NOT the same
-- table as war_room_dibs_v2: dibs claims a target for a kill; this asks
-- teammates for help mid-fight, and the two can coexist on the same target.
-- `source` is a discriminator seat for CAT's lead-set-in-advance markers
-- (explicitly out of scope for #523) so that feature can land later without a
-- migration that rewrites these rows — default 'live' is the only source built.
CREATE TABLE public.war_room_assists_v2 (
  id bigserial PRIMARY KEY,
  target_id bigint NOT NULL,
  requester_id bigint NOT NULL,
  requester_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('smoke', 'tear', 'help')),
  source text NOT NULL DEFAULT 'live',
  war_id bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  -- Short-timeout backstop (reuses the war_room_dibs_v2 auto_expire_at sweep
  -- pattern, see warRoomAssistsExpiry.ts): armed at creation, always — an
  -- assist request means "I am in this fight right now", not "eventually".
  auto_expire_at timestamp with time zone,
  deleted_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX war_room_assists_v2_updated_at_idx ON public.war_room_assists_v2 (updated_at);
-- One live assist request per requester (mirrors dibs' one-live-claim rule) —
-- a fresh click replaces whatever the requester last asked for.
CREATE UNIQUE INDEX war_room_assists_v2_active_requester_idx
  ON public.war_room_assists_v2 (requester_id) WHERE (deleted_at IS NULL);
CREATE INDEX war_room_assists_v2_active_target_idx
  ON public.war_room_assists_v2 (target_id) WHERE (deleted_at IS NULL);

-- #528 Part 2: enemy loadout observations captured from the attack page once
-- Torn reveals them. Deliberately its OWN table, not war_room_state_v2 — see
-- db/migrations/0046-war-room-loadout-observations.sql for the full reasoning
-- (append-only provenance, hard-pruned rather than tombstoned).
CREATE TABLE public.war_room_loadout_observations_v2 (
  id bigserial PRIMARY KEY,
  target_id bigint NOT NULL,
  observed_by bigint NOT NULL,
  observed_by_name text NOT NULL,
  war_id bigint,
  loadout jsonb NOT NULL,
  observed_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX war_room_loadout_observations_v2_target_idx
  ON public.war_room_loadout_observations_v2 (target_id, observed_at DESC);
CREATE INDEX war_room_loadout_observations_v2_observed_by_idx
  ON public.war_room_loadout_observations_v2 (observed_by, created_at);
CREATE INDEX war_room_loadout_observations_v2_observed_at_idx
  ON public.war_room_loadout_observations_v2 (observed_at);

CREATE TABLE public.war_room_notes_private_v2 (
  war_id bigint NOT NULL,
  notes text,
  updated_by_id bigint,
  updated_by_name text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.war_room_notes_v2 (
  war_id bigint NOT NULL,
  opponent_faction_id bigint,
  war_type text,
  race_target_score integer,
  updated_by_id bigint,
  updated_by_name text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  termed_score_us integer,
  termed_score_them integer,
  notes_public text
);

CREATE TABLE public.war_room_roll_call_v2 (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  war_id bigint NOT NULL,
  member_id bigint NOT NULL,
  member_name text,
  on_at_start boolean NOT NULL,
  can_self_hospital boolean,
  needs_merc boolean,
  availability text,
  revised boolean DEFAULT false NOT NULL,
  submitted_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- #480: one immutable row per member per war, captured within the minute
-- before war start. war_room_member_stats_v2 has no history (overwritten in
-- place every sweep) — this is the only place "what was their energy right
-- before the war" survives past the next tick.
CREATE TABLE public.war_stacks_snapshot (
  war_id bigint NOT NULL,
  member_id bigint NOT NULL,
  member_name text,
  energy_current integer,
  energy_maximum integer,
  -- False when the member had no readable pooled key at capture time — an
  -- explicit "unknown", not a zero and not a missing row (a blank energy cell
  -- reads as zero in a spreadsheet, which is a different, wrong claim).
  has_reading boolean NOT NULL,
  -- overdose_until (war_room_member_stats_v2) is a PERMANENT, cross-war latch
  -- — a member who OD'd three weeks ago and never since would still show one.
  -- This is scoped to THIS war by comparing it against
  -- war_room_config_v2.matched_detected_at at capture time, so it answers
  -- "OD'd since this war was matched", not "OD'd ever".
  od_flagged_prewar boolean NOT NULL,
  captured_at timestamp with time zone NOT NULL,
  PRIMARY KEY (war_id, member_id)
);

CREATE TABLE public.war_room_state_v2 (
  member_id bigint NOT NULL,
  faction_id bigint NOT NULL,
  member_name text NOT NULL,
  level integer,
  "position" text,
  bsp_total bigint,
  bsp_str bigint,
  bsp_spd bigint,
  bsp_def bigint,
  bsp_dex bigint,
  bsp_fetched_at timestamp with time zone,
  state jsonb DEFAULT '{}'::jsonb NOT NULL,
  deleted_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  spy_source text,
  ts_spy_at timestamp with time zone,
  -- When we OBSERVED this member enter Traveling (#330). Torn gives no arrival
  -- time for travel, so the ETA is derived from this plus the known flight time
  -- for the destination and aircraft. NULL means we did not witness the
  -- departure, which is normal — not missing data.
  travel_departed_at timestamp with time zone
);

-- ── New tables for the multi-faction stack ───────────────────────────────────

-- Single row identifying the faction this database (and its API process) serves.
CREATE TABLE public.faction_config (
  id smallint DEFAULT 1 NOT NULL,
  slug text NOT NULL,
  display_name text NOT NULL,
  torn_faction_id bigint NOT NULL,
  branding jsonb DEFAULT '{}'::jsonb NOT NULL,
  features jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Uploaded branding images (#173): logo / favicon / hero, stored as bytea in
-- the tenant DB (small, few — rides existing backups + isolation).
CREATE TABLE public.faction_branding_assets (
  kind         text PRIMARY KEY,
  content_type text NOT NULL,
  bytes        bytea NOT NULL,
  updated_at   timestamp with time zone NOT NULL DEFAULT now()
);

-- #254: feedback attachments (images/video) stored as bytea, keyed to the
-- GitHub issue they were embedded in so the #255 prune can clean them up once
-- that issue closes.
CREATE TABLE public.feedback_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_number integer NOT NULL,
  content_type text NOT NULL,
  bytes        bytea NOT NULL,
  created_at   timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX feedback_attachments_issue_idx ON public.feedback_attachments (issue_number);

-- Per-faction policy settings as whole JSON documents (tier requirements,
-- CPR requirements, payout tickets, ...) — replaces hardcoded frontend config.
-- The leader admin UI (slice #74) edits these; db/seed/03 provides defaults.
CREATE TABLE public.faction_settings (
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Per-faction operator secrets (#105): spy-provider API keys, AES-256-GCM
-- encrypted at rest with KEY_ENCRYPTION_KEY. `hint` = last 4 chars for the
-- admin UI; plaintext never leaves the server.
CREATE TABLE public.faction_secrets (
  name text NOT NULL,
  value_enc bytea NOT NULL,
  hint text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Role grants (replaces the hardcoded LEADERSHIP_IDS/WARLEAD_IDS/ADMIN_IDS/
-- VISITOR_IDS lists). A user may hold several roles.
CREATE TABLE public.role_assignments (
  torn_user_id bigint NOT NULL,
  role text NOT NULL,
  granted_by bigint,
  granted_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Competitions (#183): member-facing contests over faction stats. Leaderboard
-- standings are computed on read from member_daily_stats deltas.
CREATE TABLE public.competitions (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL,
  type         text NOT NULL DEFAULT 'leaderboard',
  metric_id    text NOT NULL,
  direction    text NOT NULL DEFAULT 'desc',
  reducer      text NOT NULL DEFAULT 'total',
  window_kind  text NOT NULL DEFAULT 'fixed',
  window_start timestamp with time zone,
  window_end   timestamp with time zone,
  rolling_days integer,
  auto_resolve boolean NOT NULL DEFAULT false,
  resolve_interval_days integer,
  next_resolve_at timestamp with time zone,
  threshold_comparator text,
  threshold_value double precision,
  pinned       boolean NOT NULL DEFAULT false,
  -- Prize table (#239): prize_kind 'placement' (ordered slots, slot 0 = 1st /
  -- lottery winner) or 'flat' (one prize to all). Each slot in `prizes` is a
  -- tagged jsonb value: {kind:'cash',amount} | {kind:'text',text} | (later)
  -- {kind:'item',item_id,qty}. Informational only.
  prize_kind   text NOT NULL DEFAULT 'placement',
  prizes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by   text,
  created_at   timestamp with time zone NOT NULL DEFAULT now(),
  updated_at   timestamp with time zone NOT NULL DEFAULT now()
);

-- Resolved competition standings (#185): materialised history, one row per
-- member per resolution. Payout-referenceable without recomputation.
CREATE TABLE public.competition_results (
  id             bigserial PRIMARY KEY,
  competition_id bigint NOT NULL,
  resolution_seq integer NOT NULL,
  resolved_at    timestamp with time zone NOT NULL DEFAULT now(),
  resolved_by    text,
  window_start   timestamp with time zone NOT NULL,
  window_end     timestamp with time zone NOT NULL,
  member_id      text NOT NULL,
  member_name    text,
  value          double precision NOT NULL,
  rank           integer NOT NULL,
  partial        boolean NOT NULL DEFAULT false,
  winner         boolean NOT NULL DEFAULT false,
  -- The prize this member earned at resolution (#239), a tagged jsonb slot or
  -- null. Self-contained so history records who won what without recomputation.
  prize          jsonb
);
CREATE INDEX competition_results_competition_idx
  ON public.competition_results (competition_id, resolution_seq);

-- #227: append-only intraday sample series for competition-relevant stats. The
-- frequent member-stats run (and #230's boundary captures) append one slim
-- sample per member; competition resolution reads "latest sample <= boundary".
-- `stats` holds only the competition-relevant personalstats categories
-- (drugs/attacking/hospital/other); gym values (not in personalstats) ride
-- alongside as numeric columns. Prunable — retention keeps recent samples plus
-- any within a still-unresolved competition's window.
CREATE TABLE public.member_stat_samples (
  id            bigserial PRIMARY KEY,
  member_id     text NOT NULL,
  captured_at   timestamp with time zone NOT NULL DEFAULT now(),
  stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
  gym_strength  bigint,
  gym_speed     bigint,
  gym_dexterity bigint,
  gym_defense   bigint,
  gym_energy    bigint
);
-- "latest sample <= T, per member" lookups (resolution boundaries + retention).
CREATE INDEX member_stat_samples_member_time_idx
  ON public.member_stat_samples (member_id, captured_at DESC);
CREATE INDEX member_stat_samples_captured_idx
  ON public.member_stat_samples (captured_at);

-- #284 Observed faction-membership stints: one row per continuous stint
-- (left_at IS NULL = the open/current one). Maintained by members-sync; powers
-- the days-in-faction streak. Lifetime total lives on members.total_days_in_faction.
CREATE TABLE public.member_faction_stints (
  id        bigserial PRIMARY KEY,
  member_id text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at   timestamptz
);
CREATE UNIQUE INDEX member_faction_stints_one_open_idx
  ON public.member_faction_stints (member_id) WHERE left_at IS NULL;
CREATE INDEX member_faction_stints_member_idx
  ON public.member_faction_stints (member_id, joined_at);

-- Per-member war notes (#199): one global note per member, war-lead editable.
CREATE TABLE public.member_notes (
  member_id  text PRIMARY KEY,
  note       text NOT NULL DEFAULT '',
  updated_by text,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- #207: Web Push subscriptions for War Room notifications (one row per browser
-- push endpoint; pruned on 404/410 at delivery).
CREATE TABLE public.push_subscriptions (
  endpoint   text PRIMARY KEY,
  member_id  text NOT NULL,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX push_subscriptions_member_id_idx ON public.push_subscriptions (member_id);

-- #395: faction calendar. Almost everything the calendar shows is DERIVED from
-- tables that already exist (ranked_wars, competitions, oc_payout_weeks,
-- crimes); these two hold only what has no other home. See
-- db/migrations/0037-calendar.sql for the full rationale.
CREATE TABLE public.calendar_events (
  id         bigserial PRIMARY KEY,
  source     text NOT NULL DEFAULT 'manual'
             CHECK (source IN ('manual', 'torn_event')),
  title      text NOT NULL,
  note       text,
  starts_at  timestamptz NOT NULL,
  -- NULL is a point in time, not a zero-length event.
  ends_at    timestamptz,
  -- Torn has no events API, so Christmas Town is typed in — and yearly
  -- recurrence is what keeps a hand-maintained entry from going stale.
  recurrence text NOT NULL DEFAULT 'none'
             CHECK (recurrence IN ('none', 'yearly')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX calendar_events_starts_idx ON public.calendar_events (starts_at);

-- Real-world birthdays. Month/day are what a faction uses; the year is
-- optional and separate, because saying happy birthday needs neither someone's
-- age nor a full date of birth.
-- #395 / #458: faction upgrades snapshotted daily. One row PER DAY, because a
-- current-state table repainted every night would show today's percentages
-- across all of last month — see db/migrations/0038-faction-upgrades.sql.
CREATE TABLE public.faction_upgrade_snapshots (
  snapshot_date date PRIMARY KEY,
  branch_state  text,
  -- NULL means "could not read it", never zero — a faction that has not bought
  -- Strength Training genuinely has 0%, which is a different fact.
  steadfast_strength  numeric,
  steadfast_defense   numeric,
  steadfast_speed     numeric,
  steadfast_dexterity numeric,
  steadfast_unparsed  jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload       jsonb NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);

-- #459: each member's Torn event start hour, for members who opted into that
-- scope. Its own table so withdrawal DELETES rather than hides — a stale value
-- must not outlive the consent that permitted collecting it.
CREATE TABLE public.member_event_settings (
  member_id  text PRIMARY KEY,
  -- Stored exactly as Torn states it ("11:30 TCT"), not parsed on write.
  start_time text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.member_birthdays (
  member_id   text PRIMARY KEY,
  birth_month integer NOT NULL CHECK (birth_month BETWEEN 1 AND 12),
  birth_day   integer NOT NULL CHECK (birth_day BETWEEN 1 AND 31),
  birth_year  integer CHECK (birth_year BETWEEN 1900 AND 2100),
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Constraints ───────────────────────────────────────────────────────────────

ALTER TABLE crime_required_items ADD CONSTRAINT crime_required_items_pkey PRIMARY KEY (id);
ALTER TABLE crime_reward_items ADD CONSTRAINT crime_reward_items_pkey PRIMARY KEY (id);
ALTER TABLE crime_slots ADD CONSTRAINT crime_slots_pkey PRIMARY KEY (id);
ALTER TABLE crimes ADD CONSTRAINT crimes_pkey PRIMARY KEY (crime_id);
ALTER TABLE faction_attacks ADD CONSTRAINT faction_attacks_pkey PRIMARY KEY (attack_id);
ALTER TABLE faction_config ADD CONSTRAINT faction_config_pkey PRIMARY KEY (id);
ALTER TABLE faction_settings ADD CONSTRAINT faction_settings_pkey PRIMARY KEY (key);
ALTER TABLE faction_revives ADD CONSTRAINT faction_revives_pkey PRIMARY KEY (revive_id);
-- #358: the standing revives feed is read as a rolling 24h window, not per war.
CREATE INDEX IF NOT EXISTS idx_faction_revives_target_ts ON public.faction_revives USING btree (target_id, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_faction_revives_ts ON public.faction_revives USING btree ("timestamp" DESC);
ALTER TABLE factions ADD CONSTRAINT factions_pkey PRIMARY KEY (id);
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (id);
ALTER TABLE items ADD CONSTRAINT items_pkey PRIMARY KEY (id);
ALTER TABLE member_cpr_v2 ADD CONSTRAINT member_cpr_v2_pkey PRIMARY KEY (member_id, crime_name, position_label);
ALTER TABLE member_daily_stats ADD CONSTRAINT member_daily_stats_pkey PRIMARY KEY (member_id, snapshot_date);
ALTER TABLE member_overview_thresholds ADD CONSTRAINT member_overview_thresholds_pkey PRIMARY KEY (id);
ALTER TABLE member_overview_views ADD CONSTRAINT member_overview_views_pkey PRIMARY KEY (id);
ALTER TABLE member_secrets ADD CONSTRAINT member_secrets_pkey PRIMARY KEY (member_id);
ALTER TABLE members ADD CONSTRAINT members_pkey PRIMARY KEY (member_id);
ALTER TABLE oc_crime_positions ADD CONSTRAINT oc_crime_positions_pkey PRIMARY KEY (id);
ALTER TABLE oc_crime_types ADD CONSTRAINT oc_crime_types_pkey PRIMARY KEY (id);
ALTER TABLE oc_payout_members ADD CONSTRAINT oc_payout_members_pkey PRIMARY KEY (id);
ALTER TABLE oc_payout_weeks ADD CONSTRAINT oc_payout_weeks_pkey PRIMARY KEY (id);
ALTER TABLE pricing_batches ADD CONSTRAINT pricing_batches_pkey PRIMARY KEY (id);
ALTER TABLE ranked_wars ADD CONSTRAINT ranked_wars_pkey PRIMARY KEY (id);
ALTER TABLE faction_secrets ADD CONSTRAINT faction_secrets_pkey PRIMARY KEY (name);
ALTER TABLE role_assignments ADD CONSTRAINT role_assignments_pkey PRIMARY KEY (torn_user_id, role);
ALTER TABLE sync_metadata ADD CONSTRAINT sync_metadata_pkey PRIMARY KEY (id);
ALTER TABLE scraper_runs ADD CONSTRAINT scraper_runs_pkey PRIMARY KEY (id);
ALTER TABLE scraper_runs ADD CONSTRAINT scraper_runs_status_check CHECK (status IN ('running', 'success', 'failure'));
ALTER TABLE scraper_jobs ADD CONSTRAINT scraper_jobs_pkey PRIMARY KEY (job_name);
CREATE INDEX idx_scraper_runs_job_started ON public.scraper_runs USING btree (job_name, started_at DESC);
ALTER TABLE tier_requirements ADD CONSTRAINT tier_requirements_pkey PRIMARY KEY (tier, requirement_index);
ALTER TABLE war_member_contributions ADD CONSTRAINT war_member_contributions_pkey PRIMARY KEY (id);
ALTER TABLE war_payout_members ADD CONSTRAINT war_payout_members_pkey PRIMARY KEY (id);
ALTER TABLE war_payouts ADD CONSTRAINT war_payouts_pkey PRIMARY KEY (id);
ALTER TABLE war_room_auth_cache ADD CONSTRAINT war_room_auth_cache_pkey PRIMARY KEY (key_hash);
ALTER TABLE war_room_chain_v2 ADD CONSTRAINT war_room_chain_v2_pkey PRIMARY KEY (id);
ALTER TABLE war_room_config_v2 ADD CONSTRAINT war_room_config_v2_pkey PRIMARY KEY (id);
ALTER TABLE war_room_dibs_v2 ADD CONSTRAINT war_room_dibs_v2_pkey PRIMARY KEY (id);
ALTER TABLE war_room_notes_private_v2 ADD CONSTRAINT war_room_notes_private_v2_pkey PRIMARY KEY (war_id);
ALTER TABLE war_room_notes_v2 ADD CONSTRAINT war_room_notes_v2_pkey PRIMARY KEY (war_id);
ALTER TABLE war_room_roll_call_v2 ADD CONSTRAINT war_room_roll_call_v2_pkey PRIMARY KEY (id);
ALTER TABLE war_room_state_v2 ADD CONSTRAINT war_room_state_v2_pkey PRIMARY KEY (member_id);

ALTER TABLE crime_required_items ADD CONSTRAINT crime_required_items_crime_id_position_id_key UNIQUE (crime_id, position_id);
ALTER TABLE crime_reward_items ADD CONSTRAINT crime_reward_items_crime_id_item_id_key UNIQUE (crime_id, item_id);
ALTER TABLE crime_slots ADD CONSTRAINT crime_slots_crime_id_position_id_key UNIQUE (crime_id, position_id);
ALTER TABLE faction_config ADD CONSTRAINT faction_config_slug_key UNIQUE (slug);
ALTER TABLE oc_crime_positions ADD CONSTRAINT oc_crime_positions_crime_name_position_label_key UNIQUE (crime_name, position_label);
ALTER TABLE oc_crime_types ADD CONSTRAINT oc_crime_types_name_key UNIQUE (name);
ALTER TABLE oc_payout_members ADD CONSTRAINT oc_payout_members_week_id_member_id_key UNIQUE (week_id, member_id);
ALTER TABLE oc_payout_weeks ADD CONSTRAINT oc_payout_weeks_week_start_week_end_key UNIQUE (week_start, week_end);
ALTER TABLE war_member_contributions ADD CONSTRAINT war_member_contributions_war_id_member_id_key UNIQUE (war_id, member_id);
ALTER TABLE war_room_roll_call_v2 ADD CONSTRAINT war_room_roll_call_v2_uniq UNIQUE (war_id, member_id);

ALTER TABLE crimes ADD CONSTRAINT crimes_difficulty_check CHECK (((difficulty >= 1) AND (difficulty <= 10)));
ALTER TABLE faction_config ADD CONSTRAINT faction_config_singleton CHECK ((id = 1));
ALTER TABLE role_assignments ADD CONSTRAINT role_assignments_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'leadership'::text, 'warlead'::text, 'ocmanager'::text, 'visitor'::text])));
ALTER TABLE tier_requirements ADD CONSTRAINT tier_requirements_difficulty_level_check CHECK (((difficulty_level >= 1) AND (difficulty_level <= 10)));
ALTER TABLE tier_requirements ADD CONSTRAINT tier_requirements_tier_check CHECK (((tier >= 1) AND (tier <= 6)));
ALTER TABLE war_payouts ADD CONSTRAINT war_payouts_post_dist_mode_chk CHECK ((post_dist_mode = ANY (ARRAY['formula'::text, 'flat'::text])));
ALTER TABLE war_payouts ADD CONSTRAINT war_payouts_war_type_check CHECK ((war_type = ANY (ARRAY['real'::text, 'termed'::text, 'race'::text])));
ALTER TABLE war_room_chain_v2 ADD CONSTRAINT war_room_chain_v2_singleton CHECK ((id = 1));
ALTER TABLE war_room_config_v2 ADD CONSTRAINT war_room_config_v2_singleton CHECK ((id = 1));
ALTER TABLE war_room_state_v2 ADD CONSTRAINT war_room_state_v2_spy_source_chk CHECK (((spy_source IS NULL) OR (spy_source = ANY (ARRAY['tornstats'::text, 'bsp'::text]))));

ALTER TABLE crime_required_items ADD CONSTRAINT crime_required_items_crime_id_fkey FOREIGN KEY (crime_id) REFERENCES crimes(crime_id) ON DELETE CASCADE;
ALTER TABLE crime_reward_items ADD CONSTRAINT crime_reward_items_crime_id_fkey FOREIGN KEY (crime_id) REFERENCES crimes(crime_id) ON DELETE CASCADE;
ALTER TABLE crime_slots ADD CONSTRAINT crime_slots_crime_id_fkey FOREIGN KEY (crime_id) REFERENCES crimes(crime_id) ON DELETE CASCADE;
ALTER TABLE crimes ADD CONSTRAINT crimes_payout_week_id_fkey FOREIGN KEY (payout_week_id) REFERENCES oc_payout_weeks(id);
ALTER TABLE faction_revives ADD CONSTRAINT faction_revives_rw_id_fkey FOREIGN KEY (rw_id) REFERENCES ranked_wars(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE member_cpr_v2 ADD CONSTRAINT member_cpr_v2_member_id_fkey FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE CASCADE;
ALTER TABLE member_daily_stats ADD CONSTRAINT member_daily_stats_member_id_fkey FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE CASCADE;
ALTER TABLE member_stat_samples ADD CONSTRAINT member_stat_samples_member_id_fkey FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE CASCADE;
ALTER TABLE member_secrets ADD CONSTRAINT member_secrets_member_id_fkey FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE CASCADE;
ALTER TABLE oc_crime_positions ADD CONSTRAINT oc_crime_positions_crime_name_fkey FOREIGN KEY (crime_name) REFERENCES oc_crime_types(name);
ALTER TABLE oc_payout_members ADD CONSTRAINT oc_payout_members_week_id_fkey FOREIGN KEY (week_id) REFERENCES oc_payout_weeks(id) ON DELETE CASCADE;
ALTER TABLE pricing_batches ADD CONSTRAINT pricing_batches_item_id_fkey FOREIGN KEY (item_id) REFERENCES inventory_items(id);
ALTER TABLE war_member_contributions ADD CONSTRAINT war_member_contributions_war_id_fkey FOREIGN KEY (war_id) REFERENCES ranked_wars(id) ON DELETE CASCADE;
ALTER TABLE war_payout_members ADD CONSTRAINT war_payout_members_payout_id_fkey FOREIGN KEY (payout_id) REFERENCES war_payouts(id) ON DELETE CASCADE;
ALTER TABLE war_payouts ADD CONSTRAINT war_payouts_war_id_fkey FOREIGN KEY (war_id) REFERENCES ranked_wars(id) ON DELETE CASCADE;

-- ── Sequence ownership (serial columns) ──────────────────────────────────────
ALTER SEQUENCE public.crime_required_items_id_seq OWNED BY public.crime_required_items.id;
ALTER SEQUENCE public.crime_reward_items_id_seq OWNED BY public.crime_reward_items.id;
ALTER SEQUENCE public.crime_slots_id_seq OWNED BY public.crime_slots.id;
ALTER SEQUENCE public.oc_crime_positions_id_seq OWNED BY public.oc_crime_positions.id;
ALTER SEQUENCE public.oc_crime_types_id_seq OWNED BY public.oc_crime_types.id;
ALTER SEQUENCE public.oc_payout_members_id_seq OWNED BY public.oc_payout_members.id;
ALTER SEQUENCE public.oc_payout_weeks_id_seq OWNED BY public.oc_payout_weeks.id;
ALTER SEQUENCE public.pricing_batches_id_seq OWNED BY public.pricing_batches.id;
ALTER SEQUENCE public.sync_metadata_id_seq OWNED BY public.sync_metadata.id;
ALTER SEQUENCE public.war_room_dibs_v2_id_seq OWNED BY public.war_room_dibs_v2.id;
ALTER SEQUENCE public.war_room_roll_call_v2_id_seq OWNED BY public.war_room_roll_call_v2.id;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX idx_crime_required_items_consumed ON public.crime_required_items USING btree (was_consumed) WHERE (was_consumed = true);
CREATE INDEX idx_crime_required_items_crime ON public.crime_required_items USING btree (crime_id);
CREATE INDEX idx_crime_required_items_item ON public.crime_required_items USING btree (item_id);
CREATE INDEX idx_crime_required_items_user ON public.crime_required_items USING btree (user_id);
CREATE INDEX idx_crime_reward_items_crime ON public.crime_reward_items USING btree (crime_id);
CREATE INDEX idx_crime_reward_items_item ON public.crime_reward_items USING btree (item_id);
CREATE INDEX idx_crime_slots_crime_id ON public.crime_slots USING btree (crime_id);
CREATE INDEX idx_crime_slots_joined_at ON public.crime_slots USING btree (joined_at);
CREATE INDEX idx_crime_slots_user_id ON public.crime_slots USING btree (user_id);
CREATE INDEX idx_crimes_created_at ON public.crimes USING btree (created_at);
CREATE INDEX idx_crimes_difficulty ON public.crimes USING btree (difficulty);
CREATE INDEX idx_crimes_executed_at ON public.crimes USING btree (executed_at DESC);
CREATE INDEX idx_crimes_executed_status ON public.crimes USING btree (executed_at, status);
CREATE INDEX idx_crimes_payout_week ON public.crimes USING btree (payout_week_id);
CREATE INDEX idx_crimes_status ON public.crimes USING btree (status);
CREATE INDEX idx_faction_attacks_attacker_id ON public.faction_attacks USING btree (attacker_id);
CREATE INDEX idx_faction_attacks_is_ranked_war ON public.faction_attacks USING btree (is_ranked_war) WHERE (is_ranked_war = true);
CREATE INDEX idx_faction_attacks_started ON public.faction_attacks USING btree (started DESC);
CREATE INDEX faction_revives_reviver_faction_id_timestamp_idx ON public.faction_revives USING btree (reviver_faction_id, "timestamp");
CREATE INDEX faction_revives_rw_id_timestamp_idx ON public.faction_revives USING btree (rw_id, "timestamp");
CREATE INDEX faction_revives_target_id_timestamp_idx ON public.faction_revives USING btree (target_id, "timestamp");
CREATE INDEX idx_factions_name ON public.factions USING btree (name);
CREATE INDEX idx_items_name ON public.items USING btree (name);
CREATE INDEX idx_items_type ON public.items USING btree (type);
CREATE INDEX idx_member_cpr_v2_crime ON public.member_cpr_v2 USING btree (crime_name);
CREATE INDEX idx_member_cpr_v2_member ON public.member_cpr_v2 USING btree (member_id);
CREATE INDEX idx_member_daily_stats_date ON public.member_daily_stats USING btree (snapshot_date);
CREATE INDEX idx_member_daily_stats_member ON public.member_daily_stats USING btree (member_id);
CREATE INDEX member_daily_stats_is_donator_idx ON public.member_daily_stats USING btree (is_donator);
CREATE INDEX member_daily_stats_property_name_idx ON public.member_daily_stats USING btree (property_name);
CREATE INDEX member_overview_thresholds_name_idx ON public.member_overview_thresholds USING btree (name);
CREATE INDEX member_overview_views_name_idx ON public.member_overview_views USING btree (name);
CREATE INDEX idx_members_is_current ON public.members USING btree (is_current);
CREATE INDEX idx_oc_crime_pos_crime ON public.oc_crime_positions USING btree (crime_name);
CREATE INDEX idx_oc_payout_members_member ON public.oc_payout_members USING btree (member_id);
CREATE INDEX idx_payout_members_member_id ON public.oc_payout_members USING btree (member_id);
CREATE INDEX idx_payout_members_member_week ON public.oc_payout_members USING btree (member_id, week_id);
CREATE INDEX idx_payout_members_payout ON public.oc_payout_members USING btree (payout DESC);
CREATE INDEX idx_payout_members_week_dates ON public.oc_payout_members USING btree (week_start DESC, week_end DESC);
CREATE INDEX idx_payout_members_week_id ON public.oc_payout_members USING btree (week_id);
CREATE INDEX idx_payout_weeks_dates ON public.oc_payout_weeks USING btree (week_start DESC, week_end DESC);
CREATE INDEX idx_payout_weeks_timestamps ON public.oc_payout_weeks USING btree (week_start_timestamp, week_end_timestamp);
CREATE INDEX idx_ranked_wars_end_at ON public.ranked_wars USING btree (end_at DESC NULLS LAST);
CREATE INDEX idx_ranked_wars_start_at ON public.ranked_wars USING btree (start_at DESC);
CREATE INDEX idx_wmc_member_id ON public.war_member_contributions USING btree (member_id);
CREATE INDEX idx_wmc_war_id ON public.war_member_contributions USING btree (war_id);
CREATE INDEX idx_wpm_member_id ON public.war_payout_members USING btree (member_id);
CREATE INDEX idx_wpm_payout_id ON public.war_payout_members USING btree (payout_id);
CREATE INDEX idx_war_payouts_war_id ON public.war_payouts USING btree (war_id);
CREATE INDEX war_room_chain_v2_updated_at_idx ON public.war_room_chain_v2 USING btree (updated_at);
CREATE INDEX war_room_config_v2_updated_at_idx ON public.war_room_config_v2 USING btree (updated_at);
CREATE INDEX war_room_dibs_v2_updated_at_idx ON public.war_room_dibs_v2 USING btree (updated_at);
CREATE UNIQUE INDEX war_room_dibs_v2_active_target_idx ON public.war_room_dibs_v2 USING btree (target_id) WHERE (deleted_at IS NULL);
CREATE INDEX war_room_roll_call_v2_war_idx ON public.war_room_roll_call_v2 USING btree (war_id);
CREATE INDEX war_room_state_v2_faction_id_idx ON public.war_room_state_v2 USING btree (faction_id);
CREATE INDEX war_room_state_v2_updated_at_idx ON public.war_room_state_v2 USING btree (updated_at);

-- ── Functions ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_member_cpr_key(p_member_id text, p_secret text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_encrypted bytea;
begin
  if p_member_id is null or p_secret is null then
    return null;
  end if;

  select cpr_api_key into v_encrypted
    from public.member_secrets
   where member_id = p_member_id;

  if v_encrypted is null then
    return null;
  end if;

  return pgp_sym_decrypt(v_encrypted, p_secret)::text;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_next_api_key(p_secret text, p_faction_only boolean DEFAULT true)
 RETURNS TABLE(member_id text, api_key text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
  v_idx   int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.member_secrets ms
  WHERE COALESCE(ms.disabled, false) = false
    AND (
      NOT p_faction_only
      OR (COALESCE(ms.has_faction_access, false) = true
          AND COALESCE(ms.key_level, 0) >= 3)
    );

  IF v_count = 0 THEN
    RETURN;  -- empty pool — caller surfaces a clear error
  END IF;

  v_idx := (nextval('public.api_key_rotation_seq') % v_count);

  RETURN QUERY
  SELECT sub.member_id::text,
         public.get_member_cpr_key(sub.member_id::text, p_secret)
  FROM (
    SELECT ms.member_id
    FROM public.member_secrets ms
    WHERE COALESCE(ms.disabled, false) = false
      AND (
        NOT p_faction_only
        OR (COALESCE(ms.has_faction_access, false) = true
            AND COALESCE(ms.key_level, 0) >= 3)
      )
    ORDER BY ms.member_id
    OFFSET v_idx LIMIT 1
  ) sub;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_active_key_pool(p_secret text, p_faction_only boolean DEFAULT true)
 RETURNS TABLE(member_id text, api_key text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ms.member_id::text,
         public.get_member_cpr_key(ms.member_id::text, p_secret)
  FROM public.member_secrets ms
  WHERE COALESCE(ms.disabled, false) = false
    AND (
      NOT p_faction_only
      OR (COALESCE(ms.has_faction_access, false) = true
          AND COALESCE(ms.key_level, 0) >= 3)
    )
  ORDER BY ms.member_id;
$function$
;

CREATE OR REPLACE FUNCTION public.get_member_api_key(p_member_id text, p_secret text)
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.get_member_cpr_key(p_member_id, p_secret);
$function$
;

CREATE OR REPLACE FUNCTION public.set_member_cpr_key(p_member_id text, p_raw_key text, p_secret text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if p_member_id is null or length(trim(p_member_id)) = 0 then
    raise exception 'p_member_id is required';
  end if;

  -- Treat null / empty as a "clear the key" request: remove the row.
  if p_raw_key is null or length(trim(p_raw_key)) = 0 then
    delete from public.member_secrets where member_id = p_member_id;
    return;
  end if;

  if p_secret is null or length(p_secret) = 0 then
    raise exception 'p_secret is required to encrypt';
  end if;

  insert into public.member_secrets (member_id, cpr_api_key, updated_at)
  values (p_member_id, pgp_sym_encrypt(p_raw_key, p_secret), now())
  on conflict (member_id) do update
    set cpr_api_key = excluded.cpr_api_key,
        updated_at  = now();
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_member_api_key(p_member_id text, p_raw_key text, p_secret text, p_key_level smallint DEFAULT NULL::smallint, p_has_faction_access boolean DEFAULT NULL::boolean, p_member_rank text DEFAULT NULL::text, p_consent_version text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Encryption + insert/delete is owned by the existing CPR RPC so we have a
  -- single source of truth for how keys are stored.
  PERFORM public.set_member_cpr_key(p_member_id, p_raw_key, p_secret);

  -- Layer metadata on top (only when a key was actually stored). Consent is
  -- stamped only when a consent_version is supplied (i.e. from the opt-in
  -- flow) so the metadata backfill doesn't overwrite real consent timestamps.
  IF p_raw_key IS NOT NULL AND btrim(p_raw_key) <> '' THEN
    UPDATE public.member_secrets
       SET key_level          = COALESCE(p_key_level, key_level),
           has_faction_access = COALESCE(p_has_faction_access, has_faction_access),
           member_rank        = COALESCE(p_member_rank, member_rank),
           consent_at         = CASE WHEN p_consent_version IS NOT NULL THEN now() ELSE consent_at END,
           consent_version    = COALESCE(p_consent_version, consent_version),
           key_fingerprint    = right(btrim(p_raw_key), 4),
           disabled           = false,
           last_error         = NULL
     WHERE member_id::text = p_member_id;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_member_has_cpr_key()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member_id text;
begin
  if (TG_OP = 'DELETE') then
    v_member_id := OLD.member_id;
  else
    v_member_id := NEW.member_id;
  end if;

  update public.members m
     set has_cpr_key = exists (
       select 1 from public.member_secrets ms
        where ms.member_id = v_member_id
          and ms.cpr_api_key is not null
     ),
       updated_at = now()
   where m.member_id = v_member_id;

  return null;  -- AFTER trigger, return value ignored
end;
$function$
;

CREATE OR REPLACE FUNCTION public.touch_updated_at_v2()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.war_room_chain_v2_delta(p_since timestamp with time zone)
 RETURNS TABLE(rows jsonb, server_now timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(jsonb_agg(to_jsonb(c.*)), '[]'::jsonb) AS rows,
    v_now                                            AS server_now
  FROM public.war_room_chain_v2 c
  WHERE c.updated_at > COALESCE(p_since, '-infinity'::timestamptz)
    AND c.updated_at <= v_now;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.war_room_config_v2_delta(p_since timestamp with time zone)
 RETURNS TABLE(rows jsonb, server_now timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(jsonb_agg(to_jsonb(c.*)), '[]'::jsonb) AS rows,
    v_now AS server_now
  FROM public.war_room_config_v2 c
  WHERE c.updated_at > COALESCE(p_since, '-infinity'::timestamptz)
    AND c.updated_at <= v_now;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.war_room_dibs_v2_delta(p_since timestamp with time zone)
 RETURNS TABLE(rows jsonb, server_now timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(jsonb_agg(to_jsonb(d.*) ORDER BY d.updated_at), '[]'::jsonb) AS rows,
    v_now AS server_now
  FROM public.war_room_dibs_v2 d
  WHERE d.updated_at > COALESCE(p_since, '-infinity'::timestamptz)
    AND d.updated_at <= v_now;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.war_room_state_v2_delta(p_since timestamp with time zone)
 RETURNS TABLE(rows jsonb, server_now timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.updated_at), '[]'::jsonb) AS rows,
    v_now AS server_now
  FROM public.war_room_state_v2 s
  WHERE s.updated_at > COALESCE(p_since, '-infinity'::timestamptz)
    AND s.updated_at <= v_now;
END;
$function$
;

-- ── Triggers ──────────────────────────────────────────────────────────────────
-- (war_room_config_v2_cron_gate is intentionally omitted — pg_cron is gone.)
CREATE TRIGGER trg_member_secrets_sync_has_cpr_key AFTER INSERT OR DELETE OR UPDATE ON public.member_secrets FOR EACH ROW EXECUTE FUNCTION sync_member_has_cpr_key();
CREATE TRIGGER touch_updated_at_chain_v2 BEFORE INSERT OR UPDATE ON public.war_room_chain_v2 FOR EACH ROW EXECUTE FUNCTION touch_updated_at_v2();
CREATE TRIGGER touch_updated_at_config_v2 BEFORE INSERT OR UPDATE ON public.war_room_config_v2 FOR EACH ROW EXECUTE FUNCTION touch_updated_at_v2();
CREATE TRIGGER touch_updated_at_dibs_v2 BEFORE INSERT OR UPDATE ON public.war_room_dibs_v2 FOR EACH ROW EXECUTE FUNCTION touch_updated_at_v2();
CREATE TRIGGER touch_updated_at_notes_private_v2 BEFORE INSERT OR UPDATE ON public.war_room_notes_private_v2 FOR EACH ROW EXECUTE FUNCTION touch_updated_at_v2();
CREATE TRIGGER touch_updated_at_notes_v2 BEFORE INSERT OR UPDATE ON public.war_room_notes_v2 FOR EACH ROW EXECUTE FUNCTION touch_updated_at_v2();
CREATE TRIGGER touch_updated_at_state_v2 BEFORE INSERT OR UPDATE ON public.war_room_state_v2 FOR EACH ROW EXECUTE FUNCTION touch_updated_at_v2();
CREATE TRIGGER touch_updated_at_faction_config BEFORE INSERT OR UPDATE ON public.faction_config FOR EACH ROW EXECUTE FUNCTION touch_updated_at_v2();
CREATE TRIGGER touch_updated_at_faction_settings BEFORE INSERT OR UPDATE ON public.faction_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at_v2();

-- ── Views ─────────────────────────────────────────────────────────────────────

CREATE VIEW public.crime_stats AS
 SELECT status,
    difficulty,
    count(*) AS count,
    sum(rewards_money) AS total_money,
    sum(rewards_respect) AS total_respect
   FROM crimes
  GROUP BY status, difficulty;

CREATE VIEW public.crime_stats_by_difficulty AS
 SELECT difficulty,
    count(*) AS total_crimes,
    count(*) FILTER (WHERE status = 'Successful'::text) AS successful,
    count(*) FILTER (WHERE status = ANY (ARRAY['Failed'::text, 'Failure'::text])) AS failed,
    round(100.0 * count(*) FILTER (WHERE status = 'Successful'::text)::numeric / NULLIF(count(*), 0)::numeric, 2) AS success_rate,
    sum(rewards_money) FILTER (WHERE status = 'Successful'::text) AS total_money_reward
   FROM crimes
  WHERE executed_at IS NOT NULL
  GROUP BY difficulty
  ORDER BY difficulty;

CREATE VIEW public.inventory_items_with_prices AS
 SELECT ii.id AS item_id,
    ii.name AS item_name,
    ii.quantity,
    ii.available,
    ii.loaned,
    ii.loaned_to,
    ii.api_type,
    ii.category,
    ii.last_synced,
    COALESCE(sum(pb.price * pb.quantity) / NULLIF(sum(pb.quantity), 0)::numeric, 0::numeric) AS weighted_avg_price,
    COALESCE(sum(pb.quantity), 0::bigint) AS total_batched_quantity,
    COALESCE(sum(pb.price * pb.quantity) / NULLIF(sum(pb.quantity), 0)::numeric * ii.quantity::numeric, 0::numeric) AS total_value,
    max(pb.added_at) AS last_price_update
   FROM inventory_items ii
     LEFT JOIN pricing_batches pb ON ii.id = pb.item_id
  GROUP BY ii.id, ii.name, ii.quantity, ii.available, ii.loaned, ii.loaned_to, ii.api_type, ii.category, ii.last_synced;

CREATE VIEW public.inventory_armor AS
 SELECT item_id,
    item_name,
    quantity,
    available,
    loaned,
    loaned_to,
    api_type,
    category,
    last_synced,
    weighted_avg_price,
    total_batched_quantity,
    total_value,
    last_price_update
   FROM inventory_items_with_prices
  WHERE category = 'armor'::text;

CREATE VIEW public.inventory_caches AS
 SELECT item_id,
    item_name,
    quantity,
    available,
    loaned,
    loaned_to,
    api_type,
    category,
    last_synced,
    weighted_avg_price,
    total_batched_quantity,
    total_value,
    last_price_update
   FROM inventory_items_with_prices
  WHERE category = 'caches'::text;

CREATE VIEW public.inventory_cesium AS
 SELECT item_id,
    item_name,
    quantity,
    available,
    loaned,
    loaned_to,
    api_type,
    category,
    last_synced,
    weighted_avg_price,
    total_batched_quantity,
    total_value,
    last_price_update
   FROM inventory_items_with_prices
  WHERE category = 'cesium'::text;

CREATE VIEW public.inventory_crime_items AS
 SELECT item_id,
    item_name,
    quantity,
    available,
    loaned,
    loaned_to,
    api_type,
    category,
    last_synced,
    weighted_avg_price,
    total_batched_quantity,
    total_value,
    last_price_update
   FROM inventory_items_with_prices
  WHERE item_id = ANY (ARRAY['66'::text, '67'::text, '68'::text, '69'::text, '70'::text, '71'::text, '72'::text, '74'::text, '159'::text, '213'::text, '568'::text, '579'::text, '981'::text, '1080'::text, '1203'::text, '1258'::text, '1284'::text, '1331'::text, '1350'::text, '1362'::text, '1380'::text, '1383'::text, '73'::text, '103'::text, '158'::text, '172'::text, '188'::text, '190'::text, '201'::text, '222'::text, '226'::text, '256'::text, '567'::text, '576'::text, '643'::text, '856'::text, '1012'::text, '1094'::text, '1223'::text, '1230'::text, '884'::text, '1361'::text, '1379'::text, '1381'::text, '1429'::text, '1430'::text, '1461'::text, '1431'::text]);

CREATE VIEW public.inventory_drugs AS
 SELECT item_id,
    item_name,
    quantity,
    available,
    loaned,
    loaned_to,
    api_type,
    category,
    last_synced,
    weighted_avg_price,
    total_batched_quantity,
    total_value,
    last_price_update
   FROM inventory_items_with_prices
  WHERE category = 'drugs'::text;

CREATE VIEW public.inventory_medical AS
 SELECT item_id,
    item_name,
    quantity,
    available,
    loaned,
    loaned_to,
    api_type,
    category,
    last_synced,
    weighted_avg_price,
    total_batched_quantity,
    total_value,
    last_price_update
   FROM inventory_items_with_prices
  WHERE category = 'medical'::text;

CREATE VIEW public.inventory_temporary AS
 SELECT item_id,
    item_name,
    quantity,
    available,
    loaned,
    loaned_to,
    api_type,
    category,
    last_synced,
    weighted_avg_price,
    total_batched_quantity,
    total_value,
    last_price_update
   FROM inventory_items_with_prices
  WHERE category = 'temporary'::text;

CREATE VIEW public.inventory_utilities AS
 SELECT item_id,
    item_name,
    quantity,
    available,
    loaned,
    loaned_to,
    api_type,
    category,
    last_synced,
    weighted_avg_price,
    total_batched_quantity,
    total_value,
    last_price_update
   FROM inventory_items_with_prices
  WHERE category = 'utilities'::text;

CREATE VIEW public.inventory_weapons AS
 SELECT item_id,
    item_name,
    quantity,
    available,
    loaned,
    loaned_to,
    api_type,
    category,
    last_synced,
    weighted_avg_price,
    total_batched_quantity,
    total_value,
    last_price_update
   FROM inventory_items_with_prices
  WHERE category = 'weapons'::text;

CREATE VIEW public.member_crime_participation AS
 SELECT cs.user_id AS member_id,
    cs.user_name AS member_name,
    count(DISTINCT cs.crime_id) AS total_crimes,
    count(DISTINCT cs.crime_id) FILTER (WHERE c.status = 'Successful'::text) AS successful_crimes,
    count(DISTINCT cs.crime_id) FILTER (WHERE c.status = ANY (ARRAY['Failed'::text, 'Failure'::text])) AS failed_crimes,
    avg(cs.checkpoint_pass_rate) AS avg_cpr,
    sum(c.rewards_money) FILTER (WHERE c.status = 'Successful'::text) / NULLIF(count(DISTINCT cs.crime_id) FILTER (WHERE c.status = 'Successful'::text), 0)::numeric AS avg_crime_reward
   FROM crime_slots cs
     JOIN crimes c ON cs.crime_id = c.crime_id
  WHERE cs.user_id IS NOT NULL
  GROUP BY cs.user_id, cs.user_name;

CREATE VIEW public.member_payout_summary AS
 SELECT member_id,
    member_name,
    count(DISTINCT week_id) AS weeks_active,
    sum(payout) AS total_payout,
    avg(payout) AS avg_payout,
    sum(theoretical_payout) AS total_theoretical,
    sum(time_spent) AS total_time,
    max(tier) AS current_tier,
    max(week_end) AS last_payout_date
   FROM oc_payout_members pm
  GROUP BY member_id, member_name;

CREATE VIEW public.payout_summary AS
 SELECT w.id AS week_id,
    w.week_start,
    w.week_end,
    w.member_count,
    w.total_member_payout,
    w.total_time_spent,
    w.crimes_processed,
    count(m.id) AS members_with_payouts,
    sum(m.payout) AS actual_payout_total,
    avg(m.payout) AS avg_payout_per_member,
    max(m.payout) AS max_payout,
    min(m.payout) AS min_payout
   FROM oc_payout_weeks w
     LEFT JOIN oc_payout_members m ON w.id = m.week_id
  GROUP BY w.id, w.week_start, w.week_end, w.member_count, w.total_member_payout, w.total_time_spent, w.crimes_processed
  ORDER BY w.week_start DESC;

CREATE VIEW public.weekly_payout_stats AS
 SELECT id,
    week_start,
    week_end,
    member_payout_total,
    total_money_reward,
    total_item_reward,
    total_item_cost,
    crimes_processed,
    member_count,
    faction_cut_percent,
    COALESCE(array_length(crime_ids, 1), 0) AS linked_crime_count,
    saved_by,
    saved_at
   FROM oc_payout_weeks pw
  ORDER BY week_end DESC;
