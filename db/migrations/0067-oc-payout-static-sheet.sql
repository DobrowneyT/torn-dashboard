-- #871: a settled OC payout week is a static sheet, not a recalculation.
--
-- MonChoon, 2026-10-03: "once its paid and fixed (for OC and RW payments) they
-- should be saved statically as sheets, since thats what was sent to members
-- (including item prices and things that fluctuate with the market)."
--
-- ⚠️ The gap these two columns close: reopening a saved week REBUILT the item
-- breakdown from live crime data and then re-priced it at the CURRENT market.
-- A week settled in July, reopened in October, showed a pot nobody received.
-- The per-member `payout` and `share_percent` columns always held the truth;
-- the screen simply did not trust them.
--
-- `item_breakdown` — the rewards/costs maps exactly as displayed when the week
--   was saved, unit prices included. This is the market-fluctuating part.
-- `crime_values`   — the per-crime net values behind the theoretical payouts.
--
-- ⚠️ NULLABLE and NOT backfilled, by explicit decision (MonChoon, 2026-10-03:
-- "lest leave past weeks as they are and start recording the stats snapshots
-- from now in"). A three-month-old market price cannot be recovered, and
-- inventing one is precisely what this issue exists to prevent. A week with
-- NULL here opens on its stored payouts and says its itemised prices were
-- never recorded — it does NOT fall back to live prices.
ALTER TABLE public.oc_payout_weeks
  ADD COLUMN IF NOT EXISTS item_breakdown jsonb,
  ADD COLUMN IF NOT EXISTS crime_values   jsonb;
