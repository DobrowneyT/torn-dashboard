-- #357: remember an overdose for as long as the drug cooldown it caused.
--
-- Detection was a threshold test against the CURRENT drug cooldown: over 10h
-- means overdose, because a normal xanax leaves 6-8h. But the sweep overwrites
-- cooldown_drug on every pass, so the stored value burns down exactly like the
-- displayed one — and the flag silently vanished the moment a real overdose
-- dropped under 10h, leaving a member who is out of the fight for another nine
-- hours looking available.
--
-- (A comment in warRoomMemberStats.js claimed the stored reading made this
-- immune. It did not; that comment is removed in the same change.)
--
-- Safe to compute an absolute expiry because NOTHING in the game reduces drug
-- cooldown — it falls at exactly one second per second. So the first reading
-- above the threshold tells us when it ends, and we stop depending on the live
-- value. A member cannot take another drug while on drug cooldown either, so
-- holding the flag for the cooldown's full duration is not an approximation:
-- it is precisely the window in which they cannot dose again.

ALTER TABLE public.war_room_member_stats_v2
  ADD COLUMN IF NOT EXISTS overdose_until timestamp with time zone;
