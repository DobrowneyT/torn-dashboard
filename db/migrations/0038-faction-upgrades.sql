-- #395 / #458: faction upgrades, snapshotted daily.
--
-- MonChoon wants Steadfast — the per-stat gym-gain bonus — visible on the
-- calendar. Torn does expose this: `GET /faction/upgrades` returns the branches
-- the faction has bought, each upgrade carrying a `name`, a human-readable
-- `ability` string, and a `level`.
--
-- ⚠️ **One row per day, not one row.** A single current-state table would be
-- the obvious build and it would make the calendar lie: the calendar's whole
-- premise is that a date shows what was true on that date, and a current-state
-- table repainted every night would show today's percentages across all of
-- last month. Snapshotting means the band on the grid can honestly split the
-- day the faction buys an upgrade — and, before we started recording, honestly
-- show nothing at all.
--
-- ⚠️ **`payload` is the raw API response and is not decoration.** The parsed
-- columns below are derived by a tolerant parser from `ability` strings whose
-- exact wording was never verified against a live response (the wiki is behind
-- a 403 and this repo has no key at authoring time). Keeping the raw response
-- means a wrong parse is a re-derivation, not a lost month of history.
CREATE TABLE IF NOT EXISTS public.faction_upgrade_snapshots (
  snapshot_date date PRIMARY KEY,
  -- 'war' | 'peace' — which branch set is actually in effect. A faction at war
  -- is running a different set of perks, and a display that ignores this tells
  -- people they have bonuses they are not getting.
  branch_state  text,
  -- Per-stat gym-gain percentages, parsed from the Steadfast branch.
  -- ⚠️ NULL means "we could not read it", never zero. A faction that has not
  -- bought Strength Training genuinely has 0%, and that is a different fact
  -- from a parser that did not recognise the wording.
  steadfast_strength  numeric,
  steadfast_defense   numeric,
  steadfast_speed     numeric,
  steadfast_dexterity numeric,
  -- Whatever the parser could not attribute to a stat, verbatim, so the UI can
  -- show Torn's own words rather than silently dropping a perk.
  steadfast_unparsed  jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload       jsonb NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);
