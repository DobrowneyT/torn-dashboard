-- #184: rolling windows + per-day-average reducer for competitions.
-- A competition is now either 'fixed' (explicit window_start/window_end) or
-- 'rolling' (a trailing window of rolling_days ending today, recomputed on
-- read). The fixed dates become nullable since a rolling competition has none.
-- `reducer` selects total-delta (default) or a per-day average of that delta.
ALTER TABLE public.competitions
  ADD COLUMN IF NOT EXISTS window_kind  text    NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS rolling_days integer,
  ADD COLUMN IF NOT EXISTS reducer      text    NOT NULL DEFAULT 'total';

ALTER TABLE public.competitions ALTER COLUMN window_start DROP NOT NULL;
ALTER TABLE public.competitions ALTER COLUMN window_end   DROP NOT NULL;
