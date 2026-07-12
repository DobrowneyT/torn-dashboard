-- #106: the war-room ticker schedules a dibs auto-release ~30s after it
-- observes the target leave hospital (Hospital→Okay). auto_expire_at holds
-- that deadline on the claim row; a NULL means no expiry is pending. The
-- per-tick sweep tombstones claims whose deadline has passed. (#107 drops on
-- a hospital-time increase and needs no column — it tombstones in the tick.)
ALTER TABLE public.war_room_dibs_v2
  ADD COLUMN IF NOT EXISTS auto_expire_at timestamp with time zone;
