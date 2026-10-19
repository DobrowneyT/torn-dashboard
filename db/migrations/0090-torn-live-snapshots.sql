-- #1019 — the latest full Torn response from the jobs that already poll it.
--
-- `crime-occupancy` fetches every joinable crime once a minute and
-- `activity-sample` the whole roster every few minutes, then keep only the
-- slice they need. The OC watch board needs the rest — names, items, CPR,
-- status `until` — and fetching it again would double the calls for data the
-- dashboard already holds. One row per kind, overwritten each poll.
CREATE TABLE IF NOT EXISTS public.torn_live_snapshots (
  kind       text PRIMARY KEY,
  payload    jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
