-- Fallen members: Torn's "Resting in Peace" status.
--
-- When a player dies in real life their account is preserved rather than
-- removed, so they stay on the faction roster indefinitely — which is also why
-- a faction can appear to exceed 100 members. They are still a member in every
-- sense Torn reports, so is_current stays true and their stint history is left
-- intact; they simply cannot act, and should not be counted, scraped, chased
-- for roll call, or ranked in member stats.
--
-- A column rather than deriving it from war_room_state_v2: that table is
-- war-room scoped and only populated while a war is being watched, whereas the
-- members roster is what every stats surface reads.
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS is_fallen boolean NOT NULL DEFAULT false;

-- Every member-listing query pairs this with is_current.
CREATE INDEX IF NOT EXISTS members_is_current_not_fallen_idx
  ON public.members (is_current) WHERE (is_fallen = false);
