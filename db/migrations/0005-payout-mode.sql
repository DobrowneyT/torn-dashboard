-- #134: OC payout modes (tiered / flat-weighted / equal). Each saved week
-- records the mode that produced it, so history renders correctly even after
-- the faction changes its default. Existing rows are left NULL and read as
-- 'tiered' — that's the only model that existed before this column, and the
-- sole pre-existing tenant (Forge) is tier-based.
ALTER TABLE public.oc_payout_weeks
  ADD COLUMN IF NOT EXISTS payout_mode text;
