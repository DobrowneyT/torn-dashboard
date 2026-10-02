-- Manual pay eligibility on the OC weekly payout sheet (MonChoon, 2026-10-01).
--
-- ⚠️ **The ticket penalty is not a substitute.** Sitting out costs tickets, and
-- on a ticket-weighted week that is proportionate. On the EQUAL and FLAT models
-- tickets do not enter the arithmetic at all, so there was no way to withhold
-- somebody's pay short of deleting their row — which also deletes the record
-- that they were there.
--
-- ⚠️ Mirrors `war_payout_members.is_eligible` deliberately. Two payout sheets
-- that answer "is this member paid" differently is how a leader learns one
-- screen and is wrong on the other.
--
-- Defaults TRUE: every row that already exists was paid on the old rules, and a
-- migration that silently made historical members ineligible would rewrite what
-- those weeks say they paid.
ALTER TABLE public.oc_payout_members
  ADD COLUMN IF NOT EXISTS is_eligible boolean DEFAULT true NOT NULL;
