-- #239: competition prize table. prize_kind + prizes on the competition, and
-- the earned prize per member on the resolved results. Idempotent.
ALTER TABLE public.competitions
  ADD COLUMN IF NOT EXISTS prize_kind text NOT NULL DEFAULT 'placement',
  ADD COLUMN IF NOT EXISTS prizes jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.competition_results
  ADD COLUMN IF NOT EXISTS prize jsonb;
