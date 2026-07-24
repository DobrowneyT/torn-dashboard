-- #187: lottery competitions. type='lottery' qualifies members by a threshold
-- on the metric value (comparator gte|lte vs threshold_value), then draws the
-- qualified pool at random on resolve. Leaderboard competitions leave these null.
ALTER TABLE public.competitions
  ADD COLUMN IF NOT EXISTS threshold_comparator text,
  ADD COLUMN IF NOT EXISTS threshold_value      double precision;
