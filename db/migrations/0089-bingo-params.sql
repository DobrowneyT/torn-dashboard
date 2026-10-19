-- #965 — bingo, second card (MonChoon, 2026-10-19).
--
-- Rule THRESHOLDS are data now, not rule names: "15 respect", "13,000 damage",
-- "420 wins" are a square's `params`, so the next card can change a number
-- without a deploy. Each square also carries a `hint` — what counts, and what
-- proof to send — shown when a member taps it.
ALTER TABLE public.event_bingo_tiles ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.event_bingo_tiles ADD COLUMN IF NOT EXISTS hint text;

-- The gap between squares on the art, as a percent of one square — the cross
-- and the tap target sit inside each square rather than over its border.
ALTER TABLE public.event_bingo_cards ADD COLUMN IF NOT EXISTS grid_gap numeric(4,2) NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_bingo_cards_gap_chk') THEN
    ALTER TABLE public.event_bingo_cards ADD CONSTRAINT event_bingo_cards_gap_chk CHECK (grid_gap BETWEEN 0 AND 30);
  END IF;
END $$;

-- The first card's fixed-threshold rules, carried onto the parameterised ones.
UPDATE public.event_bingo_tiles SET rule = 'respect_at_least', params = '{"min": 10.01}' WHERE rule = 'respect_over_10';
UPDATE public.event_bingo_tiles SET rule = 'hit_over', params = '{"min": 10000}' WHERE rule = 'hit_over_10000';
UPDATE public.event_bingo_tiles SET rule = 'hit_between', params = '{"min": 1310, "max": 1340}' WHERE rule = 'hit_1310_1340';
UPDATE public.event_bingo_tiles SET rule = 'bounties_at_least', params = '{"count": 51}' WHERE rule = 'bounties_over_50';
