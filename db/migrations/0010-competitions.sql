-- #183: Competitions — internal, member-facing contests over faction stats.
-- A competition names a metric (from the code-defined registry) and a window;
-- the leaderboard is computed on read from member_daily_stats.personalstats
-- deltas (no denormalised standings in this slice — that arrives with #185).
-- `type` is forward-looking ('leaderboard' now; 'lottery' lands with #187) and
-- `direction` lets a contest rank lowest-wins (e.g. fewest hospital trips).
CREATE TABLE IF NOT EXISTS public.competitions (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL,
  type         text NOT NULL DEFAULT 'leaderboard',
  metric_id    text NOT NULL,
  direction    text NOT NULL DEFAULT 'desc',
  window_start date NOT NULL,
  window_end   date NOT NULL,
  created_by   text,
  created_at   timestamp with time zone NOT NULL DEFAULT now(),
  updated_at   timestamp with time zone NOT NULL DEFAULT now()
);
