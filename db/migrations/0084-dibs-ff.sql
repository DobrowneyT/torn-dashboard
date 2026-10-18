-- #997 — the fair fight a member SAW when they called dibs, and how it compares
-- with what the hit actually got.
--
-- ⚠️ FF is not stored anywhere else: each viewer's browser computes it from
-- their OWN stats against the target's ESTIMATED stats (BSP/TornStats). So the
-- only record of what the holder was shown is what their page sends with the
-- claim. Gekents seeing 1.50 and MonChoon seeing 1.20 for the same target are
-- both true; the claim keeps Gekents'.
ALTER TABLE public.war_room_dibs_v2 ADD COLUMN IF NOT EXISTS ff_shown numeric(7,2);
ALTER TABLE public.war_room_dibs_v2 ADD COLUMN IF NOT EXISTS ff_shown_estimated boolean;

-- Per member, per war: the average FF shown against the average Torn actually
-- gave, over the claims where both are known, and how many came in noticeably
-- under what the board showed — so nobody is marked down for a bad estimate.
ALTER TABLE public.war_dibs_summary ADD COLUMN IF NOT EXISTS ff_compared integer NOT NULL DEFAULT 0;
ALTER TABLE public.war_dibs_summary ADD COLUMN IF NOT EXISTS ff_shown_avg numeric(6,2);
ALTER TABLE public.war_dibs_summary ADD COLUMN IF NOT EXISTS ff_actual_avg numeric(6,2);
ALTER TABLE public.war_dibs_summary ADD COLUMN IF NOT EXISTS ff_overstated integer NOT NULL DEFAULT 0;
