-- Add the post-cutoff "flat shares" distribution-mode columns the payout UI
-- sends to war_payouts on save. They live next to the existing race_post_*
-- columns and mirror the names used in warPayoutCalculations.calculateRaceWarPayouts.
--
-- Defaults match the calculator's own defaults so existing rows (all of which
-- were 'formula' mode before this feature shipped) load correctly without a
-- one-shot backfill — formula mode ignores threshold/scale fields entirely.

ALTER TABLE public.war_payouts
  ADD COLUMN IF NOT EXISTS post_dist_mode      text    NOT NULL DEFAULT 'formula',
  ADD COLUMN IF NOT EXISTS post_flat_threshold numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS post_scale_enabled  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS post_scale_hours    integer NOT NULL DEFAULT 24;

-- Sanity constraint: dist mode is one of the two values the calculator supports.
ALTER TABLE public.war_payouts
  ADD CONSTRAINT war_payouts_post_dist_mode_chk
  CHECK (post_dist_mode IN ('formula', 'flat'));
