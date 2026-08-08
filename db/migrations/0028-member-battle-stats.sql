-- #348: our own members' battle stats.
--
-- Separate table rather than columns on `members` for the same reason
-- war_room_member_stats_v2 is separate (#336): this is LEAD-ONLY data. A
-- member's battle stats are the single most sensitive number in Torn — they
-- decide who can hit whom — and `members` is read by everything. Its own
-- table means its own read path, which can carry its own role check.
--
-- Three sources, in descending order of trust:
--   torn      — the member's OWN key via /v2/user?selections=battlestats.
--               Exact and current. Only available for enrolled keys.
--   tornstats — a faction spy report. As fresh as whoever last spied.
--   bsp       — Battle Stats Predictor's estimate. A guess, but better than
--               nothing for members who never enrolled a key.
-- `source` is stored so the UI can say which, rather than presenting an
-- estimate with the same confidence as an exact figure.

CREATE TABLE IF NOT EXISTS public.member_battle_stats (
  -- text, matching members.member_id and every other member-scoped table
  -- (member_notes, member_stat_samples). The war_room_* tables use bigint,
  -- which is a separate lineage — joining across the two needs a cast.
  member_id  text PRIMARY KEY,
  strength   bigint,
  defense    bigint,
  speed      bigint,
  dexterity  bigint,
  total      bigint,
  source     text NOT NULL DEFAULT 'torn',
  -- When the numbers were read from the source. For tornstats this is our
  -- fetch time, not the spy's timestamp — spy_at carries that.
  fetched_at timestamp with time zone,
  spy_at     timestamp with time zone,
  last_error text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS member_battle_stats_updated_at_idx
  ON public.member_battle_stats (updated_at);
