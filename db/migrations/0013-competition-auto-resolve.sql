-- #186: auto-scheduling for competitions. When auto_resolve is on, the
-- competitions-resolve scraper job closes a fixed competition once its end day
-- passes (and its final-day snapshot has landed), or draws a rolling one every
-- resolve_interval_days. next_resolve_at is the rolling competition's next due
-- time, advanced past now each cycle.
ALTER TABLE public.competitions
  ADD COLUMN IF NOT EXISTS auto_resolve          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS resolve_interval_days integer,
  ADD COLUMN IF NOT EXISTS next_resolve_at       timestamp with time zone;
