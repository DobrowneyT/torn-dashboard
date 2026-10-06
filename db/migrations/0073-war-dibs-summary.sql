-- #530 — per-war, per-member dibs activity, computed once after the war ends.
--
-- ⚠️ **This exists so the raw claims can eventually be pruned.**
-- `war_room_dibs_v2` has never been pruned (2,627 rows on forge to describe one
-- live claim, 2026-08-19), and a report reading it turns that incidental
-- accumulation into a retention commitment. Summarising per war is what makes
-- pruning possible later — but pruning is irreversible and NOT enabled by this
-- migration: the raw rows stay until the stored numbers have been checked
-- against them over at least one real war.
CREATE TABLE IF NOT EXISTS public.war_dibs_summary (
  war_id    bigint NOT NULL,
  member_id bigint NOT NULL,
  -- The name as the war recorded it, not today's. A post-mortem read months
  -- later should say what people were called at the time.
  member_name text,

  claims      integer NOT NULL DEFAULT 0,
  -- One bucket per claim, mutually exclusive and exhaustive: these eleven sum
  -- to `claims`. ⚠️ Audited on purpose — a leaderboard whose columns do not add
  -- up is one nobody can check, which is the opposite of what a metric with
  -- members' names on it needs.
  converted   integer NOT NULL DEFAULT 0,
  attempted   integer NOT NULL DEFAULT 0,
  taken_from  integer NOT NULL DEFAULT 0,
  no_swing    integer NOT NULL DEFAULT 0,
  outside     integer NOT NULL DEFAULT 0,
  released    integer NOT NULL DEFAULT 0,
  hopped      integer NOT NULL DEFAULT 0,
  overridden  integer NOT NULL DEFAULT 0,
  board_reset integer NOT NULL DEFAULT 0,
  still_open  integer NOT NULL DEFAULT 0,
  unknown     integer NOT NULL DEFAULT 0,

  -- Claims where the holder attacked the target at all, win or lose.
  swung       integer NOT NULL DEFAULT 0,
  -- ⚠️ The OTHER axis. "Stolen" is two numbers that cannot share a column:
  -- taken FROM a holder, and taken BY an offender. The top-offenders question
  -- needs this one, and a member can be on both sides in the same war.
  took_from_others integer NOT NULL DEFAULT 0,

  PRIMARY KEY (war_id, member_id)
);

-- Which wars have been summarised, and on what basis.
--
-- ⚠️ Separate from the rows above because a war with NO claims produces no
-- summary rows at all, and without this you cannot tell "not computed yet" from
-- "computed, nothing to show". The prune gate will read this table.
CREATE TABLE IF NOT EXISTS public.war_dibs_summary_state (
  war_id      bigint PRIMARY KEY,
  computed_at timestamptz NOT NULL DEFAULT now(),
  claims_seen integer NOT NULL DEFAULT 0,
  -- ⚠️ The tunable that PRODUCED these numbers, stored with them. If the grace
  -- window is ever retuned, two wars computed under different values are not
  -- comparable, and a stored figure with no record of its inputs cannot be
  -- defended to the member it describes.
  grace_seconds integer NOT NULL,
  -- Bumped in code when the classifier's rules change, so a war summarised by
  -- an older version is recomputed rather than silently left stale.
  summary_version integer NOT NULL DEFAULT 1
);
