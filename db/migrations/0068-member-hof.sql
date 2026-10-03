-- #872: per-member Hall of Fame standings, snapshotted daily.
--
-- Requested by Singularity [2573844] (forge). ⚠️ The use case is BRAGGING
-- RIGHTS, not analytics — screening applicants and spotting anomalies were both
-- offered and both declined. Nothing built on this table should read as an
-- assessment of anybody.
--
-- `GET /user/{id}/hof` returns `{ value, rank }` per category in one call, so a
-- faction-internal ranking is derived on read by sorting `value`. It is NOT
-- stored: an internal position changes whenever anybody ELSE's value changes,
-- so a stored copy would be stale the moment a different member trained.
--
-- ⚠️ ONE jsonb column, not fourteen pairs of typed ones. Torn adds HoF
-- categories, and a column-per-category schema turns every addition into a
-- migration. The `faction_upgrade_snapshots.payload` precedent is the model:
-- store what Torn sent, derive on read. A category Torn stops sending simply
-- goes absent rather than becoming a column of nulls.
--
-- ⚠️ `battle_stats` is null for anyone but the requester — straight from the
-- spec: "This field is null when requesting data for other players." A
-- roster-wide battle-stats board cannot be built, by us or anyone. It is
-- excluded at read time rather than rendered as an empty column, because a
-- blank reads as a scrape failure and gets reported as a bug.
CREATE TABLE IF NOT EXISTS public.member_hof_snapshots (
  member_id     text NOT NULL,
  snapshot_date date NOT NULL,
  -- {category: {value, rank}}, exactly as Torn sent it. `rank` is the GLOBAL
  -- Torn position; `value` is the raw figure the internal sort uses.
  hof           jsonb NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, snapshot_date)
);

-- The board reads the newest row per member; history is for movement later.
CREATE INDEX IF NOT EXISTS member_hof_snapshots_date
  ON public.member_hof_snapshots (snapshot_date DESC);
