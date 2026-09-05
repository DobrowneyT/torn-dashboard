-- #591: how long an assist request survives, as a per-faction setting.
--
-- It was a hardcoded 120s, chosen on the reasoning recorded in
-- warRoomAssistsExpiry.ts that "Torn fights are seconds, not minutes". A Torn
-- fight runs to FIVE MINUTES; a captured log shows a real one already 132s old,
-- i.e. twelve seconds past the point where the request had already vanished.
--
-- Deliberately its OWN column rather than reusing dibs_expiry_seconds. That one
-- measures how long a CLAIM survives after the target surfaces (default 30s);
-- pushing it to 300 to cover a fight would keep claims blocking other claimers
-- for five minutes. The two windows measure different things.
ALTER TABLE public.war_room_config_v2
  ADD COLUMN IF NOT EXISTS assist_expiry_seconds integer DEFAULT 300 NOT NULL;
