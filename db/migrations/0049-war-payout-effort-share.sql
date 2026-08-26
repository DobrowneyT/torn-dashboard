-- A saved RW payout already computed each member's participation/contribution
-- shares (race_breakdown, per pre/post window) but never saved the single
-- number leadership and members actually want to see: what fraction of the
-- pool they ended up with. Defined as payout_amount / the parent war_payouts
-- row's total_payout, which is well-defined in every payout mode (real war,
-- termed flat, termed scaling) unlike participationShare/contributionShare,
-- which only exist for the formula modes.
ALTER TABLE public.war_payout_members ADD COLUMN IF NOT EXISTS effort_share numeric;

UPDATE public.war_payout_members wpm
SET effort_share = CASE WHEN wp.total_payout > 0 THEN wpm.payout_amount / wp.total_payout ELSE 0 END
FROM public.war_payouts wp
WHERE wpm.payout_id = wp.id AND wpm.effort_share IS NULL;
