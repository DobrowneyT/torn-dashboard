-- #609 slice 5: per-tenant feature-flag overrides, and cadence as the first consumer.
--
-- Global default, tenant override wins. ⚠️ The row's EXISTENCE is the "set"
-- signal — not its value. `local || global` is the bug this design exists to
-- avoid: `member_stats_poll_interval_sec = 0` ALREADY means "off" in this
-- codebase (warLifecycle.ts), so a faction that deliberately disabled something
-- would silently inherit the fleet's "on". Unset a flag by DELETEing the row.
--
-- The CHECK is what makes that unambiguous: `'null'::jsonb` is not SQL NULL, so
-- a plain NOT NULL column would store a JSON null and leave "set to nothing"
-- indistinguishable from "unset".
CREATE TABLE IF NOT EXISTS feature_flags (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL CHECK (jsonb_typeof(value) <> 'null'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ⚠️ NULL now means "follow the fleet default", which the NOT NULL constraint
-- made unsayable. Existing rows keep their value and therefore their exact
-- current behaviour; registerJobs.ts performs the one-time adoption in the
-- application, where the code default is actually known (see the comment there
-- for why that inference is sound).
ALTER TABLE scraper_jobs ALTER COLUMN cron_schedule DROP NOT NULL;
